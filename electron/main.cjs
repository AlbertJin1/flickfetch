const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, screen, safeStorage, protocol, session } = require('electron');
const APP_ICON = require('node:path').join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const path = require('node:path');
const fs = require('node:fs');
const { ToolManager } = require('./services/tool-manager.cjs');
const { DownloadService, PRESETS, isAcceptedUrl } = require('./services/download-service.cjs');
const { fetchPlaylist, findPlaylistMatches, buildQueueEntry } = require('./services/spotify-service.cjs');
const { PreviewService, SCHEME: PREVIEW_SCHEME } = require('./services/preview-service.cjs');
const { createRenderedSniffer } = require('./services/rendered-sniffer.cjs');
const { spawn } = require('node:child_process');
const os = require('node:os');
const { parseLegacySettings } = require('./services/legacy-settings.cjs');
const { loadWindowState, trackWindowState } = require('./services/window-state.cjs');
const { MonitorService } = require('./services/monitor-service.cjs');
const { APP_ID, applyWindowIdentity, repairPinnedShortcuts } = require('./services/taskbar-identity.cjs');
const updateSwap = require('./services/update-swap.cjs');

// Update helper mode: the verified new build was started under a temporary name only to swap files once the old FlickFetch has
// closed (see services/update-swap.cjs). It opens no window and reports nothing.
const FINISH_UPDATE_TARGET = process.env.FLICKFETCH_FINISH_UPDATE_TARGET || '';
async function runUpdateHelperMode() {
  const logFile = process.env.FLICKFETCH_FINISH_UPDATE_LOG || '';
  const version = process.env.FLICKFETCH_FINISH_UPDATE_VERSION || '';
  const log = message => { try { if (logFile) fs.appendFileSync(logFile, `${message}\n`, 'utf8'); } catch { /* the handshake simply times out */ } };
  let code = 0;
  try {
    log('helper started');
    const result = await updateSwap.runHelperSwap({
      target: FINISH_UPDATE_TARGET, source: process.env.FLICKFETCH_FINISH_UPDATE_SOURCE || '', log,
      launch: exe => new Promise((resolve, reject) => {
        const env = { ...process.env };
        for (const key of Object.keys(env)) if (/^PORTABLE_EXECUTABLE_/i.test(key) || /^FLICKFETCH_FINISH_UPDATE_/i.test(key) || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
        const child = spawn(exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exe), env });
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
      })
    });
    if (!result.ok) {
      code = 1;
      try { fs.writeFileSync(path.join(app.getPath('userData'), 'update-result.json'), JSON.stringify({ status: 'failed', version, message: `The update could not be finished (${result.reason}). Your previous version was reopened; check for updates to try again.` })); } catch { /* ignore */ }
    }
  } catch (error) { code = 1; log(`helper crashed: ${error?.message || error}`); }
  app.exit(code);
}

// Data location: ALWAYS %LOCALAPPDATA%\FlickFetch (settings, history, monitor state, helper tools, staged updates).
// Nothing is written next to the exe. A "FlickFetch-Data" folder left beside the exe by v2.1.0 is migrated once.
function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return true;
  } catch { return false; }
}

function migrateLegacyPortableData(legacyDir, targetDir) {
  try {
    if (!legacyDir || !fs.existsSync(legacyDir) || !fs.statSync(legacyDir).isDirectory()) return;
    // Copy only what the AppData folder does not already have, so an existing AppData install is never overwritten.
    fs.cpSync(legacyDir, targetDir, { recursive: true, force: false, errorOnExist: false });
    fs.rmSync(legacyDir, { recursive: true, force: true });
  } catch { /* best effort: the app keeps working from AppData either way */ }
}

if (process.platform === 'win32') {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const appDataDir = path.join(localAppData, 'FlickFetch');
  if (isWritableDir(appDataDir)) {
    app.setPath('userData', appDataDir);
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    if (portableDir) migrateLegacyPortableData(path.join(portableDir, 'FlickFetch-Data'), appDataDir);
  }
}

// The in-app audio preview is served to a plain <audio> element through this scheme. It has to be registered as
// privileged before the app is ready so Chromium treats it as a streamable media source (Range requests / seeking).
protocol.registerSchemesAsPrivileged([{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, stream: true } }]);

const DEFAULT_SETTINGS = {
  outputDir: path.join(os.homedir(), 'Videos', 'FlickFetch'),
  preset: 0,
  customFormat: '',
  container: 'mp4',
  preferCompat: false,
  audioFormat: 'mp3',
  audioQuality: '0',
  playlist: false,
  subs: false,
  autoSubs: false,
  embedSubs: true,
  subLangs: 'en.*',
  embedThumb: true,
  embedMeta: true,
  sponsor: false,
  template: '%(title).150B.%(ext)s',
  restrict: false,
  overwrite: false,
  infoJson: false,
  description: false,
  writeThumb: false,
  useArchive: false,
  sectionStart: '',
  sectionEnd: '',
  cookiesBrowser: '',
  cookiesFile: '',
  proxy: '',
  rateLimit: '',
  fragments: 4,
  retries: 10,
  parallel: 2,
  extraArgs: '',
  autoStart: true,
  inspectPages: true,
  watchClipboard: false,
  autoUpdate: true
};

const LEGACY_DEFAULT_TEMPLATE = '%(title).150B [%(id)s].%(ext)s';
const SETTINGS_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));
let mainWindow;
let splashWindow;
let rendererReady = false;
let splashFallbackTimer;
let settings = { ...DEFAULT_SETTINGS };
let settingsFile;
let tools;
let downloads;
let preview;
let clipboardTimer;
let lastClipboard = '';
let matchOperation = 0;
let matchController = null;
let monitor;
let quitAfterMonitorClose = false;
let monitorClosePromise = null;

function emit(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
  } catch (error) { emit('app:log', { level: 'error', message: `Unable to save settings: ${error.message}` }); }
}

function loadSettings() {
  let loadedJson = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      settings = { ...DEFAULT_SETTINGS, ...parsed };
      loadedJson = true;
    }
  } catch { /* migrate the original settings.ini when no readable JSON file exists */ }
  if (!loadedJson) {
    let migrated = {};
    try {
      const legacyPath = path.join(path.dirname(settingsFile), 'settings.ini');
      if (fs.existsSync(legacyPath)) migrated = parseLegacySettings(fs.readFileSync(legacyPath, 'utf8'), DEFAULT_SETTINGS);
    } catch (error) { emit('app:log', { level: 'warn', message: `Could not import legacy settings: ${error.message}` }); }
    settings = { ...DEFAULT_SETTINGS, ...migrated };
    if (Object.keys(migrated).length) saveSettings();
  }
  // v2.1.2: the default filename no longer carries the video id in brackets. Users who never customised the template
  // still have the old default saved in settings.json, so move them to the new one. Custom templates are left alone.
  if (settings.template === LEGACY_DEFAULT_TEMPLATE) {
    settings.template = DEFAULT_SETTINGS.template;
    saveSettings();
  }
  if (!settings.outputDir) settings.outputDir = DEFAULT_SETTINGS.outputDir;
  if (!fs.existsSync(settings.outputDir)) {
    try { fs.mkdirSync(settings.outputDir, { recursive: true }); } catch { /* user can choose another location */ }
  }
}

function watchClipboard() {
  if (clipboardTimer) clearInterval(clipboardTimer);
  clipboardTimer = null;
  lastClipboard = clipboard.readText();
  if (!settings.watchClipboard) return;
  clipboardTimer = setInterval(() => {
    try {
      const value = clipboard.readText().trim();
      if (value && value !== lastClipboard) {
        lastClipboard = value;
        const urls = value.split(/\r?\n/).map(line => line.trim()).filter(isAcceptedUrl);
        if (urls.length) emit('clipboard:detected', { urls });
      }
    } catch (error) { emit('app:log', { level: 'warn', message: `Clipboard monitor: ${error.message}` }); }
  }, 1200);
}

function showMainWindow() {
  if (rendererReady || !mainWindow || mainWindow.isDestroyed()) return;
  rendererReady = true;
  if (splashFallbackTimer) clearTimeout(splashFallbackTimer);
  mainWindow.setOpacity(0);
  mainWindow.show();
  mainWindow.focus();
  let opacity = 0;
  const fade = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(fade); return; }
    opacity = Math.min(1, opacity + 0.12);
    mainWindow.setOpacity(opacity);
    if (opacity >= 1) {
      clearInterval(fade);
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
      splashWindow = null;
    }
  }, 16);
}

function createWindow() {
  rendererReady = false;
  splashWindow = new BrowserWindow({
    // 600x410 card + 36px transparent margin on every side so the rounded corners and soft shadow are never clipped.
    width: 672,
    height: 482,
    frame: false,
    transparent: true,
    hasShadow: false,
    thickFrame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    movable: true,
    center: true,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    icon: APP_ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html')).catch(error => {
    emit('app:log', { level: 'warn', message: `Unable to load the startup splash: ${error.message}` });
  });
  splashWindow.once('ready-to-show', () => { if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show(); });

  // Restore the size/position the user last left the window at (validated against the currently connected displays).
  const windowStateFile = path.join(app.getPath('userData'), 'window-state.json');
  const MIN_WIDTH = 780;
  const MIN_HEIGHT = 540;
  const windowState = loadWindowState(windowStateFile, {
    defaults: { width: 1460, height: 960 },
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    displays: screen.getAllDisplays()
  });

  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    ...(windowState.x !== undefined ? { x: windowState.x, y: windowState.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    backgroundColor: '#f3f6f8',
    title: 'FlickFetch',
    icon: APP_ICON,
    autoHideMenuBar: true,
    show: false,
    opacity: 0,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  if (windowState.maximized) mainWindow.maximize();
  trackWindowState(mainWindow, windowStateFile, windowState);
  mainWindow.on('maximize', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window:state-changed', { maximized: true }); });
  mainWindow.on('unmaximize', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window:state-changed', { maximized: false }); });
  mainWindow.on('closed', () => { mainWindow = null; });
  // Pinning or relaunching this window starts the real FlickFetch.exe (not the portable build's temp copy), so Windows shows one icon.
  if (process.platform === 'win32' && app.isPackaged) applyWindowIdentity(mainWindow);
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    if (code !== -3) emit('app:log', { level: 'error', message: `The application view failed to load: ${description}` });
  });
  // The Vite dev server is used only when launched via `npm run dev` (which passes --dev). `npm start` and packaged builds load dist/.
  if (!app.isPackaged && process.argv.includes('--dev')) {
    mainWindow.loadURL('http://127.0.0.1:5173').catch(error => {
      emit('app:log', { level: 'error', message: `Unable to load the development UI: ${error.message}` });
      showMainWindow();
    });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html')).catch(error => {
      emit('app:log', { level: 'error', message: `Unable to load the application UI: ${error.message}` });
      showMainWindow();
    });
  }
  // Avoid leaving the splash visible indefinitely if a renderer startup error prevents its ready signal.
  splashFallbackTimer = setTimeout(() => showMainWindow(), 25000);
}

function ensureHttpUrl(url) {
  try {
    const parsed = new URL(String(url));
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS links can be opened.');
    return parsed.href;
  } catch (error) { throw new Error(error.message || 'Invalid URL.'); }
}

async function inspectMedia(url, type) {
  const value = String(url || '').trim();
  if (!isAcceptedUrl(value)) throw new Error('Paste a valid media URL first.');
  tools.refresh();
  if (!tools.ytDlpPath) throw new Error('yt-dlp is not installed. Open Settings → Tools to install it.');
  const common = ['--ignore-config', '--encoding', 'utf-8', '--color', 'never', '--no-warnings'];
  if (settings.proxy?.trim()) common.push('--proxy', settings.proxy.trim());
  if (settings.cookiesFile?.trim()) common.push('--cookies', settings.cookiesFile.trim());
  else if (settings.cookiesBrowser?.trim()) common.push('--cookies-from-browser', settings.cookiesBrowser.trim());
  if (type === 'formats') {
    const result = await tools.run([...common, '--list-formats', value], { timeout: 60000 });
    const text = `${result.stdout}\n${result.stderr}`.trim();
    if (result.code !== 0 && !text) throw new Error('Could not retrieve available formats.');
    return { type, text };
  }
  const result = await tools.run([...common, '--dump-single-json', '--skip-download', value], { timeout: 60000 });
  if (result.code !== 0 && !result.stdout.trim()) throw new Error(result.stderr.trim() || 'Could not inspect this media URL.');
  let data;
  try { data = JSON.parse(result.stdout); } catch { return { type, text: result.stdout || result.stderr }; }
  return {
    type,
    info: {
      title: data.title || 'Unknown title',
      uploader: data.uploader || data.channel || 'Unknown creator',
      duration: data.duration_string || (Number.isFinite(data.duration) ? `${Math.round(data.duration)} seconds` : '—'),
      extractor: data.extractor_key || data.extractor || '—',
      uploadDate: data.upload_date || '—',
      description: String(data.description || '').slice(0, 3500),
      webpageUrl: data.webpage_url || value,
      thumbnail: data.thumbnail || '',
      formats: Array.isArray(data.formats) ? data.formats.length : 0
    }
  };
}

function registerIpc() {
  ipcMain.on('app:renderer-ready', () => showMainWindow());
  const resolveMainWindow = event => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || senderWindow !== mainWindow) throw new Error('Window controls are only available to the main application window.');
    return senderWindow;
  };
  ipcMain.handle('window:minimize', event => {
    resolveMainWindow(event).minimize();
    return true;
  });
  ipcMain.handle('window:toggle-maximize', event => {
    const win = resolveMainWindow(event);
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('window:close', event => {
    resolveMainWindow(event).close();
    return true;
  });
  ipcMain.handle('window:is-maximized', event => resolveMainWindow(event).isMaximized());
  ipcMain.handle('app:get-info', async () => ({
    name: app.getName(), version: app.getVersion(), platform: `${process.platform}-${process.arch}`,
    packaged: app.isPackaged, userDataPath: app.getPath('userData')
  }));
  ipcMain.handle('updater:check', async (_event, options) => monitor ? monitor.checkForUpdates(options || {}) : ({ supported: false, updateAvailable: false }));
  // Background download + verification. Resolves when a verified update is staged beside the exe; "Update later" simply leaves it there.
  ipcMain.handle('updater:stage', async () => {
    if (!monitor) throw new Error('The update service is not ready.');
    const info = await monitor.checkForUpdates({});
    if (!info.updateAvailable || info.installMode !== 'install') return { staged: false };
    return monitor.stageUpdate(info);
  });
  ipcMain.handle('updater:install', async () => {
    if (!monitor) throw new Error('The update service is not ready.');
    // Like PDF Studio's unsaved-edits check: never restart into an update while downloads are still running without asking.
    const busy = downloads?.snapshot?.().items?.filter(item => ['starting', 'downloading', 'processing'].includes(String(item.status || '').toLowerCase())).length || 0;
    if (busy > 0) {
      const { response } = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
        type: 'question', title: 'Update FlickFetch', message: `${busy} download${busy === 1 ? ' is' : 's are'} still running`,
        detail: 'FlickFetch has to close to finish the update. Running downloads will be stopped; you can resume them afterwards.',
        buttons: ['Update now', 'Not yet'], defaultId: 1, cancelId: 1, noLink: true
      });
      if (response !== 0) return { success: false, cancelled: true, restarting: false };
    }
    const result = await monitor.downloadAndInstallUpdate();
    // The detached PowerShell handoff waits for this process to exit before replacing the portable exe.
    // Installed builds only download the verified release, so they keep running.
    if (result?.restarting) app.quit();
    return result;
  });
  ipcMain.handle('monitor:submit-review', async (_event, review) => {
    if (!monitor) throw new Error('The review service is not ready.');
    return monitor.submitReview(review || {});
  });
  // Automatic review prompt (same policy as PDF Studio: 30 minutes of use, paused after a review, snooze / opt-out).
  ipcMain.handle('monitor:review-maybe-prompt', async () => monitor ? monitor.maybePromptReview() : ({ shouldPrompt: false, stopChecking: true }));
  ipcMain.handle('monitor:review-prompt-shown', async () => monitor ? monitor.markReviewPromptShown() : false);
  ipcMain.handle('monitor:review-defer', async (_event, choice) => monitor ? monitor.deferReview(choice) : false);
  ipcMain.handle('monitor:review-identity', async () => monitor ? monitor.reviewIdentity() : ({ hostname: '', lastReviewAt: 0, reviewPending: false }));
  ipcMain.handle('app:open-external', async (_event, url) => shell.openExternal(ensureHttpUrl(url)));
  ipcMain.handle('app:open-path', async (_event, filePath) => {
    const target = String(filePath || '');
    if (!target || !fs.existsSync(target)) throw new Error('The selected path does not exist.');
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return true;
  });
  ipcMain.handle('app:read-clipboard', () => clipboard.readText());
  ipcMain.handle('app:reveal-path', async (_event, filePath) => {
    const target = String(filePath || '');
    if (!target || !fs.existsSync(target)) throw new Error('The selected file does not exist.');
    shell.showItemInFolder(target); return true;
  });

  ipcMain.handle('settings:get', () => ({ ...settings }));
  ipcMain.handle('settings:update', (_event, values) => {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid settings payload.');
    const next = { ...settings };
    for (const [key, value] of Object.entries(values)) {
      if (!SETTINGS_KEYS.has(key)) continue;
      const defaultValue = DEFAULT_SETTINGS[key];
      if (typeof defaultValue === 'boolean') next[key] = Boolean(value);
      else if (typeof defaultValue === 'number') next[key] = Math.max(0, Math.min(key === 'parallel' ? 5 : key === 'fragments' ? 16 : 100, Number(value) || 0));
      else if (typeof value === 'string') next[key] = value.slice(0, 10000);
    }
    if (Number(next.preset) === 8 && !String(next.customFormat || '').trim()) throw new Error('Custom format cannot be empty when the Custom quality preset is selected.');
    if (next.sectionStart && !/^(\d+:){0,2}\d+(\.\d+)?$/.test(next.sectionStart)) throw new Error('Start time must look like 90, 1:30 or 00:01:30.');
    if (next.sectionEnd && !/^(\d+:){0,2}\d+(\.\d+)?$/.test(next.sectionEnd)) throw new Error('End time must look like 90, 1:30 or 00:01:30.');
    if (next.rateLimit && !/^\d+(\.\d+)?[KkMmGg]?$/.test(next.rateLimit)) throw new Error('Speed limit must look like 500K, 2M or 1.5M.');
    if (next.cookiesFile && !fs.existsSync(next.cookiesFile)) throw new Error('The cookies file does not exist.');
    if (next.outputDir) fs.mkdirSync(next.outputDir, { recursive: true });
    settings = next; saveSettings(); watchClipboard();
    return { ...settings };
  });
  ipcMain.handle('dialog:output-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.outputDir });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('dialog:cookies-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Cookies text file', extensions: ['txt'] }, { name: 'All files', extensions: ['*'] }] });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('tools:status', () => tools.getStatus());
  ipcMain.handle('tools:install', async (_event, selection) => tools.install(selection || {}));
  ipcMain.handle('tools:check-update', () => tools.checkYtDlpUpdate());
  ipcMain.handle('tools:update-ytdlp', async () => {
    const output = await tools.updateYtDlp();
    return { output, status: await tools.getStatus() };
  });

  ipcMain.handle('downloads:snapshot', () => downloads.snapshot());
  ipcMain.handle('downloads:add', (_event, urls) => {
    if (!Array.isArray(urls)) throw new Error('Expected a list of media links.');
    return downloads.add(urls);
  });
  ipcMain.handle('downloads:start', () => { downloads.start(); return downloads.snapshot(); });
  ipcMain.handle('downloads:pause', () => { downloads.pause(); return downloads.snapshot(); });
  ipcMain.handle('downloads:stop-all', () => { downloads.stopAll(); return downloads.snapshot(); });
  ipcMain.handle('downloads:stop', (_event, id) => downloads.stopItem(String(id)));
  ipcMain.handle('downloads:retry', (_event, id) => downloads.retry(String(id)));
  ipcMain.handle('downloads:remove', (_event, id) => downloads.remove(String(id)));
  ipcMain.handle('downloads:clear-finished', () => { downloads.clearFinished(); return downloads.snapshot(); });
  ipcMain.handle('downloads:get-log', (_event, id) => downloads.getLog(String(id)));
  ipcMain.handle('media:inspect', (_event, url, type) => inspectMedia(url, type));

  ipcMain.handle('preview:prepare', (_event, url, options) => preview.prepare(String(url || ''), { fresh: Boolean(options?.fresh) }));
  ipcMain.handle('preview:warm', (_event, url) => preview.warm(String(url || '')));

  ipcMain.handle('spotify:import', (_event, url) => fetchPlaylist(url));
  ipcMain.handle('spotify:find-matches', async (_event, playlist, options = {}) => {
    matchController?.abort();
    const controller = new AbortController();
    matchController = controller;
    const operation = ++matchOperation;
    const autoDownload = options?.autoDownload !== false;
    // As soon as a CONFIDENT audio-only match is found for a track, queue it and start downloading right away.
    const onConfident = autoDownload ? async (track, candidate) => {
      if (operation !== matchOperation || controller.signal.aborted) return {};
      try {
        const [item] = downloads.add([buildQueueEntry(track, candidate, playlist.name)]);
        downloads.start();
        return { queued: true, downloadId: item?.id, queueError: '' };
      } catch (error) { return { queued: false, queueError: error.message }; }
    } : null;
    try {
      const result = await findPlaylistMatches(playlist, tools, (channel, payload) => {
        if (operation === matchOperation && !controller.signal.aborted) emit(channel, payload);
      }, controller.signal, { onConfident });
      if (operation !== matchOperation) throw new Error('A newer match search replaced this one.');
      return result;
    } finally {
      if (matchController === controller) matchController = null;
    }
  });
  ipcMain.handle('spotify:cancel-matches', () => {
    if (!matchController) return false;
    matchController.abort();
    return true;
  });
  ipcMain.handle('spotify:add-match', (_event, candidate, track, playlistName) => {
    if (!candidate?.url || !track) throw new Error('Choose a YouTube match first.');
    const [item] = downloads.add([buildQueueEntry(track, candidate, playlistName)]);
    downloads.start();
    return item;
  });
  ipcMain.handle('spotify:export-csv', async (_event, playlist) => {
    if (!playlist || !Array.isArray(playlist.tracks)) throw new Error('No playlist is available to export.');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Spotify playlist matches',
      defaultPath: `${String(playlist.name || 'spotify-playlist').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80)}-matches.csv`,
      filters: [{ name: 'CSV file', extensions: ['csv'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const fields = ['Number', 'Title', 'Artist', 'Album', 'Duration (ms)', 'Spotify URL', 'YouTube match', 'YouTube channel', 'Match score', 'Match URL'];
    const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = [fields.map(quote).join(',')];
    for (const track of playlist.tracks) {
      const match = track.bestMatch || track.candidates?.[0] || {};
      lines.push([track.number, track.title, track.artist, track.album, track.durationMilliseconds, track.spotifyUrl, match.title, match.channel, match.score, match.url].map(quote).join(','));
    }
    fs.writeFileSync(result.filePath, `\uFEFF${lines.join('\r\n')}`, 'utf8');
    return { canceled: false, filePath: result.filePath };
  });
}

// Groups the taskbar button / jump list under FlickFetch's own identity (and lets the icon show correctly).
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

app.whenReady().then(async () => {
  if (FINISH_UPDATE_TARGET) return runUpdateHelperMode();
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  loadSettings();
  tools = new ToolManager(app.getPath('userData'), emit);
  // Finds the real <video>/video/mp4 source behind pages yt-dlp has no extractor for (static HTML, then the live DOM).
  const pageInspector = createRenderedSniffer({ electron: { BrowserWindow, session }, getSettings: () => settings, log: (level, message) => emit('app:log', { level, message }) });
  downloads = new DownloadService({ toolManager: tools, getSettings: () => settings, emit, userDataPath: app.getPath('userData'), resolveMedia: (url, options) => pageInspector.resolve(url, options) });
  preview = new PreviewService({
    toolManager: tools, getSettings: () => settings,
    cacheDir: path.join(app.getPath('userData'), 'preview-cache'),
    log: (level, message) => emit('app:log', { level, message })
  });
  protocol.handle(PREVIEW_SCHEME, request => preview.handleRequest(request));
  monitor = new MonitorService({ app, appVersion: app.getVersion(), userDataPath: app.getPath('userData'), emit, packaged: app.isPackaged, safeStorage });
  await monitor.initialize();
  registerIpc();
  createWindow();
  // An icon pinned earlier carries no app ID, so Windows keeps it apart from the running window; link them (takes effect on next launch).
  if (process.platform === 'win32' && app.isPackaged) repairPinnedShortcuts({ shell, log: (level, message) => emit('app:log', { level, message }) });
  watchClipboard();
  // The update helper leaves a note when it could not replace the exe in place. Say so plainly and show where the new version is.
  setTimeout(() => {
    const outcome = monitor.consumeUpdateResult?.();
    if (!outcome) return;
    emit('app:log', { level: outcome.status === 'ok' ? 'info' : 'warn', message: outcome.message });
    if (outcome.status === 'ok') return;
    const hasFile = Boolean(outcome.newPath) && fs.existsSync(outcome.newPath);
    dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
      type: outcome.status === 'fallback' ? 'info' : 'warning',
      title: 'FlickFetch update',
      message: outcome.status === 'fallback' ? `FlickFetch ${outcome.version} is running from a saved copy` : `FlickFetch ${outcome.version} could not be installed`,
      detail: `${outcome.message}${hasFile ? `\n\nNew version: ${outcome.newPath}` : ''}`,
      buttons: hasFile ? ['Show in folder', 'OK'] : ['OK'], defaultId: 0, cancelId: hasFile ? 1 : 0, noLink: true
    }).then(({ response }) => { if (hasFile && response === 0) shell.showItemInFolder(outcome.newPath); }).catch(() => {});
  }, 2500);
  if (app.isPackaged && process.platform === 'win32') {
    // 1) An update the person postponed ("Update later") is re-verified and offered again.  2) Then check for a newer one and,
    // like PDF Studio, download and verify it quietly in the background so "Update now" is only a rename.
    monitor.restoreStagedUpdate().catch(error => emit('app:log', { level: 'warn', message: `Staged update check failed: ${error.message}` }));
    setTimeout(async () => {
      try {
        const info = await monitor.checkForUpdates();
        if (settings.autoUpdate && info.updateAvailable && info.installMode === 'install') {
          await monitor.stageUpdate(info);
        }
      } catch (error) { emit('app:log', { level: 'warn', message: `FlickFetch update check failed: ${error.message}` }); }
    }, 1800);
  }
  if (settings.autoUpdate && tools.isManagedYtDlp()) {
    setTimeout(async () => {
      try {
        const output = await tools.updateYtDlp();
        emit('app:log', { level: 'info', message: `yt-dlp update check: ${output}` });
        emit('tools:changed', {});
      } catch (error) { emit('app:log', { level: 'warn', message: `yt-dlp update check: ${error.message}` }); }
    }, 2200);
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(error => {
  dialog.showErrorBox('FlickFetch could not start', error.stack || error.message);
  app.quit();
});

// After an in-place update the new exe already sits at the old path; start it as the last thing this process does.
app.on('quit', () => { try { monitor?.relaunchAfterQuit?.(); } catch { /* the new exe can still be opened by hand from the same path */ } });

app.on('will-quit', () => { try { preview?.clearCacheDir(); } catch { /* temp audio is also cleared on next start */ } });

app.on('before-quit', event => {
  if (!quitAfterMonitorClose && monitor) {
    event.preventDefault();
    if (!monitorClosePromise) {
      monitorClosePromise = (async () => {
        if (splashFallbackTimer) clearTimeout(splashFallbackTimer);
        if (downloads) { downloads.stopAll(); downloads.flushPersist(); }
        if (clipboardTimer) clearInterval(clipboardTimer);
        await Promise.race([monitor.close(), new Promise(resolve => setTimeout(resolve, 4500))]);
        quitAfterMonitorClose = true;
        app.quit();
      })().catch(error => {
        console.warn('Monitor close handling failed:', error);
        quitAfterMonitorClose = true;
        app.quit();
      });
    }
    return;
  }
  if (splashFallbackTimer) clearTimeout(splashFallbackTimer);
  if (downloads) { downloads.stopAll(); downloads.flushPersist(); }
  if (clipboardTimer) clearInterval(clipboardTimer);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
