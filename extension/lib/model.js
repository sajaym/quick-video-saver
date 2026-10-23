// Pure state transitions for a tab's detected media (no chrome.* calls: unit-testable in Node).
import {webURL, hostOf, uid} from './util.js';
import {classify, normalizeKey, embedURL, isPartialStreamHost, withoutByteRange} from './detect.js';
import {parseManifest} from './manifest.js';

export const MAX_ITEMS = 90;
const KEEP_HEADERS = /^(?:referer|origin|authorization|user-agent|accept-language|x-[\w-]+)$/i;

export function newTabState(tabId, url = '', title = '') {
  // probes: {[url]: {state: 'running'|'done'|'failed', info, error, errorCode, page}} from the helper's site extractors
  return {tabId, url, title, navId: 0, page: null, items: {}, frames: {}, embeds: {}, probes: {}, drm: '', mse: 0, partial: false, updated: Date.now()};
}

export function compactManifest(info) {
  if (!info) return null;
  const pick = ({url, id, height, width, bandwidth, fps, codecs, label, size, approx, audioGroup, hasAudio}) => ({url, id, height, width, bandwidth, fps, codecs, label, size, approx, audioGroup, hasAudio});
  return {
    type: info.type, master: !!info.master, duration: info.duration || 0, live: !!info.live, drm: info.drm || '', encrypted: !!info.encrypted, segments: info.segments || 0, fmp4: !!info.fmp4,
    variants: (info.variants || []).slice(0, 16).map(pick), audio: (info.audio || []).slice(0, 8).map(({url, name, lang, bandwidth, group}) => ({url, name, lang, bandwidth, group})),
    subtitles: (info.subtitles || []).length,
  };
}

export function keepHeaders(headers) {
  const kept = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (KEEP_HEADERS.test(name) && value && String(value).length < 2048) kept[name] = String(value);
  }
  return kept;
}

export function upsert(st, {url, kind, mime = '', size = 0, weak = false, headers, frameURL = '', frameId = 0, source = 'network', now = Date.now()}) {
  const href = webURL(url);
  if (!href || !kind) return null;
  const key = normalizeKey(href);
  let item = st.items[key];
  if (!item) {
    if (Object.keys(st.items).length >= MAX_ITEMS) {
      const oldest = Object.values(st.items).sort((a, b) => (b.weak - a.weak) || (a.lastSeen - b.lastSeen))[0];
      if (oldest) delete st.items[oldest.key];
    }
    item = st.items[key] = {id: uid(), key, kind, url: href, mime, size: 0, weak, frameURL, frameId, sources: [], firstSeen: now, lastSeen: now, seen: 0, headers: {}, manifest: null, media: null, analysis: 'none'};
  }
  item.url = withoutByteRange(href); // newest URL carries the freshest token; byte ranges must not narrow the download
  item.lastSeen = now;
  item.seen++;
  if (mime && !item.mime) item.mime = mime;
  if (size > item.size) item.size = size;
  if (!weak) item.weak = false;
  if (frameURL) { item.frameURL = frameURL; item.frameId = frameId; }
  if (!item.sources.includes(source)) item.sources.push(source);
  const kept = keepHeaders(headers);
  if (Object.keys(kept).length) item.headers = {...item.headers, ...kept};
  st.updated = now;
  return item;
}

export function applyNetwork(st, d) {
  if (isPartialStreamHost(d.url)) { st.partial = true; return null; }
  const cls = classify(d.url, d.mime, {size: d.size, disposition: d.disposition, hasRange: d.status === 206});
  if (!cls) return null;
  return upsert(st, {url: d.url, kind: cls.kind, mime: d.mime, size: d.size, weak: !!cls.weak, headers: d.headers, frameURL: d.frameURL, frameId: d.frameId, source: 'network', now: d.now});
}

export function applyHook(st, frameURL, events, now = Date.now()) {
  const added = [];
  for (const event of Array.isArray(events) ? events.slice(0, 60) : []) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'manifest' && ['hls', 'dash', 'mss'].includes(event.kind)) {
      const item = upsert(st, {url: event.url, kind: event.kind, frameURL, source: 'hook', now});
      if (!item) continue;
      item.kind = event.kind;
      item.weak = false;
      const info = parseManifest(event.kind, String(event.text || ''), item.url);
      if (info) { item.manifest = compactManifest(info); item.analysis = 'parsed'; }
      added.push(item);
    } else if (event.type === 'urls' && Array.isArray(event.urls)) {
      for (const url of event.urls.slice(0, 40)) {
        const cls = classify(url, '');
        if (cls) added.push(upsert(st, {url, kind: cls.kind, weak: true, frameURL, source: 'data', now}));
      }
    } else if (event.type === 'mse' || event.type === 'mse-buffer') {
      st.mse++;
    } else if (event.type === 'drm') {
      st.drm = String(event.system || 'DRM').slice(0, 60);
    }
  }
  return added.filter(Boolean);
}

export function applyPage(st, msg, now = Date.now()) {
  if (msg.top && msg.page && typeof msg.page === 'object') {
    st.page = {...msg.page, updated: now};
    if (msg.page.url) st.url = msg.page.url;
  }
  const frames = Object.keys(st.frames);
  if (frames.length >= 12 && !st.frames[msg.frameURL]) delete st.frames[frames[0]];
  st.frames[msg.frameURL] = {top: !!msg.top, at: now, videos: (Array.isArray(msg.videos) ? msg.videos : []).slice(0, 30)};
  const frameURL = msg.frameURL;
  const add = (url, mime, source, weak) => {
    const cls = classify(url, mime || '');
    if (cls && !weak) return upsert(st, {url, kind: cls.kind, weak: !!cls.weak, frameURL, source, now});
    if (cls) return upsert(st, {url, kind: cls.kind, weak: true, frameURL, source, now});
    return null;
  };
  for (const video of st.frames[frameURL].videos) {
    if (video.src && !video.blob) add(video.src, '', 'dom');
    for (const source of video.sources || []) add(source.url, source.type, 'dom');
  }
  const links = (Array.isArray(msg.links) ? msg.links : []).slice(0, 30);
  for (const link of links) add(link, '', 'link', links.length > 4);
  for (const url of (Array.isArray(msg.metaVideos) ? msg.metaVideos : []).slice(0, 6)) {
    if (!add(url, '', 'meta', false)) { const embed = embedURL(url); if (embed) st.embeds[embed] = {url: embed, at: now}; }
  }
  for (const url of (Array.isArray(msg.embeds) ? msg.embeds : []).slice(0, 10)) {
    const embed = embedURL(url);
    if (embed) st.embeds[embed] = {url: embed, at: now};
  }
  st.updated = now;
}

// Attach what the <video> elements know (size, duration, poster, thumbnail) to the detected items.
// Keys of playlists that merely belong to a master playlist (its renditions): they are not videos of their own.
export function variantKeys(items) {
  const keys = new Set();
  for (const item of items) {
    for (const entry of [...(item.manifest?.variants || []), ...(item.manifest?.audio || [])]) {
      if (entry.url && entry.url !== item.url) keys.add(normalizeKey(entry.url));
    }
  }
  return keys;
}

// The detected item a <video> element is playing: by its own address first, then (blob / MediaSource players) by the
// manifest the page loaded in the same frame.
export function linkContext(st) {
  const items = Object.values(st.items);
  const hidden = variantKeys(items);
  return {items, manifests: items.filter(item => ['hls', 'dash', 'mss'].includes(item.kind) && !hidden.has(item.key))};
}

export function videoTarget(ctx, frameURL, frame, video) {
  const keys = new Set([video.src, ...(video.sources || []).map(s => s.url)].filter(Boolean).filter(u => !u.startsWith('blob:')).map(normalizeKey));
  let target = ctx.items.find(item => keys.has(item.key));
  if (!target && (video.blob || !video.src)) {
    const candidates = ctx.manifests.filter(item => item.frameURL === frameURL || frame.top && !item.frameURL);
    const pool = candidates.length ? candidates : ctx.manifests;
    if (pool.length === 1) target = pool[0];
    else if (pool.length > 1) {
      const byDuration = video.duration && pool.find(item => item.manifest && Math.abs(item.manifest.duration - video.duration) < 3);
      target = byDuration || pool.slice().sort((a, b) => b.lastSeen - a.lastSeen)[0];
    }
  }
  return target || null;
}

export function linkVideos(st) {
  const ctx = linkContext(st);
  const links = new Map();
  for (const [frameURL, frame] of Object.entries(st.frames)) {
    for (const video of frame.videos) {
      if (video.kind !== 'video') continue;
      const target = videoTarget(ctx, frameURL, frame, video);
      if (!target) continue;
      const known = links.get(target.id);
      const rank = (video.width * video.height) + (video.paused ? 0 : 1e7);
      if (!known || rank > known.rank) links.set(target.id, {rank, width: video.width, height: video.height, duration: video.duration, poster: video.poster, thumb: video.thumb || known?.thumb || '', label: video.label, playing: !video.paused && !video.ended, visible: video.visible});
      else if (video.thumb && !known.thumb) known.thumb = video.thumb;
    }
  }
  return links;
}
