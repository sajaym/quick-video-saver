// Runs inside the page's own JavaScript world (document_start).
// Watches how the page loads media (fetch / XHR / MediaSource / EME) and reports what it learns to
// content.js through a private DOM event. It never changes what the page receives.
(() => {
  'use strict';
  const FLAG = '__qvsHook2';
  if (window[FLAG]) return;
  try { Object.defineProperty(window, FLAG, {value: true}); } catch { return; }

  const EVENT = 'qvs-evt-9f3a1c';
  const MAX_TEXT = 600000;
  const MAX_BODY = 2000000;
  let windowStart = 0, budget = 150;

  // Patched functions answer toString() like the native originals, so integrity checks stay quiet.
  const nativeToString = Function.prototype.toString;
  const fakes = new WeakMap();
  const toStringProxy = new Proxy(nativeToString, {apply: (target, self, args) => fakes.has(self) ? fakes.get(self) : Reflect.apply(target, self, args)});
  fakes.set(toStringProxy, nativeToString.call(nativeToString));
  try { Function.prototype.toString = toStringProxy; } catch { /* frozen prototype: skip */ }
  const cloak = (patched, original) => { try { fakes.set(patched, nativeToString.call(original)); } catch {} return patched; };

  function emit(type, data) {
    const now = Date.now();
    if (now - windowStart > 10000) { windowStart = now; budget = 150; }
    if (budget-- <= 0) return;
    try { document.dispatchEvent(new CustomEvent(EVENT, {detail: JSON.stringify({type, ...data})})); } catch { /* page without a document yet */ }
  }

  const URL_IN_TEXT = /https?:\/\/[^\s"'<>\\)\]},]+?\.(?:m3u8|mpd|mp4|webm|m4v|mov|mkv|flv|mp3|m4a)(?:\?[^\s"'<>\\)\]},]*)?/gi;

  function sniff(url, text, via) {
    if (typeof text !== 'string' || !text || !/^https?:/i.test(url || '')) return;
    const head = text.slice(0, 4096).replace(/^﻿/, '').trimStart();
    let kind = '';
    if (head.startsWith('#EXTM3U')) kind = 'hls';
    else if (/<MPD[\s>]/.test(head)) kind = 'dash';
    else if (/<SmoothStreamingMedia[\s>]/.test(head)) kind = 'mss';
    if (kind) { emit('manifest', {url, kind, via, text: text.slice(0, MAX_TEXT)}); return; }
    if (text.length > MAX_TEXT || !/\.(?:m3u8|mpd|mp4|webm|m4v|mov|mkv|flv|mp3|m4a)/i.test(text)) return;
    const clean = text.replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
    const urls = new Set();
    for (const match of clean.matchAll(URL_IN_TEXT)) { urls.add(match[0]); if (urls.size >= 40) break; }
    if (urls.size) emit('urls', {from: url, urls: [...urls]});
  }

  // ---- fetch -----------------------------------------------------------------------------------------
  const skipType = /^(?:video|audio|image|font)\/|event-stream|zip|pdf|wasm/i;
  async function readCapped(response) {
    const reader = response.body?.getReader();
    if (!reader) return response.text();
    const chunks = [];
    let total = 0;
    while (total < MAX_BODY) {
      const {done, value} = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    reader.cancel().catch(() => {});
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder().decode(bytes);
  }

  function inspectResponse(response) {
    try {
      const url = response.url;
      if (!url || response.type === 'opaque' || !response.ok) return;
      const type = (response.headers.get('content-type') || '').toLowerCase();
      const length = Number(response.headers.get('content-length')) || 0;
      if (skipType.test(type) || length > MAX_BODY) return;
      if (type && !/json|text|xml|mpegurl|dash|javascript|octet-stream|binary|plain/.test(type)) return;
      readCapped(response.clone()).then(text => sniff(url, text, 'fetch'), () => {});
    } catch { /* never disturb the page */ }
  }

  if (typeof window.fetch === 'function') {
    const originalFetch = window.fetch;
    window.fetch = cloak(function fetch(...args) {
      const promise = originalFetch.apply(this, args);
      try { promise.then(inspectResponse, () => {}); } catch { /* ignore */ }
      return promise;
    }, originalFetch);
  }

  // ---- XMLHttpRequest ----------------------------------------------------------------------------------
  const xhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (xhrProto) {
    const originalOpen = xhrProto.open, originalSend = xhrProto.send;
    xhrProto.open = cloak(function open(method, url) {
      try { this.__qvsURL = String(url); } catch { /* ignore */ }
      return originalOpen.apply(this, arguments);
    }, originalOpen);
    xhrProto.send = cloak(function send() {
      try {
        this.addEventListener('load', () => {
          try {
            const url = this.responseURL || new URL(this.__qvsURL, location.href).href;
            const type = (this.getResponseHeader('content-type') || '').toLowerCase();
            if (skipType.test(type) || this.status >= 400) return;
            const kind = this.responseType;
            if (kind === '' || kind === 'text') sniff(url, this.responseText, 'xhr');
            else if (kind === 'json') sniff(url, JSON.stringify(this.response), 'xhr');
            else if (kind === 'arraybuffer' && this.response && this.response.byteLength && this.response.byteLength < MAX_BODY) {
              const head = new TextDecoder().decode(new Uint8Array(this.response, 0, Math.min(64, this.response.byteLength)));
              if (/^﻿?\s*(?:#EXTM3U|<\?xml|<MPD|<SmoothStreamingMedia)/.test(head)) sniff(url, new TextDecoder().decode(this.response), 'xhr');
            }
          } catch { /* ignore */ }
        });
      } catch { /* ignore */ }
      return originalSend.apply(this, arguments);
    }, originalSend);
  }

  // ---- MediaSource: blob videos --------------------------------------------------------------------------
  try {
    if (window.MediaSource) {
      const create = URL.createObjectURL;
      URL.createObjectURL = cloak(function createObjectURL(object) {
        const url = create.apply(this, arguments);
        try { if (object instanceof MediaSource) emit('mse', {blob: url}); } catch { /* ignore */ }
        return url;
      }, create);
      const addBuffer = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = cloak(function addSourceBuffer(mime) {
        try { emit('mse-buffer', {mime: String(mime).slice(0, 200)}); } catch { /* ignore */ }
        return addBuffer.apply(this, arguments);
      }, addBuffer);
    }
  } catch { /* ignore */ }

  // ---- DRM (EME) ------------------------------------------------------------------------------------------
  try {
    if (window.Navigator && Navigator.prototype.requestMediaKeySystemAccess) {
      const original = Navigator.prototype.requestMediaKeySystemAccess;
      Navigator.prototype.requestMediaKeySystemAccess = cloak(function requestMediaKeySystemAccess(system) {
        try { emit('drm', {system: String(system).slice(0, 80)}); } catch { /* ignore */ }
        return original.apply(this, arguments);
      }, original);
    }
  } catch { /* ignore */ }
})();
