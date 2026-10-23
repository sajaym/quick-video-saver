// Isolated-world content script: the "Download" button that floats in the top-right corner of a video.
// Built to cost nothing while idle: no observers, no timers and no DOM until a video is hovered or starts playing;
// one shared button (in a closed shadow root) moves between videos, and everything it needs comes from the service worker.
(() => {
  if (globalThis.__qvsOverlay) return;
  globalThis.__qvsOverlay = true;

  const isTop = window === window.top;
  const MIN_W = 200, MIN_H = 110;      // smaller players are thumbnails, ads and decoration
  const IDLE_HIDE = 2400;              // like player controls: the button fades when the pointer rests
  const live = document.getElementsByTagName('video');   // live collection: free to keep, free to read
  const extra = new Set();             // videos inside open shadow roots, learnt from the pointer
  const metas = new WeakMap();         // per video: what the service worker said, and the state of its download
  const dismissed = new WeakSet();
  const active = new Map();            // job id -> video, polled while a download runs

  const siteHost = (() => {
    let host = location.hostname;
    if (!isTop) { try { host = new URL(location.ancestorOrigins[location.ancestorOrigins.length - 1]).hostname || host; } catch { /* no ancestor info */ } }
    return host.replace(/^www\./, '');
  })();

  let alive = true, enabled = false, attached = false;
  let host = null, els = null, resizer = null;
  let current = null, visible = false, overButton = false, menuOpen = false;
  let pointer = {x: -1, y: -1}, frame = 0, hideTimer = 0, pollTimer = 0;

  // ---- settings -------------------------------------------------------------------------------------------
  function applySettings(raw) {
    const hidden = Array.isArray(raw?.overlayHidden) ? raw.overlayHidden : [];
    enabled = raw?.overlay !== false && !hidden.includes(siteHost) && !hidden.includes(location.hostname.replace(/^www\./, ''));
    enabled ? attach() : detach();
  }
  chrome.storage.local.get('settings').then(({settings}) => applySettings(settings), () => applySettings(null));
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) applySettings(changes.settings.newValue); });

  function post(message) {
    if (!alive) return Promise.resolve(null);
    try { return chrome.runtime.sendMessage(message).catch(() => null); }
    catch { shutdown(); return Promise.resolve(null); }   // the extension was reloaded: this script is orphaned
  }

  function shutdown() { alive = false; detach(); host?.remove(); host = null; }

  // ---- listeners (only while the button is enabled) -------------------------------------------------------
  const opts = {capture: true, passive: true};
  function attach() {
    if (attached) return;
    attached = true;
    document.addEventListener('pointermove', onMove, opts);
    document.addEventListener('play', onPlay, true);
    document.addEventListener('fullscreenchange', onFullscreen);
    document.addEventListener('keydown', onKey, true);
    document.documentElement.addEventListener('mouseleave', onLeave, opts);
    window.addEventListener('scroll', onViewport, opts);
    window.addEventListener('resize', onViewport, {passive: true});
  }

  function detach() {
    if (!attached) return;
    attached = false;
    document.removeEventListener('pointermove', onMove, opts);
    document.removeEventListener('play', onPlay, true);
    document.removeEventListener('fullscreenchange', onFullscreen);
    document.removeEventListener('keydown', onKey, true);
    document.documentElement.removeEventListener('mouseleave', onLeave, opts);
    window.removeEventListener('scroll', onViewport, opts);
    window.removeEventListener('resize', onViewport, {passive: true});
    hide();
    if (host) host.style.display = 'none';
  }

  // ---- finding the video under the pointer ----------------------------------------------------------------
  function usable(video, rect) {
    if (rect.width < MIN_W || rect.height < MIN_H || rect.bottom < 40 || rect.top > innerHeight - 40 || rect.right < 40 || rect.left > innerWidth - 40) return false;
    return !!(video.currentSrc || video.src || video.firstElementChild || video.readyState > 0);   // an empty <video> is a placeholder
  }

  function videoAt(x, y) {
    let best = null, area = Infinity;
    const test = video => {
      const rect = video.getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom || !usable(video, rect)) return;
      if (rect.width * rect.height < area) { best = video; area = rect.width * rect.height; }
    };
    for (let i = 0; i < live.length && i < 40; i++) test(live[i]);
    for (const video of extra) { if (video.isConnected) test(video); else extra.delete(video); }
    return best;
  }

  function onMove(event) {
    pointer.x = event.clientX; pointer.y = event.clientY;
    const target = event.target;
    if (target === host) return;
    if (target && target.shadowRoot) {
      const inner = event.composedPath()[0];
      if (inner instanceof HTMLVideoElement && !extra.has(inner)) extra.add(inner);
    }
    if (!live.length && !extra.size) return;
    if (!frame) frame = requestAnimationFrame(tick);
  }

  function tick() {
    frame = 0;
    if (document.hidden || !alive) return;
    const video = videoAt(pointer.x, pointer.y);
    if (video && !dismissed.has(video)) show(video);
    else if (visible && !overButton && !menuOpen) armHide(700);   // short grace: the pointer may be heading for the button
  }

  function onPlay(event) {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement) || dismissed.has(video) || (video.muted && video.loop)) return;
    if (!usable(video, video.getBoundingClientRect())) return;
    show(video);
    armHide(3600);
  }

  function onLeave() { if (visible && !overButton && !menuOpen) armHide(400); }
  function onKey(event) { if (event.key === 'Escape' && menuOpen) closeMenu(); }
  function onViewport() { if (visible && !frame) frame = requestAnimationFrame(() => { frame = 0; place(); }); }

  function onFullscreen() {
    if (!host) return;
    const fs = document.fullscreenElement;
    if (fs && (fs.tagName === 'VIDEO' || fs.tagName === 'IFRAME')) { hide(); return; }   // nothing can be drawn on top of those
    const parent = fs || document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
    if (visible) place();
  }

  // ---- showing, hiding, placing ---------------------------------------------------------------------------
  function metaOf(video) {
    let meta = metas.get(video);
    if (!meta) { meta = {state: 'idle', info: null, job: null, error: '', code: '', queriedAt: 0, tries: 0}; metas.set(video, meta); }
    return meta;
  }

  function show(video) {
    const fs = document.fullscreenElement;
    if (fs && (fs.tagName === 'VIDEO' || fs.tagName === 'IFRAME')) return;
    if (!ensureHost()) return;
    if (current !== video) {
      closeMenu();
      current = video;
      resizer?.disconnect();
      resizer?.observe(video);
      paint();
    }
    const meta = metaOf(video);
    if (!visible) { visible = true; paint(); wrap().classList.add('on'); }
    if (Date.now() - meta.queriedAt > 2500) { meta.tries = 0; query(video); }
    place();
    armHide(IDLE_HIDE);
  }

  function hide() {
    clearTimeout(hideTimer);
    if (!visible) return;
    visible = false;
    overButton = false;
    closeMenu();
    wrap()?.classList.remove('on');
  }

  function armHide(ms) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (overButton || menuOpen) armHide(IDLE_HIDE); else hide(); }, ms);
  }

  function place() {
    if (!current || !host || !visible) return;
    const rect = current.getBoundingClientRect();
    if (!usable(current, rect)) { hide(); return; }
    const box = wrap();
    const width = box.offsetWidth;
    const right = Math.min(rect.right, document.documentElement.clientWidth);
    const x = Math.max(4, Math.min(right - width - 10, document.documentElement.clientWidth - width - 4));
    const y = Math.max(rect.top, 0) + 10;
    box.style.transform = `translate3d(${Math.round(x)}px,${Math.round(y)}px,0)`;
  }

  // ---- talking to the service worker ----------------------------------------------------------------------
  function describe(video) {
    const sources = [...video.querySelectorAll('source')].map(s => ({url: s.src, type: s.type || ''})).filter(s => /^https?:/.test(s.url)).slice(0, 6);
    const src = video.currentSrc || video.src || '';
    return {src, blob: src.startsWith('blob:'), sources, duration: Number.isFinite(video.duration) ? Math.round(video.duration * 10) / 10 : 0, width: video.videoWidth || 0, height: video.videoHeight || 0};
  }

  async function query(video) {
    const meta = metaOf(video);
    meta.queriedAt = Date.now();
    const reply = await post({type: 'OV_QUERY', frameURL: location.href, top: isTop, video: describe(video)});
    if (!reply || !reply.ok) return;
    meta.info = reply;
    // Sizes and qualities arrive while the extension studies the video: look again until it has finished.
    if (reply.pending && (meta.tries = (meta.tries || 0) + 1) < 8) setTimeout(() => { if (visible && current === video) query(video); }, 1200);
    if (reply.job && meta.state === 'idle') { meta.state = 'busy'; meta.job = reply.job; active.set(reply.job.id, video); startPolling(); }
    if (current === video) paint();
  }

  async function download(video, {qualityKey = '', audioOnly = false} = {}) {
    const meta = metaOf(video);
    if (meta.state === 'busy') return;
    meta.state = 'busy'; meta.job = {state: 'queued', progress: 0}; meta.error = ''; meta.code = '';
    paint();
    const reply = await post({type: 'OV_DOWNLOAD', frameURL: location.href, top: isTop, video: describe(video), cardId: meta.info?.card?.id || '', qualityKey, audioOnly});
    if (!reply || !reply.ok) {
      meta.state = 'error'; meta.job = null;
      meta.error = reply?.error || 'The download could not start.';
      meta.code = /helper|set ?up|Settings/i.test(meta.error) ? 'setup' : '';
      paint();
      return;
    }
    meta.job = {...meta.job, id: reply.id};
    active.set(reply.id, video);
    startPolling();
  }

  function startPolling() { if (!pollTimer) pollTimer = setTimeout(poll, 500); }

  async function poll() {
    pollTimer = 0;
    if (!active.size || !alive) return;
    const reply = await post({type: 'OV_JOBS', ids: [...active.keys()]});
    for (const [id, video] of [...active]) {
      if (!reply || !reply.ok) break;
      const job = reply.jobs[id];
      const meta = metaOf(video);
      if (!job) { active.delete(id); meta.state = 'idle'; meta.job = null; continue; }
      meta.job = job;
      if (job.state === 'complete') { meta.state = 'done'; active.delete(id); }
      else if (job.state === 'error') { meta.state = 'error'; meta.error = job.explain?.title || job.error || 'The download failed.'; meta.code = job.errorCode === 'tool_missing' ? 'setup' : ''; active.delete(id); }
      else if (job.state === 'cancelled') { meta.state = 'idle'; meta.job = null; active.delete(id); }
    }
    if (visible && current) paint();
    if (active.size) pollTimer = setTimeout(poll, document.hidden ? 3000 : 800);
  }

  // ---- the button -----------------------------------------------------------------------------------------
  const ICONS = {
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    spinner: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    eyeOff: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/>',
    folder: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
    stop: '<rect width="14" height="14" x="5" y="5" rx="2"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  };
  const svg = name => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  const CSS = `
    *{box-sizing:border-box}
    [hidden]{display:none!important}
    .wrap{position:fixed;left:0;top:0;width:max-content;opacity:0;visibility:hidden;pointer-events:none;transform:translate3d(-9999px,0,0);transition:opacity .16s ease,visibility 0s linear .16s;font:600 13px/1 system-ui,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;color:#fff}
    .wrap.on{opacity:1;visibility:visible;pointer-events:auto;transition:opacity .16s ease,visibility 0s}
    .pill{position:relative;display:flex;align-items:stretch;height:36px;border-radius:11px;overflow:hidden;background:#BC5634;box-shadow:0 0 0 1px rgba(255,255,255,.14) inset,0 2px 4px rgba(0,0,0,.22),0 8px 22px rgba(0,0,0,.3);user-select:none}
    .wrap[data-mode=done] .pill{background:#2F7D4F}
    .wrap[data-mode=error] .pill{background:#B3382C}
    .bar{position:absolute;inset:0;background:rgba(0,0,0,.24);transform-origin:left center;transform:scaleX(0);transition:transform .6s linear;pointer-events:none}
    button{all:unset;box-sizing:border-box;position:relative;display:flex;align-items:center;gap:8px;padding:0 13px;cursor:pointer;color:inherit;font:inherit;white-space:nowrap}
    button:hover{background:rgba(255,255,255,.15)}
    button:active{background:rgba(0,0,0,.14)}
    button:focus-visible{outline:2px solid #fff;outline-offset:-4px}
    button[disabled]{cursor:default;opacity:.8}
    button[disabled]:hover{background:none}
    .more,.close{padding:0 9px;border-left:1px solid rgba(255,255,255,.24)}
    .close{padding:0 8px}
    .sub{font-weight:500;opacity:.88;max-width:150px;overflow:hidden;text-overflow:ellipsis}
    .sub:empty{display:none}
    .spin svg{animation:spin .9s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .menu{display:none;position:absolute;top:calc(100% + 6px);right:0;min-width:224px;max-width:300px;padding:6px;border-radius:13px;background:#FAF9F5;color:#1F1E1D;border:1px solid rgba(31,30,29,.14);box-shadow:0 12px 32px rgba(0,0,0,.28);font-weight:500}
    .menu.open{display:block}
    .menu.up{top:auto;bottom:calc(100% + 6px)}
    .menu.left{right:auto;left:0}
    .item{width:100%;padding:0 10px;height:36px;border-radius:8px;gap:10px}
    .item:hover{background:rgba(188,86,52,.13)}
    .item svg{flex:none;opacity:.75}
    .item .name{flex:1;overflow:hidden;text-overflow:ellipsis}
    .item .size{opacity:.58;font-size:12px;font-weight:500}
    .item.on .name{color:#BC5634;font-weight:700}
    .head{padding:6px 10px 5px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;opacity:.55;font-weight:600}
    .sep{height:1px;margin:5px 4px;background:currentColor;opacity:.11}
    @media (prefers-color-scheme:dark){.menu{background:#262624;color:#F4F3EE;border-color:rgba(255,255,255,.14)}.item:hover{background:rgba(217,119,87,.2)}.item.on .name{color:#E8896A}}
    @media (prefers-reduced-motion:reduce){.wrap,.bar,.spin svg{transition:none;animation:none}}
  `;

  function ensureHost() {
    if (host) { if (host.style.display === 'none') host.style.display = 'block'; return true; }
    const parent = document.fullscreenElement && !['VIDEO', 'IFRAME'].includes(document.fullscreenElement.tagName) ? document.fullscreenElement : document.documentElement;
    if (!parent) return false;
    host = document.createElement('qvs-download-button');
    host.style.cssText = 'all:initial!important;position:fixed!important;left:0!important;top:0!important;width:0!important;height:0!important;overflow:visible!important;z-index:2147483647!important;display:block!important;pointer-events:none!important';
    const root = host.attachShadow({mode: 'closed'});
    root.innerHTML = `<style>${CSS}</style><div class="wrap"><div class="pill"><i class="bar"></i>
      <button class="main" type="button"><span class="ico"></span><span class="label">Download</span><span class="sub"></span></button>
      <button class="more" type="button" aria-label="Choose quality" aria-haspopup="menu" aria-expanded="false">${svg('chevron')}</button>
      <button class="close" type="button" aria-label="Hide this button" title="Hide">${svg('close')}</button></div><div class="menu" role="menu"></div></div>`;
    const q = selector => root.querySelector(selector);
    els = {wrap: q('.wrap'), bar: q('.bar'), main: q('.main'), ico: q('.ico'), label: q('.label'), sub: q('.sub'), more: q('.more'), close: q('.close'), menu: q('.menu')};
    // The page must not see (or react to) clicks on the button: a player would pause or seek.
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'contextmenu', 'wheel']) host.addEventListener(type, event => event.stopPropagation());
    els.wrap.addEventListener('pointerenter', () => { overButton = true; clearTimeout(hideTimer); });
    els.wrap.addEventListener('pointerleave', () => { overButton = false; if (visible && !menuOpen) armHide(900); });
    els.main.addEventListener('click', event => { if (event.isTrusted) onMain(); });
    els.more.addEventListener('click', event => { if (event.isTrusted) menuOpen ? closeMenu() : openMenu(); });
    els.close.addEventListener('click', event => { if (event.isTrusted && current) { dismissed.add(current); hide(); } });
    els.menu.addEventListener('click', event => {
      const item = event.target.closest('[data-act]');
      if (item && event.isTrusted) onMenu(item.dataset.act, item.dataset.key || '');
    });
    resizer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (visible) place(); }) : null;
    parent.appendChild(host);
    return true;
  }

  const wrap = () => els?.wrap;

  const bytes = n => n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(n >= 104857600 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  const sizeText = q => q.size ? (q.approx ? '~' : '') + bytes(q.size) : '';

  function paint() {
    if (!els || !current) return;
    const meta = metaOf(current);
    const card = meta.info?.card;
    const quality = card ? card.qualities.find(q => q.key === card.defaultQuality) || card.qualities[0] : null;
    let label = card?.live ? 'Record live' : 'Download', sub = '', icon = 'download', mode = 'idle', disabled = false, progress = 0, spin = false;
    if (meta.state === 'busy') {
      const job = meta.job || {};
      mode = 'busy'; progress = job.progress || 0;
      if (job.state === 'paused') { label = 'Paused'; sub = `${Math.round(progress)}%`; icon = 'stop'; }
      else if (job.state === 'processing') { label = 'Processing'; icon = 'spinner'; spin = true; progress = 100; }
      else if (job.state === 'downloading' && (progress > 0 || job.downloaded)) { label = progress > 0 ? `${Math.round(progress)}%` : bytes(job.downloaded); sub = job.speed ? bytes(job.speed) + '/s' : ''; icon = 'spinner'; spin = true; }
      else { label = 'Starting'; icon = 'spinner'; spin = true; }
    } else if (meta.state === 'done') { mode = 'done'; label = 'Saved'; sub = 'Show in folder'; icon = 'check'; progress = 100; }
    else if (meta.state === 'error') { mode = 'error'; label = meta.code === 'setup' ? 'Set up helper' : 'Failed'; sub = meta.code === 'setup' ? '' : meta.error; icon = 'alert'; }
    else if (card?.drm) { label = 'DRM protected'; icon = 'alert'; disabled = true; }
    else if (quality) sub = [quality.label, sizeText(quality)].filter(Boolean).join(' · ');
    if (els.label.textContent !== label) els.label.textContent = label;
    if (els.sub.textContent !== sub) els.sub.textContent = sub;
    els.sub.title = meta.state === 'error' ? meta.error : '';
    if (els.ico.dataset.icon !== icon) { els.ico.dataset.icon = icon; els.ico.innerHTML = svg(icon); }
    els.main.classList.toggle('spin', spin);
    els.main.disabled = disabled;
    els.more.hidden = disabled;
    els.bar.style.transform = `scaleX(${Math.max(0, Math.min(1, progress / 100))})`;
    els.wrap.dataset.mode = mode;
    if (menuOpen) fillMenu();
    place();
  }

  function onMain() {
    if (!current) return;
    const meta = metaOf(current);
    const card = meta.info?.card;
    if (meta.state === 'busy') openMenu();
    else if (meta.state === 'done') post({type: 'OV_JOB_ACTION', id: meta.job?.id, action: 'reveal'});
    else if (meta.state === 'error' && meta.code === 'setup') post({type: 'OV_OPEN'});
    else download(current, {qualityKey: card?.defaultQuality || ''});
  }

  // ---- the quality menu -----------------------------------------------------------------------------------
  const item = (act, icon, name, extraText = '', key = '', on = false) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'item' + (on ? ' on' : ''); button.setAttribute('role', 'menuitem');
    button.dataset.act = act; if (key) button.dataset.key = key;
    button.insertAdjacentHTML('afterbegin', svg(icon));
    const label = document.createElement('span'); label.className = 'name'; label.textContent = name; button.append(label);
    if (extraText) { const size = document.createElement('span'); size.className = 'size'; size.textContent = extraText; button.append(size); }
    return button;
  };
  const separator = () => Object.assign(document.createElement('div'), {className: 'sep'});
  const heading = text => Object.assign(document.createElement('div'), {className: 'head', textContent: text});

  function fillMenu() {
    if (!current) return;
    const meta = metaOf(current);
    const card = meta.info?.card;
    const nodes = [];
    if (meta.state === 'busy') {
      nodes.push(item('cancel', 'stop', 'Cancel download'));
    } else {
      if (meta.state === 'done') nodes.push(item('reveal', 'folder', 'Show in folder'), separator());
      if (card && !card.drm) {
        nodes.push(heading(meta.state === 'done' ? 'Download again' : 'Choose quality'));
        for (const q of card.qualities.slice(0, 10)) nodes.push(item('quality', 'download', q.label, sizeText(q), q.key, q.key === card.defaultQuality));
        if (card.kind !== 'audio') nodes.push(item('audio', 'music', 'Audio only'));
      } else nodes.push(item('quality', 'download', card?.drm ? 'DRM protected' : meta.info?.analyzing ? 'Looking for the best quality…' : 'Save this video'));
    }
    nodes.push(separator(), item('site', 'eyeOff', 'Hide on this site'));
    els.menu.replaceChildren(...nodes);
  }

  function openMenu() {
    menuOpen = true;
    clearTimeout(hideTimer);
    els.more.setAttribute('aria-expanded', 'true');
    if (current) query(current);   // qualities may have arrived since the button appeared
    fillMenu();
    els.menu.classList.add('open');
    const box = els.wrap.getBoundingClientRect(), menu = els.menu.getBoundingClientRect();
    els.menu.classList.toggle('up', box.bottom + menu.height + 12 > innerHeight && box.top > menu.height + 12);
    els.menu.classList.toggle('left', box.right - menu.width < 4);
  }

  function closeMenu() {
    if (!menuOpen) return;
    menuOpen = false;
    els.more.setAttribute('aria-expanded', 'false');
    els.menu.classList.remove('open');
    if (visible) armHide(IDLE_HIDE);
  }

  function onMenu(act, key) {
    const video = current;
    closeMenu();
    if (!video) return;
    const meta = metaOf(video);
    if (act === 'quality') download(video, {qualityKey: key || meta.info?.card?.defaultQuality || ''});
    else if (act === 'audio') download(video, {audioOnly: true});
    else if (act === 'cancel') post({type: 'OV_JOB_ACTION', id: meta.job?.id, action: 'cancel'});
    else if (act === 'reveal') post({type: 'OV_JOB_ACTION', id: meta.job?.id, action: 'reveal'});
    else if (act === 'site') { post({type: 'OV_HIDE_SITE', host: siteHost}); hide(); }
  }
})();
