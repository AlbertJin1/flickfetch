'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const swap = require('../electron/services/update-swap.cjs');

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const noSleep = () => Promise.resolve();
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flickfetch-swap-'));

test('the helper keeps the exact file name: old exe -> .old, new build at the original name, then both leftovers are removed', async () => {
  const dir = fresh();
  try {
    const exe = path.join(dir, 'My Downloader.exe');
    fs.writeFileSync(exe, 'old-build');
    const staged = `${exe}.new`; fs.writeFileSync(staged, 'new-build');
    const helper = await swap.prepareHelper({ target: exe, stagedPath: staged, sha256: sha('new-build') });
    assert.equal(helper, path.join(dir, 'My Downloader.updating.exe'));
    assert.equal(fs.readFileSync(exe, 'utf8'), 'old-build', 'nothing is touched while the old app is still running');
    // The old app is still closing: the first renames are refused, then they succeed.
    const realRename = fs.promises.rename; let busy = 3; const launched = [];
    fs.promises.rename = async (a, b) => { if (a === exe && busy-- > 0) { const e = new Error('locked'); e.code = 'EBUSY'; throw e; } return realRename(a, b); };
    let result;
    try { result = await swap.runHelperSwap({ target: exe, source: helper, launch: async f => launched.push(f), sleep: noSleep }); } finally { fs.promises.rename = realRename; }
    assert.equal(result.ok, true);
    assert.deepEqual(launched, [exe], 'the new build is opened under the original name');
    assert.equal(fs.readFileSync(exe, 'utf8'), 'new-build');
    assert.equal(fs.readFileSync(`${exe}.old`, 'utf8'), 'old-build');
    const cleaned = await swap.cleanupLeftovers({ target: exe, sleep: noSleep });
    assert.equal(cleaned.pending, false);
    assert.deepEqual(fs.readdirSync(dir).filter(n => n !== path.basename(staged)).sort(), ['My Downloader.exe']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a wrong checksum is refused before anything is started, and a helper that never gets the file gives up without touching it', async () => {
  const dir = fresh();
  try {
    const exe = path.join(dir, 'FlickFetch.exe'); fs.writeFileSync(exe, 'old-build');
    const staged = `${exe}.new`; fs.writeFileSync(staged, 'new-build');
    await assert.rejects(swap.prepareHelper({ target: exe, stagedPath: staged, sha256: 'f'.repeat(64) }));
    assert.equal(fs.existsSync(swap.helperPathFor(exe)), false);
    const helper = await swap.prepareHelper({ target: exe, stagedPath: staged, sha256: sha('new-build') });
    const realRename = fs.promises.rename; let t = 0;
    fs.promises.rename = async (a, b) => { if (a === exe) { const e = new Error('locked'); e.code = 'EBUSY'; throw e; } return realRename(a, b); };
    let result;
    try { result = await swap.runHelperSwap({ target: exe, source: helper, launch: async () => { throw new Error('must not start'); }, sleep: noSleep, now: () => (t += 100_000), timeoutMs: 250_000 }); } finally { fs.promises.rename = realRename; }
    assert.equal(result.ok, false); assert.equal(result.reason, 'timeout');
    assert.equal(fs.readFileSync(exe, 'utf8'), 'old-build');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('if the new build cannot be copied into place the old exe is restored and reopened', async () => {
  const dir = fresh();
  try {
    const exe = path.join(dir, 'FlickFetch.exe'); fs.writeFileSync(exe, 'old-build');
    const staged = `${exe}.new`; fs.writeFileSync(staged, 'new-build');
    const helper = await swap.prepareHelper({ target: exe, stagedPath: staged, sha256: sha('new-build') });
    const launched = [];
    const result = await swap.runHelperSwap({ target: exe, source: helper, launch: async f => launched.push(f), sleep: noSleep, hash: async file => (file === exe ? 'different' : 'same') });
    assert.equal(result.ok, false); assert.equal(result.reason, 'copy-failed');
    assert.equal(fs.readFileSync(exe, 'utf8'), 'old-build', 'the previous exe is back under its name');
    assert.equal(fs.existsSync(`${exe}.old`), false);
    assert.deepEqual(launched, [exe]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('safety: only the matching temp name is accepted as helper, and cleanup never removes the running exe', async () => {
  const dir = fresh();
  try {
    const exe = path.join(dir, 'FlickFetch.exe'); fs.writeFileSync(exe, 'x');
    const other = path.join(dir, 'Other.exe'); fs.writeFileSync(other, 'y');
    const refused = await swap.runHelperSwap({ target: exe, source: other, launch: async () => {}, sleep: noSleep });
    assert.equal(refused.ok, false); assert.equal(fs.readFileSync(exe, 'utf8'), 'x');
    fs.writeFileSync(path.join(dir, 'notes.old'), 'keep');
    await swap.cleanupLeftovers({ target: exe, sleep: noSleep });
    assert.equal(fs.existsSync(exe), true); assert.equal(fs.existsSync(path.join(dir, 'notes.old')), true); assert.equal(fs.existsSync(other), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wiring: main.cjs has a helper mode and the updater tries the exe helper before the script helpers', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
  assert.match(main, /FLICKFETCH_FINISH_UPDATE_TARGET/);
  assert.match(main, /if \(FINISH_UPDATE_TARGET\) return runUpdateHelperMode\(\)/);
  const service = fs.readFileSync(path.join(__dirname, '..', 'electron', 'services', 'monitor-service.cjs'), 'utf8');
  assert.ok(service.indexOf('this.startExeHelper({') < service.indexOf('const attempts = ['), 'exe helper comes first');
});
