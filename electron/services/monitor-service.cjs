'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { isMonitorApiUrl, monitorApiUrlCandidates } = require('./monitor-api.cjs');
const reviewPolicy = require('./review-queue-policy.cjs');

const APP_ID = 'flickfetch';
const APP_NAME = 'FlickFetch';
// Monitor API root; the desktop client only ever talks to the allow-listed, server-side client gateway.
// No Monitor API key is stored in, loaded by, or sent from FlickFetch: the gateway injects its own server-only key.
const DEFAULT_GATEWAY = 'https://pdfstudio.shares.zrok.io/pdfstudio-monitor/api/client-gateway.php';
const HEARTBEAT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_FILE_BYTES = 1024 * 1024 * 1024; // updates are assembled in memory
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const USAGE_QUEUE_LIMIT = 100;
const EXE_ENTRY_NAME = 'FlickFetch.exe';
const UPDATE_FILE_PATTERN = /^FlickFetch-(\d+(?:\.\d+)+)-x64-Portable(?: \(\d+\))?\.exe(\.part)?$/i;

// Runs detached after the app quits. It waits for the running exe (found by path, so a renamed exe works), swaps the new
// build into the SAME path (keeping whatever name the person gave it), starts it, confirms it stayed open, then deletes the
// old exe and staging files. It never leaves the person stranded: if the in-place swap fails, the old exe is restored, the
// verified new build is saved to a visible folder and started from there, and the next launch explains what happened.
// ASCII only: Windows PowerShell 5.1 reads a BOM-less script file as ANSI.
const APPLY_UPDATE_SCRIPT = String.raw`
param([Parameter(Mandatory=$true)][string]$TargetPath,[Parameter(Mandatory=$true)][string]$SourcePath,[Parameter(Mandatory=$true)][int]$ParentPid,[Parameter(Mandatory=$true)][string]$ExpectedSha256,[Parameter(Mandatory=$true)][string]$Version,[Parameter(Mandatory=$true)][string]$LogPath,[Parameter(Mandatory=$true)][string]$ResultPath,[Parameter(Mandatory=$true)][string]$FallbackDir)
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath($SourcePath)
$target = [IO.Path]::GetFullPath($TargetPath)
$directory = [IO.Path]::GetDirectoryName($target)
$backup = $target + '.ff-backup'
$expected = $ExpectedSha256.ToLowerInvariant()
$staged = ''
$movedOriginal = $false
$succeeded = $false

function Write-Log([string]$Message) {
  try { ('[' + (Get-Date -Format o) + '] ' + $Message) | Out-File -LiteralPath $LogPath -Append -Encoding utf8 } catch {}
}
function Write-Result([string]$Status, [string]$Message, [string]$NewPath) {
  try {
    $json = ([ordered]@{ status = $Status; version = $Version; message = $Message; newPath = $NewPath; oldPath = $target; at = (Get-Date -Format o) } | ConvertTo-Json)
    [IO.File]::WriteAllText($ResultPath, $json, (New-Object Text.UTF8Encoding($false)))
  } catch {}
}
function Get-TargetProcesses {
  # Match by full path, not by the name 'FlickFetch': the person may have renamed the exe.
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and [IO.Path]::GetFullPath($_.Path).Equals($target, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
  })
}
function Start-AndConfirm([string]$Path) {
  $process = Start-Process -FilePath $Path -WorkingDirectory ([IO.Path]::GetDirectoryName($Path)) -PassThru
  Start-Sleep -Seconds 4
  $alive = $false
  try { $alive = -not $process.HasExited } catch { $alive = $false }
  if (-not $alive) { throw 'FlickFetch closed right after it was started.' }
}

# This line is the handshake: FlickFetch only quits once it can see that the helper is really running.
Write-Log 'helper started'
try {
  try { Wait-Process -Id $ParentPid -Timeout 90 -ErrorAction SilentlyContinue } catch {}
  # The electron-builder portable bootstrapper may still own the EXE briefly after its child exits.
  $deadline = (Get-Date).AddSeconds(45)
  do {
    $running = @(Get-TargetProcesses)
    if ($running.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  if ($running.Count -gt 0) { throw 'FlickFetch is still running, so the exe could not be replaced.' }
  Write-Log 'old exe is closed'

  $staged = Join-Path $directory ('.FlickFetch.update-' + [Guid]::NewGuid().ToString('N') + '.exe')
  Copy-Item -LiteralPath $source -Destination $staged -Force
  $actual = (Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw 'Staged executable checksum mismatch.' }
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
  if (Test-Path -LiteralPath $target) {
    $moved = $false
    for ($attempt = 1; $attempt -le 20 -and -not $moved; $attempt++) {
      try { Move-Item -LiteralPath $target -Destination $backup -Force; $moved = $true; $movedOriginal = $true }
      catch { if ($attempt -eq 20) { throw }; Start-Sleep -Milliseconds 750 }
    }
  }
  Move-Item -LiteralPath $staged -Destination $target -Force
  $installed = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($installed -ne $expected) { throw 'Installed executable checksum mismatch.' }
  Write-Log 'new exe is in place, starting it'
  Start-AndConfirm $target
  Write-Log 'updated and relaunched'
  $succeeded = $true
  Write-Result 'ok' ('FlickFetch was updated to ' + $Version + '.') $target
} catch {
  $reason = $_.Exception.Message
  Write-Log ('In-place update failed: ' + $reason)
  # 1) Put the old exe back exactly where it was (and drop anything half-installed).
  try {
    if ($movedOriginal) {
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue }
      if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $target -Force }
    }
  } catch { Write-Log ('Could not restore the old exe: ' + $_.Exception.Message) }
  if ($staged -and (Test-Path -LiteralPath $staged)) { Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue }
  # 2) Fallback: keep the verified new build in a folder the person can see and start it from there.
  $fallback = Join-Path $FallbackDir ('FlickFetch-' + $Version + '-x64-Portable.exe')
  $fallbackWorked = $false
  try {
    New-Item -ItemType Directory -Force -Path $FallbackDir | Out-Null
    Copy-Item -LiteralPath $source -Destination $fallback -Force
    if ((Get-FileHash -LiteralPath $fallback -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'The saved copy failed its checksum.' }
    Start-AndConfirm $fallback
    $fallbackWorked = $true
    Write-Log ('Started the new version from ' + $fallback)
    Write-Result 'fallback' ('FlickFetch could not replace its own exe (' + $reason + '). Version ' + $Version + ' was started from a saved copy instead. Your original exe is unchanged.') $fallback
    Remove-Item -LiteralPath $source -Force -ErrorAction SilentlyContinue
  } catch { Write-Log ('Fallback failed: ' + $_.Exception.Message) }
  if (-not $fallbackWorked) {
    # 3) Last resort: reopen the version the person had, and show them where the verified new file is.
    $shown = $source
    if (Test-Path -LiteralPath $fallback) { $shown = $fallback }
    else {
      # The staging folder is tidied on launch, so give the only copy a name that survives that.
      try { $kept = Join-Path ([IO.Path]::GetDirectoryName($source)) ('keep-FlickFetch-' + $Version + '-x64-Portable.exe'); Move-Item -LiteralPath $source -Destination $kept -Force; $shown = $kept } catch {}
    }
    Write-Result 'failed' ('The update to ' + $Version + ' could not be applied (' + $reason + '). The downloaded file was kept so you can run it yourself.') $shown
    try { if (Test-Path -LiteralPath $target) { Start-Process -FilePath $target -WorkingDirectory $directory } } catch { Write-Log ('Could not reopen the old exe: ' + $_.Exception.Message) }
  }
}

if ($succeeded) {
  try {
    # The update succeeded: remove the old exe (backup). Antivirus / the bootstrapper can hold it briefly, so retry.
    for ($attempt = 1; $attempt -le 30 -and (Test-Path -LiteralPath $backup); $attempt++) {
      try { Remove-Item -LiteralPath $backup -Force -ErrorAction Stop } catch { Start-Sleep -Milliseconds 1000 }
    }
    Remove-Item -LiteralPath $source -Force -ErrorAction SilentlyContinue
    Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($source)) -Filter 'FlickFetch-*.exe' -Force -ErrorAction SilentlyContinue | Where-Object { $_.FullName -ne $target } | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -LiteralPath $directory -Filter '.FlickFetch.update-*.exe' -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  } catch { Write-Log ('Cleanup warning: ' + $_.Exception.Message) }
}
if ($PSCommandPath) { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue }
`;

function randomId() { return crypto.randomBytes(16).toString('hex'); }
function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function safeText(value, limit = 1500) { return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, limit); }
function isValidInstallId(value) { return /^[a-f0-9]{16,64}$/i.test(String(value || '')); }
function cleanHash(value) { return String(value || '').trim().replace(/^sha256[:=]/i, '').toLowerCase(); }

/** Same friendly label PDF Studio reports, so both apps read identically in the Monitor ("Windows 11 (x64)"). */
function getOsLabel() {
  const system = String(os.type() || '').trim();
  const release = String(os.release() || '').trim();
  const architecture = process.arch === 'ia32' ? 'x86' : process.arch === 'x64' ? 'x64' : process.arch;
  if (process.platform === 'win32' || /^windows(?:_nt)?$/i.test(system)) {
    const match = release.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!match) return `Windows (${architecture})`;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const build = Number(match[3] || 0);
    let version;
    if (major === 10 && minor === 0) version = build >= 22000 ? 'Windows 11' : 'Windows 10';
    else if (major === 6 && minor === 3) version = 'Windows 8.1';
    else if (major === 6 && minor === 2) version = 'Windows 8';
    else if (major === 6 && minor === 1) version = 'Windows 7';
    else if (major === 6 && minor === 0) version = 'Windows Vista';
    else version = `Windows ${release}`;
    return `${version} (${architecture})`.slice(0, 120);
  }
  return `${system || process.platform} ${release} (${architecture})`.trim().slice(0, 120);
}
function getHostname() { try { return String(os.hostname() || '').trim().slice(0, 64); } catch { return ''; } }
function findLocalIp() {
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const item of list || []) {
        const isV4 = item.family === 'IPv4' || item.family === 4;
        if (isV4 && !item.internal && item.address && item.address !== '0.0.0.0') return item.address;
      }
    }
  } catch { /* no network interface information */ }
  return '';
}

function parseVersion(value) {
  const version = String(value || '').trim().replace(/^v/i, '');
  if (!/^\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version “${value}”. Use a version such as 2.1.1.`);
  }
  const withoutBuild = version.split('+')[0];
  const [numeric, prerelease = ''] = withoutBuild.split('-', 2);
  return { raw: version, numbers: numeric.split('.').map(part => Number(part)), prerelease };
}
function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < Math.max(a.numbers.length, b.numbers.length); i += 1) {
    const difference = (a.numbers[i] || 0) - (b.numbers[i] || 0);
    if (difference) return Math.sign(difference);
  }
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  if (a.prerelease === b.prerelease) return 0;
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
}

/** Writes through a temp file and keeps a recoverable .bak while swapping (Windows rename cannot replace reliably). */
async function atomicWrite(file, content, options = { encoding: 'utf8', mode: 0o600 }) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  const backup = `${file}.bak`;
  await fsp.writeFile(temp, content, options);
  try {
    await fsp.rm(backup, { force: true });
    try { await fsp.rename(file, backup); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await fsp.rename(temp, file);
    await fsp.rm(backup, { force: true });
  } catch (error) {
    try { if (!fs.existsSync(file) && fs.existsSync(backup)) await fsp.rename(backup, file); } catch { /* keep the original error */ }
    throw error;
  }
}
/** Reads file, then .tmp/.bak leftovers from an interrupted swap. Returns {found, value}; throws if found but unreadable. */
async function readRecoverable(file, parse) {
  let foundAny = false;
  let lastError = null;
  for (const candidate of [`${file}.tmp`, file, `${file}.bak`]) {
    let raw;
    try { raw = await fsp.readFile(candidate, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') continue; foundAny = true; lastError = error; continue; }
    foundAny = true;
    try {
      const value = await parse(raw);
      if (candidate !== file) {
        await fsp.copyFile(candidate, file);
        await fsp.rm(`${file}.tmp`, { force: true }).catch(() => {});
        await fsp.rm(`${file}.bak`, { force: true }).catch(() => {});
      }
      return { found: true, value };
    } catch (error) { lastError = error; }
  }
  if (!foundAny) return { found: false, value: null };
  throw lastError || new Error('The file could not be recovered.');
}

const DELTA_MIN_CHUNK = 65536;
const DELTA_AVG_MASK = 0x1ffff;
const DELTA_MAX_CHUNK = 1048576;
const DELTA_WINDOW = 64;

function makeGearTable() {
  const table = new Uint32Array(256);
  let x = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    table[i] = x;
  }
  return table;
}
const GEAR = makeGearTable();
function rol32(value) { return ((value << 1) | (value >>> 31)) >>> 0; }

/** Must stay byte-for-byte compatible with src/delta.php's psd-chunks-v1 chunker. */
function buildContentDefinedChunks(buffer) {
  const window = new Uint8Array(DELTA_WINDOW);
  let windowCount = 0;
  let windowPos = 0;
  let rolling = 0;
  let chunkStart = 0;
  let segmentStart = 0;
  let chunkLength = 0;
  const chunks = [];
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (windowCount < DELTA_WINDOW) {
      rolling = (rol32(rolling) ^ GEAR[byte]) >>> 0;
      window[windowCount++] = byte;
    } else {
      const outgoing = window[windowPos];
      rolling = (rol32(rolling) ^ GEAR[byte] ^ GEAR[outgoing]) >>> 0;
      window[windowPos] = byte;
      windowPos = (windowPos + 1) % DELTA_WINDOW;
    }
    const candidateSize = chunkLength + (i - segmentStart + 1);
    if (candidateSize >= DELTA_MIN_CHUNK && ((rolling & DELTA_AVG_MASK) === 0 || candidateSize >= DELTA_MAX_CHUNK)) {
      const segmentLength = i - segmentStart + 1;
      chunkLength += segmentLength;
      const part = buffer.subarray(chunkStart, chunkStart + chunkLength);
      chunks.push({ offset: chunkStart, size: chunkLength, sha256: sha256(part), data: part });
      chunkStart += chunkLength;
      chunkLength = 0;
      segmentStart = i + 1;
      if (chunks.length > 10000) throw new Error('This executable has too many differential-update chunks.');
    }
  }
  if (chunkStart < buffer.length) {
    const size = buffer.length - chunkStart;
    const part = buffer.subarray(chunkStart);
    chunks.push({ offset: chunkStart, size, sha256: sha256(part), data: part });
  }
  return chunks;
}

function parseDeltaPayload(payload, expectedHashes = []) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (bytes.length < 12 || bytes.subarray(0, 8).toString('ascii') !== 'PSDDELTA') throw new Error('The differential update response has an invalid header.');
  const count = bytes.readUInt32LE(8);
  if (count > 10000 || count !== expectedHashes.length) throw new Error('The differential update response has an unexpected chunk count.');
  let offset = 12;
  const result = new Map();
  const expectedSet = new Set(expectedHashes);
  for (let i = 0; i < count; i++) {
    if (offset + 40 > bytes.length) throw new Error('The differential update response is truncated.');
    const hash = bytes.subarray(offset, offset + 32).toString('hex'); offset += 32;
    const rawSize = bytes.readUInt32LE(offset); offset += 4;
    const compressedSize = bytes.readUInt32LE(offset); offset += 4;
    if (rawSize < 1 || rawSize > DELTA_MAX_CHUNK || compressedSize < 1 || offset + compressedSize > bytes.length) throw new Error('The differential update contains an invalid chunk length.');
    const chunk = zlib.inflateRawSync(bytes.subarray(offset, offset + compressedSize), { maxOutputLength: DELTA_MAX_CHUNK });
    offset += compressedSize;
    if (chunk.length !== rawSize || sha256(chunk) !== hash || !expectedSet.has(hash)) throw new Error('A differential update chunk failed integrity validation.');
    result.set(hash, chunk);
  }
  if (offset !== bytes.length || expectedHashes.some(hash => !result.has(hash))) throw new Error('The differential update response is incomplete or contains trailing data.');
  return result;
}


const DEFAULT_REVIEW_STATE = Object.freeze({
  totalUsageSeconds: 0, submittedAt: 0, neverAskAgain: false, snoozedUntil: 0, lastPromptAt: 0, promptCount: 0,
  reviewStatus: 'none', pendingReviewId: '', lastReviewId: '', lastReviewVersion: '', usageSecondsAtReview: 0
});

class MonitorService {
  constructor({ app, appVersion, userDataPath, emit = () => {}, packaged = false, safeStorage = null, platform = process.platform }) {
    this.app = app;
    this.platform = platform;
    this.appVersion = String(appVersion || '0.0.0');
    this.userDataPath = userDataPath;
    this.emit = emit;
    this.packaged = Boolean(packaged);
    this.safeStorage = safeStorage;
    this.gateway = process.env.FLICKFETCH_MONITOR_GATEWAY_URL || DEFAULT_GATEWAY;
    this.installId = '';
    this.sessionId = randomId();
    this.sessionStartedAt = Math.floor(Date.now() / 1000);
    this.sessionStartedMs = Date.now();
    this.reviewAccountedMs = Date.now();
    this.heartbeatTimer = null;
    this.reviewTimer = null;
    this.started = false;
    this.closed = false;
    this.latest = null;
    this.updateCheckAt = 0;
    this.updateCheckPromise = null;
    this.downloadPromise = null;
    this.usageQueueFlushing = false;
    this.lastDiagnosticKey = '';
    this.lastDiagnosticAt = 0;
    this.stateFile = path.join(userDataPath, 'monitor-state.json');
    this.usageQueueFile = path.join(userDataPath, 'monitor-usage-queue.json');
    this.usageLogFile = path.join(userDataPath, 'monitor-usage.log');
    this.reviewStateFile = path.join(userDataPath, 'review-state.json');
    this.reviewOutboxFile = path.join(userDataPath, 'review-outbox.enc');
    this.updateResultFile = path.join(userDataPath, 'update-result.json');
    this.reviewState = null;
    this.reviewStateLoad = null;
    this.reviewAccounting = null;
    this.reviewOutboxReadBlocked = false;
    this.reviewStateReadBlocked = false;
    this.reviewFlushing = false;
    this.isPortable = this.platform === 'win32' && Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
    this.targetExecutable = path.resolve(process.env.PORTABLE_EXECUTABLE_FILE || process.execPath);
  }

  /**
   * How this build can take an update:
   *  - 'install':  the packaged Windows portable exe replaces itself and restarts.
   *  - 'download': an installed build cannot overwrite its own installation, so it downloads the verified
   *                portable release to the Downloads folder and the person runs it.
   *  - null:       unpackaged development runs and non-Windows platforms. These can still *check* for a release
   *                (see canCheckUpdates) but never download or replace anything.
   */
  get updateMode() {
    if (!this.packaged || this.platform !== 'win32') return null;
    return this.isPortable ? 'install' : 'download';
  }

  /** Release checks are read-only, so they also work from `npm run dev`; only packaged non-Windows builds are excluded. */
  get canCheckUpdates() { return !this.packaged || this.platform === 'win32'; }

  get identity() { return { hostname: getHostname(), os: getOsLabel(), local_ip: findLocalIp() }; }
  log(level, message) { this.emit('app:log', { level, message }); }
  getSafeStorage() {
    if (this.safeStorage) return this.safeStorage;
    try { this.safeStorage = require('electron').safeStorage || null; } catch { this.safeStorage = null; }
    return this.safeStorage;
  }

  // Removes anything an earlier update left behind: the old exe backup and staged copies beside the exe, and the staged
  // download folder in AppData. Runs shortly after launch (the update helper may still be finishing) and never throws.
  cleanupUpdateLeftovers() {
    if (!this.packaged || this.platform !== 'win32') return;
    const timer = setTimeout(() => this.runUpdateCleanup(), 30_000);
    timer.unref?.();
  }

  /** Synchronous and never throws. Safe to run on every launch. */
  runUpdateCleanup() {
    try {
      const target = path.resolve(this.targetExecutable);
      const sameFile = file => path.resolve(file).toLowerCase() === target.toLowerCase();
      if (this.isPortable) {
        // The replaced exe (backup) and staged copies sit beside the exe, whatever the person renamed it to.
        const dir = path.dirname(target);
        if (fs.existsSync(target)) {
          for (const name of fs.readdirSync(dir)) {
            if (name === `${path.basename(target)}.ff-backup` || /^\.FlickFetch\.update-[0-9a-f]+\.exe$/i.test(name)) {
              try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* retried on the next launch */ }
            }
          }
        }
        const stageDir = path.join(this.userDataPath, 'updates');
        if (fs.existsSync(stageDir)) {
          for (const name of fs.readdirSync(stageDir)) {
            const file = path.join(stageDir, name);
            // keep-* is the only copy of a release that could not be applied; it lingers for a week so the person can still run it.
            const maxAge = /^keep-/i.test(name) ? 7 * 24 * 3_600_000 : 10 * 60_000;
            try { if (Date.now() - fs.statSync(file).mtimeMs > maxAge) fs.rmSync(file, { recursive: true, force: true }); } catch { /* ignore */ }
          }
        }
      }
      // Downloaded releases: drop interrupted .part files and any release that is not newer than the running version.
      const downloadDir = this.updateDownloadDir();
      if (fs.existsSync(downloadDir)) {
        for (const name of fs.readdirSync(downloadDir)) {
          const match = UPDATE_FILE_PATTERN.exec(name);
          if (!match) continue;
          const file = path.join(downloadDir, name);
          if (sameFile(file)) continue; // never touch the exe that is running
          let obsolete = Boolean(match[2]);
          if (!obsolete) { try { obsolete = compareVersions(match[1], this.appVersion) <= 0; } catch { obsolete = false; } }
          if (obsolete) { try { fs.rmSync(file, { force: true }); } catch { /* in use: retried next launch */ } }
        }
        try { if (!fs.readdirSync(downloadDir).length) fs.rmdirSync(downloadDir); } catch { /* not empty or in use */ }
      }
    } catch (error) { this.log('warn', `Update cleanup skipped: ${error.message}`); }
  }

  /** Fails early, before a large download, when the exe's folder cannot be written (the swap needs it). */
  assertWritableDirectory(dir) {
    const probe = path.join(dir, `.FlickFetch.write-test-${randomId().slice(0, 8)}`);
    try { fs.writeFileSync(probe, ''); fs.rmSync(probe, { force: true }); }
    catch { throw new Error(`FlickFetch cannot replace itself because "${dir}" is not writable. Move the exe to a folder you own, such as Documents or Desktop, and update again.`); }
  }

  // ───────────────────────── identity & lifecycle ─────────────────────────
  async initialize() {
    fs.mkdirSync(this.userDataPath, { recursive: true });
    let state = {};
    try { state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { /* create a new stable installation id */ }
    this.installId = isValidInstallId(state.install_id) ? state.install_id.toLowerCase() : randomId();
    this.persistIdentity(state.created_at);
    // Usage reporting (open / heartbeat / close) runs for every launch, including `npm start` and `npm run dev`,
    // so the Monitor always shows this device. Reviews and in-app updates remain packaged-build only.
    this.started = true;
    this.cleanupUpdateLeftovers();
    // Same start-up order as PDF Studio: deliver anything queued while offline, then announce this session.
    (async () => {
      await this.flushUsageQueue();
      await this.sendUsage(this.sessionPayload('open'), 8000);
    })().catch(error => this.log('warn', `Monitor connection unavailable: ${error.message}`));
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return;
      void this.accountReviewUsage();
      this.sendUsage(this.sessionPayload('heartbeat'), 8000).catch(error => this.log('warn', `Monitor heartbeat failed: ${error.message}`));
      void this.flushUsageQueue();
      void this.flushPendingReviews();
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
    // Once per launch ignore retry backoff so a review rejected earlier is re-sent as soon as the app starts.
    void this.flushPendingReviews({ force: true });
    this.reviewTimer = setInterval(() => { void this.flushPendingReviews(); }, 60_000);
    this.reviewTimer.unref?.();
    return { enabled: true, installId: this.installId };
  }

  persistIdentity(createdAt) {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({ install_id: this.installId, created_at: createdAt || new Date().toISOString() }, null, 2), { mode: 0o600 });
    } catch (error) { this.log('warn', `Monitor identity could not be saved: ${error.message}`); }
  }

  /** The monitor canonicalizes one installation per app/device. Keep the server's id so heartbeats, reviews and updates agree. */
  adoptInstallId(value) {
    const candidate = String(value || '').trim().toLowerCase();
    if (!isValidInstallId(candidate) || candidate === this.installId) return;
    this.installId = candidate;
    let state = {};
    try { state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { /* retain a safe creation timestamp */ }
    this.persistIdentity(state.created_at);
  }

  // ───────────────────────── Monitor transport ─────────────────────────
  gatewayUrl(resource, params = {}) {
    const url = new URL(this.gateway);
    if (url.protocol !== 'https:' && !(url.hostname === 'localhost' || url.hostname === '127.0.0.1')) throw new Error('The FlickFetch monitor gateway must use HTTPS.');
    url.searchParams.set('resource', resource);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    if (resource === 'update' || resource === 'access') {
      // This Electron package is permanently bound to FlickFetch. Never allow a caller or
      // copied PDF Studio updater parameter to place a request in another application's lane.
      url.searchParams.set('app_id', APP_ID);
      url.searchParams.set('app', APP_ID); // legacy server/client compatibility
    }
    return url;
  }

  assertGatewayUrl(value, expectedAction = '') {
    let url;
    try { url = value instanceof URL ? value : new URL(String(value)); }
    catch { throw new Error('The update endpoint contains an invalid URL.'); }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('FlickFetch Monitor update requests and downloads must remain on HTTPS.');
    if (url.username || url.password) throw new Error('Release URLs cannot contain embedded credentials.');
    if (expectedAction) {
      const action = url.searchParams.get('action') || 'latest';
      const trusted = local || (isMonitorApiUrl(url) && /\/client-gateway\.php$/i.test(url.pathname));
      if (!trusted || url.searchParams.get('resource') !== 'update' || action !== expectedAction) throw new Error('The update URL is not a valid FlickFetch Monitor update endpoint.');
      const format = url.searchParams.get('format');
      if (format && (action !== 'download' || format !== 'zip')) throw new Error('The update endpoint contains an unsupported package format.');
    }
    return url;
  }

  /** HTTPS fetch with manual redirects and the /api <-> /public/api deployment fallback used by PDF Studio. */
  async fetchMonitor(value, { signal, accept = 'application/json', maxRedirects = 5, allowApiPathFallback = true, method = 'GET', body = null } = {}) {
    let current = this.assertGatewayUrl(value);
    const requestSignal = signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      let response;
      try {
        const headers = { 'User-Agent': `FlickFetch/${this.appVersion}`, 'ngrok-skip-browser-warning': '1', Accept: accept };
        response = await fetch(current, {
          method, redirect: 'manual', signal: requestSignal,
          headers: body === null ? headers : { ...headers, 'Content-Type': 'application/json' },
          ...(body === null ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
        });
      } catch (error) {
        if (!signal && (error?.name === 'TimeoutError' || error?.name === 'AbortError')) throw new Error('The FlickFetch Monitor did not respond within 20 seconds. Check your connection and try again.');
        throw error;
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('The FlickFetch Monitor returned an incomplete redirect.');
        if (redirects === maxRedirects) throw new Error('Too many redirects while connecting to the FlickFetch Monitor.');
        current = this.assertGatewayUrl(new URL(location, current));
        continue;
      }
      const alternate = allowApiPathFallback ? monitorApiUrlCandidates(current).find(candidate => candidate.pathname !== current.pathname) : null;
      if (!response.ok) {
        if (alternate && [401, 403, 404, 405].includes(response.status)) {
          return this.fetchMonitor(alternate, { signal, accept, maxRedirects, allowApiPathFallback: false, method, body });
        }
        let serverDetail = '';
        if (accept.includes('application/json')) {
          try {
            const errorBody = JSON.parse((await response.clone().text()).slice(0, 1200));
            if (typeof errorBody?.error === 'string') serverDetail = errorBody.error.replace(/[\r\n\t]+/g, ' ').slice(0, 300);
          } catch { /* a non-JSON Apache/tunnel response is summarized by status below */ }
        }
        if (response.status === 401) throw new Error(`The FlickFetch Monitor gateway refused the request.${serverDetail ? ` ${serverDetail}` : ' Check the server-side gateway configuration and Monitor API credentials.'}`);
        if (response.status === 404) throw new Error(`The FlickFetch Monitor client gateway was not found. Deploy client-gateway.php to the Monitor API directory and verify the server URL.${serverDetail ? ` ${serverDetail}` : ''}`);
        if (response.status === 403 || response.status === 429) throw new Error(`The FlickFetch Monitor temporarily refused the request.${serverDetail ? ` ${serverDetail}` : ' Try again later.'}`);
        throw new Error(`FlickFetch Monitor returned HTTP ${response.status}${serverDetail ? `: ${serverDetail}` : '.'}`);
      }
      // A tunnel splash or web-server fallback can return HTML with HTTP 200: try the alternate deployment path once.
      if (accept.includes('application/json') && !/\bjson\b/i.test(response.headers.get('content-type') || '')) {
        if (alternate) return this.fetchMonitor(alternate, { signal, accept, maxRedirects, allowApiPathFallback: false, method, body });
        throw new Error('The FlickFetch Monitor gateway returned a non-JSON response. Check the gateway deployment and tunnel route.');
      }
      return response;
    }
    throw new Error('Could not reach the FlickFetch Monitor.');
  }

  async readBody(response, limit, message) {
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > limit) throw new Error(message);
    const parts = [];
    let total = 0;
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > limit) throw new Error(message);
      parts.push(bytes);
    }
    return Buffer.concat(parts, total);
  }

  /** Streams a response into memory with progress events, a hard size cap and an exact-size check. */
  async downloadBytes(response, { expectedSize = 0, maxBytes = MAX_FILE_BYTES, phase = 'download', from = 5, to = 70, signal } = {}) {
    const declared = Number(response.headers.get('content-length') || 0);
    const total = declared > 0 ? declared : expectedSize;
    if (total > maxBytes) throw new Error('The update package is larger than the safety limit.');
    const parts = [];
    let received = 0;
    let lastEmit = 0;
    for await (const chunk of response.body) {
      if (signal?.aborted) throw new Error('Update cancelled.');
      const bytes = Buffer.from(chunk);
      received += bytes.length;
      if (received > maxBytes) throw new Error('The update package is larger than the safety limit.');
      parts.push(bytes);
      const now = Date.now();
      if (total > 0 && now - lastEmit > 150) {
        lastEmit = now;
        this.emit('updater:progress', { phase, percent: Math.round(from + (received / total) * (to - from)), downloadedBytes: received, totalBytes: total });
      }
    }
    if (expectedSize && received !== expectedSize) throw new Error('The downloaded update size does not match the monitor manifest.');
    return Buffer.concat(parts, received);
  }

  async logDiagnostic(message) {
    const safe = String(message || 'Unknown Monitor reporting error').replace(/[\r\n\t]+/g, ' ').slice(0, 700);
    const now = Date.now();
    if (safe === this.lastDiagnosticKey && now - this.lastDiagnosticAt < 5 * 60 * 1000) return; // do not repeat a persistent rejection every heartbeat
    this.lastDiagnosticKey = safe;
    this.lastDiagnosticAt = now;
    console.warn(`[FlickFetch] Monitor reporting: ${safe}`);
    try {
      await fsp.mkdir(path.dirname(this.usageLogFile), { recursive: true });
      try {
        const stat = await fsp.stat(this.usageLogFile);
        if (stat.size > 256 * 1024) { await fsp.rm(`${this.usageLogFile}.old`, { force: true }); await fsp.rename(this.usageLogFile, `${this.usageLogFile}.old`); }
      } catch { /* no log yet */ }
      await fsp.appendFile(this.usageLogFile, `${new Date().toISOString()} | ${safe}\n`, 'utf8');
    } catch { /* diagnostics must never break the app */ }
  }

  /** Posts one telemetry/review event. Resolves {status: 'delivered' | 'retry' | 'permanent', message}. */
  async postUsage(payload, timeoutMs = 8000) {
    const candidates = monitorApiUrlCandidates(this.gatewayUrl('telemetry'));
    let lastFailure = 'Could not reach the FlickFetch Monitor telemetry endpoint.';
    let lastStatus = 0;
    for (let index = 0; index < candidates.length; index += 1) {
      const endpoint = candidates[index];
      try {
        const response = await fetch(endpoint.toString(), {
          method: 'POST', redirect: 'manual',
          headers: { 'User-Agent': `FlickFetch/${this.appVersion}`, 'ngrok-skip-browser-warning': '1', Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs)
        });
        const bodyText = await response.text().catch(() => '');
        lastStatus = response.status;
        let result = null;
        try { result = JSON.parse(bodyText); } catch { /* not JSON */ }
        if (response.ok && result && result.ok === true) {
          if (typeof result.install_id === 'string') this.adoptInstallId(result.install_id);
          return { status: 'delivered', install_id: this.installId };
        }
        const detail = String(result?.error || (response.ok ? 'The endpoint returned HTTP success but did not confirm the event.' : '') || bodyText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 240);
        lastFailure = `${endpoint.pathname} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
        // Try the direct-public alias when the canonical rewrite or a routing layer blocks that route.
        if (index + 1 < candidates.length && [301, 302, 303, 307, 308, 401, 403, 404, 405].includes(response.status)) continue;
        if (index + 1 < candidates.length && response.ok && (!result || result.ok !== true)) continue;
      } catch (error) {
        // A network failure is host-wide; do not wait for a second path on the same host.
        lastFailure = `${endpoint.origin}${endpoint.pathname} could not be reached: ${String(error?.message || error).slice(0, 220)}`;
        lastStatus = 0;
        break;
      }
      break;
    }
    const temporary = lastStatus === 0 || lastStatus >= 500 || [408, 425, 429].includes(lastStatus) || [301, 302, 303, 307, 308].includes(lastStatus);
    await this.logDiagnostic(lastFailure);
    return { status: temporary ? 'retry' : 'permanent', message: lastFailure };
  }

  // ───────────────────────── usage telemetry (durable queue) ─────────────────────────
  sessionPayload(event) {
    return {
      event, app_id: APP_ID, app: APP_ID, session_id: this.sessionId, install_id: this.installId, version: this.appVersion, ...this.identity,
      started_at: this.sessionStartedAt, seconds: Math.max(0, Math.floor((Date.now() - this.sessionStartedMs) / 1000))
    };
  }
  async readUsageQueue() {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.usageQueueFile, 'utf8'));
      return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') : [];
    } catch { return []; }
  }
  async writeUsageQueue(queue) { await atomicWrite(this.usageQueueFile, JSON.stringify(queue.slice(-USAGE_QUEUE_LIMIT))); }
  async enqueueUsageEvent(payload) {
    try {
      const queue = await this.readUsageQueue();
      // Only the latest heartbeat per session is kept; open/close stay durable and idempotent.
      const key = `${payload.session_id}:${payload.event}`;
      const filtered = queue.filter(item => `${item.session_id}:${item.event}` !== key);
      filtered.push(payload);
      await this.writeUsageQueue(filtered);
    } catch { /* losing a heartbeat is acceptable */ }
  }
  async flushUsageQueue() {
    if (this.usageQueueFlushing) return;
    this.usageQueueFlushing = true;
    try {
      const queue = await this.readUsageQueue();
      if (!queue.length) return;
      const remaining = [];
      let transientFailure = false;
      for (const item of queue) {
        if (transientFailure) { remaining.push(item); continue; }
        const result = await this.postUsage(item, 6000);
        if (result.status === 'retry') { transientFailure = true; remaining.push(item); }
        // A permanent 4xx rejection is logged locally and dropped; retrying a malformed event forever would clog the queue.
      }
      await this.writeUsageQueue(remaining);
    } finally { this.usageQueueFlushing = false; }
  }
  async sendUsage(payload, timeoutMs = 8000) {
    if (!payload || !this.started) return { status: 'skipped' };
    const result = await this.postUsage(payload, timeoutMs);
    if (result.status === 'delivered') await this.flushUsageQueue();
    else if (result.status === 'retry') await this.enqueueUsageEvent(payload);
    return result;
  }
  /** Sends one session event now (kept for callers and tests); failures are queued like every other event. */
  async postTelemetry(event, extra = {}) {
    if (!this.started || !this.installId || this.closed) return { ok: false, skipped: true };
    const result = await this.sendUsage({ ...this.sessionPayload(event), ...extra });
    return { ok: result.status === 'delivered', install_id: this.installId, status: result.status };
  }

  // ───────────────────────── reviews (encrypted outbox) ─────────────────────────
  async secureAvailable() {
    const store = this.getSafeStorage();
    if (!store) return false;
    if (typeof store.isAsyncEncryptionAvailable === 'function') {
      try { if (await store.isAsyncEncryptionAvailable()) return true; } catch { /* fall through */ }
    }
    try { return Boolean(store.isEncryptionAvailable()); } catch { return false; }
  }
  async secureEncrypt(text) {
    const store = this.getSafeStorage();
    if (typeof store.encryptStringAsync === 'function') { try { return Buffer.from(await store.encryptStringAsync(text)); } catch { /* use the synchronous API */ } }
    return store.encryptString(text);
  }
  async secureDecrypt(buffer) {
    const store = this.getSafeStorage();
    if (typeof store.decryptStringAsync === 'function') {
      try { const out = await store.decryptStringAsync(buffer); return typeof out === 'string' ? out : String(out?.result ?? ''); } catch { /* written by the sync API */ }
    }
    return store.decryptString(buffer);
  }
  async readReviewOutbox() {
    try {
      const { value } = await readRecoverable(this.reviewOutboxFile, async raw => {
        if (!(await this.secureAvailable())) throw new Error('Windows secure storage is not available to decrypt pending reviews.');
        const encrypted = Buffer.from(String(raw).trim(), 'base64');
        if (!encrypted.length) throw new Error('The encrypted review outbox is empty or damaged.');
        return reviewPolicy.normalizeOutbox(JSON.parse(await this.secureDecrypt(encrypted)));
      });
      this.reviewOutboxReadBlocked = false;
      return value || [];
    } catch (error) {
      this.reviewOutboxReadBlocked = true;
      void this.logDiagnostic(`The encrypted review outbox could not be read and was preserved (${String(error?.message || error).slice(0, 180)}).`);
      throw error;
    }
  }
  async writeReviewOutbox(items) {
    if (this.reviewOutboxReadBlocked) throw new Error('The existing encrypted review queue could not be read; it was not overwritten.');
    if (!(await this.secureAvailable())) throw new Error('Windows secure storage is unavailable, so the review cannot be saved safely.');
    const encrypted = await this.secureEncrypt(JSON.stringify({ version: 1, items: items.slice(-reviewPolicy.MAX_PENDING_REVIEWS) }));
    await atomicWrite(this.reviewOutboxFile, encrypted.toString('base64'));
  }
  async queueReview(payload, id) {
    const queue = await this.readReviewOutbox();
    if (queue.some(item => item.id === id)) return;
    if (queue.length) throw new Error('A review is already pending delivery from this installation.');
    queue.push(reviewPolicy.createOutboxItem(id, payload));
    await this.writeReviewOutbox(queue);
  }

  async loadReviewState() {
    if (this.reviewState) return this.reviewState;
    if (this.reviewStateLoad) return this.reviewStateLoad;
    this.reviewStateLoad = (async () => {
      try {
        const { value: saved } = await readRecoverable(this.reviewStateFile, raw => {
          const value = JSON.parse(raw);
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Review state is not a JSON object.');
          return value;
        });
        this.reviewStateReadBlocked = false;
        this.reviewState = {
          ...DEFAULT_REVIEW_STATE, ...(saved || {}),
          totalUsageSeconds: Math.max(0, Math.min(315360000, Number(saved?.totalUsageSeconds) || 0)),
          submittedAt: Math.max(0, Number(saved?.submittedAt) || 0),
          neverAskAgain: Boolean(saved?.neverAskAgain),
          snoozedUntil: Math.max(0, Number(saved?.snoozedUntil) || 0),
          lastPromptAt: Math.max(0, Number(saved?.lastPromptAt) || 0),
          promptCount: Math.max(0, Math.min(10000, Number(saved?.promptCount) || 0)),
          reviewStatus: ['pending', 'submitted'].includes(saved?.reviewStatus) ? saved.reviewStatus : (Number(saved?.submittedAt) > 0 ? 'submitted' : 'none'),
          pendingReviewId: typeof saved?.pendingReviewId === 'string' ? saved.pendingReviewId.slice(0, 64) : '',
          lastReviewId: typeof saved?.lastReviewId === 'string' ? saved.lastReviewId.slice(0, 64) : '',
          lastReviewVersion: typeof saved?.lastReviewVersion === 'string' ? saved.lastReviewVersion.slice(0, 32) : '',
          usageSecondsAtReview: Math.max(0, Number(saved?.usageSecondsAtReview) || 0)
        };
        if (this.reviewState.submittedAt > 0 && this.reviewState.neverAskAgain) this.reviewState.neverAskAgain = false;
        if (this.reviewState.submittedAt > 0 && !this.reviewState.usageSecondsAtReview) this.reviewState.usageSecondsAtReview = this.reviewState.totalUsageSeconds;
      } catch {
        this.reviewState = { ...DEFAULT_REVIEW_STATE };
        this.reviewStateReadBlocked = true;
        this.reviewState.reviewStatus = 'pending';
        this.reviewState.pendingReviewId = 'state-unreadable';
        this.reviewState.neverAskAgain = true;
      }
      // Recover the suppression state if the process closed after durably queueing a review but before saving state.
      try {
        const queued = await this.readReviewOutbox();
        const pending = queued.find(item => item && typeof item.id === 'string' && item.payload && typeof item.payload === 'object');
        if (pending && pending.id !== this.reviewState.lastReviewId) { this.reviewState.reviewStatus = 'pending'; this.reviewState.pendingReviewId = pending.id; }
      } catch {
        // A queue that cannot be read must never cause another prompt or be overwritten.
        this.reviewState.reviewStatus = 'pending';
        this.reviewState.pendingReviewId = this.reviewState.pendingReviewId || 'pending-unreadable';
      }
      return this.reviewState;
    })();
    try { return await this.reviewStateLoad; } finally { this.reviewStateLoad = null; }
  }
  async persistReviewState() {
    const state = await this.loadReviewState();
    if (this.reviewStateReadBlocked) return false; // never overwrite an unrecoverable history
    await atomicWrite(this.reviewStateFile, JSON.stringify(state));
    return true;
  }
  async accountReviewUsage() {
    if (!this.started) return;
    if (this.reviewAccounting) return this.reviewAccounting;
    this.reviewAccounting = (async () => {
      const now = Date.now();
      const seconds = Math.max(0, Math.floor((now - this.reviewAccountedMs) / 1000));
      if (seconds < 1) return;
      this.reviewAccountedMs += seconds * 1000;
      const state = await this.loadReviewState();
      state.totalUsageSeconds = Math.min(315360000, state.totalUsageSeconds + seconds);
      await this.persistReviewState();
    })().catch(() => {}).finally(() => { this.reviewAccounting = null; });
    return this.reviewAccounting;
  }

  async flushPendingReviews({ force = false } = {}) {
    if (this.reviewFlushing || this.reviewOutboxReadBlocked || !this.started) return { delivered: 0, pending: true };
    this.reviewFlushing = true;
    let delivered = 0;
    try {
      let queue = await this.readReviewOutbox();
      if (!queue.length) return { delivered: 0, pending: false };
      const state = await this.loadReviewState();
      queue = queue.filter(item => !(state.submittedAt && state.lastReviewId && item.id === state.lastReviewId));
      for (const item of queue) {
        if (!force && Number(item.nextAttemptAt || 0) > Date.now()) continue;
        const result = await this.postUsage({ ...item.payload, install_id: this.installId }, 8000);
        if (result.status === 'delivered') {
          Object.assign(state, { submittedAt: Date.now(), reviewStatus: 'submitted', pendingReviewId: '', lastReviewId: item.id, lastReviewVersion: String(item.payload?.version || this.appVersion).slice(0, 32), snoozedUntil: 0 });
          await this.persistReviewState();
          queue = queue.filter(candidate => candidate.id !== item.id);
          await this.writeReviewOutbox(queue);
          delivered += 1;
          break;
        }
        // Keep the review on every failure (a gateway may become compatible later); backoff prevents flooding.
        item.attempts = Math.min(30, Number(item.attempts || 0) + 1);
        item.lastStatus = String(result.status || 'retry');
        item.lastError = String(result.message || 'The Monitor did not acknowledge the review.').slice(0, 500);
        item.nextAttemptAt = Date.now() + reviewPolicy.retryDelayMs(item.attempts, item.lastStatus);
      }
      await this.writeReviewOutbox(queue);
      return { delivered, pending: queue.length > 0, message: queue[0]?.lastError || '' };
    } catch (error) {
      await this.logDiagnostic(`Pending review delivery failed safely: ${String(error?.message || error).slice(0, 300)}`);
      return { delivered, pending: true, error: String(error?.message || error) };
    } finally { this.reviewFlushing = false; }
  }

  async submitReview({ rating, name = '', message = '' } = {}) {
    if (!this.packaged) throw new Error('Reviews can be submitted from a packaged FlickFetch build.');
    if (!this.installId) throw new Error('The monitor identity is not ready yet. Please restart FlickFetch and try again.');
    const numericRating = Number(rating);
    if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) throw new Error('Please select a rating from 1 to 5 stars.');
    const state = await this.loadReviewState();
    if (this.reviewStateReadBlocked && state.pendingReviewId === 'state-unreadable') throw new Error('FlickFetch could not safely recover its local review history. No new review was added to avoid a possible duplicate.');
    if (this.reviewOutboxReadBlocked) throw new Error('FlickFetch could not safely read its existing encrypted review queue. No new review was added and no pending feedback was overwritten.');
    if (state.pendingReviewId || state.reviewStatus === 'pending') {
      const retry = await this.flushPendingReviews({ force: true });
      return { ok: true, queued: !retry.delivered, delivered: retry.delivered > 0, alreadyQueued: true, detail: retry.message || '' };
    }
    await this.accountReviewUsage();
    state.usageSecondsAtReview = state.totalUsageSeconds; // the next automatic prompt needs fresh use after this review
    const identity = this.identity;
    const reviewId = randomId();
    const payload = {
      event: 'review', app_id: APP_ID, app: APP_ID, session_id: reviewId, client_review_id: reviewId,
      install_id: this.installId, version: this.appVersion, ...identity,
      started_at: Math.floor(Date.now() / 1000), seconds: 0, rating: numericRating,
      // No name given -> the device name identifies the reviewer in the Monitor.
      name: (safeText(name, 60) || identity.hostname).slice(0, 60), message: safeText(message, 1500)
    };
    // The encrypted outbox is written first, so an interrupted process cannot lose a review and then ask again.
    try { await this.queueReview(payload, reviewId); }
    catch (queueError) {
      const direct = await this.postUsage(payload, 10000);
      if (direct.status !== 'delivered') throw new Error(`Your review could not be sent or saved on this device (${String(direct.message || queueError?.message || 'unknown error').slice(0, 160)}). Please try again later.`);
      Object.assign(state, { submittedAt: Date.now(), reviewStatus: 'submitted', pendingReviewId: '', lastReviewId: reviewId, lastReviewVersion: this.appVersion, snoozedUntil: 0, usageSecondsAtReview: state.totalUsageSeconds });
      await this.persistReviewState();
      return { ok: true, delivered: true, reviewId };
    }
    state.reviewStatus = 'pending';
    state.pendingReviewId = reviewId;
    state.snoozedUntil = 0;
    await this.persistReviewState();
    const sent = await this.flushPendingReviews({ force: true });
    return { ok: true, delivered: sent.delivered > 0, queued: !(sent.delivered > 0), reviewId, detail: sent.message || '' };
  }

  /** Decides whether the automatic review prompt should appear now (same policy and timings as PDF Studio). */
  async maybePromptReview() {
    if (!this.packaged) return { shouldPrompt: false, stopChecking: true };
    await this.accountReviewUsage();
    const state = await this.loadReviewState();
    const now = Date.now();
    const liveSeconds = Math.max(0, Math.floor((now - this.reviewAccountedMs) / 1000));
    const totalUsageSeconds = state.totalUsageSeconds + liveSeconds;
    const cooldownMs = 7 * 24 * 60 * 60 * 1000;
    const blocked = this.reviewOutboxReadBlocked || this.reviewStateReadBlocked;
    if (reviewPolicy.shouldSuppressReviewPrompt(state, blocked, { appVersion: this.appVersion, now })) {
      const permanent = blocked || state.neverAskAgain;
      const resting = reviewPolicy.reviewCooldownRemainingMs(state, this.appVersion, now);
      return {
        shouldPrompt: false, stopChecking: permanent, totalUsageSeconds, submitted: Boolean(state.submittedAt), recentlyReviewed: resting > 0,
        pending: Boolean(state.pendingReviewId || state.reviewStatus === 'pending' || this.reviewOutboxReadBlocked),
        nextCheckAfterMs: resting > 0 ? Math.min(24 * 60 * 60 * 1000, resting) : 60 * 60 * 1000
      };
    }
    if (now < state.snoozedUntil) return { shouldPrompt: false, totalUsageSeconds, nextCheckAfterMs: Math.min(24 * 60 * 60 * 1000, state.snoozedUntil - now) };
    if (state.lastPromptAt && now - state.lastPromptAt < cooldownMs) return { shouldPrompt: false, totalUsageSeconds, nextCheckAfterMs: Math.min(24 * 60 * 60 * 1000, cooldownMs - (now - state.lastPromptAt)) };
    const usageSinceReview = Math.max(0, totalUsageSeconds - state.usageSecondsAtReview);
    const neededSeconds = Math.max(0, reviewPolicy.REVIEW_MIN_NEW_USAGE_SECONDS - usageSinceReview);
    if (totalUsageSeconds < 30 * 60 || neededSeconds > 0) {
      const missing = Math.max(30 * 60 - totalUsageSeconds, neededSeconds);
      return { shouldPrompt: false, totalUsageSeconds, nextCheckAfterMs: Math.max(60_000, Math.min(10 * 60_000, missing * 1000 + Math.random() * 20_000)) };
    }
    const shouldPrompt = Math.random() < 0.28;
    return { shouldPrompt, totalUsageSeconds, submitted: false, nextCheckAfterMs: shouldPrompt ? 0 : Math.round((12 + Math.random() * 18) * 60_000) };
  }
  async markReviewPromptShown() {
    const state = await this.loadReviewState();
    if (reviewPolicy.shouldSuppressReviewPrompt(state, this.reviewOutboxReadBlocked || this.reviewStateReadBlocked)) return false;
    state.lastPromptAt = Date.now();
    state.promptCount = Math.min(10000, state.promptCount + 1);
    await this.persistReviewState();
    return true;
  }
  async deferReview(choice) {
    const state = await this.loadReviewState();
    if (state.pendingReviewId || state.reviewStatus === 'pending') return true;
    if (String(choice) === 'never') { state.neverAskAgain = true; state.snoozedUntil = 0; }
    else state.snoozedUntil = Date.now() + 7 * 24 * 60 * 60 * 1000;
    await this.persistReviewState();
    return true;
  }
  async reviewIdentity() {
    const state = await this.loadReviewState().catch(() => null);
    return { hostname: getHostname(), lastReviewAt: Number(state?.submittedAt) || 0, reviewPending: Boolean(state?.pendingReviewId || state?.reviewStatus === 'pending') };
  }

  // ───────────────────────── updates ─────────────────────────
  compareVersions(left, right) { try { return compareVersions(left, right); } catch { return 0; } }

  async checkForUpdates({ force = false } = {}) {
    const mode = this.updateMode;
    const development = !this.packaged;
    if (!this.canCheckUpdates) return { supported: false, updateAvailable: false, currentVersion: this.appVersion, installMode: null, development, releaseState: 'unsupported', message: 'FlickFetch updates are published for Windows only.' };
    if (this.updateCheckPromise) return this.updateCheckPromise;
    if (!force && Date.now() - this.updateCheckAt < 60_000 && this.latest) return this.latest;
    this.updateCheckPromise = (async () => {
      const url = this.gatewayUrl('update', { action: 'latest', app: APP_ID, version: this.appVersion, install_id: this.installId, hostname: getHostname(), local_ip: findLocalIp(), platform: 'windows' });
      const response = await this.fetchMonitor(url, { accept: 'application/json' });
      let data;
      try { data = JSON.parse((await this.readBody(response, MAX_METADATA_BYTES, 'The FlickFetch Monitor release metadata is unexpectedly large.')).toString('utf8')); }
      catch (error) { if (/unexpectedly large/.test(error.message)) throw error; throw new Error('The FlickFetch Monitor did not return valid JSON from update.php.'); }
      if (!data || typeof data !== 'object' || data.ok === false) throw new Error(String(data?.error || 'The FlickFetch Monitor returned an unexpected update response.'));
      const latest = data.latest && typeof data.latest === 'object' ? data.latest : null;
      if (!latest) {
        const blocked = data.status === 'rollout_blocked';
        this.latest = { supported: true, updateAvailable: false, currentVersion: this.appVersion, latestVersion: this.appVersion, notes: '', size: 0, sha256: '', delta: null, package: null,
          status: blocked ? 'rollout_blocked' : 'no_release', releaseState: blocked ? 'rollout_blocked' : 'no_release',
          message: blocked ? 'This release is being rolled out gradually.' : 'No release is currently available from the FlickFetch Monitor.' };
      } else {
        const latestVersion = String(latest.version || '').trim().replace(/^v/i, '');
        parseVersion(latestVersion);
        const updateAvailable = data.update_available === true && compareVersions(latestVersion, this.appVersion) > 0;
        let size = Number(latest.size || data.size || 0);
        let hash = cleanHash(latest.sha256 || data.sha256);
        let packageInfo = null;
        let delta = null;
        if (updateAvailable) {
          if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('The FlickFetch Monitor did not provide a valid SHA-256 checksum required to verify this update.');
          if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) throw new Error('The FlickFetch Monitor returned an invalid executable size for this update.');
          const pkg = latest.package && typeof latest.package === 'object' ? latest.package : (data.package && typeof data.package === 'object' ? data.package : null);
          const pkgSize = Number(pkg?.size || 0);
          const pkgHash = cleanHash(pkg?.sha256);
          if (String(pkg?.format || '').toLowerCase() === 'zip' && Number.isSafeInteger(pkgSize) && pkgSize > 0 && pkgSize <= MAX_FILE_BYTES && /^[a-f0-9]{64}$/.test(pkgHash) && (!pkg.entry || String(pkg.entry) === EXE_ENTRY_NAME)) {
            packageInfo = { format: 'zip', size: pkgSize, sha256: pkgHash, entry: EXE_ENTRY_NAME };
          }
          const d = latest.delta && typeof latest.delta === 'object' ? latest.delta : null;
          const manifestSize = Number(d?.manifest_size || 0);
          const manifestHash = cleanHash(d?.manifest_sha256);
          if (String(d?.format || '') === 'psd-chunks-v1' && Number.isSafeInteger(manifestSize) && manifestSize > 0 && manifestSize <= MAX_MANIFEST_BYTES && /^[a-f0-9]{64}$/.test(manifestHash)) {
            delta = { format: 'psd-chunks-v1', manifest_size: manifestSize, manifest_sha256: manifestHash };
          }
        }
        // 'ahead' = this build is newer than anything published: an unreleased development or pre-release build.
        const order = compareVersions(latestVersion, this.appVersion);
        const releaseState = updateAvailable ? 'update_available' : order < 0 ? 'ahead' : 'current';
        this.latest = { supported: true, updateAvailable: Boolean(updateAvailable), currentVersion: this.appVersion, latestVersion, notes: String(latest.notes || data.notes || '').slice(0, 24000),
          size, sha256: hash, delta, package: packageInfo, status: data.status || 'unknown', releaseState,
          message: updateAvailable ? `FlickFetch ${latestVersion} is available from the FlickFetch Monitor.`
            : releaseState === 'ahead' ? `This build (${this.appVersion}) is newer than the latest published release (${latestVersion}).`
            : `No newer release is available. Installed: ${this.appVersion}; latest on Monitor: ${latestVersion}.` };
      }
      this.latest = { ...this.latest, installMode: mode, development, checkedAt: Date.now() };
      this.updateCheckAt = Date.now();
      this.emit('updater:status', this.latest);
      return this.latest;
    })().finally(() => { this.updateCheckPromise = null; });
    return this.updateCheckPromise;
  }

  async downloadAndInstallUpdate() {
    if (this.downloadPromise) return this.downloadPromise;
    this.downloadPromise = this._downloadAndInstallUpdate().finally(() => { this.downloadPromise = null; });
    return this.downloadPromise;
  }

  async _downloadAndInstallUpdate() {
    const update = await this.checkForUpdates({ force: true });
    if (!update.updateAvailable) throw new Error('FlickFetch is already up to date.');
    const mode = update.installMode || this.updateMode;
    if (!mode) throw new Error('Updates can be downloaded from a packaged Windows build of FlickFetch.');
    if (mode === 'download') return this.downloadUpdateToDisk(update);
    const target = path.resolve(this.targetExecutable);
    if (!fs.existsSync(target) || path.extname(target).toLowerCase() !== '.exe') throw new Error('The running executable path could not be verified. This installation cannot self-update safely.');
    this.assertWritableDirectory(path.dirname(target));
    this.emit('updater:progress', { phase: 'prepare', percent: 0 });

    const { executable, method, transfer } = await this.fetchVerifiedExecutable(update, { basePaths: this.differentialBasePaths('install') });

    const stageDir = path.join(this.userDataPath, 'updates');
    fs.mkdirSync(stageDir, { recursive: true });
    const stagedExe = path.join(stageDir, `FlickFetch-${update.latestVersion}-${randomId().slice(0, 8)}.exe`);
    fs.writeFileSync(stagedExe, executable, { mode: 0o700 });
    this.emit('updater:progress', { phase: 'prepare', percent: 90 });
    const helperPath = path.join(stageDir, 'apply-update.ps1');
    const logPath = path.join(stageDir, 'apply-update.log');
    fs.writeFileSync(helperPath, APPLY_UPDATE_SCRIPT, 'utf8');
    fs.rmSync(logPath, { force: true });
    fs.rmSync(this.updateResultFile, { force: true });
    const checksum = sha256(executable);
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', helperPath,
      '-TargetPath', target, '-SourcePath', stagedExe, '-ParentPid', String(process.pid), '-ExpectedSha256', checksum,
      '-Version', String(update.latestVersion), '-LogPath', logPath, '-ResultPath', this.updateResultFile, '-FallbackDir', this.updateDownloadDir()];
    let spawnError = null;
    const child = spawn('powershell.exe', args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', error => { spawnError = error; this.log('error', `Could not start the update installer: ${error.message}`); });
    child.unref();
    // Only quit once the helper has proven it is running. Otherwise the app would close and nothing would ever reopen it.
    if (!(await this.waitForUpdateHelper(logPath, () => spawnError))) {
      try { child.kill(); } catch { /* already gone */ }
      this.log('warn', `The update helper did not start${spawnError ? ` (${spawnError.message})` : ''}; the verified release is being saved instead.`);
      for (const file of [helperPath, stagedExe]) { try { fs.rmSync(file, { force: true }); } catch { /* tidied on next launch */ } }
      return this.saveVerifiedRelease(update, executable, method, transfer);
    }
    this.emit('updater:progress', { phase: 'restarting', percent: 100 });
    return { success: true, restarting: true, version: update.latestVersion, method, usedDifferential: method === 'delta', transfer };
  }

  /** Resolves true once the detached helper has written its first log line; false if it never starts. */
  async waitForUpdateHelper(logPath, getSpawnError, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (getSpawnError()) return false;
      try { if (fs.readFileSync(logPath, 'utf8').includes('helper started')) return true; } catch { /* not written yet */ }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return false;
  }

  /** Reads and deletes the note the update helper left for the next launch. Returns null when there is none. */
  consumeUpdateResult() {
    try {
      const raw = fs.readFileSync(this.updateResultFile, 'utf8').replace(/^\uFEFF/, '');
      fs.rmSync(this.updateResultFile, { force: true });
      const value = JSON.parse(raw);
      if (!value || !['ok', 'fallback', 'failed'].includes(value.status)) return null;
      return { status: value.status, version: safeText(value.version, 40), message: safeText(value.message, 600), newPath: safeText(value.newPath, 520), oldPath: safeText(value.oldPath, 520) };
    } catch { return null; }
  }

  /** Differential reuse -> compressed package -> raw EXE, then size and SHA-256 verification. Returns the verified bytes. */
  async fetchVerifiedExecutable(update, { basePaths = [] } = {}) {
    // 1) Differential reuse -> 2) compressed package -> 3) verified raw EXE, each falling back to the next on any failure.
    let executable = null;
    let transfer = null;
    if (basePaths.length && update.delta?.manifest_sha256) {
      try { ({ executable, transfer } = await this.downloadDifferentialExecutable(update, basePaths)); }
      catch (error) { executable = null; this.log('warn', `Differential update unavailable; switching to a verified full package: ${error.message}`); }
    }
    let method = executable ? 'delta' : '';
    if (!executable && update.package?.format === 'zip') {
      try {
        const zipUrl = this.assertGatewayUrl(this.gatewayUrl('update', { action: 'download', app: APP_ID, version: update.latestVersion, format: 'zip' }), 'download');
        this.emit('updater:progress', { phase: 'download', percent: 5 });
        const response = await this.fetchMonitor(zipUrl, { signal: AbortSignal.timeout(180_000), accept: 'application/zip, application/octet-stream, */*' });
        const payloadBytes = await this.downloadBytes(response, { expectedSize: update.package.size, phase: 'download', from: 5, to: 65 });
        if (sha256(payloadBytes) !== update.package.sha256) throw new Error('The downloaded update package failed its SHA-256 integrity check.');
        this.emit('updater:progress', { phase: 'verify', percent: 70 });
        const AdmZip = require('adm-zip');
        const entries = new AdmZip(payloadBytes).getEntries().filter(entry => !entry.isDirectory && path.basename(entry.entryName).toLowerCase() === EXE_ENTRY_NAME.toLowerCase());
        if (entries.length !== 1) throw new Error(`The update archive must contain exactly one ${EXE_ENTRY_NAME} file.`);
        executable = entries[0].getData();
        method = 'compressed';
        transfer = { downloadedBytes: payloadBytes.length, reusedBytes: 0, totalBytes: Number(update.size) || executable.length };
      } catch (error) {
        executable = null;
        this.log('warn', `Compressed update could not be used; falling back to the full executable: ${error.message}`);
      }
    }
    if (!executable) {
      // Older monitor releases may not have a ZIP cache; the canonical endpoint is always a verified raw EXE.
      const rawUrl = this.assertGatewayUrl(this.gatewayUrl('update', { action: 'download', app: APP_ID, version: update.latestVersion }), 'download');
      this.emit('updater:progress', { phase: 'download', percent: 5 });
      const response = await this.fetchMonitor(rawUrl, { signal: AbortSignal.timeout(300_000), accept: 'application/octet-stream, application/zip, */*' });
      executable = await this.downloadBytes(response, { expectedSize: Number(update.size) || 0, phase: 'download', from: 5, to: 70 });
      method = 'full';
      transfer = { downloadedBytes: executable.length, reusedBytes: 0, totalBytes: executable.length };
    }

    const expectedSize = Number(update.size || 0);
    if (expectedSize && executable.length !== expectedSize) throw new Error('The extracted executable size does not match the published release.');
    const expectedHash = String(update.sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedHash) || sha256(executable) !== expectedHash) throw new Error('The extracted executable failed its SHA-256 integrity check.');

    return { executable, method, transfer: { ...transfer, method } };
  }

  updateDownloadDir() {
    try { const downloads = this.app?.getPath?.('downloads'); if (downloads) return path.join(downloads, 'FlickFetch Updates'); } catch { /* fall back below */ }
    return path.join(this.userDataPath, 'updates', 'download');
  }

  /** Installed builds: save the verified portable release to the Downloads folder and let the person run it. */
  async downloadUpdateToDisk(update) {
    const dir = this.updateDownloadDir();
    fs.mkdirSync(dir, { recursive: true });
    const base = `FlickFetch-${update.latestVersion}-x64-Portable`;
    const preferred = path.join(dir, `${base}.exe`);
    const expected = String(update.sha256).toLowerCase();
    this.emit('updater:progress', { phase: 'prepare', percent: 0 });
    if (fs.existsSync(preferred)) {
      try {
        if (sha256(fs.readFileSync(preferred)) === expected) {
          this.emit('updater:progress', { phase: 'saved', percent: 100 });
          return { success: true, restarting: false, downloaded: true, reused: true, version: update.latestVersion, filePath: preferred, method: 'existing' };
        }
      } catch { /* unreadable: download a fresh copy below */ }
    }
    const { executable, method, transfer } = await this.fetchVerifiedExecutable(update, { basePaths: this.differentialBasePaths('download') });
    return this.saveVerifiedRelease(update, executable, method, transfer);
  }

  /** Writes the verified portable release to the Downloads folder (never overwriting a different file) and reports where it is. */
  saveVerifiedRelease(update, executable, method, transfer) {
    const dir = this.updateDownloadDir();
    fs.mkdirSync(dir, { recursive: true });
    const base = `FlickFetch-${update.latestVersion}-x64-Portable`;
    const expected = String(update.sha256).toLowerCase();
    let destination = path.join(dir, `${base}.exe`);
    for (let n = 1; fs.existsSync(destination) && n < 100; n += 1) destination = path.join(dir, `${base} (${n}).exe`);
    const partial = `${destination}.part`;
    try {
      this.emit('updater:progress', { phase: 'save', percent: 92 });
      fs.writeFileSync(partial, executable);
      if (fs.statSync(partial).size !== executable.length || sha256(fs.readFileSync(partial)) !== expected) throw new Error('The saved update failed verification. Check free disk space and try again.');
      fs.renameSync(partial, destination);
    } catch (error) {
      try { fs.rmSync(partial, { force: true }); } catch { /* ignore */ }
      throw error;
    }
    this.emit('updater:progress', { phase: 'saved', percent: 100 });
    return { success: true, restarting: false, downloaded: true, reused: false, version: update.latestVersion, filePath: destination, method, usedDifferential: method === 'delta', transfer };
  }

  /**
   * Files whose bytes can be reused when building the new executable. Matching is by content-defined chunk hash, so a
   * block is found wherever it sits. Portable build: the running exe (it embeds the whole app, stored uncompressed).
   * Installed build: earlier saved releases plus the installed program files, whose unchanged files appear verbatim in
   * the new portable exe. Overridable in tests.
   */
  differentialBasePaths(mode) {
    if (mode === 'install') return [path.resolve(this.targetExecutable)];
    const found = [];
    try {
      const dir = this.updateDownloadDir();
      for (const name of fs.readdirSync(dir)) if (/^FlickFetch-.*Portable.*\.exe$/i.test(name)) found.push(path.join(dir, name));
    } catch { /* no earlier downloads */ }
    const reusable = new Set(['.exe', '.dll', '.pak', '.bin', '.dat', '.asar', '.node']);
    let budget = 700 * 1024 * 1024;
    const walk = (dir, depth) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (depth < 3) walk(full, depth + 1); continue; }
        if (!entry.isFile() || !reusable.has(path.extname(entry.name).toLowerCase()) || /^uninstall/i.test(entry.name)) continue;
        let size = 0;
        try { size = fs.statSync(full).size; } catch { continue; }
        if (size < 2 * DELTA_MIN_CHUNK || size > MAX_FILE_BYTES || size > budget) continue;
        budget -= size; found.push(full);
      }
    };
    if (this.packaged) walk(path.dirname(path.resolve(this.targetExecutable)), 0);
    return found;
  }

  /** Chunks each base file and records where every block lives; file bytes are not kept in memory. */
  async indexDifferentialBases(basePaths) {
    const index = new Map();
    let done = 0;
    for (const file of basePaths) {
      try {
        const bytes = fs.readFileSync(file);
        for (const chunk of buildContentDefinedChunks(bytes)) if (!index.has(chunk.sha256)) index.set(chunk.sha256, { file, offset: chunk.offset, size: chunk.size });
      } catch (error) { this.log('warn', `Skipped ${path.basename(file)} while comparing update files: ${error.message}`); }
      done += 1;
      this.emit('updater:progress', { phase: 'differential', percent: 10 + Math.round((done / basePaths.length) * 10) });
      await new Promise(resolve => setImmediate(resolve)); // let the window repaint between files
    }
    return index;
  }

  async downloadDifferentialExecutable(update, basePaths) {
    const manifestUrl = this.assertGatewayUrl(this.gatewayUrl('update', { action: 'manifest', app: APP_ID, version: update.latestVersion }), 'manifest');
    this.emit('updater:progress', { phase: 'manifest', percent: 8 });
    const manifestResponse = await this.fetchMonitor(manifestUrl, { accept: 'application/json' });
    const manifestBytes = await this.readBody(manifestResponse, MAX_MANIFEST_BYTES, 'The differential-update manifest is unexpectedly large.');
    if (update.delta.manifest_size && manifestBytes.length !== Number(update.delta.manifest_size)) throw new Error('The differential-update manifest download is incomplete.');
    if (sha256(manifestBytes) !== String(update.delta.manifest_sha256).toLowerCase()) throw new Error('Differential manifest checksum mismatch.');
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (manifest.format !== 'psd-chunks-v1' || manifest.version !== update.latestVersion || Number(manifest.size) !== Number(update.size) || String(manifest.sha256).toLowerCase() !== update.sha256) throw new Error('Differential manifest identity does not match the target release.');
    if (!Array.isArray(manifest.chunks) || manifest.chunks.length < 1 || manifest.chunks.length > 10000) throw new Error('Differential manifest chunk list is invalid.');
    let expectedOffset = 0;
    for (const chunk of manifest.chunks) {
      if (Number(chunk.offset) !== expectedOffset || !Number.isInteger(Number(chunk.size)) || chunk.size < 1 || chunk.size > DELTA_MAX_CHUNK || !/^[a-f0-9]{64}$/i.test(String(chunk.sha256 || ''))) throw new Error('Differential manifest contains an invalid chunk descriptor.');
      expectedOffset += Number(chunk.size);
    }
    if (expectedOffset !== Number(manifest.size)) throw new Error('Differential manifest does not cover the target executable.');

    this.emit('updater:progress', { phase: 'differential', percent: 10 });
    const local = await this.indexDifferentialBases(basePaths);
    const wanted = manifest.chunks.map(chunk => String(chunk.sha256).toLowerCase());
    const missing = [...new Set(wanted.filter(hash => !local.has(hash)))];
    this.emit('updater:progress', { phase: 'differential', percent: 20, missingChunks: missing.length, totalChunks: manifest.chunks.length });

    // When most of the EXE changed, the compressed package is cheaper than a delta (same heuristic as PDF Studio).
    const sizeByHash = new Map(manifest.chunks.map(chunk => [String(chunk.sha256).toLowerCase(), Number(chunk.size)]));
    const missingRawBytes = missing.reduce((sum, hash) => sum + (sizeByHash.get(hash) || 0), 0);
    const zipBytes = Number(update.package?.size || 0);
    const threshold = zipBytes > 0 ? Math.min(Number(update.size) * 0.92, zipBytes * 1.75) : Number(update.size) * 0.92;
    if (missingRawBytes >= threshold) throw new Error(`Only ${Math.round((1 - missingRawBytes / Number(update.size)) * 100)}% of the executable matches the installed files (compressed builds rarely share blocks between releases); the compressed update is smaller.`);

    let downloaded = new Map();
    let deltaTransferBytes = 0;
    if (missing.length) {
      const deltaUrl = this.assertGatewayUrl(this.gatewayUrl('update', { action: 'delta', app: APP_ID, version: update.latestVersion }), 'delta');
      const deltaResponse = await this.fetchMonitor(deltaUrl, { method: 'POST', accept: 'application/vnd.pdfstudio.delta, application/octet-stream, */*', body: { version: update.latestVersion, chunks: missing }, signal: AbortSignal.timeout(180_000) });
      const deltaBytes = await this.downloadBytes(deltaResponse, { phase: 'differential', from: 20, to: 70 });
      deltaTransferBytes = deltaBytes.length;
      downloaded = parseDeltaPayload(deltaBytes, missing);
    }

    const parts = [];
    const handles = new Map();
    let builtSize = 0;
    let reusedBytes = 0;
    try {
      for (const descriptor of manifest.chunks) {
        const hash = String(descriptor.sha256).toLowerCase();
        let part = downloaded.get(hash);
        if (!part) {
          const where = local.get(hash);
          if (where) {
            let fd = handles.get(where.file);
            if (fd === undefined) { fd = fs.openSync(where.file, 'r'); handles.set(where.file, fd); }
            part = Buffer.alloc(where.size);
            if (fs.readSync(fd, part, 0, where.size, where.offset) !== where.size) part = null;
            else reusedBytes += part.length;
          }
        }
        if (!part || part.length !== Number(descriptor.size) || sha256(part) !== hash) throw new Error('A required executable block is missing or failed validation.');
        parts.push(part); builtSize += part.length;
      }
    } finally { for (const fd of handles.values()) { try { fs.closeSync(fd); } catch { /* already closed */ } } }
    if (builtSize !== Number(update.size)) throw new Error('Reconstructed executable has an invalid total size.');
    this.emit('updater:progress', { phase: 'reconstruct', percent: 76 });
    return { executable: Buffer.concat(parts, builtSize), transfer: { downloadedBytes: deltaTransferBytes, reusedBytes, totalBytes: builtSize, changedBlocks: missing.length, totalBlocks: manifest.chunks.length } };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reviewTimer) clearInterval(this.reviewTimer);
    this.heartbeatTimer = null; this.reviewTimer = null;
    if (!this.started || !this.installId) return;
    await this.accountReviewUsage();
    // Build the close event directly (sendUsage would also flush the queue and delay quitting).
    const payload = this.sessionPayload('close');
    const result = await this.postUsage(payload, 2500);
    if (result.status === 'retry') await this.enqueueUsageEvent(payload);
  }
}

module.exports = { MonitorService, APPLY_UPDATE_SCRIPT, UPDATE_FILE_PATTERN, APP_ID, APP_NAME, DEFAULT_GATEWAY, sha256, randomId, buildContentDefinedChunks, parseDeltaPayload, getOsLabel, compareVersions };
