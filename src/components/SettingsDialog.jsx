import React, { useEffect, useState } from 'react';
import { Activity, Download, FolderOpen, Globe2, HardDrive, Music2, Save, Settings2, ShieldCheck, SlidersHorizontal, Wrench } from 'lucide-react';
import { Field, Modal, Notice, ProgressBar, SelectField, Toggle } from './Primitives.jsx';

const tabs = [
  { id: 'output', label: 'Format & output', icon: Download },
  { id: 'subtitles', label: 'Subtitles & extras', icon: Music2 },
  { id: 'network', label: 'Network & login', icon: Globe2 },
  { id: 'behavior', label: 'App behavior', icon: SlidersHorizontal },
  { id: 'tools', label: 'Downloader tools', icon: Wrench }
];

const qualityOptions = [
  { value: 0, label: 'Best quality (video + audio)' },
  { value: 1, label: 'Up to 2160p (4K)' }, { value: 2, label: 'Up to 1440p' },
  { value: 3, label: 'Up to 1080p' }, { value: 4, label: 'Up to 720p' },
  { value: 5, label: 'Up to 480p' }, { value: 6, label: 'Up to 360p' },
  { value: 7, label: 'Audio only (extract)' }, { value: 8, label: 'Custom format string…' }
];

function InlineSelect({ value, onChange, options }) {
  return <select className="field-control" value={value} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
}

export default function SettingsDialog({ initialSettings, toolStatus, toolsProgress, onClose, onSave, onRefreshTools, onInstallTools, onUpdateYtDlp }) {
  const [values, setValues] = useState(initialSettings);
  const [tab, setTab] = useState('output');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const [toolAction, setToolAction] = useState('');

  useEffect(() => setValues(initialSettings), [initialSettings]);
  const set = (key, value) => setValues(current => ({ ...current, [key]: value }));
  const setToggle = key => value => set(key, value);
  const browseOutput = async () => {
    try { const folder = await window.flickfetch.settings.chooseOutputFolder(); if (folder) set('outputDir', folder); }
    catch (error) { setLocalError(error.message); }
  };
  const browseCookies = async () => {
    try { const file = await window.flickfetch.settings.chooseCookiesFile(); if (file) set('cookiesFile', file); }
    catch (error) { setLocalError(error.message); }
  };
  const save = async () => {
    setBusy(true); setLocalError('');
    try { await onSave(values); onClose(); }
    catch (error) { setLocalError(error.message); }
    finally { setBusy(false); }
  };
  const install = async () => {
    setBusy(true); setToolAction('install'); setLocalError('');
    try { await onInstallTools(); await onRefreshTools(); }
    catch (error) { setLocalError(error.message); }
    finally { setBusy(false); setToolAction(''); }
  };
  const update = async () => {
    setBusy(true); setToolAction('update'); setLocalError('');
    try { const result = await onUpdateYtDlp(); setLocalError(result?.output || 'yt-dlp update completed.'); await onRefreshTools(); }
    catch (error) { setLocalError(error.message); }
    finally { setBusy(false); setToolAction(''); }
  };

  return (
    <Modal title="Settings" subtitle="Configure download quality, output, network access, and bundled tools." onClose={onClose} width="max-w-5xl" footer={
      <div className="flex items-center justify-between gap-4"><span className="text-[10px] text-slate-400">Settings are stored locally in your user profile.</span><div className="flex gap-2"><button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="btn-primary" onClick={save} disabled={busy}><Save size={14} />{busy && !toolAction ? 'Saving…' : 'Save settings'}</button></div></div>
    }>
      <div className="grid min-h-[570px] grid-cols-[205px_minmax(0,1fr)]">
        <aside className="border-r border-slate-100 bg-slate-50/75 p-3">
          <div className="mb-3 px-2 pt-2 text-[9px] font-extrabold uppercase tracking-[.15em] text-slate-400">Preferences</div>
          <div className="space-y-1">{tabs.map(item => { const Icon = item.icon; return <button key={item.id} onClick={() => setTab(item.id)} className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-[11px] font-semibold transition ${tab === item.id ? 'bg-white text-brand-700 shadow-soft ring-1 ring-slate-200' : 'text-slate-500 hover:bg-white/80 hover:text-slate-800'}`}><Icon size={15} />{item.label}</button>; })}</div>
          <div className="mt-7 rounded-xl border border-slate-200/80 bg-white p-3"><div className="flex items-center gap-2 text-[10px] font-bold text-slate-700"><ShieldCheck size={14} className="text-emerald-600" /> Privacy note</div><p className="mt-2 text-[9px] leading-relaxed text-slate-400">Cookies are read locally by yt-dlp. Only use browser sessions or cookie files belonging to accounts you control.</p></div>
        </aside>

        <div className="scrollbar-thin max-h-[70vh] overflow-y-auto p-6">
          {localError && <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] leading-relaxed text-amber-800">{localError}</div>}

          {tab === 'output' && <div className="space-y-6">
            <div><div className="mb-3 flex items-center gap-2 text-[13px] font-bold text-slate-800"><Download size={16} className="text-brand-600" /> Video and audio format</div>
              <div className="grid grid-cols-2 gap-4"><SelectField label="Quality preset" value={values.preset} onChange={value => set('preset', Number(value))} options={qualityOptions} /><SelectField label="Video container" value={values.container} onChange={value => set('container', value)} options={[{ value: 'auto', label: 'Automatic' }, { value: 'mp4', label: 'MP4' }, { value: 'mkv', label: 'MKV' }, { value: 'webm', label: 'WebM' }]} /></div>
              {Number(values.preset) === 8 && <div className="mt-4"><Field label="Custom yt-dlp format expression" value={values.customFormat} onChange={value => set('customFormat', value)} placeholder="bv*+ba/b" hint="This expression is passed to yt-dlp as the format selector." /></div>}
              <div className="mt-4 grid grid-cols-2 gap-4"><SelectField label="Audio extraction format" value={values.audioFormat} onChange={value => set('audioFormat', value)} options={['mp3', 'm4a', 'opus', 'flac', 'wav', 'aac', 'vorbis', 'best'].map(item => ({ value: item, label: item.toUpperCase() }))} /><Field label="Audio quality" value={values.audioQuality} onChange={value => set('audioQuality', value)} placeholder="0" hint="0 is best quality; other values such as 192K are supported." /></div>
              <div className="mt-3 rounded-xl bg-slate-50 px-3.5 py-1"><Toggle checked={values.preferCompat} onChange={setToggle('preferCompat')} label="Prefer H.264 / AAC compatibility" description="Prefer broadly compatible codecs when MP4 is selected." /><Toggle checked={values.playlist} onChange={setToggle('playlist')} label="Download full playlists" description="Allow yt-dlp to process all entries from a playlist URL." /></div>
            </div>
            <div className="border-t border-slate-100 pt-5"><div className="mb-3 flex items-center gap-2 text-[13px] font-bold text-slate-800"><FolderOpen size={16} className="text-brand-600" /> Save location and naming</div>
              <span className="field-label">Output folder</span><div className="flex gap-2"><input className="field-control min-w-0 flex-1" value={values.outputDir} onChange={event => set('outputDir', event.target.value)} /><button className="btn-secondary shrink-0" onClick={browseOutput}><FolderOpen size={14} /> Browse</button></div>
              <div className="mt-4"><Field label="Output filename template" value={values.template} onChange={value => set('template', value)} hint="Default: %(title).150B [%(id)s].%(ext)s" /></div>
              <div className="mt-3 grid grid-cols-2 gap-3 rounded-xl bg-slate-50 px-3.5 py-1"><Toggle checked={values.restrict} onChange={setToggle('restrict')} label="Restrict filenames" /><Toggle checked={values.overwrite} onChange={setToggle('overwrite')} label="Overwrite existing files" /><Toggle checked={values.useArchive} onChange={setToggle('useArchive')} label="Skip previously downloaded items" /><Toggle checked={values.infoJson} onChange={setToggle('infoJson')} label="Write metadata JSON" /><Toggle checked={values.description} onChange={setToggle('description')} label="Save description text" /><Toggle checked={values.writeThumb} onChange={setToggle('writeThumb')} label="Save thumbnail as JPG" /></div>
            </div>
            <div className="border-t border-slate-100 pt-5"><div className="mb-3 text-[13px] font-bold text-slate-800">Clip a section</div><div className="grid grid-cols-2 gap-4"><Field label="Start time" value={values.sectionStart} onChange={value => set('sectionStart', value)} placeholder="00:00 or 90" /><Field label="End time" value={values.sectionEnd} onChange={value => set('sectionEnd', value)} placeholder="00:30 or 120" /></div><p className="mt-2 text-[9px] text-slate-400">Leave both fields blank to download the complete media file. FFmpeg is required for most section downloads.</p></div>
          </div>}

          {tab === 'subtitles' && <div className="space-y-6">
            <div><div className="mb-3 text-[13px] font-bold text-slate-800">Subtitle handling</div><div className="rounded-xl bg-slate-50 px-3.5 py-1"><Toggle checked={values.subs} onChange={setToggle('subs')} label="Download subtitles" description="Save subtitles offered by the source." /><Toggle checked={values.autoSubs} onChange={setToggle('autoSubs')} label="Include auto-generated subtitles" description="Also request auto-generated captions when available." /><Toggle checked={values.embedSubs} onChange={setToggle('embedSubs')} label="Embed subtitles in the video" description="Embed when the selected output supports it; otherwise convert to SRT." /></div><div className="mt-4"><Field label="Subtitle language expression" value={values.subLangs} onChange={value => set('subLangs', value)} placeholder="en.*,ja" hint="yt-dlp language selector. The default en.* matches English subtitle variants." /></div></div>
            <div className="border-t border-slate-100 pt-5"><div className="mb-3 text-[13px] font-bold text-slate-800">Metadata and enhancements</div><div className="rounded-xl bg-slate-50 px-3.5 py-1"><Toggle checked={values.embedThumb} onChange={setToggle('embedThumb')} label="Embed thumbnail" description="Add the thumbnail to compatible media formats." /><Toggle checked={values.embedMeta} onChange={setToggle('embedMeta')} label="Embed metadata and chapters" /><Toggle checked={values.sponsor} onChange={setToggle('sponsor')} label="Remove detected SponsorBlock segments" description="Supported sources only. Available chapters and segment data depend on the source." /></div><Notice tone="info">Some options require FFmpeg. Subtitle and SponsorBlock availability depends on the source site and the media formats it provides.</Notice></div>
          </div>}

          {tab === 'network' && <div className="space-y-6">
            <div><div className="mb-3 flex items-center gap-2 text-[13px] font-bold text-slate-800"><Globe2 size={16} className="text-brand-600" /> Network and login</div><div className="grid grid-cols-2 gap-4"><SelectField label="Cookies from browser" value={values.cookiesBrowser} onChange={value => set('cookiesBrowser', value)} options={[{ value: '', label: 'Do not use browser cookies' }, ...['chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi'].map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) }))]} /><Field label="Proxy URL (optional)" value={values.proxy} onChange={value => set('proxy', value)} placeholder="http://127.0.0.1:8080" /></div>
              <div className="mt-4"><span className="field-label">Cookies.txt file</span><div className="flex gap-2"><input className="field-control min-w-0 flex-1" value={values.cookiesFile} onChange={event => set('cookiesFile', event.target.value)} placeholder="Optional Netscape cookies.txt path" /><button className="btn-secondary shrink-0" onClick={browseCookies}><FolderOpen size={14} /> Browse</button></div></div>
            </div>
            <div className="border-t border-slate-100 pt-5"><div className="mb-3 text-[13px] font-bold text-slate-800">Transfer controls</div><div className="grid grid-cols-2 gap-4"><Field label="Speed limit" value={values.rateLimit} onChange={value => set('rateLimit', value)} placeholder="Unlimited" hint="Examples: 500K, 2M, 1.5M" /><SelectField label="Parallel fragments" value={values.fragments} onChange={value => set('fragments', Number(value))} options={[1, 2, 4, 6, 8, 12, 16].map(value => ({ value, label: `${value} fragments` }))} /><SelectField label="Retry attempts" value={values.retries} onChange={value => set('retries', Number(value))} options={[0, 1, 3, 5, 10, 15, 20, 30].map(value => ({ value, label: `${value} retries` }))} /><SelectField label="Simultaneous downloads" value={values.parallel} onChange={value => set('parallel', Number(value))} options={[1, 2, 3, 4, 5].map(value => ({ value, label: `${value} at a time` }))} /></div></div>
            <Notice tone="warning">Only use browser cookies or cookie files for accounts you control. Credentials are read locally by yt-dlp. FlickFetch does not unlock private posts or bypass account restrictions.</Notice>
          </div>}

          {tab === 'behavior' && <div className="space-y-6">
            <div><div className="mb-3 flex items-center gap-2 text-[13px] font-bold text-slate-800"><Activity size={16} className="text-brand-600" /> App behavior</div><div className="rounded-xl bg-slate-50 px-3.5 py-1"><Toggle checked={values.autoStart} onChange={setToggle('autoStart')} label="Start queued downloads automatically" description="Begin processing newly added items without pressing Resume." /><Toggle checked={values.watchClipboard} onChange={setToggle('watchClipboard')} label="Watch clipboard for copied media links" description="FlickFetch will offer to add detected links; it will not download without your action." /><Toggle checked={values.autoUpdate} onChange={setToggle('autoUpdate')} label="Check for yt-dlp updates on startup" description="Checks the locally managed yt-dlp installation when the app opens." /></div></div>
            <div className="border-t border-slate-100 pt-5"><div className="mb-2 text-[13px] font-bold text-slate-800">Extra yt-dlp arguments</div><p className="mb-3 text-[10px] leading-relaxed text-slate-400">Optional arguments appended to every yt-dlp download command. These are advanced options; use only arguments you understand.</p><textarea className="field-control min-h-[140px] resize-y font-mono text-[11px]" value={values.extraArgs} onChange={event => set('extraArgs', event.target.value)} placeholder={'--embed-chapters\n--no-mtime'} /></div>
          </div>}

          {tab === 'tools' && <div className="space-y-5">
            <div className="flex items-start justify-between gap-4"><div><div className="flex items-center gap-2 text-[13px] font-bold text-slate-800"><HardDrive size={16} className="text-brand-600" /> Downloader components</div><p className="mt-1 text-[10px] text-slate-400">FlickFetch uses yt-dlp for extraction, FFmpeg for merging and conversion, and Deno for JavaScript challenges on supported sites.</p></div><button className="btn-secondary shrink-0" onClick={onRefreshTools}><Activity size={13} /> Refresh status</button></div>
            <div className="grid grid-cols-3 gap-3">{[['ytDlp', 'yt-dlp', toolStatus?.ytDlp], ['ffmpeg', 'FFmpeg / FFprobe', toolStatus?.ffmpeg], ['deno', 'Deno runtime', toolStatus?.deno]].map(([key, label, item]) => <div key={key} className="rounded-xl border border-slate-200 p-3.5"><div className="flex items-center justify-between"><span className="text-[11px] font-bold text-slate-700">{label}</span><span className={`h-2 w-2 rounded-full ${item?.installed ? 'bg-emerald-500' : 'bg-amber-400'}`} /></div><div className="mt-2 text-[10px] font-semibold text-slate-500">{item?.installed ? 'Installed' : 'Not found'}</div><div className="mt-1 break-all text-[9px] leading-relaxed text-slate-400">{item?.version || item?.path || 'Install this component to enable its features.'}</div></div>)}</div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4"><div className="flex items-center justify-between"><div><div className="text-[11px] font-bold text-slate-800">Tool installation folder</div><div className="mt-1 break-all text-[9px] text-slate-400">{toolStatus?.binDir || 'Loading…'}</div></div><span className="rounded-full bg-white px-2.5 py-1 text-[9px] font-bold text-slate-500">{toolStatus?.platform || ''}</span></div>{toolsProgress && <div className="mt-4"><div className="mb-2 flex justify-between text-[10px] font-semibold text-slate-600"><span>{toolsProgress.label}</span><span>{Math.round(toolsProgress.progress || 0)}%</span></div><ProgressBar value={toolsProgress.progress} /></div>}</div>
            {!toolStatus?.installSupported && <Notice tone="warning">Automatic tool installation is currently packaged for Windows x64. On other platforms, install these command-line tools separately and make sure they are available on PATH.</Notice>}
            <div className="flex flex-wrap gap-2"><button className="btn-primary" onClick={install} disabled={busy || !toolStatus?.installSupported}><Wrench size={14} />{toolAction === 'install' ? 'Installing…' : 'Install / repair all tools'}</button><button className="btn-secondary" onClick={update} disabled={busy || !toolStatus?.ytDlp?.installed}><Activity size={14} />{toolAction === 'update' ? 'Updating…' : 'Update yt-dlp'}</button></div>
            <p className="text-[9px] leading-relaxed text-slate-400">yt-dlp is installed only after its official release SHA-256 checksum is verified. FFmpeg and Deno are downloaded from their upstream release assets. These tools retain their own licenses; see THIRD-PARTY-NOTICES.md.</p>
          </div>}
        </div>
      </div>
    </Modal>
  );
}
