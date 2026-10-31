import React, { useMemo, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Check, CircleHelp, Download, ExternalLink,
  FolderCog, Link2, ListChecks, Music2, PlayCircle, Settings2, Sparkles, X
} from 'lucide-react';

const GUIDE_STEPS = [
  {
    id: 'add', eyebrow: 'STEP 01 · START HERE', title: 'Bring a link into FlickFetch',
    description: 'Paste a public media URL, drop a link onto the app, or use the clipboard button. FlickFetch checks the source and adds it to your queue.',
    Icon: Link2, accent: 'mint', bullets: ['Paste one link per line', 'Press Ctrl + Enter to add quickly', 'Drop .txt or .url link lists onto the window']
  },
  {
    id: 'tune', eyebrow: 'STEP 02 · MAKE IT YOURS', title: 'Choose how your media is saved',
    description: 'Set your preferred quality, format, output folder, subtitle behavior, and network options. Each new queue item keeps a snapshot of its settings.',
    Icon: Settings2, accent: 'violet', bullets: ['Pick a quality preset or audio-only mode', 'Choose MP4, MKV, or WebM', 'Use advanced settings only when you need them']
  },
  {
    id: 'manage', eyebrow: 'STEP 03 · STAY IN CONTROL', title: 'Track every task in one queue',
    description: 'Watch progress, transfer speed, and completion status. Pause the queue, stop an individual task, retry a failure, or open a completed file.',
    Icon: ListChecks, accent: 'amber', bullets: ['Select a row to inspect its activity log', 'Use filters and search to find a task', 'Completed and failed items stay in History']
  },
  {
    id: 'spotify', eyebrow: 'STEP 04 · PLAYLIST WORKFLOW', title: 'Match a Spotify playlist',
    description: 'Import a public Spotify playlist, review the YouTube candidates, then add only the tracks you approve. Matches are suggestions, not official Spotify downloads.',
    Icon: Music2, accent: 'pink', bullets: ['Paste a public playlist URL', 'Review title, artist, and candidate quality', 'Add selected matches or export the review as CSV']
  }
];

export default function GuideDialog({ onClose, onNavigate, onAddUrls }) {
  const [step, setStep] = useState(0);
  const [sampleUrl, setSampleUrl] = useState('');
  const [added, setAdded] = useState(false);
  const active = GUIDE_STEPS[step];
  const Icon = active.Icon;
  const progress = useMemo(() => ((step + 1) / GUIDE_STEPS.length) * 100, [step]);

  const finish = () => {
    localStorage.setItem('flickfetch-guide-v1', 'completed');
    onClose?.();
  };

  const goToAction = () => {
    if (step === 1) onNavigate?.('settings');
    else if (step === 3) onNavigate?.('spotify');
    else onNavigate?.('downloads');
  };

  const submitSample = async () => {
    const value = sampleUrl.trim();
    if (!value) return;
    const result = await onAddUrls?.([value]);
    if (result?.length) setAdded(true);
  };

  return (
    <div className="guide-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) finish(); }}>
      <section className="guide-dialog" role="dialog" aria-modal="true" aria-labelledby="guide-title">
        <aside className="guide-rail">
          <div className="guide-brand"><div className="guide-brand-mark">F</div><div><b>FlickFetch</b><span>QUICK START GUIDE</span></div></div>
          <div className="guide-rail-copy"><span>YOUR FIRST 3 MINUTES</span><h3>Everything you need to get moving.</h3><p>A short walkthrough of the everyday workflows.</p></div>
          <div className="guide-step-list">
            {GUIDE_STEPS.map((item, index) => {
              const StepIcon = item.Icon;
              return <button key={item.id} onClick={() => setStep(index)} className={`guide-step ${index === step ? 'is-active' : ''} ${index < step ? 'is-done' : ''}`}>
                <span className="guide-step-number">{index < step ? <Check size={14} /> : `0${index + 1}`}</span>
                <span className="guide-step-text"><b>{item.title}</b><small>{item.eyebrow.replace(/^STEP 0\d · /, '')}</small></span>
                <StepIcon size={16} />
              </button>;
            })}
          </div>
          <div className="guide-rail-foot"><Sparkles size={15} /><span>Designed to keep your workflow simple and in your control.</span></div>
        </aside>

        <div className="guide-content">
          <div className="guide-topline"><div className="guide-progress-label">GETTING STARTED <span>{String(step + 1).padStart(2, '0')} / 04</span></div><button className="icon-button" onClick={finish} aria-label="Close guide"><X size={18} /></button></div>
          <div className="guide-progress"><span style={{ width: `${progress}%` }} /></div>
          <div className={`guide-art guide-art-${active.accent}`}>
            <div className="guide-art-orbit orbit-one" /><div className="guide-art-orbit orbit-two" />
            <div className="guide-art-card"><div className="guide-art-icon"><Icon size={31} /></div><div className="guide-art-lines"><i /><i /><i /></div><div className="guide-art-check"><Check size={15} /></div></div>
            <div className="guide-art-float float-one"><PlayCircle size={17} /> <span>Ready when you are</span></div>
            <div className="guide-art-float float-two"><Sparkles size={16} /></div>
          </div>

          <div className="guide-copy">
            <div className="guide-eyebrow">{active.eyebrow}</div>
            <h2 id="guide-title">{active.title}</h2>
            <p>{active.description}</p>
            <div className="guide-bullets">{active.bullets.map(item => <div key={item}><span><Check size={12} /></span>{item}</div>)}</div>
          </div>

          {step === 0 && <div className="guide-try-box"><label htmlFor="guide-url">TRY IT · ADD A MEDIA LINK</label><div className="guide-try-row"><input id="guide-url" value={sampleUrl} onChange={event => { setSampleUrl(event.target.value); setAdded(false); }} placeholder="https://www.youtube.com/watch?v=…" onKeyDown={event => { if (event.key === 'Enter') submitSample(); }} /><button onClick={submitSample} disabled={!sampleUrl.trim()}>Add link <ArrowRight size={14} /></button></div>{added && <small className="guide-success"><Check size={12} /> Added to your download queue.</small>}</div>}
          {step === 1 && <button className="guide-action-card" onClick={goToAction}><span className="guide-action-icon"><FolderCog size={18} /></span><span><b>Explore download settings</b><small>Open the settings panel and choose your defaults.</small></span><ExternalLink size={15} /></button>}
          {step === 2 && <button className="guide-action-card" onClick={goToAction}><span className="guide-action-icon"><Download size={18} /></span><span><b>View your download queue</b><small>See active tasks and their progress.</small></span><ExternalLink size={15} /></button>}
          {step === 3 && <button className="guide-action-card" onClick={goToAction}><span className="guide-action-icon"><Music2 size={18} /></span><span><b>Open Spotify matcher</b><small>Import and review a public playlist.</small></span><ExternalLink size={15} /></button>}

          <div className="guide-footer"><button className="guide-skip" onClick={finish}>Skip guide</button><div className="guide-nav-buttons">{step > 0 && <button className="guide-back" onClick={() => setStep(value => value - 1)}><ArrowLeft size={15} /> Back</button>}{step < GUIDE_STEPS.length - 1 ? <button className="guide-next" onClick={() => setStep(value => value + 1)}>Continue <ArrowRight size={15} /></button> : <button className="guide-next" onClick={finish}>Finish guide <Check size={15} /></button>}</div></div>
        </div>
      </section>
    </div>
  );
}
