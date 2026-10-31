const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isAcceptedUrl, buildDownloadArgs, splitArgs, DownloadService } = require('../electron/services/download-service.cjs');
const { parseSpotifyUrl, findPlaylistMatches, findCandidates, rank, buildQueueEntry } = require('../electron/services/spotify-service.cjs');
const japanese = require('../electron/services/japanese.cjs');
const { parseLegacySettings } = require('../electron/services/legacy-settings.cjs');
const { ToolManager } = require('../electron/services/tool-manager.cjs');


test('legacy settings.ini values migrate with types and escaped multiline values', () => {
  const defaults = { outputDir: 'C:/Videos', preset: 0, watchClipboard: false, extraArgs: '' };
  const legacy = [
    'OutputDir=C:\\\\Media\\\\FlickFetch\\nSubFolder',
    'Preset=3',
    'WatchClipboard=true',
    'ExtraArgs=--embed-chapters\\n--no-mtime',
    'UnknownField=ignored'
  ].join('\n');
  const parsed = parseLegacySettings(legacy, defaults);
  assert.equal(parsed.outputDir, 'C:\\Media\\FlickFetch\nSubFolder');
  assert.equal(parsed.preset, 3);
  assert.equal(parsed.watchClipboard, true);
  assert.equal(parsed.extraArgs, '--embed-chapters\n--no-mtime');
  assert.equal(Object.hasOwn(parsed, 'unknownField'), false);
});

test('media URL validation accepts supported URL/search forms and rejects unsafe schemes', () => {
  assert.equal(isAcceptedUrl('https://www.youtube.com/watch?v=abc'), true);
  assert.equal(isAcceptedUrl('https://www.instagram.com/reel/abc/'), true);
  assert.equal(isAcceptedUrl('ytsearch5:artist title'), true);
  assert.equal(isAcceptedUrl('file:///C:/secret.txt'), false);
  assert.equal(isAcceptedUrl('javascript:alert(1)'), false);
  assert.equal(isAcceptedUrl(''), false);
});

test('command-line option splitting respects quoted values', () => {
  assert.deepEqual(splitArgs('--format "best video" --no-playlist'), ['--format', 'best video', '--no-playlist']);
  assert.deepEqual(splitArgs(''), []);
});

test('download arguments carry container, playlist, subtitles, network and retry settings', () => {
  const args = buildDownloadArgs({
    outputDir: 'C:/Media Downloads', preset: 3, container: 'mp4', preferCompat: true,
    playlist: true, subs: true, autoSubs: true, embedSubs: true, subLangs: 'en.*,ja',
    proxy: 'http://127.0.0.1:8080', rateLimit: '2M', fragments: 8, retries: 5,
    embedThumb: true, embedMeta: true, sponsor: true, template: '%(title)s.%(ext)s',
    extraArgs: '--no-mtime'
  }, 'C:/AppData/bin');
  const joined = args.join('\n');
  assert.ok(joined.includes('--yes-playlist'));
  assert.ok(joined.includes('--write-subs'));
  assert.ok(joined.includes('--write-auto-subs'));
  assert.ok(joined.includes('http://127.0.0.1:8080'));
  assert.ok(joined.includes('2M'));
  assert.ok(joined.includes('--concurrent-fragments'));
  assert.ok(joined.includes('--fragment-retries'));
  assert.ok(joined.includes('--sponsorblock-remove'));
  assert.ok(joined.includes('--no-mtime'));
});

test('audio-only mode selects extraction format and omits video remux options', () => {
  const args = buildDownloadArgs({ outputDir: '/tmp', preset: 7, audioFormat: 'mp3', audioQuality: '192K', container: 'mp4', fragments: 4, retries: 2 }, '/tmp/bin');
  assert.ok(args.includes('-x'));
  assert.ok(args.includes('--audio-format'));
  assert.ok(args.includes('mp3'));
  assert.ok(args.includes('--audio-quality'));
  assert.ok(args.includes('192K'));
  assert.equal(args.includes('--remux-video'), false);
});

test('Spotify playlist links parse direct, embed, localized, and Spotify URI formats', () => {
  const id = '37i9dQZF1DXcBWIGoYBM5M';
  assert.equal(parseSpotifyUrl(`https://open.spotify.com/playlist/${id}`), id);
  assert.equal(parseSpotifyUrl(`https://open.spotify.com/embed/playlist/${id}?theme=0`), id);
  assert.equal(parseSpotifyUrl(`https://open.spotify.com/intl-en/playlist/${id}`), id);
  assert.equal(parseSpotifyUrl(`spotify:playlist:${id}`), id);
  assert.equal(parseSpotifyUrl('https://open.spotify.com/track/123'), null);
  assert.equal(parseSpotifyUrl('http://open.spotify.com/playlist/12345678901234567890'), null);
});


test('auto-generated subtitles can be requested without regular subtitles', () => {
  const args = buildDownloadArgs({ outputDir: '/tmp', preset: 0, autoSubs: true, subs: false, embedSubs: false, fragments: 1, retries: 0 }, '/tmp/bin');
  assert.ok(args.includes('--write-auto-subs'));
  assert.equal(args.includes('--write-subs'), false);
});

test('queue addition preserves imported track titles and validates a batch before inserting', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-add-test-'));
  const outputDir = path.join(root, 'output');
  const userDataPath = path.join(root, 'user-data');
  fs.mkdirSync(outputDir, { recursive: true });
  const settings = { outputDir, preset: 0, autoStart: false };
  const service = new DownloadService({
    toolManager: { binDir: root, ytDlpPath: null, refresh() {} },
    getSettings: () => settings,
    userDataPath,
    emit() {}
  });
  assert.throws(() => service.add(['https://example.com/valid', 'file:///private/file']), /supported media URL/);
  assert.equal(service.snapshot().items.length, 0);
  const added = service.add([{ url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Artist - Imported song' }]);
  assert.equal(added[0].title, 'Artist - Imported song');
  service.flushPersist();
  fs.rmSync(root, { recursive: true, force: true });
});

test('Spotify matching cancellation stops the active search and returns partial results', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-cancel-test-'));
  const fakeYtDlp = path.join(root, 'fake-yt-dlp');
  fs.writeFileSync(fakeYtDlp, '#!/usr/bin/env node\nsetTimeout(() => console.log(JSON.stringify({ entries: [] })), 1000);\n', { mode: 0o755 });
  const toolManager = { binDir: root, ytDlpPath: fakeYtDlp, refresh() { this.ytDlpPath = fakeYtDlp; } };
  const controller = new AbortController();
  const playlist = { name: 'Test', tracks: [{ number: 1, title: 'Track', artist: 'Artist', candidates: [], matchStatus: 'Waiting for search' }, { number: 2, title: 'Next', artist: 'Artist', candidates: [], matchStatus: 'Waiting for search' }] };
  const search = findPlaylistMatches(playlist, toolManager, () => {}, controller.signal);
  setTimeout(() => controller.abort(), 50);
  const result = await search;
  assert.equal(result.canceled, true);
  assert.equal(result.tracks.length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('download queue runs a fake yt-dlp process and parses title, progress, saved path and completion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-test-'));
  const outputDir = path.join(root, 'output');
  const userDataPath = path.join(root, 'user-data');
  fs.mkdirSync(outputDir, { recursive: true });
  const fakeYtDlp = path.join(root, 'fake-yt-dlp');
  const fakeScript = `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst saved = path.join(process.cwd(), 'test-media.mp4');\nfs.writeFileSync(saved, 'test media');\nconsole.log('@@T|1|1|Sample test media');\nconsole.log('@@P|100|100|100|2048|0|0|0');\nconsole.log('@@F|' + saved);\n`;
  fs.writeFileSync(fakeYtDlp, fakeScript, { mode: 0o755 });
  const toolManager = { binDir: root, ytDlpPath: fakeYtDlp, ffmpegPath: '', refresh() { this.ytDlpPath = fakeYtDlp; } };
  const settings = { outputDir, preset: 0, container: 'mp4', fragments: 1, retries: 0, autoStart: true, parallel: 1 };
  let completed;
  const done = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Fake download did not complete in time.')), 5000);
    completed = item => { clearTimeout(timeout); resolve(item); };
  });
  const service = new DownloadService({
    toolManager,
    getSettings: () => settings,
    userDataPath,
    emit(channel, payload) {
      const item = payload?.item;
      if (channel === 'downloads:changed' && item?.status === 'Done') completed(item);
    }
  });
  const added = service.add(['https://example.com/media']);
  assert.equal(added.length, 1);
  const result = await done;
  assert.equal(result.title, 'Sample test media');
  assert.equal(result.status, 'Done');
  assert.equal(result.progress, 100);
  assert.ok(fs.existsSync(result.filePath));
  service.flushPersist();
  assert.ok(fs.existsSync(path.join(userDataPath, 'downloads.json')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('ToolManager.getStatus resolves without infinite refresh/getStatus recursion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-tools-'));
  const manager = new ToolManager(root, () => {});
  assert.equal(manager.refresh(), undefined);
  const status = await manager.getStatus();
  assert.equal(typeof status.ready, 'boolean');
  assert.equal(status.binDir, path.join(root, 'bin'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('Spotify matcher accepts only studio audio and rejects videos, live, remixes, edits and wrong lengths', () => {
  const track = { title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', durationMilliseconds: 200040 };
  const rate = (title, channel, durationSeconds, source = 'youtube') => rank(track, { title, channel, url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', durationSeconds, source });
  assert.equal(rate('Blinding Lights', 'The Weeknd', 200, 'ytm').confident, true);
  assert.equal(rate('Blinding Lights', 'The Weeknd - Topic', 200).confident, true);
  assert.equal(rate('The Weeknd - Blinding Lights (Official Audio)', 'TheWeekndVEVO', 201).confident, true);
  for (const bad of [
    rate('The Weeknd - Blinding Lights (Official Video)', 'TheWeekndVEVO', 262),
    rate('Blinding Lights (Sped Up)', 'The Weeknd - Topic', 170),
    rate('The Weeknd - Blinding Lights (Live at SNL)', 'The Weeknd', 230),
    rate('Blinding Lights (Remix)', 'The Weeknd - Topic', 200),
    rate('Blinding Lights (Radio Edit)', 'The Weeknd - Topic', 190),
    rate('Blinding Lights', 'Other Artist - Topic', 200),
    rate('Blinding Lights', 'The Weeknd - Topic', 300)
  ]) { assert.equal(bad.confident, false); assert.equal(bad.rejected, true); }
  assert.equal(rate('The Weeknd - Blinding Lights (Lyrics)', 'Lyric Channel', 200).confident, false);
  const remaster = { title: 'Hotel California - 2013 Remaster', artist: 'Eagles', album: 'Hotel California', durationMilliseconds: 391000 };
  assert.equal(rank(remaster, { title: 'Hotel California (2013 Remaster)', channel: 'Eagles - Topic', url: 'x', durationSeconds: 391 }).confident, true);
});

test('a similar title on the credited artist\'s own channel is accepted instead of flagged', () => {
  const track = { title: 'Seasons (Waiting on You) - BADBADNOTGOOD Remix', artist: 'Future Islands, BADBADNOTGOOD', album: 'Seasons (Waiting on You) (BADBADNOTGOOD Remix)', durationMilliseconds: 223000 };
  const rate = (title, channel, durationSeconds) => rank(track, { title, channel, url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', durationSeconds });
  const official = rate('Future Islands - Seasons (Waiting On You) (BADBADNOTGOOD Remix)', 'Future Islands', 223);
  assert.equal(official.confident, true);
  assert.equal(official.titleVouched, true);
  assert.equal(rate('Seasons (Waiting on You) BADBADNOTGOOD Remix', 'BADBADNOTGOOD', 223).confident, true); // any credited artist counts
  // The same title from an unrelated uploader is still flagged, as is a different song or the wrong length on the artist's channel.
  assert.equal(rate('Future Islands - Seasons (Waiting On You) (BADBADNOTGOOD Remix)', 'Random Uploader', 223).confident, false);
  assert.equal(rate('Future Islands - A Dream of You and Me', 'Future Islands', 223).confident, false);
  assert.equal(rate('Future Islands - Seasons (Waiting On You) (BADBADNOTGOOD Remix)', 'Future Islands', 400).confident, false);
});

test('Spotify queue entries force audio-only tagged downloads with clean names', () => {
  const entry = buildQueueEntry({ title: 'Blinding Lights', artist: 'The Weeknd, Someone', album: 'After Hours' }, { url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', squareArt: true }, 'My: Mix / 100%');
  assert.equal(entry.overrides.preset, 7);
  assert.equal(entry.overrides.playlist, false);
  assert.equal(entry.overrides.sponsor, false);
  assert.equal(entry.overrides.embedThumb, true);
  assert.equal(entry.overrides.template, 'My Mix 100%%/The Weeknd - Blinding Lights.%(ext)s');
  const args = buildDownloadArgs({ outputDir: 'out', preset: 0, fragments: 1, retries: 0, audioFormat: 'mp3', audioQuality: '0', ...entry.overrides }, 'bin');
  assert.ok(args.includes('-x') && args.includes('--no-playlist'));
  assert.equal(args[args.indexOf('-f') + 1], 'ba/b');
});

test('auto-download: a confident match is queued the moment it is found', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-sp-'));
  const fake = path.join(root, 'fake-yt-dlp');
  const entry = { id: 'aaaaaaaaaaa', title: 'Song', channel: 'Artist - Topic', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', duration: 200 };
  fs.writeFileSync(fake, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ entries: [${JSON.stringify(entry)}] }));\n`, { mode: 0o755 });
  const toolManager = { binDir: root, ytDlpPath: fake, refresh() { this.ytDlpPath = fake; } };
  const playlist = { name: 'P', tracks: [{ number: 1, title: 'Song', artist: 'Artist', durationMilliseconds: 200000, candidates: [] }, { number: 2, title: 'Other Thing', artist: 'Someone Else', durationMilliseconds: 200000, candidates: [] }] };
  const queued = [];
  const result = await findPlaylistMatches(playlist, toolManager, () => {}, undefined, { onConfident: async (track, candidate) => { queued.push([track.number, candidate.url]); return { queued: true }; } });
  assert.deepEqual(queued, [[1, 'https://www.youtube.com/watch?v=aaaaaaaaaaa']]);
  assert.equal(result.tracks[0].queued, true);
  assert.equal(result.tracks[1].matchStatus, 'Needs review');
  assert.equal(result.tracks[1].bestMatch, null);
  fs.rmSync(root, { recursive: true, force: true });
});


test('window state restores size, position and maximized flag, and recovers from off-screen or invalid data', () => {
  const { sanitizeState } = require('../electron/services/window-state.cjs');
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  const opts = { defaults: { width: 1460, height: 960 }, minWidth: 780, minHeight: 540, displays };

  assert.deepEqual(sanitizeState({ x: 100, y: 80, width: 1000, height: 700, maximized: true }, opts), { width: 1000, height: 700, x: 100, y: 80, maximized: true });
  // Garbage / missing data falls back to defaults.
  assert.deepEqual(sanitizeState(null, opts), { width: 1460, height: 960, maximized: false });
  assert.deepEqual(sanitizeState({ width: 'big', height: NaN }, opts), { width: 1460, height: 960, maximized: false });
  // Size is clamped to the minimum and to the largest display.
  const clamped = sanitizeState({ width: 100, height: 100 }, opts);
  assert.equal(clamped.width, 780); assert.equal(clamped.height, 540);
  const huge = sanitizeState({ width: 9000, height: 9000 }, opts);
  assert.equal(huge.width, 1920); assert.equal(huge.height, 1040);
  // A window left on a now-disconnected monitor keeps its size but loses its position.
  const offscreen = sanitizeState({ x: 3000, y: 200, width: 1100, height: 800 }, opts);
  assert.equal(offscreen.x, undefined); assert.equal(offscreen.width, 1100);
  // Slightly off the edge but title bar still reachable is kept.
  assert.equal(sanitizeState({ x: -300, y: 10, width: 1000, height: 700 }, opts).x, -300);
});


test('yt-dlp version comparison handles stable, nightly and malformed versions', () => {
  const { compareYtDlpVersions } = require('../electron/services/tool-manager.cjs');
  assert.ok(compareYtDlpVersions('2026.10.26', '2026.09.30') > 0);
  assert.ok(compareYtDlpVersions('2026.11.01', '2026.10.26') > 0);
  assert.equal(compareYtDlpVersions('2026.10.26', '2026.10.26'), 0);
  assert.ok(compareYtDlpVersions('2026.10.26', '2026.10.26.232901') < 0); // nightly of the same day is newer than stable
  assert.equal(compareYtDlpVersions('v2026.10.26', '2026.10.26'), 0);
  assert.equal(compareYtDlpVersions('garbage', '2026.10.26'), 0);
});

test('checkYtDlpUpdate reports updateAvailable only when GitHub has a newer release, and stays quiet offline', async () => {
  const { ToolManager } = require('../electron/services/tool-manager.cjs');
  const manager = new ToolManager(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-tools-')), () => {});
  manager.refresh = () => {};
  manager.ytDlpPath = 'fake';
  let current = '2026.10.01';
  manager.getVersion = async () => current;
  const realFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, json: async () => ({ tag_name: '2026.10.26' }) });
    assert.deepEqual(await manager.checkYtDlpUpdate({ force: true }), { current: '2026.10.01', latest: '2026.10.26', updateAvailable: true });
    current = '2026.10.26';
    assert.equal((await manager.checkYtDlpUpdate()).updateAvailable, false); // already on latest -> no card
    global.fetch = async () => { throw new Error('offline'); };
    current = '2026.10.01';
    const offline = await manager.checkYtDlpUpdate({ force: true });
    assert.equal(offline.updateAvailable, false);
    assert.equal(offline.latest, null);
  } finally { global.fetch = realFetch; }
});


test('share links with tracking query strings and a non-string argument are handled', async () => {
  const { fetchPlaylist } = require('../electron/services/spotify-service.cjs');
  const id = '6lXZL82tCwPs3kp4vCWDTd';
  assert.equal(parseSpotifyUrl(`https://open.spotify.com/playlist/${id}?si=8d1a383e501641fc`), id);
  assert.equal(parseSpotifyUrl(`  https://open.spotify.com/playlist/${id}?si=8d1a383e501641fc\n`), id);
  // A leaked click event (object) must produce the friendly error, not crash.
  await assert.rejects(() => fetchPlaylist({ type: 'click' }), /Paste a public Spotify playlist URL/);
});

test('Japanese / CJK titles are matched instead of being skipped as "Different title"', () => {
  const rate = (track, candidate) => rank({ durationMilliseconds: 199000, ...track }, { url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', source: 'youtube', durationSeconds: 199, ...candidate });
  const haru = { title: 'ハルジオン', artist: 'YOASOBI', album: 'THE BOOK' };

  // Regression: a perfect YouTube "Topic" upload used to be rejected because non-ASCII text was erased before comparing.
  const topic = rate(haru, { title: 'ハルジオン', channel: 'YOASOBI - Topic' });
  assert.equal(topic.rejected, false);
  assert.equal(topic.confident, true);
  assert.equal(rate(haru, { title: 'ハルジオン', channel: 'YOASOBI', source: 'ytm' }).confident, true);
  assert.equal(rate(haru, { title: 'YOASOBI「ハルジオン」 Official Audio', channel: 'YOASOBI' }).confident, true, 'title inside 「」 is read');

  // Still strict about everything that is not the studio recording.
  assert.deepEqual(rate(haru, { title: 'ツバメ', channel: 'YOASOBI - Topic' }).rejectReasons, ['Different title']);
  assert.match(rate(haru, { title: '祝福（カラオケ）[Originally Performed By YOASOBI] - The Blessing (karaoke)', channel: 'Sing King' }).rejectReasons[0], /karaoke/i);
  assert.match(rate(haru, { title: 'ハルジオン / YOASOBI (Official instrumental)', channel: 'YOASOBI' }).rejectReasons[0], /Instrumental/);
  assert.match(rate(haru, { title: 'ハルジオン (Piano Echoes Ver.)', channel: 'YOASOBI' }).rejectReasons[0], /arrangement/i);
  assert.ok(rate(haru, { title: 'ハルジオン 歌ってみた', channel: 'singer' }).rejected, '歌ってみた = cover');
  assert.ok(rate(haru, { title: 'YOASOBI「ハルジオン」 Official Music Video', channel: 'Ayase / YOASOBI', durationSeconds: 215 }).rejected);
  assert.ok(rate(haru, { title: 'ハルジオン (ライブ)', channel: 'YOASOBI' }).rejected, 'ライブ = live');

  // Other scripts work the same way, as do two-character artist names.
  assert.equal(rate({ title: '봄날', artist: 'BTS' }, { title: '봄날', channel: 'BTS - Topic' }).confident, true);
  assert.equal(rate({ title: 'Группа крови', artist: 'КИНО' }, { title: 'Группа крови', channel: 'КИНО - Topic' }).confident, true);
  assert.equal(rate({ title: 'ドライフラワー', artist: '優里' }, { title: 'ドライフラワー', channel: '優里 - Topic' }).confident, true);
});

test('a romanized Spotify title/artist is matched to the Japanese upload only with strong evidence', () => {
  const track = { title: 'Mayonaka no Door / Stay With Me', artist: 'Miki Matsubara', durationMilliseconds: 346000 };
  const rate = (candidate, extra = {}) => rank(track, { url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', source: 'youtube', ...candidate, ...extra });
  const good = rate({ title: '真夜中のドア〜stay with me', channel: '松原みき - Topic', durationSeconds: 346 });
  assert.equal(good.confident, true);
  assert.equal(good.readingMatched, true, 'the title is proven by how it sounds, not just by its length');
  assert.equal(good.artistVouched, true);
  assert.equal(rate({ title: '真夜中のドア〜stay with me', channel: '松原みき - Topic', durationSeconds: 386 }).rejected, true, 'a different length is not vouched for');
  assert.equal(rate({ title: '真夜中のドア〜stay with me', channel: 'city pop fan', durationSeconds: 346 }).rejected, true, 'an untrusted uploader is not vouched for');
  assert.equal(rank({ title: 'Lemon', artist: 'Kenshi Yonezu', durationMilliseconds: 255000 }, { title: 'Lemon', channel: '米津玄師 - Topic', url: 'x', durationSeconds: 255 }).confident, true);
  assert.equal(rank({ title: 'Lemon', artist: 'Kenshi Yonezu', durationMilliseconds: 255000 }, { title: 'Lemon', channel: '米津玄師 - Topic', url: 'x', durationSeconds: 300 }).rejected, true);
});

test('kana <-> romaji: hiragana, katakana, digraphs, small tsu and the long-vowel mark', () => {
  const r = japanese.kanaToRomaji;
  assert.equal(r('ハルジオン'), 'harujion');
  assert.equal(r('はるじおん'), 'harujion');
  assert.equal(r('しゃしん'), 'shashin');
  assert.equal(r('ちょっと'), 'chotto');
  assert.equal(r('がっこう'), 'gakkou');
  assert.equal(r('コーヒー'), 'koohii');
  assert.equal(r('ファイト'), 'faito');
  assert.equal(r('ティファニー'), 'tifanii');
  assert.equal(r('ヴァイオリン'), 'vaiorin');
  assert.equal(r('ｶﾀｶﾅ'), 'katakana', 'half-width katakana');
  assert.equal(r('Hello ハロー'), 'Hello haroo', 'Latin passes through');
  assert.equal(japanese.phoneticKey('Shinou'), japanese.phoneticKey('shinō'));
  assert.equal(japanese.phoneticKey('Shi'), japanese.phoneticKey('si'));
  assert.equal(japanese.phoneticKey('tsuki'), japanese.phoneticKey('tuki'));
});

test('reading similarity links kanji+kana titles to romaji (kanji are unknown gaps) without confusing different songs', () => {
  const sim = japanese.readingSimilarity;
  for (const other of ['Boku Ga Shinou To Omottanowa', 'Nakashima Mika Boku Ga Shinou To Omotta No Wa', 'bokuga shinōto omotta no wa']) {
    assert.ok(sim('僕が死のうと思ったのは', other) >= 0.85, other);
  }
  assert.ok(sim('ハルジオン', 'Harujion') >= 0.99);
  assert.ok(sim('ハルジオン', 'はるじおん') >= 0.99, 'katakana == hiragana');
  assert.ok(sim('春を告げる', 'Haru wo Tsugeru') >= 0.85);
  assert.ok(sim('Mayonaka no Door / Stay With Me', '真夜中のドア〜stay with me') >= 0.85);
  for (const other of ['I', 'Glamorous Sky', 'Boku no Kimochi', 'Yoru ni Kakeru']) assert.ok(sim('僕が死のうと思ったのは', other) < 0.5, other);
  assert.ok(sim('ハルジオン', 'Tsubame') < 0.5);
  assert.equal(sim('Hotel California', 'Take It Easy'), null, 'same script: nothing to translate');
  assert.equal(sim('秒針を噛む', 'Byoushin wo Kamu'), null, 'almost all kanji: too little to judge, so no guess');
  assert.equal(japanese.romajiQuery('ハルジオン'), 'harujion');
  assert.equal(japanese.romajiQuery('僕が死のうと思ったのは'), null);
});

test('Mika Nakashima case: romaji uploads match, every other version and the wrong song stay skipped', () => {
  const track = { title: '僕が死のうと思ったのは', artist: 'Mika Nakashima', durationMilliseconds: 383000 };
  const rate = candidate => rank(track, { url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', source: 'youtube', durationSeconds: 383, ...candidate });
  const topic = rate({ title: 'Boku Ga Shinou To Omottanowa', channel: 'Mika Nakashima - Topic' });
  assert.equal(topic.confident, true);
  assert.equal(topic.readingMatched, true);
  assert.equal(rate({ title: '僕が死のうと思ったのは', channel: 'Mika Nakashima', source: 'ytm' }).confident, true);
  assert.equal(rate({ title: 'Boku Ga Shinou To Omottanowa (Instrumental)', channel: 'Mika Nakashima' }).rejected, true);
  assert.match(rate({ title: 'Bokuga Shinouto Omottanowa (Piano & Voice Style)', channel: 'Mika Nakashima' }).rejectReasons.join(), /arrangement/i);
  assert.match(rate({ title: '【BACKUP】中島美嘉 僕が死のうと思ったのは Live【中字】', channel: 'fan' }).rejectReasons.join(), /Live/);
  assert.match(rate({ title: 'Nakashima Mika - Boku Ga Shinou To Omotta No Wa (Romanji)', channel: 'Mika Nakashima' }).rejectReasons.join(), /translation/i);
  assert.match(rate({ title: '僕が死のうと思ったのは (English Translation 英訳 + Lyrics 歌詞付き)', channel: 'Mika Nakashima' }).rejectReasons.join(), /translation/i);
  const wrong = rate({ title: 'I', channel: 'Mika Nakashima', source: 'ytm', durationSeconds: 250 });
  assert.equal(wrong.rejected, true);
  assert.deepEqual(wrong.rejectReasons.filter(reason => /Different title/.test(reason)), ['Different title']);
  // Same-length romaji upload from a stranger who never names the artist is not trusted.
  assert.equal(rate({ title: 'Boku Ga Shinou To Omottanowa', channel: 'Some Uploader' }).confident, false);
  // Artist written in another script: "Kenshi Yonezu" / "米津玄師", "Zutomayo" / "ずっと真夜中でいいのに。".
  assert.equal(rank({ title: 'Lemon', artist: 'Kenshi Yonezu', durationMilliseconds: 255000 }, { title: 'Lemon', channel: '米津玄師 - Topic', url: 'x', durationSeconds: 255 }).confident, true);
});

test('katakana, hiragana and romaji uploads of the same title all match', () => {
  const track = { title: 'ハルジオン', artist: 'YOASOBI', durationMilliseconds: 199000 };
  for (const title of ['ハルジオン', 'はるじおん', 'Harujion']) {
    assert.equal(rank(track, { title, channel: 'YOASOBI - Topic', url: 'x', durationSeconds: 199 }).confident, true, title);
  }
});

test('candidates that are the right song in the wrong version are listed before candidates that are a different song', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-sort-'));
  const fake = path.join(root, 'fake-yt-dlp');
  const entries = [
    { id: 'aaaaaaaaaaa', title: 'I', channel: 'Mika Nakashima', duration: 250 },
    { id: 'bbbbbbbbbbb', title: 'Boku Ga Shinou To Omottanowa (Instrumental)', channel: 'Mika Nakashima', duration: 383 }
  ];
  fs.writeFileSync(fake, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ entries: ${JSON.stringify(entries)} }));\n`, { mode: 0o755 });
  const toolManager = { binDir: root, ytDlpPath: fake, refresh() { this.ytDlpPath = fake; } };
  const ranked = await findCandidates({ title: '僕が死のうと思ったのは', artist: 'Mika Nakashima', durationMilliseconds: 383000 }, toolManager);
  assert.equal(ranked[0].url, 'https://www.youtube.com/watch?v=bbbbbbbbbbb', 'the instrumental of the right song comes first');
  assert.equal(ranked.at(-1).url, 'https://www.youtube.com/watch?v=aaaaaaaaaaa', 'the unrelated song is last');
  fs.rmSync(root, { recursive: true, force: true });
});

test('when the first search finds nothing confident, a title-only search recovers the song (and a good first search skips it)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-pass2-'));
  const fake = path.join(root, 'fake-yt-dlp');
  const log = path.join(root, 'calls.log');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const target = decodeURIComponent(process.argv[process.argv.length - 1]);
fs.appendFileSync(${JSON.stringify(log)}, target + '\\n');
const out = entries => console.log(JSON.stringify({ entries }));
if (target.includes('Mika Nakashima')) out([{ id: 'aaaaaaaaaaa', title: 'I', channel: 'Mika Nakashima', duration: 250 }]);
else if (target.includes('q=僕が死のうと思ったのは')) out([{ id: 'ccccccccccc', title: '僕が死のうと思ったのは', channel: 'Mika Nakashima', duration: 383 }]);
else out([]);
`;
  fs.writeFileSync(fake, script, { mode: 0o755 });
  const toolManager = { binDir: root, ytDlpPath: fake, refresh() { this.ytDlpPath = fake; } };
  const ranked = await findCandidates({ title: '僕が死のうと思ったのは', artist: 'Mika Nakashima', durationMilliseconds: 383000 }, toolManager);
  assert.equal(ranked[0].url, 'https://www.youtube.com/watch?v=ccccccccccc');
  assert.equal(ranked[0].confident, true);
  assert.ok(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length > 2, 'extra searches ran');

  // A good first pass means no extra searches (so well-matched playlists stay fast).
  fs.rmSync(log, { force: true });
  const good = [{ id: 'ddddddddddd', title: 'Song', channel: 'Artist - Topic', duration: 200 }];
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, 'x\\n');\nconsole.log(JSON.stringify({ entries: ${JSON.stringify(good)} }));\n`, { mode: 0o755 });
  const quick = await findCandidates({ title: 'Song', artist: 'Artist', durationMilliseconds: 200000 }, toolManager);
  assert.equal(quick[0].confident, true);
  assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length, 2, 'only the two first-pass searches ran');
  fs.rmSync(root, { recursive: true, force: true });
});
