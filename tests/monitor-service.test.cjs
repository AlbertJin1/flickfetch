'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MonitorService, APPLY_UPDATE_SCRIPT, APP_ID, DEFAULT_GATEWAY, sha256, randomId, buildContentDefinedChunks, parseDeltaPayload, getOsLabel, compareVersions } = require('../electron/services/monitor-service.cjs');
const { monitorApiUrlCandidates, isMonitorApiUrl } = require('../electron/services/monitor-api.cjs');

function makeDelta(chunks) {
  const records = [Buffer.from('PSDDELTA'), Buffer.alloc(4)];
  records[1].writeUInt32LE(chunks.length, 0);
  for (const chunk of chunks) {
    const compressed = zlib.deflateRawSync(chunk);
    const head = Buffer.alloc(40);
    Buffer.from(sha256(chunk), 'hex').copy(head, 0);
    head.writeUInt32LE(chunk.length, 32);
    head.writeUInt32LE(compressed.length, 36);
    records.push(head, compressed);
  }
  return Buffer.concat(records);
}

test('FlickFetch monitor identity is app-scoped and does not contain a client API key', () => {
  assert.equal(APP_ID, 'flickfetch');
  assert.match(DEFAULT_GATEWAY, /^https:\/\//);
  assert.match(randomId(), /^[a-f0-9]{32}$/);
  assert.equal(sha256(Buffer.from('test')), '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
});

test('client gateway routes update requests with the FlickFetch app id', () => {
  const service = new MonitorService({ app: {}, appVersion: '2.1.1', userDataPath: os.tmpdir(), packaged: true });
  const url = service.gatewayUrl('update', { action: 'latest', app: APP_ID, version: '2.1.1' });
  assert.equal(url.searchParams.get('resource'), 'update');
  assert.equal(url.searchParams.get('app_id'), 'flickfetch');
  assert.equal(url.searchParams.get('app'), 'flickfetch');
  assert.equal(url.searchParams.get('version'), '2.1.1');
  assert.equal(service.compareVersions('2.10.0', '2.9.9'), 1);
  assert.equal(service.compareVersions('2.1.1', '2.1.1'), 0);
});

test('FlickFetch updater gateway always overrides conflicting app aliases with its own app_id', () => {
  const service = new MonitorService({ app: {}, appVersion: '2.1.1', userDataPath: os.tmpdir(), packaged: true });
  const url = service.gatewayUrl('update', { action: 'latest', app: 'pdfstudio', app_id: 'pdfstudio' });
  assert.equal(url.searchParams.get('app_id'), 'flickfetch');
  assert.equal(url.searchParams.get('app'), 'flickfetch');
});

test('installation id remains stable across launches', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-monitor-test-'));
  try {
    const first = new MonitorService({ app: {}, appVersion: '2.1.1', userDataPath: directory, packaged: false });
    await first.initialize();
    const id = first.installId;
    const second = new MonitorService({ app: {}, appVersion: '2.1.1', userDataPath: directory, packaged: false });
    await second.initialize();
    assert.equal(second.installId, id);
    assert.match(id, /^[a-f0-9]{32}$/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});


function withFetch(handler, run) {
  const original = global.fetch;
  global.fetch = handler;
  return Promise.resolve().then(run).finally(() => { global.fetch = original; });
}
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from(`enc:${text}`),
  decryptString: buffer => buffer.toString().replace(/^enc:/, '')
};

test('successful session open adopts and persists the monitor canonical installation id', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-canonical-id-'));
  try {
    const service = new MonitorService({ app: {}, appVersion: '2.1.1', userDataPath: directory, packaged: true });
    service.installId = 'b'.repeat(32);
    service.started = true;
    fs.writeFileSync(path.join(directory, 'monitor-state.json'), JSON.stringify({ install_id: service.installId, created_at: '2026-01-01T00:00:00.000Z' }));
    const canonicalId = 'a'.repeat(32);
    let body;
    await withFetch(async (url, options) => { body = JSON.parse(options.body); return jsonResponse(200, { ok: true, install_id: canonicalId }); }, async () => {
      const response = await service.postTelemetry('open');
      assert.equal(response.ok, true);
    });
    assert.equal(body.app_id, 'flickfetch');
    assert.equal(body.app, 'flickfetch');
    assert.equal(body.event, 'open');
    assert.match(body.session_id, /^[a-f0-9]{32}$/);
    assert.equal(service.installId, canonicalId);
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'monitor-state.json'), 'utf8'));
    assert.equal(saved.install_id, canonicalId);
    assert.ok(saved.created_at);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('OS label and version comparison match PDF Studio behaviour', () => {
  assert.match(getOsLabel(), /\((x64|x86|arm64|\w+)\)$/);
  assert.equal(compareVersions('2.1.1', '2.1.1-beta.1'), 1);
  assert.equal(compareVersions('v2.2', '2.1.9'), 1);
  assert.throws(() => compareVersions('nope', '1.0.0'), /Invalid release version/);
});

test('monitor URL fallback maps /api to /public/api on the trusted host only', () => {
  const [first, second] = monitorApiUrlCandidates('https://pdfstudio.shares.zrok.io/pdfstudio-monitor/api/client-gateway.php?resource=telemetry');
  assert.equal(first.pathname, '/pdfstudio-monitor/api/client-gateway.php');
  assert.equal(second.pathname, '/pdfstudio-monitor/public/api/client-gateway.php');
  assert.equal(second.searchParams.get('resource'), 'telemetry');
  assert.equal(monitorApiUrlCandidates('https://evil.example/pdfstudio-monitor/api/x').length, 1);
  assert.equal(isMonitorApiUrl('http://pdfstudio.shares.zrok.io/pdfstudio-monitor/api/x'), false);
});

test('telemetry falls back to the direct-public gateway path when the first route is blocked', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-fallback-'));
  try {
    const service = new MonitorService({ app: {}, appVersion: '2.1.1', userDataPath: directory, packaged: true });
    service.installId = 'c'.repeat(32);
    const seen = [];
    await withFetch(async url => { seen.push(new URL(url).pathname); return seen.length === 1 ? jsonResponse(404, { ok: false, error: 'nope' }) : jsonResponse(200, { ok: true, install_id: 'c'.repeat(32) }); }, async () => {
      const result = await service.postUsage({ event: 'heartbeat', app: 'flickfetch' });
      assert.equal(result.status, 'delivered');
    });
    assert.deepEqual(seen, ['/pdfstudio-monitor/api/client-gateway.php', '/pdfstudio-monitor/public/api/client-gateway.php']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('events that cannot be delivered are queued durably and flushed later', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-queue-'));
  try {
    const service = new MonitorService({ app: {}, appVersion: '2.1.1', userDataPath: directory, packaged: true });
    service.installId = 'd'.repeat(32);
    service.started = true;
    await withFetch(async () => { throw new Error('offline'); }, async () => {
      const result = await service.sendUsage(service.sessionPayload('heartbeat'));
      assert.equal(result.status, 'retry');
    });
    assert.equal((await service.readUsageQueue()).length, 1);
    const delivered = [];
    await withFetch(async (url, options) => { delivered.push(JSON.parse(options.body).event); return jsonResponse(200, { ok: true, install_id: 'd'.repeat(32) }); }, async () => {
      await service.sendUsage(service.sessionPayload('close'));
    });
    assert.deepEqual(delivered.sort(), ['close', 'heartbeat']);
    assert.equal((await service.readUsageQueue()).length, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a gateway 4xx rejection is dropped from the queue instead of retried forever', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-reject-'));
  try {
    const service = new MonitorService({ app: {}, appVersion: '2.1.1', userDataPath: directory, packaged: true });
    service.installId = 'e'.repeat(32);
    service.started = true;
    await service.writeUsageQueue([service.sessionPayload('open')]);
    await withFetch(async () => jsonResponse(400, { ok: false, error: 'Invalid install id.' }), async () => { await service.flushUsageQueue(); });
    assert.equal((await service.readUsageQueue()).length, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('reviews are saved in the encrypted outbox, sent with the FlickFetch app id, and cleared once acknowledged', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-review-outbox-'));
  try {
    const service = new MonitorService({ app: {}, appVersion: '2.1.1', userDataPath: directory, packaged: true, safeStorage: fakeSafeStorage });
    service.installId = 'f'.repeat(32);
    service.started = true;
    // Monitor unreachable: the review stays queued (and is never stored in plaintext).
    await withFetch(async () => { throw new Error('offline'); }, async () => {
      const result = await service.submitReview({ rating: 5, name: '', message: 'Great app' });
      assert.equal(result.queued, true);
      assert.equal(result.delivered, false);
    });
    const stored = fs.readFileSync(path.join(directory, 'review-outbox.enc'), 'utf8');
    assert.ok(!stored.includes('Great app'));
    assert.equal((await service.loadReviewState()).reviewStatus, 'pending');
    // A second review while one is pending does not overwrite it.
    let sent;
    await withFetch(async (url, options) => { sent = JSON.parse(options.body); return jsonResponse(200, { ok: true, install_id: 'f'.repeat(32) }); }, async () => {
      const again = await service.submitReview({ rating: 1, message: 'other' });
      assert.equal(again.alreadyQueued, true);
      assert.equal(again.delivered, true);
    });
    assert.equal(sent.event, 'review');
    assert.equal(sent.app_id, 'flickfetch');
    assert.equal(sent.app, 'flickfetch');
    assert.equal(sent.rating, 5);
    assert.equal(sent.message, 'Great app');
    assert.equal(sent.name, service.identity.hostname);
    const state = await service.loadReviewState();
    assert.equal(state.reviewStatus, 'submitted');
    assert.equal((await service.readReviewOutbox()).length, 0);
    assert.equal((await service.maybePromptReview()).shouldPrompt, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the automatic review prompt waits for 30 minutes of use and honours "never ask again"', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-review-prompt-'));
  try {
    const service = new MonitorService({ app: {}, appVersion: '2.1.1', userDataPath: directory, packaged: true, safeStorage: fakeSafeStorage });
    service.installId = '1'.repeat(32);
    service.started = true;
    const early = await service.maybePromptReview();
    assert.equal(early.shouldPrompt, false);
    assert.ok(early.nextCheckAfterMs >= 60_000);
    const state = await service.loadReviewState();
    state.totalUsageSeconds = 31 * 60;
    await service.deferReview('never');
    const later = await service.maybePromptReview();
    assert.equal(later.shouldPrompt, false);
    assert.equal(later.stopChecking, true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('update metadata is validated and requests carry the FlickFetch app id', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-update-meta-'));
  try {
    const service = new MonitorService({ app: {}, appVersion: '2.1.1', userDataPath: directory, packaged: true, platform: 'win32' });
    service.isPortable = true;
    service.installId = '2'.repeat(32);
    const hash = 'ab'.repeat(32);
    let requested;
    await withFetch(async url => { requested = new URL(url); return jsonResponse(200, { ok: true, update_available: true, status: 'update_available',
      latest: { version: '2.2.0', notes: 'New', size: 1000, sha256: hash, package: { format: 'zip', size: 500, sha256: 'cd'.repeat(32), entry: 'FlickFetch.exe' },
        delta: { format: 'psd-chunks-v1', manifest_size: 10, manifest_sha256: 'ef'.repeat(32) } } }); }, async () => {
      const result = await service.checkForUpdates({ force: true });
      assert.equal(result.updateAvailable, true);
      assert.equal(result.latestVersion, '2.2.0');
      assert.equal(result.package.entry, 'FlickFetch.exe');
      assert.equal(result.delta.manifest_sha256, 'ef'.repeat(32));
    });
    assert.equal(requested.searchParams.get('app'), 'flickfetch');
    assert.equal(requested.searchParams.get('action'), 'latest');
    assert.equal(requested.searchParams.get('install_id'), '2'.repeat(32));
    await withFetch(async () => jsonResponse(200, { ok: true, update_available: true, latest: { version: '2.3.0', size: 10, sha256: 'bad' } }), async () => {
      await assert.rejects(service.checkForUpdates({ force: true }), /valid SHA-256/);
    });
    assert.throws(() => service.assertGatewayUrl('https://evil.example/pdfstudio-monitor/api/client-gateway.php?resource=update&action=download', 'download'), /not a valid FlickFetch Monitor/);
    assert.doesNotThrow(() => service.assertGatewayUrl(service.gatewayUrl('update', { action: 'download', app: 'flickfetch', version: '2.2.0', format: 'zip' }), 'download'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('content-defined chunks cover the original bytes and are deterministic', () => {
  const source = crypto.randomBytes(3 * 1024 * 1024 + 137);
  const chunks = buildContentDefinedChunks(source);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.size, 0), source.length);
  let offset = 0;
  for (const chunk of chunks) {
    assert.equal(chunk.offset, offset);
    assert.equal(chunk.data.length, chunk.size);
    assert.equal(chunk.sha256, sha256(chunk.data));
    offset += chunk.size;
  }
  const repeat = buildContentDefinedChunks(source);
  assert.deepEqual(chunks.map(({ offset, size, sha256 }) => ({ offset, size, sha256 })), repeat.map(({ offset, size, sha256 }) => ({ offset, size, sha256 })));
});

test('PSDDELTA payload parser verifies records and rejects corruption', () => {
  const content = [Buffer.from('small executable block'), crypto.randomBytes(1024)];
  const hashes = content.map(sha256);
  const parsed = parseDeltaPayload(makeDelta(content), hashes);
  assert.deepEqual([...parsed.keys()], hashes);
  content.forEach((chunk, index) => assert.deepEqual(parsed.get(hashes[index]), chunk));
  const broken = makeDelta(content);
  broken[broken.length - 1] ^= 0xff;
  assert.throws(() => parseDeltaPayload(broken, hashes), /integrity validation|inflate|unexpected|invalid/i);
});

test('development runs can check for updates but never install; packaged non-Windows builds cannot check', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-dev-check-'));
  try {
    const dev = new MonitorService({ app: {}, appVersion: '2.1.1', userDataPath: directory, packaged: false, platform: 'win32' });
    dev.installId = '3'.repeat(32);
    assert.equal(dev.updateMode, null);
    assert.equal(dev.canCheckUpdates, true);
    const hash = 'ab'.repeat(32);
    await withFetch(async () => jsonResponse(200, { ok: true, update_available: true, latest: { version: '2.2.0', notes: '- Faster', size: 1000, sha256: hash } }), async () => {
      const result = await dev.checkForUpdates({ force: true });
      assert.equal(result.supported, true);
      assert.equal(result.updateAvailable, true);
      assert.equal(result.releaseState, 'update_available');
      assert.equal(result.development, true);
      assert.equal(result.installMode, null);
      assert.ok(result.checkedAt > 0);
      await assert.rejects(dev.downloadAndInstallUpdate(), /packaged/i);
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  const linux = new MonitorService({ app: {}, appVersion: '2.1.1', userDataPath: os.tmpdir(), packaged: true, platform: 'linux' });
  assert.equal(linux.updateMode, null);
  const unsupported = await linux.checkForUpdates();
  assert.equal(unsupported.supported, false);
  assert.match(unsupported.message, /Windows/i);
});

test('a build newer than the latest release is reported as ahead (unreleased), and an equal one as current', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-ahead-'));
  try {
    const service = new MonitorService({ app: {}, appVersion: '2.2.0', userDataPath: directory, packaged: false, platform: 'win32' });
    service.installId = '4'.repeat(32);
    const respond = version => async () => jsonResponse(200, { ok: true, update_available: false, latest: { version, size: 1000, sha256: 'ab'.repeat(32) } });
    await withFetch(respond('2.1.1'), async () => {
      const ahead = await service.checkForUpdates({ force: true });
      assert.equal(ahead.updateAvailable, false);
      assert.equal(ahead.releaseState, 'ahead');
      assert.equal(ahead.latestVersion, '2.1.1');
      assert.match(ahead.message, /newer than the latest published release/);
    });
    await withFetch(respond('2.2.0'), async () => {
      assert.equal((await service.checkForUpdates({ force: true })).releaseState, 'current');
    });
    await withFetch(async () => jsonResponse(200, { ok: true, update_available: false }), async () => {
      assert.equal((await service.checkForUpdates({ force: true })).releaseState, 'no_release');
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('update mode is install for the portable exe and download for installed builds', () => {
  const installed = new MonitorService({ app: {}, appVersion: '2.1.1', userDataPath: os.tmpdir(), packaged: true, platform: 'win32' });
  installed.isPortable = false;
  assert.equal(installed.updateMode, 'download');
  installed.isPortable = true;
  assert.equal(installed.updateMode, 'install');
});

test('installed builds download, verify and save the update without touching the running exe', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-update-dl-'));
  try {
    const downloads = path.join(directory, 'Downloads');
    const exe = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(4096)]);
    const hash = sha256(exe);
    const progress = [];
    const service = new MonitorService({ app: { getPath: name => (name === 'downloads' ? downloads : directory) }, appVersion: '2.1.1', userDataPath: directory, packaged: true, platform: 'win32', emit: (channel, payload) => { if (channel === 'updater:progress') progress.push(payload); } });
    service.isPortable = false;
    service.installId = '3'.repeat(32);
    let downloadRequests = 0;
    const handler = async url => {
      const request = new URL(url);
      if (request.searchParams.get('action') === 'latest') return jsonResponse(200, { ok: true, update_available: true, latest: { version: '2.2.0', notes: 'New', size: exe.length, sha256: hash } });
      downloadRequests += 1;
      return new Response(exe, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(exe.length) } });
    };
    await withFetch(handler, async () => {
      const result = await service.downloadAndInstallUpdate();
      assert.equal(result.downloaded, true);
      assert.equal(result.restarting, false);
      assert.equal(path.dirname(result.filePath), path.join(downloads, 'FlickFetch Updates'));
      assert.equal(path.basename(result.filePath), 'FlickFetch-2.2.0-x64-Portable.exe');
      assert.equal(sha256(fs.readFileSync(result.filePath)), hash);
      assert.deepEqual(fs.readdirSync(path.dirname(result.filePath)).filter(name => name.endsWith('.part')), []);
      assert.equal(progress.at(-1).phase, 'saved');
      // A second request reuses the verified file instead of downloading it again.
      const again = await service.downloadAndInstallUpdate();
      assert.equal(again.reused, true);
      assert.equal(again.filePath, result.filePath);
      assert.equal(downloadRequests, 1);
      // A different file already using the name is never overwritten.
      fs.writeFileSync(result.filePath, 'something else');
      const third = await service.downloadAndInstallUpdate();
      assert.notEqual(third.filePath, result.filePath);
      assert.match(path.basename(third.filePath), /\(1\)\.exe$/);
      assert.equal(fs.readFileSync(result.filePath, 'utf8'), 'something else');
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a corrupted update download is rejected and nothing is saved', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-update-bad-'));
  try {
    const downloads = path.join(directory, 'Downloads');
    const exe = crypto.randomBytes(2048);
    const service = new MonitorService({ app: { getPath: () => downloads }, appVersion: '2.1.1', userDataPath: directory, packaged: true, platform: 'win32' });
    service.isPortable = false;
    service.installId = '4'.repeat(32);
    const handler = async url => {
      if (new URL(url).searchParams.get('action') === 'latest') return jsonResponse(200, { ok: true, update_available: true, latest: { version: '2.2.0', size: exe.length, sha256: sha256(exe) } });
      const tampered = Buffer.from(exe); tampered[10] ^= 0xff;
      return new Response(tampered, { status: 200, headers: { 'content-length': String(tampered.length) } });
    };
    await withFetch(handler, async () => {
      await assert.rejects(service.downloadAndInstallUpdate(), /SHA-256 integrity check/);
    });
    const saved = fs.existsSync(path.join(downloads, 'FlickFetch Updates')) ? fs.readdirSync(path.join(downloads, 'FlickFetch Updates')) : [];
    assert.deepEqual(saved, []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the portable update helper finds the running exe by path so a renamed exe is replaced in place', () => {
  assert.doesNotMatch(APPLY_UPDATE_SCRIPT, /Get-Process\s+-Name/);
  assert.match(APPLY_UPDATE_SCRIPT, /\$_\.Path/);
  // The new build is moved onto the same $target path (keeping its name), the old exe is deleted, and the script removes itself.
  assert.match(APPLY_UPDATE_SCRIPT, /Move-Item -LiteralPath \$staged -Destination \$target/);
  assert.match(APPLY_UPDATE_SCRIPT, /Remove-Item -LiteralPath \$backup/);
  assert.match(APPLY_UPDATE_SCRIPT, /Remove-Item -LiteralPath \$PSCommandPath/);
});

test('cleanup removes the old portable exe backup for a renamed exe and keeps the running exe', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-cleanup-'));
  const previous = process.env.PORTABLE_EXECUTABLE_FILE;
  try {
    const exe = path.join(directory, 'My Downloader.exe');
    process.env.PORTABLE_EXECUTABLE_FILE = exe;
    const service = new MonitorService({ app: { getPath: () => path.join(directory, 'Downloads') }, appVersion: '2.2.0', userDataPath: path.join(directory, 'data'), packaged: true, platform: 'win32' });
    assert.equal(service.updateMode, 'install');
    fs.mkdirSync(path.join(directory, 'data', 'updates'), { recursive: true });
    fs.writeFileSync(exe, 'new');
    fs.writeFileSync(`${exe}.ff-backup`, 'old');
    fs.writeFileSync(path.join(directory, '.FlickFetch.update-abc123.exe'), 'staged');
    fs.writeFileSync(path.join(directory, 'notes.txt'), 'keep');
    const old = path.join(directory, 'data', 'updates', 'old.exe');
    fs.writeFileSync(old, 'x'); fs.utimesSync(old, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    service.runUpdateCleanup();
    assert.equal(fs.readFileSync(exe, 'utf8'), 'new');
    assert.equal(fs.existsSync(`${exe}.ff-backup`), false);
    assert.equal(fs.existsSync(path.join(directory, '.FlickFetch.update-abc123.exe')), false);
    assert.equal(fs.existsSync(path.join(directory, 'notes.txt')), true);
    assert.equal(fs.existsSync(old), false);
  } finally {
    if (previous === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE; else process.env.PORTABLE_EXECUTABLE_FILE = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('cleanup deletes older downloaded releases and partial files but keeps newer ones', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-cleanup-dl-'));
  try {
    const downloads = path.join(directory, 'Downloads');
    const folder = path.join(downloads, 'FlickFetch Updates');
    fs.mkdirSync(folder, { recursive: true });
    const names = ['FlickFetch-2.1.0-x64-Portable.exe', 'FlickFetch-2.2.0-x64-Portable.exe', 'FlickFetch-2.2.0-x64-Portable (1).exe', 'FlickFetch-2.3.0-x64-Portable.exe', 'FlickFetch-2.4.0-x64-Portable.exe.part', 'unrelated.exe'];
    for (const name of names) fs.writeFileSync(path.join(folder, name), 'x');
    const service = new MonitorService({ app: { getPath: () => downloads }, appVersion: '2.2.0', userDataPath: path.join(directory, 'data'), packaged: true, platform: 'win32' });
    service.isPortable = false;
    service.runUpdateCleanup();
    assert.deepEqual(fs.readdirSync(folder).sort(), ['FlickFetch-2.3.0-x64-Portable.exe', 'unrelated.exe']);
    // The exe that is currently running from this folder is never deleted.
    service.targetExecutable = path.join(folder, 'FlickFetch-2.3.0-x64-Portable.exe');
    service.appVersion = '2.3.0';
    service.runUpdateCleanup();
    assert.equal(fs.existsSync(path.join(folder, 'FlickFetch-2.3.0-x64-Portable.exe')), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the portable update stops early when its folder is not writable', () => {
  const service = new MonitorService({ app: {}, appVersion: '2.1.1', userDataPath: os.tmpdir(), packaged: true, platform: 'win32' });
  assert.doesNotThrow(() => service.assertWritableDirectory(os.tmpdir()));
  assert.throws(() => service.assertWritableDirectory(path.join(os.tmpdir(), 'flickfetch-missing-dir-xyz')), /not writable/);
});

test('review submission is not sent by an unpackaged development build', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-review-test-'));
  try {
    const service = new MonitorService({ app: {}, appVersion: '2.1.1', userDataPath: directory, packaged: false });
    await service.initialize();
    await assert.rejects(service.submitReview({ rating: 5 }), /packaged FlickFetch build/i);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

// ───────── differential updates ─────────
function differentialFixture() {
  // A stored (uncompressed) portable exe: unchanged "files" stay byte-identical, so their blocks can be reused.
  const files = [0, 1, 2, 3].map(() => crypto.randomBytes(1_500_000));
  const header = Buffer.from('MZ-portable-header-v1');
  const oldExe = Buffer.concat([header, ...files]);
  const changed = Buffer.from(files[2]);
  crypto.randomBytes(180_000).copy(changed, 600_000);            // one region of one file changed
  const added = crypto.randomBytes(120_000);                      // and a new file appeared in the middle
  const newExe = Buffer.concat([Buffer.from('MZ-portable-header-v2-longer'), files[0], files[1], added, changed, files[3]]);
  return { oldExe, newExe };
}

function differentialUpdate(newExe, version = '2.2.0') {
  const chunks = buildContentDefinedChunks(newExe);
  const manifest = Buffer.from(JSON.stringify({ format: 'psd-chunks-v1', version, size: newExe.length, sha256: sha256(newExe),
    chunks: chunks.map(c => ({ offset: c.offset, size: c.size, sha256: c.sha256 })) }));
  const update = { latestVersion: version, size: newExe.length, sha256: sha256(newExe), package: null,
    delta: { format: 'psd-chunks-v1', manifest_size: manifest.length, manifest_sha256: sha256(manifest) } };
  const byHash = new Map(chunks.map(c => [c.sha256, Buffer.from(c.data)]));
  return { update, manifest, byHash };
}

test('differential update downloads only the changed blocks and rebuilds the exact exe', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-delta-'));
  try {
    const { oldExe, newExe } = differentialFixture();
    const oldPath = path.join(directory, 'FlickFetch.exe');
    fs.writeFileSync(oldPath, oldExe);
    const { update, manifest, byHash } = differentialUpdate(newExe);
    const service = new MonitorService({ app: {}, appVersion: '2.1.1', userDataPath: directory, packaged: true, platform: 'win32' });
    const phases = [];
    service.emit = (name, payload) => { if (name === 'updater:progress') phases.push(payload); };
    let requestedChunks = 0; let fullDownloads = 0;
    await withFetch(async (url, options = {}) => {
      const action = new URL(url).searchParams.get('action');
      if (action === 'manifest') return new Response(manifest, { status: 200, headers: { 'content-type': 'application/json' } });
      if (action === 'delta') {
        const wanted = JSON.parse(options.body).chunks;
        requestedChunks = wanted.length;
        return new Response(makeDelta(wanted.map(hash => byHash.get(hash))), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      }
      fullDownloads += 1;
      return new Response(newExe, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    }, async () => {
      const result = await service.fetchVerifiedExecutable(update, { basePaths: [oldPath] });
      assert.equal(result.method, 'delta');
      assert.equal(fullDownloads, 0);
      assert.equal(sha256(result.executable), sha256(newExe));
      assert.ok(result.transfer.reusedBytes > newExe.length * 0.5, `reused ${result.transfer.reusedBytes}`);
      assert.ok(result.transfer.downloadedBytes < newExe.length * 0.45, `downloaded ${result.transfer.downloadedBytes} of ${newExe.length}`);
      assert.ok(requestedChunks > 0 && requestedChunks < result.transfer.totalBlocks * 0.6);
    });
    assert.ok(phases.some(p => p.phase === 'differential' && p.totalChunks > 0));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a build that shares nothing with the installed files falls back to a verified full download', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-delta-fallback-'));
  try {
    const { newExe } = differentialFixture();
    const unrelated = path.join(directory, 'FlickFetch.exe');
    fs.writeFileSync(unrelated, crypto.randomBytes(2_000_000)); // e.g. an exe built with compression: the bytes share no blocks
    const { update, manifest } = differentialUpdate(newExe);
    const service = new MonitorService({ app: {}, appVersion: '2.1.1', userDataPath: directory, packaged: true, platform: 'win32' });
    service.emit = () => {};
    let deltaRequested = false;
    await withFetch(async url => {
      const action = new URL(url).searchParams.get('action');
      if (action === 'manifest') return new Response(manifest, { status: 200, headers: { 'content-type': 'application/json' } });
      if (action === 'delta') { deltaRequested = true; return new Response('', { status: 500 }); }
      return new Response(newExe, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    }, async () => {
      const result = await service.fetchVerifiedExecutable(update, { basePaths: [unrelated] });
      assert.equal(result.method, 'full');
      assert.equal(sha256(result.executable), sha256(newExe));
    });
    assert.equal(deltaRequested, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('installed builds use their program files and earlier saved releases as the reuse pool', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-bases-'));
  try {
    const install = path.join(directory, 'FlickFetch');
    fs.mkdirSync(path.join(install, 'resources'), { recursive: true });
    const big = Buffer.alloc(200_000, 7);
    fs.writeFileSync(path.join(install, 'FlickFetch.exe'), big);
    fs.writeFileSync(path.join(install, 'resources', 'app.asar'), big);
    fs.writeFileSync(path.join(install, 'Uninstall FlickFetch.exe'), big);
    fs.writeFileSync(path.join(install, 'readme.txt'), big);
    fs.writeFileSync(path.join(install, 'tiny.dll'), Buffer.alloc(100));
    const downloads = path.join(directory, 'dl');
    fs.mkdirSync(downloads);
    fs.writeFileSync(path.join(downloads, 'FlickFetch-2.1.1-x64-Portable.exe'), big);
    const service = new MonitorService({ app: {}, appVersion: '2.1.1', userDataPath: directory, packaged: true, platform: 'win32' });
    service.targetExecutable = path.join(install, 'FlickFetch.exe');
    service.updateDownloadDir = () => downloads;
    const names = service.differentialBasePaths('download').map(file => path.relative(directory, file).replace(/\\/g, '/')).sort();
    assert.deepEqual(names, ['FlickFetch/FlickFetch.exe', 'FlickFetch/resources/app.asar', 'dl/FlickFetch-2.1.1-x64-Portable.exe']);
    service.isPortable = true;
    assert.deepEqual(service.differentialBasePaths('install'), [path.resolve(service.targetExecutable)]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the update helper proves it started, restores the old exe on failure and falls back to a visible copy', () => {
  assert.match(APPLY_UPDATE_SCRIPT, /Write-Log 'helper started'/);
  // Failure path: put the old exe back, then start the verified new build from the visible fallback folder.
  assert.match(APPLY_UPDATE_SCRIPT, /Move-Item -LiteralPath \$backup -Destination \$target/);
  assert.match(APPLY_UPDATE_SCRIPT, /\$FallbackDir/);
  assert.match(APPLY_UPDATE_SCRIPT, /Write-Result 'fallback'/);
  assert.match(APPLY_UPDATE_SCRIPT, /Write-Result 'failed'/);
  // The old exe is only deleted after the new one was started and stayed open.
  assert.ok(APPLY_UPDATE_SCRIPT.indexOf('Start-AndConfirm $target') < APPLY_UPDATE_SCRIPT.indexOf('if ($succeeded)'));
  // Windows PowerShell 5.1 reads a BOM-less script as ANSI, so it must stay ASCII.
  assert.doesNotMatch(APPLY_UPDATE_SCRIPT, /[^\x00-\x7F]/);
});

test('waitForUpdateHelper only reports success once the helper wrote its first log line', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-helper-'));
  try {
    const service = new MonitorService({ app: {}, appVersion: '2.2.0', userDataPath: directory, packaged: true, platform: 'win32' });
    const log = path.join(directory, 'apply-update.log');
    assert.equal(await service.waitForUpdateHelper(log, () => null, 300), false);
    assert.equal(await service.waitForUpdateHelper(log, () => new Error('spawn failed'), 300), false);
    setTimeout(() => fs.writeFileSync(log, '[now] helper started\n'), 100);
    assert.equal(await service.waitForUpdateHelper(log, () => null, 2000), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('consumeUpdateResult returns the helper note once, then nothing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-result-'));
  try {
    const service = new MonitorService({ app: {}, appVersion: '2.2.0', userDataPath: directory, packaged: true, platform: 'win32' });
    assert.equal(service.consumeUpdateResult(), null);
    fs.writeFileSync(service.updateResultFile, JSON.stringify({ status: 'fallback', version: '2.3.0', message: 'moved', newPath: 'C:\\Downloads\\x.exe', oldPath: 'C:\\old.exe' }));
    assert.deepEqual(service.consumeUpdateResult(), { status: 'fallback', version: '2.3.0', message: 'moved', newPath: 'C:\\Downloads\\x.exe', oldPath: 'C:\\old.exe' });
    assert.equal(service.consumeUpdateResult(), null);
    fs.writeFileSync(service.updateResultFile, '\uFEFF{"status":"bogus"}');
    assert.equal(service.consumeUpdateResult(), null);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('cleanup keeps the only copy of an unapplied release for a week', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-keep-'));
  const previous = process.env.PORTABLE_EXECUTABLE_FILE;
  try {
    process.env.PORTABLE_EXECUTABLE_FILE = path.join(directory, 'FlickFetch.exe');
    fs.writeFileSync(process.env.PORTABLE_EXECUTABLE_FILE, 'x');
    const service = new MonitorService({ app: { getPath: () => path.join(directory, 'Downloads') }, appVersion: '2.2.0', userDataPath: path.join(directory, 'data'), packaged: true, platform: 'win32' });
    const stage = path.join(directory, 'data', 'updates');
    fs.mkdirSync(stage, { recursive: true });
    const hourAgo = new Date(Date.now() - 3_600_000);
    const stale = path.join(stage, 'FlickFetch-2.3.0-abc.exe');
    const kept = path.join(stage, 'keep-FlickFetch-2.3.0-x64-Portable.exe');
    for (const file of [stale, kept]) { fs.writeFileSync(file, 'x'); fs.utimesSync(file, hourAgo, hourAgo); }
    service.runUpdateCleanup();
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(kept), true);
  } finally {
    if (previous === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE; else process.env.PORTABLE_EXECUTABLE_FILE = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
