// Isolated-world content script: reads the page (video elements, structured data, embeds) and relays
// what hook.js saw in the page world to the service worker.
(() => {
  if (globalThis.__qvsContent) return;
  globalThis.__qvsContent = true;

  const EVENT = 'qvs-evt-9f3a1c';
  const isTop = window === window.top;
  const MEDIA_LINK = /\.(?:mp4|webm|mkv|mov|m4v|m3u8|mpd|mp3|m4a|flv|ogv)(?:[?#]|$)/i;
  // Native attribute selectors find the few media links without touching the thousands of other anchors.
  const LINK_SELECTOR = ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'm3u8', 'mpd', 'mp3', 'm4a', 'flv', 'ogv'].map(ext => `a[href*=".${ext}" i]`).join(',');
  const WATCHED = /^(?:VIDEO|AUDIO|SOURCE|IFRAME|META)$/;
  const EMBED = [
    /^https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/[\w-]{6,}/i, /^https?:\/\/player\.vimeo\.com\/video\/\d+/i, /^https?:\/\/(?:www\.)?dailymotion\.com\/embed\/video\/\w+/i,
    /^https?:\/\/(?:www\.)?facebook\.com\/plugins\/video\.php/i, /^https?:\/\/streamable\.com\/(?:e|o)\/\w+/i, /^https?:\/\/(?:www\.)?rumble\.com\/embed\/[\w.-]+/i,
    /^https?:\/\/(?:www\.)?odysee\.com\/\$\/embed\//i, /^https?:\/\/(?:www\.)?bitchute\.com\/embed\/\w+/i, /^https?:\/\/player\.twitch\.tv\/\?/i,
    /^https?:\/\/(?:[\w-]+)\.wistia\.(?:net|com)\/embed\/(?:iframe|medias)\/\w+/i, /^https?:\/\/(?:www\.)?ok\.ru\/videoembed\/\d+/i, /^https?:\/\/(?:www\.)?vk\.com\/video_ext\.php/i,
    /^https?:\/\/players\.brightcove\.net\/\d+\//i, /^https?:\/\/(?:www\.)?tiktok\.com\/embed\//i, /^https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv)\/[\w-]+\/embed/i,
  ];

  let alive = true;
  let timer = 0, lastPayload = '', lastDeep = 0;
  const hookQueue = [];
  let hookTimer = 0;
  const thumbsDone = new Set();

  function post(message) {
    if (!alive) return Promise.resolve(null);
    try { return chrome.runtime.sendMessage(message).catch(() => null); }
    catch { alive = false; observer.disconnect(); return Promise.resolve(null); } // extension was reloaded
  }

  // ---- events coming from the page world ---------------------------------------------------------------
  document.addEventListener(EVENT, event => {
    try {
      const data = JSON.parse(event.detail);
      if (!data || typeof data.type !== 'string') return;
      hookQueue.push(data);
      if (hookQueue.length > 60) hookQueue.shift();
      clearTimeout(hookTimer);
      hookTimer = setTimeout(() => post({type: 'HOOK', frameURL: location.href, top: isTop, events: hookQueue.splice(0)}), 150);
    } catch { /* malformed event from a hostile page */ }
  }, true);

  // ---- page reading ----------------------------------------------------------------------------------------
  const text = (value, max = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const meta = selector => text(document.querySelector(selector)?.content, 500);
  const abs = value => { try { return value ? new URL(value, location.href).href : ''; } catch { return ''; } };

  function structuredVideos() {
    const found = [];
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try { data = JSON.parse(el.textContent); } catch { continue; }
      const stack = Array.isArray(data) ? [...data] : [data];
      while (stack.length && found.length < 6) {
        const node = stack.shift();
        if (!node || typeof node !== 'object') continue;
        if (Array.isArray(node['@graph'])) stack.push(...node['@graph']);
        if (/VideoObject/i.test([].concat(node['@type'] || []).join(','))) {
          const thumb = [].concat(node.thumbnailUrl || node.thumbnail?.url || node.image?.url || node.image || [])[0];
          found.push({name: text(node.name || node.headline), contentUrl: abs(node.contentUrl), embedUrl: abs(node.embedUrl), thumbnail: abs(typeof thumb === 'string' ? thumb : ''), duration: text(node.duration, 40)});
        }
      }
    }
    return found;
  }

  function mediaElements(deep) {
    const found = [];
    const visit = root => {
      for (const el of root.querySelectorAll('video,audio')) { if (found.length < 30) found.push(el); }
      if (!deep) return;
      let checked = 0;
      for (const host of root.querySelectorAll('*')) {
        if (++checked > 20000 || found.length >= 30) break;
        if (!(host instanceof HTMLElement) || host.localName === 'qvs-download-button') continue;   // the API only accepts HTML elements
        let shadow = null;
        try { shadow = (chrome.dom && chrome.dom.openOrClosedShadowRoot && chrome.dom.openOrClosedShadowRoot(host)) || host.shadowRoot; } catch { /* not a shadow host */ }
        if (shadow) visit(shadow);
      }
    };
    visit(document);
    return found;
  }

  function captureFrame(video, key) {
    if (thumbsDone.has(key) || video.readyState < 2 || !video.videoWidth || video.tagName !== 'VIDEO') return '';
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 224;
      canvas.height = Math.max(40, Math.round(224 * video.videoHeight / video.videoWidth));
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/jpeg', 0.62);
      thumbsDone.add(key);
      return data.length < 40000 ? data : '';
    } catch { thumbsDone.add(key); return ''; } // cross-origin video taints the canvas
  }

  function describe(el, index) {
    const sources = [...el.querySelectorAll('source')].map(s => ({url: abs(s.src), type: s.type || '', label: s.title || s.getAttribute('label') || ''})).filter(s => /^https?:/.test(s.url)).slice(0, 8);
    const src = el.currentSrc || el.src || '';
    const label = text(el.title || el.getAttribute('aria-label') || el.dataset?.title || '', 160);
    const rect = el.getBoundingClientRect();
    const key = src || `${index}:${el.poster}`;
    return {
      src, blob: src.startsWith('blob:'), sources, poster: abs(el.poster), label, kind: el.tagName.toLowerCase(),
      duration: Number.isFinite(el.duration) ? Math.round(el.duration * 10) / 10 : 0, width: el.videoWidth || 0, height: el.videoHeight || 0,
      paused: el.paused, muted: el.muted, ended: el.ended, loop: el.loop, box: [Math.round(rect.width), Math.round(rect.height)],
      visible: rect.width > 40 && rect.height > 30 && rect.bottom > 0 && rect.top < innerHeight, thumb: captureFrame(el, key),
    };
  }

  function collect(force = false) {
    const deep = force || Date.now() - lastDeep > 8000;
    if (deep) lastDeep = Date.now();
    const videos = mediaElements(deep).map(describe);
    const links = [...document.querySelectorAll(LINK_SELECTOR)].map(a => a.href).filter(href => MEDIA_LINK.test(href) && /^https?:/.test(href)).slice(0, 30);
    const embeds = [...document.querySelectorAll('iframe[src]')].map(f => f.src).filter(src => EMBED.some(pattern => pattern.test(src))).slice(0, 10);
    const metaVideos = ['og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player:stream'].map(name => abs(meta(`meta[property="${name}"],meta[name="${name}"]`))).filter(Boolean);
    const payload = {type: 'PAGE', frameURL: location.href, top: isTop, videos, links, embeds, metaVideos};
    if (isTop) {
      payload.page = {
        url: location.href, title: text(document.title, 400), siteName: meta('meta[property="og:site_name"]'), ogTitle: meta('meta[property="og:title"]'), twitterTitle: meta('meta[name="twitter:title"]'),
        ogImage: abs(meta('meta[property="og:image"],meta[name="twitter:image"]')), heading: text(document.querySelector('h1')?.textContent, 200), ld: structuredVideos(),
        hasMedia: videos.length > 0, canonical: abs(document.querySelector('link[rel="canonical"]')?.href),
      };
    }
    const signature = JSON.stringify(payload, (key, value) => key === 'thumb' ? (value ? 1 : 0) : key === 'paused' || key === 'visible' ? undefined : value);
    const hasNew = videos.some(v => v.thumb);
    if (!force && signature === lastPayload && !hasNew) return;
    lastPayload = signature;
    post(payload);
  }

  // Scans run when the browser is idle, and a page that keeps changing without new media is scanned less and less often.
  let quiet = 0;
  function run() {
    const before = lastPayload;
    collect(false);
    quiet = lastPayload === before ? Math.min(quiet + 1, 4) : 0;
  }
  function schedule(urgent = true) {
    if (urgent === true) quiet = 0;
    clearTimeout(timer);
    timer = setTimeout(() => (window.requestIdleCallback ? requestIdleCallback(run, {timeout: 1500}) : run()), 400 * (1 + quiet * 2));
  }

  // Only changes that can bring or alter media wake the scanner (feeds and chats mutate constantly).
  const interesting = node => node.tagName === 'A' ? MEDIA_LINK.test(node.getAttribute('href') || '') : node.tagName === 'SCRIPT' ? node.type === 'application/ld+json' : WATCHED.test(node.tagName);
  function relevant(records) {
    for (const record of records) {
      if (record.type === 'attributes') { if (interesting(record.target)) return true; continue; }
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (interesting(node) || (node.firstElementChild && node.querySelector('video,audio,source,iframe,meta,script[type="application/ld+json"],' + LINK_SELECTOR))) return true;
      }
    }
    return false;
  }

  const observer = new MutationObserver(records => { if (relevant(records)) schedule(false); });
  observer.observe(document.documentElement || document, {subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href', 'poster']});
  for (const type of ['loadedmetadata', 'loadeddata', 'durationchange', 'resize', 'play', 'playing', 'emptied']) document.addEventListener(type, () => schedule(true), true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(true); });
  chrome.runtime.onMessage.addListener(message => {
    if (message && message.type === 'SCAN') { lastPayload = ''; thumbsDone.clear(); collect(true); }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => schedule(true), {once: true});
  window.addEventListener('load', () => schedule(true), {once: true});
  schedule(true);
})();
