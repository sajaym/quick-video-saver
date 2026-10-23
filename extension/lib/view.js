// Turns raw tab state into the cards the interface shows. Pure functions: unit-testable in Node.
import {hostOf, extOf} from './util.js';
import {linkVideos, variantKeys} from './model.js';
import {codecSummary, qualityLabel, prettyCodecs} from './manifest.js';
import {pickTitle, cleanTitle} from './title.js';

const MAX_MORE = 8;
const KIND_BASE = {page: 100, embed: 70, hls: 80, dash: 78, mss: 60, file: 62, audio: 22, blob: 8};

export function pageHost(st) {
  return hostOf(st.page?.url || st.url);
}

export function pageTitle(st) {
  const host = pageHost(st);
  // A tab that is itself a media file ("sample.mp4"): the file name is the best title there is.
  const direct = /\/([^/]+)\.(?:mp4|webm|mkv|mov|m4v|m3u8|mpd|mp3|m4a|flv|ogv)$/i.exec((() => { try { return new URL(st.page?.url || st.url).pathname; } catch { return ''; } })());
  if (direct && !st.page?.ld?.length && !st.page?.ogTitle) { try { return decodeURIComponent(direct[1]).replace(/[_+]+/g, ' ').trim() || 'Video'; } catch { return direct[1]; } }
  const ld = st.page?.ld?.find(v => v.name)?.name || '';
  return pickTitle({ld, og: st.page?.ogTitle, twitter: st.page?.twitterTitle, heading: st.page?.heading, doc: st.page?.title, tab: st.title || st.page?.title, host, siteName: st.page?.siteName});
}

function fileNameOf(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || ''); } catch { return ''; }
}

function containerLabel(item) {
  if (item.kind === 'hls') return 'HLS';
  if (item.kind === 'dash') return 'DASH';
  if (item.kind === 'mss') return 'Smooth';
  const ext = extOf(item.url) || (/\/([\w.+-]+)$/.exec((item.mime || '').split(';')[0])?.[1] || '').replace(/^x-/, '');
  const label = (/^(mp4|m4v|webm|mkv|mov|flv|avi|wmv|mpeg|mpg|3gp|ogv|mp3|m4a|aac|ogg|opus|wav|flac)$/.test(ext) ? ext : item.kind === 'audio' ? 'audio' : 'video').toUpperCase();
  return label;
}

function pickDefault(qualities, cap) {
  const limit = cap && cap !== 'best' ? Number(cap) : 0;
  if (!qualities.length) return '';
  const fit = limit ? qualities.find(q => !q.height || q.height <= limit) : qualities[0];
  return (fit || qualities[qualities.length - 1]).key;
}

function itemQualities(item, link) {
  const m = item.manifest;
  const duration = m?.duration || item.media?.duration || link?.duration || 0;
  if (m && m.variants.length) {
    return m.variants.map((v, index) => ({
      key: String(v.id || v.height || index) + ':' + index, label: v.label || qualityLabel(v.height, v.fps) || 'Stream', height: v.height || 0, width: v.width || 0, fps: v.fps || 0,
      size: v.size || (duration && v.bandwidth ? Math.round(v.bandwidth * duration / 8) : 0), approx: true, codecs: codecSummary(v.codecs), bandwidth: v.bandwidth || 0,
    }));
  }
  const height = item.media?.height || link?.height || 0;
  const width = item.media?.width || link?.width || 0;
  let size = item.size || item.media?.size || 0;
  let approx = false;
  if (!size && item.media?.bitrate && duration) { size = Math.round(item.media.bitrate * duration / 8); approx = true; }
  if (!size && m?.segments && duration && item.media?.bitrate) { size = Math.round(item.media.bitrate * duration / 8); approx = true; }
  return [{key: 'best', label: height ? qualityLabel(height, item.media?.fps || 0) : item.kind === 'audio' ? 'Audio' : 'Original', height, width, fps: item.media?.fps || 0, size, approx, codecs: item.media ? prettyCodecs(item.media.vcodec, item.media.acodec) : ''}];
}

function itemCard(item, link, base, ctx, multiple) {
  const m = item.manifest;
  const qualities = itemQualities(item, link);
  const duration = m?.duration || item.media?.duration || link?.duration || 0;
  const defaultKey = pickDefault(qualities, ctx.settings.quality);
  const chosen = qualities.find(q => q.key === defaultKey) || qualities[0];
  const title = multiple && link?.label ? cleanTitle(link.label, {host: pageHost(ctx.st)}) || base : base;
  const drm = m?.drm || '';
  let score = KIND_BASE[item.kind] || 30;
  if (link) score += 10 + (link.playing ? 8 : 0) + (link.visible ? 4 : 0);
  if (item.size) score += Math.min(12, Math.log10(item.size + 1) * 1.6);
  if (duration > 120) score += 8; else if (duration && duration < 20) score -= 14;
  if (item.weak) score -= 60;
  if (m && !m.master && !m.variants.length && m.segments && m.segments < 4) score -= 25; // ad-sized playlist
  if (drm) score -= 5;
  if (item.sources.length === 1 && item.sources[0] === 'data') score -= 10;
  return {
    id: item.id, source: 'item', kind: item.kind, title, host: hostOf(item.url), subtitle: [hostOf(item.url), fileNameOf(item.url)].filter(Boolean).join(' · '), poster: link?.poster || '', thumb: link?.thumb || '',
    container: containerLabel(item), duration, live: !!m?.live, drm, encrypted: !!m?.encrypted, qualities, defaultQuality: defaultKey, size: chosen?.size || 0, approx: !!chosen?.approx,
    resolution: chosen?.label || '', playing: link ? qualityLabel(link.height) : '', codecs: chosen?.codecs || '', weak: !!item.weak, score, analysis: item.analysis, url: item.url,
    tracks: m ? {audio: m.audio.length, subtitles: m.subtitles} : null,
  };
}

function infoCards(st, ctx, base) {
  const cards = [];
  const seen = new Set();
  const pageURL = st.page?.url || st.url;
  // The page itself first, so an embed of the very same video (og:video) never shows up twice.
  const probes = Object.entries(st.probes || {}).sort(([a], [b]) => (a === pageURL ? -1 : 0) - (b === pageURL ? -1 : 0));
  for (const [url, probe] of probes) {
    if (probe.state !== 'done' || !probe.info) continue;
    const info = probe.info;
    if (info.id && info.extractor && info.kind !== 'playlist') {
      const identity = info.extractor + ':' + info.id;
      if (seen.has(identity)) continue;
      seen.add(identity);
    }
    const generic = /^generic$/i.test(info.extractor || '');
    const isPage = url === (st.page?.url || st.url);
    if (info.kind === 'playlist') {
      for (const [index, entry] of (info.entries || []).entries()) {
        cards.push({id: `entry:${index}:${entry.url}`, source: 'entry', kind: 'page', title: entry.title || `${base} #${index + 1}`, host: hostOf(entry.url), subtitle: hostOf(entry.url), poster: entry.thumbnail || '', thumb: '', container: 'VIDEO',
          duration: entry.duration || 0, live: false, drm: '', qualities: [{key: 'best', label: 'Best', height: 0, size: 0, approx: true}], defaultQuality: 'best', size: 0, approx: true, resolution: 'Best', weak: false, score: 50 - index * 0.1, url: entry.url, analysis: 'none', playlist: true});
      }
      continue;
    }
    const qualities = (info.qualities || []).map(q => ({key: q.formatId || String(q.height), label: q.label, height: q.height, width: q.width, fps: q.fps, size: q.size, approx: q.approx, codecs: [q.vcodec && prettyCodecs(q.vcodec), q.hdr ? 'HDR' : ''].filter(Boolean).join(' '), formatId: q.formatId, hasAudio: q.hasAudio}));
    const single = info.single;
    if (!qualities.length) qualities.push({key: 'best', label: single?.height ? qualityLabel(single.height) : 'Best', height: single?.height || 0, width: single?.width || 0, size: single?.size || 0, approx: !single?.size, codecs: ''});
    const defaultKey = pickDefault(qualities, ctx.settings.quality);
    const chosen = qualities.find(q => q.key === defaultKey) || qualities[0];
    cards.push({
      id: 'page:' + url, source: 'page', kind: 'page', title: info.title && !generic ? info.title : base, host: hostOf(url), subtitle: [info.site && !generic ? info.site : '', info.uploader].filter(Boolean).join(' · ') || hostOf(url), poster: info.thumbnail || '', thumb: '',
      container: (info.ext || 'video').toUpperCase(), duration: info.duration || 0, live: !!info.live, drm: info.drm ? 'DRM' : '', qualities, defaultQuality: defaultKey, size: chosen?.size || 0, approx: !!chosen?.approx,
      resolution: chosen?.label || '', codecs: chosen?.codecs || '', weak: false, score: generic ? 55 : isPage ? 110 : 100, url, analysis: 'done', site: info.site, generic, audio: info.audio, subtitles: info.subtitles || [], embedded: !isPage,
    });
  }
  return cards;
}

export function buildView(st, ctx) {
  const base = pageTitle(st);
  const items = Object.values(st.items).filter(item => !item.invalid);
  const hiddenKeys = variantKeys(items);
  const links = linkVideos(st);
  const videoCount = Object.values(st.frames).reduce((n, f) => n + f.videos.filter(v => v.kind === 'video').length, 0);
  const itemCards = items.filter(item => !hiddenKeys.has(item.key)).map(item => itemCard(item, links.get(item.id), base, {...ctx, st}, videoCount > 1));
  const cards = [...itemCards, ...infoCards(st, {...ctx, st}, base)];

  // Embedded players that a site extractor understands: shown until their own analysis replaces them.
  for (const embed of Object.values(st.embeds)) {
    const probe = st.probes?.[embed.url];
    if (probe?.state === 'done' || probe?.state === 'failed') continue;
    cards.push({id: 'embed:' + embed.url, source: 'embed', kind: 'embed', title: base, host: hostOf(embed.url), subtitle: `Embedded player · ${hostOf(embed.url)}`, poster: st.page?.ld?.find(v => v.thumbnail)?.thumbnail || st.page?.ogImage || '', thumb: '', container: 'EMBED', duration: 0, live: false, drm: '',
      qualities: [{key: 'best', label: 'Best', height: 0, size: 0, approx: true}], defaultQuality: 'best', size: 0, approx: true, resolution: 'Best', weak: false, score: 66, url: embed.url, analysis: probe?.state === 'running' ? 'pending' : 'none'});
  }

  // The site extractor and the network often describe the very same video (Vimeo, TED...): keep one prominent.
  for (const page of cards.filter(c => c.source === 'page' && !c.generic && c.duration)) {
    const top = Math.max(0, ...page.qualities.map(q => q.height || 0));
    for (const card of cards) {
      if (card.source !== 'item' || !['hls', 'dash', 'file', 'mss'].includes(card.kind) || !card.duration) continue;
      const cardTop = Math.max(0, ...card.qualities.map(q => q.height || 0));
      if (Math.abs(card.duration - page.duration) <= 3 && cardTop && cardTop === top) card.score -= 45;
    }
  }
  // A page-level card from the generic extractor duplicates what the network already found.
  const strong = cards.filter(c => !c.weak && c.source === 'item' && ['hls', 'dash', 'file', 'mss'].includes(c.kind));
  for (const card of cards) if (card.generic && strong.length) card.score -= 40;

  // The page's own poster is the best fallback artwork when only one video is present.
  const poster = st.page?.ld?.find(v => v.thumbnail)?.thumbnail || st.page?.ogImage || '';
  for (const card of cards) if (!card.poster && !card.thumb && poster && cards.filter(c => !c.weak).length <= 2) card.poster = poster;

  cards.sort((a, b) => b.score - a.score);
  const strongScore = cards.find(c => !c.weak)?.score ?? 0;
  for (const card of cards) {
    card.group = card.weak || card.score < strongScore - 38 || (card.duration && card.duration < 20 && card.score < strongScore - 10) ? 'more' : 'main';
  }
  const main = cards.filter(c => c.group === 'main').slice(0, 4);
  for (const card of cards) if (card.group === 'main' && !main.includes(card)) card.group = 'more';
  // Pages can list dozens of loose files (translated subtitles clips, related videos): show the best few.
  let shown = 0, dropped = 0;
  const trimmed = cards.filter(card => card.group !== 'more' || ++shown <= MAX_MORE || (dropped++, false));
  if (main[0]) main[0].best = main.length > 1;   // a "best match" ribbon on a lone card is just noise

  const probes = Object.values(st.probes || {});
  const analyzing = probes.some(p => p.state === 'running') || items.some(item => item.analysis === 'pending');
  let hint = '';
  if (!cards.length) {
    if (st.drm) hint = 'drm';
    else if (st.partial) hint = 'partial';
    else if (st.mse) hint = 'blob';
  }
  const own = st.probes?.[st.page?.url || st.url];
  return {title: base, host: pageHost(st), url: st.page?.url || st.url, siteName: st.page?.siteName || '', cards: trimmed, hiddenCount: dropped, analyzing, drm: st.drm, hint, pageProbe: {state: own?.state || 'idle', error: own?.error || '', errorCode: own?.errorCode || ''}};
}
