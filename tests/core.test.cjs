const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isAcceptedUrl, buildDownloadArgs, splitArgs, DownloadService } = require('../electron/services/download-service.cjs');
const { parseSpotifyUrl, findPlaylistMatches } = require('../electron/services/spotify-service.cjs');
const { parseLegacySettings } = require('../electron/services/legacy-settings.cjs');


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
