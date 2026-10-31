import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Disc3, ExternalLink, FileSpreadsheet, Headphones, Loader2, Music2, PlayCircle, Search, Sparkles, Youtube } from 'lucide-react';
import { formatDuration } from '../lib/format.js';
import { Notice, ProgressBar, SectionHeading, StatCard } from './Primitives.jsx';

export default function SpotifyWorkspace({ initialRequest, toolStatus, onToast, onOpenDownloads }) {
  const [url, setUrl] = useState('');
  const [playlist, setPlaylist] = useState(null);
  const [importing, setImporting] = useState(false);
  const [matching, setMatching] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, trackTitle: '', status: '' });
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedMatches, setSelectedMatches] = useState({});
  const [busyTrack, setBusyTrack] = useState(null);
  const lastRequestSequence = useRef(0);

  useEffect(() => window.flickfetch.on.spotifyProgress(payload => {
    setProgress({ current: payload.current, total: payload.total, trackTitle: payload.trackTitle, status: payload.status });
    if (payload.track) setPlaylist(current => current ? ({ ...current, tracks: current.tracks.map(track => track.number === payload.track.number ? payload.track : track) }) : current);
  }), []);

  const matchedCount = playlist?.tracks.filter(track => track.candidates?.length).length || 0;
  const failedCount = playlist?.tracks.filter(track => track.matchStatus === 'Failed' || (track.matchStatus && track.matchStatus !== 'Matched' && track.matchStatus !== 'Waiting for search')).length || 0;
  const filteredTracks = useMemo(() => (playlist?.tracks || []).filter(track => {
    if (filter === 'matched' && !track.candidates?.length) return false;
    if (filter === 'unmatched' && track.candidates?.length) return false;
    return !search || `${track.title} ${track.artist} ${track.album}`.toLowerCase().includes(search.toLowerCase());
  }), [playlist, filter, search]);

  const importPlaylist = async (sourceUrl = url) => {
    const playlistUrl = String(sourceUrl || '').trim();
    if (!playlistUrl) return;
    setUrl(playlistUrl);
    setImporting(true); setError(''); setPlaylist(null); setSelectedMatches({});
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
  }, [initialRequest?.sequence]);

  const findMatches = async () => {
    if (!playlist) return;
    setMatching(true); setError(''); setSelectedMatches({});
    setProgress({ current: 0, total: playlist.tracks.length, trackTitle: 'Preparing YouTube searches…', status: '' });
    try {
      const result = await window.flickfetch.spotify.findMatches(playlist);
      setPlaylist(result);
      setProgress({ current: result.tracks.filter(track => track.candidates?.length || track.matchStatus === 'Failed').length, total: result.tracks.length, trackTitle: result.canceled ? 'Matching canceled' : 'Matching finished', status: '' });
      onToast?.(result.canceled ? 'info' : 'success', result.canceled ? 'Match search canceled' : 'YouTube review is ready', result.canceled ? 'Completed suggestions were kept. You can resume by searching again.' : 'Check each suggestion before adding it to the download queue.');
    } catch (exception) { setError(exception.message); }
    finally { setMatching(false); }
  };

  const selectedCandidate = track => {
    const urlValue = selectedMatches[track.number];
    return track.candidates?.find(candidate => candidate.url === urlValue) || track.bestMatch || track.candidates?.[0] || null;
  };

  const addMatch = async track => {
    const candidate = selectedCandidate(track);
    if (!candidate?.url) return;
    setBusyTrack(track.number);
    try {
      await window.flickfetch.spotify.addMatch(candidate.url, `${track.artist} - ${track.title}`);
      onToast?.('success', 'Added to download queue', track.title);
    } catch (exception) { onToast?.('error', 'Could not add match', exception.message); }
    finally { setBusyTrack(null); }
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

  return (
    <div className="scrollbar-thin h-full overflow-y-auto px-7 pb-8 pt-6">
      <SectionHeading eyebrow="Playlist review" title="Spotify playlist matcher" description="Import a public playlist, search for audio-first YouTube candidates, and review each suggested match." right={<div className="flex items-center gap-2 rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-[10px] font-semibold text-emerald-700"><Music2 size={14} /> Public embed · No Spotify sign-in</div>} />

      <div className="panel mb-5 overflow-hidden">
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4"><div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600"><Disc3 size={18} /></div><div><div className="text-[13px] font-bold text-slate-900">Import playlist metadata</div><div className="mt-0.5 text-[10px] text-slate-400">Paste a Spotify playlist link. Only publicly exposed playlist information is supported.</div></div></div>
        <div className="p-5"><label className="field-label">Spotify playlist URL</label><div className="flex gap-2"><input className="field-control min-w-0 flex-1" value={url} onChange={event => setUrl(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') importPlaylist(); }} placeholder="https://open.spotify.com/playlist/…" /><button className="btn-primary shrink-0" disabled={!url.trim() || importing} onClick={importPlaylist}>{importing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}{importing ? 'Reading playlist…' : 'Import playlist'}</button></div>
          <div className="mt-3 flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-[9px] leading-relaxed text-slate-500"><Sparkles size={13} className="mt-0.5 shrink-0 text-emerald-600" /><span>FlickFetch reads the public Spotify embed page; it does not use an API key, OAuth flow, or Spotify account login. Private playlists and some tracks may not be visible through this public surface.</span></div>
        </div>
      </div>

      {error && <div className="mb-5"><Notice tone="error">{error}</Notice></div>}

      {playlist ? <>
        <div className="panel mb-5 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 p-5"><div className="flex min-w-0 items-center gap-3"><div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-600 text-white shadow-soft"><Music2 size={22} /></div><div className="min-w-0"><div className="truncate text-[16px] font-bold text-slate-900">{playlist.name}</div><div className="mt-0.5 truncate text-[10px] text-slate-400">{playlist.owner} · {playlist.tracks.length} tracks</div><button className="mt-1 inline-flex items-center gap-1 text-[9px] font-semibold text-emerald-700 hover:underline" onClick={() => openLink(playlist.url)}>Open Spotify playlist <ExternalLink size={10} /></button></div></div><div className="flex flex-wrap gap-2"><button className="btn-secondary" onClick={exportCsv}><FileSpreadsheet size={14} /> Export CSV</button><button className="btn-primary" disabled={matching || !toolStatus?.ytDlp?.installed} onClick={findMatches}>{matching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}{matching ? 'Finding matches…' : 'Find YouTube matches'}</button></div></div>
          <div className="grid grid-cols-3 gap-3 p-4"><StatCard icon={Music2} label="Playlist tracks" value={playlist.tracks.length} tone="emerald" /><StatCard icon={CheckCircle2} label="Matched" value={matchedCount} tone="brand" /><StatCard icon={Headphones} label="Need review" value={failedCount || Math.max(0, playlist.tracks.length - matchedCount)} tone="amber" /></div>
          {matching && <div className="border-t border-slate-100 px-5 py-3"><div className="mb-2 flex items-center justify-between gap-3 text-[10px]"><span className="truncate font-semibold text-slate-600">{progress.trackTitle || 'Searching YouTube…'}</span><div className="flex items-center gap-3"><span className="shrink-0 font-bold tabular-nums text-brand-700">{progress.current} / {progress.total}</span><button className="font-bold text-rose-600 hover:underline" onClick={() => window.flickfetch.spotify.cancelMatches()}>Cancel search</button></div></div><ProgressBar value={progress.total ? progress.current / progress.total * 100 : 0} /></div>}
        </div>

        <div className="panel overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3"><div><div className="text-[13px] font-bold text-slate-900">Track-by-track match review</div><div className="mt-0.5 text-[9px] text-slate-400">Choose a candidate, open it for review, or add it to the regular download queue.</div></div><div className="flex items-center gap-2"><div className="relative"><Search size={12} className="absolute left-2.5 top-2.5 text-slate-400" /><input className="w-[170px] rounded-lg border border-slate-200 py-1.5 pl-8 pr-2 text-[10px] outline-none focus:border-brand-400" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search tracks…" /></div><div className="flex rounded-lg bg-slate-100 p-0.5">{[['all', 'All'], ['matched', 'Matched'], ['unmatched', 'No match']].map(([id, label]) => <button key={id} className={`rounded-md px-2 py-1.5 text-[9px] font-bold ${filter === id ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-400'}`} onClick={() => setFilter(id)}>{label}</button>)}</div></div></div>
          {filteredTracks.length ? <div className="divide-y divide-slate-100">{filteredTracks.map(track => {
            const candidate = selectedCandidate(track);
            const hasCandidates = track.candidates?.length > 0;
            return <div key={track.number} className="grid grid-cols-[38px_minmax(0,1fr)_minmax(250px,.95fr)_94px] items-center gap-4 px-5 py-4 transition hover:bg-slate-50/60">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-[10px] font-bold text-slate-500">{track.number}</div>
              <div className="min-w-0"><div className="truncate text-[11px] font-bold text-slate-800">{track.title}</div><div className="mt-0.5 truncate text-[9px] text-slate-500">{track.artist}</div><div className="mt-1 flex items-center gap-2 text-[8px] text-slate-400"><span>{track.album || 'Album not listed'}</span><span>·</span><span>{formatDuration(track.durationMilliseconds)}</span>{track.spotifyUrl && <button className="font-semibold text-emerald-700 hover:underline" onClick={() => openLink(track.spotifyUrl)}>Spotify track</button>}</div></div>
              <div className="min-w-0">{hasCandidates ? <><div className="mb-1 flex items-center justify-between gap-2"><span className="text-[8px] font-extrabold uppercase tracking-[.12em] text-slate-400">Suggested YouTube result</span><span className={`rounded-full px-2 py-0.5 text-[8px] font-bold ${candidate?.score >= 80 ? 'bg-emerald-50 text-emerald-700' : candidate?.score >= 62 ? 'bg-brand-50 text-brand-700' : 'bg-amber-50 text-amber-700'}`}>{candidate?.score ?? '—'} / 100</span></div><select className="field-control !py-2 text-[10px]" value={candidate?.url || ''} onChange={event => setSelectedMatches(current => ({ ...current, [track.number]: event.target.value }))}>{track.candidates.map((item, index) => <option key={item.url} value={item.url}>{index + 1}. {item.title} · {item.score}%</option>)}</select><div className="mt-1 truncate text-[8px] text-slate-400">{candidate?.channel || 'Unknown channel'} · {candidate?.matchLabel || 'Review candidate'}</div></> : <div className="rounded-lg bg-slate-50 px-3 py-2 text-[9px] text-slate-400">{track.matchStatus || 'Waiting for search'}</div>}</div>
              <div className="flex flex-col items-end gap-1.5">{hasCandidates ? <><button className="btn-secondary !w-full !justify-center !px-2 !py-2" onClick={() => openLink(candidate?.url)}><Youtube size={13} /> Open</button><button className="btn-primary !w-full !justify-center !px-2 !py-2" disabled={busyTrack === track.number} onClick={() => addMatch(track)}>{busyTrack === track.number ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} Add</button></> : <span className="text-[9px] text-slate-300">No result</span>}</div>
            </div>;
          })}</div> : <div className="px-5 py-12 text-center text-[10px] text-slate-400">No tracks match your search or filter.</div>}
        </div>
        <div className="mt-4"><Notice tone="warning">Match scores are heuristic suggestions, not verification that a result is the same recording or that it may legally be downloaded. Check the title, artist, source, and rights yourself. FlickFetch does not bulk-download playlist matches automatically.</Notice></div>
      </> : <div className="panel flex flex-col items-center px-6 py-16 text-center"><div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600"><Music2 size={25} /></div><div className="mt-4 text-[14px] font-bold text-slate-800">Your playlist review starts here</div><p className="mt-1 max-w-[360px] text-[10px] leading-relaxed text-slate-400">Import a public Spotify playlist to read its track list. FlickFetch will then search YouTube and show likely matches for you to review individually.</p><button className="btn-secondary mt-4" onClick={onOpenDownloads}>Go to Downloads <ExternalLink size={13} /></button></div>}

    </div>
  );
}
