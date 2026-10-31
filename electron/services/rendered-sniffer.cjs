'use strict';
/*
 * Rendered page inspection (stage 2 of the page sniffer).
 *
 * Opens the link in a hidden, sandboxed browser window, lets the page's JavaScript build its player, and reports:
 *   - the live DOM of every frame (the same <video><source type="video/mp4"> you see in DevTools -> Elements), and
 *   - the media requests the player makes (the same list as DevTools -> Network -> Media), with the Referer sent.
 * Media requests are recorded and then cancelled, so nothing is downloaded by the inspector itself.
 *
 * Isolation: a private in-memory session (no shared cookies), no preload, no Node integration, sandbox on,
 * permissions denied, pop-ups and downloads blocked, audio muted, images/fonts not loaded, and top-level
 * navigation after load is blocked. One inspection runs at a time.
 */

const fs = require('node:fs');
const { BROWSER_UA, resolveMedia, classifyMedia, parseNetscapeCookies, withCookies } = require('./page-sniffer.cjs');

const PARTITION = 'flickfetch-page-inspector';
const SNAPSHOT_SCRIPT = `(() => {
  try {
    const videos = Array.from(document.querySelectorAll('video, audio')).map(v => ({
      tag: v.tagName.toLowerCase(), currentSrc: v.currentSrc || '', src: v.getAttribute('src') || '', type: v.getAttribute('type') || '',
      videoHeight: v.videoHeight || 0,
      sources: Array.from(v.querySelectorAll('source')).map(s => ({
        src: s.getAttribute('src') || '', type: s.getAttribute('type') || '',
        label: [s.getAttribute('label'), s.getAttribute('title'), s.getAttribute('res'), s.getAttribute('size')].filter(Boolean).join(' ')
      }))
    }));
    return { href: location.href, title: document.title, videos, html: document.documentElement.outerHTML.slice(0, 1500000) };
  } catch (error) { return null; }
})()`;
const PLAY_SCRIPT = `(() => {
  try {
    document.querySelectorAll('video').forEach(v => { v.muted = true; const p = v.play(); if (p && p.catch) p.catch(() => {}); });
    const selectors = ['.vjs-big-play-button', '.fluid_initial_play', '.fluid_html5_player_initial_play', '.jw-icon-display', '.plyr__control--overlaid',
      '.ytp-large-play-button', '.play-button', '.btn-play', '[aria-label="Play"]', '[title="Play"]', '.mejs__overlay-button', '.vp-big-play-button'];
    for (const selector of selectors) { const el = document.querySelector(selector); if (el) { el.click(); break; } }
  } catch (error) { /* ignore */ }
  return true;
})()`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function createRenderedSniffer({ electron, getSettings = () => ({}), log = () => {}, timeoutMs = 16000 }) {
  const { BrowserWindow, session } = electron;
  let sniffSession = null;
  let cookieStamp = '';
  let cookieList = [];
  let chain = Promise.resolve();

  function getSession() {
    if (sniffSession) return sniffSession;
    sniffSession = session.fromPartition(PARTITION, { cache: false });
    sniffSession.setUserAgent(BROWSER_UA);
    sniffSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    sniffSession.setPermissionCheckHandler(() => false);
    sniffSession.on('will-download', event => event.preventDefault());
    return sniffSession;
  }

  /** Apply the person's proxy and cookies file so the inspector sees the page as yt-dlp would. */
  async function configure() {
    const ses = getSession();
    const settings = getSettings() || {};
    const proxy = String(settings.proxy || '').trim();
    try { await ses.setProxy(proxy ? { proxyRules: proxy } : { mode: 'system' }); } catch (error) { log('warn', `Page inspector proxy: ${error.message}`); }
    const file = String(settings.cookiesFile || '').trim();
    if (file) {
      try {
        const stamp = `${file}:${fs.statSync(file).mtimeMs}`;
        if (stamp !== cookieStamp) {
          cookieList = parseNetscapeCookies(fs.readFileSync(file, 'utf8'));
          for (const cookie of cookieList) {
            try { await ses.cookies.set(cookie); } catch { /* skip an invalid cookie */ }
          }
          cookieStamp = stamp;
        }
      } catch (error) { log('warn', `Page inspector cookies: ${error.message}`); }
    }
    if (!file) { cookieList = []; cookieStamp = ''; }
    return ses;
  }

  async function runRender(pageUrl, { signal, log: stepLog = () => {} }) {
    const ses = await configure();
    const network = [];
    const seen = new Set();
    const record = (details, extra = {}) => {
      if (seen.has(details.url)) return;
      seen.add(details.url);
      const headers = details.requestHeaders || {};
      const referer = headers.Referer || headers.referer || details.referrer || '';
      network.push({ url: details.url, type: extra.type || '', mediaRequest: details.resourceType === 'media', referer, frameUrl: details.frame?.url || '' });
      stepLog(`Player requested media: ${details.url.length > 120 ? `${details.url.slice(0, 119)}…` : details.url}`);
    };

    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      try {
        if (details.resourceType === 'image' || details.resourceType === 'font') return callback({ cancel: true });
        const isMedia = details.resourceType === 'media' || classifyMedia(details.url, '') === 'file' || classifyMedia(details.url, '') === 'hls' || classifyMedia(details.url, '') === 'dash';
        if (isMedia && /^https?:/i.test(details.url)) {
          record(details);
          // Only the address matters; never pull the video through the inspector.
          if (details.resourceType === 'media' || classifyMedia(details.url, '') === 'file') return callback({ cancel: true });
        }
      } catch { /* never break page loading */ }
      callback({});
    });
    ses.webRequest.onHeadersReceived((details, callback) => {
      try {
        const headers = details.responseHeaders || {};
        const key = Object.keys(headers).find(name => name.toLowerCase() === 'content-type');
        const type = key ? String(headers[key][0] || headers[key]).toLowerCase() : '';
        if (/^video\/|mpegurl|dash\+xml/.test(type) && /^https?:/i.test(details.url)) record({ ...details, requestHeaders: {} }, { type });
      } catch { /* ignore */ }
      callback({});
    });

    const win = new BrowserWindow({
      show: false, width: 1280, height: 720, skipTaskbar: true, focusable: false,
      webPreferences: {
        session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
        autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false, spellcheck: false, devTools: false
      }
    });
    let loaded = false;
    let aborted = false;
    const onAbort = () => { aborted = true; };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const contents = win.webContents;
      contents.setAudioMuted(true);
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', event => { if (loaded) event.preventDefault(); });
      contents.on('will-redirect', event => { if (loaded) event.preventDefault(); });
      contents.loadURL(pageUrl, { userAgent: BROWSER_UA }).catch(() => { /* aborted or failed loads still leave useful requests */ });
      contents.once('did-finish-load', () => { loaded = true; });

      const deadline = Date.now() + timeoutMs;
      let firstFind = 0;
      let lastPlay = 0;
      let snapshots = [];
      while (Date.now() < deadline && !aborted && !win.isDestroyed()) {
        await sleep(600);
        if (win.isDestroyed()) break;
        const frames = (() => { try { return contents.mainFrame.framesInSubtree; } catch { return []; } })();
        const current = [];
        for (const frame of frames) {
          try {
            if (frame.detached) continue;
            if (Date.now() - lastPlay > 2500) frame.executeJavaScript(PLAY_SCRIPT, true).catch(() => {});
            const snapshot = await frame.executeJavaScript(SNAPSHOT_SCRIPT, true);
            if (snapshot && snapshot.href && /^https?:/i.test(snapshot.href)) current.push(snapshot);
          } catch { /* a frame can navigate or detach while it is being read */ }
        }
        if (Date.now() - lastPlay > 2500) lastPlay = Date.now();
        if (current.length) snapshots = current;
        const liveSource = snapshots.some(s => (s.videos || []).some(v => /^https?:/i.test(v.currentSrc || '') || (v.sources || []).some(x => x.src)));
        if ((liveSource || network.length) && !firstFind) firstFind = Date.now();
        if (firstFind && Date.now() - firstFind > 1800) break; // give other qualities a moment to appear
      }
      const title = snapshots.find(s => s.title)?.title || '';
      return { title, snapshots, network, aborted };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      try { ses.webRequest.onBeforeSendHeaders(null); ses.webRequest.onHeadersReceived(null); } catch { /* ignore */ }
      try { if (!win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
    }
  }

  /** Queue so only one hidden window exists at a time. */
  function render(pageUrl, options = {}) {
    const run = chain.then(() => runRender(pageUrl, options));
    chain = run.catch(() => {});
    return run;
  }

  /** The page resolver the download queue uses: static read first, rendered inspection as the fallback. */
  async function resolve(pageUrl, { signal, log: stepLog = () => {} } = {}) {
    const ses = await configure();
    const proxy = String((getSettings() || {}).proxy || '').trim();
    // Chromium's network stack refuses to send a cross-origin Referer on programmatic requests, and a hot-linked CDN
    // needs exactly that. Node's fetch sends any header, so it does the page reads and the source verification.
    // It cannot use a proxy though; with one configured, the Chromium session is used and verification is left to yt-dlp
    // (which supports both a proxy and --referer). The hidden window always uses Chromium, with its natural Referer.
    const fetchImpl = proxy
      ? (url, init = {}) => { const { headers = {}, ...rest } = init; const { Referer, Cookie, ...allowed } = headers; return ses.fetch(url, { ...rest, headers: allowed }); }
      : withCookies((url, init) => fetch(url, init), cookieList);
    return resolveMedia({ url: pageUrl, signal, log: stepLog, fetchImpl, renderer: render, verify: !proxy });
  }

  return { render, resolve, configure };
}

module.exports = { createRenderedSniffer, SNAPSHOT_SCRIPT, PLAY_SCRIPT };
