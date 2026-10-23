// Parsers for streaming manifests (HLS, MPEG-DASH, Smooth Streaming).
// They run inside the service worker, so no DOM APIs (DOMParser) are used.
import {isoDuration, resolveURL} from './util.js';

const DRM_UUID = {
  'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'Widevine',
  '9a04f079-9840-4286-ab92-e65be0885f95': 'PlayReady',
  '94ce86fb-07ff-4f43-adb8-93d2fa968ca2': 'FairPlay',
  '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b': 'CENC',
};

export function qualityLabel(height, fps = 0) {
  if (!height) return '';
  return `${height}p${fps > 30 ? Math.round(fps) : ''}`;
}

function attributes(text) {
  const result = {};
  for (const [, key, raw] of text.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) result[key] = raw.replace(/^"|"$/g, '');
  return result;
}

function resolution(value) {
  const match = /^(\d+)x(\d+)$/i.exec(value || '');
  return match ? {width: Number(match[1]), height: Number(match[2])} : {width: 0, height: 0};
}

function describeVariants(variants, duration) {
  for (const variant of variants) {
    variant.label = qualityLabel(variant.height, variant.fps) || (variant.bandwidth ? `${Math.round(variant.bandwidth / 1000)} kbps` : 'Stream');
    if (duration && variant.bandwidth) { variant.size = Math.round(variant.bandwidth * duration / 8); variant.approx = true; }
  }
  return variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
}

export function parseHLS(text, baseURL) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) return null;
  const out = {type: 'hls', master: false, variants: [], audio: [], subtitles: [], segments: 0, duration: 0, live: false, encrypted: false, drm: '', fmp4: false};
  let hasEnd = false, playlistType = '', pending = null, segmentDuration = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) { pending = attributes(line.slice(18)); continue; }
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attributes(line.slice(13));
      const track = {type: a.TYPE, group: a['GROUP-ID'], name: a.NAME || a.LANGUAGE || '', lang: a.LANGUAGE || '', url: a.URI ? resolveURL(a.URI, baseURL) : '', default: a.DEFAULT === 'YES'};
      if (a.TYPE === 'AUDIO') out.audio.push(track);
      else if (a.TYPE === 'SUBTITLES') out.subtitles.push(track);
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const a = attributes(line.slice(11));
      const method = (a.METHOD || 'NONE').toUpperCase();
      if (method !== 'NONE') out.encrypted = true;
      const format = (a.KEYFORMAT || '').toLowerCase();
      if (/sample-aes/.test(method.toLowerCase()) && /fairplay|streamingkeydelivery|widevine|edef8ba9|playready|9a04f079/.test(format) || /edef8ba9|9a04f079|streamingkeydelivery|fairplay/.test(format)) {
        out.drm = /edef8ba9/.test(format) ? 'Widevine' : /9a04f079/.test(format) ? 'PlayReady' : 'FairPlay';
      } else if (method === 'SAMPLE-AES-CTR' || method === 'SAMPLE-AES-CENC') out.drm = out.drm || 'DRM';
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) { out.fmp4 = true; continue; }
    if (line.startsWith('#EXT-X-ENDLIST')) { hasEnd = true; continue; }
    if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) { playlistType = line.slice(21).trim().toUpperCase(); continue; }
    if (line.startsWith('#EXTINF:')) { segmentDuration = parseFloat(line.slice(8)) || 0; continue; }
    if (line.startsWith('#')) continue;
    if (pending) {
      const {width, height} = resolution(pending.RESOLUTION);
      out.variants.push({
        url: resolveURL(line, baseURL), bandwidth: Number(pending.BANDWIDTH) || 0, average: Number(pending['AVERAGE-BANDWIDTH']) || 0, width, height,
        fps: parseFloat(pending['FRAME-RATE']) || 0, codecs: pending.CODECS || '', audioGroup: pending.AUDIO || '', hasAudio: !pending.AUDIO,
      });
      out.master = true;
      pending = null;
    } else if (segmentDuration !== null) {
      out.segments++;
      out.duration += segmentDuration;
      segmentDuration = null;
    }
  }
  out.live = !out.master && !hasEnd && playlistType !== 'VOD';
  if (out.master) {
    for (const variant of out.variants) variant.bandwidth = variant.average || variant.bandwidth;
    describeVariants(out.variants, 0);
  }
  return out;
}

// ---- tiny XML reader (MPD / ISM) -------------------------------------------------------------
export function parseXML(text) {
  const root = {name: '#root', attrs: {}, children: [], text: ''};
  const stack = [root];
  const source = String(text || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, data) => data.replace(/[<>&]/g, ''));
  const tag = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let match;
  while ((match = tag.exec(source))) {
    const [, closing, name, rawAttrs, selfClosing, content] = match;
    if (content !== undefined) { stack[stack.length - 1].text += content; continue; }
    const local = name.replace(/^.*:/, '');
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs = {};
    for (const [, key, dq, sq] of rawAttrs.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[key.replace(/^.*:/, '')] = dq ?? sq;
    const node = {name: local, attrs, children: [], text: ''};
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root.children[0] || null;
}

const kids = (node, name) => node.children.filter(child => child.name === name);
const find = (node, name) => node.children.find(child => child.name === name);
function* walk(node) { yield node; for (const child of node.children) yield* walk(child); }

export function parseMPD(text, baseURL) {
  const mpd = parseXML(text);
  if (!mpd || mpd.name !== 'MPD') return null;
  const out = {type: 'dash', variants: [], audio: [], subtitles: [], duration: isoDuration(mpd.attrs.mediaPresentationDuration), live: mpd.attrs.type === 'dynamic', drm: '', encrypted: false};
  const base = resolveURL(find(mpd, 'BaseURL')?.text.trim() || '', baseURL) || baseURL;
  for (const node of walk(mpd)) {
    if (node.name === 'ContentProtection') {
      const scheme = (node.attrs.schemeIdUri || '').toLowerCase();
      const uuid = scheme.replace(/^urn:uuid:/, '');
      out.encrypted = true;
      if (DRM_UUID[uuid] && uuid !== '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b') out.drm = DRM_UUID[uuid];
      else if (uuid === '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b') out.drm = out.drm || 'CENC';
    }
  }
  if (out.encrypted && !out.drm) out.drm = 'CENC';
  const periods = kids(mpd, 'Period');
  if (!out.duration) out.duration = periods.reduce((sum, period) => sum + isoDuration(period.attrs.duration), 0);
  for (const period of periods.slice(0, 1)) {
    for (const set of kids(period, 'AdaptationSet')) {
      const setMime = (set.attrs.mimeType || set.attrs.contentType || '').toLowerCase();
      for (const rep of kids(set, 'Representation')) {
        const mime = (rep.attrs.mimeType || setMime).toLowerCase();
        const codecs = rep.attrs.codecs || set.attrs.codecs || '';
        const bandwidth = Number(rep.attrs.bandwidth) || 0;
        const width = Number(rep.attrs.width || set.attrs.width) || 0, height = Number(rep.attrs.height || set.attrs.height) || 0;
        const isVideo = /video/.test(mime) || (!/audio|text|application/.test(mime) && height > 0);
        const isAudio = /audio/.test(mime) && !isVideo;
        const frame = String(rep.attrs.frameRate || set.attrs.frameRate || '0');
        const fps = frame.includes('/') ? Number(frame.split('/')[0]) / (Number(frame.split('/')[1]) || 1) : Number(frame);
        if (isVideo) out.variants.push({id: rep.attrs.id, bandwidth, width, height, fps: Math.round(fps * 100) / 100, codecs, hasAudio: false, url: baseURL});
        else if (isAudio) out.audio.push({id: rep.attrs.id, bandwidth, codecs, lang: set.attrs.lang || '', name: set.attrs.lang || rep.attrs.id || 'Audio'});
        else if (/text|application/.test(mime) && /vtt|ttml|stpp|srt/.test(mime + codecs)) out.subtitles.push({lang: set.attrs.lang || '', name: set.attrs.lang || ''});
      }
    }
  }
  const audioBandwidth = out.audio.reduce((best, track) => Math.max(best, track.bandwidth), 0);
  for (const variant of out.variants) variant.bandwidth += audioBandwidth;
  describeVariants(out.variants, out.duration);
  out.base = base;
  return out;
}

export function parseISM(text, baseURL) {
  const root = parseXML(text);
  if (!root || root.name !== 'SmoothStreamingMedia') return null;
  const scale = Number(root.attrs.TimeScale) || 10_000_000;
  const out = {type: 'mss', variants: [], audio: [], subtitles: [], duration: (Number(root.attrs.Duration) || 0) / scale, live: root.attrs.IsLive === 'TRUE', drm: root.children.some(c => c.name === 'Protection') ? 'PlayReady' : '', encrypted: false};
  out.encrypted = !!out.drm;
  for (const stream of kids(root, 'StreamIndex')) {
    const type = (stream.attrs.Type || '').toLowerCase();
    for (const level of kids(stream, 'QualityLevel')) {
      const bandwidth = Number(level.attrs.Bitrate) || 0;
      if (type === 'video') out.variants.push({bandwidth, width: Number(level.attrs.MaxWidth) || 0, height: Number(level.attrs.MaxHeight) || 0, fps: 0, codecs: level.attrs.FourCC || '', hasAudio: false, url: baseURL});
      else if (type === 'audio') out.audio.push({bandwidth, name: stream.attrs.Name || stream.attrs.Language || 'Audio', lang: stream.attrs.Language || ''});
    }
  }
  describeVariants(out.variants, out.duration);
  return out;
}

export function parseManifest(kind, text, baseURL) {
  try {
    if (kind === 'hls') return parseHLS(text, baseURL);
    const info = kind === 'dash' ? parseMPD(text, baseURL) : kind === 'mss' ? parseISM(text, baseURL) : null;
    // A truncated or foreign document parses to an empty shell: treat that as "unreadable".
    return info && (info.variants.length || info.audio.length || info.duration) ? info : null;
  } catch { /* malformed manifests must never break detection */ }
  return null;
}

// What a text body really is, regardless of its URL or content type.
export function sniffManifest(text) {
  const head = String(text || '').slice(0, 4096).replace(/^﻿/, '').trimStart();
  if (head.startsWith('#EXTM3U')) return 'hls';
  if (/<MPD[\s>]/.test(head)) return 'dash';
  if (/<SmoothStreamingMedia[\s>]/.test(head)) return 'mss';
  return '';
}

export function codecSummary(codecs) {
  const text = String(codecs || '').toLowerCase();
  const parts = [];
  if (/avc[13]/.test(text)) parts.push('H.264');
  else if (/hev1|hvc1|h265/.test(text)) parts.push('H.265');
  else if (/vp0?9/.test(text)) parts.push('VP9');
  else if (/av01/.test(text)) parts.push('AV1');
  if (/mp4a/.test(text)) parts.push('AAC');
  else if (/opus/.test(text)) parts.push('Opus');
  else if (/ac-3|ec-3/.test(text)) parts.push('Dolby');
  return parts.join(' + ');
}

const CODEC_NAMES = {h264: 'H.264', avc1: 'H.264', hevc: 'H.265', h265: 'H.265', vp9: 'VP9', vp8: 'VP8', av1: 'AV1', mpeg4: 'MPEG-4', aac: 'AAC', mp3: 'MP3', opus: 'Opus', vorbis: 'Vorbis', ac3: 'Dolby', eac3: 'Dolby', flac: 'FLAC'};
// ffprobe / yt-dlp codec names ("h264", "aac") to the labels people know.
export function prettyCodecs(...names) {
  return names.filter(Boolean).map(name => CODEC_NAMES[String(name).toLowerCase()] || String(name).toUpperCase()).join(' + ');
}
