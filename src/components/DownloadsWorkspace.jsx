import React, { useMemo, useState } from 'react';
import { Activity, AlertTriangle, ArrowDownToLine, AudioLines, CheckCircle2, CirclePause, CirclePlay, ClipboardPaste, Clock3, Download, FileSearch, FolderOpen, Gauge, ListChecks, Music2, Pause, Play, Plus, RefreshCw, RotateCcw, Search, Settings2, Square, Trash2, Video, XCircle } from 'lucide-react';
import { formatBytes, formatEta, formatSpeed, safeHost, timeAgo } from '../lib/format.js';
import { Modal, Notice, ProgressBar, SectionHeading, StatCard, StatusPill } from './Primitives.jsx';

const qualityOptions = [
  { value: 0, label: 'Best quality' }, { value: 1, label: 'Up to 4K' }, { value: 2, label: 'Up to 1440p' },
  { value: 3, label: 'Up to 1080p' }, { value: 4, label: 'Up to 720p' }, { value: 5, label: 'Up to 480p' },
  { value: 6, label: 'Up to 360p' }, { value: 7, label: 'Audio only' }, { value: 8, label: 'Custom format' }
];

function QueueRow({ item, active, onSelect, onRetry, onStop, onRemove, onOpenFolder }) {
  const progress = Number(item.progress);
  const isActive = ['Starting', 'Downloading', 'Processing'].includes(item.status);
  return (
    <div onClick={() => onSelect(item.id)} className={`group queue-grid grid cursor-pointer grid-cols-[minmax(0,1fr)_104px_160px_100px_86px] items-center gap-4 border-b border-slate-100 px-4 py-3 transition hover:bg-slate-50/70 ${active ? 'bg-brand-50/50' : 'bg-white'}`}>
      <div className="flex min-w-0 items-center gap-3">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${item.status === 'Done' ? 'bg-emerald-50 text-emerald-600' : item.status === 'Failed' ? 'bg-rose-50 text-rose-500' : item.status === 'Downloading' ? 'bg-brand-50 text-brand-600' : 'bg-slate-100 text-slate-500'}`}>
          {item.status === 'Done' ? <CheckCircle2 size={17} /> : item.status === 'Failed' ? <AlertTriangle size={17} /> : item.settingsSnapshot?.preset === 7 ? <AudioLines size={17} /> : <Video size={17} />}
        </div>
        <div className="min-w-0 flex-1"><div className="truncate text-[11px] font-bold text-slate-800">{item.title || item.url}</div><div className="mt-0.5 truncate text-[9px] text-slate-400">{safeHost(item.url)}{item.playlistCount > 1 ? ` · item ${item.playlistIndex || 0} of ${item.playlistCount}` : ''} · {timeAgo(item.createdAt)}</div>{item.errorText && item.status === 'Failed' && <div className="mt-1 truncate text-[9px] text-rose-500">{item.errorText}</div>}</div>
      </div>
      <div><StatusPill status={item.status} />{item.stage && <div className="mt-1 max-w-[100px] truncate text-[8px] text-violet-500">{item.stage}</div>}</div>
      <div><div className="mb-1.5 flex items-center justify-between text-[9px]"><span className="text-slate-400">{item.status === 'Done' ? 'Completed' : item.status === 'Processing' ? 'Processing' : 'Progress'}</span><span className="font-bold tabular-nums text-slate-600">{item.status === 'Done' ? '100%' : progress >= 0 ? `${Math.round(progress)}%` : '—'}</span></div><ProgressBar value={progress >= 0 ? progress : 0} indeterminate={item.status === 'Starting' || (item.status === 'Downloading' && progress < 0)} /></div>
      <div className="text-[10px] tabular-nums text-slate-500">{isActive ? formatSpeed(item.speed) : item.status === 'Done' ? formatBytes(item.finalSize) : '—'}</div>
      <div className="flex items-center justify-end gap-0.5" onClick={event => event.stopPropagation()}>
        {isActive && <button title="Cancel download" onClick={() => onStop(item.id)} className="rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Square size={13} /></button>}
        {item.status === 'Done' && item.filePath && <button title="Show downloaded file" onClick={() => onOpenFolder(item.filePath)} className="rounded-lg p-2 text-slate-400 hover:bg-brand-50 hover:text-brand-600"><FolderOpen size={14} /></button>}
        {['Failed', 'Canceled'].includes(item.status) && <button title="Retry" onClick={() => onRetry(item.id)} className="rounded-lg p-2 text-slate-400 hover:bg-brand-50 hover:text-brand-600"><RotateCcw size={14} /></button>}
        {!isActive && <button title="Remove from list" onClick={() => onRemove(item.id)} className="rounded-lg p-2 text-slate-300 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100"><Trash2 size={13} /></button>}
      </div>
    </div>
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

  const activeCount = items.filter(item => ['Starting', 'Downloading', 'Processing'].includes(item.status)).length;
  const completedCount = items.filter(item => item.status === 'Done').length;
  const failedCount = items.filter(item => item.status === 'Failed').length;
  const filtered = useMemo(() => items.filter(item => {
    if (filter === 'downloading' && !['starting', 'downloading', 'processing'].includes(item.status.toLowerCase())) return false;
    if (filter !== 'all' && filter !== 'downloading' && item.status.toLowerCase() !== filter) return false;
    return !search || `${item.title} ${item.url}`.toLowerCase().includes(search.toLowerCase());
  }), [items, filter, search]);
  const selected = items.find(item => item.id === selectedId) || null;
  const urls = urlText.split(/\r?\n/).map(value => value.trim()).filter(Boolean);

  const add = async () => {
    if (!urls.length) return;
    setAdding(true);
    try { await onAddUrls(urls); setUrlText(''); }
    finally { setAdding(false); }
  };

  const inspectFirst = async type => {
    const url = urls[0] || items.find(item => item.status === 'Queued')?.url || '';
    if (!url) { setInspectError('Paste a media link first, or select a queued download.'); setInspect({ type, info: null, text: '' }); return; }
    setInspectBusy(true); setInspectError(''); setInspect({ type, info: null, text: '' });
    try { const data = await window.flickfetch.inspect(url, type); setInspect(data); }
    catch (error) { setInspectError(error.message); }
    finally { setInspectBusy(false); }
  };

  return (
    <div className="scrollbar-thin h-full overflow-y-auto px-7 pb-8 pt-6">
      <SectionHeading eyebrow="Media workspace" title="Downloads" description="Add links, tune your download profile, and track every task in one place." right={<div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[10px] font-semibold text-slate-500"><span className={`h-2 w-2 rounded-full ${activeCount ? 'animate-pulse bg-emerald-500' : 'bg-slate-300'}`} />{activeCount ? `${activeCount} active task${activeCount === 1 ? '' : 's'}` : 'Queue is idle'}</div>} />

      <div className="mb-5 grid grid-cols-3 gap-3"><StatCard icon={ListChecks} label="In the queue" value={items.filter(item => ['Queued', 'Starting', 'Downloading', 'Processing'].includes(item.status)).length} tone="brand" /><StatCard icon={CheckCircle2} label="Completed" value={completedCount} tone="emerald" /><StatCard icon={AlertTriangle} label="Need attention" value={failedCount} tone="amber" /></div>

      <div className="panel mb-5 overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div><div className="text-[13px] font-bold text-slate-900">Create a download</div><div className="mt-0.5 text-[10px] text-slate-400">Paste one or more supported media links, one per line.</div></div><button className="btn-quiet" onClick={onOpenSettings}><Settings2 size={14} /> Advanced settings</button></div>
        <div className="p-5">
          <div className="relative"><textarea value={urlText} onChange={event => setUrlText(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); add(); } }} className="field-control min-h-[92px] resize-y bg-slate-50/70 pr-24 font-mono text-[11px] leading-relaxed" placeholder={'https://www.youtube.com/watch?v=…\nhttps://www.instagram.com/reel/…'} /><span className="absolute bottom-3 right-3 rounded-md bg-white px-2 py-1 text-[8px] font-semibold text-slate-400 shadow-sm">Ctrl + Enter</span></div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><button className="btn-primary" onClick={add} disabled={!urls.length || adding}><Plus size={15} />{adding ? 'Adding…' : `Add ${urls.length || ''} to queue`}</button><button className="btn-secondary" onClick={async () => { try { const text = await window.flickfetch.app.readClipboard(); if (text) setUrlText(current => current ? `${current.trim()}\n${text}` : text); } catch { /* Clipboard permission is controlled by Electron settings. */ } }}><ClipboardPaste size={14} /> Paste</button></div><div className="flex items-center gap-2"><button className="btn-quiet" onClick={() => inspectFirst('info')}><FileSearch size={14} /> Inspect info</button><button className="btn-quiet" onClick={() => inspectFirst('formats')}><Activity size={14} /> Formats</button><button className="btn-quiet text-emerald-700 hover:bg-emerald-50" onClick={() => onSpotify(urls[0] || '')}><Music2 size={14} /> Import Spotify playlist</button></div></div>
        </div>
      </div>

      <div className="panel mb-5 p-4">
        <div className="mb-3 flex items-center justify-between"><div className="flex items-center gap-2 text-[12px] font-bold text-slate-800"><Gauge size={15} className="text-brand-600" /> Download profile</div><button className="btn-quiet" onClick={onOpenSettings}>More options <Settings2 size={13} /></button></div>
        <div className="grid grid-cols-[1.35fr_1fr_1fr_auto] items-end gap-3">
          <label className="block"><span className="field-label">Quality preset</span><select className="field-control" value={settings.preset} onChange={event => onSettingsChange({ preset: Number(event.target.value) })}>{qualityOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label className="block"><span className="field-label">Container</span><select className="field-control" disabled={Number(settings.preset) === 7} value={settings.container} onChange={event => onSettingsChange({ container: event.target.value })}>{['auto', 'mp4', 'mkv', 'webm'].map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label>
          <label className="block"><span className="field-label">Audio format</span><select className="field-control" disabled={Number(settings.preset) !== 7} value={settings.audioFormat} onChange={event => onSettingsChange({ audioFormat: event.target.value })}>{['mp3', 'm4a', 'opus', 'flac', 'wav', 'aac', 'vorbis', 'best'].map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label>
          <label className="flex h-[40px] items-center gap-2.5 rounded-xl border border-slate-200 px-3"><input type="checkbox" checked={settings.playlist} onChange={event => onSettingsChange({ playlist: event.target.checked })} className="h-3.5 w-3.5 accent-brand-600" /><span className="whitespace-nowrap text-[10px] font-semibold text-slate-600">Full playlists</span></label>
        </div>
        <div className="mt-3 flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2.5"><div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white text-slate-400"><FolderOpen size={14} /></div><div className="min-w-0 flex-1"><div className="text-[8px] font-bold uppercase tracking-[.12em] text-slate-400">Save location</div><div className="truncate text-[10px] font-medium text-slate-600">{settings.outputDir}</div></div><button className="btn-secondary !px-3 !py-2" onClick={async () => { try { const folder = await window.flickfetch.settings.chooseOutputFolder(); if (folder) onSettingsChange({ outputDir: folder }); } catch (error) { console.error(error); } }}><FolderOpen size={13} /> Browse</button><button className="btn-quiet" title="Open save location" onClick={() => window.flickfetch.app.openPath(settings.outputDir)}><ArrowDownToLine size={14} /> Open</button>
        </div>
      </div>

      <div className="panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4"><div><div className="text-[14px] font-bold text-slate-900">Download queue</div><div className="mt-0.5 text-[10px] text-slate-400">{items.length} item{items.length === 1 ? '' : 's'} · {activeCount} active · {completedCount} completed</div></div><div className="flex flex-wrap items-center gap-1.5"><button className="btn-secondary !px-3 !py-2" onClick={queueRunning ? onPause : onStart}><span>{queueRunning ? <Pause size={13} /> : <Play size={13} />}</span>{queueRunning ? 'Pause queue' : 'Resume queue'}</button><button className="btn-secondary !px-3 !py-2" onClick={onStopAll} disabled={!items.some(item => ['Queued', 'Starting', 'Downloading', 'Processing'].includes(item.status))}><Square size={12} /> Stop all</button><button className="btn-quiet" onClick={() => items.filter(item => item.status === 'Failed' || item.status === 'Canceled').forEach(item => onRetry(item.id))}><RefreshCw size={13} /> Retry failed</button><button className="btn-quiet" onClick={onClearFinished}><Trash2 size={13} /> Clear finished</button></div></div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/50 px-4 py-2.5"><div className="flex items-center gap-1">{[['all', 'All'], ['queued', 'Queued'], ['downloading', 'Active'], ['done', 'Completed'], ['failed', 'Failed'], ['canceled', 'Canceled']].map(([id, label]) => <button key={id} onClick={() => setFilter(id)} className={`rounded-lg px-2.5 py-1.5 text-[9px] font-bold transition ${filter === id ? 'bg-white text-brand-700 shadow-sm ring-1 ring-slate-200' : 'text-slate-400 hover:text-slate-700'}`}>{label}</button>)}</div><div className="relative w-[210px]"><Search size={12} className="absolute left-2.5 top-2.5 text-slate-400" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search queue…" className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-2 text-[10px] outline-none focus:border-brand-400" /></div></div>
        {filtered.length > 0 ? <>
          <div className="queue-grid grid grid-cols-[minmax(0,1fr)_104px_160px_100px_86px] gap-4 border-b border-slate-100 px-4 py-2.5 text-[8px] font-extrabold uppercase tracking-[.12em] text-slate-400"><span>Content</span><span>Status</span><span>Progress</span><span>Speed / size</span><span className="text-right">Actions</span></div>
          <div>{filtered.map(item => <QueueRow key={item.id} item={item} active={selectedId === item.id} onSelect={onSelectItem} onRetry={onRetry} onStop={id => window.flickfetch.downloads.stop(id)} onRemove={onRemove} onOpenFolder={onOpenPath} />)}</div>
        </> : <div className="px-6 py-14 text-center"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-600"><Download size={20} /></div><div className="mt-3 text-[13px] font-bold text-slate-800">{items.length ? 'No items match this view' : 'Your queue is ready'}</div><div className="mx-auto mt-1 max-w-[300px] text-[10px] leading-relaxed text-slate-400">{items.length ? 'Try another filter or search term.' : 'Add a media link above to see download progress, transfer speed, and processing details.'}</div></div>}
      </div>

      {selected && <div className="panel mt-5 overflow-hidden"><div className="flex items-center justify-between border-b border-slate-100 px-4 py-3"><div><div className="text-[11px] font-bold text-slate-800">Activity log</div><div className="mt-0.5 max-w-[620px] truncate text-[9px] text-slate-400">{selected.title || selected.url}</div></div><div className="flex items-center gap-2"><button className="btn-quiet" onClick={() => navigator.clipboard?.writeText((selected.logs || []).join('\n'))}><ClipboardPaste size={13} /> Copy log</button><button className="btn-quiet" onClick={() => onSelectItem(null)}><XCircle size={13} /> Close</button></div></div><pre className="scrollbar-thin max-h-[170px] overflow-auto bg-[#171a2c] px-4 py-3 font-mono text-[9px] leading-relaxed text-slate-300">{(selected.logs || []).join('\n') || 'No activity has been recorded yet.'}</pre></div>}

      {inspect && <Modal title={inspect.type === 'formats' ? 'Available formats' : 'Media information'} subtitle="Quick inspect uses yt-dlp without downloading the media." onClose={() => { setInspect(null); setInspectError(''); }} width="max-w-2xl"><div className="p-5">{inspectBusy && <div className="mb-4"><div className="mb-2 text-[10px] font-semibold text-slate-500">Inspecting source…</div><ProgressBar indeterminate /></div>}{inspectError && <Notice tone="error">{inspectError}</Notice>}{inspect.info && <div className="space-y-3">{[['Title', inspect.info.title], ['Creator', inspect.info.uploader], ['Duration', inspect.info.duration], ['Source', inspect.info.extractor], ['Upload date', inspect.info.uploadDate], ['Formats found', inspect.info.formats]].map(([label, value]) => <div key={label} className="grid grid-cols-[110px_1fr] gap-3 border-b border-slate-100 pb-2"><span className="text-[10px] font-bold text-slate-400">{label}</span><span className="break-words text-[11px] text-slate-700">{value}</span></div>)}{inspect.info.description && <div><div className="mb-1 text-[10px] font-bold text-slate-400">Description preview</div><p className="whitespace-pre-wrap text-[10px] leading-relaxed text-slate-600">{inspect.info.description}</p></div>}</div>}{inspect.text && <pre className="scrollbar-thin max-h-[460px] overflow-auto rounded-xl bg-[#171a2c] p-4 font-mono text-[9px] leading-relaxed text-slate-200">{inspect.text}</pre>}</div></Modal>}
    </div>
  );
}
