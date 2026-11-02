const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pageSniffer = require('./page-sniffer.cjs');

const PRESETS = [
  'Best quality (video + audio)', 'Up to 2160p (4K)', 'Up to 1440p', 'Up to 1080p',
  'Up to 720p', 'Up to 480p', 'Up to 360p', 'Audio only (extract)', 'Custom format string…'
];
const HEIGHTS = { 1: 2160, 2: 1440, 3: 1080, 4: 720, 5: 480, 6: 360 };
const TIME_RX = /^(\d+:){0,2}\d+(\.\d+)?$/;
const RATE_RX = /^\d+(\.\d+)?[KkMmGg]?$/;

function splitArgs(value) {
  const input = String(value || '');
  const result = [];
  let current = '';
  let quoted = false;
  for (const char of input) {
    if (char === '"') { quoted = !quoted; continue; }
    if (/\s/.test(char) && !quoted) {
      if (current) { result.push(current); current = ''; }
    } else current += char;
  }
  if (current) result.push(current);
  return result;
}

/** Make a literal title safe inside yt-dlp's `--parse-metadata FROM:TO` (colons separate, % starts a field). */
function escapeParseMetadata(value) {
  return String(value || '').replace(/\\/g, '/').replace(/%/g, '%%').replace(/:/g, '\\:').replace(/[\r\n]+/g, ' ').trim();
}

function cleanPageTitle(value) {
  return String(value || '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
}

/**
 * `resolved` is set when the page sniffer found the real media behind a page:
 * { url, referer, userAgent, title }. The same Referer/User-Agent the browser used are sent, which signed or
 * hot-link protected CDNs (e.g. `...embedplayer.net/...mp4?st=...&e=...`) require.
 */
function buildDownloadArgs(settings, binDir, resolved = null) {
  const s = settings;
  const args = ['--ignore-config', '--encoding', 'utf-8', '--color', 'never'];
  if (s.proxy?.trim()) args.push('--proxy', s.proxy.trim());
  if (s.cookiesFile?.trim()) args.push('--cookies', s.cookiesFile.trim());
  else if (s.cookiesBrowser?.trim()) args.push('--cookies-from-browser', s.cookiesBrowser.trim());
  if (s.ffmpegPath?.trim()) args.push('--ffmpeg-location', s.ffmpegPath.trim());

  args.push('--quiet', '--progress', '--newline', '--windows-filenames');
  args.push('--progress-template', 'download:@@P|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s');
  args.push('--progress-template', 'postprocess:@@PP|%(progress.status)s|%(progress.postprocessor)s');
  args.push('--print', 'before_dl:@@T|%(playlist_index)s|%(n_entries)s|%(title)s');
  args.push('--print', 'after_move:@@F|%(filepath)s');

  const template = s.template?.trim() || '%(title).150B.%(ext)s';
  const outputTemplate = s.playlist ? '%(playlist_title&{}/|)s%(playlist_index&{} - |)s' + template : template;
  args.push('-P', s.outputDir, '-o', outputTemplate, s.playlist ? '--yes-playlist' : '--no-playlist');

  const preset = Number(s.preset) || 0;
  let format = 'bv*+ba/b';
  if (HEIGHTS[preset]) format = `bv*[height<=?${HEIGHTS[preset]}]+ba/b[height<=?${HEIGHTS[preset]}]`;
  else if (preset === 7) format = 'ba/b';
  else if (preset === 8) format = (s.customFormat || '').trim();
  args.push('-f', format);

  if (preset === 7) {
    args.push('-x');
    if (s.audioFormat && s.audioFormat !== 'best') args.push('--audio-format', s.audioFormat);
    if (s.audioQuality) args.push('--audio-quality', String(s.audioQuality));
  } else {
    const container = (s.container || 'auto').toLowerCase();
    if (['mp4', 'mkv', 'webm'].includes(container)) {
      args.push('--merge-output-format', container);
      if (container !== 'webm') args.push('--remux-video', container);
    }
    if (container === 'mp4' && s.preferCompat) args.push('-S', 'vcodec:h264,res,acodec:m4a');
  }

  if (s.subs || s.autoSubs) {
    if (s.subs) args.push('--write-subs');
    if (s.autoSubs) args.push('--write-auto-subs');
    args.push('--sub-langs', (s.subLangs || 'en.*').trim());
    if (s.embedSubs && preset !== 7) args.push('--embed-subs');
    else args.push('--convert-subs', 'srt');
  }
  if (s.embedThumb) args.push('--embed-thumbnail');
  if (s.embedMeta) args.push('--embed-metadata');
  if (s.sponsor) args.push('--sponsorblock-remove', 'sponsor,selfpromo,interaction,intro,outro');
  if (s.restrict) args.push('--restrict-filenames');
  if (s.overwrite) args.push('--force-overwrites');
  if (s.infoJson) args.push('--write-info-json');
  if (s.description) args.push('--write-description');
  if (s.writeThumb) args.push('--write-thumbnail', '--convert-thumbnails', 'jpg');
  if (s.useArchive) {
    const appDataDir = path.dirname(binDir);
    const archive = path.join(appDataDir, 'archive.txt');
    args.push('--download-archive', archive);
  }
  const start = (s.sectionStart || '').trim();
  const end = (s.sectionEnd || '').trim();
  if ((start || end) && (!start || TIME_RX.test(start)) && (!end || TIME_RX.test(end))) {
    args.push('--download-sections', `*${start || '0'}-${end || 'inf'}`);
  }
  if (s.rateLimit?.trim() && RATE_RX.test(s.rateLimit.trim())) args.push('--limit-rate', s.rateLimit.trim());
  args.push('--concurrent-fragments', String(Math.max(1, Math.min(16, Number(s.fragments) || 4))));
  args.push('--retries', String(Math.max(0, Math.min(100, Number(s.retries) || 0))));
  args.push('--fragment-retries', String(Math.max(0, Math.min(100, Number(s.retries) || 0))));
  if (resolved) {
    if (resolved.referer) args.push('--referer', resolved.referer);
    args.push('--user-agent', resolved.userAgent || pageSniffer.BROWSER_UA);
    const title = cleanPageTitle(resolved.title);
    if (title) args.push('--parse-metadata', `${escapeParseMetadata(title)}:%(title)s`);
  }
  args.push(...splitArgs(s.extraArgs));
  return args;
}

function isAcceptedUrl(value) {
  const v = String(value || '').trim();
  return /^https?:\/\/\S+$/i.test(v) || /^ytsearch\d*:.+$/i.test(v) || /^ytsearchdate\d*:.+$/i.test(v);
}

function bytesText(value) {
  if (!Number.isFinite(value) || value < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = value; let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function friendlyHint(message, url) {
  const lower = String(message || '').toLowerCase();
  if (/facebook\.com|fb\.watch|fb\.com/i.test(url) && /login|cookie|private|unavailable|confirm/i.test(lower)) {
    return `${message} Facebook tip: confirm the post is available to your account and configure cookies from your own logged-in browser in Settings → Network & login.`;
  }
  if (/instagram\.com|instagr\.am/i.test(url) && /login|cookie|private|unavailable|challenge/i.test(lower)) {
    return `${message} Instagram tip: check the post in your own account, configure your own browser cookies in Settings → Network & login, and update yt-dlp.`;
  }
  return message;
}

class DownloadService {
  constructor({ toolManager, getSettings, emit, userDataPath, resolveMedia }) {
    this.tools = toolManager;
    this.getSettings = getSettings;
    this.emit = emit || (() => {});
    this.userDataPath = userDataPath;
    // (pageUrl, { signal, log }) => { ok, selected:{url,referer,kind,source}, title, stage, reason }
    this.resolveMedia = resolveMedia || ((url, options) => pageSniffer.resolveMedia({ url, ...options }));
    this.items = [];
    this.processes = new Map();
    this.running = false;
    this.pumping = false;
    this.nextNumber = 1;
    this.storePath = path.join(userDataPath, 'downloads.json');
    this.persistTimer = null;
    this.load();
  }

  load() {
    try {
      const stored = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      if (!Array.isArray(stored)) return;
      this.items = stored.slice(-250).map(item => ({
        ...item,
        status: ['Starting', 'Downloading', 'Processing'].includes(item.status) ? 'Failed' : item.status,
        errorText: ['Starting', 'Downloading', 'Processing'].includes(item.status) ? 'Download was interrupted when FlickFetch closed.' : item.errorText,
        speed: -1, eta: -1, logs: Array.isArray(item.logs) ? item.logs : []
      }));
      this.nextNumber = Math.max(0, ...this.items.map(item => Number(item.number) || 0)) + 1;
    } catch { this.items = []; }
  }

  persist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => this.flushPersist(), 700);
    this.persistTimer.unref?.();
  }

  flushPersist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.writeFileSync(this.storePath, JSON.stringify(this.items.slice(-250), null, 2), 'utf8');
    } catch (error) { this.emit('app:log', { level: 'warn', message: `Could not save download history: ${error.message}` }); }
  }

  publicItem(item) {
    return { ...item, logs: (item.logs || []).slice(-3000) };
  }

  snapshot() { return { running: this.running, items: this.items.map(item => this.publicItem(item)) }; }

  publish(item) {
    this.persist();
    this.emit('downloads:changed', { item: this.publicItem(item), snapshot: this.snapshot() });
  }

  add(urls) {
    const added = [];
    const settings = { ...this.getSettings() };
    if (!String(settings.outputDir || '').trim()) throw new Error('Choose an output folder before adding downloads.');
    const entries = urls.map(raw => raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { url: raw })
      .map(entry => ({
        url: String(entry.url || '').trim(), title: String(entry.title || '').trim().slice(0, 300),
        overrides: entry.overrides && typeof entry.overrides === 'object' ? entry.overrides : null
      }))
      .filter(entry => entry.url);
    for (const entry of entries) {
      const effective = { ...settings, ...(entry.overrides || {}) };
      if (Number(effective.preset) === 8 && !String(effective.customFormat || '').trim()) throw new Error('Enter a custom format string in Settings or select another quality preset.');
      if (!isAcceptedUrl(entry.url)) throw new Error(`This does not look like a supported media URL: ${entry.url}`);
      if (/spotify\.(com|link|app\.link)/i.test(entry.url)) throw new Error('Spotify playlists must be imported from the Spotify Playlist workspace for match review.');
    }
    for (const entry of entries) {
      const url = entry.url;
      // Never queue the same URL twice while an earlier copy is still pending, running or finished.
      const existing = this.items.find(item => item.url === url && !entry.overrides === !item.overrides && !['Failed', 'Canceled'].includes(item.status));
      if (existing) { added.push(existing); continue; }
      const initialTitle = entry.title || url;
      const item = {
        id: crypto.randomUUID(), number: this.nextNumber++, url, title: initialTitle,
        status: 'Queued', progress: -1, fileProgress: -1, playlistIndex: 0, playlistCount: 0,
        speed: -1, eta: -1, totalBytes: 0, finalSize: 0, stage: '', filePath: '',
        errorText: '', cancelRequested: false, createdAt: new Date().toISOString(),
        overrides: entry.overrides || undefined, fixedTitle: entry.overrides ? initialTitle : undefined,
        settingsSnapshot: { ...settings, ...(entry.overrides || {}) }, logs: [`Added to queue: ${url}`]
      };
      added.push(item);
      this.items.unshift(item);
    }
    this.persist();
    this.emit('downloads:changed', { snapshot: this.snapshot() });
    if (settings.autoStart !== false) this.start();
    return added.map(item => this.publicItem(item));
  }

  start() { this.running = true; this.pump(); this.emit('downloads:queue-state', { running: true }); }
  pause() { this.running = false; this.emit('downloads:queue-state', { running: false }); }

  async pump() {
    if (this.pumping || !this.running) return;
    this.pumping = true;
    try {
      while (this.running) {
        const limit = Math.max(1, Math.min(5, Number(this.getSettings().parallel) || 2));
        if (this.processes.size >= limit) break;
        const next = this.items.slice().reverse().find(item => item.status === 'Queued');
        if (!next) break;
        this.runItem(next);
      }
    } finally { this.pumping = false; }
  }

  runItem(item, resolved = null) {
    const snapshot = item.settingsSnapshot || this.getSettings();
    let args;
    try {
      args = buildDownloadArgs({ ...snapshot, ffmpegPath: this.tools.ffmpegPath }, this.tools.binDir, resolved);
      args.push('--', resolved ? resolved.url : item.url);
    } catch (error) {
      item.status = 'Failed'; item.errorText = error.message; item.logs.push(`ERROR: ${error.message}`); this.publish(item); return;
    }
    this.tools.refresh();
    if (!this.tools.ytDlpPath) {
      item.status = 'Failed'; item.errorText = 'yt-dlp is not installed. Open Settings → Tools to install it.'; item.logs.push(item.errorText); this.publish(item); return;
    }
    item.status = 'Starting'; item.errorText = ''; item.stage = ''; item.speed = -1; item.eta = -1;
    item.attemptStart = item.logs.length;
    item.logs.push(`> yt-dlp ${args.map(arg => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ')}`);
    this.publish(item);

    const child = spawn(this.tools.ytDlpPath, args, {
      cwd: snapshot.outputDir || process.cwd(),
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, PATH: `${this.tools.binDir}${path.delimiter}${process.env.PATH || ''}`, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    });
    this.processes.set(item.id, child);
    const consume = (stream, isStderr) => {
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', line => this.handleLine(item, line, isStderr));
    };
    consume(child.stdout, false);
    consume(child.stderr, true);
    child.on('error', error => {
      item.errorText = error.message;
      item.logs.push(`ERROR: ${error.message}`);
    });
    child.on('close', code => {
      this.processes.delete(item.id);
      item.speed = -1; item.eta = -1;
      if (item.cancelRequested) {
        item.status = 'Canceled'; item.logs.push('Canceled.');
      } else if (code === 0) {
        item.status = 'Done'; item.progress = 100; item.fileProgress = 100;
        try { if (item.filePath && fs.existsSync(item.filePath)) item.finalSize = fs.statSync(item.filePath).size; } catch { /* ignore */ }
      } else if (this.needsPageInspection(item, snapshot, resolved)) {
        this.inspectAndRetry(item, snapshot);
        return;
      } else {
        item.status = 'Failed';
        if (!item.errorText) item.errorText = `yt-dlp exited with code ${code ?? 'unknown'}.`;
        item.errorText = friendlyHint(item.errorText, item.url);
        item.logs.push(`Failed: ${item.errorText}`);
      }
      this.publish(item);
      this.pump();
    });
  }

  /** yt-dlp had no dedicated extractor (it fell to its generic one) or found no playable format on a web page. */
  needsPageInspection(item, snapshot, resolved) {
    if (resolved || item.inspected || snapshot.inspectPages === false) return false;
    if (!/^https?:\/\//i.test(item.url)) return false;
    const attempt = (item.logs || []).slice(Math.max(0, item.attemptStart || 0)).join('\n');
    return /\[generic\]|Unsupported URL|No video formats found|Unable to extract|no video could be found|There is no video in this post/i.test(attempt);
  }

  /**
   * Read the page like DevTools would (<video><source type="video/mp4">, og:video, player configs, nested iframes,
   * then the live rendered DOM and media requests), verify the result with the right Referer, and download that.
   */
  async inspectAndRetry(item, snapshot) {
    item.inspected = true;
    const originalError = item.errorText;
    const controller = new AbortController();
    this.processes.set(item.id, { placeholder: true, controller }); // keeps this item's download slot while inspecting
    item.status = 'Processing'; item.stage = 'Inspecting page for video'; item.speed = -1; item.eta = -1; item.progress = -1; item.fileProgress = -1; item.errorText = '';
    item.logs.push('yt-dlp has no extractor for this page. Inspecting it for a video source…');
    this.publish(item);
    let result;
    try {
      result = await this.resolveMedia(item.url, { signal: controller.signal, log: message => { item.logs.push(message); this.publish(item); } });
    } catch (error) { result = { ok: false, reason: error.message }; }
    this.processes.delete(item.id);
    if (item.cancelRequested) {
      item.status = 'Canceled'; item.stage = ''; item.logs.push('Canceled.'); this.publish(item); this.pump(); return;
    }
    if (!result || !result.ok || !result.selected) {
      item.status = 'Failed'; item.stage = '';
      const reason = result?.reason || 'No video source was found in the page.';
      item.errorText = friendlyHint(`${originalError ? `${originalError} ` : ''}${reason}`, item.url);
      item.logs.push(`Failed: ${item.errorText}`);
      this.publish(item); this.pump(); return;
    }
    const chosen = result.selected;
    const title = cleanPageTitle(result.title);
    if (title && !item.fixedTitle) item.fixedTitle = title;
    if (title && item.title === item.url) item.title = title;
    item.resolvedSource = chosen.url;
    item.logs.push(`Using ${chosen.kind === 'embed' ? 'embedded player' : chosen.kind.toUpperCase()} source found ${result.stage === 'rendered' ? 'in the live page' : 'in the page'}${chosen.type ? ` (${chosen.type})` : ''}: ${chosen.url}`);
    item.status = 'Starting'; item.stage = ''; item.errorText = '';
    this.publish(item);
    this.runItem(item, { url: chosen.url, referer: chosen.referer || (chosen.kind === 'embed' ? item.url : ''), userAgent: pageSniffer.BROWSER_UA, title });
  }

  handleLine(item, line, isStderr) {
    if (line.startsWith('@@P|')) {
      const parts = line.split('|');
      if (parts.length < 8) return;
      const downloaded = Number(parts[1]);
      const total = Number(parts[2]) > 0 ? Number(parts[2]) : Number(parts[3]);
      const frag = Number(parts[6]); const fragCount = Number(parts[7]);
      item.fileProgress = total > 0 && Number.isFinite(downloaded) ? Math.min(100, downloaded / total * 100)
        : fragCount > 0 && Number.isFinite(frag) ? Math.min(100, frag / fragCount * 100) : -1;
      item.progress = item.playlistCount > 1 && item.playlistIndex > 0 && item.fileProgress >= 0
        ? Math.min(100, ((item.playlistIndex - 1) * 100 + item.fileProgress) / item.playlistCount) : item.fileProgress;
      item.totalBytes = total > 0 ? total : 0;
      item.speed = Number(parts[4]) || -1;
      item.eta = Number(parts[5]) || -1;
      if (item.status !== 'Processing' || item.fileProgress >= 0) item.status = 'Downloading';
      this.publish(item);
      return;
    }
    if (line.startsWith('@@PP|')) {
      const parts = line.split('|');
      if (parts[1] === 'started') { item.stage = parts.slice(2).join('|'); item.status = 'Processing'; item.speed = -1; item.eta = -1; this.publish(item); }
      return;
    }
    if (line.startsWith('@@T|')) {
      const parts = line.split('|');
      item.playlistIndex = Number(parts[1]) || 0;
      item.playlistCount = Number(parts[2]) || 0;
      item.title = item.fixedTitle || parts.slice(3).join('|') || item.url;
      item.fileProgress = 0;
      item.progress = item.playlistCount > 1 && item.playlistIndex > 0 ? ((item.playlistIndex - 1) * 100) / item.playlistCount : 0;
      item.status = 'Downloading';
      item.logs.push(`Downloading: ${item.title}`);
      this.publish(item);
      return;
    }
    if (line.startsWith('@@F|')) {
      item.filePath = line.slice(4);
      item.logs.push(`Saved: ${item.filePath}`);
      this.publish(item);
      return;
    }
    if (line.trim()) {
      item.logs.push(line);
      if (isStderr && line.startsWith('ERROR:')) item.errorText = line.slice(6).trim();
      if (item.logs.length > 3000) item.logs.splice(0, 500);
      this.publish(item);
    }
  }

  stopItem(id) {
    const item = this.items.find(entry => entry.id === id);
    if (!item) return false;
    if (item.status === 'Queued') {
      item.status = 'Canceled'; item.cancelRequested = true; item.logs.push('Canceled before starting.'); this.publish(item); return true;
    }
    const child = this.processes.get(id);
    if (!child) return false;
    item.cancelRequested = true;
    if (child.placeholder) { // still inspecting the page, no process yet
      child.controller.abort();
      item.logs.push('Cancellation requested…'); this.publish(item); return true;
    }
    try {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => { try { child.kill(); } catch { /* ignore */ } });
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      }
    } catch { try { child.kill(); } catch { /* ignore */ } }
    item.logs.push('Cancellation requested…'); this.publish(item);
    return true;
  }

  stopAll() {
    this.pause();
    for (const item of this.items) {
      if (item.status === 'Queued') this.stopItem(item.id);
      else if (['Starting', 'Downloading', 'Processing'].includes(item.status)) this.stopItem(item.id);
    }
  }

  retry(id) {
    const item = this.items.find(entry => entry.id === id);
    if (!item || !['Failed', 'Canceled'].includes(item.status)) return false;
    item.status = 'Queued'; item.progress = -1; item.fileProgress = -1; item.speed = -1; item.eta = -1;
    item.totalBytes = 0; item.finalSize = 0; item.stage = ''; item.errorText = ''; item.cancelRequested = false;
    item.playlistIndex = 0; item.playlistCount = 0; item.filePath = '';
    item.inspected = false; item.resolvedSource = undefined;
    item.logs.push('---- retry ----');
    this.publish(item); this.start(); return true;
  }

  remove(id) {
    const item = this.items.find(entry => entry.id === id);
    if (!item || ['Starting', 'Downloading', 'Processing'].includes(item.status)) return false;
    this.items = this.items.filter(entry => entry.id !== id); this.persist();
    this.emit('downloads:changed', { snapshot: this.snapshot() }); return true;
  }

  clearFinished() {
    this.items = this.items.filter(item => !['Done', 'Failed', 'Canceled'].includes(item.status));
    this.persist(); this.emit('downloads:changed', { snapshot: this.snapshot() });
  }

  getLog(id) {
    const item = this.items.find(entry => entry.id === id);
    return item ? (item.logs || []).join('\n') : '';
  }
}

module.exports = { DownloadService, PRESETS, buildDownloadArgs, isAcceptedUrl, splitArgs, escapeParseMetadata };
