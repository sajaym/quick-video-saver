// User preferences, stored locally. Every key is validated so a corrupt value can never break a download.
export const DEFAULTS = {
  quality: 'best',            // best | 2160 | 1440 | 1080 | 720 | 480 | 360
  container: 'mp4',           // mp4 | mkv
  audioFormat: 'mp3',         // mp3 | m4a
  preferCompat: true,         // choose H.264/AAC when resolutions are equal
  folder: '',                 // '' = Windows Downloads\Quick Video Saver
  parallel: 2,
  useCookies: true,           // let the helper reuse your browser login for the same site
  smartAnalyze: true,         // let the helper study the page when you open the extension
  notifications: true,
  overlay: true,              // show a Download button on top of videos in the page
  overlayHidden: [],          // sites where that button was switched off
  subtitles: false,
  autoUpdate: true,
  openIn: 'popup',            // popup | sidepanel
  theme: 'system',            // system | light | dark
  nameTemplate: '{title} [{quality}]',
  fragments: 6,
};

const RULES = {
  quality: v => ['best', '2160', '1440', '1080', '720', '480', '360'].includes(v),
  container: v => ['mp4', 'mkv'].includes(v),
  audioFormat: v => ['mp3', 'm4a'].includes(v),
  openIn: v => ['popup', 'sidepanel'].includes(v),
  theme: v => ['system', 'light', 'dark'].includes(v),
  parallel: v => Number.isInteger(v) && v >= 1 && v <= 4,
  fragments: v => Number.isInteger(v) && v >= 1 && v <= 16,
  folder: v => typeof v === 'string' && v.length < 400 && !/[\x00-\x1f"<>|*?]/.test(v) && (v === '' || /^[a-zA-Z]:\\|^\\\\/.test(v)),
  overlayHidden: v => Array.isArray(v) && v.length <= 200 && v.every(host => typeof host === 'string' && host.length < 120 && /^[\w.-]+$/.test(host)),
  nameTemplate: v => typeof v === 'string' && v.length < 120 && v.includes('{title}'),
};

for (const key of ['preferCompat', 'useCookies', 'smartAnalyze', 'notifications', 'subtitles', 'autoUpdate', 'overlay']) RULES[key] = v => typeof v === 'boolean';

let cache = null;

export async function getSettings() {
  if (cache) return cache;
  const {settings = {}} = await chrome.storage.local.get('settings');
  const merged = {...DEFAULTS};
  for (const [key, value] of Object.entries(settings)) if (key in DEFAULTS && RULES[key]?.(value)) merged[key] = value;
  cache = merged;
  return merged;
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = {...current};
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in DEFAULTS)) continue;
    if (!RULES[key]?.(value)) throw new Error(`Invalid value for ${key}.`);
    next[key] = value;
  }
  await chrome.storage.local.set({settings: next});
  cache = next;
  return next;
}

chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) cache = null; });
