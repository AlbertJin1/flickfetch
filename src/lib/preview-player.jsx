import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

/**
 * One shared, audio-only player for the whole app.
 *
 * It lives above the workspaces, so a preview keeps playing while you switch tabs, only one preview can play at a
 * time, and rows only re-render when the *state* changes (the 4 Hz playback position is a separate context that only
 * the player bar subscribes to).
 *
 * status: idle -> loading (resolving the stream) -> playing <-> buffering / paused -> ended | error
 */
const StateContext = createContext(null);
const TimeContext = createContext(0);

const VOLUME_KEY = 'flickfetch-preview-volume';
const MUTED_KEY = 'flickfetch-preview-muted';
/** A preview that has not started within this long after its source was set is treated as failed (and retried once). */
const START_TIMEOUT_MS = 20000;
const MAX_AUTO_RETRIES = 1;

const readStored = (key, fallback, parse) => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : parse(raw);
  } catch { return fallback; }
};
const writeStored = (key, value) => {
  try { localStorage.setItem(key, String(value)); }
  catch { /* Storage may be disabled in a restricted preview. */ }
};

const MEDIA_ERRORS = {
  2: 'The audio stream was interrupted. Check your connection and try again.',
  3: 'This audio couldn’t be decoded.',
  4: 'FlickFetch couldn’t play this stream. Updating yt-dlp in Settings may help.'
};

export function PreviewPlayerProvider({ children }) {
  const audioRef = useRef(null);
  const tokenRef = useRef(0);
  const attemptRef = useRef(0);
  const watchdogRef = useRef(null);
  const loadRef = useRef(null);
  const stateRef = useRef({ status: 'idle', track: null, duration: 0, error: '', retrying: false });
  const [state, setState] = useState(stateRef.current);
  const [position, setPosition] = useState(0);
  const [volume, setVolumeState] = useState(() => readStored(VOLUME_KEY, 0.8, raw => Math.min(1, Math.max(0, Number(raw) || 0))));
  const [muted, setMutedState] = useState(() => readStored(MUTED_KEY, false, raw => raw === 'true'));

  const update = useCallback(patch => {
    stateRef.current = { ...stateRef.current, ...patch };
    setState(stateRef.current);
  }, []);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
  }, []);

  /** A failed attempt: quietly try once more (this is exactly what pressing Preview a second time used to do), then give up. */
  const failOrRetry = useCallback((token, message) => {
    if (token !== tokenRef.current) return;
    clearWatchdog();
    const track = stateRef.current.track;
    if (track && attemptRef.current < MAX_AUTO_RETRIES) { loadRef.current?.(track, attemptRef.current + 1); return; }
    update({ status: 'error', error: message, retrying: false });
  }, [clearWatchdog, update]);

  if (!audioRef.current && typeof Audio !== 'undefined') {
    audioRef.current = new Audio();
    audioRef.current.preload = 'auto';
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    audio.volume = volume;
    audio.muted = muted;
  }, [volume, muted]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    const current = () => stateRef.current;
    const handlers = {
      playing: () => { clearWatchdog(); update({ status: 'playing', error: '', retrying: false }); },
      pause: () => { if (['playing', 'buffering'].includes(current().status)) update({ status: 'paused' }); },
      waiting: () => { if (current().status === 'playing') update({ status: 'buffering' }); },
      ended: () => { setPosition(0); update({ status: 'ended' }); },
      timeupdate: () => setPosition(audio.currentTime || 0),
      durationchange: () => { if (Number.isFinite(audio.duration) && audio.duration > 0) update({ duration: audio.duration }); },
      error: () => {
        // Ignore the error raised by clearing the source when a preview is stopped or replaced.
        if (!audio.getAttribute('src') || !current().track) return;
        failOrRetry(tokenRef.current, MEDIA_ERRORS[audio.error?.code] || MEDIA_ERRORS[4]);
      }
    };
    for (const [name, handler] of Object.entries(handlers)) audio.addEventListener(name, handler);
    return () => {
      for (const [name, handler] of Object.entries(handlers)) audio.removeEventListener(name, handler);
      clearWatchdog();
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    };
  }, [update, clearWatchdog, failOrRetry]);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    tokenRef.current += 1; // invalidates any preview that is still resolving
    clearWatchdog();
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    setPosition(0);
    update({ status: 'idle', track: null, duration: 0, error: '', retrying: false });
  }, [update, clearWatchdog]);

  /** Resolve + play a track. `attempt` > 0 is the automatic retry, which also forgets anything cached for the video. */
  const load = useCallback(async (track, attempt) => {
    const audio = audioRef.current;
    if (!audio) return;
    attemptRef.current = attempt;
    const token = ++tokenRef.current;
    clearWatchdog();
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    setPosition(0);
    update({ status: 'loading', track, duration: 0, error: '', retrying: attempt > 0 });

    let info;
    try { info = await window.flickfetch.preview.prepare(track.url, attempt > 0 ? { fresh: true } : undefined); }
    catch (error) { failOrRetry(token, error?.message || 'Couldn’t load the preview.'); return; }
    if (token !== tokenRef.current) return; // the user moved on while we were resolving

    update({ duration: info.durationSeconds || 0 });
    watchdogRef.current = setTimeout(() => failOrRetry(token, MEDIA_ERRORS[2]), START_TIMEOUT_MS);
    audio.src = info.src;
    try { await audio.play(); }
    catch (error) {
      if (token !== tokenRef.current || error.name === 'AbortError') return;
      failOrRetry(token, MEDIA_ERRORS[audio.error?.code] || MEDIA_ERRORS[4]);
    }
  }, [clearWatchdog, failOrRetry, update]);
  loadRef.current = load;

  /** Warm the stream lookup (e.g. on hover) so pressing Preview starts sooner. Fire-and-forget. */
  const warm = useCallback(url => {
    try { window.flickfetch?.preview?.warm?.(url)?.catch?.(() => {}); } catch { /* optional */ }
  }, []);

  /** Start (or toggle) a preview. `track` = { key, url, title, artist }. */
  const toggle = useCallback(async track => {
    const audio = audioRef.current;
    if (!audio || !track?.url) return;
    const current = stateRef.current;

    if (current.track?.key === track.key) {
      if (current.status === 'loading') { stop(); return; }
      if (current.status === 'playing' || current.status === 'buffering') { audio.pause(); return; }
      if (current.status === 'paused' || current.status === 'ended') {
        if (current.status === 'ended') audio.currentTime = 0;
        try { await audio.play(); } catch (error) { if (error.name !== 'AbortError') update({ status: 'error', error: MEDIA_ERRORS[4] }); }
        return;
      }
      // status === 'error': fall through and try again from scratch
    }

    attemptRef.current = 0;
    loadRef.current(track, 0);
  }, [stop, update]);

  const resume = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !stateRef.current.track) return;
    const { status, track } = stateRef.current;
    if (status === 'error') { toggle(track); return; }
    if (status === 'ended') audio.currentTime = 0;
    try { await audio.play(); } catch (error) { if (error.name !== 'AbortError') update({ status: 'error', error: MEDIA_ERRORS[4] }); }
  }, [toggle, update]);

  const pause = useCallback(() => { audioRef.current?.pause(); }, []);

  const seek = useCallback(seconds => {
    const audio = audioRef.current;
    if (!audio || !audio.getAttribute('src')) return;
    const limit = stateRef.current.duration || audio.duration || 0;
    const next = Math.min(Math.max(0, Number(seconds) || 0), limit || Number(seconds) || 0);
    audio.currentTime = next;
    setPosition(next);
  }, []);

  const setVolume = useCallback(value => {
    const next = Math.min(1, Math.max(0, Number(value) || 0));
    setVolumeState(next); writeStored(VOLUME_KEY, next);
    if (next > 0) { setMutedState(false); writeStored(MUTED_KEY, false); }
  }, []);

  const toggleMute = useCallback(() => {
    setMutedState(value => { writeStored(MUTED_KEY, !value); return !value; });
  }, []);

  // OS media keys / overlay: show what is playing and let the hardware keys control it.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return undefined;
    const session = navigator.mediaSession;
    const { track, status } = state;
    try {
      session.metadata = track && typeof MediaMetadata !== 'undefined' ? new MediaMetadata({ title: track.title || 'Preview', artist: track.artist || '', album: 'FlickFetch preview' }) : null;
      session.playbackState = status === 'playing' || status === 'buffering' ? 'playing' : status === 'paused' ? 'paused' : 'none';
      session.setActionHandler('play', track ? () => resume() : null);
      session.setActionHandler('pause', track ? () => pause() : null);
      session.setActionHandler('stop', track ? () => stop() : null);
    } catch { /* Media Session is optional. */ }
    return undefined;
  }, [state, resume, pause, stop]);

  const api = useMemo(() => ({
    ...state, volume, muted, toggle, warm, resume, pause, stop, seek, setVolume, toggleMute
  }), [state, volume, muted, toggle, warm, resume, pause, stop, seek, setVolume, toggleMute]);

  return (
    <StateContext.Provider value={api}>
      <TimeContext.Provider value={position}>{children}</TimeContext.Provider>
    </StateContext.Provider>
  );
}

export function usePreviewPlayer() {
  const value = useContext(StateContext);
  if (!value) throw new Error('usePreviewPlayer must be used inside <PreviewPlayerProvider>.');
  return value;
}

/** Playback position in seconds. Only the player bar should subscribe: it updates several times a second. */
export const usePreviewPosition = () => useContext(TimeContext);
