const { spawn } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const execFileAsync = promisify(execFile);

const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'feat', 'featuring', 'ft', 'official', 'audio', 'video', 'lyrics', 'lyric', 'topic']);
const MUSIC_VIDEO = /\b(official\s+)?(music\s+video|video\s+official|official\s+video|mv)\b|\b4k\s+(music\s+)?video\b/i;
const LIVE = /\b(live|concert|performance|session|stage\s+version)\b/i;
const VISUALIZER = /\b(visuali[sz]er|dance\s+video|reaction|karaoke|instrumental)\b/i;
const AUDIO_SIGNAL = /\b(official\s+audio|audio\s+only|provided\s+to\s+youtube\s+by|lyrics?)\b/i;

function htmlDecode(value) {
  return String(value || '')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function getProp(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  const found = Object.keys(obj).find(name => name.toLowerCase() === key.toLowerCase());
  return found ? obj[found] : undefined;
}

function readText(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(readText).filter(Boolean).join(', ');
  if (value && typeof value === 'object') {
    for (const key of ['name', 'title', 'text', 'subtitle', 'label']) {
      const text = readText(getProp(value, key));
      if (text) return text;
    }
  }
  return '';
}

function readAny(obj, ...keys) {
  for (const key of keys) {
    const value = readText(getProp(obj, key));
    if (value.trim()) return value.trim();
  }
  return '';
}

function findObjectWithTrackList(node) {
  if (!node || typeof node !== 'object') return null;
  if (!Array.isArray(node) && (Array.isArray(getProp(node, 'trackList')) || (getProp(node, 'trackList') && typeof getProp(node, 'trackList') === 'object'))) return node;
  for (const value of Object.values(node)) {
    const found = findObjectWithTrackList(value);
    if (found) return found;
  }
  return null;
}

function parseDuration(value) {
  if (typeof value === 'number') return value > 0 ? Math.round(value < 10000 ? value * 1000 : value) : 0;
  if (value && typeof value === 'object') {
    const ms = Number(getProp(value, 'totalMilliseconds') ?? getProp(value, 'milliseconds'));
    if (ms > 0) return Math.round(ms);
    const seconds = Number(getProp(value, 'seconds'));
    return seconds > 0 ? Math.round(seconds * 1000) : 0;
  }
  if (typeof value === 'string') {
    const parts = value.trim().split(':').map(Number);
    if ((parts.length === 2 || parts.length === 3) && parts.every(n => Number.isFinite(n) && n >= 0)) {
      const seconds = parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2];
      return Math.round(seconds * 1000);
    }
  }
  return 0;
}

function parseSpotifyUrl(input) {
  const raw = String(input || '').trim();
  const uri = /^spotify:playlist:([A-Za-z0-9]{10,40})$/i.exec(raw);
  if (uri) return uri[1];
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (!(host === 'open.spotify.com' || host === 'spotify.link' || host.endsWith('.spotify.link') || host === 'spotify.app.link' || host.endsWith('.spotify.app.link'))) return null;
  const match = /^\/(?:embed\/)?(?:intl-[a-z]{2}\/)?playlist\/([A-Za-z0-9]{10,40})\/?$/i.exec(url.pathname);
  return match ? match[1] : null;
}

async function fetchPlaylist(url) {
  let playlistId = parseSpotifyUrl(url);
  if (!playlistId) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Paste a public Spotify playlist URL.'); }
    if (parsed.protocol !== 'https:' || !/(^|\.)spotify\.(link|app\.link)$/.test(parsed.hostname)) {
      throw new Error('Paste a public Spotify playlist URL, for example https://open.spotify.com/playlist/…');
    }
    const shortResponse = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'Mozilla/5.0 FlickFetch/2.1.0' } });
    playlistId = parseSpotifyUrl(shortResponse.url);
    if (!playlistId) throw new Error('This share link did not resolve to a Spotify playlist. Check that it is a playlist link rather than a track or album.');
  }

  const playlistUrl = `https://open.spotify.com/playlist/${playlistId}`;
  const embedUrl = `https://open.spotify.com/embed/playlist/${playlistId}?utm_source=generator&theme=0`;
  const response = await fetch(embedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9'
    },
    signal: AbortSignal.timeout(30000)
  });
  const html = await response.text();
  if (!response.ok) throw new Error(`Spotify did not return this public playlist (HTTP ${response.status}). The playlist may be private, unavailable, or temporarily blocked.`);
  const match = /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match) throw new Error('Spotify did not expose playlist data on its public embed page. Private playlists are not supported, and Spotify may change this page format.');
  let data;
  try { data = JSON.parse(htmlDecode(match[1])); } catch { throw new Error('Spotify returned playlist metadata that FlickFetch could not read.'); }
  const entity = findObjectWithTrackList(data);
  if (!entity) throw new Error('No track list was present in Spotify’s public embed page. Try a public playlist or export its track list to CSV.');
  const trackList = getProp(entity, 'trackList');
  const entries = Array.isArray(trackList) ? trackList : Array.isArray(getProp(trackList, 'items')) ? getProp(trackList, 'items') : [];
  const tracks = [];
  for (const row of entries) {
    const title = readAny(row, 'title', 'name');
    if (!title) continue;
    const artist = readAny(row, 'subtitle', 'artist', 'artists', 'byline') || 'Unknown artist';
    const uri = readAny(row, 'uri', 'spotifyUri');
    let spotifyTrackUrl = readAny(row, 'externalUrl', 'url');
    if (/^spotify:track:/i.test(uri)) spotifyTrackUrl = `https://open.spotify.com/track/${uri.slice('spotify:track:'.length)}`;
    if (!/^https:\/\/open\.spotify\.com\/track\//i.test(spotifyTrackUrl)) spotifyTrackUrl = '';
    tracks.push({
      number: tracks.length + 1,
      title,
      artist,
      album: readAny(row, 'album', 'albumTitle'),
      durationMilliseconds: parseDuration(getProp(row, 'duration_ms') ?? getProp(row, 'durationMs') ?? getProp(row, 'duration') ?? getProp(row, 'durationMillis') ?? getProp(row, 'durationMilliseconds')),
      spotifyUrl: spotifyTrackUrl,
      candidates: [],
      matchStatus: 'Waiting for search'
    });
  }
  if (!tracks.length) throw new Error('The embed page contained a playlist but did not expose readable tracks. Spotify may have changed its page format or the playlist may not be public.');
  return {
    id: playlistId,
    name: readAny(entity, 'title', 'name', 'nameText', 'headerText') || 'Spotify playlist',
    owner: readAny(entity, 'subtitle', 'ownerName', 'creator') || 'Public Spotify playlist',
    url: playlistUrl,
    tracks
  };
}

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function tokens(value) { return new Set(normalize(value).split(/\s+/).filter(token => token.length > 1 && !STOP_WORDS.has(token))); }
function coverage(target, candidate) {
  const targetTokens = tokens(target);
  if (!targetTokens.size) return 0;
  const candidateTokens = tokens(candidate);
  return [...targetTokens].filter(token => candidateTokens.has(token)).length / targetTokens.size;
}
function durationSeconds(candidate) {
  if (Number.isFinite(Number(candidate.durationSeconds))) return Number(candidate.durationSeconds);
  if (Number.isFinite(Number(candidate.duration))) return Number(candidate.duration);
  const text = String(candidate.duration_string || '').split(':');
  if (!text.length) return -1;
  let total = 0;
  for (const part of text) { const n = Number(part); if (!Number.isFinite(n)) return -1; total = total * 60 + n; }
  return total;
}
function rank(track, candidate) {
  let score = Math.round(coverage(track.title, candidate.title) * 48 + coverage(track.artist, `${candidate.title} ${candidate.channel}`) * 32);
  const candidateDuration = durationSeconds(candidate);
  if (track.durationMilliseconds > 0 && candidateDuration > 0) {
    const delta = Math.abs(track.durationMilliseconds / 1000 - candidateDuration);
    if (delta <= 2.5) score += 18;
    else if (delta <= 6) score += 14;
    else if (delta <= 12) score += 9;
    else if (delta <= 25) score += 3;
    else score -= 12;
  }
  const topicChannel = /-\s*topic/i.test(candidate.channel || '');
  const audioSignal = AUDIO_SIGNAL.test(candidate.title || '') || /provided to youtube by/i.test(candidate.title || '');
  const likelyMusicVideo = MUSIC_VIDEO.test(candidate.title || '') || /\bvevo\b/i.test(candidate.channel || '');
  const live = LIVE.test(candidate.title || '');
  const visualizer = VISUALIZER.test(candidate.title || '');
  if (topicChannel) score += 14;
  if (audioSignal) score += 12;
  if (likelyMusicVideo) score -= 42;
  if (live) score -= 28;
  if (visualizer) score -= 18;
  score = Math.max(0, Math.min(100, score));
  const kind = likelyMusicVideo ? 'video — review' : (topicChannel || audioSignal) ? 'audio signal' : 'review';
  return { ...candidate, score, likelyMusicVideo, matchLabel: `${score >= 80 ? 'Strong' : score >= 62 ? 'Good' : 'Review'} · ${kind}` };
}

function spawnCapture(exe, args, cwd, timeoutMs = 45000, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true, env: { ...process.env, PATH: `${cwd}${path.delimiter}${process.env.PATH || ''}`, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    let stdout = ''; let stderr = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      error ? reject(error) : resolve(result);
    };
    const onAbort = () => {
      try { child.kill(); } catch { /* ignore */ }
      finish(new Error('Match search canceled.'));
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(new Error('YouTube search timed out.'));
    }, timeoutMs);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => finish(error));
    child.on('close', code => finish(null, { code, stdout, stderr }));
  });
}

async function findCandidates(track, toolManager, signal) {
  toolManager.refresh();
  if (!toolManager.ytDlpPath) throw new Error('yt-dlp is not installed. Open Settings → Tools and install or repair the downloader tools first.');
  const query = `${track.artist ? `${track.artist} ` : ''}${track.title} official audio`;
  const args = ['--ignore-config', '--encoding', 'utf-8', '--color', 'never', '--quiet', '--no-warnings', '--ignore-errors', '--skip-download', '--flat-playlist', '--dump-single-json', `ytsearch10:${query}`];
  const capture = await spawnCapture(toolManager.ytDlpPath, args, toolManager.binDir, 45000, signal);
  if (capture.code !== 0 && !capture.stdout.trim()) {
    const detail = capture.stderr.trim().slice(0, 420);
    throw new Error(`YouTube search failed${detail ? `: ${detail}` : '.'}`);
  }
  let parsed;
  try { parsed = JSON.parse(capture.stdout); } catch { throw new Error('yt-dlp returned an unreadable YouTube search response. Update yt-dlp and try again.'); }
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  const candidates = [];
  for (const entry of entries) {
    const id = String(entry.id || '');
    const title = String(entry.title || '');
    let url = String(entry.webpage_url || entry.original_url || entry.url || '');
    if (!url && id.length === 11) url = `https://www.youtube.com/watch?v=${id}`;
    if (url.startsWith('/watch?')) url = `https://www.youtube.com${url}`;
    if (!title || !url) continue;
    try {
      const parsedUrl = new URL(url);
      const valid = parsedUrl.hostname === 'youtube.com' || parsedUrl.hostname.endsWith('.youtube.com') || parsedUrl.hostname === 'youtu.be' || parsedUrl.hostname.endsWith('.youtube-nocookie.com');
      if (!valid) { if (id.length !== 11) continue; url = `https://www.youtube.com/watch?v=${id}`; }
    } catch { if (id.length !== 11) continue; url = `https://www.youtube.com/watch?v=${id}`; }
    candidates.push({ title, channel: String(entry.channel || entry.uploader || entry.channel_title || ''), url, durationSeconds: durationSeconds(entry) });
  }
  if (!candidates.length) throw new Error('YouTube did not return any usable search results for this track.');
  return candidates.map(candidate => rank(track, candidate)).sort((a, b) => b.score - a.score || Number(a.likelyMusicVideo) - Number(b.likelyMusicVideo));
}

async function findPlaylistMatches(playlist, toolManager, emit, signal) {
  const results = [];
  const total = playlist.tracks.length;
  for (let index = 0; index < total; index++) {
    if (signal?.aborted) return { ...playlist, tracks: [...results, ...playlist.tracks.slice(index)], canceled: true };
    const track = playlist.tracks[index];
    try {
      const candidates = await findCandidates(track, toolManager, signal);
      results.push({ ...track, candidates, bestMatch: candidates[0], matchStatus: 'Matched' });
      emit?.('spotify:match-progress', { current: index + 1, total, trackTitle: track.title, status: 'Matched', track: results[results.length - 1] });
    } catch (error) {
      if (signal?.aborted) return { ...playlist, tracks: [...results, ...playlist.tracks.slice(index)], canceled: true };
      const failed = { ...track, candidates: [], bestMatch: null, matchStatus: error.message };
      results.push(failed);
      emit?.('spotify:match-progress', { current: index + 1, total, trackTitle: track.title, status: 'Failed', track: failed });
    }
  }
  return { ...playlist, tracks: results, canceled: false };
}

module.exports = { fetchPlaylist, findCandidates, findPlaylistMatches, parseSpotifyUrl };
