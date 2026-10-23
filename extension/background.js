// Quick Video Saver: service worker.
// Detects media per tab, studies it (manifests, page analysis), runs downloads and serves the interface.
import {webURL, hostOf, originOf, uid, debounce, extOf, resolveURL, withTimeout} from './lib/util.js';
import {classify, isKnownSite} from './lib/detect.js';
import {parseManifest, parseHLS} from './lib/manifest.js';
import {newTabState, applyNetwork, applyHook, applyPage, compactManifest, keepHeaders, linkContext, videoTarget} from './lib/model.js';
import {buildView} from './lib/view.js';
import {fileBase, safeName} from './lib/title.js';
import {getSettings, saveSettings} from './lib/settings.js';
import {HelperClient} from './lib/native.js';
import {describeError} from './lib/errors.js';

const HOST_FILTER = {urls: ['http://*/*', 'https://*/*']};
// Media never travels as an image, script, style or font: letting the browser skip those saves a worker wake-up per request.
const HEADER_FILTER = {...HOST_FILTER, types: ['xmlhttprequest', 'media', 'other', 'object', 'main_frame', 'sub_frame']};
const ACTIVE = new Set(['queued', 'starting', 'downloading', 'processing']);
const USER_AGENT = navigator.userAgent;

// ---------------------------------------------------------------------------------------------------
// UI notifications: any change is broadcast (debounced) to every open popup / side panel / tab.
const ports = new Set();
const dirty = new Set();
const flush = debounce(() => {
  const scopes = [...dirty];
  dirty.clear();
  for (const port of ports) { try { port.postMessage({type: 'changed', scopes}); } catch { ports.delete(port); } }
}, 60);
function changed(...scopes) { for (const scope of scopes) dirty.add(scope); flush(); }

// ---------------------------------------------------------------------------------------------------
// Per-tab state: memory first, mirrored (debounced) into session storage so a sleeping worker loses nothing.
const tabs = new Map();
const queues = new Map();
const persistTimers = new Map();
const storeKey = id => `tab:${id}`;

function loadTab(tabId) {
  let promise = tabs.get(tabId);
  if (!promise) {
    promise = chrome.storage.session.get(storeKey(tabId)).then(data => {
      const st = data[storeKey(tabId)] || newTabState(tabId);
      st.probes ||= {}; st.items ||= {}; st.frames ||= {}; st.embeds ||= {};
      for (const probe of Object.values(st.probes)) if (probe.state === 'running') probe.state = 'idle';
      return st;
    }).catch(() => newTabState(tabId));
    tabs.set(tabId, promise);
  }
  return promise;
}

function mutateTab(tabId, fn) {
  const run = (queues.get(tabId) || Promise.resolve()).then(async () => {
    const st = await loadTab(tabId);
    const result = await fn(st);
    st.updated = Date.now();
    schedulePersist(tabId);
    scheduleBadge(tabId);
    changed('tab:' + tabId);
    return result;
  });
  queues.set(tabId, run.catch(() => {}));
  return run;
}

function schedulePersist(tabId) {
  clearTimeout(persistTimers.get(tabId));
  persistTimers.set(tabId, setTimeout(async () => {
    const st = await tabs.get(tabId);
    if (!st) return;
    // Thumbnails stay in memory only: they are large and cheap to capture again.
    const plain = JSON.parse(JSON.stringify(st, (key, value) => key === 'thumb' ? undefined : value));
    chrome.storage.session.set({[storeKey(tabId)]: plain}).catch(() => {});
  }, 500));
}

function dropTab(tabId) {
  tabs.delete(tabId); queues.delete(tabId);
  clearTimeout(persistTimers.get(tabId)); persistTimers.delete(tabId);
  chrome.storage.session.remove(storeKey(tabId)).catch(() => {});
}

const badgeTimers = new Map();
function scheduleBadge(tabId) {
  clearTimeout(badgeTimers.get(tabId));
  badgeTimers.set(tabId, setTimeout(async () => {
    try {
      const st = await loadTab(tabId);
      const view = buildView(st, {settings: await getSettings()});
      const count = view.cards.filter(card => card.group === 'main' && !card.drm).length;
      await chrome.action.setBadgeText({tabId, text: count ? String(count) : ''});
      await chrome.action.setBadgeBackgroundColor({tabId, color: '#5b4bf5'});
      await chrome.action.setBadgeTextColor?.({tabId, color: '#ffffff'});
    } catch { /* the tab closed meanwhile */ }
  }, 350));
}

// ---------------------------------------------------------------------------------------------------
// Network capture
const requestHeaders = new Map();

chrome.webRequest.onBeforeSendHeaders.addListener(details => {
  if (details.tabId < 0 || !/^(?:xmlhttprequest|media|other|object)$/.test(details.type)) return;
  const headers = {};
  for (const {name, value} of details.requestHeaders || []) headers[name] = value;
  requestHeaders.set(details.requestId, keepHeaders(headers));
  if (requestHeaders.size > 600) requestHeaders.delete(requestHeaders.keys().next().value);
}, {...HOST_FILTER, types: ['xmlhttprequest', 'media', 'other', 'object']}, ['requestHeaders', 'extraHeaders']);

chrome.webRequest.onHeadersReceived.addListener(details => {
  const headers = requestHeaders.get(details.requestId);
  requestHeaders.delete(details.requestId);
  if (details.tabId < 0 || details.statusCode >= 400 || details.statusCode === 204 || /^(?:image|script|stylesheet|font|ping|csp_report|websocket)$/.test(details.type)) return;
  const header = name => details.responseHeaders?.find(h => h.name.toLowerCase() === name)?.value || '';
  const mime = header('content-type');
  const total = /\/(\d+)\s*$/.exec(header('content-range'))?.[1];
  const size = Number(total || (details.statusCode === 206 ? 0 : header('content-length'))) || 0;
  const disposition = header('content-disposition');
  if (!classify(details.url, mime, {size, disposition, hasRange: details.statusCode === 206})) return;
  const frameURL = details.documentUrl || details.initiator || '';
  mutateTab(details.tabId, st => applyNetwork(st, {url: details.url, mime, size, status: details.statusCode, disposition, headers, frameURL, frameId: details.frameId})).catch(() => {});
}, HEADER_FILTER, ['responseHeaders']);

// ---------------------------------------------------------------------------------------------------
// Navigation lifecycle
chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  const restored = details.transitionQualifiers?.includes('forward_back');
  mutateTab(details.tabId, st => {
    if (restored && st.url === details.url) return;
    const fresh = newTabState(details.tabId, details.url);
    fresh.navId = st.navId + 1;
    // Anything first seen at or after the commit belongs to the new page (requests can beat this handler).
    for (const [key, item] of Object.entries(st.items)) if (item.firstSeen >= details.timeStamp - 2) fresh.items[key] = item;
    for (const key of Object.keys(st)) delete st[key];
    Object.assign(st, fresh);
  }).catch(() => {});
  setTimeout(() => chrome.tabs.sendMessage(details.tabId, {type: 'SCAN'}).catch(() => {}), 1500);
});

// Same video, different address ("?t=60", "#comments", tracking parameters): not a new page.
const NOISE_PARAMS = /^(?:t|start|time_continue|feature|si|list|index|pp|utm_\w+|fbclid|gclid|ref|source|spm)$/i;
function viewKey(value) {
  try {
    const url = new URL(value);
    const keep = [...url.searchParams].filter(([name]) => !NOISE_PARAMS.test(name)).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
    return `${url.origin}${url.pathname}?${keep}`;
  } catch { return String(value); }
}

chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  if (details.frameId !== 0) return;
  const navAt = Date.now();
  let isNewView = false;
  mutateTab(details.tabId, st => {
    isNewView = !!st.url && viewKey(st.url) !== viewKey(details.url);
    st.url = details.url;
    if (!isNewView) return;
    // Single-page apps swap the video without a page load. The old view's media goes quiet; whatever
    // is still requested after the switch (checked below) belongs to the new view.
    st.probes = {};
    st.embeds = {};
    st.drm = '';
    st.navId++;
  }).then(() => {
    if (!isNewView) return;
    setTimeout(() => mutateTab(details.tabId, st => {
      for (const [key, item] of Object.entries(st.items)) if (item.lastSeen < navAt) delete st.items[key];
    }).catch(() => {}), 1200);
  }).catch(() => {});
  setTimeout(() => chrome.tabs.sendMessage(details.tabId, {type: 'SCAN'}).catch(() => {}), 900);
});

chrome.tabs.onRemoved.addListener(dropTab);
chrome.tabs.onReplaced.addListener((added, removed) => {
  const state = tabs.get(removed);
  if (state) { tabs.set(added, state.then(st => ({...st, tabId: added}))); dropTab(removed); }
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.title) mutateTab(tabId, st => { st.title = change.title; }).catch(() => {});
});

// ---------------------------------------------------------------------------------------------------
// Messages from content scripts
async function fromContent(message, sender) {
  const tabId = sender.tab?.id;
  if (!(tabId >= 0) || typeof message.frameURL !== 'string') return;
  if (message.type === 'HOOK') {
    await mutateTab(tabId, st => { applyHook(st, message.frameURL, message.events); });
  } else {
    await mutateTab(tabId, st => {
      if (sender.tab.title && !st.title) st.title = sender.tab.title;
      for (const video of message.videos || []) if (video && typeof video === 'object') video.thumb = typeof video.thumb === 'string' && video.thumb.startsWith('data:image/jpeg') ? video.thumb : '';
      const previous = st.frames[message.frameURL]?.videos || [];
      applyPage(st, message);
      // Keep earlier thumbnails: the page only sends a frame once.
      const videos = st.frames[message.frameURL]?.videos || [];
      for (const video of videos) if (!video.thumb) video.thumb = previous.find(old => old.src === video.src && old.thumb)?.thumb || '';
    });
  }
}

// ---------------------------------------------------------------------------------------------------
// Fetching manifests with the page's identity (Referer / Origin / cookies) through temporary DNR rules.
let ruleCounter = 5000;
async function cookieHeaderFor(url) {
  try {
    const cookies = await chrome.cookies.getAll({url});
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  } catch { return ''; }
}

// Runs `work(signal)` with the page's Referer / Origin / cookies applied to this one request (temporary DNR rule).
async function withPageIdentity(url, {headers = {}, referer = '', timeout = 12000} = {}, work) {
  const id = ruleCounter = ruleCounter >= 80000 ? 5000 : ruleCounter + 1;
  const modify = [];
  const set = (header, value) => { if (value) modify.push({header, operation: 'set', value}); };
  set('Referer', headers.Referer || referer);
  set('Origin', headers.Origin);
  set('Authorization', headers.Authorization);
  for (const [name, value] of Object.entries(headers)) if (/^x-[\w-]+$/i.test(name)) set(name, value);
  set('Cookie', (await getSettings()).useCookies ? await cookieHeaderFor(url) : '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const canFilter = !/[*^|]/.test(url);
  try {
    if (modify.length && canFilter) {
      await chrome.declarativeNetRequest.updateSessionRules({addRules: [{id, priority: 1, action: {type: 'modifyHeaders', requestHeaders: modify}, condition: {urlFilter: `|${url}|`, resourceTypes: ['xmlhttprequest'], initiatorDomains: [chrome.runtime.id]}}]});
    }
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
    if (modify.length && canFilter) chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: [id]}).catch(() => {});
  }
}

async function fetchText(url, {maxBytes = 2_500_000, ...context} = {}) {
  return withPageIdentity(url, context, async signal => {
    const response = await fetch(url, {signal, cache: 'no-store', credentials: 'omit', redirect: 'follow'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < maxBytes) {
      const {done, value} = await reader.read();
      if (done) break;
      chunks.push(value); total += value.length;
    }
    reader.cancel().catch(() => {});
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder().decode(bytes);
  });
}

// One byte is enough to learn what a URL really is: a web page that merely ends in ".webm" is not a video.
async function peek(url, context) {
  return withPageIdentity(url, {...context, timeout: 9000}, async signal => {
    const response = await fetch(url, {signal, cache: 'no-store', credentials: 'omit', redirect: 'follow', headers: {Range: 'bytes=0-0'}});
    response.body?.cancel().catch(() => {});
    const total = /\/(\d+)\s*$/.exec(response.headers.get('content-range') || '')?.[1];
    return {status: response.status, type: (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), size: Number(total || response.headers.get('content-length')) || 0};
  });
}

// ---------------------------------------------------------------------------------------------------
// Helper connection
const helper = new HelperClient({
  onEvent: message => { if (message.event === 'job') onHelperJob(message.job); },
  onState: () => changed('helper'),
  getConfig: async () => {
    const s = await getSettings();
    return {folder: s.folder, parallel: s.parallel, container: s.container, audioFormat: s.audioFormat, preferCompat: s.preferCompat, subtitles: s.subtitles, fragments: s.fragments, autoUpdate: s.autoUpdate};
  },
});
// "unknown" and "error" still count as usable: the next call retries the connection.
const helperUsable = () => !['missing', 'forbidden', 'outdated'].includes(helper.info.status);

async function gatherCookies(urls) {
  if (!(await getSettings()).useCookies) return [];
  const seen = new Map();
  for (const url of new Set(urls.filter(Boolean))) {
    try {
      for (const c of await chrome.cookies.getAll({url})) seen.set(`${c.domain}|${c.path}|${c.name}`, {domain: c.domain, path: c.path, secure: c.secure, expirationDate: c.expirationDate, name: c.name, value: c.value});
    } catch { /* invalid URL for cookies */ }
  }
  return [...seen.values()].slice(0, 3000);
}

// ---------------------------------------------------------------------------------------------------
// Analysis: manifests, ffprobe details, and the helper's site extractors
const limiters = {active: 0, waiting: []};
function limited(task) {
  return new Promise((resolve, reject) => {
    const run = () => { limiters.active++; task().then(resolve, reject).finally(() => { limiters.active--; limiters.waiting.shift()?.(); }); };
    limiters.active < 3 ? run() : limiters.waiting.push(run);
  });
}

const analyzing = new Set();
const itemById = (st, id) => Object.values(st.items).find(item => item.id === id);

function needsAnalysis(item, includeWeak = false) {
  if ((item.weak && !includeWeak) || analyzing.has(item.id) || item.analysis === 'done' || item.analysis === 'failed') return false;
  if (['hls', 'dash', 'mss'].includes(item.kind)) return !item.manifest || !item.manifest.duration && !item.manifest.live;
  return !item.media && !item.mediaTried;
}

function requestContext(item, pageURL) {
  const headers = {...item.headers};
  headers.Referer ||= item.frameURL || pageURL;
  return {headers, referer: headers.Referer};
}

async function analyzeItem(tabId, itemId) {
  const snap = await mutateTab(tabId, st => {
    const item = itemById(st, itemId);
    if (!item) return null;
    item.analysis = 'pending';
    return {url: item.url, kind: item.kind, headers: {...item.headers}, frameURL: item.frameURL, manifest: item.manifest, page: st.page?.url || st.url, loose: item.weak && item.sources.every(source => source === 'link' || source === 'data') && !item.verified};
  });
  if (!snap) return;
  const ctx = requestContext(snap, snap.page);
  const patch = {};
  if (snap.loose) {
    // Found only in a link or in page data: make sure it is really media before offering it.
    try {
      const seen = await peek(snap.url, ctx);
      if (seen.status >= 400 && seen.status !== 403 && seen.status !== 401) patch.invalid = true;
      else if (/^(?:text\/html|text\/css|image\/|font\/)/.test(seen.type)) patch.invalid = true;
      else if (!['hls', 'dash', 'mss'].includes(snap.kind) && /^(?:application\/(?:json|xml|javascript)|text\/(?:plain|xml))/.test(seen.type)) patch.invalid = true;
      else if (seen.size) patch.size = seen.size;
    } catch { /* unreachable from here: keep it, the helper may still manage */ }
  }
  try {
    if (['hls', 'dash', 'mss'].includes(snap.kind)) {
      let info = snap.manifest;
      if (!info) {
        const parsed = parseManifest(snap.kind, await fetchText(snap.url, ctx), snap.url);
        if (!parsed) throw new Error('This manifest could not be read.');
        info = compactManifest(parsed);
      }
      if (info.type === 'hls' && !info.duration) {
        const probe = info.master ? info.variants.find(v => v.url && v.height <= 720) || info.variants.at(-1) : null;
        if (probe?.url) {
          const media = parseHLS(await fetchText(probe.url, ctx), probe.url);
          if (media) Object.assign(info, {duration: media.duration, live: media.live, encrypted: info.encrypted || media.encrypted, drm: info.drm || media.drm, segments: media.segments});
        }
      }
      patch.manifest = info;
    }
  } catch (error) {
    patch.error = error.message;
  }
  if (patch.invalid) { await mutateTab(tabId, st => { const item = itemById(st, itemId); if (item) { item.invalid = true; item.analysis = 'done'; } }); return; }
  // The helper knows how to read what the browser cannot: use it for details (and as a fallback).
  const fileLike = ['file', 'audio'].includes(snap.kind) || (patch.manifest && !patch.manifest.master && !patch.manifest.variants.length);
  if ((fileLike || (patch.error && !snap.manifest)) && helperUsable()) {
    try {
      const cookies = await gatherCookies([snap.url, snap.page]);
      if (fileLike && !patch.error) {
        const result = await helper.call('media_info', {url: snap.url, kind: snap.kind, headers: {...ctx.headers, 'User-Agent': USER_AGENT}, cookies});
        patch.media = result.info;
        if (result.info.duration && patch.manifest && !patch.manifest.duration) patch.manifest.duration = result.info.duration;
      } else {
        const result = await helper.call('probe', {url: snap.url, pageURL: snap.page, headers: {...ctx.headers, 'User-Agent': USER_AGENT}, cookies});
        const info = result.info;
        if (info.kind === 'video') {
          patch.manifest = {type: snap.kind, master: info.qualities.length > 1, duration: info.duration || 0, live: !!info.live, drm: info.drm ? 'DRM' : '', encrypted: false, segments: 0, fmp4: false, audio: [], subtitles: 0,
            variants: info.qualities.map(q => ({id: q.formatId, height: q.height, width: q.width, fps: q.fps, label: q.label, size: q.size, approx: q.approx, bandwidth: 0}))};
          patch.error = '';
        }
      }
    } catch (error) { if (!patch.manifest) patch.error ||= error.message; }
  }
  await mutateTab(tabId, st => {
    const item = itemById(st, itemId);
    if (!item) return;
    if (patch.manifest) item.manifest = patch.manifest;
    if (patch.media) item.media = patch.media;
    if (patch.invalid) item.invalid = true;
    if (patch.size && patch.size > item.size) item.size = patch.size;
    item.verified = true;
    item.mediaTried = true;
    item.analysis = patch.error && !patch.manifest && !patch.media ? 'failed' : 'done';
  });
}

function probeCandidates(st, settings) {
  const pageURL = webURL(st.page?.url || st.url);
  const candidates = [];
  if (!settings.smartAnalyze) return candidates;
  const strong = Object.values(st.items).some(item => !item.weak && ['hls', 'dash', 'file', 'mss'].includes(item.kind));
  if (pageURL && !st.probes[pageURL]) {
    const url = new URL(pageURL);
    const root = url.pathname === '/' && !url.search;
    const hints = st.page?.hasMedia || st.mse || st.partial || Object.keys(st.embeds).length;
    if (!root && (isKnownSite(pageURL) || (!strong && hints))) candidates.push(pageURL);
  }
  // An embed on the page's own site (youtube.com watch page with an /embed/ og:video) is the same video.
  const pageHost = pageURL ? new URL(pageURL).hostname.replace(/^www\./, '') : '';
  for (const embed of Object.keys(st.embeds).slice(0, 3)) {
    if (st.probes[embed] || (pageHost && new URL(embed).hostname.replace(/^www\./, '').endsWith(pageHost) && st.probes[pageURL]?.state !== 'failed' && isKnownSite(pageURL))) continue;
    candidates.push(embed);
  }
  return candidates;
}

async function runProbe(tabId, url, {force = false} = {}) {
  const pageURL = (await loadTab(tabId)).page?.url || (await loadTab(tabId)).url;
  const started = await mutateTab(tabId, st => {
    if (!force && st.probes[url]) return false;
    st.probes[url] = {state: 'running', at: Date.now()};
    return true;
  });
  if (!started) return;
  let outcome;
  try {
    const cookies = await gatherCookies([url, pageURL]);
    const result = await helper.call('probe', {url, pageURL: url === pageURL ? '' : pageURL, headers: {'User-Agent': USER_AGENT, ...(url === pageURL ? {} : {Referer: pageURL})}, cookies});
    outcome = {state: 'done', info: result.info, at: Date.now()};
  } catch (error) {
    outcome = {state: 'failed', error: error.message, errorCode: error.code || 'unknown', at: Date.now()};
  }
  await mutateTab(tabId, st => { st.probes[url] = outcome; });
}

async function ensureAnalysis(tabId, includeWeak = false) {
  const st = await loadTab(tabId);
  const settings = await getSettings();
  for (const item of Object.values(st.items)) {
    if (!needsAnalysis(item, includeWeak)) continue;
    analyzing.add(item.id);
    limited(() => analyzeItem(tabId, item.id)).catch(() => {}).finally(() => analyzing.delete(item.id));
  }
  if (helperUsable()) {
    for (const url of probeCandidates(st, settings)) limited(() => runProbe(tabId, url)).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------
// Jobs
let jobs = [];
let jobsLoaded;
const jobsReady = () => jobsLoaded ||= chrome.storage.local.get('jobs').then(({jobs: stored = []}) => {
  jobs = stored;
  // A restart means the helper died with the worker: whatever was running can be resumed.
  for (const job of jobs) if (ACTIVE.has(job.state)) Object.assign(job, job.engine === 'helper' ? {state: 'paused', detail: 'Interrupted. Resume to continue.', speed: 0, eta: 0} : {state: 'error', errorCode: 'unknown', error: 'Interrupted'});
});
// Finished downloads no longer need the headers (tokens, auth) they were started with: do not keep them on disk.
const persistJobs = debounce(() => {
  const plain = jobs.slice(0, 120).map(job => job.state === 'complete' && job.request ? {...job, request: null} : job);
  chrome.storage.local.set({jobs: plain}).catch(() => {});
}, 600);

function publicJob(job) {
  const {request, ...rest} = job;
  return {...rest, canResume: job.engine === 'helper' && ['paused', 'error'].includes(job.state) && !!request, explain: job.state === 'error' ? describeError(job.errorCode, job.error) : null};
}

function patchJob(id, patch) {
  const job = jobs.find(item => item.id === id);
  if (!job) return null;
  Object.assign(job, patch, {updated: Date.now()});
  persistJobs();
  changed('jobs');
  return job;
}

// An expired token is the commonest reason a stream link fails. If the page has since requested the same
// video with a fresh link, try that automatically (once) before bothering the user.
async function autoRetry(job) {
  const stale = ['gone', 'forbidden', 'auth', 'not_media'];
  if (!job || job.autoRetried || job.engine !== 'helper' || !stale.includes(job.errorCode) || !(job.tabId >= 0) || !job.request?.key) return false;
  const st = await loadTab(job.tabId).catch(() => null);
  const fresh = st && Object.values(st.items).find(item => item.key === job.request.key);
  if (!fresh || (fresh.url === job.request.url && JSON.stringify(fresh.headers) === JSON.stringify(keepHeaders(job.request.headers)))) return false;
  job.autoRetried = true;
  job.request.url = fresh.url;
  job.request.headers = {...job.request.headers, ...fresh.headers};
  patchJob(job.id, {state: 'queued', detail: 'The link expired. Retrying with a fresh link from the page…', error: '', errorCode: '', progress: 0});
  try { await startHelperJob(job, job.stem ? {stem: job.stem, resume: true} : {}); return true; }
  catch (error) { patchJob(job.id, {state: 'error', error: error.message, errorCode: error.code || 'unknown'}); return false; }
}

function onHelperJob(update) {
  const job = jobs.find(item => item.id === update.id);
  if (!job) return;
  const was = job.state;
  const patch = {};
  for (const key of ['state', 'progress', 'downloaded', 'total', 'speed', 'eta', 'detail', 'stem', 'filename', 'path', 'size', 'error', 'errorCode', 'diag', 'attempt', 'attempts', 'strategy', 'media', 'live']) if (key in update) patch[key] = update[key];
  if (update.state === 'complete') { patch.finished = Date.now(); patch.name = update.filename || job.name; }
  if (update.state === 'error') patch.finished = Date.now();
  patchJob(update.id, patch);
  if (was === update.state) return;
  if (update.state === 'error') autoRetry(job).then(retried => { if (!retried) notifyFinished(job); });
  else if (update.state === 'complete') notifyFinished(job);
}

async function notifyFinished(job) {
  if (!job || !(await getSettings()).notifications || ports.size) return;
  const ok = job.state === 'complete';
  chrome.notifications.create(job.id, {type: 'basic', iconUrl: 'icons/128.png', title: ok ? 'Download complete' : 'Download failed', message: ok ? (job.filename || job.name) : describeError(job.errorCode, job.error).title, priority: 0}).catch?.(() => {});
}
chrome.notifications.onClicked.addListener(async id => {
  await jobsReady();
  const job = jobs.find(item => item.id === id);
  if (job?.path) helper.call('reveal', {path: job.path}).catch(() => {});
  chrome.notifications.clear(id);
});

const MIME_EXT = {'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/x-flv': 'flv', 'video/ogg': 'ogv', 'video/x-ms-wmv': 'wmv', 'video/3gpp': '3gp', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/wav': 'wav'};
const QUALITY_NAME = /^\d{2,4}p\d*$/;

function buildTarget(st, card, quality, audioOnly, settings) {
  const pageURL = st.page?.url || st.url;
  const target = {kind: card.kind, url: card.url, pageURL, headers: {'User-Agent': USER_AGENT}, format: {}, duration: card.duration || 0, live: !!card.live, filename: '', title: card.title, mime: '', expectedSize: quality?.size || 0};
  if (card.source === 'item') {
    const item = itemById(st, card.id);
    if (!item) throw new Error('This video is no longer on the page. Press Scan again.');
    target.url = item.url;
    target.mime = item.mime;
    target.headers = {...item.headers, 'User-Agent': item.headers['User-Agent'] || USER_AGENT};
    target.headers.Referer ||= item.frameURL || pageURL;
    target.frameURL = item.frameURL;
    target.key = item.key;
    if (!audioOnly && quality?.height && card.qualities.length > 1) target.format = {height: quality.height};
  } else {
    target.kind = 'page';
    if (card.source !== 'page' || card.embedded) target.headers.Referer = pageURL;
    else target.pageURL = '';
    if (!audioOnly && quality?.formatId) target.format = {formatId: quality.formatId, hasAudio: !!quality.hasAudio, height: quality.height};
    else if (!audioOnly && quality?.height) target.format = {height: quality.height};
  }
  if (audioOnly) target.format = {audioOnly: true};
  const label = quality && QUALITY_NAME.test(quality.label) ? quality.label : '';
  target.qualityLabel = audioOnly ? 'Audio' : quality?.label || '';
  target.filename = fileBase(card.title, {quality: audioOnly ? '' : label, template: settings.nameTemplate});
  return target;
}

async function createJob(target, card, name, engine) {
  const settings = await getSettings();
  await jobsReady();
  const request = {...target};
  const job = {
    id: uid(), name, title: card?.title || target.title || name, state: 'queued', progress: 0, created: Date.now(), updated: Date.now(), engine, kind: target.kind, host: hostOf(target.url), url: target.url,
    quality: target.qualityLabel || '', container: card?.container || '', thumb: (card?.thumb && card.thumb.length < 30000 ? card.thumb : '') || card?.poster || '', tabId: card?.tabId ?? -1, cardId: card?.id || '',
    detail: 'Starting…', filename: '', path: '', size: 0, error: '', errorCode: '', request, folder: settings.folder,
  };
  jobs.unshift(job);
  // Only the 40 newest finished jobs are kept alongside everything that is still active.
  const finished = jobs.filter(item => !ACTIVE.has(item.state) && item.state !== 'paused');
  for (const old of finished.slice(40)) jobs.splice(jobs.indexOf(old), 1);
  persistJobs();
  changed('jobs');
  return job;
}

async function startHelperJob(job, extra = {}) {
  const request = job.request;
  const cookies = await gatherCookies([request.url, request.pageURL, request.frameURL]);
  const reply = await helper.call('start', {
    id: job.id, url: request.url, pageURL: request.pageURL || '', kind: request.kind, filename: job.name, title: job.title, format: request.format, headers: request.headers, cookies, duration: request.duration, live: request.live, expectedSize: request.expectedSize || 0, ...extra,
  });
  // State changes arrive as helper events; only the reserved file name is recorded here.
  patchJob(job.id, {stem: reply.stem, folder: reply.folder});
}

async function startBrowserJob(job) {
  const {url, mime} = job.request;
  const ext = extOf(url).match(/^(?:mp4|webm|mkv|mov|m4v|ogv|avi|flv|wmv|mpeg|mpg|3gp|mp3|m4a|aac|ogg|opus|wav|flac)$/) ? extOf(url) : MIME_EXT[String(mime).split(';')[0]] || (job.request.kind === 'audio' ? 'mp3' : 'mp4');
  const headers = Object.entries(job.request.headers || {}).filter(([name]) => /^(?:authorization|x-[\w-]+)$/i.test(name)).map(([name, value]) => ({name, value}));
  const downloadId = await chrome.downloads.download({url, filename: `Quick Video Saver/${safeName(job.name)}.${ext}`, conflictAction: 'uniquify', saveAs: false, headers});
  patchJob(job.id, {downloadId, state: 'downloading', detail: 'Downloading with the browser…'});
}

async function startDownload(params) {
  const settings = await getSettings();
  await jobsReady();
  let target, card = null;
  if (params.link) {
    const link = params.link;
    target = {kind: link.kind || classify(link.url, link.mime || '')?.kind || 'page', url: webURL(link.url), pageURL: webURL(link.pageURL) || '', headers: {'User-Agent': USER_AGENT, ...(link.pageURL ? {Referer: link.pageURL} : {})}, format: link.format || {},
      duration: link.duration || 0, live: !!link.live, title: link.title || 'Video', qualityLabel: link.qualityLabel || '', mime: link.mime || '', filename: ''};
    if (!target.url) throw new Error('Enter a valid http or https link.');
    if (params.audioOnly) target.format = {audioOnly: true};
    target.filename = fileBase(target.title, {quality: QUALITY_NAME.test(target.qualityLabel) ? target.qualityLabel : '', template: settings.nameTemplate});
    card = {id: params.cardId || '', title: target.title, container: '', poster: link.thumb || '', tabId: params.tabId};
  } else {
    const st = await loadTab(params.tabId);
    const view = buildView(st, {settings});
    card = view.cards.find(item => item.id === params.cardId);
    if (!card) throw new Error('This video is no longer on the page. Press Scan again.');
    card.tabId = params.tabId;
    const quality = card.qualities.find(q => q.key === params.qualityKey) || card.qualities.find(q => q.key === card.defaultQuality) || card.qualities[0];
    target = buildTarget(st, card, quality, !!params.audioOnly, settings);
    if (card.drm) throw new Error('This video is DRM-protected and cannot be saved.');
  }
  const name = params.name ? safeName(params.name) : target.filename;
  const direct = target.kind === 'file' && !params.audioOnly;
  const useBrowser = direct && (!helperUsable() || params.engine === 'browser');
  if (!direct) await helper.ensure().catch(() => { throw new Error('Streams and page links need the helper. Open Settings to set it up.'); });
  const job = await createJob(target, card, name, useBrowser ? 'browser' : 'helper');
  const forget = () => { jobs.splice(jobs.indexOf(job), 1); persistJobs(); changed('jobs'); };
  try {
    if (useBrowser) await startBrowserJob(job);
    else await startHelperJob(job);
  } catch (error) {
    if (useBrowser || !direct || /already (?:downloading|queued)/.test(error.message)) { forget(); throw error; }
    // The helper is unreachable: a plain file can still be saved by the browser itself.
    patchJob(job.id, {engine: 'browser'});
    try { await startBrowserJob(job); } catch (inner) { forget(); throw inner; }
  }
  return {ok: true, id: job.id, engine: job.engine};
}

async function jobAction(message) {
  await jobsReady();
  const job = jobs.find(item => item.id === message.id);
  if (!job && message.action !== 'clear') throw new Error('That download is no longer in the list.');
  switch (message.action) {
    case 'cancel':
    case 'pause':
    case 'stop': {
      if (job.engine === 'browser') { await chrome.downloads.cancel(job.downloadId).catch(() => {}); patchJob(job.id, {state: 'cancelled', detail: 'Cancelled'}); break; }
      const mode = message.action === 'pause' ? 'pause' : message.action === 'stop' ? 'stop' : 'cancel';
      await helper.call('cancel', {id: job.id, mode}).catch(() => {});
      if (['queued', 'starting'].includes(job.state)) patchJob(job.id, {state: mode === 'pause' ? 'paused' : 'cancelled', detail: mode === 'pause' ? 'Paused' : 'Cancelled'});
      break;
    }
    case 'resume':
    case 'retry': {
      if (job.engine === 'browser') throw new Error('Start this download again from the page.');
      const request = job.request;
      // A fresh token is better than the stale one: look for the same video on the tab again.
      if (message.action === 'retry' && job.tabId >= 0) {
        const st = await loadTab(job.tabId).catch(() => null);
        const fresh = st && Object.values(st.items).find(item => item.key === request.key);
        if (fresh) { request.url = fresh.url; request.headers = {...request.headers, ...fresh.headers}; }
      }
      patchJob(job.id, {state: 'queued', detail: 'Starting…', error: '', errorCode: '', progress: job.progress || 0, finished: 0});
      // Same file name: whatever was downloaded before (HLS fragments, partial files) is picked up again.
      try { await startHelperJob(job, job.stem ? {stem: job.stem, resume: true} : {}); }
      catch (error) { patchJob(job.id, {state: 'error', error: error.message, errorCode: error.code || 'unknown'}); throw error; }
      break;
    }
    case 'remove':
      // Giving up on an unfinished download also removes its partial files.
      if (job.engine === 'helper' && job.stem && ['paused', 'error', 'cancelled'].includes(job.state)) helper.call('discard', {stem: job.stem}).catch(() => {});
      jobs.splice(jobs.indexOf(job), 1); persistJobs(); changed('jobs');
      break;
    case 'reveal':
      if (job.engine === 'browser' && job.downloadId != null) chrome.downloads.show(job.downloadId);
      else await helper.call('reveal', {path: job.path});
      break;
    case 'open':
      if (job.engine === 'browser' && job.downloadId != null) chrome.downloads.open(job.downloadId);
      else await helper.call('open', {path: job.path});
      break;
    case 'delete':
      if (job.path) await helper.call('delete_file', {path: job.path}).catch(() => {});
      jobs.splice(jobs.indexOf(job), 1); persistJobs(); changed('jobs');
      break;
    default: throw new Error('Unknown action.');
  }
  return {ok: true};
}

// Browser-engine downloads report through downloads.onChanged; progress is polled while a UI is open.
chrome.downloads.onChanged.addListener(async delta => {
  await jobsReady();
  const job = jobs.find(item => item.downloadId === delta.id);
  if (!job) return;
  const patch = {};
  if (delta.state?.current === 'complete') Object.assign(patch, {state: 'complete', progress: 100, detail: 'Saved', finished: Date.now()});
  if (delta.state?.current === 'interrupted') Object.assign(patch, delta.error?.current === 'USER_CANCELED' ? {state: 'cancelled', detail: 'Cancelled'} : {state: 'error', errorCode: delta.error?.current === 'SERVER_FORBIDDEN' ? 'forbidden' : 'unknown', error: delta.error?.current || 'Interrupted', finished: Date.now()});
  if (delta.filename?.current) patch.path = delta.filename.current;
  if (Object.keys(patch).length) {
    patchJob(job.id, patch);
    if (patch.state === 'complete') {
      const [item] = await chrome.downloads.search({id: delta.id});
      if (item) patchJob(job.id, {path: item.filename, filename: item.filename.split(/[\\/]/).pop(), size: item.fileSize || item.totalBytes});
      notifyFinished(jobs.find(x => x.id === job.id));
    } else if (patch.state === 'error') {
      // A refusal for a direct file may still succeed through the helper (it replays headers and cookies).
      if (patch.errorCode === 'forbidden' && helperUsable()) {
        patchJob(job.id, {engine: 'helper', state: 'queued', detail: 'The browser was refused. Trying with the helper…', error: '', errorCode: '', progress: 0});
        startHelperJob(job).catch(error => { patchJob(job.id, {state: 'error', error: error.message, errorCode: error.code || 'unknown'}); notifyFinished(jobs.find(x => x.id === job.id)); });
      } else notifyFinished(jobs.find(x => x.id === job.id));
    }
  }
});

setInterval(async () => {
  if (!ports.size) return;
  const live = jobs.filter(job => job.engine === 'browser' && ACTIVE.has(job.state) && job.downloadId != null);
  for (const job of live) {
    const [item] = await chrome.downloads.search({id: job.downloadId}).catch(() => []);
    if (item && item.totalBytes > 0 && item.state === 'in_progress') patchJob(job.id, {progress: Math.min(99, item.bytesReceived * 100 / item.totalBytes), downloaded: item.bytesReceived, total: item.totalBytes, size: item.totalBytes});
  }
}, 800);

// ---------------------------------------------------------------------------------------------------
// Settings side effects, side panel and menus
async function applyActionMode() {
  const {openIn} = await getSettings();
  try {
    await chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: openIn === 'sidepanel'});
    await chrome.action.setPopup({popup: openIn === 'sidepanel' ? '' : 'popup.html'});
  } catch { /* side panel unsupported */ }
}

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({id: 'qvs-media', title: 'Download this video with Quick Video Saver', contexts: ['video', 'audio']});
    chrome.contextMenus.create({id: 'qvs-link', title: 'Download this link with Quick Video Saver', contexts: ['link'], targetUrlPatterns: ['*://*/*.mp4*', '*://*/*.webm*', '*://*/*.mkv*', '*://*/*.mov*', '*://*/*.m3u8*', '*://*/*.mpd*', '*://*/*.mp3*', '*://*/*.m4a*']});
    chrome.contextMenus.create({id: 'qvs-page', title: 'Save the video from this page', contexts: ['page']});
    chrome.contextMenus.create({id: 'qvs-panel', title: 'Open Quick Video Saver in the side panel', contexts: ['page', 'action']});
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'qvs-panel') { chrome.sidePanel.open({tabId: tab.id}).catch(() => {}); return; }
  const url = info.menuItemId === 'qvs-page' ? tab.url : info.srcUrl || info.linkUrl;
  const blob = !url || url.startsWith('blob:') || url.startsWith('data:');
  startDownload({tabId: tab.id, link: {url: blob ? tab.url : url, kind: blob || info.menuItemId === 'qvs-page' ? 'page' : undefined, pageURL: blob || info.menuItemId === 'qvs-page' ? '' : tab.url, title: tab.title}})
    .then(() => chrome.sidePanel.open({tabId: tab.id}).catch(() => {}))
    .catch(error => chrome.notifications.create({type: 'basic', iconUrl: 'icons/128.png', title: 'Quick Video Saver', message: error.message}));
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-sidepanel' && tab?.id >= 0) chrome.sidePanel.open({tabId: tab.id}).catch(() => {});
});

// After an install or reload, pages that were already open get the detection scripts without a refresh.
async function injectIntoOpenTabs() {
  for (const tab of await chrome.tabs.query({url: ['http://*/*', 'https://*/*']})) {
    const target = {tabId: tab.id, allFrames: true};
    chrome.scripting.executeScript({target, files: ['inject/hook.js'], world: 'MAIN', injectImmediately: true}).catch(() => {});
    chrome.scripting.executeScript({target, files: ['inject/content.js'], injectImmediately: true}).catch(() => {});
    chrome.scripting.executeScript({target, files: ['inject/overlay.js'], injectImmediately: true}).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(details => {
  buildMenus(); applyActionMode(); injectIntoOpenTabs().catch(() => {});
  // First install: land on Settings, where the one-time helper setup is explained and checked.
  if (details.reason === 'install') chrome.runtime.openOptionsPage().catch(() => {});
});
chrome.runtime.onStartup.addListener(applyActionMode);
chrome.declarativeNetRequest.getSessionRules().then(rules => chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: rules.map(rule => rule.id)})).catch(() => {});

// ---------------------------------------------------------------------------------------------------
// The Download button drawn over videos (inject/overlay.js). Requests come from content scripts, tab-bound.
async function cardForVideo(tabId, frameURL, video) {
  const [st, settings] = await Promise.all([loadTab(tabId), getSettings()]);
  const view = buildView(st, {settings});
  const frame = st.frames[frameURL] || {top: false, videos: []};
  const clean = {src: String(video?.src || ''), blob: !!video?.blob, duration: Number(video?.duration) || 0, sources: Array.isArray(video?.sources) ? video.sources.slice(0, 6).map(s => ({url: String(s?.url || '')})) : []};
  const target = videoTarget(linkContext(st), frameURL, frame, clean);
  let card = target ? view.cards.find(item => item.id === target.id) : null;
  // A blob / MediaSource player has no address of its own: the best card of the page is its video.
  if (!card && (clean.blob || !clean.src)) card = view.cards.find(item => item.group === 'main' && !item.drm) || view.cards.find(item => item.group === 'main') || null;
  return {st, view, card};
}

const overlayApi = {
  async OV_QUERY(message, sender) {
    const tabId = sender.tab.id;
    await jobsReady();
    ensureAnalysis(tabId).catch(() => {});
    if (helper.info.status === 'unknown') helper.ensure().catch(() => {});
    const {view, card} = await cardForVideo(tabId, message.frameURL, message.video);
    const running = card && jobs.find(job => job.cardId === card.id && job.tabId === tabId && ACTIVE.has(job.state));
    return {
      ok: true, analyzing: view.analyzing, pending: view.analyzing || !card || ['none', 'pending'].includes(card.analysis),
      card: card ? {id: card.id, kind: card.kind, title: card.title, live: card.live, drm: !!card.drm, defaultQuality: card.defaultQuality,
        qualities: card.qualities.map(({key, label, size, approx}) => ({key, label, size, approx}))} : null,
      job: running ? overlayJob(running) : null,
    };
  },
  async OV_DOWNLOAD(message, sender) {
    const tabId = sender.tab.id;
    if (message.cardId) {
      const {card} = await cardForVideo(tabId, message.frameURL, message.video);
      if (card && card.id === message.cardId) {
        const quality = card.qualities.find(q => q.key === message.qualityKey)?.key;
        return startDownload({tabId, cardId: card.id, qualityKey: quality, audioOnly: !!message.audioOnly});
      }
    }
    // No card yet (the page is still being studied, or nothing was found): let the helper try the page itself.
    const url = webURL(sender.tab.url);
    if (!url) throw new Error('Open a web page first.');
    return startDownload({tabId, audioOnly: !!message.audioOnly, link: {url, kind: 'page', title: sender.tab.title || 'Video'}});
  },
  async OV_JOBS(message) {
    await jobsReady();
    const out = {};
    for (const id of Array.isArray(message.ids) ? message.ids.slice(0, 8) : []) {
      const job = jobs.find(item => item.id === id);
      if (job) out[id] = overlayJob(job);
    }
    return {ok: true, jobs: out};
  },
  async OV_JOB_ACTION(message) {
    if (!['cancel', 'reveal'].includes(message.action)) throw new Error('Unknown action.');
    return jobAction({id: message.id, action: message.action});
  },
  async OV_HIDE_SITE(message) {
    const host = String(message.host || '');
    const settings = await getSettings();
    if (host && !settings.overlayHidden.includes(host)) await saveSettings({overlayHidden: [...settings.overlayHidden, host]});
    changed('settings');
    return {ok: true};
  },
  async OV_OPEN() { await chrome.runtime.openOptionsPage(); return {ok: true}; },
};

function overlayJob(job) {
  const {id, state, progress, downloaded, speed, error, errorCode} = job;
  return {id, state, progress, downloaded, speed, error, errorCode, explain: state === 'error' ? describeError(errorCode, error) : null};
}

// ---------------------------------------------------------------------------------------------------
// Interface API
function isInterface(sender) { return typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL('')); }

async function getState({tabId, weak}) {
  await jobsReady();
  const settings = await getSettings();
  let tab = null;
  try { tab = tabId >= 0 ? await chrome.tabs.get(tabId) : null; } catch { tab = null; }
  const supported = !!webURL(tab?.url);
  let view = null;
  if (supported) {
    const st = await loadTab(tabId);
    if (tab.title && st.title !== tab.title) st.title = tab.title;
    if (!st.url) st.url = tab.url;
    view = buildView(st, {settings});
    ensureAnalysis(tabId, !!weak).catch(() => {});
  }
  // The helper starts in the background so its status, tools and folder are always current.
  if (helper.info.status === 'unknown') helper.ensure().catch(() => {});
  return {ok: true, tab: tab ? {id: tab.id, url: tab.url, title: tab.title, windowId: tab.windowId, favIcon: tab.favIconUrl || ''} : null, supported, view, jobs: jobs.map(publicJob), helper: helper.info, settings, version: chrome.runtime.getManifest().version};
}

const api = {
  state: getState,
  async scan({tabId}) {
    chrome.tabs.sendMessage(tabId, {type: 'SCAN'}).catch(() => {});
    await mutateTab(tabId, st => {
      for (const item of Object.values(st.items)) if (item.analysis === 'failed') { item.analysis = 'none'; item.mediaTried = false; }
      for (const [url, probe] of Object.entries(st.probes)) if (probe.state === 'failed') delete st.probes[url];
    });
    ensureAnalysis(tabId).catch(() => {});
    return {ok: true};
  },
  async analyze({tabId, url}) {
    const st = await loadTab(tabId);
    const target = webURL(url) || webURL(st.page?.url || st.url);
    if (!target) throw new Error('Open a web page first.');
    limited(() => runProbe(tabId, target, {force: true})).catch(() => {});
    return {ok: true};
  },
  download: params => startDownload(params),
  async probeLink({url, tabId}) {
    const link = webURL(url);
    if (!link) throw new Error('Enter a valid http or https link.');
    let page = '';
    if (tabId >= 0) { try { page = webURL((await chrome.tabs.get(tabId)).url) || ''; } catch { page = ''; } }
    const cookies = await gatherCookies([link, page]);
    const result = await helper.call('probe', {url: link, pageURL: page, headers: {'User-Agent': USER_AGENT}, cookies});
    return {ok: true, info: result.info};
  },
  job: jobAction,
  async clearFinished() {
    await jobsReady();
    jobs = jobs.filter(job => ACTIVE.has(job.state) || job.state === 'paused');
    persistJobs(); changed('jobs');
    return {ok: true};
  },
  async settings({patch}) {
    const before = await getSettings();
    const next = await saveSettings(patch || {});
    await applyActionMode();
    const helperKeys = ['folder', 'parallel', 'container', 'audioFormat', 'preferCompat', 'subtitles', 'fragments', 'autoUpdate'];
    if (helperKeys.some(key => key in patch && patch[key] !== before[key])) {
      // A connection that is still starting has read the old values: let it finish, then push the new ones.
      if (helper.connecting) await helper.connecting.catch(() => {});
    }
    if (helper.info.status === 'ready' && helperKeys.some(key => key in patch && patch[key] !== before[key])) {
      try {
        const config = {folder: next.folder, parallel: next.parallel, container: next.container, audioFormat: next.audioFormat, preferCompat: next.preferCompat, subtitles: next.subtitles, fragments: next.fragments, autoUpdate: next.autoUpdate};
        const reply = await helper.call('configure', {config});
        helper.set({folder: reply.folder});
      } catch (error) { await saveSettings({folder: before.folder}); throw error; }
    }
    changed('settings');
    return {ok: true, settings: next};
  },
  async helper({action, path}) {
    if (action === 'check') { try { await helper.ensure(true); } catch { /* state carries the reason */ } return {ok: true, helper: helper.info}; }
    if (action === 'openFolder') { await helper.call('folder'); return {ok: true}; }
    if (action === 'chooseFolder') {
      const result = await helper.call('choose_folder', {start: (await getSettings()).folder || helper.info.folder});
      return {ok: true, folder: result.folder || ''};
    }
    if (action === 'update') { const result = await helper.call('update'); return {ok: true, result}; }
    if (action === 'reveal') { await helper.call('reveal', {path}); return {ok: true}; }
    throw new Error('Unknown helper action.');
  },
  async exists() {
    await jobsReady();
    const finished = jobs.filter(job => job.state === 'complete' && job.path).slice(0, 60);
    if (!finished.length || !helperUsable()) return {ok: true};
    try {
      const {exists} = await helper.call('exists', {paths: finished.map(job => job.path)});
      for (const job of finished) job.missing = exists[job.path] === false;
      changed('jobs');
    } catch { /* helper offline */ }
    return {ok: true};
  },
  async openPanel({windowId}) { await chrome.sidePanel.open({windowId}); return {ok: true}; },
};

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'PAGE' || message?.type === 'HOOK') {
    fromContent(message, sender).catch(() => {}).finally(() => respond({ok: true}));
    return true;
  }
  if (typeof message?.type === 'string' && message.type.startsWith('OV_')) {
    const handler = overlayApi[message.type];
    if (!handler || !(sender.tab?.id >= 0)) { respond({ok: false, error: 'Unknown request.'}); return; }
    handler(message, sender).then(result => respond(result), error => respond({ok: false, error: error.message, code: error.code}));
    return true;
  }
  if (!isInterface(sender)) { respond({ok: false, error: 'This action is only available inside Quick Video Saver.'}); return; }
  const handler = api[message?.type];
  if (!handler) { respond({ok: false, error: 'Unknown request.'}); return; }
  handler(message).then(result => respond(result?.ok === undefined ? {ok: true, ...result} : result), error => respond({ok: false, error: error.message, code: error.code}));
  return true;
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'ui' || !isInterface(port.sender)) return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
});
