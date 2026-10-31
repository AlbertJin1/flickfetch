const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel, listener) => {
  if (typeof listener !== 'function') return () => {};
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('flickfetch', {
  app: {
    signalReady: () => ipcRenderer.send('app:renderer-ready'),
    getInfo: () => ipcRenderer.invoke('app:get-info'),
    openExternal: url => ipcRenderer.invoke('app:open-external', url),
    openPath: filePath => ipcRenderer.invoke('app:open-path', filePath),
    readClipboard: () => ipcRenderer.invoke('app:read-clipboard'),
    revealPath: filePath => ipcRenderer.invoke('app:reveal-path', filePath)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: values => ipcRenderer.invoke('settings:update', values),
    chooseOutputFolder: () => ipcRenderer.invoke('dialog:output-folder'),
    chooseCookiesFile: () => ipcRenderer.invoke('dialog:cookies-file')
  },
  tools: {
    status: () => ipcRenderer.invoke('tools:status'),
    install: selection => ipcRenderer.invoke('tools:install', selection),
    updateYtDlp: () => ipcRenderer.invoke('tools:update-ytdlp')
  },
  downloads: {
    snapshot: () => ipcRenderer.invoke('downloads:snapshot'),
    add: urls => ipcRenderer.invoke('downloads:add', urls),
    start: () => ipcRenderer.invoke('downloads:start'),
    pause: () => ipcRenderer.invoke('downloads:pause'),
    stopAll: () => ipcRenderer.invoke('downloads:stop-all'),
    stop: id => ipcRenderer.invoke('downloads:stop', id),
    retry: id => ipcRenderer.invoke('downloads:retry', id),
    remove: id => ipcRenderer.invoke('downloads:remove', id),
    clearFinished: () => ipcRenderer.invoke('downloads:clear-finished'),
    getLog: id => ipcRenderer.invoke('downloads:get-log', id)
  },
  inspect: (url, type) => ipcRenderer.invoke('media:inspect', url, type),
  spotify: {
    importPlaylist: url => ipcRenderer.invoke('spotify:import', url),
    findMatches: playlist => ipcRenderer.invoke('spotify:find-matches', playlist),
    addMatch: (url, title) => ipcRenderer.invoke('spotify:add-match', url, title),
    exportCsv: playlist => ipcRenderer.invoke('spotify:export-csv', playlist),
    cancelMatches: () => ipcRenderer.invoke('spotify:cancel-matches')
  },
  on: {
    downloadsChanged: listener => subscribe('downloads:changed', listener),
    queueState: listener => subscribe('downloads:queue-state', listener),
    toolsProgress: listener => subscribe('tools:progress', listener),
    spotifyProgress: listener => subscribe('spotify:match-progress', listener),
    clipboardDetected: listener => subscribe('clipboard:detected', listener),
    appLog: listener => subscribe('app:log', listener)
  }
});
