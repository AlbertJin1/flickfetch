const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { ToolManager } = require('./services/tool-manager.cjs');
const { DownloadService, PRESETS, isAcceptedUrl } = require('./services/download-service.cjs');
const { fetchPlaylist, findPlaylistMatches } = require('./services/spotify-service.cjs');
const { spawn } = require('node:child_process');
const os = require('node:os');
const { parseLegacySettings } = require('./services/legacy-settings.cjs');

// Preserve the original Windows data directory so existing helper binaries remain available.
if (process.platform === 'win32') {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  app.setPath('userData', path.join(localAppData, 'FlickFetch'));
}

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
  template: '%(title).150B [%(id)s].%(ext)s',
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
  watchClipboard: false,
  autoUpdate: true
};

const SETTINGS_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));
let mainWindow;
let splashWindow;
let rendererReady = false;
let splashFallbackTimer;
let settings = { ...DEFAULT_SETTINGS };
let settingsFile;
let tools;
let downloads;
let clipboardTimer;
let lastClipboard = '';
let matchOperation = 0;
let matchController = null;

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
    width: 600,
    height: 410,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    center: true,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#07111e',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html')).catch(error => {
    emit('app:log', { level: 'warn', message: `Unable to load the startup splash: ${error.message}` });
  });
  splashWindow.once('ready-to-show', () => { if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show(); });

  mainWindow = new BrowserWindow({
    width: 1460,
    height: 960,
    minWidth: 1060,
    minHeight: 680,
    backgroundColor: '#f3f6f8',
    title: 'FlickFetch',
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
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    if (code !== -3) emit('app:log', { level: 'error', message: `The application view failed to load: ${description}` });
  });
  if (!app.isPackaged) {
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
  ipcMain.handle('app:get-info', async () => ({
    name: app.getName(), version: app.getVersion(), platform: `${process.platform}-${process.arch}`,
    packaged: app.isPackaged, userDataPath: app.getPath('userData')
  }));
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

  ipcMain.handle('spotify:import', (_event, url) => fetchPlaylist(url));
  ipcMain.handle('spotify:find-matches', async (_event, playlist) => {
    matchController?.abort();
    const controller = new AbortController();
    matchController = controller;
    const operation = ++matchOperation;
    try {
      const result = await findPlaylistMatches(playlist, tools, (channel, payload) => {
        if (operation === matchOperation && !controller.signal.aborted) emit(channel, payload);
      }, controller.signal);
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
  ipcMain.handle('spotify:add-match', (_event, url, title) => downloads.add([{ url, title }]));
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

app.whenReady().then(() => {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  loadSettings();
  tools = new ToolManager(app.getPath('userData'), emit);
  downloads = new DownloadService({ toolManager: tools, getSettings: () => settings, emit, userDataPath: app.getPath('userData') });
  registerIpc();
  createWindow();
  watchClipboard();
  if (settings.autoUpdate && tools.ytDlpPath && path.dirname(tools.ytDlpPath) === tools.binDir) {
    setTimeout(async () => {
      try {
        const output = await tools.updateYtDlp();
        emit('app:log', { level: 'info', message: `yt-dlp update check: ${output}` });
      } catch (error) { emit('app:log', { level: 'warn', message: `yt-dlp update check: ${error.message}` }); }
    }, 2200);
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(error => {
  dialog.showErrorBox('FlickFetch could not start', error.stack || error.message);
  app.quit();
});

app.on('before-quit', () => {
  if (splashFallbackTimer) clearTimeout(splashFallbackTimer);
  if (downloads) { downloads.stopAll(); downloads.flushPersist(); }
  if (clipboardTimer) clearInterval(clipboardTimer);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
