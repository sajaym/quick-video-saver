// Turn noisy page titles into clean video names and file names.

const SEPARATORS = /\s+(?:[|\-–—•·»«~:]|::|\/\/)\s+|\s*\|\s*/;
const GENERIC = /^(?:home|homepage|official(?: site| website)?|watch(?: online| now| free| free online)?|video|videos|online|free|hd|full(?: video| movie)?|download|(?:free )?download,? borrow,? (?:and )?streaming|stream(?:ing)?|player|play|movies?|tv|tube|login|sign in)$/i;
const NOISE_PREFIX = /^(?:\(\d+\)\s*|\[\d+\]\s*|[▶►⏵🔴🔊🔇]+\s*)+/u;
const QUALITY_TAG = /\s*[\[(]?\s*\b(?:2160|1440|1080|720|576|480|360|240|144)p(?:\d{2})?\s*[\])]?\s*$/i;

const squash = text => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function siteLabel(host, siteName = '') {
  if (siteName) return siteName;
  const labels = String(host || '').replace(/^www\./, '').split('.');
  const main = labels.length > 2 && /^(?:co|com|org|net|gov|ac)$/.test(labels[labels.length - 2]) ? labels[labels.length - 3] : labels[labels.length - 2] || labels[0] || '';
  return main;
}

export function cleanTitle(raw, {host = '', siteName = ''} = {}) {
  let title = String(raw ?? '').replace(/\s+/g, ' ').replace(NOISE_PREFIX, '').trim();
  if (!title) return '';
  const site = squash(siteLabel(host, siteName));
  const hostLabel = squash(siteLabel(host));
  const parts = title.split(SEPARATORS).map(part => part.trim()).filter(Boolean);
  if (parts.length > 1) {
    const kept = parts.filter(part => {
      const flat = squash(part);
      if (!flat || GENERIC.test(part)) return false;
      const isSite = (site.length >= 3 && (flat === site || (flat.length <= site.length + 6 && flat.includes(site)))) || (hostLabel.length >= 3 && (flat === hostLabel || (flat.length <= hostLabel.length + 6 && flat.includes(hostLabel))));
      return !isSite;
    });
    if (kept.length) title = kept.join(' - ');
  }
  title = title.replace(QUALITY_TAG, '').trim();
  if (title.length > 150) {
    const cut = title.slice(0, 150);
    title = cut.slice(0, Math.max(60, cut.lastIndexOf(' '))).trim();
  }
  return title;
}

// Best human title for the video on this page. Structured data beats the raw <title>.
export function pickTitle({ld = '', og = '', twitter = '', heading = '', doc = '', tab = '', host = '', siteName = ''} = {}) {
  for (const candidate of [ld, og, twitter]) {
    const cleaned = cleanTitle(candidate, {host, siteName});
    if (cleaned && !GENERIC.test(cleaned) && cleaned.length >= 3) return cleaned;
  }
  const fromTab = cleanTitle(tab || doc, {host, siteName});
  if (fromTab && fromTab.length >= 3 && !GENERIC.test(fromTab)) return fromTab;
  const fromHeading = cleanTitle(heading, {host, siteName});
  if (fromHeading) return fromHeading;
  return siteLabel(host, siteName) ? `${siteLabel(host, siteName)} video` : 'Video';
}

export function fileBase(title, {quality = '', template = '{title} [{quality}]'} = {}) {
  const name = String(title || 'Video').trim() || 'Video';
  let out = template.replace('{title}', name).replace('{quality}', quality);
  if (!quality) out = out.replace(/\s*\[\]\s*/g, ' ').replace(/\s*\(\)\s*/g, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

// Mirrors the helper's safe_stem(): useful for previewing the final name in the UI.
export function safeName(text, limit = 150) {
  let out = String(text || '').normalize('NFC')
    .replace(/[\x00-\x1f\x7f​-‏‪-‮⁠﻿]/g, '')
    .replace(/:/g, ' -').replace(/[|/\\]/g, '-').replace(/"/g, "'").replace(/[<>*?]/g, '')
    .replace(/\s+/g, ' ').replace(/^[ .-]+|[ .-]+$/g, '');
  out = out.slice(0, limit).replace(/[ .-]+$/g, '');
  if (!out) out = 'Video';
  if (/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i.test(out)) out = '_' + out;
  return out;
}
