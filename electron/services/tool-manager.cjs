const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const AdmZip = require('adm-zip');

const TOOL_URLS = {
  ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
  checksums: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS',
  ffmpeg: 'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
  deno: 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip'
};

function executableName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function replaceFile(source, destination) {
  if (!fs.existsSync(destination)) { fs.renameSync(source, destination); return; }
  const backup = `${destination}.replace-backup`;
  try {
    fs.rmSync(backup, { force: true });
    fs.renameSync(destination, backup);
    fs.renameSync(source, destination);
    fs.rmSync(backup, { force: true });
  } catch (error) {
    try { if (!fs.existsSync(destination) && fs.existsSync(backup)) fs.renameSync(backup, destination); } catch { /* preserve original error */ }
    throw error;
  } finally { try { if (fs.existsSync(backup) && fs.existsSync(destination)) fs.rmSync(backup, { force: true }); } catch { /* ignore */ } }
}

function findOnPath(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir.replace(/^"|"$/g, ''), name);
      try { if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate; } catch { /* ignore */ }
    }
  }
  return null;
}

function runCapture(exe, args, cwd, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true, env: { ...process.env, PATH: `${cwd}${path.delimiter}${process.env.PATH || ''}`, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error('The tool did not respond before the timeout.'));
    }, timeout);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function downloadTo(url, destination, progress) {
  const response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'FlickFetch/2.1.0' } });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status} ${response.statusText}).`);
  const total = Number(response.headers.get('content-length')) || 0;
  const file = fs.createWriteStream(destination);
  let received = 0;
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (total && progress) progress(received / total);
      callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body), meter, file);
}

class ToolManager {
  constructor(userDataPath, emit) {
    this.binDir = path.join(userDataPath, 'bin');
    this.emit = emit || (() => {});
    fs.mkdirSync(this.binDir, { recursive: true });
    this.refresh();
  }

  refresh() {
    const ytNames = process.platform === 'win32' ? ['yt-dlp.exe', 'yt-dlp'] : ['yt-dlp', 'yt-dlp.exe'];
    const ffNames = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg'];
    const fpNames = process.platform === 'win32' ? ['ffprobe.exe'] : ['ffprobe'];
    const deNames = process.platform === 'win32' ? ['deno.exe'] : ['deno'];
    this.ytDlpPath = this.findLocalOrPath(ytNames, 'yt-dlp');
    this.ffmpegPath = this.findLocalOrPath(ffNames, 'ffmpeg');
    this.ffprobePath = this.findLocalOrPath(fpNames, 'ffprobe');
    this.denoPath = this.findLocalOrPath(deNames, 'deno');
    return this.getStatus();
  }

  findLocalOrPath(names, baseName) {
    for (const name of names) {
      const local = path.join(this.binDir, name);
      try { if (fs.existsSync(local) && fs.statSync(local).size > 0) return local; } catch { /* ignore */ }
    }
    return findOnPath(names) || findOnPath([baseName]);
  }

  async getVersion(exe, args) {
    if (!exe) return null;
    try {
      const result = await runCapture(exe, args, this.binDir, 15000);
      if (result.code !== 0) return null;
      return (result.stdout || result.stderr).split(/\r?\n/)[0].trim() || null;
    } catch { return null; }
  }

  async getStatus() {
    this.refresh();
    const [ytVersion, ffVersion, denoVersion] = await Promise.all([
      this.getVersion(this.ytDlpPath, ['--version']),
      this.getVersion(this.ffmpegPath, ['-version']),
      this.getVersion(this.denoPath, ['--version'])
    ]);
    return {
      ready: Boolean(this.ytDlpPath),
      complete: Boolean(this.ytDlpPath && this.ffmpegPath && this.ffprobePath && this.denoPath),
      binDir: this.binDir,
      ytDlp: { installed: Boolean(this.ytDlpPath), path: this.ytDlpPath, version: ytVersion },
      ffmpeg: { installed: Boolean(this.ffmpegPath), path: this.ffmpegPath, version: ffVersion },
      ffprobe: { installed: Boolean(this.ffprobePath), path: this.ffprobePath },
      deno: { installed: Boolean(this.denoPath), path: this.denoPath, version: denoVersion },
      platform: `${process.platform}-${process.arch}`,
      installSupported: process.platform === 'win32' && process.arch === 'x64'
    };
  }

  async install({ ytDlp = true, ffmpeg = true, deno = true } = {}) {
    if (!(ytDlp || ffmpeg || deno)) return this.getStatus();
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      throw new Error('Automatic tool installation currently supports Windows x64. On this platform, install yt-dlp, FFmpeg, and Deno separately and add them to PATH.');
    }
    const selected = [ytDlp && 'yt-dlp', ffmpeg && 'FFmpeg', deno && 'Deno'].filter(Boolean);
    let complete = 0;
    const report = (label, fraction) => this.emit('tools:progress', {
      label, progress: Math.min(100, Math.max(0, ((complete + fraction) / selected.length) * 100))
    });

    if (ytDlp) {
      const dest = path.join(this.binDir, 'yt-dlp.exe');
      const temp = `${dest}.download`;
      report('Downloading yt-dlp…', 0);
      try {
        await downloadTo(TOOL_URLS.ytDlp, temp, f => report('Downloading yt-dlp…', f * 0.9));
        report('Verifying yt-dlp checksum…', 0.94);
        const sumsResponse = await fetch(TOOL_URLS.checksums, { headers: { 'User-Agent': 'FlickFetch/2.1.0' } });
        if (!sumsResponse.ok) throw new Error('Unable to retrieve the official yt-dlp checksum list. The downloaded file was not installed.');
        const sums = await sumsResponse.text();
        const line = sums.split(/\r?\n/).find(row => /\s\*?yt-dlp\.exe\s*$/i.test(row.trim()));
        const expected = line?.trim().split(/[\s*]+/)[0];
        if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) throw new Error('The official checksum list did not contain a valid yt-dlp.exe SHA-256 entry.');
        const actual = crypto.createHash('sha256').update(fs.readFileSync(temp)).digest('hex');
        if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error('yt-dlp failed SHA-256 verification. The file was not installed.');
        replaceFile(temp, dest);
        complete++;
        report('yt-dlp installed', 0);
      } catch (error) {
        try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
        throw error;
      }
    }

    if (ffmpeg) {
      const archive = path.join(os.tmpdir(), `flickfetch-ffmpeg-${Date.now()}.zip`);
      report('Downloading FFmpeg…', 0);
      try {
        await downloadTo(TOOL_URLS.ffmpeg, archive, f => report('Downloading FFmpeg…', f * 0.9));
        report('Extracting FFmpeg…', 0.94);
        const zip = new AdmZip(archive);
        for (const wanted of ['ffmpeg.exe', 'ffprobe.exe']) {
          const entry = zip.getEntries().find(item => path.basename(item.entryName).toLowerCase() === wanted);
          if (!entry) throw new Error(`${wanted} was not found in the FFmpeg archive.`);
          const dest = path.join(this.binDir, wanted);
          const temp = `${dest}.new`;
          fs.writeFileSync(temp, entry.getData());
          replaceFile(temp, dest);
        }
        complete++;
        report('FFmpeg installed', 0);
      } finally { fs.rmSync(archive, { force: true }); }
    }

    if (deno) {
      const archive = path.join(os.tmpdir(), `flickfetch-deno-${Date.now()}.zip`);
      report('Downloading Deno…', 0);
      try {
        await downloadTo(TOOL_URLS.deno, archive, f => report('Downloading Deno…', f * 0.9));
        report('Extracting Deno…', 0.94);
        const zip = new AdmZip(archive);
        const entry = zip.getEntries().find(item => path.basename(item.entryName).toLowerCase() === 'deno.exe');
        if (!entry) throw new Error('deno.exe was not found in the Deno archive.');
        const dest = path.join(this.binDir, 'deno.exe');
        const temp = `${dest}.new`;
        fs.writeFileSync(temp, entry.getData());
        replaceFile(temp, dest);
        complete++;
        report('Deno installed', 0);
      } finally { fs.rmSync(archive, { force: true }); }
    }

    this.refresh();
    this.emit('tools:progress', { label: 'Tools ready', progress: 100 });
    return this.getStatus();
  }

  async updateYtDlp() {
    this.refresh();
    if (!this.ytDlpPath) throw new Error('yt-dlp is not installed.');
    const result = await runCapture(this.ytDlpPath, ['-U', '--color', 'never'], this.binDir, 180000);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.code !== 0) throw new Error(output || `yt-dlp update failed (exit code ${result.code}).`);
    return output || 'yt-dlp is up to date.';
  }

  async run(args, options = {}) {
    this.refresh();
    if (!this.ytDlpPath) throw new Error('yt-dlp is not installed. Open Settings → Tools to install it.');
    return runCapture(this.ytDlpPath, args, this.binDir, options.timeout || 60000);
  }
}

module.exports = { ToolManager };
