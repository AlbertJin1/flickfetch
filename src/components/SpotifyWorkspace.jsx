import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Download, ExternalLink, FileSpreadsheet, Headphones, Info, Link2, ListMusic, Loader2,
  Music2, PauseCircle, PlayCircle, Search, SearchX, Wand2, X
} from 'lucide-react';
import { formatDuration } from '../lib/format.js';
import { usePreviewPlayer } from '../lib/preview-player.jsx';
import DropdownSelect from './DropdownSelect.jsx';
import { FilterTabs, Meter, Stepper, SwitchChip } from './ui.jsx';

const STEPS = [
  { label: 'Import playlist', hint: 'Paste a Spotify link' },
  { label: 'Find audio', hint: 'Match each song' },
  { label: 'Review & download', hint: 'Check the results' }
];

/** One song, one state. Everything in the UI is derived from this. */
const stateOf = track => {
  if (track.queued) return 'queued';
  if (track.bestMatch) return 'ready';
  if (track.candidates?.length) return 'review';
  if (track.matchStatus === 'Failed' || track.matchStatus === 'Needs review') return 'nomatch';
  return 'pending';
};

const strength = score => (score >= 80 ? ['Strong match', 'is-strong'] : score >= 62 ? ['Likely match', 'is-likely'] : ['Weak match', 'is-weak']);
const youtubeSearchUrl = track => `https://www.youtube.com/results?search_query=${encodeURIComponent(`${track.artist} ${track.title} audio`)}`;

/** Label + icon for a row's Preview button, derived from the shared player state. */
function previewButtonState(player, key) {
  const active = player.track?.key === key;
  const status = active ? player.status : 'idle';
  if (status === 'loading') return { Icon: Loader2, spin: true, label: 'Loading…', title: 'Cancel this preview', active };
  if (status === 'playing' || status === 'buffering') return { Icon: PauseCircle, label: 'Pause', title: 'Pause the preview', active };
  if (status === 'paused') return { Icon: PlayCircle, label: 'Resume', title: 'Resume the preview', active };
  if (status === 'ended') return { Icon: PlayCircle, label: 'Replay', title: 'Play the preview again', active };
  if (status === 'error') return { Icon: PlayCircle, label: 'Retry', title: 'Try the preview again', active };
  return { Icon: PlayCircle, label: 'Preview', title: 'Listen to this version here in FlickFetch', active: false };
}

function TrackStatus({ state }) {
  const map = {
    queued: ['Downloading', 'queued', CheckCircle2],
    ready: ['Ready', 'ready', CheckCircle2],
    review: ['Needs review', 'review', AlertTriangle],
    nomatch: ['No match', 'nomatch', SearchX],
    pending: ['Waiting', 'pending', null]
  };
  const [label, tone, Icon] = map[state];
  return <span className={`ff-badge ff-badge-sp-${tone}`}>{Icon ? <Icon size={13} aria-hidden="true" /> : <i aria-hidden="true" />}{label}</span>;
}

export default function SpotifyWorkspace({ initialRequest, toolStatus, onToast, onOpenDownloads, onOpenSettings }) {
  const [url, setUrl] = useState('');
  const [playlist, setPlaylist] = useState(null);
  const [importing, setImporting] = useState(false);
  const [matching, setMatching] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, trackTitle: '', status: '' });
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedMatches, setSelectedMatches] = useState({});
  const [openPickers, setOpenPickers] = useState({});
  const [busyTrack, setBusyTrack] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [autoDownload, setAutoDownload] = useState(true);
  const lastRequestSequence = useRef(0);
  const listTopRef = useRef(null);
  const player = usePreviewPlayer();

  useEffect(() => window.flickfetch.on.spotifyProgress(payload => {
    setProgress({ current: payload.current, total: payload.total, trackTitle: payload.trackTitle, status: payload.status });
    if (payload.track) setPlaylist(current => current ? ({ ...current, tracks: current.tracks.map(track => track.number === payload.track.number ? payload.track : track) }) : current);
  }), []);

  const tracks = playlist?.tracks || [];
  const counts = useMemo(() => {
    const result = { all: tracks.length, queued: 0, ready: 0, review: 0, nomatch: 0, pending: 0 };
    for (const track of tracks) result[stateOf(track)] += 1;
    return result;
  }, [tracks]);
  const searched = tracks.length - counts.pending;
  const hasResults = searched > 0;
  const needAttention = counts.review + counts.nomatch;
  const step = !playlist ? 0 : (matching || hasResults) ? 2 : 1;
  const engineReady = Boolean(toolStatus?.ytDlp?.installed);

  const filteredTracks = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return tracks.filter(track => {
      const state = stateOf(track);
      if (filter === 'attention' ? !(state === 'review' || state === 'nomatch') : filter !== 'all' && state !== filter) return false;
      return !needle || `${track.title} ${track.artist} ${track.album}`.toLowerCase().includes(needle);
    });
  }, [tracks, filter, search]);

  const importPlaylist = async (sourceUrl = url) => {
    // Only accept a real string: a click handler must never leak its event object in here.
    const playlistUrl = (typeof sourceUrl === 'string' ? sourceUrl : url).trim();
    if (!playlistUrl) return;
    setUrl(playlistUrl);
    setImporting(true); setError(''); setPlaylist(null); setSelectedMatches({}); setOpenPickers({}); setFilter('all'); setSearch('');
    try {
      const result = await window.flickfetch.spotify.importPlaylist(playlistUrl);
      setPlaylist(result); setProgress({ current: 0, total: result.tracks.length, trackTitle: '', status: '' });
      onToast?.('success', 'Playlist imported', `${result.tracks.length} tracks were read from the public Spotify embed.`);
    } catch (exception) { setError(exception.message); }
    finally { setImporting(false); }
  };

  useEffect(() => {
    if (initialRequest?.sequence && initialRequest.sequence !== lastRequestSequence.current && initialRequest.url) {
      lastRequestSequence.current = initialRequest.sequence;
      void importPlaylist(initialRequest.url);
    }
  }, [initialRequest?.sequence]); // eslint-disable-line react-hooks/exhaustive-deps

  const changePlaylist = () => {
    if (matching) return;
    setPlaylist(null); setError(''); setSelectedMatches({}); setOpenPickers({}); setFilter('all'); setSearch('');
  };

  const findMatches = async () => {
    if (!playlist) return;
    setMatching(true); setError(''); setSelectedMatches({});
    setProgress({ current: 0, total: playlist.tracks.length, trackTitle: 'Starting search…', status: '' });
    try {
      const result = await window.flickfetch.spotify.findMatches(playlist, { autoDownload });
      setPlaylist(result);
      const queued = result.tracks.filter(track => track.queued).length;
      const review = result.tracks.filter(track => !track.bestMatch && !track.queued).length;
      setProgress({ current: result.tracks.filter(track => track.candidates?.length || track.matchStatus === 'Failed' || track.queued).length, total: result.tracks.length, trackTitle: result.canceled ? 'Search canceled' : 'Search finished', status: '' });
      onToast?.(result.canceled ? 'info' : 'success', result.canceled ? 'Search canceled' : (autoDownload ? `${queued} song${queued === 1 ? '' : 's'} downloading` : 'Matches are ready'), result.canceled ? 'Finished songs were kept. Search again to continue with the rest.' : (review ? `${review} song${review === 1 ? '' : 's'} need a quick look below.` : 'Every song found a confident match.'));
      if (!result.canceled && review) setFilter('attention');
    } catch (exception) { setError(exception.message); }
    finally { setMatching(false); }
  };

  const selectedCandidate = track => {
    const urlValue = selectedMatches[track.number];
    return track.candidates?.find(candidate => candidate.url === urlValue) || track.bestMatch || track.candidates?.find(candidate => !candidate.rejected) || track.candidates?.[0] || null;
  };

  const queueTrack = async track => {
    const candidate = selectedCandidate(track);
    if (!candidate?.url) return false;
    await window.flickfetch.spotify.addMatch(candidate, track, playlist?.name);
    setPlaylist(current => current ? ({ ...current, tracks: current.tracks.map(entry => entry.number === track.number ? { ...entry, queued: true } : entry) }) : current);
    return true;
  };

  const addMatch = async track => {
    setBusyTrack(track.number);
    try { if (await queueTrack(track)) onToast?.('success', 'Download started', track.title); }
    catch (exception) { onToast?.('error', 'Could not add this song', exception.message); }
    finally { setBusyTrack(null); }
  };

  const downloadReady = async () => {
    const targets = tracks.filter(track => stateOf(track) === 'ready');
    if (!targets.length) return;
    setBulkBusy(true);
    let added = 0;
    try { for (const track of targets) { try { if (await queueTrack(track)) added += 1; } catch { /* keep going; failures stay visible in the list */ } } }
    finally { setBulkBusy(false); }
    onToast?.(added === targets.length ? 'success' : 'warning', `${added} song${added === 1 ? '' : 's'} downloading`, added === targets.length ? 'You can follow progress in Downloads.' : `${targets.length - added} could not be added. Try them one by one.`);
  };

  const exportCsv = async () => {
    try {
      const result = await window.flickfetch.spotify.exportCsv(playlist);
      if (!result.canceled) onToast?.('success', 'CSV exported', result.filePath);
    } catch (exception) { onToast?.('error', 'Export failed', exception.message); }
  };

  const openLink = async value => {
    if (!value) return;
    try { await window.flickfetch.app.openExternal(value); }
    catch (exception) { onToast?.('error', 'Could not open link', exception.message); }
  };

  const showAttention = () => { setFilter('attention'); setSearch(''); listTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  const tabs = [
    { value: 'all', label: 'All', count: counts.all },
    { value: 'queued', label: 'Downloading', count: counts.queued },
    { value: 'ready', label: 'Ready', count: counts.ready },
    { value: 'attention', label: 'Needs attention', count: needAttention },
    { value: 'pending', label: 'Not searched', count: counts.pending }
  ].filter(tab => tab.value === 'all' || tab.count > 0 || filter === tab.value);

  return (
    <div className="ff-page scrollbar-thin">
      <div className="ff-page-inner">
        <header className="ff-page-head">
          <h1>Spotify matcher</h1>
          <p>Turn a public Spotify playlist into audio files. FlickFetch finds the studio version of each song and downloads it for you.</p>
        </header>

        <Stepper steps={STEPS} current={step} />

        {error && (
          <div className="ff-inline-note ff-note-error" role="alert"><AlertTriangle size={16} aria-hidden="true" /><span><b>Something went wrong.</b> {error}</span><button type="button" className="ff-icon-btn" aria-label="Dismiss" onClick={() => setError('')}><X size={15} /></button></div>
        )}

        {!playlist ? (
          <section className="ff-card ff-import" aria-label="Import a playlist">
            <div className="ff-import-icon"><Link2 size={22} aria-hidden="true" /></div>
            <h2>Paste your playlist link</h2>
            <p>In Spotify, open the playlist, choose <b>Share</b>, then <b>Copy link to playlist</b>.</p>
            <form className="ff-import-form" onSubmit={event => { event.preventDefault(); importPlaylist(); }}>
              <input value={url} onChange={event => setUrl(event.target.value)} placeholder="https://open.spotify.com/playlist/…" aria-label="Spotify playlist link" spellCheck={false} autoFocus />
              <button type="submit" className="ff-btn ff-btn-primary ff-btn-lg" disabled={!url.trim() || importing}>
                {importing ? <><Loader2 size={17} className="animate-spin" aria-hidden="true" />Reading playlist…</> : <><ListMusic size={17} aria-hidden="true" />Import playlist</>}
              </button>
            </form>
            <ul className="ff-import-facts">
              <li><CheckCircle2 size={15} aria-hidden="true" />No Spotify login or API key needed</li>
              <li><CheckCircle2 size={15} aria-hidden="true" />Public playlists only</li>
              <li><CheckCircle2 size={15} aria-hidden="true" />Nothing downloads until you start the search</li>
            </ul>
          </section>
        ) : (
          <>
            <section className="ff-card ff-playlist" aria-label="Imported playlist">
              <div className="ff-playlist-cover" aria-hidden="true"><Music2 size={24} /></div>
              <div className="ff-playlist-copy">
                <h2 title={playlist.name}>{playlist.name}</h2>
                <p>{[playlist.owner, `${tracks.length} songs`].filter(Boolean).join(' · ')}</p>
              </div>
              <div className="ff-playlist-actions">
                <button type="button" className="ff-link" onClick={() => openLink(playlist.url)}><ExternalLink size={14} aria-hidden="true" />Open in Spotify</button>
                <button type="button" className="ff-btn ff-btn-ghost" onClick={exportCsv}><FileSpreadsheet size={15} aria-hidden="true" />Export CSV</button>
                <button type="button" className="ff-btn ff-btn-ghost" onClick={changePlaylist} disabled={matching}>Use another playlist</button>
              </div>
            </section>

            {matching ? (
              <section className="ff-card ff-run" aria-live="polite">
                <div className="ff-run-top">
                  <div><h2>Finding audio versions</h2><p>{progress.trackTitle || 'Searching…'}</p></div>
                  <div className="ff-run-count"><b>{progress.current}</b><span>of {progress.total}</span></div>
                </div>
                <Meter value={progress.total ? progress.current / progress.total * 100 : 0} />
                <div className="ff-run-foot">
                  <span>{autoDownload ? `${counts.queued} downloading so far · ${needAttention} need review` : `${counts.ready} matched so far · ${needAttention} need review`}</span>
                  <button type="button" className="ff-btn ff-btn-danger-quiet" onClick={() => window.flickfetch.spotify.cancelMatches()}><X size={15} aria-hidden="true" />Cancel search</button>
                </div>
              </section>
            ) : !hasResults ? (
              <section className="ff-card ff-start">
                <div className="ff-start-copy">
                  <h2>Ready to match {tracks.length} songs</h2>
                  <p>For each song, FlickFetch looks for the original studio audio. Music videos, live versions, remixes and covers are skipped.</p>
                  <SwitchChip checked={autoDownload} onChange={setAutoDownload} label="Start downloading as soon as a confident match is found" />
                </div>
                <div className="ff-start-cta">
                  <button type="button" className="ff-btn ff-btn-primary ff-btn-xl" onClick={findMatches} disabled={!engineReady}>
                    <Wand2 size={18} aria-hidden="true" />{autoDownload ? 'Find & download songs' : 'Find matches'}
                  </button>
                  {!engineReady && <p className="ff-warn-text"><AlertTriangle size={14} aria-hidden="true" />The download engine isn’t installed yet. <button type="button" className="ff-link" onClick={onOpenSettings}>Open Settings</button> to install it.</p>}
                </div>
              </section>
            ) : (
              <section className="ff-card ff-summary" aria-label="Results summary">
                <div className="ff-summary-stats">
                  <div className="is-good"><b>{counts.queued + counts.ready}</b><span>{counts.queued ? 'matched' : 'ready'}</span></div>
                  <div className={needAttention ? 'is-warn' : ''}><b>{needAttention}</b><span>need attention</span></div>
                  {counts.pending > 0 && <div><b>{counts.pending}</b><span>not searched</span></div>}
                </div>
                <div className="ff-summary-actions">
                  {counts.ready > 0 && <button type="button" className="ff-btn ff-btn-primary ff-btn-lg" onClick={downloadReady} disabled={bulkBusy}>{bulkBusy ? <Loader2 size={17} className="animate-spin" aria-hidden="true" /> : <Download size={17} aria-hidden="true" />}Download {counts.ready} ready song{counts.ready === 1 ? '' : 's'}</button>}
                  {needAttention > 0 && <button type="button" className={`ff-btn ${counts.ready > 0 ? 'ff-btn-ghost' : 'ff-btn-primary ff-btn-lg'}`} onClick={showAttention}><Headphones size={16} aria-hidden="true" />Review {needAttention} song{needAttention === 1 ? '' : 's'}</button>}
                  {counts.queued > 0 && <button type="button" className="ff-btn ff-btn-ghost" onClick={onOpenDownloads}>See progress in Downloads</button>}
                  {(counts.pending > 0 || counts.nomatch > 0) && <button type="button" className="ff-btn ff-btn-ghost" onClick={findMatches} disabled={!engineReady}><Search size={15} aria-hidden="true" />Search again</button>}
                </div>
              </section>
            )}

            <section className="ff-tracks" aria-label="Songs" ref={listTopRef}>
              <div className="ff-tracks-bar">
                {tabs.length > 1 ? <FilterTabs label="Filter songs" value={filter} onChange={setFilter} tabs={tabs} /> : <h2 className="ff-tracks-title">Songs <span>{tracks.length}</span></h2>}
                <label className="ff-search"><Search size={15} aria-hidden="true" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search songs" aria-label="Search songs" /></label>
              </div>

              {filteredTracks.length ? (
                <ul className="ff-list">
                  {filteredTracks.map(track => {
                    const state = stateOf(track);
                    const candidate = selectedCandidate(track);
                    const hasCandidates = Boolean(track.candidates?.length);
                    const pickerOpen = state === 'review' || openPickers[track.number];
                    const [strengthLabel, strengthTone] = strength(candidate?.score);
                    const plain = !hasResults && !matching;
                    const showPicker = pickerOpen && hasCandidates && state !== 'queued';
                    const cleanLabel = candidate?.matchLabel ? candidate.matchLabel.replace(/^(Confident|Review|Skipped) · /, '') : '';
                    const meta = state === 'review' ? cleanLabel : candidate?.channel;
                    const previewKey = candidate?.url ? `${track.number}:${candidate.url}` : '';
                    const previewUi = previewButtonState(player, previewKey);
                    return (
                      <li key={track.number} className={`ff-track is-${state} ${plain ? 'is-plain' : ''} ${previewUi.active ? 'is-previewing' : ''}`}>
                        <span className="ff-track-num" aria-label={`Song ${track.number}`}>{track.number}</span>
                        <div className="ff-track-main">
                          <span className="ff-track-title">{track.title}</span>
                          <span className="ff-track-sub">{[track.artist, track.album, formatDuration(track.durationMilliseconds)].filter(value => value && value !== '—').join(' · ')}</span>
                        </div>

                        {!plain && (
                          <div className="ff-track-match">
                            {state === 'queued' && candidate ? (
                              <div className="ff-match-inline"><TrackStatus state={state} /><span className="ff-candidate-title" title={candidate.title}>{candidate.title}</span></div>
                            ) : (
                              <>
                                <div className="ff-track-status"><TrackStatus state={state} /></div>
                                {hasCandidates && candidate && !showPicker && <span className="ff-candidate-title" title={candidate.title}>{candidate.title}</span>}
                                {showPicker && (
                                  <div className="ff-picker">
                                    <DropdownSelect className="ff-picker-select" ariaLabel={`Choose a version of ${track.title}`} value={candidate?.url || ''} onChange={value => setSelectedMatches(current => ({ ...current, [track.number]: value }))}
                                      options={track.candidates.map((item, index) => ({ value: item.url, label: `${index + 1}. ${item.title}${item.rejected ? ' (skipped)' : ''}` }))} />
                                  </div>
                                )}
                                {hasCandidates && candidate && <span className="ff-candidate-meta"><span className={`ff-strength ${strengthTone}`}>{strengthLabel}</span>{meta ? ` · ${meta}` : ''}</span>}
                                {!hasCandidates && state === 'nomatch' && <span className="ff-candidate-meta">{track.matchError || track.queueError || 'No confident studio version was found for this song.'}</span>}
                              </>
                            )}
                            {track.queueError && hasCandidates && <span className="ff-candidate-error">{track.queueError}</span>}
                          </div>
                        )}

                        {!plain && (
                          <div className="ff-track-actions">
                            {hasCandidates && state !== 'queued' && (
                              <>
                                <button type="button" className="ff-btn ff-btn-primary" disabled={busyTrack === track.number || bulkBusy} onClick={() => addMatch(track)}>{busyTrack === track.number ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}Download</button>
                                <button type="button" className={`ff-btn ff-btn-quiet ff-btn-preview ${previewUi.active ? 'is-active' : ''}`} onPointerEnter={() => player.warm(candidate.url)} onFocus={() => player.warm(candidate.url)} onClick={() => player.toggle({ key: previewKey, url: candidate.url, title: candidate.title || track.title, artist: track.artist })} title={previewUi.title} aria-label={`${previewUi.label}: ${track.title}`}><previewUi.Icon size={15} className={previewUi.spin ? 'animate-spin' : undefined} aria-hidden="true" />{previewUi.label}</button>
                                {state === 'ready' && !pickerOpen && <button type="button" className="ff-link" onClick={() => setOpenPickers(current => ({ ...current, [track.number]: true }))}>Change version</button>}
                              </>
                            )}
                            {state === 'nomatch' && (
                              <>
                                <button type="button" className="ff-btn ff-btn-soft" onClick={() => openLink(youtubeSearchUrl(track))}><Search size={15} aria-hidden="true" />Search YouTube</button>
                                {track.spotifyUrl && <button type="button" className="ff-link" onClick={() => openLink(track.spotifyUrl)}>Spotify</button>}
                              </>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="ff-empty ff-empty-compact"><h3>No songs in this view</h3><p>{search ? `Nothing matches “${search}”.` : 'Try a different filter.'}</p><button type="button" className="ff-btn ff-btn-ghost" onClick={() => { setFilter('all'); setSearch(''); }}>Show all songs</button></div>
              )}
            </section>

            <details className="ff-about">
              <summary><Info size={15} aria-hidden="true" />How matching works</summary>
              <p>Only studio audio is downloaded automatically: YouTube Music songs, “Topic” album uploads and official audio whose title, artist and length match Spotify. Music videos, live, remix, sped-up or slowed versions, covers, and anything more than 7 seconds off are skipped. Songs without a confident match are left for you to review. Make sure you have the right to download what you save.</p>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
