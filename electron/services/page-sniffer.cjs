'use strict';
/*
 * Page sniffer: finds the real media behind a web page when yt-dlp has no dedicated extractor.
 *
 * It mirrors what a person does in DevTools: look for <video>/<source type="video/mp4">, og:video, JSON-LD,
 * player configs in scripts, and nested <iframe> players, then CHECK each candidate with the same Referer a
 * browser would send before it is handed to the downloader (hot-link protected / signed CDN URLs).
 *
 * Two stages feed the same ranking and validation:
 *   1. static   - fetch the HTML (and nested iframes) and parse it.
 *   2. rendered - a hidden, sandboxed browser window runs the page's JavaScript and reports the live DOM and the
 *                 media requests the player makes (see rendered-sniffer.cjs). Players such as Fluid Player build
 *                 the <video><source> tag with JavaScript, which a plain fetch never sees.
 * Everything here is pure or takes injected I/O so it can be tested without a network or Electron.
 */

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const FILE_EXT = ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'ogv', 'ogg', 'flv', 'avi', 'mp3', 'm4a', 'aac', 'opus', 'wav', 'flac'];
const MEDIA_EXT_RX = '(?:mp4|m4v|webm|mov|mkv|ogv|flv|avi|m3u8|mpd|m4a|mp3)';
const ATTR_KEYS = ['src', 'data-src', 'data-lazy-src', 'data-video', 'data-video-src', 'data-mp4', 'data-url', 'data-file', 'data-hd', 'data-sd', 'data-stream', 'data-source', 'data-hls'];
const IMAGE_EXT_RX = /\.(?:jpe?g|png|gif|webp|avif|svg|ico|bmp|vtt|srt|css|js|json|woff2?)(?:$|[?#])/i;
const AD_HOST_RX = /(?:doubleclick|googlesyndication|googletagmanager|google-analytics|googleadservices|adservice|facebook\.com\/(?:plugins|tr)|recaptcha|disqus|addthis|sharethis|adsterra|popads|exoclick|juicyads|trafficjunky)/i;
const AD_PATH_RX = /(?:\/ads?\/|[/_.-](?:preroll|midroll|vast|vpaid|advert|adserver)[/_.-]|\bbanner\b)/i;
const PREVIEW_PATH_RX = /(?:thumb|sprite|storyboard|preview|teaser|trailer-?clip|loading|placeholder)/i;
const EMBED_HOST_RX = /^https?:\/\/(?:www\.)?(?:youtube(?:-nocookie)?\.com\/embed\/|player\.vimeo\.com\/video\/|dailymotion\.com\/embed\/video\/|streamable\.com\/[eo]\/|fast\.wistia\.(?:net|com)\/embed\/|players\.brightcove\.net\/|rumble\.com\/embed\/|player\.twitch\.tv\/|vk\.com\/video_ext\.php|ok\.ru\/videoembed\/|odysee\.com\/\$\/embed\/)/i;
const PLAYERISH_RX = /(?:embed|player|video|stream|play|watch|iframe|cdn|media|vid)/i;

/* ------------------------------------------------------------------ small helpers */

function decodeEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_m, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name.toLowerCase()]);
}

function safeFromCodePoint(code) {
  try { return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''; } catch { return ''; }
}

/** Undo the JSON/JS escaping that hides URLs inside inline player configs. */
function unescapeScriptText(text) {
  return String(text || '')
    .replace(/\\u002f/gi, '/').replace(/\\u0026/gi, '&').replace(/\\u003d/gi, '=').replace(/\\u003a/gi, ':').replace(/\\u003f/gi, '?')
    .replace(/\\x26/gi, '&').replace(/\\x2f/gi, '/').replace(/\\x3d/gi, '=')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&');
}

function resolveUrl(value, base) {
  const raw = decodeEntities(String(value || '')).trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!raw || /^(?:blob|data|javascript|about|mailto|tel|file):/i.test(raw) || raw.startsWith('#')) return '';
  try {
    const parsed = new URL(raw, base || undefined);
    if (!/^https?:$/.test(parsed.protocol)) return '';
    parsed.hash = '';
    return parsed.href;
  } catch { return ''; }
}

function pathOf(url) {
  try { return new URL(url).pathname; } catch { return String(url || '').split(/[?#]/)[0]; }
}

/** 'file' | 'hls' | 'dash' | '' for a URL and optional MIME type. */
function classifyMedia(url, type) {
  const mime = String(type || '').toLowerCase().split(';')[0].trim();
  if (/mpegurl|x-mpegurl/.test(mime)) return 'hls';
  if (/dash\+xml/.test(mime)) return 'dash';
  if (/^(?:video|audio)\//.test(mime)) return 'file';
  const path = pathOf(url).toLowerCase();
  if (/\.m3u8$/.test(path)) return 'hls';
  if (/\.mpd$/.test(path)) return 'dash';
  const ext = (path.match(/\.([a-z0-9]{2,5})$/) || [])[1];
  if (ext && FILE_EXT.includes(ext)) return 'file';
  return '';
}

function heightHint(...texts) {
  for (const text of texts) {
    const value = String(text || '');
    const p = value.match(/(?:^|[^0-9])(2160|1440|1080|720|576|480|360|240|144)\s*p?(?:[^0-9]|$)/i);
    if (p) return Number(p[1]);
    if (/(?:^|[^a-z])(?:4k|uhd)(?:[^a-z]|$)/i.test(value)) return 2160;
    if (/(?:^|[^a-z])(?:fhd)(?:[^a-z]|$)/i.test(value)) return 1080;
    if (/(?:^|[^a-z])(?:hd)(?:[^a-z]|$)/i.test(value)) return 720;
  }
  return 0;
}

const SOURCE_WEIGHT = {
  'dom-currentSrc': 100, 'video-source': 96, 'network-media': 92, 'video-src': 94, 'dom-source': 95,
  'og:video': 72, 'jsonld': 66, 'script': 52, 'page-text': 40, 'link': 34, 'anchor': 30, 'embed': 20
};

function scoreCandidate(candidate) {
  let score = SOURCE_WEIGHT[candidate.source] ?? 30;
  if (/^video\/mp4$/i.test(candidate.type || '')) score += 4;
  if (candidate.kind === 'file') score += 6;
  if (candidate.kind === 'hls') score += 2;
  if (candidate.kind === 'dash') score -= 4;
  if (candidate.kind === 'embed') score = 20;
  score += Math.min(15, (candidate.height || 0) / 144);
  if (AD_PATH_RX.test(pathOf(candidate.url)) || AD_HOST_RX.test(candidate.url)) score -= 45;
  if (PREVIEW_PATH_RX.test(pathOf(candidate.url))) score -= 25;
  if (/\.(?:mp3|m4a|aac|opus|wav|flac)$/i.test(pathOf(candidate.url)) && !/^video\//i.test(candidate.type || '')) score -= 20;
  if (candidate.size > 0 && candidate.size < 150 * 1024 && candidate.kind === 'file') score -= 30;
  if (candidate.validated) score += 25;
  return score;
}

function makeCandidate(fields) {
  const candidate = {
    url: fields.url, kind: fields.kind, type: fields.type || '', source: fields.source,
    from: fields.from || '', referer: fields.referer || '', label: fields.label || '',
    height: fields.height || heightHint(fields.label, pathOf(fields.url)), size: fields.size || 0
  };
  candidate.score = scoreCandidate(candidate);
  return candidate;
}

/** Merge duplicates (same URL), keeping the strongest evidence for each, best first. */
function mergeCandidates(...lists) {
  const byUrl = new Map();
  for (const list of lists) {
    for (const candidate of list || []) {
      if (!candidate || !candidate.url) continue;
      const key = candidate.url;
      const existing = byUrl.get(key);
      if (!existing) { byUrl.set(key, { ...candidate }); continue; }
      const stronger = candidate.score > existing.score ? candidate : existing;
      const weaker = stronger === candidate ? existing : candidate;
      byUrl.set(key, {
        ...stronger, type: stronger.type || weaker.type, referer: stronger.referer || weaker.referer,
        label: stronger.label || weaker.label, height: stronger.height || weaker.height, size: stronger.size || weaker.size,
        validated: stronger.validated || weaker.validated
      });
    }
  }
  return [...byUrl.values()].map(c => ({ ...c, score: scoreCandidate(c) })).sort((a, b) => b.score - a.score);
}

/* ------------------------------------------------------------------ HTML parsing */

function parseAttributes(text) {
  const attrs = {};
  const rx = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = rx.exec(text))) {
    const name = match[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function readBase(html, pageUrl) {
  const base = /<base\b([^>]*)>/i.exec(html);
  if (base) {
    const href = parseAttributes(base[1]).href;
    const resolved = href && resolveUrl(href, pageUrl);
    if (resolved) return resolved;
  }
  return pageUrl;
}

/**
 * Extract media candidates, nested player frames and a title from HTML.
 * `html` may be the raw response body or a rendered `document.documentElement.outerHTML`.
 */
function extractFromHtml(html, pageUrl, options = {}) {
  const text = String(html || '');
  const base = readBase(text, pageUrl);
  const found = [];
  const iframes = [];
  const documentUrl = options.documentUrl || pageUrl;

  const add = (rawUrl, fields) => {
    const url = resolveUrl(rawUrl, base);
    if (!url || IMAGE_EXT_RX.test(pathOf(url))) return;
    const kind = classifyMedia(url, fields.type);
    if (!kind) return;
    found.push(makeCandidate({ ...fields, url, kind, from: documentUrl }));
  };

  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '');
  const tagRx = /<(video|audio|source|iframe|frame|embed|meta|a|link)\b([^>]*)>/gi;
  let match;
  while ((match = tagRx.exec(withoutComments))) {
    const tag = match[1].toLowerCase();
    const attrs = parseAttributes(match[2]);
    if (tag === 'video' || tag === 'audio' || tag === 'source') {
      const type = attrs.type || '';
      if (tag === 'source' && /^image\//i.test(type)) continue;
      const label = [attrs.label, attrs.title, attrs.res, attrs.size, attrs['data-res'], attrs['data-quality']].filter(Boolean).join(' ');
      for (const key of ATTR_KEYS) {
        if (attrs[key]) add(attrs[key], { type, source: tag === 'source' ? 'video-source' : 'video-src', label });
      }
    } else if (tag === 'iframe' || tag === 'frame' || tag === 'embed') {
      const target = resolveUrl(attrs.src || attrs['data-src'] || attrs['data-lazy-src'], base);
      if (!target || AD_HOST_RX.test(target) || /^about:/i.test(target)) continue;
      iframes.push({ url: target, label: [attrs.id, attrs.class, attrs.title, attrs.name].filter(Boolean).join(' ') });
      if (EMBED_HOST_RX.test(target)) found.push(makeCandidate({ url: target, kind: 'embed', source: 'embed', from: documentUrl }));
    } else if (tag === 'meta') {
      const name = String(attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
      if (/^(?:og:video(?::(?:secure_)?url)?|twitter:player:stream|og:audio|contenturl)$/.test(name)) {
        add(attrs.content, { type: attrs['og:video:type'] || '', source: 'og:video' });
      }
    } else if (tag === 'link') {
      const rel = String(attrs.rel || '').toLowerCase();
      if (/^video\//i.test(attrs.type || '') || rel === 'video_src') add(attrs.href, { type: attrs.type, source: 'link' });
    } else if (tag === 'a') {
      if (attrs.href && new RegExp(`\\.${MEDIA_EXT_RX}(?:$|[?#])`, 'i').test(attrs.href)) add(attrs.href, { source: 'anchor', label: attrs.title || '' });
    }
  }

  // Structured data (schema.org VideoObject)
  const ldRx = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  while ((match = ldRx.exec(withoutComments))) {
    for (const url of collectJsonUrls(match[1], ['contentUrl', 'embedUrl', 'contenturl', 'embedurl'])) {
      const resolved = resolveUrl(url, base);
      if (resolved && EMBED_HOST_RX.test(resolved)) found.push(makeCandidate({ url: resolved, kind: 'embed', source: 'embed', from: documentUrl }));
      else add(url, { source: 'jsonld' });
    }
  }

  // Player configs: sources:[{file:"..."}], "src":"...", HLS manifests, escaped URLs, atob("...") payloads
  const prepared = unescapeScriptText(withoutComments) + '\n' + decodeBase64Payloads(withoutComments);
  const quotedRx = new RegExp(`["'\`]((?:https?:)?(?:\\/\\/)?[^"'\`\\s<>\\\\]*?\\.${MEDIA_EXT_RX}(?:\\?[^"'\`\\s<>\\\\]*)?)["'\`]`, 'gi');
  while ((match = quotedRx.exec(prepared))) {
    const value = match[1];
    if (value.length > 2000 || /[{}();]/.test(value)) continue;
    const before = prepared.slice(Math.max(0, match.index - 80), match.index);
    const label = (before.match(/(?:label|quality|res|size|height|title)["']?\s*[:=]\s*["']?([^"',}\s]{1,12})["']?\s*,?\s*(?:["']?(?:file|src|url|link)["']?\s*:\s*)?$/i) || [])[1] || '';
    add(value, { source: 'script', label });
  }
  const bareRx = new RegExp(`https?:\\/\\/[^\\s"'\`<>()\\\\\\]\\[{}|^]+?\\.${MEDIA_EXT_RX}(?:\\?[^\\s"'\`<>()\\\\\\]\\[{}|^]*)?`, 'gi');
  while ((match = bareRx.exec(prepared))) add(match[0], { source: 'page-text' });

  const title = decodeEntities(((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(text) || [])[1] || '')).replace(/\s+/g, ' ').trim();
  const ogTitle = (() => {
    const rx = /<meta\b([^>]*)>/gi; let m;
    while ((m = rx.exec(text))) { const a = parseAttributes(m[1]); if (String(a.property || a.name).toLowerCase() === 'og:title' && a.content) return a.content.trim(); }
    return '';
  })();
  return { title: ogTitle || title, candidates: mergeCandidates(found), iframes: dedupeBy(iframes, f => f.url) };
}

function collectJsonUrls(jsonText, keys) {
  const wanted = new Set(keys.map(k => k.toLowerCase()));
  const out = [];
  const walk = value => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (wanted.has(k.toLowerCase()) && typeof v === 'string') out.push(v);
        else walk(v);
      }
    }
  };
  try { walk(JSON.parse(decodeEntities(jsonText).trim())); } catch {
    for (const key of keys) {
      const rx = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'gi'); let m;
      while ((m = rx.exec(jsonText))) out.push(m[1]);
    }
  }
  return out;
}

function decodeBase64Payloads(text) {
  const out = [];
  const rx = /atob\(\s*["']([A-Za-z0-9+/=]{16,4000})["']\s*\)/g;
  let match;
  while ((match = rx.exec(text))) {
    try {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      if (/^[\x20-\x7e]+$/.test(decoded) && /https?:\/\//.test(decoded)) out.push(`"${decoded.replace(/"/g, '')}"`);
    } catch { /* not base64 */ }
  }
  return out.join('\n');
}

function dedupeBy(list, keyFn) {
  const seen = new Set();
  return list.filter(item => { const k = keyFn(item); if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * Candidates reported by the live page: <video> elements (with currentSrc), <source> tags and the rendered HTML.
 * `snapshot` = { href, title, html, videos:[{currentSrc, src, type, sources:[{src,type,label}]}] }
 */
function extractFromSnapshot(snapshot) {
  const documentUrl = snapshot.href || '';
  const parsed = extractFromHtml(snapshot.html || '', documentUrl, { documentUrl });
  const live = [];
  for (const video of snapshot.videos || []) {
    const push = (raw, source, type, label) => {
      const url = resolveUrl(raw, documentUrl);
      const kind = url && classifyMedia(url, type);
      if (kind) live.push(makeCandidate({ url, kind, type, source, from: documentUrl, label, height: heightHint(label) || (video.videoHeight || 0) }));
    };
    if (video.currentSrc) push(video.currentSrc, 'dom-currentSrc', video.type || '');
    if (video.src) push(video.src, 'dom-currentSrc', video.type || '');
    for (const source of video.sources || []) push(source.src, 'dom-source', source.type || '', source.label || '');
  }
  return { title: snapshot.title || parsed.title, candidates: mergeCandidates(live, parsed.candidates), iframes: parsed.iframes };
}

/* ------------------------------------------------------------------ HTTP stage */

function browserHeaders(extra = {}) {
  return {
    'User-Agent': BROWSER_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    ...extra
  };
}

async function readLimitedText(response, limit) {
  if (!response.body || typeof response.body.getReader !== 'function') return (await response.text()).slice(0, limit);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (bytes >= limit) { try { await reader.cancel(); } catch { /* ignore */ } break; }
  }
  return text;
}

async function fetchPage(url, { fetchImpl, referer, signal, timeoutMs = 15000, maxBytes = 3 * 1024 * 1024 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetchImpl(url, {
      headers: browserHeaders(referer ? { Referer: referer } : {}),
      redirect: 'follow', signal: controller.signal, credentials: 'include'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = String(response.headers.get('content-type') || '').toLowerCase();
    const finalUrl = response.url || url;
    if (/^(?:video|audio)\//.test(type) || /mpegurl|dash\+xml/.test(type)) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      return { url: finalUrl, type, direct: true, html: '' };
    }
    if (type && !/html|xml|json|text|javascript/.test(type)) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      throw new Error(`not a web page (${type})`);
    }
    return { url: finalUrl, type, html: await readLimitedText(response, maxBytes) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Stage 1: read the page and the player frames nested inside it. */
async function sniffStatic(pageUrl, { fetchImpl, signal, log = () => {}, maxFrames = 8, maxDepth = 3 } = {}) {
  const visited = new Set();
  const queue = [{ url: pageUrl, referer: '', depth: 0 }];
  const all = [];
  let title = '';
  let fetched = 0;
  let failure = '';
  while (queue.length && fetched < maxFrames + 1) {
    if (signal?.aborted) break;
    const { url, referer, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    let page;
    try { page = await fetchPage(url, { fetchImpl, referer, signal }); fetched++; } catch (error) {
      if (depth === 0) failure = error.message;
      log(`Could not read ${depth ? 'frame' : 'page'} ${shorten(url)}: ${error.message}`);
      continue;
    }
    if (page.direct) {
      all.push(makeCandidate({ url: page.url, kind: classifyMedia(page.url, page.type) || 'file', type: page.type, source: 'video-src', from: referer || page.url, referer }));
      continue;
    }
    const parsed = extractFromHtml(page.html, page.url, { documentUrl: page.url });
    if (!title && depth === 0) title = parsed.title;
    for (const candidate of parsed.candidates) all.push({ ...candidate, referer: candidate.kind === 'embed' ? '' : page.url });
    log(`Read ${depth ? 'frame' : 'page'} ${shorten(page.url)}: ${parsed.candidates.length} media reference${parsed.candidates.length === 1 ? '' : 's'}, ${parsed.iframes.length} frame${parsed.iframes.length === 1 ? '' : 's'}`);
    if (depth < maxDepth) {
      const frames = parsed.iframes.slice().sort((a, b) => Number(PLAYERISH_RX.test(b.url + ' ' + b.label)) - Number(PLAYERISH_RX.test(a.url + ' ' + a.label)));
      for (const frame of frames) if (!visited.has(frame.url)) queue.push({ url: frame.url, referer: page.url, depth: depth + 1 });
    }
  }
  return { title, candidates: mergeCandidates(all), failure };
}

/* ------------------------------------------------------------------ validation */

const MEDIA_TYPE_RX = /^(?:video|audio)\/|mpegurl|dash\+xml|octet-stream|mp4|x-matroska|x-flv/i;

function originOf(url) { try { return new URL(url).origin + '/'; } catch { return ''; } }

function refererOptions(candidate, pageUrl) {
  return [...new Set([candidate.referer, candidate.from, pageUrl, originOf(pageUrl), originOf(candidate.from), ''])].filter(v => v !== undefined);
}

/** Check that a URL really serves media for the given Referer. Never downloads more than the first chunk. */
async function probeUrl(url, referer, { fetchImpl, signal, timeoutMs = 9000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const headers = { 'User-Agent': BROWSER_UA, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9', Range: 'bytes=0-2047' };
    if (referer) headers.Referer = referer;
    const response = await fetchImpl(url, { headers, redirect: 'follow', signal: controller.signal, credentials: 'include' });
    const type = String(response.headers.get('content-type') || '').toLowerCase();
    const range = String(response.headers.get('content-range') || '');
    const length = Number(response.headers.get('content-length')) || 0;
    const total = Number((range.match(/\/(\d+)$/) || [])[1]) || (response.status === 200 ? length : 0);
    let head = '';
    if (response.ok && response.body?.getReader) {
      const reader = response.body.getReader();
      const first = await reader.read();
      try { await reader.cancel(); } catch { /* ignore */ }
      if (first.value) head = Buffer.from(first.value).subarray(0, 2048).toString('latin1');
    }
    try { await response.body?.cancel(); } catch { /* ignore */ }
    if (!response.ok) return { ok: false, status: response.status, reason: `HTTP ${response.status}` };
    if (/^text\/html|json/.test(type) || /^\s*<(?:!doctype|html)/i.test(head)) return { ok: false, status: response.status, reason: 'returned a web page instead of media' };
    if (head.startsWith('#EXTM3U') || /mpegurl/.test(type)) return { ok: true, type: type || 'application/vnd.apple.mpegurl', size: 0 };
    if (/<MPD\b/.test(head) || /dash\+xml/.test(type)) return { ok: true, type, size: 0 };
    if (type && !MEDIA_TYPE_RX.test(type)) return { ok: false, status: response.status, reason: `unexpected content type ${type}` };
    return { ok: true, type, size: total };
  } catch (error) {
    return { ok: false, status: 0, reason: error.name === 'AbortError' ? 'timed out' : error.message };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Probe the best candidates (each with the Referers a browser could have sent) and return them with the working Referer. */
async function validateCandidates(candidates, pageUrl, { fetchImpl, signal, log = () => {}, maxCandidates = 6 }) {
  const checked = [];
  const media = candidates.filter(c => c.kind !== 'embed').slice(0, maxCandidates);
  for (const candidate of media) {
    if (signal?.aborted) break;
    let lastReason = '';
    let ok = null;
    for (const referer of refererOptions(candidate, pageUrl)) {
      const result = await probeUrl(candidate.url, referer, { fetchImpl, signal });
      if (result.ok) { ok = { ...result, referer }; break; }
      lastReason = result.reason;
      if (result.status === 404 || result.status === 410) break; // another Referer will not help
    }
    if (ok) {
      const validated = { ...candidate, validated: true, referer: ok.referer, type: candidate.type || ok.type, size: ok.size || candidate.size };
      validated.score = scoreCandidate(validated);
      checked.push(validated);
      log(`Verified ${candidate.kind.toUpperCase()} source (${candidate.source}${candidate.type ? `, ${candidate.type}` : ''}): ${shorten(candidate.url)}`);
    } else log(`Rejected ${shorten(candidate.url)}: ${lastReason || 'not reachable'}`);
  }
  return checked.sort((a, b) => b.score - a.score);
}

/* ------------------------------------------------------------------ orchestration */

/**
 * Find the best downloadable media for a page.
 * @param {object} options
 * @param {string} options.url             the page the person pasted
 * @param {Function} options.fetchImpl     fetch-compatible function
 * @param {Function} [options.renderer]    async (url, {signal, referer}) => { title, snapshots:[...], network:[...] }
 * @param {boolean} [options.verify=true]  probe candidates before choosing; false accepts the best-ranked one (used when
 *                                         requests cannot carry a Referer, so the downloader does the checking)
 * @returns {Promise<{ok:boolean, title:string, selected?:object, candidates:object[], stage?:string, reason?:string}>}
 */
async function resolveMedia({ url, fetchImpl = globalThis.fetch, renderer = null, signal, log = () => {}, verify = true }) {
  if (typeof fetchImpl !== 'function') return { ok: false, title: '', candidates: [], reason: 'No network access is available for page inspection.' };
  const summary = { title: '', all: [] };

  const check = async candidates => {
    if (verify) return validateCandidates(candidates, url, { fetchImpl, signal, log });
    const media = candidates.filter(c => c.kind !== 'embed').slice(0, 1).map(c => ({ ...c, referer: c.referer || c.from || url }));
    if (media.length) log('Verification skipped (a proxy is configured); the downloader will check this source.');
    return media;
  };

  const finish = (stage, validated) => {
    const media = validated.filter(c => c.kind !== 'embed');
    if (media.length) return { ok: true, stage, title: summary.title, selected: media[0], candidates: mergeCandidates(media, summary.all), pageUrl: url };
    return null;
  };
  const embedFallback = () => {
    const embed = summary.all.find(c => c.kind === 'embed');
    return embed ? { ok: true, stage: 'embed', title: summary.title, selected: { ...embed, referer: url }, candidates: summary.all, pageUrl: url } : null;
  };

  log('Inspecting the page for video sources…');
  const staticResult = await sniffStatic(url, { fetchImpl, signal, log });
  summary.title = staticResult.title;
  summary.all = staticResult.candidates;
  if (signal?.aborted) return { ok: false, title: summary.title, candidates: summary.all, reason: 'Canceled.' };
  let validated = await check(staticResult.candidates);
  let done = finish('static', validated);
  if (done) return done;

  if (renderer && !signal?.aborted) {
    log('Nothing usable in the page source. Loading the page like a browser to read the live player…');
    try {
      const rendered = await renderer(url, { signal, log });
      summary.title = summary.title || rendered.title || '';
      const fromDom = (rendered.snapshots || []).map(extractFromSnapshot);
      const fromNetwork = (rendered.network || []).map(entry => makeCandidate({
        url: entry.url, kind: classifyMedia(entry.url, entry.type) || (entry.mediaRequest ? 'file' : ''), type: entry.type || '',
        source: 'network-media', from: entry.frameUrl || url, referer: entry.referer || ''
      })).filter(c => c.kind);
      summary.title = summary.title || fromDom.map(r => r.title).find(Boolean) || '';
      summary.all = mergeCandidates(summary.all, ...fromDom.map(r => r.candidates), fromNetwork);
      // Frames that only the live page revealed are read statically too.
      const known = new Set([url]);
      const extraFrames = fromDom.flatMap(r => r.iframes).filter(f => !known.has(f.url)).slice(0, 4);
      for (const frame of extraFrames) {
        if (signal?.aborted) break;
        const nested = await sniffStatic(frame.url, { fetchImpl, signal, log, maxFrames: 3, maxDepth: 1 });
        summary.all = mergeCandidates(summary.all, nested.candidates);
      }
      log(`The live page revealed ${summary.all.filter(c => c.kind !== 'embed').length} media reference${summary.all.length === 1 ? '' : 's'}.`);
      validated = await check(summary.all);
      done = finish('rendered', validated);
      if (done) return done;
    } catch (error) {
      log(`Live page inspection failed: ${error.message}`);
    }
  }
  const embed = embedFallback();
  if (embed) return embed;
  const tried = summary.all.filter(c => c.kind !== 'embed').length;
  return {
    ok: false, title: summary.title, candidates: summary.all,
    reason: tried
      ? `Found ${tried} possible video link${tried === 1 ? '' : 's'} but none could be opened (they may need you to be signed in, or expired).`
      : 'No video file (video/mp4, HLS, DASH) was found in the page. It may need you to sign in, press play first, or use a protected stream.'
  };
}

/* ------------------------------------------------------------------ misc */

function shorten(url, max = 110) {
  const value = String(url || '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Parse a Netscape cookies.txt into objects usable by Electron's cookies.set (and tests). */
function parseNetscapeCookies(text) {
  const cookies = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) { httpOnly = true; line = line.slice('#HttpOnly_'.length); } else if (line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const [domain, , cookiePath, secure, expires, name, ...valueParts] = parts;
    const host = domain.replace(/^\./, '');
    if (!host || !name) continue;
    const expiry = Number(expires);
    cookies.push({
      url: `${secure.toUpperCase() === 'TRUE' ? 'https' : 'http'}://${host}${cookiePath || '/'}`,
      domain: domain, path: cookiePath || '/', name, value: valueParts.join('\t'),
      secure: secure.toUpperCase() === 'TRUE', httpOnly,
      ...(Number.isFinite(expiry) && expiry > 0 ? { expirationDate: expiry } : {})
    });
  }
  return cookies;
}

/** Cookie header value for `url` from parsed Netscape cookies (domain, path, secure and expiry rules applied). */
function cookieHeaderFor(url, cookies) {
  let target;
  try { target = new URL(url); } catch { return ''; }
  const now = Date.now() / 1000;
  const pairs = [];
  for (const cookie of cookies || []) {
    const domain = String(cookie.domain || '').toLowerCase();
    const host = target.hostname.toLowerCase();
    const hostOnly = !domain.startsWith('.');
    const bare = domain.replace(/^\./, '');
    const domainOk = hostOnly ? host === bare : (host === bare || host.endsWith(`.${bare}`));
    if (!domainOk) continue;
    if (cookie.secure && target.protocol !== 'https:') continue;
    if (cookie.expirationDate && cookie.expirationDate < now) continue;
    const cookiePath = cookie.path || '/';
    if (!(target.pathname === cookiePath || target.pathname.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`))) continue;
    pairs.push(`${cookie.name}=${cookie.value}`);
  }
  return pairs.join('; ');
}

/** Wrap a fetch so every request carries the person's cookies for that URL. */
function withCookies(fetchImpl, cookies) {
  if (!cookies || !cookies.length) return fetchImpl;
  return (url, init = {}) => {
    const header = cookieHeaderFor(url, cookies);
    return fetchImpl(url, header ? { ...init, headers: { ...(init.headers || {}), Cookie: header } } : init);
  };
}

/** True when a pasted link already points straight at a media file. */
function isDirectMediaUrl(url) {
  return Boolean(classifyMedia(url, ''));
}

module.exports = {
  BROWSER_UA, decodeEntities, unescapeScriptText, resolveUrl, classifyMedia, heightHint, scoreCandidate, makeCandidate,
  mergeCandidates, extractFromHtml, extractFromSnapshot, sniffStatic, probeUrl, validateCandidates, resolveMedia,
  parseNetscapeCookies, cookieHeaderFor, withCookies, isDirectMediaUrl, shorten, EMBED_HOST_RX
};
