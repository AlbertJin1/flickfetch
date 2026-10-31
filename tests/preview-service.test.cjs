const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PreviewService, PROBE_RANGE, CHUNK_BYTES, AUDIO_FORMAT, parseVideoId, parseRange, friendlyError, isAllowedUpstream, streamUpstream } = require('../electron/services/preview-service.cjs');

const ID = 'dQw4w9WgXcQ';
const TOTAL = CHUNK_BYTES * 2 + 12345;
const BODY = Buffer.alloc(TOTAL);
for (let i = 0; i < TOTAL; i += 1) BODY[i] = i % 251;

/** A tiny stand-in for googlevideo: supports Range, can be told to reject (expired URL). */
function startUpstream() {
  const state = { reject: false, rejectOnce: false, ranges: [], headers: [] };
  const server = http.createServer((req, res) => {
    state.ranges.push(req.headers.range || null);
    state.headers.push(req.headers);
    if (state.reject || state.rejectOnce) { state.rejectOnce = false; res.writeHead(403); res.end('expired'); return; }
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!match) { res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Content-Length': TOTAL }); res.end(BODY); return; }
    let start; let end;
    if (match[1] === '') { start = Math.max(0, TOTAL - Number(match[2])); end = TOTAL - 1; }
    else { start = Number(match[1]); end = match[2] === '' ? TOTAL - 1 : Math.min(Number(match[2]), TOTAL - 1); }
    if (start >= TOTAL) { res.writeHead(416, { 'Content-Range': `bytes */${TOTAL}` }); res.end(); return; }
    res.writeHead(206, { 'Content-Type': 'audio/mp4', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${TOTAL}` });
    res.end(BODY.subarray(start, end + 1));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}/videoplayback?expire=${Math.floor(Date.now() / 1000) + 3600}` })));
}

function fakeTools(streamUrl, overrides = {}) {
  const calls = [];
  return {
    calls,
    ytDlpPath: 'yt-dlp',
    refresh() {},
    async run(args, options) {
      calls.push({ args, options });
      if (args.includes('-P') && overrides.download !== false) { // the yt-dlp download fallback
        const dir = args[args.indexOf('-P') + 1];
        const name = args[args.indexOf('-o') + 1].replace('%(ext)s', 'm4a');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name), BODY);
        return { code: 0, stdout: `${path.join(dir, name)}\n`, stderr: '' };
      }
      if (overrides.run) return overrides.run(args, options);
      return { code: 0, stdout: JSON.stringify({ url: streamUrl, title: 'Song', artist: 'Band', duration: 215, http_headers: { 'User-Agent': 'UA/1', Cookie: 'secret=1', 'Sec-Fetch-Mode': 'navigate' } }), stderr: '' };
    }
  };
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ffprev-test-'));
const makeService = (tools, extra = {}) => new PreviewService({ toolManager: tools, getSettings: () => ({}), allowUpstream: () => true, cacheDir: path.join(tempDir(), 'cache'), ...extra });
/** A stand-in upstream for tests that only care about yt-dlp, not the stream: every probe succeeds. */
const healthyUpstream = async () => ({ status: 206, headers: {}, body: null });
const request = (path = ID, headers = {}) => new Request(`ffpreview://track/${path}`, { headers });

test('parseVideoId accepts YouTube URL shapes and rejects everything else', () => {
  assert.equal(parseVideoId(`https://www.youtube.com/watch?v=${ID}&list=PL1`), ID);
  assert.equal(parseVideoId(`https://music.youtube.com/watch?v=${ID}`), ID);
  assert.equal(parseVideoId(`https://youtu.be/${ID}?t=5`), ID);
  assert.equal(parseVideoId(`https://www.youtube.com/shorts/${ID}`), ID);
  assert.equal(parseVideoId(ID), ID);
  assert.equal(parseVideoId('https://evil.example/watch?v=' + ID), null);
  assert.equal(parseVideoId('https://www.youtube.com/results?search_query=abc'), null);
  assert.equal(parseVideoId('file:///etc/passwd'), null);
  assert.equal(parseVideoId(''), null);
  assert.equal(parseVideoId(undefined), null);
});

test('parseRange understands open, closed, suffix and invalid ranges', () => {
  assert.equal(parseRange(null), null);
  assert.deepEqual(parseRange('bytes=10-'), { start: 10, end: null });
  assert.deepEqual(parseRange('bytes=10-20'), { start: 10, end: 20 });
  assert.deepEqual(parseRange('bytes=-500'), { suffix: 500 });
  assert.equal(parseRange('bytes=20-10').invalid, true);
  assert.equal(parseRange('bytes=0-1,5-9').invalid, true);
  assert.equal(parseRange('items=0-1').invalid, true);
});

test('upstream allow-list only accepts HTTPS googlevideo / youtube hosts', () => {
  assert.equal(isAllowedUpstream('https://rr3---sn-abc.googlevideo.com/videoplayback?x=1'), true);
  assert.equal(isAllowedUpstream('http://rr3---sn-abc.googlevideo.com/videoplayback'), false);
  assert.equal(isAllowedUpstream('https://googlevideo.com.evil.example/videoplayback'), false);
  assert.equal(isAllowedUpstream('https://127.0.0.1/videoplayback'), false);
  assert.equal(isAllowedUpstream('not a url'), false);
});

test('friendlyError turns yt-dlp noise into one actionable sentence', () => {
  assert.match(friendlyError('ERROR: [youtube] abc: Sign in to confirm you’re not a bot'), /sign-in/i);
  assert.match(friendlyError('ERROR: [youtube] abc: Video unavailable'), /can’t be played/);
  assert.match(friendlyError('ERROR: [youtube] abc: Requested format is not available'), /Updating yt-dlp/);
  assert.match(friendlyError(''), /Couldn’t load the preview/);
});

test('prepare resolves audio-only with yt-dlp settings, returns the protocol src and caches the result', async () => {
  const tools = fakeTools('https://rr1.googlevideo.com/videoplayback');
  const service = new PreviewService({ toolManager: tools, getSettings: () => ({ proxy: 'http://proxy:8080', cookiesBrowser: 'firefox' }), fetchUpstream: healthyUpstream });
  const info = await service.prepare(`https://www.youtube.com/watch?v=${ID}`);
  assert.deepEqual(info, { id: ID, src: `ffpreview://track/${ID}`, title: 'Song', durationSeconds: 215 });
  const { args } = tools.calls[0];
  assert.ok(args.includes('--no-playlist') && args.includes('--skip-download') && args.includes('--dump-single-json'));
  assert.equal(args[args.indexOf('-f') + 1], AUDIO_FORMAT);
  assert.equal(args[args.indexOf('--proxy') + 1], 'http://proxy:8080');
  assert.equal(args[args.indexOf('--cookies-from-browser') + 1], 'firefox');
  assert.equal(args.at(-1), `https://www.youtube.com/watch?v=${ID}`);
  await service.prepare(ID);
  assert.equal(tools.calls.length, 1, 'second prepare is served from cache');
});

test('concurrent prepares for one video share a single yt-dlp run', async () => {
  const tools = fakeTools('https://rr1.googlevideo.com/videoplayback');
  const service = new PreviewService({ toolManager: tools, getSettings: () => ({}), fetchUpstream: healthyUpstream });
  await Promise.all([service.prepare(ID), service.prepare(ID), service.prepare(ID)]);
  assert.equal(tools.calls.length, 1);
});

test('cache entries expire shortly before the stream URL does', async () => {
  let clock = 1_000_000_000_000;
  const expireAt = Math.floor(clock / 1000) + 600; // stream valid for 10 minutes
  const tools = fakeTools(`https://rr1.googlevideo.com/videoplayback?expire=${expireAt}`);
  const service = new PreviewService({ toolManager: tools, getSettings: () => ({}), now: () => clock, fetchUpstream: healthyUpstream });
  await service.prepare(ID);
  clock += 4 * 60 * 1000;
  await service.prepare(ID);
  assert.equal(tools.calls.length, 1);
  clock += 2 * 60 * 1000; // inside the 5 minute safety margin
  await service.prepare(ID);
  assert.equal(tools.calls.length, 2);
});

test('prepare reports readable errors', async () => {
  await assert.rejects(makeService(fakeTools('x')).prepare('https://example.com/nope'), /only available for YouTube/);
  const missing = fakeTools('x'); missing.ytDlpPath = null;
  await assert.rejects(makeService(missing).prepare(ID), /yt-dlp is not installed/);
  const failing = fakeTools('x', { run: async () => ({ code: 1, stdout: '', stderr: 'ERROR: [youtube] dQw4w9WgXcQ: Video unavailable' }) });
  await assert.rejects(makeService(failing).prepare(ID), /can’t be played/);
  const garbage = fakeTools('x', { run: async () => ({ code: 0, stdout: 'not json', stderr: '' }) });
  await assert.rejects(makeService(garbage).prepare(ID), /unreadable/);
  const timeout = fakeTools('x', { run: async () => { throw new Error('The tool did not respond before the timeout.'); } });
  await assert.rejects(makeService(timeout).prepare(ID), /took too long/);
  const foreign = fakeTools('https://evil.example/stream.m4a');
  await assert.rejects(new PreviewService({ toolManager: foreign, getSettings: () => ({}) }).prepare(ID), /did not provide a playable audio stream/);
});

test('protocol handler proxies the stream with correct Range semantics', async () => {
  const upstream = await startUpstream();
  try {
    const tools = fakeTools(upstream.url);
    const service = makeService(tools, { fetchUpstream: streamUpstream });

    // First media request: open-ended range is answered with one bounded chunk.
    let response = await service.handleRequest(request(ID, { Range: 'bytes=0-' }));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes 0-${CHUNK_BYTES - 1}/${TOTAL}`);
    assert.equal(response.headers.get('content-type'), 'audio/mp4');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    let body = Buffer.from(await response.arrayBuffer());
    assert.equal(body.length, CHUNK_BYTES);
    assert.ok(body.equals(BODY.subarray(0, CHUNK_BYTES)));

    // Seeking into the middle.
    response = await service.handleRequest(request(ID, { Range: `bytes=${CHUNK_BYTES + 10}-` }));
    assert.equal(response.status, 206);
    body = Buffer.from(await response.arrayBuffer());
    assert.ok(body.equals(BODY.subarray(CHUNK_BYTES + 10, CHUNK_BYTES * 2 + 10)));

    // Explicit ranges are passed through untouched.
    response = await service.handleRequest(request(ID, { Range: 'bytes=100-199' }));
    assert.equal(response.headers.get('content-range'), `bytes 100-199/${TOTAL}`);
    assert.equal((await response.arrayBuffer()).byteLength, 100);

    // Suffix ranges (tail) too.
    response = await service.handleRequest(request(ID, { Range: 'bytes=-1000' }));
    assert.equal(response.headers.get('content-range'), `bytes ${TOTAL - 1000}-${TOTAL - 1}/${TOTAL}`);
    await response.arrayBuffer();

    // Past the end.
    response = await service.handleRequest(request(ID, { Range: `bytes=${TOTAL + 5}-` }));
    assert.equal(response.status, 416);

    // No Range header: plain 200 with the whole file, no Range sent upstream.
    response = await service.handleRequest(request(ID));
    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, TOTAL);
    assert.equal(upstream.state.ranges.at(-1), null);

    // Only the allow-listed yt-dlp headers reach the upstream; cookies and fetch-metadata never do.
    const sent = upstream.state.headers[0];
    assert.equal(sent['user-agent'], 'UA/1');
    assert.equal(sent.cookie, undefined);
    assert.equal(sent['sec-fetch-mode'], undefined);
    assert.equal(tools.calls.length, 1, 'one resolve served every request');
  } finally { upstream.server.close(); }
});

test('an expired stream URL is re-resolved once and the request still succeeds', async () => {
  const upstream = await startUpstream();
  try {
    const tools = fakeTools(upstream.url);
    const service = makeService(tools, { fetchUpstream: streamUpstream });
    await service.prepare(ID);
    upstream.state.rejectOnce = true; // the cached URL is rejected once; the freshly resolved one works
    const response = await service.handleRequest(request(ID, { Range: 'bytes=0-' }));
    assert.equal(response.status, 206);
    await response.arrayBuffer();
    assert.equal(tools.calls.length, 2);
  } finally { upstream.server.close(); }
});

test('when the direct stream is refused, yt-dlp downloads the audio and it plays from the file', async () => {
  const upstream = await startUpstream();
  try {
    upstream.state.reject = true; // googlevideo refuses every direct request
    const logs = [];
    const tools = fakeTools(upstream.url);
    const service = makeService(tools, { fetchUpstream: streamUpstream, log: (level, message) => logs.push(message) });

    let response = await service.handleRequest(request(ID, { Range: 'bytes=0-' }));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-type'), 'audio/mp4');
    assert.equal(response.headers.get('content-range'), `bytes 0-${TOTAL - 1}/${TOTAL}`);
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(BODY));
    assert.match(logs.join('\n'), /falling back to a yt-dlp download/);
    const download = tools.calls.find(call => call.args.includes('-P'));
    assert.ok(download.args.includes('--no-playlist') && download.args.includes('--print'));
    assert.equal(download.args.at(-1), `https://www.youtube.com/watch?v=${ID}`);

    // Seeking is now served from the local file: exact ranges, no more upstream or yt-dlp traffic.
    const upstreamBefore = upstream.state.ranges.length;
    response = await service.handleRequest(request(ID, { Range: 'bytes=1000-1999' }));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes 1000-1999/${TOTAL}`);
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(BODY.subarray(1000, 2000)));
    response = await service.handleRequest(request(ID, { Range: 'bytes=-500' }));
    assert.equal(response.headers.get('content-range'), `bytes ${TOTAL - 500}-${TOTAL - 1}/${TOTAL}`);
    await response.arrayBuffer();
    response = await service.handleRequest(request(ID, { Range: `bytes=${TOTAL + 1}-` }));
    assert.equal(response.status, 416);
    response = await service.handleRequest(request(ID));
    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, TOTAL);
    assert.equal(upstream.state.ranges.length, upstreamBefore);
    assert.equal(tools.calls.filter(call => call.args.includes('-P')).length, 1);
  } finally { upstream.server.close(); }
});

test('after repeated direct failures new videos go straight to the download', async () => {
  const upstream = await startUpstream();
  try {
    upstream.state.reject = true;
    const service = makeService(fakeTools(upstream.url), { fetchUpstream: streamUpstream });
    for (const id of ['aaaaaaaaaaa', 'bbbbbbbbbbb']) await (await service.handleRequest(request(id, { Range: 'bytes=0-' }))).arrayBuffer();
    const hits = upstream.state.ranges.length;
    await (await service.handleRequest(request('ccccccccccc', { Range: 'bytes=0-' }))).arrayBuffer();
    assert.equal(upstream.state.ranges.length, hits, 'no further direct attempts once it is known to fail');
  } finally { upstream.server.close(); }
});

test('concurrent requests share one download and old cached files are pruned', async () => {
  const tools = fakeTools('https://rr1.googlevideo.com/videoplayback');
  const service = makeService(tools, { fetchUpstream: async () => { throw new Error('refused'); } });
  const responses = await Promise.all([1, 2, 3].map(() => service.handleRequest(request(ID, { Range: 'bytes=0-9' }))));
  assert.deepEqual(responses.map(r => r.status), [206, 206, 206]);
  await Promise.all(responses.map(r => r.arrayBuffer()));
  assert.equal(tools.calls.filter(call => call.args.includes('-P')).length, 1);
  const ids = Array.from({ length: 14 }, (_, i) => `id${String(i).padStart(9, '0')}`);
  for (const id of ids) await (await service.handleRequest(request(id, { Range: 'bytes=0-9' }))).arrayBuffer();
  assert.ok(fs.readdirSync(service.cacheDir).length <= 12);
  service.clearCacheDir();
  assert.equal(fs.existsSync(service.cacheDir), false);
});

test('if both the stream and the download fail, the media element gets a 502 with the reason', async () => {
  const failing = fakeTools('https://rr1.googlevideo.com/videoplayback', { download: false, run: async args => (args.includes('-P') ? { code: 1, stdout: '', stderr: 'ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you’re not a bot' } : { code: 0, stdout: JSON.stringify({ url: 'https://rr1.googlevideo.com/videoplayback', title: 't', duration: 1 }), stderr: '' }) });
  const response = await makeService(failing, { fetchUpstream: async () => ({ status: 403, headers: {}, body: null }) }).handleRequest(request(ID, { Range: 'bytes=0-' }));
  assert.equal(response.status, 502);
  assert.match(await response.text(), /sign-in/i);
});

test('protocol handler rejects anything that is not a plain video id request', async () => {
  const service = makeService(fakeTools('http://127.0.0.1:1/x'));
  assert.equal((await service.handleRequest(request('short'))).status, 400);
  assert.equal((await service.handleRequest(request('..%2F..%2Fsecret'))).status, 400);
  assert.equal((await service.handleRequest(new Request('ffpreview://other/' + ID))).status, 404);
  assert.equal((await service.handleRequest(new Request(`ffpreview://track/${ID}`, { method: 'POST', body: 'x' }))).status, 405);
  assert.equal((await service.handleRequest(request(ID, { Range: 'bytes=9-1' }))).status, 416);
});

test('a failed stream lookup is rescued by the download fallback', async () => {
  const failing = fakeTools('x', { run: async () => ({ code: 1, stdout: '', stderr: 'ERROR: [youtube] dQw4w9WgXcQ: Video unavailable' }) });
  const response = await makeService(failing).handleRequest(request(ID, { Range: 'bytes=0-9' }));
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 10);
});

test('aborting the request tears down the upstream connection', async () => {
  const upstream = await startUpstream();
  try {
    const controller = new AbortController();
    const service = makeService(fakeTools(upstream.url), { fetchUpstream: streamUpstream });
    await service.prepare(ID);
    controller.abort();
    const response = await service.handleRequest(new Request(`ffpreview://track/${ID}`, { headers: { Range: 'bytes=0-' }, signal: controller.signal }));
    assert.equal(response.status, 499);
  } finally { upstream.server.close(); }
});

test('prepare probes the direct stream with a tiny range and does not download when it answers', async () => {
  const upstream = await startUpstream();
  try {
    const tools = fakeTools(upstream.url);
    const service = makeService(tools, { fetchUpstream: streamUpstream });
    await service.prepare(ID);
    assert.deepEqual(upstream.state.ranges, [PROBE_RANGE]);
    assert.equal(tools.calls.filter(call => call.args.includes('-P')).length, 0);
    await service.prepare(ID);
    assert.equal(upstream.state.ranges.length, 1, 'a verified stream is not probed again straight away');
  } finally { upstream.server.close(); }
});

test('when YouTube refuses the stream, prepare downloads the audio so the first play already works', async () => {
  const upstream = await startUpstream();
  try {
    upstream.state.reject = true;
    const tools = fakeTools(upstream.url);
    const service = makeService(tools, { fetchUpstream: streamUpstream });
    const info = await service.prepare(ID);              // the slow fallback happens here, behind the spinner
    assert.equal(info.src, `ffpreview://track/${ID}`);
    assert.equal(tools.calls.filter(call => call.args.includes('-P')).length, 1);
    const before = upstream.state.ranges.length;
    const response = await service.handleRequest(request(ID, { Range: 'bytes=0-' }));   // the <audio> element's request
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes 0-${TOTAL - 1}/${TOTAL}`);
    await response.arrayBuffer();
    assert.equal(upstream.state.ranges.length, before, 'served from disk: no more upstream traffic');
    assert.equal(tools.calls.filter(call => call.args.includes('-P')).length, 1);
  } finally { upstream.server.close(); }
});

test('prepare waits for a download that is already running instead of racing it', async () => {
  const upstream = await startUpstream();
  try {
    upstream.state.reject = true;
    const tools = fakeTools(upstream.url);
    const service = makeService(tools, { fetchUpstream: streamUpstream });
    await Promise.all([service.prepare(ID), service.prepare(ID, { fresh: true }), service.handleRequest(request(ID, { Range: 'bytes=0-9' })).then(r => r.arrayBuffer())]);
    assert.equal(tools.calls.filter(call => call.args.includes('-P')).length, 1);
  } finally { upstream.server.close(); }
});

test('prepare({ fresh }) forgets the cached stream and resolves again', async () => {
  const tools = fakeTools('https://rr1.googlevideo.com/videoplayback');
  const service = makeService(tools, { fetchUpstream: healthyUpstream });
  await service.prepare(ID);
  await service.prepare(ID, { fresh: true });
  assert.equal(tools.calls.length, 2);
});

test('a transient download failure is retried once; a permanent one is not', async () => {
  let attempts = 0;
  const flaky = fakeTools('x', { download: false, run: async args => {
    if (!args.includes('-P')) return { code: 0, stdout: JSON.stringify({ url: 'https://rr1.googlevideo.com/videoplayback', duration: 1 }), stderr: '' };
    attempts += 1;
    if (attempts === 1) return { code: 1, stdout: '', stderr: 'ERROR: unable to download video data: connection reset' };
    const dir = args[args.indexOf('-P') + 1]; const file = path.join(dir, `${ID}.m4a`);
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, BODY);
    return { code: 0, stdout: `${file}\n`, stderr: '' };
  } });
  const service = makeService(flaky, { fetchUpstream: async () => ({ status: 403, headers: {}, body: null }) });
  await service.prepare(ID);
  assert.equal(attempts, 2);

  let permanentAttempts = 0;
  const blocked = fakeTools('x', { download: false, run: async args => {
    if (!args.includes('-P')) return { code: 0, stdout: JSON.stringify({ url: 'https://rr1.googlevideo.com/videoplayback', duration: 1 }), stderr: '' };
    permanentAttempts += 1;
    return { code: 1, stdout: '', stderr: 'ERROR: [youtube] abc: Sign in to confirm you’re not a bot' };
  } });
  await assert.rejects(makeService(blocked, { fetchUpstream: async () => ({ status: 403, headers: {}, body: null }) }).prepare(ID), /sign-in/i);
  assert.equal(permanentAttempts, 1);
});

test('the direct-stream failure memory expires so one bad patch does not slow the whole session', async () => {
  let clock = 1_000_000_000_000;
  const upstream = await startUpstream();
  try {
    upstream.state.reject = true;
    const service = makeService(fakeTools(upstream.url), { fetchUpstream: streamUpstream, now: () => clock });
    await service.prepare('aaaaaaaaaaa'); await service.prepare('bbbbbbbbbbb');
    const hits = upstream.state.ranges.length;
    await service.prepare('ccccccccccc');
    assert.equal(upstream.state.ranges.length, hits, 'suspended: straight to the download');
    clock += 11 * 60 * 1000; upstream.state.reject = false;
    await service.prepare('ddddddddddd');
    assert.ok(upstream.state.ranges.length > hits, 'after the suspension the direct stream is tried again');
  } finally { upstream.server.close(); }
});

test('warm resolves without probing or downloading', async () => {
  const tools = fakeTools('https://rr1.googlevideo.com/videoplayback');
  let probes = 0;
  const service = makeService(tools, { fetchUpstream: async () => { probes += 1; return { status: 206, headers: {}, body: null }; } });
  assert.equal(await service.warm(`https://www.youtube.com/watch?v=${ID}`), true);
  assert.equal(await service.warm('https://example.com/x'), false);
  assert.equal(probes, 0);
  assert.equal(tools.calls.length, 1);
  await service.prepare(ID);
  assert.equal(tools.calls.length, 1, 'prepare reuses the warmed lookup');
});
