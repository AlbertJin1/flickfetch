import React from 'react';
import { AlertTriangle, ExternalLink, Loader2, Music2, Pause, Play, RotateCcw, Volume1, Volume2, VolumeX, X } from 'lucide-react';
import { usePreviewPlayer, usePreviewPosition } from '../lib/preview-player.jsx';

const clock = seconds => {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

function Progress({ duration, disabled, onSeek }) {
  const position = usePreviewPosition();
  const max = duration > 0 ? duration : 0;
  const shown = Math.min(position, max || position);
  const percent = max ? (shown / max) * 100 : 0;
  return (
    <div className="ff-pb-progress">
      <span className="ff-pb-time" aria-hidden="true">{clock(shown)}</span>
      <input
        type="range" className="ff-pb-range" min={0} max={max || 1} step={0.25} value={max ? shown : 0}
        disabled={disabled || !max} aria-label="Seek" aria-valuetext={`${clock(shown)} of ${clock(max)}`}
        style={{ '--ff-pb-fill': `${percent}%` }} onChange={event => onSeek(Number(event.target.value))}
      />
      <span className="ff-pb-time" aria-hidden="true">{max ? clock(max) : '–:––'}</span>
    </div>
  );
}

export default function PreviewBar() {
  const player = usePreviewPlayer();
  const { track, status, error, duration, volume, muted, retrying } = player;
  if (!track) return null;

  const loading = status === 'loading';
  const failed = status === 'error';
  const playing = status === 'playing' || status === 'buffering';
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const sub = failed ? error : loading ? (retrying ? 'Trying again…' : 'Finding the audio…') : status === 'buffering' ? 'Buffering…' : [track.artist, status === 'ended' ? 'Finished' : 'Preview'].filter(Boolean).join(' · ');

  return (
    <section className={`ff-previewbar ${failed ? 'is-error' : ''}`} aria-label="Audio preview">
      <div className="ff-pb-art" aria-hidden="true">{failed ? <AlertTriangle size={18} /> : loading ? <Loader2 size={18} className="animate-spin" /> : <Music2 size={18} />}</div>
      <div className="ff-pb-meta">
        <strong title={track.title}>{track.title || 'Preview'}</strong>
        <span role={failed ? 'alert' : 'status'} title={sub}>{sub}</span>
      </div>

      <div className="ff-pb-controls">
        {failed ? (
          <button type="button" className="ff-btn ff-btn-ghost ff-pb-retry" onClick={() => player.toggle(track)}><RotateCcw size={15} aria-hidden="true" />Try again</button>
        ) : (
          <button type="button" className="ff-pb-play" onClick={() => (playing ? player.pause() : loading ? player.stop() : player.resume())} aria-label={loading ? 'Cancel preview' : playing ? 'Pause preview' : 'Play preview'}>
            {loading ? <Loader2 size={18} className="animate-spin" aria-hidden="true" /> : playing ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
          </button>
        )}
      </div>

      <Progress duration={duration} disabled={loading || failed} onSeek={player.seek} />

      <div className="ff-pb-volume">
        <button type="button" className="ff-pb-icon" onClick={player.toggleMute} aria-label={muted ? 'Unmute' : 'Mute'} aria-pressed={muted}><VolumeIcon size={17} aria-hidden="true" /></button>
        <input type="range" className="ff-pb-range ff-pb-range-volume" min={0} max={1} step={0.05} value={muted ? 0 : volume} aria-label="Volume" style={{ '--ff-pb-fill': `${(muted ? 0 : volume) * 100}%` }} onChange={event => player.setVolume(event.target.value)} />
      </div>

      <button type="button" className="ff-pb-icon" title="Open this video on YouTube" aria-label="Open this video on YouTube" onClick={() => window.flickfetch.app.openExternal(track.url).catch(() => {})}><ExternalLink size={16} aria-hidden="true" /></button>
      <button type="button" className="ff-pb-icon" title="Close player" aria-label="Close player" onClick={player.stop}><X size={17} aria-hidden="true" /></button>
    </section>
  );
}
