// Quick Video Saver interface: one app for the popup, the side panel and a full tab.
import {h, clear, syncList, setText, setHidden, openMenu, closeMenu, toast} from './dom.js';
import {icon, logo} from './icons.js';
import {debounce, readableDuration, readableSpeed, readableEta, readableBytes, sizeLabel, webURL, hostOf} from '../lib/util.js';
import {fileBase} from '../lib/title.js';
import {prettyCodecs} from '../lib/manifest.js';

const MODE = document.body.dataset.mode || 'popup';
const QUALITY_NAME = /^\d{2,4}p\d*$/;
const ACTIVE = new Set(['queued', 'starting', 'downloading', 'processing']);

const S = {tab: null, tabInfo: null, supported: true, view: null, jobs: [], helper: {status: 'unknown'}, settings: {}, version: '', ready: false,
  ui: {page: document.body.dataset.view || 'videos', prefs: new Map(), temp: [], moreOpen: false, linkBusy: false, analyzeBusy: false, updating: false, checking: false, lastExists: 0}};
const R = {};

// ---------------------------------------------------------------------------------------------- messaging
async function send(message) {
  let response;
  try { response = await chrome.runtime.sendMessage(message); }
  catch { throw new Error('The extension was reloaded. Close and reopen this window.'); }
  if (!response || response.ok === false) throw Object.assign(new Error(response?.error || 'The extension did not answer.'), {code: response?.code});
  return response;
}

const prefFor = card => { let pref = S.ui.prefs.get(card.id); if (!pref) { pref = {quality: '', name: '', renaming: false, details: false}; S.ui.prefs.set(card.id, pref); } return pref; };
const qualityOf = (card, pref) => card.qualities.find(q => q.key === (pref.quality || card.defaultQuality)) || card.qualities[0];
const helperOK = () => S.helper.status === 'ready' && S.helper.ready;
const helperMissing = () => ['missing', 'forbidden', 'outdated'].includes(S.helper.status);

// ---------------------------------------------------------------------------------------------- tab tracking
async function pickTab() {
  if (MODE === 'popup' || MODE === 'panel') {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    return tab || null;
  }
  const tabs = await chrome.tabs.query({url: ['http://*/*', 'https://*/*']});
  return tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
}

async function retarget() {
  const tab = await pickTab();
  if (tab?.id !== S.tab?.id || tab?.url !== S.tab?.url) { S.tab = tab; closeMenu(); }
  scheduleRefresh();
}

let refreshing = false, again = false;
async function refresh() {
  if (refreshing) { again = true; return; }
  refreshing = true;
  try {
    do {
      again = false;
      const res = await send({type: 'state', tabId: S.tab?.id ?? -1, weak: S.ui.moreOpen});
      Object.assign(S, {supported: res.supported, view: res.view, jobs: res.jobs, helper: res.helper, settings: res.settings, tabInfo: res.tab, version: res.version, ready: true});
      render();
    } while (again);
  } catch (error) {
    R.fatal.hidden = false;
    // Files were replaced but the browser still runs the previous background service ("Unknown action."
    // is how version 1 answered a request it does not know). Reloading the extension fixes that by itself.
    if (/^Unknown (?:action|request)\./.test(error.message)) {
      let recent = false;
      try { recent = Date.now() - Number(localStorage.getItem('qvs-self-reload') || 0) < 60000; localStorage.setItem('qvs-self-reload', String(Date.now())); } catch { /* storage unavailable */ }
      if (!recent) { setText(R.fatalText, 'Updating the extension…'); setTimeout(() => chrome.runtime.reload(), 300); }
      else setText(R.fatalText, 'The extension was updated but the browser still runs the old version. Open the extensions page, press Reload on Quick Video Saver, then reopen this window.');
    } else setText(R.fatalText, error.message);
  } finally { refreshing = false; }
}
const scheduleRefresh = debounce(refresh, 70);

// ---------------------------------------------------------------------------------------------- small builders
const iconBtn = (name, label, onClick, extra = '') => h('button', {class: 'iconbtn ' + extra, title: label, 'aria-label': label, onClick}, icon(name, 20));
// A number that changes gets a small pop so the eye notices it.
function setCount(el, text) { if (el.textContent === text) return; el.textContent = text; el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
const chip = (text, kind = '') => h('span', {class: 'chip ' + kind, text});
const go = page => { S.ui.page = page; closeMenu(); render(); R.scroll.scrollTop = 0; if (page === 'downloads') exists(); };
async function exists() { if (Date.now() - S.ui.lastExists > 8000) { S.ui.lastExists = Date.now(); send({type: 'exists'}).catch(() => {}); } }

async function copy(text, done = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(done, {kind: 'success', ms: 1800}); }
  catch { toast('Could not copy to the clipboard.', {kind: 'error'}); }
}

function applyTheme() {
  const theme = S.settings.theme || 'system';
  const root = document.documentElement;
  try { localStorage.setItem('qvs-theme', theme); } catch { /* storage unavailable */ }
  if ((root.dataset.theme || 'system') === theme) return;
  root.classList.add('theme-switch'); // colors change at once instead of fading through the old palette
  if (theme === 'system') root.removeAttribute('data-theme'); else root.dataset.theme = theme;
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switch')));
}

// ---------------------------------------------------------------------------------------------- shell
function buildShell() {
  const app = document.getElementById('app');
  R.fatalText = h('span');
  R.fatal = h('div', {class: 'notice bad', hidden: true}, icon('alert', 20), h('div', {}, h('h3', {text: 'Something went wrong'}), R.fatalText));
  R.dock = iconBtn('sidebar', 'Open in side panel', onDock);
  R.settingsBtn = iconBtn('sliders', 'Settings', () => go('settings'));
  R.tabVideos = h('button', {class: 'tab', role: 'tab', onClick: () => go('videos')}, icon('film', 18), 'Videos', R.countVideos = h('span', {class: 'count', text: '0'}));
  R.tabDownloads = h('button', {class: 'tab', role: 'tab', onClick: () => go('downloads')}, icon('download', 18), 'Downloads', R.countDownloads = h('span', {class: 'count', text: '0'}));
  R.tabs = h('nav', {class: 'tabs', role: 'tablist', dataset: {page: 'videos'}}, h('i', {class: 'tab-thumb'}), R.tabVideos, R.tabDownloads);
  R.vVideos = buildVideos();
  R.vDownloads = buildDownloads();
  R.vSettings = buildSettings();
  R.scroll = h('main', {class: 'scroll'}, R.fatal, R.vVideos, R.vDownloads, R.vSettings);
  R.statusDot = h('span', {class: 'dot'});
  R.statusText = h('span', {class: 'grow'});
  R.statusAction = h('button', {class: 'linkbtn', onClick: () => go('settings')});
  R.folderBtn = iconBtn('folder', 'Open the downloads folder', openFolder);
  R.status = h('footer', {class: 'statusbar'}, R.statusDot, R.statusText, R.statusAction, R.folderBtn);
  app.append(h('div', {class: 'shell'}, h('header', {class: 'top'}, logo(38), h('div', {class: 'grow'}, h('h1', {text: 'Quick Video Saver'}), h('div', {class: 'tag', text: 'Save videos from any page'})), R.dock, R.settingsBtn), R.tabs, R.scroll, R.status));
}

async function onDock() {
  if (MODE === 'popup') {
    try { await chrome.sidePanel.open({windowId: S.tabInfo?.windowId ?? (await chrome.windows.getCurrent()).id}); window.close(); }
    catch (error) { toast('The side panel could not be opened: ' + error.message, {kind: 'error'}); }
  } else {
    await setSetting({openIn: 'popup'});
    toast('The toolbar button now opens a popup.', {kind: 'success'});
  }
}

async function openFolder() {
  try { if (helperOK()) await send({type: 'helper', action: 'openFolder'}); else chrome.downloads.showDefaultFolder(); }
  catch (error) { toast(error.message, {kind: 'error'}); }
}

async function setSetting(patch) {
  try { await send({type: 'settings', patch}); }
  catch (error) { toast(error.message, {kind: 'error'}); }
  scheduleRefresh();
}

// ---------------------------------------------------------------------------------------------- videos view
function buildVideos() {
  R.favicon = h('span', {class: 'favph'}, icon('globe', 12));
  R.pageHost = h('span', {class: 'host'});
  R.pageTitle = h('span', {class: 'ptitle grow'});
  R.analyzing = h('span', {class: 'analyzing', hidden: true}, h('i', {class: 'spinner'}), 'Analyzing…');
  // Labelled buttons: nobody has to guess what an icon does.
  R.rescan = h('button', {class: 'btn small ghost', title: 'Look for videos on this page again', onClick: onRescan}, icon('refresh', 16), 'Rescan');
  R.analyze = h('button', {class: 'btn small ghost', title: 'Let the helper study this page to find hidden videos', onClick: onAnalyze}, icon('sparkle', 16), 'Analyze page');
  R.pagebar = h('div', {class: 'pagebar'}, h('div', {class: 'page-info'}, R.favicon, R.pageHost, R.pageTitle), h('div', {class: 'page-actions'}, R.analyzing, R.rescan, R.analyze));
  R.notices = h('div');
  R.cards = h('div', {class: 'cards'});
  R.skeleton = h('div', {class: 'cards', hidden: true}, [0, 1].map(() => h('div', {class: 'card'}, h('div', {class: 'thumb'}), h('div', {class: 'card-body'}, h('span', {class: 'skeleton', style: {width: '80%', height: '14px'}}), h('span', {class: 'skeleton'})))));
  R.moreToggle = h('button', {class: 'more-toggle', 'aria-expanded': 'false', onClick: () => { S.ui.moreOpen = !S.ui.moreOpen; render(); scheduleRefresh(); }}, R.moreLabel = h('span'), icon('chevronDown', 16));
  R.moreCards = h('div', {class: 'cards', hidden: true});
  R.empty = h('div', {class: 'empty', hidden: true},
    h('div', {class: 'art'}, R.emptyIcon = h('span')), R.emptyTitle = h('h2'), R.emptyText = h('p'),
    h('div', {class: 'row'}, R.emptyScan = h('button', {class: 'btn ghost', onClick: onRescan}, icon('refresh', 16), 'Scan again'), R.emptyAnalyze = h('button', {class: 'btn primary', onClick: onAnalyze}, icon('sparkle', 16), 'Analyze page')));
  R.link = h('input', {class: 'field', type: 'url', placeholder: 'Paste a video or page link…', spellcheck: false, 'aria-label': 'Video or page link'});
  R.linkGo = h('button', {class: 'btn ghost', type: 'submit'}, icon('link', 16), 'Find');
  R.linkbox = h('form', {class: 'linkbox', onSubmit: onLink}, R.link, R.linkGo);
  return h('section', {}, R.pagebar, R.notices, R.cards, R.skeleton, R.moreToggle, R.moreCards, R.empty, R.linkbox);
}

async function onRescan() {
  if (!S.tab) return;
  try { await send({type: 'scan', tabId: S.tab.id}); toast('Scanning the page…', {ms: 1500}); } catch (error) { toast(error.message, {kind: 'error'}); }
}

async function onAnalyze() {
  if (!S.tab || S.ui.analyzeBusy) return;
  if (helperMissing()) { toast('Page analysis needs the helper.', {kind: 'error', action: {label: 'Set up', run: () => go('settings')}}); return; }
  S.ui.analyzeBusy = true; render();
  try { await send({type: 'analyze', tabId: S.tab.id, url: S.tab.url}); toast('Studying this page with the helper…', {ms: 2500}); }
  catch (error) { toast(error.message, {kind: 'error'}); }
  setTimeout(() => { S.ui.analyzeBusy = false; render(); }, 1500);
}

async function onLink(event) {
  event.preventDefault();
  const url = webURL(R.link.value.trim());
  if (!url) { toast('Paste a full http or https link.', {kind: 'error'}); return; }
  if (S.ui.linkBusy) return;
  S.ui.linkBusy = true; R.linkGo.disabled = true; render();
  try {
    const {info} = await send({type: 'probeLink', url, tabId: S.tab?.id ?? -1});
    const id = 'temp:' + url;
    S.ui.temp = S.ui.temp.filter(card => card.id !== id);
    if (info.kind === 'playlist') {
      toast(`${info.entries.length} videos found. Showing the first ones.`, {kind: 'success'});
      for (const entry of info.entries.slice(0, 6).reverse()) S.ui.temp.unshift(tempCard('temp:' + entry.url, entry.url, {title: entry.title, duration: entry.duration, thumbnail: entry.thumbnail, qualities: []}));
    } else S.ui.temp.unshift(tempCard(id, url, info));
    R.link.value = '';
  } catch (error) {
    if (helperMissing() && /\.(?:mp4|webm|mkv|mov|m4v|mp3|m4a)(?:[?#]|$)/i.test(url)) {
      try { await send({type: 'download', tabId: S.tab?.id ?? -1, link: {url, kind: 'file', title: 'Video'}}); toast('Download started with the browser.', {kind: 'success'}); R.link.value = ''; go('downloads'); }
      catch (inner) { toast(inner.message, {kind: 'error'}); }
    } else toast(error.message, {kind: 'error', action: helperMissing() ? {label: 'Set up', run: () => go('settings')} : null});
  }
  S.ui.linkBusy = false; R.linkGo.disabled = false; render();
}

function tempCard(id, url, info) {
  const qualities = (info.qualities || []).map(q => ({key: q.formatId || String(q.height), label: q.label, height: q.height, size: q.size, approx: q.approx, codecs: [q.vcodec && prettyCodecs(q.vcodec), q.hdr ? 'HDR' : ''].filter(Boolean).join(' '), formatId: q.formatId, hasAudio: q.hasAudio}));
  if (!qualities.length) qualities.push({key: 'best', label: info.single?.height ? info.single.height + 'p' : 'Best', height: info.single?.height || 0, size: info.single?.size || 0, approx: !info.single?.size, codecs: ''});
  return {id, temp: {url: info.webpage_url || url, info}, source: 'page', kind: 'page', title: info.title || hostOf(url) || 'Video', host: hostOf(url), subtitle: [info.site, info.uploader].filter(Boolean).join(' · ') || hostOf(url), poster: info.thumbnail || '', thumb: '', container: (info.ext || 'video').toUpperCase(),
    duration: info.duration || 0, live: !!info.live, drm: info.drm ? 'DRM' : '', qualities, defaultQuality: qualities[0].key, size: qualities[0].size, approx: qualities[0].approx, resolution: qualities[0].label, weak: false, url, group: 'main', analysis: 'done', audio: info.audio};
}

function suggestedName(card, pref, audio = false) {
  const quality = qualityOf(card, pref);
  return fileBase(card.title, {quality: !audio && QUALITY_NAME.test(quality?.label || '') ? quality.label : '', template: S.settings.nameTemplate || '{title} [{quality}]'});
}

async function startCard(card, {audioOnly = false, engine} = {}) {
  const pref = prefFor(card);
  const quality = qualityOf(card, pref);
  const name = pref.name || '';
  try {
    if (card.temp) {
      await send({type: 'download', tabId: S.tab?.id ?? -1, cardId: card.id, audioOnly, name, link: {url: card.temp.url, kind: 'page', title: card.title, qualityLabel: quality?.label, duration: card.duration, live: card.live, thumb: card.poster,
        format: quality?.formatId ? {formatId: quality.formatId, hasAudio: quality.hasAudio, height: quality.height} : quality?.height ? {height: quality.height} : {}}});
    } else await send({type: 'download', tabId: S.tab.id, cardId: card.id, qualityKey: quality?.key, audioOnly, name, engine});
    toast(audioOnly ? 'Saving the audio…' : 'Download started', {kind: 'success', ms: 2200});
  } catch (error) {
    const needsHelper = /helper|setup|Settings/i.test(error.message);
    toast(error.message, {kind: 'error', ms: 6500, action: needsHelper ? {label: 'Set up', run: () => go('settings')} : /no longer on the page/i.test(error.message) ? {label: 'Scan again', run: onRescan} : null});
  }
}

function qualityMenu(card, button) {
  const pref = prefFor(card);
  const current = qualityOf(card, pref).key;
  openMenu(button, [
    ...card.qualities.map(q => ({label: q.label, sub: q.codecs || '', hint: sizeLabel(q.size, q.approx) || '', checked: q.key === current, radio: true, run: () => { pref.quality = q.key; render(); }})),
  ], {title: 'Quality'});
}

function cardMenu(card, button) {
  const pref = prefFor(card);
  openMenu(button, [
    {icon: 'music', label: `Save audio only (${(S.settings.audioFormat || 'mp3').toUpperCase()})`, disabled: !!card.drm, run: () => startCard(card, {audioOnly: true})},
    {icon: 'edit', label: 'Rename file…', run: () => { pref.renaming = true; if (!pref.name) pref.name = suggestedName(card, pref); render(); setTimeout(() => button.closest('.card')?.querySelector('.rename input')?.select(), 30); }},
    {icon: 'info', label: pref.details ? 'Hide details' : 'Show details', run: () => { pref.details = !pref.details; render(); }},
    {separator: true},
    {icon: 'copy', label: 'Copy link', run: () => copy(card.url, 'Link copied')},
    card.kind === 'file' && {icon: 'download', label: 'Download with the browser', run: () => startCard(card, {engine: 'browser'})},
    card.source === 'item' && card.kind !== 'file' && {icon: 'sparkle', label: 'Re-analyze this stream', run: onRescan},
  ]);
}

function makeCard() {
  const r = {};
  r.img = h('img', {alt: '', referrerPolicy: 'no-referrer', loading: 'lazy', hidden: true});
  r.placeholder = h('span', {}, icon('film', 28));
  r.dur = h('span', {class: 'dur', hidden: true});
  r.live = h('span', {class: 'live', text: 'LIVE', hidden: true});
  r.thumb = h('div', {class: 'thumb'}, r.placeholder, r.img, r.live, r.dur);
  r.title = h('h3', {class: 'card-title'});
  r.chips = h('div', {class: 'chips'});
  r.sub = h('div', {class: 'card-sub'});
  r.ribbon = h('span', {class: 'ribbon', text: 'Best match', hidden: true});
  r.qbtn = h('button', {class: 'qbtn', 'aria-haspopup': 'menu'}, r.qlabel = h('span', {class: 'q-label'}), r.qsize = h('span', {class: 'q-size'}), icon('chevronDown', 18));
  r.dl = h('button', {class: 'btn primary'}, icon('download', 20), r.dlLabel = h('span', {text: 'Download'}));
  r.more = iconBtn('more', 'More options', null);
  r.actions = h('div', {class: 'card-actions'}, r.qbtn, r.dl, r.more);
  r.bar = h('div', {class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100'}, r.fill = h('i'));
  r.pLabel = h('span', {class: 'pp-label'});
  r.pPct = h('span', {class: 'pp-pct'});
  r.pSpeed = h('span', {class: 'pp-speed'});
  r.pSize = h('span', {class: 'pp-size'});
  r.pauseLabel = h('span', {text: 'Pause'}); r.pauseIcon = h('span', {class: 'btn-icon'}, icon('pause', 16));
  r.pause = h('button', {class: 'btn small ghost'}, r.pauseIcon, r.pauseLabel);
  r.stopLabel = h('span', {text: 'Cancel'});
  r.stop = h('button', {class: 'btn small ghost danger-text'}, icon('x', 16), r.stopLabel);
  r.progress = h('div', {class: 'card-progress progress-panel', hidden: true},
    h('div', {class: 'pp-head'}, h('span', {class: 'pp-icon'}, icon('download', 18)), r.pLabel, r.pPct), r.bar,
    h('div', {class: 'pp-meta'}, r.pSpeed, r.pSize), h('div', {class: 'pp-actions'}, r.pause, r.stop));
  r.done = h('div', {class: 'card-done', hidden: true}, icon('checkCircle', 26, 'done-icon'), h('div', {class: 'done-text grow'}, h('b', {text: 'Download complete'}), r.doneName = h('span', {class: 'done-name'})),
    h('div', {class: 'done-actions'}, r.open = h('button', {class: 'btn small ghost'}, icon('play', 16), 'Open'), r.reveal = h('button', {class: 'btn small ghost'}, icon('folderOpen', 16), 'Show')));
  r.failTitle = h('b'); r.failText = h('small'); r.retry = h('button', {class: 'btn small ghost'}, icon('retry', 16), h('span', {text: 'Try again'}));
  r.fail = h('div', {class: 'card-fail', hidden: true}, h('div', {style: {display: 'flex', gap: '8px', alignItems: 'center'}}, icon('alertCircle', 20), r.failTitle), r.failText, r.retry);
  r.rename = h('div', {class: 'rename', hidden: true}, r.nameInput = h('input', {class: 'field', spellcheck: false, 'aria-label': 'File name'}), r.nameDone = h('button', {class: 'btn small ghost', text: 'OK'}));
  r.detail = h('div', {class: 'detail', hidden: true});
  const node = h('article', {class: 'card'}, r.thumb, h('div', {class: 'card-body'}, r.ribbon, r.title, r.chips, r.sub), r.actions, r.progress, r.done, r.fail, r.rename, r.detail);
  node._r = r;
  return node;
}

const JOB_FRESH = {complete: 6 * 60e3, error: 3 * 60e3};
function cardJob(card) {
  const job = S.jobs.find(item => item.cardId === card.id && (card.temp || item.tabId === S.tab?.id));
  if (!job) return null;
  if (ACTIVE.has(job.state) || job.state === 'paused') return job;
  const age = Date.now() - (job.finished || job.updated || 0);
  return JOB_FRESH[job.state] && age < JOB_FRESH[job.state] && !job.missing ? job : null;
}

// ---- shared wording for a running download (card panel and Downloads list)
const isWaiting = job => job.state === 'queued' || job.state === 'starting' || (job.state === 'downloading' && !job.progress && !job.downloaded);
function stateLabel(job) {
  if (job.state === 'paused') return 'Paused';
  if (job.state === 'processing') return 'Finishing the file…';
  if (job.live && job.downloaded) return 'Recording live stream';
  if (job.state === 'queued') return 'Waiting in queue';
  if (isWaiting(job)) return job.attempt > 1 ? `Retrying (${job.strategy || 'another way'})` : 'Getting ready…';
  if (job.attempt > 1) return `Downloading · ${job.strategy}`;
  return 'Downloading';
}
const percentText = job => job.state === 'processing' ? '99%' : job.progress > 0 && !job.live ? `${Math.floor(job.progress)}%` : '';
const speedText = job => job.state === 'downloading' ? [readableSpeed(job.speed), readableEta(job.eta)].filter(Boolean).join('  ·  ') : '';
const sizeText = job => job.total && job.downloaded ? `${readableBytes(job.downloaded)} of ${readableBytes(job.total)}` : job.downloaded ? readableBytes(job.downloaded) : '';
function paintBar(bar, fill, job) {
  const waiting = isWaiting(job) || job.state === 'processing';
  bar.classList.toggle('indeterminate', waiting);
  bar.dataset.state = job.state === 'paused' ? 'paused' : 'running';
  bar.setAttribute('aria-valuenow', String(Math.round(job.progress || 0)));
  fill.style.width = (waiting ? 35 : Math.max(2, job.progress || 0)) + '%';
}

function patchCard(node, card) {
  const r = node._r;
  const pref = prefFor(card);
  const quality = qualityOf(card, pref);
  node.classList.toggle('best', !!card.best);
  setHidden(r.ribbon, !card.best);
  setText(r.title, card.title); r.title.title = card.title;
  setText(r.sub, card.subtitle || card.host || '');
  // artwork
  const art = card.thumb || card.poster;
  if (art) { if (r.img.getAttribute('src') !== art) { r.img.hidden = false; r.img.src = art; r.img.onerror = () => { r.img.hidden = true; r.placeholder.hidden = false; }; } } else r.img.hidden = true;
  setHidden(r.placeholder, !!art && !r.img.hidden);
  const duration = readableDuration(card.duration);
  setText(r.dur, duration); setHidden(r.dur, !duration || card.live);
  setHidden(r.live, !card.live);
  // chips
  const chips = [chip(card.container || 'VIDEO', 'accent')];
  if (card.live) chips.push(chip('Live stream', 'bad'));
  if (card.drm) chips.push(chip('DRM protected', 'bad'));
  if (quality?.label && quality.label !== 'Original' && quality.label !== 'Best') chips.push(chip(quality.label));
  if (quality?.codecs) chips.push(chip(quality.codecs));
  const size = sizeLabel(quality?.size, quality?.approx);
  if (size) chips.push(chip(size));
  else if (card.analysis === 'pending') chips.push(h('span', {class: 'skeleton', title: 'Studying this video…'}));
  if (card.tracks?.audio > 1) chips.push(chip(`${card.tracks.audio} audio tracks`));
  const signature = chips.map(c => c.className + c.textContent).join('|');
  if (r.chips.dataset.sig !== signature) { r.chips.dataset.sig = signature; clear(r.chips).append(...chips); }
  // quality picker & main button
  const multi = card.qualities.length > 1;
  setHidden(r.qbtn, !multi);
  if (multi) { setText(r.qlabel, quality.label); setText(r.qsize, sizeLabel(quality.size, quality.approx)); }
  r.qbtn.onclick = () => qualityMenu(card, r.qbtn);
  r.dl.disabled = !!card.drm;
  setText(r.dlLabel, card.drm ? 'Protected' : 'Download');
  r.dl.onclick = () => startCard(card);
  r.more.onclick = () => cardMenu(card, r.more);
  // live state of a download started from this card
  const job = cardJob(card);
  const active = job && (ACTIVE.has(job.state) || job.state === 'paused');
  setHidden(r.actions, !!job);
  setHidden(r.progress, !active);
  setHidden(r.done, !(job && job.state === 'complete'));
  setHidden(r.fail, !(job && job.state === 'error'));
  if (active) {
    r.progress.dataset.state = job.state === 'paused' ? 'paused' : isWaiting(job) ? 'waiting' : job.state;
    paintBar(r.bar, r.fill, job);
    setText(r.pLabel, stateLabel(job)); setText(r.pPct, percentText(job));
    setText(r.pSpeed, speedText(job) || (isWaiting(job) ? job.detail || '' : '')); setText(r.pSize, sizeText(job));
    const canPause = job.engine === 'helper' && !job.live && job.state !== 'paused';
    setHidden(r.pause, !(canPause || job.state === 'paused'));
    const paused = job.state === 'paused';
    setText(r.pauseLabel, paused ? 'Resume' : 'Pause');
    if (r.pauseIcon.dataset.kind !== String(paused)) { r.pauseIcon.dataset.kind = String(paused); clear(r.pauseIcon).append(icon(paused ? 'play' : 'pause', 16)); }
    r.pause.onclick = () => jobAct(job, paused ? 'resume' : 'pause');
    r.stop.onclick = () => jobAct(job, job.live ? 'stop' : paused ? 'remove' : 'cancel');
    setText(r.stopLabel, job.live ? 'Stop and save' : paused ? 'Discard' : 'Cancel');
  }
  if (job?.state === 'complete') {
    setText(r.doneName, job.filename || job.name);
    r.open.onclick = () => jobAct(job, 'open'); r.reveal.onclick = () => jobAct(job, 'reveal');
  }
  if (job?.state === 'error') {
    const why = job.explain || {};
    setText(r.failTitle, why.title || 'The download failed'); setText(r.failText, why.hint || job.error || '');
    r.retry.onclick = () => jobAct(job, why.action === 'update' ? 'update' : 'retry');
    setText(r.retry, why.action === 'update' ? 'Update downloader' : 'Try again');
  }
  // inline editors
  setHidden(r.rename, !pref.renaming);
  if (pref.renaming && document.activeElement !== r.nameInput && r.nameInput.value !== pref.name) r.nameInput.value = pref.name;
  r.nameInput.oninput = () => { pref.name = r.nameInput.value; };
  r.nameInput.onkeydown = event => { if (event.key === 'Enter') { pref.renaming = false; render(); } if (event.key === 'Escape') { pref.renaming = false; pref.name = ''; render(); } };
  r.nameDone.onclick = () => { pref.renaming = false; render(); };
  setHidden(r.detail, !pref.details);
  if (pref.details) {
    const rows = [['Format', [card.container, quality?.codecs].filter(Boolean).join(' · ')], ['Quality', quality?.label], ['Size', sizeLabel(quality?.size, quality?.approx)], ['Duration', duration], ['Source', card.host],
      ['File name', pref.name || suggestedName(card, pref)], ['Link', card.url.length > 90 ? card.url.slice(0, 90) + '…' : card.url]];
    const dl = h('dl', {}, rows.filter(([, value]) => value).map(([key, value]) => [h('dt', {text: key}), h('dd', {text: value})]));
    if (r.detail.dataset.sig !== dl.textContent) { r.detail.dataset.sig = dl.textContent; clear(r.detail).append(dl); }
  }
}

function renderVideos() {
  const view = S.view;
  const supported = S.supported && view;
  setHidden(R.pagebar, !supported);
  setHidden(R.linkbox, false);
  clear(R.notices);
  if (supported) {
    setText(R.pageHost, view.host || '');
    setText(R.pageTitle, view.title || '');
    const fav = S.tabInfo?.favIcon;
    if (fav && R.favicon.dataset.src !== fav) { R.favicon.dataset.src = fav; clear(R.favicon).append(h('img', {src: fav, alt: '', width: 18, height: 18, referrerPolicy: 'no-referrer', onError: e => e.target.replaceWith(icon('globe', 12))})); }
    setHidden(R.analyzing, !view.analyzing);
    R.analyze.disabled = S.ui.analyzeBusy;
  }
  // setup / health notices
  if (S.ready && helperMissing()) R.notices.append(setupNotice());
  else if (S.helper.status === 'error') R.notices.append(h('div', {class: 'notice warn'}, icon('alert', 20), h('h3', {text: 'The helper stopped'}), h('p', {text: S.helper.error || 'It will be restarted on the next download.'}), h('div', {class: 'notice-actions'}, h('button', {class: 'btn small ghost', text: 'Check again', onClick: recheckHelper}))));
  if (S.helper.error && S.helper.status === 'ready') R.notices.append(h('div', {class: 'notice warn'}, icon('alert', 20), h('h3', {text: 'Setting not applied'}), h('p', {text: S.helper.error})));
  const cards = [...S.ui.temp, ...(supported ? view.cards : [])];
  const main = cards.filter(card => card.temp || card.group === 'main');
  const more = cards.filter(card => !card.temp && card.group === 'more');
  syncList(R.cards, main, card => card.id, makeCard, patchCard);
  setHidden(R.moreToggle, !more.length);
  setText(R.moreLabel, `${S.ui.moreOpen ? 'Hide' : 'Show'} ${more.length} other source${more.length === 1 ? '' : 's'}`);
  R.moreToggle.setAttribute('aria-expanded', String(S.ui.moreOpen));
  setHidden(R.moreCards, !S.ui.moreOpen || !more.length);
  syncList(R.moreCards, S.ui.moreOpen ? more : [], card => card.id, makeCard, patchCard);
  const loading = supported && view.analyzing && !cards.length;
  setHidden(R.skeleton, !loading);
  const empty = !cards.length && !loading;
  setHidden(R.empty, !empty);
  if (empty) renderEmpty(supported, view);
  const total = main.filter(card => !card.temp).length;
  setCount(R.countVideos, String(total));
  R.countVideos.classList.toggle('live', total > 0);
}

function renderEmpty(supported, view) {
  let icn = 'film', title = 'No video found yet', text = 'Play the video on the page. It appears here automatically.', analyze = true;
  if (!supported) { icn = 'globe'; title = 'Open a website with a video'; text = 'Quick Video Saver works on regular web pages. Browser pages and the new-tab page cannot be scanned.'; analyze = false; }
  else if (view.hint === 'drm') { icn = 'lock'; title = 'This video is DRM-protected'; text = 'Encrypted streaming (Widevine, PlayReady, FairPlay) cannot be saved by any downloader. Free or non-DRM videos on the same site work normally.'; analyze = false; }
  else if (view.hint === 'blob') { icn = 'radio'; title = 'A streaming video is playing'; text = 'Its address is hidden by the site. Analyze the page so the helper can find the real stream.'; }
  else if (view.hint === 'partial') { icn = 'sparkle'; title = 'This site streams in pieces'; text = 'The page-level analysis finds the full video and every quality, instead of loose fragments.'; }
  else if (view.pageProbe.state === 'failed') { icn = 'alert'; title = 'Nothing to download here'; text = view.pageProbe.error ? view.pageProbe.error.slice(0, 160) : 'The helper could not find a video on this page.'; }
  clear(R.emptyIcon).append(icon(icn, 34));
  setText(R.emptyTitle, title); setText(R.emptyText, text);
  setHidden(R.emptyScan, !supported); setHidden(R.emptyAnalyze, !analyze);
  R.emptyAnalyze.disabled = S.ui.analyzeBusy;
}

function setupNotice() {
  const outdated = S.helper.status === 'outdated';
  return h('div', {class: 'notice' + (outdated ? ' warn' : '')}, icon(outdated ? 'alert' : 'shield', 20), h('h3', {text: outdated ? 'The helper needs an update' : 'One-time helper setup'}),
    h('p', {text: outdated ? 'This extension is newer than the helper your browser is connected to. Run the setup that comes with this version:' : 'Direct files already work. For streams (HLS, DASH), 1000+ sites and the best quality, install the free local helper:'}),
    h('ol', {}, h('li', {}, 'Extract the downloaded ZIP to a permanent folder.'), h('li', {}, 'Double-click ', h('b', {text: 'SETUP-WINDOWS.cmd'}), ' inside it.'), h('li', {}, 'Restart the browser, then press “Check again”.')),
    h('div', {class: 'notice-actions'}, h('button', {class: 'btn small primary', onClick: recheckHelper}, icon('refresh', 15), S.ui.checking ? 'Checking…' : 'Check again')));
}

async function recheckHelper() {
  S.ui.checking = true; render();
  try { await send({type: 'helper', action: 'check'}); } catch (error) { toast(error.message, {kind: 'error'}); }
  S.ui.checking = false;
  scheduleRefresh();
}

// ---------------------------------------------------------------------------------------------- downloads view
function buildDownloads() {
  R.activeTitle = h('div', {class: 'section-title'}, h('span', {text: 'In progress'}));
  R.activeJobs = h('div', {class: 'jobs'});
  R.doneTitle = h('div', {class: 'section-title'}, h('span', {text: 'Finished'}), h('button', {class: 'linkbtn', text: 'Clear list', onClick: () => send({type: 'clearFinished'}).catch(error => toast(error.message, {kind: 'error'}))}));
  R.doneJobs = h('div', {class: 'jobs'});
  R.noJobs = h('div', {class: 'empty'}, h('div', {class: 'art'}, icon('download', 36)), h('h2', {text: 'No downloads yet'}), h('p', {text: 'Videos you save appear here with live progress, speed and the finished file.'}));
  return h('section', {}, R.activeTitle, R.activeJobs, R.doneTitle, R.doneJobs, R.noJobs);
}

async function jobAct(job, action) {
  try {
    if (action === 'update') { await updateDownloader(); return; }
    if (action === 'reload') { await chrome.tabs.reload(job.tabId); toast('Page reloading. Play the video, then try again.', {ms: 3500}); return; }
    await send({type: 'job', id: job.id, action});
  } catch (error) { toast(error.message, {kind: 'error', ms: 6000}); }
}

function makeJob() {
  const r = {};
  r.img = h('img', {alt: '', referrerPolicy: 'no-referrer', hidden: true});
  r.badge = h('span', {class: 'state', hidden: true});
  r.thumb = h('div', {class: 'jthumb'}, r.ph = h('span', {}, icon('film', 22)), r.img, r.badge);
  r.title = h('div', {class: 'jtitle'});
  r.meta = h('div', {class: 'jmeta'});
  r.bar = h('div', {class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100'}, r.fill = h('i'));
  r.jpct = h('b', {class: 'jp-pct'}); r.jinfo = h('span', {class: 'jp-info grow'}); r.jsize = h('span', {class: 'jp-size'});
  r.prog = h('div', {class: 'jprog', hidden: true}, r.bar, h('div', {class: 'jp-meta'}, r.jpct, r.jinfo, r.jsize));
  r.err = h('div', {class: 'job-error', hidden: true}, r.errHint = h('div', {class: 'jhint'}), r.errRow = h('div', {class: 'row'}));
  r.actions = h('div', {class: 'jactions'});
  const node = h('div', {class: 'job'}, r.thumb, h('div', {class: 'jmain'}, r.title, r.meta, r.err), r.actions, r.prog);
  node._r = r;
  return node;
}

// Buttons are rebuilt only when the job changes kind of state; handlers always read the freshest job.
function jobButtons(job, current) {
  const a = [];
  const add = (name, label, run) => a.push(iconBtn(name, label, run));
  const live = job.live;
  if (ACTIVE.has(job.state)) {
    if (job.engine === 'helper' && !live && job.state === 'downloading') add('pause', 'Pause', () => jobAct(current(), 'pause'));
    add(live ? 'stop' : 'x', live ? 'Stop and save what was recorded' : 'Cancel', () => jobAct(current(), live ? 'stop' : 'cancel'));
  } else if (job.state === 'paused') {
    add('play', 'Resume', () => jobAct(current(), 'resume'));
    add('x', 'Discard', () => jobAct(current(), 'remove'));
  } else if (job.state === 'complete') {
    if (!job.missing) { add('open', 'Open the video', () => jobAct(current(), 'open')); add('folder', 'Show in folder', () => jobAct(current(), 'reveal')); }
    const more = iconBtn('more', 'More', () => openMenu(more, [{icon: 'x', label: 'Remove from list', run: () => jobAct(current(), 'remove')}, !current().missing && {icon: 'trash', label: 'Delete the file from disk', danger: true, run: () => jobAct(current(), 'delete')}]));
    a.push(more);
  } else {
    if (job.engine === 'helper') add('refresh', 'Try again', () => jobAct(current(), 'retry'));
    add('x', 'Remove from list', () => jobAct(current(), 'remove'));
  }
  return a;
}

function patchJob(node, job) {
  const r = node._r;
  node.dataset.state = job.state;
  node.classList.toggle('missing', !!job.missing);
  setText(r.title, job.filename || job.name || job.title); r.title.title = job.filename || job.name || '';
  const art = job.thumb;
  if (art) { if (r.img.getAttribute('src') !== art) { r.img.src = art; r.img.hidden = false; r.img.onerror = () => { r.img.hidden = true; }; } } else r.img.hidden = true;
  setHidden(r.ph, !!art && !r.img.hidden);
  const active = ACTIVE.has(job.state) || job.state === 'paused';
  setHidden(r.prog, !active);
  if (active) {
    paintBar(r.bar, r.fill, job);
    setText(r.jpct, percentText(job)); setText(r.jinfo, speedText(job)); setText(r.jsize, sizeText(job));
  }
  setHidden(r.badge, !['complete', 'error'].includes(job.state));
  if (!r.badge.hidden) clear(r.badge).append(icon(job.state === 'complete' ? 'check' : 'x', 14));
  let meta = '';
  if (active) meta = stateLabel(job);
  else if (job.state === 'complete') meta = job.missing ? 'File was moved or deleted' : [job.quality, readableBytes(job.size), job.detail && job.detail !== 'Saved' ? job.detail : ''].filter(Boolean).join(' · ') || 'Saved';
  else if (job.state === 'cancelled') meta = 'Cancelled';
  else if (job.state === 'error') meta = job.explain?.title || 'The download failed';
  setText(r.meta, meta);
  setHidden(r.err, job.state !== 'error');
  if (job.state === 'error') {
    setText(r.errHint, job.explain?.hint || '');
    const key = job.id + job.errorCode + job.updated;
    if (r.errRow.dataset.key !== key) {
      r.errRow.dataset.key = key;
      const action = job.explain?.action;
      clear(r.errRow).append(...[
        action === 'reload' && job.tabId >= 0 ? h('button', {class: 'btn small primary', text: 'Reload page', onClick: () => jobAct(node._job, 'reload')}) : null,
        action === 'update' ? h('button', {class: 'btn small primary', text: 'Update downloader', onClick: updateDownloader}) : null,
        h('button', {class: 'btn small ghost', onClick: () => { const j = node._job; copy([j.name, j.url, j.errorCode, j.error, j.diag].filter(Boolean).join('\n'), 'Details copied'); }}, icon('copy', 14), 'Copy details'),
      ].filter(Boolean));
    }
  }
  node._job = job;
  const signature = job.state + job.engine + job.missing + (job.live ? 'L' : '');
  if (r.actions.dataset.sig !== signature) { r.actions.dataset.sig = signature; clear(r.actions).append(...jobButtons(job, () => node._job)); }
}

function renderDownloads() {
  const active = S.jobs.filter(job => ACTIVE.has(job.state) || job.state === 'paused');
  const finished = S.jobs.filter(job => !(ACTIVE.has(job.state) || job.state === 'paused'));
  setHidden(R.activeTitle, !active.length); setHidden(R.doneTitle, !finished.length); setHidden(R.noJobs, !!S.jobs.length);
  syncList(R.activeJobs, active, job => job.id, makeJob, patchJob);
  syncList(R.doneJobs, finished, job => job.id, makeJob, patchJob);
  const running = S.jobs.filter(job => ACTIVE.has(job.state)).length;
  setCount(R.countDownloads, String(running || finished.length + active.length));
  R.countDownloads.classList.toggle('live', running > 0);
}

// ---------------------------------------------------------------------------------------------- settings view
function buildSettings() {
  const sel = (key, options) => {
    const text = h('span', {class: 'select-text'});
    const el = h('button', {type: 'button', class: 'select', 'aria-label': key, 'aria-haspopup': 'menu', 'aria-expanded': 'false', onClick: () => {
      el.setAttribute('aria-expanded', 'true');
      openMenu(el, options.map(([value, label]) => ({label, checked: String(value) === el.dataset.value, radio: true, run: () => setSetting({[key]: value})})),
        {minWidth: el.offsetWidth, onClose: () => el.setAttribute('aria-expanded', 'false')});
    }}, text, icon('chevronDown', 18, 'select-chevron'));
    el.choose = value => { el.dataset.value = String(value); setText(text, (options.find(([v]) => String(v) === String(value)) || options[0])[1]); };
    el.choose(options[0][0]);
    R['s_' + key] = el; return el;
  };
  const seg = (key, options) => {
    const buttons = options.map(([value, text]) => h('button', {type: 'button', text, 'aria-pressed': 'false', onClick: () => setSetting({[key]: value})}));
    R['g_' + key] = {buttons, options};
    return h('div', {class: 'seg'}, buttons);
  };
  const toggle = key => {
    const text = h('span', {class: 'switch-text', text: 'Off'});
    const input = h('input', {type: 'checkbox', 'aria-label': key, onChange: () => { setText(text, input.checked ? 'On' : 'Off'); setSetting({[key]: input.checked}); }});
    R['t_' + key] = input;
    R['x_' + key] = text;
    return h('label', {class: 'switch'}, input, h('span', {class: 'track'}, h('i', {class: 'knob'})), text);
  };
  const row = (title, note, control) => h('div', {class: 'srow'}, h('div', {class: 'label'}, h('b', {text: title}), note && h('small', {text: note})), control);

  R.folderPath = h('div', {class: 'path'});
  R.folderChange = h('button', {class: 'btn small ghost', text: 'Change…', onClick: chooseFolder});
  R.folderReset = h('button', {class: 'btn small ghost', text: 'Default', onClick: () => setSetting({folder: ''})});
  R.parOut = h('output'); R.parDown = h('button', {text: '−', 'aria-label': 'Fewer at once', onClick: () => setSetting({parallel: Math.max(1, S.settings.parallel - 1)})}); R.parUp = h('button', {text: '+', 'aria-label': 'More at once', onClick: () => setSetting({parallel: Math.min(4, S.settings.parallel + 1)})});
  R.helperBox = h('div');

  return h('section', {},
    h('button', {class: 'back', onClick: () => go('videos')}, icon('chevronLeft', 22), 'Settings'),
    h('div', {class: 'group'}, h('h3', {text: 'Downloads'}),
      row('Default quality', 'Used when a video offers several sizes.', sel('quality', [['best', 'Best available'], ['2160', 'Up to 4K'], ['1440', 'Up to 1440p'], ['1080', 'Up to 1080p'], ['720', 'Up to 720p'], ['480', 'Up to 480p'], ['360', 'Up to 360p']])),
      row('Video format', 'MP4 plays everywhere. MKV never needs conversion.', seg('container', [['mp4', 'MP4'], ['mkv', 'MKV']])),
      row('Audio format', 'For “Save audio only”.', seg('audioFormat', [['mp3', 'MP3'], ['m4a', 'M4A']])),
      h('div', {class: 'srow wrap'}, h('div', {class: 'label'}, h('b', {text: 'Save to'}), R.folderPath), h('div', {class: 'srow-actions'}, R.folderChange, R.folderReset)),
      row('At the same time', 'More downloads wait in the queue.', h('div', {class: 'stepper'}, R.parDown, R.parOut, R.parUp)),
      row('Download speed', 'More connections per stream finish long downloads faster. A few sites limit them.', seg('fragments', [[6, 'Normal'], [10, 'Fast'], [16, 'Max']]))),
    h('div', {class: 'group'}, h('h3', {text: 'Smart features'}),
      row('Use my browser login', 'Sites you are signed in to work. Cookies go only to the helper, for the same site.', toggle('useCookies')),
      row('Study pages automatically', 'The helper checks the page when you open this panel.', toggle('smartAnalyze')),
      row('Best compatibility', 'Prefer H.264 + AAC when two files have the same resolution.', toggle('preferCompat')),
      row('Subtitles', 'Save available subtitles next to the video.', toggle('subtitles')),
      row('Notifications', 'Tell me when a download finishes or fails.', toggle('notifications')),
      row('Keep the downloader updated', 'Fixes broken sites quickly. Checked every few days.', toggle('autoUpdate'))),
    h('div', {class: 'group'}, h('h3', {text: 'Appearance'}),
      row('Button on videos', 'A Download button appears in the corner of a video when you point at it or press play.', toggle('overlay')),
      R.hiddenRow = h('div', {class: 'srow', hidden: true}, h('div', {class: 'label'}, h('b', {text: 'Button hidden on'}), R.hiddenSites = h('small')), h('button', {class: 'btn small ghost', text: 'Show again', onClick: () => setSetting({overlayHidden: []})})),
      row('Theme', '', seg('theme', [['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']])),
      row('Toolbar button opens', 'Alt+Shift+V opens the popup, Alt+Shift+S the side panel.', seg('openIn', [['popup', 'Popup'], ['sidepanel', 'Side panel']]))),
    R.helperBox,
    h('p', {class: 'footnote'}, 'Use downloads only for videos you own or are allowed to save. DRM-protected streams cannot be saved. Version ', R.version = h('span')));
}

async function chooseFolder() {
  try {
    toast('Choose a folder in the window that opened…', {ms: 2500});
    const {folder} = await send({type: 'helper', action: 'chooseFolder'});
    if (folder) await setSetting({folder});
  } catch (error) { toast(error.message, {kind: 'error'}); }
}

async function updateDownloader() {
  if (S.ui.updating) return;
  S.ui.updating = true; render();
  try {
    toast('Checking for a newer downloader…', {ms: 2500});
    const {result} = await send({type: 'helper', action: 'update'});
    if (result.ok) toast(result.updated ? `Downloader updated to ${result.version}` : `Already up to date (${result.version})`, {kind: 'success'});
    else toast(result.error || 'The update did not finish.', {kind: 'error'});
  } catch (error) { toast(error.message, {kind: 'error'}); }
  S.ui.updating = false;
  scheduleRefresh();
}

function renderHelperBox() {
  const hp = S.helper;
  const rows = [];
  const status = hp.status === 'ready' && hp.ready ? ['ok', 'Connected'] : hp.status === 'ready' ? ['bad', 'Tools missing'] : S.helper.status === 'outdated' ? ['bad', 'Update needed'] : helperMissing() ? ['bad', 'Not installed'] : hp.status === 'connecting' ? ['busy', 'Connecting…'] : ['', 'Not connected yet'];
  const box = h('div', {class: 'group'}, h('h3', {text: 'Helper'}),
    h('div', {class: 'srow'}, h('span', {class: 'dot ' + status[0]}), h('div', {class: 'label'}, h('b', {text: status[1]}), h('small', {text: hp.status === 'ready' ? `Version ${hp.version}` : hp.error || 'It starts automatically when needed.'})),
      h('button', {class: 'btn small ghost', text: S.ui.checking ? 'Checking…' : 'Check again', onClick: recheckHelper})));
  if (hp.status === 'ready') {
    rows.push(['Downloader (yt-dlp)', hp.tools?.ytdlp || '…'], ['FFmpeg', hp.tools?.ffmpeg || '…'], ['Browser identity', hp.impersonate === null ? '…' : hp.impersonate ? 'Available (for protected sites)' : 'Not available'], ['Folder', hp.folder || '']);
    box.append(h('dl', {class: 'kv'}, rows.map(([key, value]) => [h('dt', {text: key}), h('dd', {text: value})])));
    box.append(h('div', {class: 'srow'}, h('div', {class: 'label'}, h('b', {text: 'Update downloader'}), h('small', {text: 'Sites change often. Updating usually fixes “unable to extract” errors.'})),
      h('button', {class: 'btn small primary', disabled: S.ui.updating, onClick: updateDownloader}, S.ui.updating ? 'Updating…' : 'Update now')));
  } else if (helperMissing()) box.append(setupNotice());
  return box;
}

function renderSettings() {
  const st = S.settings;
  if (!st.quality) return;
  R.version.textContent = S.version;
  R.s_quality.choose(st.quality);
  for (const key of ['container', 'audioFormat', 'theme', 'openIn', 'fragments']) R['g_' + key].buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(R['g_' + key].options[i][0] === st[key])));
  for (const key of ['useCookies', 'smartAnalyze', 'preferCompat', 'subtitles', 'notifications', 'autoUpdate', 'overlay']) { R['t_' + key].checked = !!st[key]; setText(R['x_' + key], st[key] ? 'On' : 'Off'); }
  const hiddenSites = st.overlayHidden || [];
  setHidden(R.hiddenRow, !hiddenSites.length);
  setText(R.hiddenSites, hiddenSites.join(', '));
  setText(R.folderPath, st.folder || S.helper.folder || 'Windows Downloads \\ Quick Video Saver');
  R.folderReset.hidden = !st.folder;
  R.folderChange.disabled = !helperOK();
  R.folderChange.title = helperOK() ? '' : 'Needs the helper';
  setText(R.parOut, String(st.parallel)); R.parDown.disabled = st.parallel <= 1; R.parUp.disabled = st.parallel >= 4;
  const fresh = renderHelperBox();
  if (R.helperBox.dataset.sig !== fresh.textContent + S.ui.updating + S.ui.checking) { R.helperBox.dataset.sig = fresh.textContent + S.ui.updating + S.ui.checking; clear(R.helperBox).append(fresh); }
}

// ---------------------------------------------------------------------------------------------- footer & orchestration
function renderStatus() {
  const hp = S.helper;
  let dot = '', text = 'Starting…', action = '';
  if (hp.status === 'ready' && hp.ready) { dot = 'ok'; text = `Helper ready${hp.tools?.ytdlp ? ' · yt-dlp ' + hp.tools.ytdlp : ''}`; }
  else if (hp.status === 'ready') { dot = 'bad'; text = 'Helper tools are missing'; action = 'Fix'; }
  else if (S.helper.status === 'outdated') { dot = 'bad'; text = 'Helper is outdated. Streams are off'; action = 'Update'; }
  else if (helperMissing()) { dot = 'bad'; text = 'Helper not installed. Streams are off'; action = 'Set up'; }
  else if (hp.status === 'connecting') { dot = 'busy'; text = 'Connecting to the helper…'; }
  else if (hp.status === 'error') { dot = 'bad'; text = 'Helper stopped'; action = 'Details'; }
  else text = S.ready ? 'Helper starts when needed' : 'Starting…';
  R.statusDot.className = 'dot ' + dot;
  setText(R.statusText, text);
  setText(R.statusAction, action); setHidden(R.statusAction, !action);
}

function render() {
  if (!R.scroll) return;
  applyTheme();
  const page = S.ui.page;
  setHidden(R.fatal, true);
  setHidden(R.vVideos, page !== 'videos'); setHidden(R.vDownloads, page !== 'downloads'); setHidden(R.vSettings, page !== 'settings');
  setHidden(R.tabs, page === 'settings');
  if (page !== 'settings') R.tabs.dataset.page = page;
  R.tabVideos.setAttribute('aria-selected', String(page === 'videos')); R.tabDownloads.setAttribute('aria-selected', String(page === 'downloads'));
  const inPanel = MODE === 'panel';
  setHidden(R.dock, MODE === 'tab');
  clear(R.dock).append(icon(inPanel ? 'window' : 'sidebar', 20));
  R.dock.title = inPanel ? 'Use a popup instead' : 'Open in side panel';
  R.dock.setAttribute('aria-label', R.dock.title);
  R.settingsBtn.classList.toggle('on', page === 'settings');
  renderVideos(); renderDownloads(); renderSettings(); renderStatus();
}

function start() {
  try { const cached = localStorage.getItem('qvs-theme'); if (cached && cached !== 'system') document.documentElement.dataset.theme = cached; } catch { /* storage unavailable */ }
  buildShell();
  render();
  const connect = () => {
    const port = chrome.runtime.connect({name: 'ui'});
    port.onMessage.addListener(message => { if (message.type === 'changed') scheduleRefresh(); });
    port.onDisconnect.addListener(() => setTimeout(() => { connect(); scheduleRefresh(); }, 600));
  };
  connect();
  if (MODE !== 'popup') {
    chrome.tabs.onActivated.addListener(retarget);
    chrome.tabs.onUpdated.addListener((tabId, change) => { if (tabId === S.tab?.id && (change.url || change.title || change.status === 'complete')) retarget(); });
    chrome.windows.onFocusChanged.addListener(() => { if (MODE === 'tab') retarget(); });
  }
  retarget();
  setInterval(() => { if (!document.hidden && S.jobs.some(job => ACTIVE.has(job.state))) render(); }, 2000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) retarget(); });
}

start();
