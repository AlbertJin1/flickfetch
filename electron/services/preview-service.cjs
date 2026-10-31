'use strict';
/**
 * In-app audio preview.
 *
 * The renderer never talks to YouTube. It asks the main process to `prepare` a preview for a YouTube link; this
 * service uses the already-installed yt-dlp to resolve a direct, audio-only HTTPS stream, caches it until it
 * expires, and then serves it to a plain <audio> element through the privileged `ffpreview://` protocol:
 *
 *     ffpreview://track/<11-char video id>
 *
 * Serving through our own protocol (instead of handing the googlevideo URL to the page) gives us:
 *   - Range / seek support, with open-ended requests answered in small chunks so abandoning a preview is cheap;
 *   - the headers yt-dlp says the stream needs, without exposing them to the page or loosening the CSP;
 *   - transparent recovery when a cached stream URL has expired (403/410 -> re-resolve once -> retry);
 *   - a strict allow-list: only YouTube video ids go in and only googlevideo/youtube hosts are ever contacted.
 */
const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const SCHEME = 'ffpreview';
const ID_PATTERN = /^[\w-]{11}$/;
/** Direct HTTPS audio only. Never HLS/DASH manifests, which an <audio> element cannot play. */
const AUDIO_FORMAT = 'ba[protocol=https][ext=m4a]/ba[protocol=https]/b[protocol=https]';
const CHUNK_BYTES = 2 * 1024 * 1024;
const RESOLVE_TIMEOUT_MS = 45000;
const DEFAULT_TTL_MS = 20 * 60 * 1000;
const MAX_TTL_MS = 2 * 60 * 60 * 1000;
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const REFRESH_STATUSES = new Set([401, 403, 404, 410]);
/** Fallback download: whatever yt-dlp can fetch the way the normal downloader does, preferring AAC/Opus containers Chromium plays. */
const FILE_FORMAT = 'ba[ext=m4a]/ba[ext=webm]/ba/b';
const DOWNLOAD_TIMEOUT_MS = 180000;
const MAX_CACHED_FILES = 12;
const DIRECT_FAILURES_BEFORE_SKIP = 2;
/** A direct stream that answered a probe is trusted for this long before it is probed again. */
const VERIFIED_TTL_MS = 3 * 60 * 1000;
/** After repeated direct failures we skip the direct stream, but only for a while: the cause is often temporary. */
const DIRECT_SUSPEND_MS = 10 * 60 * 1000;
const PROBE_RANGE = 'bytes=0-1';
/** Errors that retrying cannot fix (or would only make slower). */
const PERMANENT_ERROR = /sign-in|can’t be played|not installed|took too long|Updating yt-dlp/i;
const AUDIO_MIME = { m4a: 'audio/mp4', mp4: 'audio/mp4', webm: 'audio/webm', opus: 'audio/ogg', ogg: 'audio/ogg', mp3: 'audio/mpeg', aac: 'audio/aac', wav: 'audio/wav' };
const FORWARD_HEADERS = ['user-agent', 'accept', 'accept-language', 'referer', 'origin'];

const agent = new https.Agent({ keepAlive: true, maxSockets: 6 });

/** Extract the 11-character video id from a YouTube / YouTube Music / youtu.be URL (or a bare id). */
function parseVideoId(input) {
  const value = String(input || '').trim();
  if (ID_PATTERN.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1];
  else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) id = parts[1];
  }
  return id && ID_PATTERN.test(id) ? id : null;
}

const watchUrl = id => `https://www.youtube.com/watch?v=${id}`;

function isAllowedUpstream(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /(^|\.)(googlevideo|youtube)\.com$/i.test(url.hostname);
  } catch { return false; }
}

function expiryOf(value) {
  try {
    const seconds = Number(new URL(value).searchParams.get('expire'));
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  } catch { return 0; }
}

function pickHeaders(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (FORWARD_HEADERS.includes(key.toLowerCase()) && typeof value === 'string') out[key] = value;
  }
  return out;
}

/** Turn yt-dlp's stderr into one short sentence a person can act on. */
function friendlyError(stderr) {
  const text = String(stderr || '');
  const line = text.split(/\r?\n/).map(entry => entry.trim()).filter(entry => /^ERROR:/i.test(entry)).pop() || text.trim().split(/\r?\n/).pop() || '';
  const message = line.replace(/^ERROR:\s*(\[[^\]]+\]\s*[\w-]*:\s*)?/i, '').trim();
  if (/sign in|confirm you.?re not a bot|cookies/i.test(message)) return 'YouTube is asking for a sign-in. Choose a browser or cookies file in Settings, then try again.';
  if (/requested format is not available/i.test(message)) return 'YouTube did not offer a playable audio stream for this video. Updating yt-dlp in Settings may fix it.';
  if (/private video|video unavailable|removed|not available|age[- ]restricted/i.test(message)) return `YouTube says this video can’t be played (${message.slice(0, 120)}).`;
  return message ? `Couldn’t load the preview: ${message.slice(0, 160)}` : 'Couldn’t load the preview. Check your connection and try again.';
}

/** Parse a single `bytes=a-b` range. Returns null (no range), or { start, end|null } / { suffix } / { invalid: true }. */
function parseRange(header) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(header).trim());
  if (!match || (match[1] === '' && match[2] === '')) return { invalid: true };
  if (match[1] === '') return { suffix: Number(match[2]) };
  const start = Number(match[1]);
  const end = match[2] === '' ? null : Number(match[2]);
  if (end !== null && end < start) return { invalid: true };
  return { start, end };
}

/** Open the upstream stream with node's https client, following a few validated redirects. */
function streamUpstream({ url, headers, rangeHeader, allow, signal, redirects = 3 }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Object.assign(new Error('Preview request canceled.'), { name: 'AbortError' })); return; }
    let target;
    try { target = new URL(url); } catch { reject(new Error('The preview stream address is invalid.')); return; }
    if (!allow(target.href)) { reject(new Error('Refusing to open an unexpected stream address.')); return; }
    const transport = target.protocol === 'http:' ? http : https;
    const request = transport.request(target, {
      method: 'GET',
      agent: target.protocol === 'https:' ? agent : undefined,
      headers: { ...headers, ...(rangeHeader ? { Range: rangeHeader } : {}), 'Accept-Encoding': 'identity' }
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirects <= 0) { reject(new Error('The preview stream redirected too many times.')); return; }
        resolve(streamUpstream({ url: new URL(response.headers.location, target).href, headers, rangeHeader, allow, signal, redirects: redirects - 1 }));
        return;
      }
      response.on('error', () => { /* surfaced through the web stream */ });
      resolve({ status: response.statusCode, headers: response.headers, body: response });
    });
    const onAbort = () => request.destroy(Object.assign(new Error('Preview request canceled.'), { name: 'AbortError' }));
    signal?.addEventListener('abort', onAbort, { once: true });
    request.setTimeout(20000, () => request.destroy(new Error('The preview stream timed out.')));
    request.on('error', reject);
    request.on('close', () => signal?.removeEventListener('abort', onAbort));
    request.end();
  });
}

const textResponse = (status, message) => new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

class PreviewService {
  constructor({ toolManager, getSettings, cacheDir, log, fetchUpstream = streamUpstream, allowUpstream = isAllowedUpstream, now = Date.now, maxEntries = 40 }) {
    this.toolManager = toolManager;
    this.getSettings = getSettings || (() => ({}));
    this.fetchUpstream = fetchUpstream;
    this.allowUpstream = allowUpstream;
    this.now = now;
    this.maxEntries = maxEntries;
    this.cache = new Map();
    this.pending = new Map();
    this.cacheDir = cacheDir || path.join(os.tmpdir(), 'flickfetch-preview');
    this.log = typeof log === 'function' ? log : () => {};
    this.files = new Map(); // video id -> downloaded file path (insertion order = least recently used first)
    this.downloads = new Map();
    this.verified = new Map(); // video id -> time the direct stream last answered a probe
    this.directFailures = 0;
    this.directFailedAt = 0;
    this.clearCacheDir();
  }

  /** Remove leftovers from earlier runs. Called on start; the cache never outlives the app. */
  clearCacheDir() {
    try { fs.rmSync(this.cacheDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  /**
   * Called by the renderer before it starts playing. Resolves the stream AND makes sure it will really play: the
   * direct stream is probed with a 2-byte request, and when YouTube refuses it the audio is downloaded right here.
   * All of the slow, failure-prone work therefore happens while the player shows "Finding the audio…" instead of
   * inside the <audio> element's own request, where a slow fallback used to make the first attempt give up.
   * `fresh` forgets what is cached for this video (used for the automatic retry).
   */
  async prepare(url, { fresh = false } = {}) {
    const id = parseVideoId(url);
    if (!id) throw new Error('Previews are only available for YouTube links.');
    if (fresh) this.invalidate(id);
    const info = await this.resolve(id);
    await this.#ensureReady(id);
    return { id, src: `${SCHEME}://track/${id}`, title: info.title, durationSeconds: info.durationSeconds };
  }

  /** Resolve only (no probe, no download). Cheap enough to run when the person hovers a Preview button. */
  async warm(url) {
    const id = parseVideoId(url);
    if (!id) return false;
    try { await this.resolve(id); return true; } catch { return false; }
  }

  /** True while the direct stream is known to be failing; expires so a temporary problem doesn't last all session. */
  #directSuspended() {
    if (this.directFailures < DIRECT_FAILURES_BEFORE_SKIP) return false;
    if (this.now() - this.directFailedAt > DIRECT_SUSPEND_MS) { this.directFailures = 0; return false; }
    return true;
  }

  invalidate(id) { this.cache.delete(id); this.verified.delete(id); }

  /** Guarantee that a request for this video will be answered quickly: a verified direct stream or a local file. */
  async #ensureReady(id) {
    if (this.files.has(id) || this.downloads.has(id)) { await this.#ensureFile(id); return; }
    const verifiedAt = this.verified.get(id);
    if (verifiedAt && this.now() - verifiedAt < VERIFIED_TTL_MS && this.cache.has(id)) return;
    if (!this.#directSuspended()) {
      if (await this.#probeDirect(id)) {
        this.verified.set(id, this.now());
        this.directFailures = 0;
        return;
      }
      this.directFailures += 1;
      this.directFailedAt = this.now();
      this.log('warn', `Preview ${id}: direct stream refused; downloading the audio before playback.`);
    }
    await this.#ensureFile(id);
  }

  /** Ask for two bytes of the direct stream, re-resolving once if the cached URL has gone stale. */
  async #probeDirect(id) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let info;
      try { info = await this.resolve(id, attempt > 0); } catch { return false; }
      try {
        const upstream = await this.fetchUpstream({ url: info.url, headers: info.headers, rangeHeader: PROBE_RANGE, allow: this.allowUpstream });
        upstream.body?.destroy?.();
        if (upstream.status === 200 || upstream.status === 206) return true;
        this.invalidate(id);
        if (!REFRESH_STATUSES.has(upstream.status)) return false;
      } catch { this.invalidate(id); }
    }
    return false;
  }

  resolve(id, force = false) {
    const hit = this.cache.get(id);
    if (!force && hit && hit.expires > this.now()) {
      this.cache.delete(id); this.cache.set(id, hit); // keep recently used entries last
      return Promise.resolve(hit.info);
    }
    if (this.pending.has(id)) return this.pending.get(id);
    const task = this.#resolveNow(id).finally(() => this.pending.delete(id));
    this.pending.set(id, task);
    return task;
  }

  async #resolveNow(id) {
    const tools = this.toolManager;
    tools.refresh();
    if (!tools.ytDlpPath) throw new Error('yt-dlp is not installed. Open Settings → Tools to install it.');
    const settings = this.getSettings() || {};
    const args = ['--ignore-config', '--encoding', 'utf-8', '--color', 'never', '--no-warnings', '--no-playlist', '--skip-download', '-f', AUDIO_FORMAT];
    if (String(settings.proxy || '').trim()) args.push('--proxy', settings.proxy.trim());
    if (String(settings.cookiesFile || '').trim()) args.push('--cookies', settings.cookiesFile.trim());
    else if (String(settings.cookiesBrowser || '').trim()) args.push('--cookies-from-browser', settings.cookiesBrowser.trim());
    args.push('--dump-single-json', watchUrl(id));

    let result;
    try { result = await tools.run(args, { timeout: RESOLVE_TIMEOUT_MS }); }
    catch (error) { throw new Error(/timeout/i.test(error.message) ? 'YouTube took too long to answer. Try again in a moment.' : error.message); }
    if (result.code !== 0 && !String(result.stdout).trim()) throw new Error(friendlyError(result.stderr));

    let data;
    try { data = JSON.parse(result.stdout); } catch { throw new Error('yt-dlp returned an unreadable response. Updating yt-dlp in Settings may fix this.'); }
    if (!data || typeof data.url !== 'string' || !this.allowUpstream(data.url)) {
      throw new Error('YouTube did not provide a playable audio stream for this video.');
    }
    const expiry = expiryOf(data.url);
    const lifetime = expiry ? Math.min(MAX_TTL_MS, expiry - this.now() - EXPIRY_MARGIN_MS) : DEFAULT_TTL_MS;
    const info = {
      id,
      url: data.url,
      headers: pickHeaders(data.http_headers),
      title: String(data.track || data.title || ''),
      artist: String(data.artist || data.uploader || data.channel || ''),
      durationSeconds: Number.isFinite(Number(data.duration)) ? Number(data.duration) : 0
    };
    if (lifetime > 0) {
      this.cache.set(id, { info, expires: this.now() + lifetime });
      while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
    }
    return info;
  }

  /** Handler for protocol.handle('ffpreview', …). */
  async handleRequest(request) {
    let id;
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'track') return textResponse(404, 'Unknown preview resource.');
      id = decodeURIComponent(url.pathname.replace(/^\//, ''));
    } catch { return textResponse(400, 'Bad preview address.'); }
    if (!ID_PATTERN.test(id)) return textResponse(400, 'Bad preview address.');
    if (request.method !== 'GET') return textResponse(405, 'Method not allowed.');

    const range = parseRange(request.headers.get('range'));
    if (range?.invalid) return textResponse(416, 'Unsupported range.');
    // Open-ended requests ("bytes=N-") are answered in one chunk and the media element simply asks for the next one,
    // so abandoning or seeking away from a preview never downloads the rest of the file. Explicit ranges pass through.
    let rangeHeader;
    if (range?.suffix !== undefined) rangeHeader = `bytes=-${range.suffix}`;
    else if (range) rangeHeader = range.end === null ? `bytes=${range.start}-${range.start + CHUNK_BYTES - 1}` : `bytes=${range.start}-${range.end}`;

    // 1) Fast path: proxy the direct stream. 2) Reliable path: let yt-dlp fetch the audio itself and serve the file.
    // Once a video has (or is getting) a local file, or the direct stream keeps failing, go straight to the file.
    const preferFile = this.files.has(id) || this.downloads.has(id) || this.#directSuspended();
    if (!preferFile) {
      const direct = await this.#serveDirect(id, rangeHeader, request.signal);
      if (direct) return direct;
    }
    return this.#serveFile(id, range, request.signal);
  }

  /** Returns a Response, or null when the direct stream could not be used. */
  async #serveDirect(id, rangeHeader, signal) {
    let reason = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let info;
      try { info = await this.resolve(id, attempt > 0); }
      catch (error) { reason = error.message; break; }
      try {
        const upstream = await this.fetchUpstream({ url: info.url, headers: info.headers, rangeHeader, allow: this.allowUpstream, signal });
        if (REFRESH_STATUSES.has(upstream.status)) {
          upstream.body?.destroy?.();
          reason = `HTTP ${upstream.status}`;
          this.invalidate(id);
          continue;
        }
        const response = this.#toResponse(upstream);
        if (response.status !== 502) { this.directFailures = 0; return response; }
        reason = `HTTP ${upstream.status}`;
        break;
      } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) return new Response(null, { status: 499 });
        reason = error.message;
        this.invalidate(id);
      }
    }
    this.directFailures += 1;
    this.directFailedAt = this.now();
    this.log('warn', `Preview ${id}: direct stream unavailable (${reason}); falling back to a yt-dlp download.`);
    return null;
  }

  async #serveFile(id, range, signal) {
    let file;
    try { file = await this.#ensureFile(id, signal); }
    catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) return new Response(null, { status: 499 });
      this.log('warn', `Preview ${id}: ${error.message}`);
      return textResponse(502, error.message);
    }
    let size;
    try { size = fs.statSync(file).size; } catch { this.files.delete(id); return textResponse(502, 'The preview file disappeared. Try again.'); }
    let start = 0; let end = size - 1; let status = 200;
    if (range) {
      if (range.suffix !== undefined) { start = Math.max(0, size - range.suffix); }
      else { start = range.start; if (range.end !== null) end = Math.min(range.end, size - 1); }
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      status = 206;
    }
    const headers = new Headers({
      'Content-Type': AUDIO_MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream',
      'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store'
    });
    if (status === 206) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => { /* the web stream reports it */ });
    return new Response(Readable.toWeb(stream), { status, headers });
  }

  /** Have yt-dlp fetch the audio into the cache (shared between concurrent requests for the same video). */
  #ensureFile(id) {
    const known = this.files.get(id);
    if (known && fs.existsSync(known)) { this.files.delete(id); this.files.set(id, known); return Promise.resolve(known); }
    this.files.delete(id);
    if (this.downloads.has(id)) return this.downloads.get(id);
    const task = this.#downloadWithRetry(id).finally(() => this.downloads.delete(id));
    this.downloads.set(id, task);
    return task;
  }

  /** yt-dlp occasionally fails once for transient reasons (a dropped connection, a throttled first request). Try once more. */
  async #downloadWithRetry(id) {
    try { return await this.#downloadNow(id); }
    catch (error) {
      if (PERMANENT_ERROR.test(error.message)) throw error;
      this.log('warn', `Preview ${id}: download failed (${error.message}); retrying once.`);
      return this.#downloadNow(id);
    }
  }

  async #downloadNow(id) {
    const tools = this.toolManager;
    tools.refresh();
    if (!tools.ytDlpPath) throw new Error('yt-dlp is not installed. Open Settings → Tools to install it.');
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const settings = this.getSettings() || {};
    const args = ['--ignore-config', '--encoding', 'utf-8', '--color', 'never', '--no-warnings', '--no-playlist', '--no-part', '--no-mtime', '--windows-filenames',
      '-f', FILE_FORMAT, '-P', this.cacheDir, '-o', `${id}.%(ext)s`, '--print', 'after_move:filepath'];
    if (String(settings.proxy || '').trim()) args.push('--proxy', settings.proxy.trim());
    if (String(settings.cookiesFile || '').trim()) args.push('--cookies', settings.cookiesFile.trim());
    else if (String(settings.cookiesBrowser || '').trim()) args.push('--cookies-from-browser', settings.cookiesBrowser.trim());
    if (tools.ffmpegPath) args.push('--ffmpeg-location', path.dirname(tools.ffmpegPath));
    args.push(watchUrl(id));

    let result;
    try { result = await tools.run(args, { timeout: DOWNLOAD_TIMEOUT_MS }); }
    catch (error) { throw new Error(/timeout/i.test(error.message) ? 'YouTube took too long to deliver the audio. Try again in a moment.' : error.message); }
    let file = String(result.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).pop();
    if (!file || !fs.existsSync(file)) {
      file = fs.readdirSync(this.cacheDir).filter(name => name.startsWith(`${id}.`) && !/\.(part|ytdl|temp)$/i.test(name)).map(name => path.join(this.cacheDir, name))[0];
    }
    if (!file || !fs.existsSync(file)) throw new Error(friendlyError(result.stderr));
    this.files.set(id, file);
    while (this.files.size > MAX_CACHED_FILES) {
      const [oldId, oldFile] = this.files.entries().next().value;
      this.files.delete(oldId);
      try { fs.rmSync(oldFile, { force: true }); } catch { /* best effort */ }
    }
    return file;
  }

  #toResponse(upstream) {
    const headers = new Headers({ 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' });
    for (const name of ['content-type', 'content-length', 'content-range']) {
      if (upstream.headers[name]) headers.set(name, String(upstream.headers[name]));
    }
    const status = upstream.status === 200 || upstream.status === 206 || upstream.status === 416 ? upstream.status : 502;
    if (status === 502) {
      upstream.body?.destroy?.();
      return textResponse(502, `YouTube refused the stream (HTTP ${upstream.status}).`);
    }
    if (status === 416) { upstream.body?.destroy?.(); return new Response(null, { status, headers }); }
    return new Response(Readable.toWeb(upstream.body), { status, headers });
  }
}

module.exports = { PreviewService, PROBE_RANGE, SCHEME, AUDIO_FORMAT, CHUNK_BYTES, parseVideoId, parseRange, friendlyError, isAllowedUpstream, streamUpstream };
