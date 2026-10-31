import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Check, CircleAlert, Copy, FolderSearch, HardDrive, ShieldCheck, Star, X } from 'lucide-react';

const AUTHOR = { name: 'Jessie Albert Regualos', alias: 'Yotsuchi' };
const FALLBACK_VERSION = '2.1.1';

const PLATFORM_NAMES = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
const ARCH_NAMES = { x64: '64-bit', arm64: 'ARM64', ia32: '32-bit' };

function formatPlatform(raw) {
  if (!raw) return 'Desktop';
  const [os, arch] = String(raw).split('-');
  const osName = PLATFORM_NAMES[os] || os;
  return arch ? `${osName} ${ARCH_NAMES[arch] || arch}` : osName;
}

// Each tool reports a raw first line of output ("ffmpeg version N-127709-g1a2b3c-…",
// "deno 2.9.7 (stable, release, …)"). Show only the part people can read at a glance;
// the full string stays available as a tooltip and in "Copy version info".
function shortVersion(key, raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  let match = null;
  if (key === 'ffmpeg') match = text.match(/version\s+((?:N-\d+)|(?:n?\d+(?:\.\d+)+))/i);
  else if (key === 'deno') match = text.match(/deno\s+(\d+(?:\.\d+)+)/i);
  else match = text.match(/^\d+(?:\.\d+)+/);
  return match ? match[1] || match[0] : text.length > 22 ? `${text.slice(0, 21)}…` : text;
}

const TOOL_DEFS = [
  { key: 'ytDlp', label: 'yt-dlp', role: 'Finds and downloads video and audio from supported sites' },
  { key: 'ffmpeg', label: 'FFmpeg', role: 'Merges streams, converts formats, and extracts audio' },
  { key: 'deno', label: 'Deno', role: 'Runs the scripts some sites need before yt-dlp can read them' }
];

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export default function AboutDialog({ appInfo = {}, toolStatus, ytUpdate, onClose, onOpenTools, onOpenGuide, onOpenReview }) {
  const dialogRef = useRef(null);
  const returnFocusRef = useRef(null);
  const copyTimer = useRef(null);
  const [copied, setCopied] = useState(false);

  const version = appInfo.version || FALLBACK_VERSION;
  const platform = formatPlatform(appInfo.platform);

  const tools = useMemo(() => TOOL_DEFS.map(def => {
    const info = toolStatus?.[def.key];
    const state = !toolStatus ? 'pending' : info?.installed ? 'ok' : 'missing';
    const managed = Boolean(info?.path && toolStatus?.binDir && info.path.toLowerCase().startsWith(String(toolStatus.binDir).toLowerCase()));
    const updateTo = def.key === 'ytDlp' && state === 'ok' && ytUpdate?.updateAvailable ? ytUpdate.latest : null;
    return { ...def, info, state, managed, updateTo, short: shortVersion(def.key, info?.version) };
  }), [toolStatus, ytUpdate]);

  const toolsKnown = Boolean(toolStatus);
  const missingCount = tools.filter(tool => tool.state === 'missing').length;
  const updateCount = tools.filter(tool => tool.updateTo).length;
  const summary = !toolsKnown
    ? { tone: 'pending', text: 'Checking…' }
    : missingCount
      ? { tone: 'warn', text: `${missingCount} of ${tools.length} need setup` }
      : updateCount
        ? { tone: 'warn', text: 'Update available' }
        : { tone: 'ok', text: 'All ready' };

  // Focus management: move focus in, trap Tab, close on Escape, restore focus on unmount.
  useEffect(() => {
    returnFocusRef.current = document.activeElement;
    const node = dialogRef.current;
    node?.querySelector('[data-autofocus]')?.focus();

    const onKeyDown = event => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose?.(); return; }
      if (event.key !== 'Tab' || !node) return;
      const items = [...node.querySelectorAll(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      clearTimeout(copyTimer.current);
      returnFocusRef.current?.focus?.();
    };
  }, [onClose]);

  const copyDetails = useCallback(async () => {
    const lines = [
      `FlickFetch ${version}`,
      `Platform: ${appInfo.platform || 'unknown'}`,
      ...tools.map(tool => `${tool.label}: ${tool.state === 'ok' ? (tool.info?.version || 'installed') : 'not installed'}`)
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard unavailable — fail quietly */ }
  }, [appInfo.platform, tools, version]);

  const reveal = useCallback(path => {
    window.flickfetch?.app?.revealPath?.(path)?.catch?.(() => {});
  }, []);

  const needsSetup = toolsKnown && missingCount > 0;

  return (
    <div className="about-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose?.(); }}>
      <section ref={dialogRef} className="about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title" aria-describedby="about-desc">
        <header className="about-head">
          <div className="about-logo" aria-hidden="true">F</div>
          <div className="about-title">
            <h2 id="about-title">FlickFetch</h2>
            <span className="about-sub">Version {version} · {platform}</span>
          </div>
          <button type="button" className="icon-button about-close" onClick={onClose} aria-label="Close About dialog" data-autofocus>
            <X size={17} />
          </button>
        </header>

        <p id="about-desc" className="about-desc">
          Download video and audio from supported sites, and turn public Spotify playlists into YouTube matches you can review. FlickFetch runs on three helper tools, listed below.
        </p>

        <div className="about-section">
          <div className="about-section-head">
            <h3>Helper tools</h3>
            <span className={`about-status is-${summary.tone}`} role="status">
              {summary.tone === 'ok' ? <Check size={12} /> : summary.tone === 'warn' ? <CircleAlert size={12} /> : null}
              {summary.text}
            </span>
          </div>
          <ul className="about-tools-list">
            {tools.map(tool => (
              <li key={tool.key} className={`about-tool is-${tool.state}`}>
                <i aria-hidden="true" />
                <div className="about-tool-main">
                  <span className="about-tool-name">{tool.label}</span>
                  <span className="about-tool-role">{tool.role}</span>
                  {tool.state === 'ok' && (
                    <span className="about-tool-source">
                      {tool.updateTo ? `Update available: ${tool.updateTo}` : tool.managed ? 'Managed by FlickFetch' : 'Using your system install'}
                    </span>
                  )}
                </div>
                <div className="about-tool-side">
                  <span className="about-tool-version" title={tool.info?.version || undefined}>
                    {tool.state === 'pending' ? '—' : tool.state === 'missing' ? 'Not installed' : (tool.short || 'Installed')}
                  </span>
                  {tool.state === 'ok' && tool.info?.path && (
                    <button type="button" className="about-tool-reveal" onClick={() => reveal(tool.info.path)} aria-label={`Show ${tool.label} in its folder`} title="Show in folder">
                      <FolderSearch size={14} />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <button type="button" className={needsSetup ? 'btn-primary about-tools-btn' : 'btn-secondary about-tools-btn'} onClick={onOpenTools}>
            <HardDrive size={15} /> {needsSetup ? 'Install missing tools' : 'Manage helper tools'}
          </button>
        </div>

        <div className="about-links">
          {onOpenGuide && (
            <button type="button" className="btn-secondary" onClick={onOpenGuide}>
              <BookOpen size={14} /> Quick guide
            </button>
          )}
          {onOpenReview && (
            <button type="button" className="btn-secondary" onClick={onOpenReview}>
              <Star size={14} /> Review app
            </button>
          )}
          <button type="button" className={`btn-secondary ${copied ? 'is-copied' : ''}`} onClick={copyDetails} aria-live="polite">
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy version info'}
          </button>
        </div>

        <footer className="about-legal">
          <div className="about-credit">
            <ShieldCheck size={15} aria-hidden="true" />
            <div>
              <strong>Designed &amp; developed by {AUTHOR.name}</strong>
              <span>aka {AUTHOR.alias} · Copyright © 2026</span>
            </div>
          </div>
          <p>yt-dlp, FFmpeg, and Deno are separate projects with their own licenses. Read THIRD-PARTY-NOTICES.md before sharing FlickFetch.</p>
        </footer>
      </section>
    </div>
  );
}
