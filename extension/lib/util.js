// Small shared helpers used by the service worker and the interface.

export function webURL(value) {
  try {
    if (typeof value !== 'string' || value.length > 16000 || /[\x00-\x20\x7f]/.test(value)) return null;
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function hostOf(value) {
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function originOf(value) {
  try { return new URL(value).origin; } catch { return ''; }
}

export function resolveURL(relative, base) {
  try { return new URL(relative, base).href; } catch { return null; }
}

export const uid = () => crypto.randomUUID();
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function debounce(fn, ms) {
  let timer;
  const wrapped = (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  wrapped.flush = (...args) => { clearTimeout(timer); fn(...args); };
  return wrapped;
}

export function withTimeout(promise, ms, message = 'Timed out') {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}

export function readableBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** unit;
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function readableDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function readableSpeed(bytesPerSecond) {
  return bytesPerSecond > 0 ? `${readableBytes(bytesPerSecond)}/s` : '';
}

export function readableEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s left`;
  return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m left`;
}

// ISO-8601 durations as used by JSON-LD and DASH: PT1H2M3.5S, P0DT0H3M30S
export function isoDuration(value) {
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(String(value || '').trim());
  if (!match) return 0;
  const [, d = 0, h = 0, m = 0, s = 0] = match;
  return Number(d) * 86400 + Number(h) * 3600 + Number(m) * 60 + Number(s);
}

export function sizeLabel(size, approx) {
  const text = readableBytes(size);
  return text ? (approx ? '≈ ' : '') + text : '';
}

export function extOf(url) {
  try { return new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() || ''; } catch { return ''; }
}
