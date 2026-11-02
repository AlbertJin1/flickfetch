'use strict';
// Keeps FlickFetch on the SAME exe file name after every update (same method as PDF Studio):
//   1. the verified new build is copied beside the exe as "<name>.updating.exe" and started as a short-lived helper,
//   2. FlickFetch quits; the helper waits until "<name>.exe" is no longer in use (a running portable exe cannot be renamed),
//   3. the helper renames the old exe to "<name>.exe.old", copies itself to "<name>.exe", starts that and exits,
//   4. the new FlickFetch deletes "<name>.exe.old" and "<name>.updating.exe" as soon as they are free.
// If anything fails the old exe is restored and reopened. No scripts and no hidden shells are involved.

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const OLD_SUFFIX = '.old';
const HELPER_SUFFIX = '.updating.exe';
const BUSY = ['EBUSY', 'EPERM', 'EACCES'];
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sameFile = (a, b) => !!a && !!b && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

const oldPathFor = exePath => `${path.resolve(exePath)}${OLD_SUFFIX}`;
const helperPathFor = exePath => { const full = path.resolve(exePath); return path.join(path.dirname(full), `${path.basename(full, path.extname(full))}${HELPER_SUFFIX}`); };

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

/** Old-app side: copy the already verified staged build to "<name>.updating.exe" and re-check it. Returns the helper path. */
async function prepareHelper({ target, stagedPath, sha256 }) {
  if (!target || !path.isAbsolute(target) || path.extname(target).toLowerCase() !== '.exe') throw new Error('The current exe path is not usable for an update.');
  const helperPath = helperPathFor(target);
  await fsp.rm(helperPath, { force: true });
  try {
    await fsp.copyFile(stagedPath, helperPath);
    if ((await sha256File(helperPath)).toLowerCase() !== String(sha256).toLowerCase()) throw new Error('The copied update did not match its checksum.');
  } catch (error) { await fsp.rm(helperPath, { force: true }).catch(() => {}); throw error; }
  return helperPath;
}

/**
 * Helper side. `target` is the original exe path, `source` is the helper's own file. Never deletes anything except a stale
 * "<target>.old". On failure the previous exe is put back and started again. Returns { ok, reason }.
 */
async function runHelperSwap({ target, source, launch, log = () => {}, timeoutMs = 180_000, delayMs = 400, sleep = defaultSleep, now = () => Date.now(), hash = sha256File }) {
  if (!target || !source || !path.isAbsolute(target) || !path.isAbsolute(source)) return { ok: false, reason: 'bad-arguments' };
  if (path.extname(target).toLowerCase() !== '.exe' || !sameFile(source, helperPathFor(target))) return { ok: false, reason: 'unexpected-paths' };
  const oldPath = oldPathFor(target);
  const deadline = now() + timeoutMs;
  let renamed = false;
  for (;;) {
    try {
      await fsp.rm(oldPath, { force: true });
      try { await fsp.rename(target, oldPath); renamed = true; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      break;
    } catch (error) {
      if (!BUSY.includes(error?.code)) { log(`rename failed: ${error?.code || error?.message}`); return { ok: false, reason: 'rename-failed' }; }
      if (now() > deadline) { log('the previous version never closed; giving up'); return { ok: false, reason: 'timeout' }; }
      await sleep(delayMs);
    }
  }
  log(renamed ? `renamed ${path.basename(target)} -> ${path.basename(oldPath)}` : `${path.basename(target)} was already gone`);
  try {
    await fsp.copyFile(source, target);
    const [a, b] = await Promise.all([hash(source), hash(target)]);
    if (String(a).toLowerCase() !== String(b).toLowerCase()) throw new Error('copy does not match');
  } catch (error) {
    log(`copy failed: ${error?.message || error}; restoring the previous version`);
    await fsp.rm(target, { force: true }).catch(() => {});
    if (renamed) await fsp.rename(oldPath, target).catch(e => log(`restore failed: ${e?.message || e}`));
    if (fs.existsSync(target)) await launch(target);
    return { ok: false, reason: 'copy-failed' };
  }
  await launch(target);
  log(`started ${path.basename(target)}`);
  return { ok: true, reason: '' };
}

/** New-app side: removes "<exe>.old" and "<exe stem>.updating.exe" once the previous process has let go of them. */
async function cleanupLeftovers({ target, attempts = 30, delayMs = 1000, sleep = defaultSleep }) {
  const removed = [];
  const candidates = [oldPathFor(target), helperPathFor(target)].filter(file => !sameFile(file, target));
  for (const file of candidates) {
    for (let attempt = 1; fs.existsSync(file); attempt += 1) {
      try { await fsp.rm(file, { force: true }); } catch { /* still in use */ }
      if (!fs.existsSync(file)) { removed.push(file); break; }
      if (attempt >= attempts) break;
      await sleep(delayMs);
    }
  }
  return { removed, pending: candidates.some(file => fs.existsSync(file)) };
}

module.exports = { OLD_SUFFIX, HELPER_SUFFIX, oldPathFor, helperPathFor, sha256File, prepareHelper, runHelperSwap, cleanupLeftovers };
