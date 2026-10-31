import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, AudioLines, Check, CheckCircle2, ClipboardCopy, ClipboardPaste, Download, FileSearch, FolderOpen,
  ListVideo, Music2, Pause, Play, RotateCcw, Search, Settings2, SlidersHorizontal, Trash2, Video, X, XCircle
} from 'lucide-react';
import { formatBytes, formatEta, formatSpeed, safeHost, timeAgo } from '../lib/format.js';
import { Modal, Notice, ProgressBar } from './Primitives.jsx';
import DropdownSelect from './DropdownSelect.jsx';
import { ActionMenu, FilterTabs, Meter, Segmented, SwitchChip } from './ui.jsx';

const ACTIVE = ['Starting', 'Downloading', 'Processing'];
const AUDIO_PRESET = 7;
const CUSTOM_PRESET = 8;

const videoQualityOptions = [
  { value: 0, label: 'Best available' }, { value: 1, label: 'Up to 4K' }, { value: 2, label: 'Up to 1440p' },
  { value: 3, label: 'Up to 1080p' }, { value: 4, label: 'Up to 720p' }, { value: 5, label: 'Up to 480p' },
  { value: 6, label: 'Up to 360p' }, { value: CUSTOM_PRESET, label: 'Custom format' }
];
const containerOptions = [
  { value: 'mp4', label: 'MP4 · works everywhere' }, { value: 'mkv', label: 'MKV' }, { value: 'webm', label: 'WebM' }, { value: 'auto', label: 'Automatic' }
];
const audioOptions = [
  { value: 'mp3', label: 'MP3 · works everywhere' }, { value: 'm4a', label: 'M4A' }, { value: 'opus', label: 'Opus' },
  { value: 'flac', label: 'FLAC · lossless' }, { value: 'wav', label: 'WAV · lossless' }, { value: 'aac', label: 'AAC' },
  { value: 'vorbis', label: 'Vorbis' }, { value: 'best', label: 'Best available' }
];

const groupOf = status => ACTIVE.includes(status) ? 'active' : status === 'Queued' ? 'waiting' : status === 'Done' ? 'done' : status === 'Failed' ? 'failed' : 'canceled';
const isSpotifyLink = value => /spotify\.(com|link|app\.link)/i.test(value) || /^spotify:playlist:/i.test(value);

function StatusBadge({ status, paused, upNext }) {
  const label = status === 'Queued' ? (paused ? 'Paused' : upNext ? 'Up next' : 'Waiting') : status;
  return <span className={`ff-badge ff-badge-${groupOf(status)} ${status === 'Queued' && paused ? 'is-paused' : ''}`}><i aria-hidden="true" />{label}</span>;
}

function progressLine(item) {
  const parts = [];
  const progress = Number(item.progress);
  if (item.status === 'Processing') parts.push(item.stage || 'Processing file');
  else if (item.status === 'Starting') parts.push('Starting…');
  else {
    parts.push(progress >= 0 ? `${Math.round(progress)}%` : 'Preparing…');
    if (formatSpeed(item.speed) !== '—') parts.push(formatSpeed(item.speed));
    if (formatEta(item.eta) !== '—') parts.push(`${formatEta(item.eta)} left`);
  }
  if (item.playlistCount > 1) parts.push(`Item ${item.playlistIndex || 1} of ${item.playlistCount}`);
  return parts.join(' · ');
}

function QueueRow({ item, expanded, paused, upNext, onToggle, onRetry, onStop, onRemove, onOpenFolder }) {
  const group = groupOf(item.status);
  const isAudio = item.settingsSnapshot?.preset === AUDIO_PRESET;
  const progress = Number(item.progress);
  const Icon = group === 'done' ? CheckCircle2 : group === 'failed' ? AlertTriangle : isAudio ? AudioLines : Video;
  const [copied, setCopied] = useState('');
  const copy = async (key, text) => {
    try { await navigator.clipboard?.writeText(text); setCopied(key); window.setTimeout(() => setCopied(''), 1400); } catch { /* clipboard unavailable */ }
  };

  const subline = group === 'failed' && item.errorText
    ? <span className="ff-row-error">{item.errorText}</span>
    : <span className="ff-row-sub">{safeHost(item.url)}{item.status === 'Done' && item.finalSize ? ` · ${formatBytes(item.finalSize)}` : ''} · {isAudio ? 'Audio' : 'Video'} · {timeAgo(item.createdAt)}</span>;

  return (
    <li className={`ff-row is-${group} ${expanded ? 'is-open' : ''}`}>
      <div className="ff-row-line">
        <button type="button" className="ff-row-main" onClick={() => onToggle(item.id)} aria-expanded={expanded}>
          <span className="ff-row-icon" aria-hidden="true"><Icon size={18} /></span>
          <span className="ff-row-body">
            <span className="ff-row-title">{item.title || item.url}</span>
            {group === 'active' ? <span className="ff-row-sub">{safeHost(item.url)} · {isAudio ? 'Audio' : 'Video'}</span> : subline}
          </span>
        </button>
        <StatusBadge status={item.status} paused={paused} upNext={upNext} />
        <div className="ff-row-actions">
          {group === 'active' && <button type="button" className="ff-btn ff-btn-quiet" onClick={() => onStop(item.id)}><X size={15} aria-hidden="true" />Cancel</button>}
          {group === 'done' && item.filePath && <button type="button" className="ff-btn ff-btn-quiet" onClick={() => onOpenFolder(item.filePath)}><FolderOpen size={15} aria-hidden="true" />Show file</button>}
          {(group === 'failed' || group === 'canceled') && <button type="button" className="ff-btn ff-btn-soft" onClick={() => onRetry(item.id)}><RotateCcw size={15} aria-hidden="true" />Retry</button>}
          {group !== 'active' && <button type="button" className="ff-icon-btn" title="Remove from list" aria-label={`Remove ${item.title || 'download'} from list`} onClick={() => onRemove(item.id)}><Trash2 size={16} aria-hidden="true" /></button>}
        </div>
      </div>

      {group === 'active' && (
        <div className="ff-row-progress">
          <Meter value={progress >= 0 ? progress : 0} indeterminate={item.status === 'Starting' || progress < 0} />
          <span>{progressLine(item)}</span>
        </div>
      )}

      {expanded && (
        <div className="ff-row-detail">
          <dl>
            <div><dt>Link</dt><dd><span className="ff-mono">{item.url}</span><button type="button" className="ff-link" onClick={() => copy('url', item.url)}>{copied === 'url' ? <><Check size={13} />Copied</> : <><ClipboardCopy size={13} />Copy</>}</button></dd></div>
            {item.filePath && <div><dt>Saved to</dt><dd><span className="ff-mono">{item.filePath}</span><button type="button" className="ff-link" onClick={() => onOpenFolder(item.filePath)}><FolderOpen size={13} />Show in folder</button></dd></div>}
            {item.errorText && group !== 'failed' && <div><dt>Note</dt><dd>{item.errorText}</dd></div>}
          </dl>
          <div className="ff-log-head"><strong>Activity log</strong><button type="button" className="ff-link" onClick={() => copy('log', (item.logs || []).join('\n'))}>{copied === 'log' ? <><Check size={13} />Copied</> : <><ClipboardCopy size={13} />Copy log</>}</button></div>
          <pre className="ff-log scrollbar-thin">{(item.logs || []).join('\n') || 'Nothing has been logged for this download yet.'}</pre>
        </div>
      )}
    </li>
  );
}

export default function DownloadsWorkspace({ items, queueRunning, settings, onSettingsChange, onAddUrls, onStart, onPause, onStopAll, onRetry, onRemove, onClearFinished, selectedId, onSelectItem, onOpenPath, onOpenSettings, onSpotify }) {
  const [urlText, setUrlText] = useState('');
  const [adding, setAdding] = useState(false);
  const [inspect, setInspect] = useState(null);
  const [inspectBusy, setInspectBusy] = useState(false);
  const [inspectError, setInspectError] = useState('');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const textareaRef = useRef(null);
  const lastVideoPreset = useRef(Number(settings.preset) === AUDIO_PRESET ? 0 : Number(settings.preset) || 0);

  const urls = useMemo(() => urlText.split(/\r?\n/).map(value => value.trim()).filter(Boolean), [urlText]);
  const spotifyLinks = urls.filter(isSpotifyLink);
  const spotifyOnly = spotifyLinks.length === 1 && urls.length === 1;
  const spotifyMixed = spotifyLinks.length > 0 && !spotifyOnly;
  const mode = Number(settings.preset) === AUDIO_PRESET ? 'audio' : 'video';
  if (mode === 'video') lastVideoPreset.current = Number(settings.preset) || 0;

  const ordered = useMemo(() => {
    const active = []; const waiting = []; const rest = [];
    for (const item of items) { const group = groupOf(item.status); (group === 'active' ? active : group === 'waiting' ? waiting : rest).push(item); }
    // The queue runs oldest-first, so "waiting" is shown in the order downloads will actually start.
    return [...active, ...waiting.reverse(), ...rest];
  }, [items]);
  const firstWaitingId = ordered.find(item => item.status === 'Queued')?.id;

  const counts = useMemo(() => {
    const result = { all: items.length, active: 0, waiting: 0, done: 0, failed: 0, canceled: 0 };
    for (const item of items) result[groupOf(item.status)] += 1;
    return result;
  }, [items]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return ordered.filter(item => (filter === 'all' || groupOf(item.status) === filter) && (!needle || `${item.title} ${item.url}`.toLowerCase().includes(needle)));
  }, [ordered, filter, search]);

  // Coming from History selects an item: make sure it is not hidden by the current filter or search.
  useEffect(() => {
    if (selectedId && !visible.some(item => item.id === selectedId) && items.some(item => item.id === selectedId)) { setFilter('all'); setSearch(''); }
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!urls.length || adding || spotifyMixed) return;
    if (spotifyOnly) { onSpotify(urls[0]); setUrlText(''); return; }
    setAdding(true);
    try { const added = await onAddUrls(urls); if (added?.length) { setUrlText(''); setFilter('all'); } }
    finally { setAdding(false); }
  };

  const paste = async () => {
    try {
      const text = await window.flickfetch.app.readClipboard();
      if (text) setUrlText(current => current.trim() ? `${current.trim()}\n${text.trim()}` : text.trim());
      textareaRef.current?.focus();
    } catch { /* Clipboard permission is controlled by Electron settings. */ }
  };

  const inspectFirst = async type => {
    const url = urls[0] || '';
    if (!url) return;
    setInspectBusy(true); setInspectError(''); setInspect({ type, info: null, text: '' });
    try { setInspect(await window.flickfetch.inspect(url, type)); }
    catch (error) { setInspectError(error.message); }
    finally { setInspectBusy(false); }
  };

  const setMode = next => {
    if (next === mode) return;
    onSettingsChange({ preset: next === 'audio' ? AUDIO_PRESET : lastVideoPreset.current });
  };
  const chooseFolder = async () => {
    try { const folder = await window.flickfetch.settings.chooseOutputFolder(); if (folder) onSettingsChange({ outputDir: folder }); }
    catch (error) { console.error(error); }
  };

  const retryAll = () => items.filter(item => ['Failed', 'Canceled'].includes(item.status)).forEach(item => onRetry(item.id));
  const pending = counts.active + counts.waiting;
  const finished = counts.done + counts.failed + counts.canceled;
  const toggleRow = id => onSelectItem(selectedId === id ? null : id);

  const primaryLabel = adding ? 'Adding…' : spotifyOnly ? 'Open in Spotify matcher' : urls.length > 1 ? `${settings.autoStart === false ? 'Add' : 'Download'} ${urls.length} links` : settings.autoStart === false ? 'Add to queue' : 'Download';
  const summary = [counts.active && `${counts.active} downloading`, counts.waiting && `${counts.waiting} waiting`, counts.done && `${counts.done} done`, counts.failed && `${counts.failed} failed`].filter(Boolean).join(' · ');

  const tabs = [
    { value: 'all', label: 'All', count: counts.all },
    { value: 'active', label: 'Downloading', count: counts.active },
    { value: 'waiting', label: 'Waiting', count: counts.waiting },
    { value: 'done', label: 'Done', count: counts.done },
    { value: 'failed', label: 'Failed', count: counts.failed },
    { value: 'canceled', label: 'Canceled', count: counts.canceled }
  ].filter(tab => tab.value === 'all' || tab.count > 0 || filter === tab.value);

  return (
    <div className="ff-page scrollbar-thin">
      <div className="ff-page-inner">
        <header className="ff-page-head">
          <h1>Downloads</h1>
          <p>Paste a link and press Download. The options below are optional.</p>
        </header>

        <section className="ff-composer" aria-label="Add downloads">
          <div className="ff-composer-input">
            <textarea
              ref={textareaRef}
              value={urlText}
              rows={Math.min(5, Math.max(2, urls.length + 1))}
              onChange={event => setUrlText(event.target.value)}
              onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); submit(); } }}
              placeholder={'Paste video or audio links here, one per line\nYouTube, Instagram, TikTok, X, SoundCloud and more'}
              aria-label="Media links"
              spellCheck={false}
            />
            <div className="ff-composer-meta">
              {urls.length > 0 ? <span><b>{urls.length}</b> link{urls.length === 1 ? '' : 's'} ready</span> : <span>You can also drop links or a .txt file anywhere in this window.</span>}
              {urls.length > 0 && <button type="button" className="ff-link" onClick={() => setUrlText('')}>Clear</button>}
            </div>
          </div>

          {spotifyOnly && <div className="ff-inline-note ff-note-info"><Music2 size={16} aria-hidden="true" /><span><b>Spotify playlist detected.</b> Spotify links can’t be downloaded directly. FlickFetch will find the matching audio for each song in the Spotify matcher.</span></div>}
          {spotifyMixed && <div className="ff-inline-note ff-note-warn"><AlertTriangle size={16} aria-hidden="true" /><span><b>Import Spotify playlists on their own.</b> Remove the Spotify link, or paste only that one link, to continue.</span></div>}

          <div className="ff-options">
            <div className="ff-field">
              <span className="ff-field-label">Download as</span>
              <Segmented label="Download as" value={mode} onChange={setMode} options={[{ value: 'video', label: 'Video', icon: Video }, { value: 'audio', label: 'Audio only', icon: AudioLines }]} />
            </div>
            {mode === 'video' ? (<>
              <div className="ff-field ff-field-grow">
                <span className="ff-field-label">Quality</span>
                <DropdownSelect ariaLabel="Video quality" value={Number(settings.preset)} onChange={value => onSettingsChange({ preset: Number(value) })} options={videoQualityOptions} />
              </div>
              <div className="ff-field ff-field-grow">
                <span className="ff-field-label">File type</span>
                <DropdownSelect ariaLabel="Video file type" value={settings.container} onChange={value => onSettingsChange({ container: value })} options={containerOptions} />
              </div>
            </>) : (
              <div className="ff-field ff-field-wide">
                <span className="ff-field-label">Audio format</span>
                <DropdownSelect ariaLabel="Audio format" value={settings.audioFormat} onChange={value => onSettingsChange({ audioFormat: value })} options={audioOptions} />
              </div>
            )}
            <div className="ff-field">
              <span className="ff-field-label">Playlists</span>
              <SwitchChip checked={Boolean(settings.playlist)} onChange={value => onSettingsChange({ playlist: value })} label="Whole playlist" hint="When a link points to a playlist, download every item instead of only the first video." />
            </div>
          </div>
          {Number(settings.preset) === CUSTOM_PRESET && !String(settings.customFormat || '').trim() && (
            <div className="ff-inline-note ff-note-warn"><AlertTriangle size={16} aria-hidden="true" /><span>Custom format is selected but no format is set. <button type="button" className="ff-link" onClick={onOpenSettings}>Set it in Settings</button> or pick a quality above.</span></div>
          )}

          <div className="ff-composer-foot">
            <div className="ff-save">
              <FolderOpen size={16} aria-hidden="true" />
              <span className="ff-save-label">Save to</span>
              <span className="ff-save-path" title={settings.outputDir}>{settings.outputDir || 'No folder chosen'}</span>
              <button type="button" className="ff-link" onClick={chooseFolder}>Change</button>
              <button type="button" className="ff-link" onClick={() => settings.outputDir && window.flickfetch.app.openPath(settings.outputDir)} disabled={!settings.outputDir}>Open</button>
            </div>
            <div className="ff-composer-actions">
              <button type="button" className="ff-btn ff-btn-ghost" onClick={paste}><ClipboardPaste size={16} aria-hidden="true" />Paste</button>
              <button type="button" className="ff-btn ff-btn-primary ff-btn-lg" onClick={submit} disabled={!urls.length || adding || spotifyMixed}>
                {spotifyOnly ? <Music2 size={17} aria-hidden="true" /> : <Download size={17} aria-hidden="true" />}{primaryLabel}
              </button>
            </div>
          </div>

          <div className="ff-composer-tools">
            <button type="button" className="ff-link" disabled={!urls.length || spotifyOnly} title={urls.length ? 'Show title, creator and duration without downloading' : 'Paste a link first'} onClick={() => inspectFirst('info')}><FileSearch size={14} aria-hidden="true" />Preview details</button>
            <button type="button" className="ff-link" disabled={!urls.length || spotifyOnly} title={urls.length ? 'List every quality the source offers' : 'Paste a link first'} onClick={() => inspectFirst('formats')}><ListVideo size={14} aria-hidden="true" />See available formats</button>
            <span className="ff-spacer" />
            <button type="button" className="ff-link" onClick={onOpenSettings}><SlidersHorizontal size={14} aria-hidden="true" />More options</button>
          </div>
        </section>

        <section className="ff-queue" aria-label="Download queue">
          <div className="ff-queue-bar">
            <div className="ff-queue-title">
              <h2>Queue</h2>
              <span>{summary || 'Nothing here yet'}</span>
            </div>
            <div className="ff-queue-tools">
              {items.length > 8 && (
                <label className="ff-search"><Search size={15} aria-hidden="true" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search" aria-label="Search downloads" /></label>
              )}
              {pending > 0 && (
                <button type="button" className={`ff-btn ${queueRunning ? 'ff-btn-ghost' : 'ff-btn-primary'}`} onClick={queueRunning ? onPause : onStart}>
                  {queueRunning ? <><Pause size={15} aria-hidden="true" />Pause all</> : <><Play size={15} aria-hidden="true" />Resume</>}
                </button>
              )}
              {items.length > 0 && (
                <ActionMenu label="Manage" icon={Settings2} items={[
                  { label: 'Retry failed', hint: counts.failed + counts.canceled ? `${counts.failed + counts.canceled} download${counts.failed + counts.canceled === 1 ? '' : 's'}` : 'Nothing to retry', icon: RotateCcw, disabled: !(counts.failed + counts.canceled), onSelect: retryAll },
                  { label: 'Clear finished', hint: finished ? `Remove ${finished} from the list` : 'Nothing to clear', icon: Trash2, disabled: !finished, onSelect: onClearFinished },
                  { label: 'Cancel everything', hint: pending ? `Stop ${pending} active or waiting` : 'Nothing is running', icon: XCircle, danger: true, disabled: !pending, onSelect: onStopAll }
                ]} />
              )}
            </div>
          </div>

          {items.length > 0 && tabs.length > 1 && <div className="ff-queue-tabs"><FilterTabs label="Filter downloads" value={filter} onChange={setFilter} tabs={tabs} /></div>}

          {!queueRunning && pending > 0 && (
            <div className="ff-inline-note ff-note-warn ff-flush"><Pause size={16} aria-hidden="true" /><span><b>Downloads are paused.</b> Waiting items won’t start until you press Resume above.</span></div>
          )}

          {visible.length > 0 ? (
            <ul className="ff-list">
              {visible.map(item => (
                <QueueRow key={item.id} item={item} expanded={selectedId === item.id} paused={!queueRunning} upNext={item.id === firstWaitingId}
                  onToggle={toggleRow} onRetry={onRetry} onStop={id => window.flickfetch.downloads.stop(id)} onRemove={onRemove} onOpenFolder={onOpenPath} />
              ))}
            </ul>
          ) : items.length === 0 ? (
            <div className="ff-empty">
              <div className="ff-empty-icon"><Download size={24} aria-hidden="true" /></div>
              <h3>Nothing downloading yet</h3>
              <p>Your downloads show up here with live progress, speed and time remaining.</p>
              <ol className="ff-how">
                <li><b>1</b>Copy a link from your browser</li>
                <li><b>2</b>Paste it above</li>
                <li><b>3</b>Press Download</li>
              </ol>
            </div>
          ) : (
            <div className="ff-empty ff-empty-compact">
              <h3>No downloads match this view</h3>
              <p>{search ? `Nothing matches “${search}”.` : 'Try a different filter.'}</p>
              <button type="button" className="ff-btn ff-btn-ghost" onClick={() => { setFilter('all'); setSearch(''); }}>Show everything</button>
            </div>
          )}
        </section>
      </div>

      {inspect && (
        <Modal title={inspect.type === 'formats' ? 'Available formats' : 'Media details'} subtitle="Read from the source without downloading anything." onClose={() => { setInspect(null); setInspectError(''); }} width="max-w-2xl">
          <div className="p-5">
            {inspectBusy && <div className="mb-4"><div className="mb-2 text-[13px] font-semibold text-slate-600">Reading the source…</div><ProgressBar indeterminate /></div>}
            {inspectError && <Notice tone="error">{inspectError}</Notice>}
            {inspect.info && <div className="ff-inspect">{[['Title', inspect.info.title], ['Creator', inspect.info.uploader], ['Duration', inspect.info.duration], ['Source', inspect.info.extractor], ['Uploaded', inspect.info.uploadDate], ['Formats found', inspect.info.formats]].map(([label, value]) => <div key={label}><span>{label}</span><span>{value || '—'}</span></div>)}{inspect.info.description && <div className="ff-inspect-desc"><span>Description</span><p>{inspect.info.description}</p></div>}</div>}
            {inspect.text && <pre className="ff-log ff-log-tall scrollbar-thin">{inspect.text}</pre>}
          </div>
        </Modal>
      )}
    </div>
  );
}
