const { spawn } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const execFileAsync = promisify(execFile);
const { foldKana, readingSimilarity, romajiQuery } = require('./japanese.cjs');

const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'feat', 'featuring', 'ft', 'official', 'audio', 'video', 'lyrics', 'lyric', 'topic']);

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

async function fetchPlaylist(rawUrl) {
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  let playlistId = parseSpotifyUrl(url);
  if (!playlistId) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Paste a public Spotify playlist URL.'); }
    if (parsed.protocol !== 'https:' || !/(^|\.)spotify\.(link|app\.link)$/.test(parsed.hostname)) {
      throw new Error('Paste a public Spotify playlist URL, for example https://open.spotify.com/playlist/…');
    }
    const shortResponse = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'Mozilla/5.0 FlickFetch/2.1.1' } });
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

/* CJK-aware text handling. The old normalizer kept only a-z0-9, which turned every Japanese / Korean / Chinese title
 * into an empty string (so a perfect match scored "Different title"). Now letters and digits of every script survive,
 * full-width forms are folded (ＭＶ -> MV, （ ） -> ( )), and CJK text is compared by character pairs, because it has no spaces. */
const CJK_CLASS = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}ー';
const CJK_CHAR = new RegExp(`[${CJK_CLASS}]`, 'u');
const CJK_RUNS = new RegExp(`[${CJK_CLASS}]+|[^${CJK_CLASS}]+`, 'gu');
const hasCjk = value => CJK_CHAR.test(String(value || ''));

function normalize(value) {
  return String(value || '')
    .normalize('NFKC').toLowerCase()
    .replace(/[\u30a1-\u30f6]/g, ch => foldKana(ch)) // カタカナ == ひらがな
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC') // drop accents on Latin letters; kana keep their dakuten
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function tokens(value) {
  const out = new Set();
  let cjk = '';
  for (const word of normalize(value).split(/\s+/)) {
    for (const run of word.match(CJK_RUNS) || []) {
      if (hasCjk(run)) cjk += run;
      else if (run.length > 1 && !STOP_WORDS.has(run)) out.add(run);
    }
  }
  if (cjk.length === 1) out.add(`cjk:${cjk}`);
  for (let i = 0; i < cjk.length - 1; i += 1) out.add(`cjk:${cjk.slice(i, i + 2)}`);
  return out;
}
function coverage(target, candidate) {
  const targetTokens = tokens(target);
  if (!targetTokens.size) return 0;
  const candidateTokens = tokens(candidate);
  return [...targetTokens].filter(token => candidateTokens.has(token)).length / targetTokens.size;
}
function durationSeconds(candidate) {
  if (Number.isFinite(Number(candidate.durationSeconds)) && Number(candidate.durationSeconds) > 0) return Number(candidate.durationSeconds);
  if (Number.isFinite(Number(candidate.duration)) && Number(candidate.duration) > 0) return Number(candidate.duration);
  const text = String(candidate.duration_string || '').split(':');
  if (text.length < 2) return -1;
  let total = 0;
  for (const part of text) { const n = Number(part); if (!Number.isFinite(n)) return -1; total = total * 60 + n; }
  return total;
}

/* ---------------------------------------------------------------------------------------------
 * Strict "studio recording only" matching.
 * A candidate is HARD-REJECTED (never auto-downloaded) when it is a music video, live version,
 * remix/edit/sped-up/slowed/cover/karaoke/instrumental etc. that Spotify's own title does not
 * contain, by a different artist or title, or when its length differs from Spotify's by > 7 s.
 * -------------------------------------------------------------------------------------------- */
const VIDEO_RX = /\b(official\s+(music\s+)?video|music\s+video|video\s+clip|videoclip|clip\s+officiel|full\s+video|lyric\s+video|visuali[sz]er|official\s+visuali[sz]er|vertical\s+video|dance\s+video|\(video\)|\[video\]|4k\s+(video|remaster)|hd\s+video|m\/?v)\b|ミュージックビデオ|ミュージック・ビデオ/i;
const LYRICS_RX = /\blyrics?\b|\bwith\s+lyrics\b|歌詞|リリック/i;
const VARIANTS = [
  [/\bremix(ed)?\b|\brmx\b|\bflip\b|\bbootleg\b|リミックス|リミクス/i, 'Remix'],
  [/\blive\b|\bconcert\b|\bunplugged\b|\bsession(s)?\b|\bin\s+concert\b|\bperformance\b|\bat\s+the\b.*\btour\b|ライブ|ライヴ|弾き語り|生演奏/i, 'Live version'],
  [/\bacoustic\b|アコースティック|アコギ/i, 'Acoustic version'],
  [/\binstrumental\b|\bkaraoke\b|\bbacking\s+track\b|\bminus\s+one\b|\boff\s*vocal\b|\bwithout\s+vocals?\b|カラオケ|インスト|オフボーカル|オフヴォーカル|ガイドメロなし|伴奏/i, 'Instrumental / karaoke'],
  [/\bcover\b|\btribute\b|\bin\s+the\s+style\s+of\b|\boriginally\s+performed\b|\bpiano\s+version\b|\bguitar\s+version\b|\bmusic\s+box\b|歌ってみた|弾いてみた|叩いてみた|演奏してみた|カバー|オルゴール|耳コピ|ピアノ(版|アレンジ|ver)/i, 'Cover'],
  [/\bsped\s*up\b|\bspeed\s*up\b|\bslowed\b|\breverb\b|\bnightcore\b|\b8d\b|\bbass\s*boost(ed)?\b|\bpitched\b|\bchipmunk\b|\btiktok\s+version\b|ナイトコア|スピードアップ|スローバージョン/i, 'Sped-up / slowed edit'],
  [/\bmashup\b|\bmedley\b|メドレー|マッシュアップ/i, 'Mashup'],
  [/\btranslations?\b|\bromaji\b|\bromanji\b|\brom\s*\/\s*eng\b|\beng(lish)?\s*(sub|lyrics)\b|\bcolou?r\s*coded\b|和訳|日本語訳|ローマ字/i, 'Lyrics / translation video'],
  [/\bpiano\b|ピアノ|\borchestral\b|\bstring\s+quartet\b|\b8-?bit\b|\bchiptune\b/i, 'Alternate arrangement'],
  [/\bextended\b|\bradio\s+edit\b|\bclub\s+mix\b|\bdub\s+mix\b|\b\w+\s+edit\b|\bshort\s+version\b|\bcut\b|\btv\s*(size|ver\.?|edit)\b|ショート(ver|バージョン|サイズ)|TVサイズ/i, 'Edit / alternate mix'],
  [/\blo-?fi\b|\bchill\s+version\b/i, 'Lo-fi edit'],
  [/\breaction\b|\btutorial\b|\blesson\b|\bhow\s+to\s+play\b|\bchords\b|\bshorts?\b|\bfull\s+album\b|\bplaylist\b|\bcompilation\b|\bhour(s)?\b|作業用|睡眠用|リアクション|反応動画|解説|踊ってみた|歌詞付き.*(まとめ|メドレー)/i, 'Not the song']
];

function cleanSpotifyTitle(title) {
  const original = String(title || '').normalize('NFKC');
  return original
    .replace(/\s+-\s+(\d{4}\s+)?(remaster(ed)?|mono|stereo|single|radio|from|live|version|edit|bonus|deluxe|original).*$/i, '')
    .replace(/\s+-\s+(tv|アニメ|ＴＶ|映画|劇場版|ドラマ|主題歌|オープニング|エンディング|opening|ending|theme|ost|insert\s+song)[^]*$/i, '')
    .replace(/[\(\[\{][^\)\]\}]*(feat|ft|with|remaster|version|ver\.?|from|deluxe|bonus|mono|stereo|アニメ|主題歌|テーマ|オープニング|エンディング|映画|ドラマ|挿入歌)[^\)\]\}]*[\)\]\}]/gi, '')
    .replace(/\s{2,}/g, ' ').trim() || original.trim();
}
function primaryArtist(artist) {
  return String(artist || '').split(/\s*(?:,|&|×|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bx\b|;|\/)\s*/i)[0].trim();
}
/** Every credited artist ("Future Islands, BADBADNOTGOOD" -> both), not just the first. */
function artistNames(artist) {
  return String(artist || '').split(/\s*(?:,|&|×|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bx\b|;|\/)\s*/i).map(name => name.trim()).filter(Boolean);
}
/** True when the uploading channel is one of the credited artists ("Future Islands", "Future Islands - Topic", "FutureIslandsVEVO"). */
function channelIsCreditedArtist(channel, artist) {
  const base = normalize(String(channel || '').replace(/-\s*topic\s*$/i, '').replace(/vevo\s*$/i, '').replace(/\bofficial\b/gi, ''));
  const squashed = base.replace(/\s+/g, '');
  if (!base) return false;
  return artistNames(artist).some(name => {
    const wanted = normalize(name);
    if (wanted.length < (hasCjk(wanted) ? 2 : 3)) return false;
    return base === wanted || squashed === wanted.replace(/\s+/g, '') || coverage(name, base) >= 0.99;
  });
}
function stripCandidateTitle(title, artist) {
  // 「」 / 『』 are left alone on purpose: Japanese uploads often put the real song title inside them (YOASOBI「ハルジオン」).
  let t = String(title || '').normalize('NFKC')
    .replace(/[\(\[\{【〔〈《][^\)\]\}】〕〉》]*[\)\]\}】〕〉》]/g, ' ')
    .replace(/\b(official|audio|video|lyrics?|hd|hq|4k|topic|visuali[sz]er|remaster(ed)?(\s+\d{4})?|provided\s+to\s+youtube\s+by)\b/gi, ' ')
    .replace(/歌詞付き|歌詞|公式|オフィシャル|ミュージックビデオ/g, ' ');
  const a = normalize(primaryArtist(artist));
  const parts = t.split(/\s[-–—|:]\s/);
  if (parts.length > 1) {
    const withoutArtist = parts.filter(part => normalize(part) !== a && !(a && normalize(part).startsWith(`${a} `) && parts.length > 2));
    if (withoutArtist.length) t = withoutArtist.join(' ');
  }
  return t.replace(/\s{2,}/g, ' ').trim();
}

function rank(track, candidate) {
  const reasons = [];
  const spotifyFull = normalize(`${track.title} ${track.album || ''}`);
  const rawTitle = String(candidate.title || '').normalize('NFKC');
  const channel = String(candidate.channel || '').normalize('NFKC');
  const source = candidate.source || 'youtube';
  const isYtm = source === 'ytm';
  const topicChannel = /-\s*topic\s*$/i.test(channel);
  const officialAudio = /\bofficial\s+audio\b|\baudio\s+only\b|\(audio\)|\[audio\]|\bprovided\s+to\s+youtube\b/i.test(rawTitle);
  const vevo = /vevo/i.test(channel);
  const artist = primaryArtist(track.artist);

  // Duration is computed first because it is also the evidence used when a title/artist is written in a different script.
  const candidateDuration = durationSeconds(candidate);
  const spotifyDuration = track.durationMilliseconds > 0 ? track.durationMilliseconds / 1000 : 0;
  const delta = spotifyDuration > 0 && candidateDuration > 0 ? Math.abs(spotifyDuration - candidateDuration) : null;

  // --- hard rejections -------------------------------------------------------------------
  const spotifyIsVideoish = VIDEO_RX.test(track.title || '');
  if (!spotifyIsVideoish && VIDEO_RX.test(rawTitle) && !officialAudio) reasons.push('Music video');
  const searchable = `${rawTitle} ${channel}`;
  for (const [rx, label] of VARIANTS) {
    if (rx.test(searchable) && !rx.test(spotifyFull) && !rx.test(String(track.title || ''))) reasons.push(label);
  }

  // --- title & artist -------------------------------------------------------------------
  const coreSpotify = normalize(cleanSpotifyTitle(track.title));
  const coreCandidate = normalize(stripCandidateTitle(rawTitle, track.artist));
  const strippedTitle = stripCandidateTitle(rawTitle, track.artist) || rawTitle;
  let titleCoverage = coverage(cleanSpotifyTitle(track.title), strippedTitle);
  // Different writing systems (僕が死のうと思ったのは vs "Boku Ga Shinou To Omottanowa", カタカナ vs ひらがな): compare how the two *sound*.
  let readingSim = null;
  if (titleCoverage < 0.75) {
    readingSim = readingSimilarity(cleanSpotifyTitle(track.title), strippedTitle);
    if (readingSim !== null && readingSim >= 0.75) titleCoverage = Math.max(titleCoverage, Math.min(0.9, readingSim));
  }
  const readingMatched = readingSim !== null && readingSim >= 0.75;
  const exactTitle = Boolean(coreSpotify) && coreSpotify === coreCandidate;
  // The credited artist's own channel is the strongest signal there is: if the title is merely *similar* (extra credits,
  // a different subtitle, a remix tag in the Spotify name, ...), that upload is the real track, so don't flag it.
  const channelIsArtist = channelIsCreditedArtist(channel, track.artist);
  // Similarity is also measured against the raw upload title, because stripping brackets can drop real title words.
  const rawTitleCoverage = coverage(cleanSpotifyTitle(track.title), rawTitle);
  const titleVouched = titleCoverage < 0.75 && channelIsArtist && Math.max(titleCoverage, rawTitleCoverage) >= 0.5;
  // Spotify may romanize a title YouTube writes in Japanese (or vice versa): "Mayonaka no Door" vs "真夜中のドア". Words can't be
  // compared across scripts, so trust a same-length upload from a trusted source with no variant tags. This is only used when
  // exactly one side contains CJK text.
  const crossScriptTitle = hasCjk(track.title) !== hasCjk(rawTitle);
  const scriptVouched = titleCoverage < 0.75 && !titleVouched && crossScriptTitle && reasons.length === 0
    && delta !== null && delta <= 2 && (isYtm || topicChannel || channelIsArtist);
  if (titleCoverage < 0.75 && !titleVouched && !scriptVouched) reasons.push('Different title');
  const candidateTokens = tokens(stripCandidateTitle(rawTitle, track.artist));
  const spotifyTokens = tokens(`${cleanSpotifyTitle(track.title)} ${track.artist} ${track.album || ''}`);
  const extraTokens = [...candidateTokens].filter(token => !spotifyTokens.has(token)).length;

  const artistHaystack = `${channel} ${rawTitle}`;
  let artistCoverage = coverage(artist, artistHaystack);
  if (channelIsArtist) artistCoverage = 1; // the uploader is a credited artist (not necessarily the first listed)
  if (isYtm && !channel) artistCoverage = Math.max(artistCoverage, 0.7); // YouTube Music search results are already artist-scoped
  const artistChannel = normalize(channel.replace(/-\s*topic\s*$/i, '')) === normalize(artist) || coverage(artist, channel.replace(/-\s*topic\s*$/i, '')) >= 0.99;
  if (artistCoverage < 0.5) {
    const artistReading = readingSimilarity(artist, channel.replace(/-\s*topic\s*$/i, '') || rawTitle);
    if (artistReading !== null && artistReading >= 0.75) artistCoverage = Math.max(artistCoverage, Math.min(0.9, artistReading));
  }
  // Same idea for the artist: "Kenshi Yonezu" on Spotify, "米津玄師 - Topic" on YouTube.
  const artistScriptGap = Boolean(channel) && hasCjk(artist) !== hasCjk(channel);
  const artistVouched = artistCoverage < 0.5 && artistScriptGap && (titleCoverage >= 0.75 || scriptVouched) && delta !== null && delta <= 2.5;
  if (artistVouched) artistCoverage = 0.7;
  if (artistCoverage < 0.5) reasons.push('Different artist');

  // --- duration -------------------------------------------------------------------------
  let durationPoints = 8;
  if (delta !== null) {
    if (delta <= 1.5) durationPoints = 20;
    else if (delta <= 3) durationPoints = 17;
    else if (delta <= 5) durationPoints = 12;
    else if (delta <= 7) durationPoints = 6;
    else { durationPoints = 0; reasons.push(`Different length (${Math.round(candidateDuration)}s vs ${Math.round(spotifyDuration)}s)`); }
  }

  // --- score ----------------------------------------------------------------------------
  let score = (exactTitle ? 35 : Math.max(Math.round(titleCoverage * 28), titleVouched || scriptVouched ? 24 : 0)) + Math.round(Math.min(1, artistCoverage) * 25) + durationPoints;
  if (isYtm) score += 20; else if (topicChannel) score += 18; else if (officialAudio) score += 12 + (artistChannel || channelIsArtist ? 4 : 0); else if (artistChannel || channelIsArtist) score += 6;
  if (LYRICS_RX.test(rawTitle) && !LYRICS_RX.test(track.title || '')) score -= 20;
  if (vevo && !officialAudio && !topicChannel) score -= 8;
  if (!scriptVouched) score -= Math.min(10, extraTokens * 3); // other-script words are not "extra" words
  score = Math.max(0, Math.min(100, score));

  const trustedSource = isYtm || topicChannel || officialAudio || artistChannel || channelIsArtist;
  const rejected = reasons.length > 0;
  const confident = !rejected && score >= (titleVouched || scriptVouched ? 58 : 70) && trustedSource;
  const kind = isYtm ? 'YouTube Music song' : topicChannel ? 'Topic (album audio)' : officialAudio ? 'Official audio' : artistChannel || channelIsArtist ? 'Artist channel' : 'Other upload';
  const matchLabel = rejected ? `Skipped · ${reasons[0]}` : `${confident ? 'Confident' : 'Review'} · ${kind}${delta !== null ? ` · ${delta <= 1 ? 'same length' : `${delta.toFixed(0)}s off`}` : ''}`;
  return {
    ...candidate, score, rejected, rejectReasons: reasons, confident, matchLabel,
    sourceKind: kind, titleVouched, scriptVouched, artistVouched, readingMatched, squareArt: isYtm || topicChannel, likelyMusicVideo: reasons.includes('Music video'), durationDelta: delta
  };
}

/** "Different title / artist" means this is not the song at all; other rejections are the right song in the wrong version. */
const isWrongSong = candidate => (candidate.rejectReasons || []).some(reason => /^Different (title|artist)/.test(reason));
function sortRanked(list) {
  return list.sort((a, b) => Number(a.rejected) - Number(b.rejected)
    || (a.rejected ? Number(isWrongSong(a)) - Number(isWrongSong(b)) : 0)
    || Number(b.confident) - Number(a.confident) || b.score - a.score);
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

function entryChannel(entry) {
  const artists = Array.isArray(entry.artists) ? entry.artists.join(', ') : '';
  return String(entry.artist || artists || entry.channel || entry.uploader || entry.creator || entry.channel_title || '');
}

function parseEntries(parsed, source) {
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  const out = [];
  for (const entry of entries) {
    if (!entry) continue;
    const id = String(entry.id || '');
    const title = String(entry.track || entry.title || '');
    let url = String(entry.webpage_url || entry.original_url || entry.url || '');
    if (id.length === 11 && !/^https?:/i.test(url)) url = `https://www.youtube.com/watch?v=${id}`;
    if (url.startsWith('/watch?')) url = `https://www.youtube.com${url}`;
    if (!title || !url) continue;
    try {
      const parsedUrl = new URL(url);
      const host = parsedUrl.hostname.toLowerCase();
      const valid = host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
      if (!valid) { if (id.length !== 11) continue; url = `https://www.youtube.com/watch?v=${id}`; }
      else if (host === 'music.youtube.com' && parsedUrl.searchParams.get('v')) url = `https://www.youtube.com/watch?v=${parsedUrl.searchParams.get('v')}`;
    } catch { if (id.length !== 11) continue; url = `https://www.youtube.com/watch?v=${id}`; }
    out.push({ title, channel: entryChannel(entry), url, durationSeconds: durationSeconds(entry), source });
  }
  return out;
}

async function runSearch(toolManager, target, source, signal, extra = []) {
  const args = ['--ignore-config', '--encoding', 'utf-8', '--color', 'never', '--quiet', '--no-warnings', '--ignore-errors', '--skip-download', '--flat-playlist', ...extra, '--dump-single-json', target];
  const capture = await spawnCapture(toolManager.ytDlpPath, args, toolManager.binDir, 45000, signal);
  if (capture.code !== 0 && !capture.stdout.trim()) {
    const detail = capture.stderr.trim().slice(0, 420);
    throw new Error(`YouTube search failed${detail ? `: ${detail}` : '.'}`);
  }
  let parsed;
  try { parsed = JSON.parse(capture.stdout); } catch { throw new Error('yt-dlp returned an unreadable YouTube search response. Update yt-dlp and try again.'); }
  return parseEntries(parsed, source);
}

function mergeCandidates(lists) {
  const seen = new Set();
  const candidates = [];
  for (const item of lists.flat()) {
    const key = (item.url.match(/[?&]v=([\w-]{11})/) || [])[1] || item.url;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(item);
  }
  return candidates;
}

const ytmSongsUrl = query => `https://music.youtube.com/search?q=${encodeURIComponent(query)}&sp=EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D`;

async function findCandidates(track, toolManager, signal) {
  toolManager.refresh();
  if (!toolManager.ytDlpPath) throw new Error('yt-dlp is not installed. Open Settings → Tools and install or repair the downloader tools first.');
  const artist = primaryArtist(track.artist);
  const core = cleanSpotifyTitle(track.title);
  const query = `${artist ? `${artist} ` : ''}${core}`.trim();
  // Pass 1 (fast): YouTube Music "Songs" filter (studio recordings only) + a normal search as a fallback.
  const firstPass = [
    runSearch(toolManager, ytmSongsUrl(query), 'ytm', signal, ['--playlist-end', '8']),
    runSearch(toolManager, `ytsearch8:${query} audio`, 'youtube', signal)
  ];
  const settled = await Promise.allSettled(firstPass);
  if (signal?.aborted) throw new Error('Match search canceled.');
  const lists = settled.filter(item => item.status === 'fulfilled').map(item => item.value);
  if (!lists.length) throw (settled.find(item => item.status === 'rejected')?.reason || new Error('YouTube search failed.'));
  let ranked = sortRanked(mergeCandidates(lists).map(candidate => rank(track, candidate)));

  // Pass 2 (only when pass 1 found nothing confident): search for the title alone (the artist may be spelled differently on
  // YouTube, e.g. "Mika Nakashima" vs "中島美嘉"), and for a romaji spelling when the title is kana/Latin only.
  if (!ranked.some(item => item.confident) && core) {
    const romaji = romajiQuery(core);
    const extra = [runSearch(toolManager, ytmSongsUrl(core), 'ytm', signal, ['--playlist-end', '8'])];
    if (romaji) extra.push(runSearch(toolManager, ytmSongsUrl(`${artist} ${romaji}`.trim()), 'ytm', signal, ['--playlist-end', '6']));
    if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(`${track.title}${track.artist}`)) extra.push(runSearch(toolManager, `ytsearch6:${core} ${artist} topic`, 'youtube', signal));
    const more = await Promise.allSettled(extra);
    if (signal?.aborted) throw new Error('Match search canceled.');
    const moreLists = more.filter(item => item.status === 'fulfilled').map(item => item.value);
    if (moreLists.length) ranked = sortRanked(mergeCandidates([...lists, ...moreLists]).map(candidate => rank(track, candidate)));
  }
  if (!ranked.length) throw new Error('YouTube did not return any usable search results for this track.');
  return ranked;
}

function safeName(value, max = 120) {
  return String(value || '').replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ').replace(/\s{2,}/g, ' ').replace(/[. ]+$/g, '').trim().slice(0, max);
}
const tplEscape = value => String(value).replace(/%/g, '%%');

/** Settings overrides + file naming that force a clean, tagged, audio-only download for one Spotify track. */
function buildQueueEntry(track, candidate, playlistName = '') {
  const folder = safeName(playlistName, 80);
  const fileBase = safeName(`${primaryArtist(track.artist) || track.artist || 'Unknown artist'} - ${cleanSpotifyTitle(track.title)}`, 150) || 'track';
  return {
    url: candidate.url,
    title: `${track.artist} - ${track.title}`,
    overrides: {
      preset: 7, playlist: false, container: 'auto',
      template: `${folder ? `${tplEscape(folder)}/` : ''}${tplEscape(fileBase)}.%(ext)s`,
      embedMeta: true, embedThumb: Boolean(candidate.squareArt), writeThumb: false,
      subs: false, autoSubs: false, embedSubs: false, sponsor: false,
      sectionStart: '', sectionEnd: '', restrict: false, infoJson: false, description: false
    }
  };
}

async function findPlaylistMatches(playlist, toolManager, emit, signal, options = {}) {
  const total = playlist.tracks.length;
  const results = playlist.tracks.map(track => ({ ...track }));
  const concurrency = Math.max(1, Math.min(4, Number(options.concurrency) || 3));
  let next = 0; let done = 0; let canceled = false;
  const worker = async () => {
    while (true) {
      if (signal?.aborted) { canceled = true; return; }
      const index = next++;
      if (index >= total) return;
      const track = results[index];
      if (track.queued) { done++; continue; }
      try {
        const candidates = await findCandidates(track, toolManager, signal);
        const best = candidates.find(item => item.confident) || null;
        let updated = { ...track, candidates, bestMatch: best, matchStatus: best ? 'Matched' : 'Needs review', queued: false };
        if (best && options.onConfident) {
          try { updated = { ...updated, ...(await options.onConfident(updated, best)) }; }
          catch (error) { updated.queueError = error.message; }
        }
        results[index] = updated;
        done++;
        emit?.('spotify:match-progress', { current: done, total, trackTitle: track.title, status: updated.matchStatus, track: updated });
      } catch (error) {
        if (signal?.aborted) { canceled = true; return; }
        results[index] = { ...track, candidates: [], bestMatch: null, matchStatus: 'Failed', matchError: error.message };
        done++;
        emit?.('spotify:match-progress', { current: done, total, trackTitle: track.title, status: 'Failed', track: results[index] });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  return { ...playlist, tracks: results, canceled: canceled || Boolean(signal?.aborted) };
}

module.exports = { fetchPlaylist, findCandidates, findPlaylistMatches, parseSpotifyUrl, rank, buildQueueEntry, cleanSpotifyTitle };
