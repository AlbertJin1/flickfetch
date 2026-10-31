const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel, listener) => {
  if (typeof listener !== 'function') return () => {};
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('flickfetch', {
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized')
  },
  app: {
    signalReady: () => ipcRenderer.send('app:renderer-ready'),
    getInfo: () => ipcRenderer.invoke('app:get-info'),
    openExternal: url => ipcRenderer.invoke('app:open-external', url),
    openPath: filePath => ipcRenderer.invoke('app:open-path', filePath),
    readClipboard: () => ipcRenderer.invoke('app:read-clipboard'),
    revealPath: filePath => ipcRenderer.invoke('app:reveal-path', filePath)
  },
  updater: {
    check: options => ipcRenderer.invoke('updater:check', options),
    install: () => ipcRenderer.invoke('updater:install')
  },
  monitor: {
    submitReview: review => ipcRenderer.invoke('monitor:submit-review', review),
    maybePromptReview: () => ipcRenderer.invoke('monitor:review-maybe-prompt'),
    markReviewPromptShown: () => ipcRenderer.invoke('monitor:review-prompt-shown'),
    deferReview: choice => ipcRenderer.invoke('monitor:review-defer', choice),
    getReviewIdentity: () => ipcRenderer.invoke('monitor:review-identity')
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
    updateYtDlp: () => ipcRenderer.invoke('tools:update-ytdlp'),
    checkYtDlpUpdate: () => ipcRenderer.invoke('tools:check-update')
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
  preview: {
    prepare: (url, options) => ipcRenderer.invoke('preview:prepare', url, options),
    warm: url => ipcRenderer.invoke('preview:warm', url)
  },
  spotify: {
    importPlaylist: url => ipcRenderer.invoke('spotify:import', url),
    findMatches: (playlist, options) => ipcRenderer.invoke('spotify:find-matches', playlist, options),
    addMatch: (candidate, track, playlistName) => ipcRenderer.invoke('spotify:add-match', candidate, track, playlistName),
    exportCsv: playlist => ipcRenderer.invoke('spotify:export-csv', playlist),
    cancelMatches: () => ipcRenderer.invoke('spotify:cancel-matches')
  },
  on: {
    downloadsChanged: listener => subscribe('downloads:changed', listener),
    queueState: listener => subscribe('downloads:queue-state', listener),
    toolsProgress: listener => subscribe('tools:progress', listener),
    toolsChanged: listener => subscribe('tools:changed', listener),
    spotifyProgress: listener => subscribe('spotify:match-progress', listener),
    clipboardDetected: listener => subscribe('clipboard:detected', listener),
    appLog: listener => subscribe('app:log', listener),
    windowStateChanged: listener => subscribe('window:state-changed', listener),
    updaterStatus: listener => subscribe('updater:status', listener),
    updaterProgress: listener => subscribe('updater:progress', listener)
  }
});
