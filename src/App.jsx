import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowUpRight, CircleHelp, Download, FolderOpen, HardDrive,
  History, LifeBuoy, ListMusic, Music2, Settings, ShieldCheck, Sparkles,
  Video, X, Command, ChevronRight, Gauge, PanelLeftClose
} from 'lucide-react';
import DownloadsWorkspace from './components/DownloadsWorkspace.jsx';
import SpotifyWorkspace from './components/SpotifyWorkspace.jsx';
import HistoryWorkspace from './components/HistoryWorkspace.jsx';
import SettingsDialog from './components/SettingsDialog.jsx';
import GuideDialog from './components/GuideDialog.jsx';
import { Notice, Toast } from './components/Primitives.jsx';

const emptySettings = {
  outputDir: '', preset: 0, customFormat: '', container: 'mp4', preferCompat: false, audioFormat: 'mp3', audioQuality: '0', playlist: false,
  subs: false, autoSubs: false, embedSubs: true, subLangs: 'en.*', embedThumb: true, embedMeta: true, sponsor: false,
  template: '%(title).150B [%(id)s].%(ext)s', restrict: false, overwrite: false, infoJson: false, description: false, writeThumb: false, useArchive: false,
  sectionStart: '', sectionEnd: '', cookiesBrowser: '', cookiesFile: '', proxy: '', rateLimit: '', fragments: 4, retries: 10, parallel: 2,
  extraArgs: '', autoStart: true, watchClipboard: false, autoUpdate: true
};

const screenMeta = {
  downloads: { label: 'Downloads', eyebrow: 'MEDIA WORKSPACE', description: 'Your media, in motion.' },
  spotify: { label: 'Spotify matcher', eyebrow: 'PLAYLIST WORKFLOW', description: 'Find, review, and curate matches.' },
  history: { label: 'History', eyebrow: 'YOUR LIBRARY', description: 'Everything you have processed.' }
};

function App() {
  const [screen, setScreen] = useState('downloads');
  const [settings, setSettings] = useState(emptySettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [toolStatus, setToolStatus] = useState(null);
  const [toolsProgress, setToolsProgress] = useState(null);
  const [items, setItems] = useState([]);
  const [queueRunning, setQueueRunning] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [toast, setToast] = useState(null);
  const [clipboardSuggestion, setClipboardSuggestion] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  const [spotifyRequest, setSpotifyRequest] = useState({ url: '', sequence: 0 });
  const [aboutOpen, setAboutOpen] = useState(false);
  const [appInfo, setAppInfo] = useState({ version: '2.1.0' });
  const [isReady, setIsReady] = useState(false);
  const [sidebarCompact, setSidebarCompact] = useState(false);

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
    const offClipboard = window.flickfetch.on.clipboardDetected(payload => setClipboardSuggestion(payload.urls || []));
    const offLogs = window.flickfetch.on.appLog(payload => { if (payload.level === 'error') showToast('error', 'Background task', payload.message); });
    return () => { active = false; offDownloads(); offQueue(); offToolProgress(); offClipboard(); offLogs(); };
  }, [applySnapshot, refreshTools, showToast]);

  useEffect(() => {
    const onKeyDown = event => {
      if ((event.ctrlKey || event.metaKey) && event.key === ',') { event.preventDefault(); setSettingsOpen(true); }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'g') { event.preventDefault(); setGuideOpen(true); }
      if (event.key === 'Escape') { setAboutOpen(false); setGuideOpen(false); }
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
  const meta = screenMeta[screen] || screenMeta.downloads;

  const navigate = destination => {
    if (destination === 'settings') { setSettingsOpen(true); return; }
    setScreen(destination);
  };

  return (
    <div className="app-shell" onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragActive(true); }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDragActive(false); }} onDrop={handleDrop}>
      <aside className={`sidebar ${sidebarCompact ? 'sidebar-compact' : ''}`}>
        <div className="sidebar-brand">
          <div className="brand-symbol"><span>F</span><i /></div>
          {!sidebarCompact && <div className="brand-wordmark"><strong>FlickFetch</strong><span>MEDIA WORKSPACE</span></div>}
          <button className="sidebar-collapse" title={sidebarCompact ? 'Expand sidebar' : 'Collapse sidebar'} onClick={() => setSidebarCompact(value => !value)}><PanelLeftClose size={16} /></button>
        </div>

        <div className="sidebar-section-label">WORKSPACE</div>
        <nav className="sidebar-nav" aria-label="Workspace">
          <button onClick={() => setScreen('downloads')} className={`nav-item ${screen === 'downloads' ? 'nav-item-active' : ''}`} title="Downloads"><span className="nav-icon"><Download size={17} /></span>{!sidebarCompact && <><span>Downloads</span>{activeCount > 0 && <span className="nav-count">{activeCount}</span>}</>}</button>
          <button onClick={() => setScreen('spotify')} className={`nav-item ${screen === 'spotify' ? 'nav-item-active' : ''}`} title="Spotify matcher"><span className="nav-icon"><Music2 size={17} /></span>{!sidebarCompact && <span>Spotify matcher</span>}</button>
          <button onClick={() => setScreen('history')} className={`nav-item ${screen === 'history' ? 'nav-item-active' : ''}`} title="History"><span className="nav-icon"><History size={17} /></span>{!sidebarCompact && <><span>History</span><span className="nav-meta">{historyCount}</span></>}</button>
        </nav>

        <div className="sidebar-divider" />
        <div className="sidebar-section-label">PREFERENCES</div>
        <nav className="sidebar-nav" aria-label="Preferences">
          <button onClick={() => setSettingsOpen(true)} className="nav-item" title="Settings"><span className="nav-icon"><Settings size={17} /></span>{!sidebarCompact && <><span>Settings</span><kbd>Ctrl ,</kbd></>}</button>
          <button onClick={() => setGuideOpen(true)} className="nav-item" title="Interactive guide"><span className="nav-icon"><CircleHelp size={17} /></span>{!sidebarCompact && <><span>Interactive guide</span><kbd>Ctrl ⇧ G</kbd></>}</button>
          <button onClick={() => setAboutOpen(true)} className="nav-item" title="About FlickFetch"><span className="nav-icon"><Sparkles size={17} /></span>{!sidebarCompact && <span>About FlickFetch</span>}</button>
        </nav>

        <div className="sidebar-spacer" />
        {!sidebarCompact && <div className={`engine-card ${toolStatus?.ytDlp?.installed ? 'engine-ready' : 'engine-setup'}`}>
          <div className="engine-card-top"><span className="engine-pulse" /><span>{toolStatus?.ytDlp?.installed ? 'ENGINE ONLINE' : 'SETUP REQUIRED'}</span><Activity size={14} /></div>
          <strong>{toolStatus?.ytDlp?.installed ? 'Ready to download' : 'Prepare your tools'}</strong>
          <p>{toolStatus?.ytDlp?.installed ? `yt-dlp ${toolStatus.ytDlp.version || 'installed'} is available.` : 'Install yt-dlp and helper tools to get started.'}</p>
          <button onClick={() => setSettingsOpen(true)}>Manage tools <ArrowUpRight size={14} /></button>
        </div>}
        <div className="sidebar-user">
          <div className="sidebar-avatar">FF</div>
          {!sidebarCompact && <div className="sidebar-user-copy"><strong>FlickFetch desktop</strong><span>Version {appInfo.version || '2.1.0'}</span></div>}
          <ShieldCheck size={15} className="sidebar-security" />
        </div>
      </aside>

      <main className="app-main">
        <header className="topbar drag-region">
          <div className="topbar-left no-drag">
            <div className="breadcrumb"><span>FlickFetch</span><ChevronRight size={14} /><strong>{meta.label}</strong></div>
            <div className="topbar-context"><span className="context-dot" />{activeCount ? `${activeCount} active ${activeCount === 1 ? 'task' : 'tasks'}` : 'Your workspace is ready'}</div>
          </div>
          <div className="topbar-actions no-drag">
            <div className={`engine-chip ${toolStatus?.ytDlp?.installed ? 'is-online' : 'is-offline'}`}><span />{toolStatus?.ytDlp?.installed ? 'Engine ready' : 'Engine setup'}</div>
            <button className="topbar-help" onClick={() => setGuideOpen(true)}><LifeBuoy size={15} /><span>Help</span></button>
            <button className="topbar-settings" onClick={() => setSettingsOpen(true)} aria-label="Open settings"><Settings size={17} /></button>
          </div>
        </header>

        {clipboardSuggestion.length > 0 && <div className="clipboard-banner"><Notice tone="info" onDismiss={() => setClipboardSuggestion([])}><div className="clipboard-banner-content"><span>Media link{clipboardSuggestion.length > 1 ? 's' : ''} detected in your clipboard ({clipboardSuggestion.length}).</span><div><button onClick={async () => { await addUrls(clipboardSuggestion); setClipboardSuggestion([]); }}>Add to queue</button><button className="clipboard-dismiss" onClick={() => setClipboardSuggestion([])}>Dismiss</button></div></div></Notice></div>}

        <div className="workspace-host" key={screen}>
          {screen === 'downloads' && <DownloadsWorkspace items={items} queueRunning={queueRunning} settings={settings} onSettingsChange={updateSettings} onAddUrls={addUrls} onStart={startQueue} onPause={pauseQueue} onStopAll={stopAll} onRetry={retry} onRemove={remove} onClearFinished={clearFinished} selectedId={selectedId} onSelectItem={setSelectedId} onOpenPath={revealPath} onOpenSettings={() => setSettingsOpen(true)} onSpotify={openSpotify} />}
          {screen === 'spotify' && <SpotifyWorkspace initialRequest={spotifyRequest} toolStatus={toolStatus} onToast={showToast} onOpenDownloads={() => setScreen('downloads')} />}
          {screen === 'history' && <HistoryWorkspace items={items} onRetry={retry} onRemove={remove} onOpenPath={revealPath} onSelectItem={id => { setSelectedId(id); setScreen('downloads'); }} />}
        </div>

        <footer className="app-statusbar"><div className="statusbar-left"><span className="statusbar-live"><i />{activeCount ? `${activeCount} task${activeCount === 1 ? '' : 's'} running` : 'All caught up'}</span><span className="status-separator" />{completedCount} completed <span className="status-separator" />{toolStatus?.complete ? 'All helper tools installed' : 'Helper tools may need setup'}</div><div className="statusbar-right"><span>React · Electron · Tailwind</span><span className="status-version">v{appInfo.version || '2.1.0'}</span></div></footer>
      </main>

      {settingsOpen && <SettingsDialog initialSettings={settings} toolStatus={toolStatus} toolsProgress={toolsProgress} onClose={() => setSettingsOpen(false)} onSave={updateSettings} onRefreshTools={refreshTools} onInstallTools={() => window.flickfetch.tools.install({ ytDlp: true, ffmpeg: true, deno: true })} onUpdateYtDlp={() => window.flickfetch.tools.updateYtDlp()} />}
      {guideOpen && <GuideDialog onClose={() => setGuideOpen(false)} onNavigate={navigate} onAddUrls={addUrls} />}
      {aboutOpen && <div className="about-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setAboutOpen(false); }}><div className="about-dialog"><div className="about-head"><div className="about-logo">F</div><div><h2>FlickFetch</h2><span>MEDIA WORKSPACE</span></div><button className="icon-button" onClick={() => setAboutOpen(false)}><X size={17} /></button></div><p>A desktop media download manager powered by yt-dlp, FFmpeg, and Deno. Manage downloads, review public Spotify playlist matches, and keep your media workflow organized in one place.</p><div className="about-facts"><div><span>VERSION</span><strong>{appInfo.version || '2.1.0'}</strong></div><div><span>PLATFORM</span><strong>{appInfo.platform || 'Desktop'}</strong></div><div><span>BUILT WITH</span><strong>React · Electron</strong></div></div><div className="about-legal"><strong>Copyright © 2026 Jessie Albert Regualos</strong><p>Third-party tools retain their own copyrights and licenses. Review THIRD-PARTY-NOTICES.md before distributing.</p></div><button onClick={() => { setAboutOpen(false); setSettingsOpen(true); }} className="btn-primary about-tools"><HardDrive size={15} /> Manage downloader tools</button></div></div>}
      <Toast toast={toast} onClose={() => setToast(null)} />
      {dragActive && <div className="drop-overlay"><div className="drop-overlay-card"><div className="drop-overlay-icon"><Download size={24} /></div><strong>Drop to add to your queue</strong><span>Media URLs, URL text, or .txt / .url link-list files</span></div></div>}
      {!isReady && <div className="renderer-fallback"><div className="renderer-spinner" /><span>Preparing your workspace…</span></div>}
    </div>
  );
}

export default App;
