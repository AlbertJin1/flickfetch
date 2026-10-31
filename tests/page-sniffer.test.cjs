const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const sniffer = require('../electron/services/page-sniffer.cjs');
const { DownloadService, buildDownloadArgs, escapeParseMetadata } = require('../electron/services/download-service.cjs');

const MP4_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(400000, 7)]);

function listen(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });

test('a <video><source type="video/mp4"> with HTML-escaped signed URL is read exactly like DevTools shows it', () => {
  // The exact shape from the browser inspector: query string separators are &amp; in the raw HTML.
  const html = `<html><head><title>My &amp; Clip</title></head><body>
    <div id="fluid_video_wrapper_my-video"><video class="wew_video visible" id="my-video" preload="auto" poster="https://pool2.embedplayer.net/thumbs/21376_thumb_0.jpg?st=x&amp;e=1" playsinline loop>
      <source src="https://pool2.embedplayer.net/21376_h265.mp4?st=7PC4StJ7KspdhQMDyHb58A&amp;e=1793467017" type="video/mp4">
    </video></div></body></html>`;
  const parsed = sniffer.extractFromHtml(html, 'https://pool2.embedplayer.net/embed/1');
  assert.equal(parsed.title, 'My & Clip');
  assert.equal(parsed.candidates.length, 1, 'the poster image is not a candidate');
  assert.equal(parsed.candidates[0].url, 'https://pool2.embedplayer.net/21376_h265.mp4?st=7PC4StJ7KspdhQMDyHb58A&e=1793467017');
  assert.equal(parsed.candidates[0].type, 'video/mp4');
  assert.equal(parsed.candidates[0].source, 'video-source');
});

test('relative sources, <base>, data-src, og:video, JSON-LD and HLS are all found; images are not', () => {
  const html = `<head><base href="https://cdn.example.org/v/"><meta property="og:video:secure_url" content="https://cdn.example.org/og.mp4">
    <script type="application/ld+json">{"@type":"VideoObject","contentUrl":"https://cdn.example.org/ld.webm"}</script></head>
    <video data-src="rel/clip.mp4"></video><source src="pic.webp" type="image/webp"><source src="live/master.m3u8" type="application/x-mpegURL">
    <a href="/files/download.mp4">dl</a><img src="https://cdn.example.org/x.jpg">`;
  const urls = sniffer.extractFromHtml(html, 'https://site.example/page').candidates.map(c => c.url);
  assert.ok(urls.includes('https://cdn.example.org/v/rel/clip.mp4'));
  assert.ok(urls.includes('https://cdn.example.org/og.mp4'));
  assert.ok(urls.includes('https://cdn.example.org/ld.webm'));
  assert.ok(urls.includes('https://cdn.example.org/v/live/master.m3u8'));
  assert.ok(urls.includes('https://cdn.example.org/files/download.mp4'), '<base> applies to root-relative links too');
  assert.ok(!urls.some(u => /\.(webp|jpg)/.test(u)));
});

test('player configs in scripts are decoded: escaped slashes, \\u0026, atob payloads, quality labels', () => {
  const b64 = Buffer.from('https://media.example.net/secret/hidden.mp4?t=1').toString('base64');
  const html = `<script>
    var cfg = {"sources":[{"file":"https:\\/\\/media.example.net\\/a\\/720.mp4?x=1\\u0026y=2","label":"720p"},{"file":"https:\\/\\/media.example.net\\/a\\/1080.mp4","label":"1080p"}]};
    player.src(atob("${b64}"));
  </script>`;
  const found = sniffer.extractFromHtml(html, 'https://site.example/').candidates;
  const urls = found.map(c => c.url);
  assert.ok(urls.includes('https://media.example.net/a/720.mp4?x=1&y=2'));
  assert.ok(urls.includes('https://media.example.net/secret/hidden.mp4?t=1'));
  assert.equal(found[0].url.includes('1080.mp4'), true, 'higher resolution ranks first');
});

test('ads and previews rank below the real video', () => {
  const html = `<video src="https://x.example/ads/preroll.mp4"></video><video src="https://x.example/media/thumb_preview.mp4"></video><video src="https://x.example/media/main.mp4"></video>`;
  const found = sniffer.extractFromHtml(html, 'https://x.example/').candidates;
  assert.equal(found[0].url, 'https://x.example/media/main.mp4');
});

test('live DOM snapshot: currentSrc and <source> from a JavaScript-built player outrank everything', () => {
  const result = sniffer.extractFromSnapshot({
    href: 'https://player.example/embed/9', title: 'Rendered',
    html: '<div id="fluid_video_wrapper_my-video"></div>',
    videos: [{ currentSrc: '', src: '', sources: [{ src: '/21376_h265.mp4?st=a&e=2', type: 'video/mp4', label: '' }] }]
  });
  assert.equal(result.candidates[0].url, 'https://player.example/21376_h265.mp4?st=a&e=2');
  assert.equal(result.candidates[0].source, 'dom-source');
});

test('Netscape cookie files are parsed (including #HttpOnly_ lines)', () => {
  const cookies = sniffer.parseNetscapeCookies('# Netscape HTTP Cookie File\n#HttpOnly_.example.com\tTRUE\t/\tTRUE\t1793467017\tsid\tabc\n.other.org\tTRUE\t/\tFALSE\t0\tk\tv\n');
  assert.equal(cookies.length, 2);
  assert.equal(cookies[0].httpOnly, true);
  assert.equal(cookies[0].secure, true);
  assert.equal(cookies[0].name, 'sid');
  assert.equal(cookies[1].expirationDate, undefined);
});

test('metadata titles are escaped for yt-dlp --parse-metadata', () => {
  assert.equal(escapeParseMetadata('Part 1: 100% real'), 'Part 1\\: 100%% real');
});

test('resolveMedia follows the nested player iframe and finds the Referer a hot-link protected file needs', async () => {
  const media = await listen((req, res) => {
    // Like a signed CDN: refuses unless the request carries the player page as Referer.
    if (!String(req.headers.referer || '').includes('/embed/')) { res.writeHead(403, { 'content-type': 'text/html' }); res.end('<html>blocked</html>'); return; }
    if (!req.url.startsWith('/21376_h265.mp4?st=good&e=')) { res.writeHead(404); res.end(); return; }
    res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes 0-2047/${MP4_BYTES.length}`, 'content-length': 2048 });
    res.end(MP4_BYTES.subarray(0, 2048));
  });
  let player;
  const playerServer = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><title>Player</title><video id="my-video"><source src="${media.base}/21376_h265.mp4?st=good&amp;e=1793467017" type="video/mp4"></video></html>`);
  });
  player = playerServer;
  const site = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head><title>Episode 5 | Example</title></head><body><iframe src="${player.base}/embed/abc" allowfullscreen></iframe></body></html>`);
  });
  try {
    const logs = [];
    const result = await sniffer.resolveMedia({ url: `${site.base}/watch/5`, fetchImpl: fetch, log: m => logs.push(m) });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.stage, 'static');
    assert.equal(result.selected.url, `${media.base}/21376_h265.mp4?st=good&e=1793467017`);
    assert.equal(result.selected.referer, `${player.base}/embed/abc`, 'the player frame, not the outer page, is the Referer');
    assert.equal(result.selected.validated, true);
    assert.equal(result.title, 'Episode 5 | Example');
    assert.ok(logs.some(m => /Verified FILE source/.test(m)));
  } finally { await Promise.all([close(media.server), close(playerServer.server), close(site.server)]); }
});

test('a link that is already a media file resolves directly; HTML error pages are rejected as media', async () => {
  const srv = await listen((req, res) => {
    if (req.url === '/direct.mp4') { res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': MP4_BYTES.length }); res.end(MP4_BYTES); return; }
    res.writeHead(200, { 'content-type': 'video/mp4' }); res.end('<!DOCTYPE html><html>sign in</html>');
  });
  try {
    const direct = await sniffer.resolveMedia({ url: `${srv.base}/direct.mp4`, fetchImpl: fetch });
    assert.equal(direct.ok, true);
    assert.equal(direct.selected.url, `${srv.base}/direct.mp4`);
    const fake = await sniffer.probeUrl(`${srv.base}/fake.mp4`, '', { fetchImpl: fetch });
    assert.equal(fake.ok, false);
    assert.match(fake.reason, /web page instead of media/);
  } finally { await close(srv.server); }
});

test('the rendered stage is used when the static page has no video, and its network capture is verified', async () => {
  const media = await listen((req, res) => { res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes 0-2047/${MP4_BYTES.length}` }); res.end(MP4_BYTES.subarray(0, 2048)); });
  const site = await listen((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><title>JS player</title><div id="app"></div><script>/* builds player at runtime */</script></html>'); });
  try {
    let rendererCalled = 0;
    const result = await sniffer.resolveMedia({
      url: `${site.base}/watch`, fetchImpl: fetch,
      renderer: async (url) => {
        rendererCalled++;
        return {
          title: 'JS player',
          snapshots: [{ href: url, title: 'JS player', html: '', videos: [{ currentSrc: '', src: '', sources: [{ src: `${media.base}/live.mp4?st=1&e=2`, type: 'video/mp4' }] }] }],
          network: [{ url: `${media.base}/other-quality.mp4`, mediaRequest: true, referer: url }]
        };
      }
    });
    assert.equal(rendererCalled, 1);
    assert.equal(result.ok, true);
    assert.equal(result.stage, 'rendered');
    assert.equal(result.selected.url, `${media.base}/live.mp4?st=1&e=2`);
    assert.ok(result.candidates.some(c => c.url.endsWith('other-quality.mp4')));
  } finally { await Promise.all([close(media.server), close(site.server)]); }
});

test('nothing found gives a clear reason instead of a vague yt-dlp error', async () => {
  const site = await listen((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><title>Text only</title><p>No video here</p></html>'); });
  try {
    const result = await sniffer.resolveMedia({ url: `${site.base}/`, fetchImpl: fetch });
    assert.equal(result.ok, false);
    assert.match(result.reason, /No video file/);
  } finally { await close(site.server); }
});

test('download args send the browser Referer, User-Agent and page title for a resolved source', () => {
  const args = buildDownloadArgs({ outputDir: '/tmp', preset: 0, container: 'mp4', fragments: 1, retries: 0 }, '/tmp/bin',
    { url: 'https://cdn.example/x.mp4?st=1&e=2', referer: 'https://player.example/embed/1', userAgent: sniffer.BROWSER_UA, title: 'Ep 5: The "Start"' });
  const at = flag => args[args.indexOf(flag) + 1];
  assert.equal(at('--referer'), 'https://player.example/embed/1');
  assert.equal(at('--user-agent'), sniffer.BROWSER_UA);
  assert.equal(at('--parse-metadata'), 'Ep 5\\: The "Start":%(title)s');
});

test('queue: when yt-dlp has no extractor, FlickFetch inspects the page and retries with the real mp4 and Referer', async () => {
  const media = await listen((req, res) => {
    if (req.headers.referer !== `${site.base}/watch/1`) { res.writeHead(403); res.end(); return; }
    res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes 0-2047/${MP4_BYTES.length}` }); res.end(MP4_BYTES.subarray(0, 2048));
  });
  const site = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><title>Clip One</title><video><source src="${media.base}/clip.mp4?st=a&amp;e=9" type="video/mp4"></video></html>`);
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-sniff-queue-'));
  const outputDir = path.join(root, 'out');
  fs.mkdirSync(outputDir, { recursive: true });
  const callsFile = path.join(root, 'calls.jsonl');
  const fake = path.join(root, 'fake-yt-dlp');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');
if (!args.includes('--referer')) {
  console.error('[generic] Extracting URL: ' + args[args.length - 1]);
  console.error('ERROR: Unsupported URL: ' + args[args.length - 1]);
  process.exit(1);
}
const saved = path.join(process.cwd(), 'Clip One.mp4'); fs.writeFileSync(saved, 'media');
console.log('@@T|1|1|clip'); console.log('@@F|' + saved);
`, { mode: 0o755 });
  const settings = { outputDir, preset: 0, container: 'mp4', fragments: 1, retries: 0, autoStart: true, parallel: 1, inspectPages: true };
  let finish;
  const done = new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('queue did not finish')), 8000); finish = item => { clearTimeout(t); resolve(item); }; });
  const service = new DownloadService({
    toolManager: { binDir: root, ytDlpPath: fake, ffmpegPath: '', refresh() {} },
    getSettings: () => settings, userDataPath: path.join(root, 'ud'),
    emit(channel, payload) { const item = payload?.item; if (channel === 'downloads:changed' && ['Done', 'Failed'].includes(item?.status)) finish(item); }
  });
  try {
    service.add([`${site.base}/watch/1`]);
    const item = await done;
    assert.equal(item.status, 'Done', item.errorText);
    const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.length, 2, 'first yt-dlp attempt on the page, second on the verified media');
    assert.equal(calls[0].at(-1), `${site.base}/watch/1`);
    assert.equal(calls[1].at(-1), `${media.base}/clip.mp4?st=a&e=9`);
    assert.equal(calls[1][calls[1].indexOf('--referer') + 1], `${site.base}/watch/1`);
    assert.ok(item.logs.some(line => /Using FILE source found in the page \(video\/mp4\)/.test(line)), 'the log says what was found and where');
    assert.equal(item.url, `${site.base}/watch/1`, 'history keeps the link the person pasted');
  } finally {
    service.flushPersist();
    await Promise.all([close(media.server), close(site.server)]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('queue: turning the setting off keeps the original yt-dlp failure and never fetches the page', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-sniff-off-'));
  const outputDir = path.join(root, 'out'); fs.mkdirSync(outputDir, { recursive: true });
  const fake = path.join(root, 'fake-yt-dlp');
  fs.writeFileSync(fake, '#!/usr/bin/env node\nconsole.error("[generic] x");console.error("ERROR: Unsupported URL: x");process.exit(1);\n', { mode: 0o755 });
  let resolverCalls = 0; let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const service = new DownloadService({
    toolManager: { binDir: root, ytDlpPath: fake, refresh() {} },
    getSettings: () => ({ outputDir, preset: 0, autoStart: true, parallel: 1, inspectPages: false, fragments: 1, retries: 0 }), userDataPath: path.join(root, 'ud'),
    resolveMedia: async () => { resolverCalls++; return { ok: false }; },
    emit(channel, payload) { if (channel === 'downloads:changed' && payload?.item?.status === 'Failed') finish(payload.item); }
  });
  service.add(['https://example.com/page']);
  const item = await done;
  assert.equal(resolverCalls, 0);
  assert.match(item.errorText, /Unsupported URL/);
  service.flushPersist();
  fs.rmSync(root, { recursive: true, force: true });
});

test('queue: canceling while the page is being inspected stops cleanly and never starts yt-dlp on the media', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-sniff-cancel-'));
  const outputDir = path.join(root, 'out'); fs.mkdirSync(outputDir, { recursive: true });
  const fake = path.join(root, 'fake-yt-dlp');
  const calls = path.join(root, 'calls.log');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, 'x\\n');\nconsole.error('ERROR: Unsupported URL: x');process.exit(1);\n`, { mode: 0o755 });
  let inspecting; let finish;
  const started = new Promise(resolve => { inspecting = resolve; });
  const done = new Promise(resolve => { finish = resolve; });
  const service = new DownloadService({
    toolManager: { binDir: root, ytDlpPath: fake, refresh() {} },
    getSettings: () => ({ outputDir, preset: 0, autoStart: true, parallel: 1, inspectPages: true, fragments: 1, retries: 0 }), userDataPath: path.join(root, 'ud'),
    resolveMedia: (url, { signal }) => new Promise(resolve => { inspecting(); signal.addEventListener('abort', () => resolve({ ok: false, reason: 'Canceled.' })); }),
    emit(channel, payload) { if (channel === 'downloads:changed' && payload?.item?.status === 'Canceled') finish(payload.item); }
  });
  const [item] = service.add(['https://example.com/page']);
  await started;
  assert.equal(service.stopItem(item.id), true);
  const result = await done;
  assert.equal(result.status, 'Canceled');
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1, 'yt-dlp ran once (the original attempt) and not again after cancel');
  assert.equal(service.processes.size, 0, 'the download slot is released');
  service.flushPersist();
  fs.rmSync(root, { recursive: true, force: true });
});

test('cookies file entries become a Cookie header only for matching host, path, scheme and unexpired cookies', () => {
  const cookies = sniffer.parseNetscapeCookies([
    '.example.com\tTRUE\t/\tFALSE\t0\tsession\tabc', '.example.com\tTRUE\t/private\tFALSE\t0\tpriv\t1',
    'cdn.example.com\tFALSE\t/\tTRUE\t0\tsecureonly\t2', '.example.com\tTRUE\t/\tFALSE\t1\texpired\t3', '.other.org\tTRUE\t/\tFALSE\t0\tno\t4'
  ].join('\n'));
  assert.equal(sniffer.cookieHeaderFor('https://www.example.com/watch', cookies), 'session=abc');
  assert.equal(sniffer.cookieHeaderFor('https://www.example.com/private/x', cookies), 'session=abc; priv=1');
  assert.equal(sniffer.cookieHeaderFor('https://cdn.example.com/v.mp4', cookies), 'session=abc; secureonly=2');
  assert.equal(sniffer.cookieHeaderFor('http://cdn.example.com/v.mp4', cookies), 'session=abc');
});
