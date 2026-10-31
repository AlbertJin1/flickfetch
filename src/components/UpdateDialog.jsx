import React, { useEffect, useMemo, useRef } from 'react';
import { describeTransfer } from '../lib/format.js';
import { ArrowUpRight, Check, CircleAlert, CloudOff, Download, FlaskConical, FolderOpen, RefreshCw, X } from 'lucide-react';

const PHASES = { prepare: 'Preparing', manifest: 'Checking release', differential: 'Comparing files', download: 'Downloading', verify: 'Verifying', reconstruct: 'Rebuilding', save: 'Saving', saved: 'Saved', restarting: 'Restarting' };
const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function buildLabel(info, appInfo) {
  if (info ? info.development : appInfo?.packaged === false) return 'Development build';
  if (info?.installMode === 'install') return 'Portable build';
  if (info?.installMode === 'download') return 'Installed build';
  return 'Release build';
}

function formatChecked(timestamp) {
  if (!timestamp) return '';
  try { return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
}

// Release notes arrive as plain text from the Monitor. Render lines starting with -, * or • as a list; everything else as paragraphs.
function parseNotes(notes) {
  const blocks = [];
  String(notes || '').replace(/\r\n?/g, '\n').split('\n').forEach(raw => {
    const line = raw.trim();
    if (!line) return;
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    const last = blocks[blocks.length - 1];
    if (bullet) {
      if (last?.type === 'list') last.items.push(bullet[1]);
      else blocks.push({ type: 'list', items: [bullet[1]] });
    } else blocks.push({ type: 'p', text: line.replace(/^#{1,6}\s+/, '') });
  });
  return blocks;
}

/**
 * Derives one display state from the check lifecycle:
 * checking | error | unavailable | available | ahead | current | none
 */
function deriveState({ info, checking, error }) {
  if (checking && !info) return 'checking';
  if (checking) return 'checking';
  if (error) return 'error';
  if (!info) return 'checking';
  if (info.supported === false) return 'unavailable';
  if (info.updateAvailable) return 'available';
  if (info.releaseState === 'ahead') return 'ahead';
  if (info.releaseState === 'no_release' || info.releaseState === 'rollout_blocked') return 'none';
  return 'current';
}

export default function UpdateDialog({ info, appInfo = {}, checking, error, installing, progress, savedUpdate, onCheck, onInstall, onReveal, onClose }) {
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const returnFocusRef = useRef(null);
  const state = deriveState({ info, checking, error });
  const downloadMode = info?.installMode === 'download';
  const canInstall = state === 'available' && Boolean(info?.installMode);
  const percent = Math.max(0, Math.min(100, Number(progress?.percent || 0)));
  const currentVersion = info?.currentVersion || appInfo.version || '';
  const notes = useMemo(() => parseNotes(info?.notes), [info?.notes]);
  const isDev = info ? Boolean(info.development) : appInfo.packaged === false;

  // Focus management: move focus in, trap Tab, close on Escape, restore focus on unmount.
  useEffect(() => {
    returnFocusRef.current = document.activeElement;
    const node = dialogRef.current;
    node?.querySelector('[data-autofocus]')?.focus();
    const onKeyDown = event => {
      if (event.key === 'Escape') { event.stopPropagation(); onCloseRef.current?.(); return; }
      if (event.key !== 'Tab' || !node) return;
      const items = [...node.querySelectorAll(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => { document.removeEventListener('keydown', onKeyDown, true); returnFocusRef.current?.focus?.(); };
  }, []);

  const hero = {
    checking: { icon: <RefreshCw size={26} className="update-spin" />, title: 'Checking for updates…', text: 'Contacting the FlickFetch Monitor for the latest release.' },
    error: { icon: <CloudOff size={26} />, title: 'Couldn’t check for updates', text: error || 'The FlickFetch Monitor could not be reached. Check your connection and try again.' },
    unavailable: { icon: <CircleAlert size={26} />, title: 'Updates unavailable', text: info?.message || 'Updates can’t be checked on this platform.' },
    available: { icon: <Download size={26} />, title: `Version ${info?.latestVersion} is available`, text: downloadMode ? 'FlickFetch will download and verify the new release; you then open the new file to switch.' : info?.installMode ? 'FlickFetch will download, verify, and restart into the new version.' : 'A newer release is published. Development builds can’t install it, so grab it from a packaged build.' },
    ahead: { icon: <FlaskConical size={26} />, title: 'You’re ahead of the latest release', text: `This build (${currentVersion}) is newer than the latest published release (${info?.latestVersion}). It’s the latest unreleased version.` },
    none: { icon: <Check size={26} />, title: info?.releaseState === 'rollout_blocked' ? 'Rollout in progress' : 'No release published yet', text: info?.message || 'There is nothing to update to right now.' },
    current: { icon: <Check size={26} />, title: 'FlickFetch is up to date', text: `You’re running the latest release${currentVersion ? `, version ${currentVersion}` : ''}.` }
  }[state];

  const tone = state === 'available' ? 'accent' : state === 'error' || state === 'unavailable' ? 'warn' : state === 'ahead' ? 'violet' : state === 'checking' ? 'pending' : 'ok';
  const showVersions = !['checking', 'error', 'unavailable'].includes(state) && info?.latestVersion && state !== 'none';
  const checkedAt = formatChecked(info?.checkedAt);

  return (
    <div className="update-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose?.(); }}>
      <section ref={dialogRef} className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title" aria-describedby="update-desc">
        <header className="update-head">
          <h2>Software update</h2>
          <span className={`update-chip ${isDev ? 'is-dev' : ''}`}>{buildLabel(info, appInfo)}</span>
          <button type="button" className="icon-button update-close" onClick={onClose} aria-label="Close update dialog" data-autofocus><X size={17} /></button>
        </header>

        <div className={`update-hero is-${tone}`} aria-live="polite">
          <div className="update-hero-icon" aria-hidden="true">{hero.icon}</div>
          <div>
            <h3 id="update-title">{hero.title}</h3>
            <p id="update-desc">{hero.text}</p>
          </div>
        </div>

        {showVersions && (
          <dl className="update-versions">
            <div><dt>Installed</dt><dd>{currentVersion}</dd></div>
            <i aria-hidden="true">{state === 'available' ? '→' : state === 'ahead' ? '>' : '='}</i>
            <div><dt>Latest release</dt><dd>{info.latestVersion}</dd></div>
          </dl>
        )}

        {state === 'ahead' && isDev && <p className="update-note">Development mode: update checks work, but nothing is ever downloaded or replaced here.</p>}
        {state === 'available' && !info?.installMode && isDev && <p className="update-note">Development mode: installing updates is disabled.</p>}

        {state === 'available' && notes.length > 0 && (
          <div className="update-notes">
            <h4>What’s new</h4>
            <div className="update-notes-body" tabIndex={0}>
              {notes.map((block, index) => block.type === 'list'
                ? <ul key={index}>{block.items.map((item, i) => <li key={i}>{item}</li>)}</ul>
                : <p key={index}>{block.text}</p>)}
            </div>
          </div>
        )}

        {installing && (
          <div className="app-update-progress update-progress" role="status" aria-live="polite">
            <div><span>{PHASES[progress?.phase] || 'Preparing'}</span><b>{percent}%</b></div>
            <progress max="100" value={percent} />
            {progress?.totalChunks > 0 && <small className="update-diff">Only {progress.missingChunks} of {progress.totalChunks} blocks changed, so only those are downloaded.</small>}
          </div>
        )}

        {savedUpdate && !installing && state === 'available' && (
          <p className="update-saved"><Check size={14} /> Saved and verified. {describeTransfer(savedUpdate.transfer)}{savedUpdate.transfer ? '. ' : ''}Close FlickFetch, then open the new file to switch.</p>
        )}

        <footer className="update-actions">
          <span className="update-checked">{checking ? '' : checkedAt ? `Last checked ${checkedAt}` : ''}</span>
          <button type="button" className="btn-secondary" onClick={onCheck} disabled={checking || installing}>
            <RefreshCw size={14} className={checking ? 'update-spin' : ''} /> {state === 'error' ? 'Try again' : 'Check again'}
          </button>
          {canInstall && (savedUpdate && !installing
            ? <button type="button" className="btn-primary" onClick={onReveal}><FolderOpen size={14} /> Show in folder</button>
            : <button type="button" className="btn-primary" onClick={onInstall} disabled={installing || checking}>
                {installing ? (downloadMode ? 'Downloading…' : 'Installing…') : <>{downloadMode ? 'Download update' : 'Update now'} <ArrowUpRight size={14} /></>}
              </button>)}
          {!canInstall && <button type="button" className="btn-primary" onClick={onClose}>Done</button>}
        </footer>
      </section>
    </div>
  );
}
