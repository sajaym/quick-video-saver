// Decide whether a network response is a video, a streaming manifest, audio, or noise.
import {webURL, extOf} from './util.js';

const FILE_EXT = /^(mp4|webm|mkv|mov|m4v|ogv|avi|flv|wmv|mpeg|mpg|3gp|3g2|f4v|asf)$/;
const AUDIO_EXT = /^(mp3|m4a|aac|ogg|oga|opus|wav|flac|weba|wma)$/;
// Things that are never worth listing: segments, subtitles, keys, images, scripts.
const NOISE_EXT = /^(ts|m4s|cmfv|cmfa|cmfm|m4f|vtt|srt|webvtt|ttml|key|jpg|jpeg|png|gif|webp|avif|svg|ico|css|js|mjs|json|woff2?|ttf|otf|html?|xml|txt|wasm|map)$/;
// Names that are surely stream pieces, and names that only might be (video1.mp4 can be a real file).
const STRONG_SEGMENT = /(?:^|[\/_.-])(?:seg(?:ment)?|chunk|frag(?:ment)?|init)[-_]?\d{0,8}(?:[-_.][a-z0-9]+)*\.(?:mp4|m4s|m4a|aac|ts|webm)$/i;
const WEAK_SEGMENT = /(?:^|[\/_.-])(?:part|media|audio|video|v|a)[-_]?\d{1,8}(?:[-_.][a-z0-9]+)*\.(?:mp4|m4s|m4a|aac|ts|webm)$/i;
const SEGMENT_NAME = {test: path => STRONG_SEGMENT.test(path) || WEAK_SEGMENT.test(path)};
const NUMBERED_SEGMENT = /[\/_-]\d{3,}\.(?:m4s|ts|aac|cmfv|cmfa)$/i;
const AD_HOST = /(?:^|\.)(?:doubleclick\.net|googlesyndication\.com|googleadservices\.com|imasdk\.googleapis\.com|adnxs\.com|adsystem\.com|moatads\.com|innovid\.com|teads\.tv|spotxchange\.com|spotx\.tv|adform\.net|criteo\.com|taboola\.com|outbrain\.com|serving-sys\.com|2mdn\.net|adsrvr\.org|pubmatic\.com|rubiconproject\.com|openx\.net|smartadserver\.com|adition\.com|tremorhub\.com|freewheel\.tv|fwmrm\.net|jwpltx\.com|scorecardresearch\.com|vungle\.com|unity3d\.com|applovin\.com|mopub\.com|chartboost\.com)$/i;
const AD_PATH = /\/(?:ads?|adserver|adserving|vast|vmap|preroll|midroll|postroll|sponsor|promo-?video|commercial)\//i;
const VOLATILE_PARAM = /^(?:token|tok|sig|signature|expires?|exp|hash|hmac|auth|policy|key-pair-id|hdnts|hdntl|st|se|sp|sv|sr|rn|rbuf|range|bytes|bytestart|byteend|start|end|ts|_|cb|nocache|session|sid|x-amz-.*|x-goog-.*|x-ms-.*|googleaccessid|awsaccesskeyid|cmsg|cpn)$/i;

const HLS_MIME = /mpegurl|x-mpegurl|vnd\.apple\.mpegurl/i;
const DASH_MIME = /dash\+xml/i;
const MSS_MIME = /vnd\.ms-sstr\+xml/i;

export function isAdURL(url) {
  try {
    const parsed = new URL(url);
    return AD_HOST.test(parsed.hostname) || AD_PATH.test(parsed.pathname);
  } catch { return false; }
}

// Returns {kind, weak} or null. kind: hls | dash | mss | file | audio
export function classify(rawURL, mime = '', {size = 0, disposition = '', hasRange = false} = {}) {
  const href = webURL(rawURL);
  if (!href) return null;
  const url = new URL(href);
  if (isAdURL(href)) return null;
  const path = url.pathname.toLowerCase();
  const ext = extOf(href);
  const type = String(mime || '').split(';')[0].trim().toLowerCase();

  if (HLS_MIME.test(type) || /\.m3u8?$/.test(path)) return {kind: 'hls'};
  if (DASH_MIME.test(type) || /\.mpd$/.test(path)) return {kind: 'dash'};
  if (MSS_MIME.test(type) || /\.isml?\/manifest/i.test(path) || /\/manifest(?:\(.*\))?$/i.test(path) && /\.isml?\//i.test(path)) return {kind: 'mss'};

  // MPEG-TS pieces are HLS segments, unless one is big enough to be a whole recording served as a file.
  if (type === 'video/mp2t' || type === 'video/vnd.dlna.mpeg-tts') {
    return size >= 30_000_000 && !SEGMENT_NAME.test(path) && !NUMBERED_SEGMENT.test(path) ? {kind: 'file', weak: false} : null;
  }
  if (type === 'application/x-mpegurl-segment') return null;
  if (NOISE_EXT.test(ext) && !/^(video|audio)\//.test(type)) return null;
  if (NUMBERED_SEGMENT.test(path) || ext === 'm4s' || ext === 'cmfv' || ext === 'cmfa') return null;

  const dispositionExt = /filename\*?=(?:UTF-8'')?"?[^";]*\.([a-z0-9]{2,4})"?/i.exec(disposition || '')?.[1]?.toLowerCase() || '';
  const octet = /^(application\/octet-stream|binary\/octet-stream|application\/force-download|application\/x-download)$/.test(type);
  const isVideoType = /^video\//.test(type) || /^application\/(?:mp4|x-matroska)$/.test(type);
  const isAudioType = /^audio\//.test(type);

  if (isVideoType || FILE_EXT.test(ext) && (octet || !type || isVideoType) || octet && FILE_EXT.test(dispositionExt)) {
    const strong = STRONG_SEGMENT.test(path), maybe = WEAK_SEGMENT.test(path);
    const tiny = size > 0 && size < 250_000 && !hasRange;
    if (strong && size < 4_000_000) return null;
    if (maybe && size > 0 && size < 1_500_000) return null;
    return {kind: 'file', weak: tiny || strong || (maybe && !(size > 0))};
  }
  if (isAudioType || AUDIO_EXT.test(ext) && (octet || !type) || octet && AUDIO_EXT.test(dispositionExt)) {
    if (SEGMENT_NAME.test(path) || (size > 0 && size < 60_000)) return null;
    return {kind: 'audio', weak: size > 0 && size < 400_000};
  }
  return null;
}

// Same video seen again with a fresh token or a different Range must collapse into one entry.
export function normalizeKey(rawURL) {
  try {
    const url = new URL(rawURL);
    const keep = [...url.searchParams.entries()].filter(([name]) => !VOLATILE_PARAM.test(name)).sort(([a], [b]) => a.localeCompare(b));
    const query = keep.map(([k, v]) => `${k}=${v}`).join('&');
    return `${url.origin}${url.pathname}${query ? '?' + query : ''}`;
  } catch { return String(rawURL); }
}

// Hosts whose "video" URLs are partial DASH pieces: let the site extractor handle the page instead.
export function isPartialStreamHost(rawURL) {
  try {
    const url = new URL(rawURL);
    return /(?:^|\.)googlevideo\.com$/.test(url.hostname) && /\/videoplayback/.test(url.pathname)
      || /(?:^|\.)(?:fbcdn\.net|cdninstagram\.com)$/.test(url.hostname) && /\.mp4$/.test(url.pathname) && /[?&](?:bytestart|byteend)=/.test(url.search);
  } catch { return false; }
}

// Pull candidate media URLs out of JSON / JS configuration text.
const URL_IN_TEXT = /https?:\/\/[^\s"'<>\\)\]},]+?\.(?:m3u8|mpd|mp4|webm|m4v|mov|mkv|flv|mp3|m4a)(?:\?[^\s"'<>\\)\]},]*)?/gi;
export function urlsInText(text, limit = 40) {
  const clean = String(text || '').replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/\\u003d/gi, '=').replace(/&amp;/g, '&');
  const found = new Set();
  for (const match of clean.matchAll(URL_IN_TEXT)) {
    if (webURL(match[0]) && !isAdURL(match[0])) found.add(match[0]);
    if (found.size >= limit) break;
  }
  return [...found];
}

// Iframe sources that a site extractor understands directly (YouTube embeds, Vimeo players, ...).
const EMBED_PATTERNS = [
  /^https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/[\w-]{6,}/i,
  /^https?:\/\/player\.vimeo\.com\/video\/\d+/i,
  /^https?:\/\/(?:www\.)?dailymotion\.com\/embed\/video\/\w+/i,
  /^https?:\/\/(?:www\.)?facebook\.com\/plugins\/video\.php/i,
  /^https?:\/\/streamable\.com\/(?:e|o)\/\w+/i,
  /^https?:\/\/(?:www\.)?rumble\.com\/embed\/[\w.-]+/i,
  /^https?:\/\/(?:www\.)?odysee\.com\/\$\/embed\//i,
  /^https?:\/\/(?:www\.)?bitchute\.com\/embed\/\w+/i,
  /^https?:\/\/player\.twitch\.tv\/\?/i,
  /^https?:\/\/(?:fast|[\w-]+)\.wistia\.(?:net|com)\/embed\/(?:iframe|medias)\/\w+/i,
  /^https?:\/\/(?:www\.)?ok\.ru\/videoembed\/\d+/i,
  /^https?:\/\/(?:www\.)?vk\.com\/video_ext\.php/i,
  /^https?:\/\/players\.brightcove\.net\/\d+\//i,
  /^https?:\/\/(?:cdn\.)?jwplayer\.com\/players\//i,
  /^https?:\/\/(?:www\.)?tiktok\.com\/embed\//i,
  /^https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv)\/[\w-]+\/embed/i,
  /^https?:\/\/platform\.twitter\.com\/embed\//i,
  /^https?:\/\/(?:www\.)?ted\.com\/talks\//i,
  /^https?:\/\/(?:www\.)?(?:bilibili\.com\/blackboard\/html5mobileplayer|player\.bilibili\.com\/player)/i,
  /^https?:\/\/(?:w|embed)\.soundcloud\.com\//i,
];
export function embedURL(rawURL) {
  const href = webURL(rawURL);
  return href && EMBED_PATTERNS.some(pattern => pattern.test(href)) ? href : null;
}

// Sites where yt-dlp has a dedicated extractor, so analysing the page is always worthwhile.
const KNOWN_SITES = /(?:^|\.)(?:youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitter\.com|x\.com|facebook\.com|fb\.watch|instagram\.com|tiktok\.com|twitch\.tv|reddit\.com|bilibili\.com|soundcloud\.com|streamable\.com|rumble\.com|odysee\.com|bitchute\.com|ted\.com|vk\.com|ok\.ru|imgur\.com|9gag\.com|linkedin\.com|pinterest\.com|tumblr\.com|mxplayer\.in|sharechat\.com|bandcamp\.com|mixcloud\.com|nicovideo\.jp|pornhub\.com|xvideos\.com|xhamster\.com|redtube\.com|youporn\.com|spankbang\.com|eporner\.com|bbc\.co\.uk|cnn\.com|nbcnews\.com|arte\.tv|ndtv\.com|aajtak\.in|indiatoday\.in|dw\.com|france24\.com|hotstar\.com|jiocinema\.com|sonyliv\.com|zee5\.com|voot\.com|ustream\.tv|coub\.com|kick\.com|weibo\.com|douyin\.com|archive\.org|vevo\.com|crunchyroll\.com|funimation\.com)$/i;
export function isKnownSite(pageURL) {
  try { return KNOWN_SITES.test(new URL(pageURL).hostname); } catch { return false; }
}

// Players that fetch a video in byte ranges sometimes put the range in the URL ("?range=0-1048575").
// The download must ask for the whole file, so those parameters are removed.
export function withoutByteRange(rawURL) {
  try {
    const url = new URL(rawURL);
    let changed = false;
    for (const name of [...url.searchParams.keys()]) {
      const value = url.searchParams.get(name);
      if ((/^(?:range|bytes)$/i.test(name) && /^(?:bytes=)?\d+-\d*$/.test(value)) || (/^(?:bytestart|byteend)$/i.test(name) && /^\d+$/.test(value))) { url.searchParams.delete(name); changed = true; }
    }
    return changed ? url.href : rawURL;
  } catch { return rawURL; }
}
