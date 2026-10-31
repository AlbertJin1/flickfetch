import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowUpRight, CircleHelp, Download, HardDrive,
  History, LifeBuoy, Music2, Settings, ShieldCheck, Sparkles, X, Star,
  ChevronLeft, ChevronRight,
  Minus, Maximize2, Minimize2
} from 'lucide-react';
import DownloadsWorkspace from './components/DownloadsWorkspace.jsx';
import SpotifyWorkspace from './components/SpotifyWorkspace.jsx';
import PreviewBar from './components/PreviewBar.jsx';
import HistoryWorkspace from './components/HistoryWorkspace.jsx';
import SettingsDialog from './components/SettingsDialog.jsx';
import GuideDialog from './components/GuideDialog.jsx';
import UpdateDialog from './components/UpdateDialog.jsx';
import AboutDialog from './components/AboutDialog.jsx';
import ReviewDialog from './components/ReviewDialog.jsx';
import { describeTransfer } from './lib/format.js';
import { Notice, Toast } from './components/Primitives.jsx';

const emptySettings = {
  outputDir: '', preset: 0, customFormat: '', container: 'mp4', preferCompat: false, audioFormat: 'mp3', audioQuality: '0', playlist: false,
  subs: false, autoSubs: false, embedSubs: true, subLangs: 'en.*', embedThumb: true, embedMeta: true, sponsor: false,
  template: '%(title).150B [%(id)s].%(ext)s', restrict: false, overwrite: false, infoJson: false, description: false, writeThumb: false, useArchive: false,
  sectionStart: '', sectionEnd: '', cookiesBrowser: '', cookiesFile: '', proxy: '', rateLimit: '', fragments: 4, retries: 10, parallel: 2,
  extraArgs: '', autoStart: true, inspectPages: true, watchClipboard: false, autoUpdate: true
};


const UPDATE_PHASES = { prepare: 'Preparing', manifest: 'Checking release', differential: 'Comparing files', download: 'Downloading', verify: 'Verifying', reconstruct: 'Rebuilding', save: 'Saving', saved: 'Saved', restarting: 'Restarting' };

function App() {
  const [screen, setScreen] = useState('downloads');
  const [settings, setSettings] = useState(emptySettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [toolStatus, setToolStatus] = useState(null);
  const [toolsProgress, setToolsProgress] = useState(null);
  const [ytUpdate, setYtUpdate] = useState(null);
  const [updatingYtDlp, setUpdatingYtDlp] = useState(false);
  const [updaterInfo, setUpdaterInfo] = useState(null);
  const [updaterProgress, setUpdaterProgress] = useState(null);
  const [downloadedUpdate, setDownloadedUpdate] = useState(null);
  const [checkingAppUpdate, setCheckingAppUpdate] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateError, setUpdateError] = useState('');
  const downloadMode = updaterInfo?.installMode === 'download';
  const updateSaved = Boolean(downloadedUpdate && downloadedUpdate.version === updaterInfo?.latestVersion);
  const [updatingApp, setUpdatingApp] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewAuto, setReviewAuto] = useState(false);
  const [items, setItems] = useState([]);
  const [queueRunning, setQueueRunning] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [toast, setToast] = useState(null);
  const [clipboardSuggestion, setClipboardSuggestion] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  const [spotifyRequest, setSpotifyRequest] = useState({ url: '', sequence: 0 });
  const [aboutOpen, setAboutOpen] = useState(false);
  const [appInfo, setAppInfo] = useState({ version: '2.1.1' });
  const [isReady, setIsReady] = useState(false);
  const [sidebarCompact, setSidebarCompact] = useState(() => {
    try { return localStorage.getItem('flickfetch-sidebar-compact') === 'true'; }
    catch { return false; }
  });
  const [windowMaximized, setWindowMaximized] = useState(false);

  useEffect(() => {
    try { localStorage.setItem('flickfetch-sidebar-compact', String(sidebarCompact)); }
    catch { /* Storage may be disabled in a restricted preview. */ }
  }, [sidebarCompact]);

  // Collapse automatically when the window becomes narrow; the toggle still works at any width.
  useEffect(() => {
    const query = window.matchMedia('(max-width: 980px)');
    if (query.matches) setSidebarCompact(true);
    const onChange = event => { if (event.matches) setSidebarCompact(true); };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  const toggleSidebar = useCallback(() => setSidebarCompact(value => !value), []);

  useEffect(() => {
    let active = true;
    const windowApi = window.flickfetch?.window;
    if (windowApi?.isMaximized) {
      windowApi.isMaximized().then(value => { if (active) setWindowMaximized(Boolean(value)); }).catch(() => {});
    }
    const unsubscribe = window.flickfetch?.on?.windowStateChanged?.(payload => {
      if (active) setWindowMaximized(Boolean(payload?.maximized));
    });
    return () => { active = false; unsubscribe?.(); };
  }, []);

  const minimizeWindow = () => window.flickfetch?.window?.minimize?.();
  const toggleMaximizeWindow = async () => {
    try {
      const value = await window.flickfetch?.window?.toggleMaximize?.();
      if (typeof value === 'boolean') setWindowMaximized(value);
    } catch (error) { showToast('error', 'Window action failed', error.message); }
  };
  const closeWindow = () => window.flickfetch?.window?.close?.();

  // Ask for a review only after about 30 minutes of accumulated use. The main process persists submissions,
  // snoozes and "never ask again" per installation; randomized checks avoid prompting everyone at once.
  useEffect(() => {
    if (reviewOpen || !window.flickfetch?.monitor?.maybePromptReview) return undefined;
    let timer = null;
    let cancelled = false;
    const check = async () => {
      try {
        const reviewState = await window.flickfetch.monitor.maybePromptReview();
        if (cancelled || reviewState?.stopChecking) return;
        if (reviewState?.shouldPrompt) {
          await window.flickfetch.monitor.markReviewPromptShown?.();
          if (cancelled) return;
          setReviewAuto(true);
          setReviewOpen(true);
          return;
        }
        const requested = Number(reviewState?.nextCheckAfterMs);
        const delay = Number.isFinite(requested) && requested > 0 ? Math.max(60_000, Math.min(24 * 60 * 60 * 1000, requested)) : Math.round((12 + Math.random() * 18) * 60_000);
        if (!cancelled) timer = setTimeout(check, delay);
      } catch { if (!cancelled) timer = setTimeout(check, 30 * 60_000); }
    };
    timer = setTimeout(check, Math.round((4 + Math.random() * 5) * 60_000));
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [reviewOpen]);

  const showToast = useCallback((type, title, message) => {
    setToast({ type, title, message });
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => setToast(null), 4300);
  }, []);

  const applySnapshot = useCallback(snapshot => {
    if (!snapshot) return;
    if (Array.isArray(snapshot.items)) setItems(snapshot.items);
    if (typeof snapshot.running === 'boolean') setQueueRunning(snapshot.running);
  }, []);

  const refreshTools = useCallback(async () => {
    const status = await window.flickfetch.tools.status();
    setToolStatus(status);
    return status;
  }, []);

  // Ask for the latest yt-dlp release whenever the installed version changes (cached in the main process).
  const installedYtDlp = toolStatus?.ytDlp?.installed ? (toolStatus.ytDlp.version || 'installed') : null;
  useEffect(() => {
    if (!installedYtDlp) { setYtUpdate(null); return undefined; }
    let active = true;
    window.flickfetch.tools.checkYtDlpUpdate?.()
      .then(result => { if (active) setYtUpdate(result); })
      .catch(() => { if (active) setYtUpdate(null); });
    return () => { active = false; };
  }, [installedYtDlp]);

  useEffect(() => {
    let active = true;
    const initialize = async () => {
      try {
        const [saved, snapshot, info] = await Promise.all([
          window.flickfetch.settings.get(),
          window.flickfetch.downloads.snapshot(),
          window.flickfetch.app.getInfo()
        ]);
        if (!active) return;
        setSettings(saved);
        applySnapshot(snapshot);
        setAppInfo(info);
        try { const updateState = await window.flickfetch.updater?.check?.(); if (active && updateState) setUpdaterInfo(updateState); }
        catch { if (active) setUpdaterInfo({ supported: false, updateAvailable: false, status: 'offline' }); }
        try { await refreshTools(); }
        catch (error) { showToast('warning', 'Tool status unavailable', error.message); }
      } catch (error) {
        if (active) showToast('error', 'FlickFetch could not initialize', error.message);
      } finally {
        if (active) {
          setIsReady(true);
          try { window.flickfetch.app.signalReady(); } catch { /* Browser preview does not expose Electron IPC. */ }
          if (!localStorage.getItem('flickfetch-guide-v1')) setGuideOpen(true);
        }
      }
    };
    initialize();
    const offDownloads = window.flickfetch.on.downloadsChanged(payload => applySnapshot(payload.snapshot || payload));
    const offQueue = window.flickfetch.on.queueState(payload => setQueueRunning(Boolean(payload.running)));
    const offToolProgress = window.flickfetch.on.toolsProgress(payload => setToolsProgress(payload));
    const offToolsChanged = window.flickfetch.on.toolsChanged?.(() => { refreshTools().catch(() => {}); }) || (() => {});
    const offClipboard = window.flickfetch.on.clipboardDetected(payload => setClipboardSuggestion(payload.urls || []));
    const offLogs = window.flickfetch.on.appLog(payload => { if (payload.level === 'error') showToast('error', 'Background task', payload.message); });
    const offUpdater = window.flickfetch.on.updaterStatus?.(payload => { if (active) setUpdaterInfo(payload); }) || (() => {});
    const offUpdaterProgress = window.flickfetch.on.updaterProgress?.(payload => { if (active) setUpdaterProgress(prev => ({ totalChunks: prev?.totalChunks, missingChunks: prev?.missingChunks, ...payload })); }) || (() => {});
    return () => { active = false; offDownloads(); offQueue(); offToolProgress(); offToolsChanged(); offClipboard(); offLogs(); offUpdater(); offUpdaterProgress(); };
  }, [applySnapshot, refreshTools, showToast]);

  useEffect(() => {
    const onKeyDown = event => {
      if ((event.ctrlKey || event.metaKey) && event.key === ',') { event.preventDefault(); setSettingsOpen(true); }
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') { event.preventDefault(); setSidebarCompact(value => !value); }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'g') { event.preventDefault(); setGuideOpen(true); }
      if (event.key === 'Escape') setGuideOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const updateSettings = async values => {
    try {
      const next = await window.flickfetch.settings.update(values);
      setSettings(next);
      showToast('success', 'Preferences saved', 'Your download profile has been updated.');
      return next;
    } catch (error) { showToast('error', 'Settings could not be saved', error.message); throw error; }
  };

  const openSpotify = url => {
    const value = String(url || '').trim();
    setSpotifyRequest(current => ({ url: value, sequence: current.sequence + 1 }));
    setScreen('spotify');
  };

  const addUrls = async urls => {
    const entries = (urls || []).map(value => String(value || '').trim()).filter(Boolean);
    const spotifyLinks = entries.filter(value => /spotify\.(com|link|app\.link)/i.test(value) || /^spotify:playlist:/i.test(value));
    if (spotifyLinks.length) {
      if (entries.length !== 1) {
        showToast('error', 'Import one Spotify link at a time', 'Open the Spotify matcher separately from other media downloads.');
        return [];
      }
      openSpotify(spotifyLinks[0]);
      showToast('info', 'Spotify playlist detected', 'The public playlist import has been opened for review.');
      return [];
    }
    try {
      const added = await window.flickfetch.downloads.add(entries);
      const snapshot = await window.flickfetch.downloads.snapshot();
      applySnapshot(snapshot);
      if (added?.length) setSelectedId(added[0].id);
      showToast('success', 'Added to download queue', `${added?.length || 0} item${added?.length === 1 ? '' : 's'} added.`);
      return added;
    } catch (error) { showToast('error', 'Could not add link', error.message); return []; }
  };

  const updateYtDlpNow = async () => {
    if (updatingYtDlp) return;
    setUpdatingYtDlp(true);
    try {
      const result = await window.flickfetch.tools.updateYtDlp();
      if (result?.status) setToolStatus(result.status); else await refreshTools();
      showToast('success', 'yt-dlp updated', result?.output || 'You are on the latest version.');
    } catch (error) { showToast('error', 'Update failed', error.message); }
    finally { setUpdatingYtDlp(false); }
  };

  // Runs a forced release check and reports the outcome inside the update dialog (no toast needed).
  const runUpdateCheck = async () => {
    if (checkingAppUpdate || updatingApp) return;
    setCheckingAppUpdate(true); setUpdateError('');
    try {
      const result = await window.flickfetch.updater.check({ force: true });
      setUpdaterInfo(result);
    } catch (error) { setUpdateError(error?.message || 'The FlickFetch Monitor could not be reached.'); }
    finally { setCheckingAppUpdate(false); }
  };

  const openUpdateDialog = () => { setUpdateOpen(true); runUpdateCheck(); };
  const closeUpdateDialog = useCallback(() => setUpdateOpen(false), []);

  const installFlickFetchUpdate = async () => {
    if (updatingApp) return;
    setUpdatingApp(true);
    setUpdaterProgress({ phase: 'prepare', percent: 0 });
    try {
      const result = await window.flickfetch.updater.install();
      if (result?.downloaded) {
        // Installed builds cannot replace themselves: the verified release is saved and shown in its folder.
        setUpdatingApp(false); setUpdaterProgress(null);
        setDownloadedUpdate({ version: result.version, filePath: result.filePath, transfer: result.transfer });
        window.flickfetch.app.revealPath?.(result.filePath)?.catch?.(() => {});
        showToast('success', 'Update downloaded', `FlickFetch ${result.version} was verified and saved${result.transfer ? `. ${describeTransfer(result.transfer)}` : ''}. Close FlickFetch, then open the new file to switch.`);
      }
    } catch (error) { setUpdatingApp(false); setUpdaterProgress(null); showToast('error', downloadMode ? 'Update download failed' : 'FlickFetch update failed', error.message); }
  };

  const showDownloadedUpdate = () => { if (downloadedUpdate?.filePath) window.flickfetch.app.revealPath?.(downloadedUpdate.filePath)?.catch?.(() => showToast('warning', 'File not found', 'The downloaded update is no longer in that folder.')); };

  const startQueue = async () => { const snapshot = await window.flickfetch.downloads.start(); applySnapshot(snapshot); };
  const pauseQueue = async () => { const snapshot = await window.flickfetch.downloads.pause(); applySnapshot(snapshot); };
  const stopAll = async () => { const snapshot = await window.flickfetch.downloads.stopAll(); applySnapshot(snapshot); showToast('info', 'Stopping downloads', 'Cancellation has been requested for active and queued items.'); };
  const retry = async id => { try { await window.flickfetch.downloads.retry(id); const snapshot = await window.flickfetch.downloads.snapshot(); applySnapshot(snapshot); } catch (error) { showToast('error', 'Retry failed', error.message); } };
  const remove = async id => { const result = await window.flickfetch.downloads.remove(id); if (result) { const snapshot = await window.flickfetch.downloads.snapshot(); applySnapshot(snapshot); if (selectedId === id) setSelectedId(null); } };
  const clearFinished = async () => { const snapshot = await window.flickfetch.downloads.clearFinished(); applySnapshot(snapshot); if (selectedId && !snapshot.items.some(item => item.id === selectedId)) setSelectedId(null); };
  const revealPath = async filePath => { try { await window.flickfetch.app.revealPath(filePath); } catch (error) { showToast('error', 'Could not open folder', error.message); } };

  const handleDrop = async event => {
    event.preventDefault();
    setDragActive(false);
    const collected = [];
    for (const file of Array.from(event.dataTransfer?.files || [])) {
      const name = String(file.name || '').toLowerCase();
      if (name.endsWith('.txt')) collected.push(await file.text());
      else if (name.endsWith('.url')) {
        const text = await file.text();
        const match = /^\s*URL\s*=\s*(https?:\/\/\S+)\s*$/im.exec(text);
        if (match) collected.push(match[1]);
      }
    }
    if (!collected.length) collected.push(event.dataTransfer?.getData('text/uri-list') || '', event.dataTransfer?.getData('text/plain') || '');
    const links = [...new Set(collected.flatMap(value => String(value || '').split(/[\s<>"']+/).map(item => item.trim()).filter(item => /^https?:\/\/\S+$/i.test(item) || /^ytsearch\d*:.+$/i.test(item))))];
    if (links.length) await addUrls(links);
    else showToast('info', 'No media links found', 'Drop URL text, a supported media link, or a .txt / .url link-list file.');
  };

  const activeCount = useMemo(() => items.filter(item => ['Starting', 'Downloading', 'Processing'].includes(item.status)).length, [items]);
  const completedCount = useMemo(() => items.filter(item => item.status === 'Done').length, [items]);
  const historyCount = useMemo(() => items.filter(item => ['Done', 'Failed', 'Canceled'].includes(item.status)).length, [items]);
  const navigate = destination => {
    if (destination === 'settings') { setSettingsOpen(true); return; }
    setScreen(destination);
  };

  return (
    <div className="app-shell" onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragActive(true); }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDragActive(false); }} onDrop={handleDrop}>
      <header className="window-chrome drag-region" onDoubleClick={event => { if (!event.target.closest('.no-drag')) toggleMaximizeWindow(); }}>
        <div className="chrome-brand no-drag">
          <div className="chrome-brand-mark"><span>F</span></div>
          <span className="chrome-brand-name">FlickFetch</span>
        </div>
        <div className="chrome-drag-space" />
        <div className="chrome-actions no-drag">
          <div className={`engine-chip ${toolStatus?.ytDlp?.installed ? 'is-online' : 'is-offline'}`}><span />{toolStatus?.ytDlp?.installed ? 'Engine ready' : 'Engine setup'}</div>
          <button className="chrome-action-button" onClick={() => setGuideOpen(true)} title="Interactive guide" aria-label="Open help"><LifeBuoy size={15} /></button>
          <button className="chrome-action-button" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Open settings"><Settings size={15} /></button>
        </div>
        <div className="window-controls no-drag" aria-label="Window controls">
          <button onClick={minimizeWindow} title="Minimize" aria-label="Minimize window"><Minus size={15} /></button>
          <button onClick={toggleMaximizeWindow} title={windowMaximized ? 'Restore' : 'Maximize'} aria-label={windowMaximized ? 'Restore window' : 'Maximize window'}>{windowMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
          <button className="window-close" onClick={closeWindow} title="Close" aria-label="Close window"><X size={16} /></button>
        </div>
      </header>
      <div className="app-body">
      <aside className={`sidebar ${sidebarCompact ? 'sidebar-compact' : ''}`} data-collapsed={sidebarCompact}>
        <button type="button" className="sidebar-toggle" onClick={toggleSidebar} title={`${sidebarCompact ? 'Expand' : 'Collapse'} sidebar (Ctrl B)`} aria-label={sidebarCompact ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!sidebarCompact} aria-controls="sidebar-content">
          {sidebarCompact ? <ChevronRight size={14} strokeWidth={2.4} /> : <ChevronLeft size={14} strokeWidth={2.4} />}
        </button>
        <div className="sidebar-inner" id="sidebar-content">
          <div className="sidebar-header">
            <div className="sidebar-brand">
              <div className="brand-symbol"><span>F</span><i /></div>
              <div className="brand-wordmark"><strong>FlickFetch</strong><span>MEDIA WORKSPACE</span></div>
            </div>
          </div>

          <div className="sidebar-scroll">
          <div className="sidebar-section-label">WORKSPACE</div>
          <nav className="sidebar-nav" aria-label="Workspace">
            <button onClick={() => setScreen('downloads')} className={`nav-item ${screen === 'downloads' ? 'nav-item-active' : ''}`} title="Downloads" aria-label="Downloads" aria-current={screen === 'downloads' ? 'page' : undefined}><span className="nav-icon"><Download size={17} />{activeCount > 0 && <i className="nav-dot" />}</span><span className="nav-label">Downloads</span>{activeCount > 0 && <span className="nav-count">{activeCount}</span>}</button>
            <button onClick={() => setScreen('spotify')} className={`nav-item ${screen === 'spotify' ? 'nav-item-active' : ''}`} title="Spotify matcher" aria-label="Spotify matcher" aria-current={screen === 'spotify' ? 'page' : undefined}><span className="nav-icon"><Music2 size={17} /></span><span className="nav-label">Spotify matcher</span></button>
            <button onClick={() => setScreen('history')} className={`nav-item ${screen === 'history' ? 'nav-item-active' : ''}`} title="History" aria-label="History" aria-current={screen === 'history' ? 'page' : undefined}><span className="nav-icon"><History size={17} /></span><span className="nav-label">History</span><span className="nav-meta">{historyCount}</span></button>
          </nav>

          <div className="sidebar-divider" />
          <div className="sidebar-section-label">PREFERENCES</div>
          <nav className="sidebar-nav" aria-label="Preferences">
            <button onClick={() => setSettingsOpen(true)} className="nav-item" title="Settings (Ctrl ,)" aria-label="Settings"><span className="nav-icon"><Settings size={17} /></span><span className="nav-label">Settings</span><kbd>Ctrl ,</kbd></button>
            <button onClick={() => setGuideOpen(true)} className="nav-item" title="Interactive guide (Ctrl Shift G)" aria-label="Interactive guide"><span className="nav-icon"><CircleHelp size={17} /></span><span className="nav-label">Interactive guide</span><kbd>Ctrl ⇧ G</kbd></button>
            <button onClick={() => setAboutOpen(true)} className="nav-item" title="About FlickFetch" aria-label="About FlickFetch"><span className="nav-icon"><Sparkles size={17} /></span><span className="nav-label">About FlickFetch</span></button>
            <button onClick={openUpdateDialog} className="nav-item" title="Check for FlickFetch updates" aria-label="Check for FlickFetch updates"><span className="nav-icon"><Download size={17} /></span><span className="nav-label">Check for updates</span></button>
            <button onClick={() => { setReviewAuto(false); setReviewOpen(true); }} className="nav-item" title="Review FlickFetch" aria-label="Review FlickFetch"><span className="nav-icon"><Star size={17} /></span><span className="nav-label">Review FlickFetch</span></button>
          </nav>

          </div>

          <div className="sidebar-footer">
          {updaterInfo?.updateAvailable && (
            <div className="engine-card engine-ready engine-update app-release-card">
              <div className="engine-card-top"><span className="engine-pulse" /><span>FLICKFETCH UPDATE</span><Download size={14} /></div>
              <strong>Version {updaterInfo.latestVersion}</strong>
              <p>{updaterInfo.notes || (downloadMode ? 'A newer release is ready. FlickFetch downloads and verifies it, then you open the new file.' : 'A newer FlickFetch release is ready to install.')}</p>
              {updatingApp && <div className="app-update-progress" role="status" aria-live="polite"><div><span>{UPDATE_PHASES[updaterProgress?.phase] || 'Preparing'}</span><b>{Math.max(0, Math.min(100, Number(updaterProgress?.percent || 0)))}%</b></div><progress max="100" value={Math.max(0, Math.min(100, Number(updaterProgress?.percent || 0)))} /></div>}
              {updateSaved && !updatingApp
                ? <><p>Saved and verified. Close FlickFetch, then open the new file to switch.</p><button onClick={showDownloadedUpdate}>Show in folder <ArrowUpRight size={14} /></button></>
                : !updaterInfo.installMode
                  ? <button onClick={openUpdateDialog}>View details <ArrowUpRight size={14} /></button>
                  : <button onClick={installFlickFetchUpdate} disabled={updatingApp}>{updatingApp ? (downloadMode ? 'Downloading…' : 'Installing update…') : (downloadMode ? 'Download update' : 'Update FlickFetch')} <ArrowUpRight size={14} /></button>}
            </div>
          )}
          {/* Only shown when there is something to act on: yt-dlp missing, or a newer release than the installed one. */}
          {toolStatus && !toolStatus.ytDlp?.installed && (
            <div className="engine-card engine-setup">
              <div className="engine-card-top"><span className="engine-pulse" /><span>SETUP REQUIRED</span><Activity size={14} /></div>
              <strong>Prepare your tools</strong>
              <p>Install yt-dlp and helper tools to get started.</p>
              <button onClick={() => setSettingsOpen(true)}>Manage tools <ArrowUpRight size={14} /></button>
            </div>
          )}
          {toolStatus?.ytDlp?.installed && ytUpdate?.updateAvailable && (
            <div className="engine-card engine-ready engine-update">
              <div className="engine-card-top"><span className="engine-pulse" /><span>UPDATE AVAILABLE</span><Download size={14} /></div>
              <strong>yt-dlp {ytUpdate.latest}</strong>
              <p>You have {ytUpdate.current}. Updating keeps downloads working.</p>
              <button onClick={updateYtDlpNow} disabled={updatingYtDlp}>{updatingYtDlp ? 'Updating…' : 'Update now'} <ArrowUpRight size={14} /></button>
            </div>
          )}
          <div className="sidebar-user" title={`FlickFetch desktop · v${appInfo.version || '2.1.1'}`}>
            <div className="sidebar-avatar">FF</div>
            <div className="sidebar-user-copy"><strong>FlickFetch desktop</strong><span>Version {appInfo.version || '2.1.1'}</span></div>
            <ShieldCheck size={15} className="sidebar-security" />
          </div>
          </div>
        </div>
      </aside>

      <main className="app-main">
        {clipboardSuggestion.length > 0 && <div className="clipboard-banner"><Notice tone="info" onDismiss={() => setClipboardSuggestion([])}><div className="clipboard-banner-content"><span>Media link{clipboardSuggestion.length > 1 ? 's' : ''} detected in your clipboard ({clipboardSuggestion.length}).</span><div><button onClick={async () => { await addUrls(clipboardSuggestion); setClipboardSuggestion([]); }}>Add to queue</button><button className="clipboard-dismiss" onClick={() => setClipboardSuggestion([])}>Dismiss</button></div></div></Notice></div>}

        <div className="workspace-host" key={screen}>
          {screen === 'downloads' && <DownloadsWorkspace items={items} queueRunning={queueRunning} settings={settings} onSettingsChange={updateSettings} onAddUrls={addUrls} onStart={startQueue} onPause={pauseQueue} onStopAll={stopAll} onRetry={retry} onRemove={remove} onClearFinished={clearFinished} selectedId={selectedId} onSelectItem={setSelectedId} onOpenPath={revealPath} onOpenSettings={() => setSettingsOpen(true)} onSpotify={openSpotify} />}
          {screen === 'spotify' && <SpotifyWorkspace initialRequest={spotifyRequest} toolStatus={toolStatus} onToast={showToast} onOpenDownloads={() => setScreen('downloads')} onOpenSettings={() => setSettingsOpen(true)} />}
          {screen === 'history' && <HistoryWorkspace items={items} onRetry={retry} onRemove={remove} onOpenPath={revealPath} onSelectItem={id => { setSelectedId(id); setScreen('downloads'); }} />}
        </div>

        <PreviewBar />

        <footer className="app-statusbar"><div className="statusbar-left"><span className="statusbar-live"><i />{activeCount ? `${activeCount} task${activeCount === 1 ? '' : 's'} running` : 'All caught up'}</span><span className="status-separator" />{completedCount} completed <span className="status-separator" />{toolStatus?.complete ? 'All helper tools installed' : 'Helper tools may need setup'}</div><div className="statusbar-right"><span className="status-version">v{appInfo.version || '2.1.1'}</span></div></footer>
      </main>
      </div>

      {settingsOpen && <SettingsDialog initialSettings={settings} toolStatus={toolStatus} toolsProgress={toolsProgress} onClose={() => setSettingsOpen(false)} onSave={updateSettings} onRefreshTools={refreshTools} onInstallTools={() => window.flickfetch.tools.install({ ytDlp: true, ffmpeg: true, deno: true })} onUpdateYtDlp={() => window.flickfetch.tools.updateYtDlp()} />}
      {guideOpen && <GuideDialog onClose={() => setGuideOpen(false)} onNavigate={navigate} onAddUrls={addUrls} />}
      {updateOpen && <UpdateDialog info={updaterInfo} appInfo={appInfo} checking={checkingAppUpdate} error={updateError} installing={updatingApp} progress={updaterProgress} savedUpdate={updateSaved ? downloadedUpdate : null} onCheck={runUpdateCheck} onInstall={installFlickFetchUpdate} onReveal={showDownloadedUpdate} onClose={closeUpdateDialog} />}
      {aboutOpen && <AboutDialog appInfo={appInfo} toolStatus={toolStatus} ytUpdate={ytUpdate} onClose={() => setAboutOpen(false)} onOpenTools={() => { setAboutOpen(false); setSettingsOpen(true); }} onOpenGuide={() => { setAboutOpen(false); setGuideOpen(true); }} onOpenReview={() => { setAboutOpen(false); setReviewAuto(false); setReviewOpen(true); }} />}
      {reviewOpen && <ReviewDialog auto={reviewAuto} onClose={() => setReviewOpen(false)} onSubmitted={result => (result?.delivered === false || result?.queued) ? showToast('info', 'Review saved', 'Your review is stored securely on this device and will be sent to the FlickFetch Monitor as soon as it is reachable.') : showToast('success', 'Thank you for your review', 'Your feedback was sent to the FlickFetch Monitor.')} />}
      <Toast toast={toast} onClose={() => setToast(null)} />
      {dragActive && <div className="drop-overlay"><div className="drop-overlay-card"><div className="drop-overlay-icon"><Download size={24} /></div><strong>Drop to add to your queue</strong><span>Media URLs, URL text, or .txt / .url link-list files</span></div></div>}
      {!isReady && <div className="renderer-fallback"><div className="renderer-spinner" /><span>Preparing your workspace…</span></div>}
    </div>
  );
}

export default App;
