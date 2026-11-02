import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertCircle, CheckCircle2, Download, FolderOpen, Globe2, HardDrive, Info, Languages,
  Save, ShieldCheck, SlidersHorizontal, Wrench, X
} from 'lucide-react';
import { ProgressBar, SelectField } from './Primitives.jsx';

const tabs = [
  { id: 'output', label: 'Format & output', hint: 'Quality, container, folder', icon: Download },
  { id: 'subtitles', label: 'Subtitles & extras', hint: 'Captions, metadata, chapters', icon: Languages },
  { id: 'network', label: 'Network & login', hint: 'Cookies, proxy, transfer speed', icon: Globe2 },
  { id: 'behavior', label: 'App behavior', hint: 'Queue, clipboard, advanced', icon: SlidersHorizontal },
  { id: 'tools', label: 'Downloader tools', hint: 'yt-dlp, FFmpeg, Deno', icon: Wrench }
];

const qualityOptions = [
  { value: 0, label: 'Best quality (video + audio)' },
  { value: 1, label: 'Up to 2160p (4K)' }, { value: 2, label: 'Up to 1440p' },
  { value: 3, label: 'Up to 1080p' }, { value: 4, label: 'Up to 720p' },
  { value: 5, label: 'Up to 480p' }, { value: 6, label: 'Up to 360p' },
  { value: 7, label: 'Audio only (extract)' }, { value: 8, label: 'Custom format string…' }
];

/* ---------- small building blocks (all sizes live in styles.css under .st-*) ---------- */
function Card({ title, description, icon: Icon, children, action }) {
  return (
    <section className="st-card">
      <header className="st-card-head">
        <div className="st-card-title">{Icon && <span className="st-card-icon"><Icon size={15} /></span>}<div><h4>{title}</h4>{description && <p>{description}</p>}</div></div>
        {action}
      </header>
      <div className="st-card-body">{children}</div>
    </section>
  );
}

function Grid({ children, cols = 2 }) {
  return <div className={`st-grid ${cols === 1 ? 'st-grid-1' : ''}`}>{children}</div>;
}

function TextField({ label, value, onChange, placeholder, hint, mono = false, ...rest }) {
  return (
    <label className="st-field">
      <span className="st-label">{label}</span>
      <input className={`field-control ${mono ? 'font-mono' : ''}`} value={value ?? ''} placeholder={placeholder} onChange={event => onChange(event.target.value)} {...rest} />
      {hint && <span className="st-hint">{hint}</span>}
    </label>
  );
}

function PathField({ label, value, onChange, placeholder, onBrowse, hint }) {
  return (
    <div className="st-field">
      <label className="st-label" htmlFor={`path-${label}`}>{label}</label>
      <div className="st-path">
        <input id={`path-${label}`} className="field-control" value={value ?? ''} placeholder={placeholder} onChange={event => onChange(event.target.value)} spellCheck={false} />
        <button type="button" className="btn-secondary" onClick={onBrowse}><FolderOpen size={14} /> Browse</button>
      </div>
      {hint && <span className="st-hint">{hint}</span>}
    </div>
  );
}

function Switch({ checked, onChange, label, description }) {
  return (
    <label className="st-switch-row">
      <span className="st-switch-copy"><span className="st-switch-label">{label}</span>{description && <span className="st-switch-desc">{description}</span>}</span>
      <input type="checkbox" role="switch" className="st-switch-input" checked={Boolean(checked)} onChange={event => onChange(event.target.checked)} />
      <span className="st-track" aria-hidden="true"><span className="st-thumb" /></span>
    </label>
  );
}

function Rows({ children }) { return <div className="st-rows">{children}</div>; }

function Callout({ tone = 'info', children }) {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'error' || tone === 'warning' ? AlertCircle : Info;
  return <div className={`st-callout st-callout-${tone}`} role={tone === 'error' ? 'alert' : 'status'}><Icon size={15} /><div>{children}</div></div>;
}

function ToolTile({ name, item, extra }) {
  const ok = Boolean(item?.installed);
  return (
    <div className={`st-tool ${ok ? 'is-ok' : 'is-missing'}`}>
      <div className="st-tool-top"><strong>{name}</strong><span className="st-badge">{ok ? 'Installed' : 'Not found'}</span></div>
      <div className="st-tool-version">{ok ? (item.version || 'Version unknown') : 'Install to enable'}</div>
      {(item?.path || extra) && <div className="st-tool-path" title={item?.path}>{item?.path || extra}</div>}
    </div>
  );
}

export default function SettingsDialog({ initialSettings, toolStatus, toolsProgress, onClose, onSave, onRefreshTools, onInstallTools, onUpdateYtDlp }) {
  const [values, setValues] = useState(initialSettings);
  const [tab, setTab] = useState('output');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [toolAction, setToolAction] = useState('');
  const contentRef = useRef(null);

  // Only reset the form when the stored settings actually change, never because of an identical re-render.
  const initialKey = JSON.stringify(initialSettings);
  useEffect(() => { setValues(initialSettings); }, [initialKey]); // eslint-disable-line
  const dirty = useMemo(() => JSON.stringify(values) !== initialKey, [values, initialKey]);

  const set = (key, value) => setValues(current => ({ ...current, [key]: value }));
  const fail = error => setFeedback({ tone: 'error', text: error?.message || String(error) });

  const browseOutput = async () => { try { const folder = await window.flickfetch.settings.chooseOutputFolder(); if (folder) set('outputDir', folder); } catch (error) { fail(error); } };
  const browseCookies = async () => { try { const file = await window.flickfetch.settings.chooseCookiesFile(); if (file) set('cookiesFile', file); } catch (error) { fail(error); } };

  const save = useCallback(async () => {
    setBusy(true); setFeedback(null);
    try { await onSave(values); onClose(); }
    catch (error) { fail(error); contentRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); }
    finally { setBusy(false); }
  }, [values, onSave, onClose]);

  const install = async () => {
    setBusy(true); setToolAction('install'); setFeedback(null);
    try { await onInstallTools(); await onRefreshTools(); setFeedback({ tone: 'success', text: 'Tools installed and verified.' }); }
    catch (error) { fail(error); }
    finally { setBusy(false); setToolAction(''); }
  };
  const update = async () => {
    setBusy(true); setToolAction('update'); setFeedback(null);
    try { const result = await onUpdateYtDlp(); await onRefreshTools(); setFeedback({ tone: 'success', text: result?.output || 'yt-dlp update completed.' }); }
    catch (error) { fail(error); }
    finally { setBusy(false); setToolAction(''); }
  };

  // Esc closes, Ctrl/Cmd+S saves; switching tabs always starts at the top.
  useEffect(() => {
    const onKey = event => {
      if (event.key === 'Escape' && !event.defaultPrevented && !busy) onClose();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!busy) save(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose, save]);
  useEffect(() => { contentRef.current?.scrollTo({ top: 0 }); }, [tab]);

  const current = tabs.find(item => item.id === tab);
  const containerOptions = [{ value: 'auto', label: 'Automatic' }, { value: 'mp4', label: 'MP4' }, { value: 'mkv', label: 'MKV' }, { value: 'webm', label: 'WebM' }];
  const audioOptions = ['mp3', 'm4a', 'opus', 'flac', 'wav', 'aac', 'vorbis', 'best'].map(item => ({ value: item, label: item.toUpperCase() }));
  const browserOptions = [{ value: '', label: 'Do not use browser cookies' }, ...['chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi'].map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) }))];

  return (
    <div className="st-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="st-dialog st-root" role="dialog" aria-modal="true" aria-labelledby="st-title">
        <header className="st-header">
          <div><h3 id="st-title">Settings</h3><p>Download quality, output, network access and bundled tools.</p></div>
          <button type="button" className="st-close" onClick={onClose} aria-label="Close settings" title="Close (Esc)"><X size={17} /></button>
        </header>

        <div className="st-body">
          <nav className="st-nav" aria-label="Settings sections">
            {tabs.map(item => {
              const Icon = item.icon; const active = tab === item.id;
              return (
                <button key={item.id} type="button" className={`st-tab ${active ? 'is-active' : ''}`} onClick={() => setTab(item.id)} aria-current={active ? 'page' : undefined}>
                  <span className="st-tab-icon"><Icon size={16} /></span>
                  <span className="st-tab-copy"><strong>{item.label}</strong><small>{item.hint}</small></span>
                </button>
              );
            })}
            <div className="st-nav-note"><ShieldCheck size={14} /><p>Everything is stored locally. Cookies are read on your device by yt-dlp and never uploaded.</p></div>
          </nav>

          <div className="st-content" ref={contentRef}>
            <div className="st-content-inner">
              <div className="st-page-head"><h4>{current.label}</h4><p>{current.hint}</p></div>
              {feedback && <div className="st-feedback"><Callout tone={feedback.tone}><span className="st-pre">{feedback.text}</span></Callout></div>}

              {tab === 'output' && <>
                <Card title="Video & audio" description="How media is selected, merged and converted." icon={Download}>
                  <Grid>
                    <SelectField label="Quality preset" value={values.preset} onChange={value => set('preset', Number(value))} options={qualityOptions} />
                    <SelectField label="Video container" value={values.container} onChange={value => set('container', value)} options={containerOptions} />
                  </Grid>
                  {Number(values.preset) === 8 && <TextField label="Custom yt-dlp format expression" value={values.customFormat} onChange={value => set('customFormat', value)} placeholder="bv*+ba/b" hint="Passed to yt-dlp as the format selector." mono />}
                  <Grid>
                    <SelectField label="Audio extraction format" value={values.audioFormat} onChange={value => set('audioFormat', value)} options={audioOptions} />
                    <TextField label="Audio quality" value={values.audioQuality} onChange={value => set('audioQuality', value)} placeholder="0" hint="0 is best; values such as 192K also work." />
                  </Grid>
                  <Rows>
                    <Switch checked={values.preferCompat} onChange={value => set('preferCompat', value)} label="Prefer H.264 / AAC compatibility" description="Choose widely supported codecs when MP4 is selected." />
                    <Switch checked={values.playlist} onChange={value => set('playlist', value)} label="Download full playlists" description="Process every entry when a playlist URL is added." />
                  </Rows>
                </Card>

                <Card title="Save location & naming" description="Where files go and how they are named." icon={FolderOpen}>
                  <PathField label="Output folder" value={values.outputDir} onChange={value => set('outputDir', value)} onBrowse={browseOutput} />
                  <TextField label="Filename template" value={values.template} onChange={value => set('template', value)} hint="Default: %(title).150B.%(ext)s" mono />
                  <Rows>
                    <Switch checked={values.restrict} onChange={value => set('restrict', value)} label="Restrict filenames" description="Use only ASCII characters and avoid spaces." />
                    <Switch checked={values.overwrite} onChange={value => set('overwrite', value)} label="Overwrite existing files" />
                    <Switch checked={values.useArchive} onChange={value => set('useArchive', value)} label="Skip previously downloaded items" />
                    <Switch checked={values.inspectPages !== false} onChange={value => set('inspectPages', value)} label="Find video on unsupported pages" description="When yt-dlp has no extractor for a link, look for the page's video/mp4 or HLS source (like DevTools does) and download it." />
                    <Switch checked={values.infoJson} onChange={value => set('infoJson', value)} label="Write metadata JSON" />
                    <Switch checked={values.description} onChange={value => set('description', value)} label="Save description text" />
                    <Switch checked={values.writeThumb} onChange={value => set('writeThumb', value)} label="Save thumbnail as JPG" />
                  </Rows>
                </Card>

                <Card title="Clip a section" description="Leave both blank to download the whole file. Most clips need FFmpeg.">
                  <Grid>
                    <TextField label="Start time" value={values.sectionStart} onChange={value => set('sectionStart', value)} placeholder="1:30 or 90" />
                    <TextField label="End time" value={values.sectionEnd} onChange={value => set('sectionEnd', value)} placeholder="2:00 or 120" />
                  </Grid>
                </Card>
              </>}

              {tab === 'subtitles' && <>
                <Card title="Subtitles" description="Captions offered by the source site.">
                  <Rows>
                    <Switch checked={values.subs} onChange={value => set('subs', value)} label="Download subtitles" description="Save subtitles offered by the source." />
                    <Switch checked={values.autoSubs} onChange={value => set('autoSubs', value)} label="Include auto-generated subtitles" description="Also request automatic captions when available." />
                    <Switch checked={values.embedSubs} onChange={value => set('embedSubs', value)} label="Embed subtitles in the video" description="When the output supports it; otherwise converted to SRT." />
                  </Rows>
                  <TextField label="Subtitle languages" value={values.subLangs} onChange={value => set('subLangs', value)} placeholder="en.*,ja" hint="yt-dlp language selector. The default en.* matches English variants." mono />
                </Card>
                <Card title="Metadata & enhancements">
                  <Rows>
                    <Switch checked={values.embedThumb} onChange={value => set('embedThumb', value)} label="Embed thumbnail" description="Add the thumbnail to compatible formats." />
                    <Switch checked={values.embedMeta} onChange={value => set('embedMeta', value)} label="Embed metadata and chapters" />
                    <Switch checked={values.sponsor} onChange={value => set('sponsor', value)} label="Remove SponsorBlock segments" description="Supported sources only; depends on available segment data." />
                  </Rows>
                  <Callout>Some options require FFmpeg. Subtitle and SponsorBlock availability depends on the source site.</Callout>
                </Card>
              </>}

              {tab === 'network' && <>
                <Card title="Connection & login" description="Use your own browser session for sites that require sign-in." icon={Globe2}>
                  <Grid>
                    <SelectField label="Cookies from browser" value={values.cookiesBrowser} onChange={value => set('cookiesBrowser', value)} options={browserOptions} />
                    <TextField label="Proxy URL (optional)" value={values.proxy} onChange={value => set('proxy', value)} placeholder="http://127.0.0.1:8080" />
                  </Grid>
                  <PathField label="cookies.txt file" value={values.cookiesFile} onChange={value => set('cookiesFile', value)} onBrowse={browseCookies} placeholder="Optional Netscape cookies.txt path" />
                  <Callout tone="warning">Only use cookies from accounts you control. FlickFetch does not unlock private posts or bypass account restrictions.</Callout>
                </Card>
                <Card title="Transfer controls" description="Balance speed against stability and politeness to the server.">
                  <Grid>
                    <TextField label="Speed limit" value={values.rateLimit} onChange={value => set('rateLimit', value)} placeholder="Unlimited" hint="Examples: 500K, 2M, 1.5M" />
                    <SelectField label="Parallel fragments" value={values.fragments} onChange={value => set('fragments', Number(value))} options={[1, 2, 4, 6, 8, 12, 16].map(value => ({ value, label: `${value} fragment${value === 1 ? '' : 's'}` }))} />
                    <SelectField label="Retry attempts" value={values.retries} onChange={value => set('retries', Number(value))} options={[0, 1, 3, 5, 10, 15, 20, 30].map(value => ({ value, label: `${value} ${value === 1 ? 'retry' : 'retries'}` }))} />
                    <SelectField label="Simultaneous downloads" value={values.parallel} onChange={value => set('parallel', Number(value))} options={[1, 2, 3, 4, 5].map(value => ({ value, label: `${value} at a time` }))} />
                  </Grid>
                </Card>
              </>}

              {tab === 'behavior' && <>
                <Card title="Queue & automation" icon={Activity}>
                  <Rows>
                    <Switch checked={values.autoStart} onChange={value => set('autoStart', value)} label="Start queued downloads automatically" description="Begin new items without pressing Resume." />
                    <Switch checked={values.watchClipboard} onChange={value => set('watchClipboard', value)} label="Watch clipboard for media links" description="FlickFetch offers to add detected links; nothing downloads without your action." />
                    <Switch checked={values.autoUpdate} onChange={value => set('autoUpdate', value)} label="Check for yt-dlp updates on startup" description="Applies to the copy FlickFetch manages itself." />
                  </Rows>
                </Card>
                <Card title="Advanced" description="Appended to every yt-dlp command, one argument per line. Use only options you understand.">
                  <label className="st-field"><span className="st-label">Extra yt-dlp arguments</span>
                    <textarea className="field-control st-textarea" value={values.extraArgs ?? ''} onChange={event => set('extraArgs', event.target.value)} placeholder={'--embed-chapters\n--no-mtime'} spellCheck={false} />
                  </label>
                </Card>
              </>}

              {tab === 'tools' && <>
                <Card title="Components" description="yt-dlp extracts, FFmpeg merges and converts, Deno solves JavaScript challenges." icon={HardDrive}
                  action={<button type="button" className="btn-secondary st-small" onClick={onRefreshTools} disabled={busy}><Activity size={13} /> Refresh</button>}>
                  <div className="st-tools">
                    <ToolTile name="yt-dlp" item={toolStatus?.ytDlp} />
                    <ToolTile name="FFmpeg / FFprobe" item={toolStatus?.ffmpeg} />
                    <ToolTile name="Deno runtime" item={toolStatus?.deno} />
                  </div>
                  <div className="st-folder"><div><span className="st-label">Install folder</span><code title={toolStatus?.binDir}>{toolStatus?.binDir || 'Loading…'}</code></div>{toolStatus?.platform && <span className="st-badge">{toolStatus.platform}</span>}</div>
                  {toolsProgress && toolAction && <div className="st-progress"><div><span>{toolsProgress.label}</span><span>{Math.round(toolsProgress.progress || 0)}%</span></div><ProgressBar value={toolsProgress.progress} /></div>}
                  {!toolStatus?.installSupported && <Callout tone="warning">Automatic installation is packaged for Windows x64. On other platforms, install these tools yourself and add them to PATH.</Callout>}
                  <div className="st-actions">
                    <button type="button" className="btn-primary" onClick={install} disabled={busy || !toolStatus?.installSupported}><Wrench size={14} />{toolAction === 'install' ? 'Installing…' : 'Install / repair all tools'}</button>
                    <button type="button" className="btn-secondary" onClick={update} disabled={busy || !toolStatus?.ytDlp?.installed}><Activity size={14} />{toolAction === 'update' ? 'Updating…' : 'Update yt-dlp'}</button>
                  </div>
                  <p className="st-hint">yt-dlp is installed only after its official SHA-256 checksum is verified. FFmpeg and Deno come from their upstream releases and keep their own licenses (see THIRD-PARTY-NOTICES.md).</p>
                </Card>
              </>}
            </div>
          </div>
        </div>

        <footer className="st-footer">
          <span className={`st-status ${dirty ? 'is-dirty' : ''}`}><i />{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
          <div className="st-footer-actions">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="button" className="btn-primary" onClick={save} disabled={busy || !dirty} title="Save (Ctrl S)"><Save size={14} />{busy && !toolAction ? 'Saving…' : 'Save settings'}</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
