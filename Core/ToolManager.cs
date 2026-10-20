// Copyright © 2026 Jessie Albert Regualos. Application source and integration code.
using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace FlickFetch
{
    /// <summary>
    /// Locates and installs the external tools: yt-dlp (the engine), FFmpeg (merging / conversion)
    /// and Deno (JavaScript runtime that yt-dlp needs for YouTube).
    /// Tools live in %LocalAppData%\FlickFetch\bin, falling back to anything found on PATH.
    /// </summary>
    public class ToolManager
    {
        public const string YtDlpUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
        public const string YtDlpSumsUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS";
        public const string FfmpegUrl = "https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip";
        public const string DenoUrl = "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip";

        public static readonly HttpClient Http = CreateHttp();

        public string BinDir;
        public string YtDlpPath;
        public string FfmpegPath;
        public string DenoPath;

        public ToolManager()
        {
            BinDir = Path.Combine(AppSettings.AppDataDir, "bin");
            ExtractBundledTools();
            Refresh();
        }

        /// <summary>
        /// Release builds embed the helper executables inside FlickFetch.exe. Extract missing files
        /// into the per-user tool directory so the app remains a single-file distribution.
        /// Existing tools are preserved; the explicit reinstall action can replace them later.
        /// </summary>
        private void ExtractBundledTools()
        {
            string[] tools = { "yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe", "deno.exe" };
            try { Directory.CreateDirectory(BinDir); }
            catch (Exception ex) { LogBootstrap("Unable to create tools directory: " + ex.Message); return; }

            Assembly assembly = Assembly.GetExecutingAssembly();
            string[] resources = assembly.GetManifestResourceNames();
            string[] toolResources = tools.Select(tool => resources.FirstOrDefault(n =>
                n.EndsWith(".BundledTools." + tool, StringComparison.OrdinalIgnoreCase))).ToArray();
            if (!toolResources.Any(n => n != null))
            {
                LogBootstrap("This build has no embedded downloader tools. Use Settings to install components.");
                return;
            }

            string assemblyVersion = assembly.GetName().Version == null ? "unknown" : assembly.GetName().Version.ToString();
            string bundleVersion = GetEmbeddedBundleFingerprint(assembly, assemblyVersion);
            string markerPath = Path.Combine(BinDir, ".bundle-version");
            string installedVersion = null;
            try { if (File.Exists(markerPath)) installedVersion = File.ReadAllText(markerPath).Trim(); } catch { }
            bool refreshBundle = !string.Equals(installedVersion, bundleVersion, StringComparison.Ordinal);
            bool allSuccessful = true;

            for (int i = 0; i < tools.Length; i++)
            {
                string tool = tools[i];
                string destination = Path.Combine(BinDir, tool);
                string resourceName = toolResources[i];
                if (resourceName == null)
                {
                    LogBootstrap("No embedded payload found for " + tool + ".");
                    allSuccessful = false;
                    continue;
                }

                try
                {
                    if (!refreshBundle && File.Exists(destination) && new FileInfo(destination).Length > 0) continue;
                    using (Stream resource = assembly.GetManifestResourceStream(resourceName))
                    {
                        if (resource == null) throw new InvalidDataException("Unable to read embedded payload " + resourceName + ".");
                        string temporary = destination + ".bundled-new";
                        using (var output = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
                            resource.CopyTo(output);
                        if (new FileInfo(temporary).Length == 0)
                        {
                            File.Delete(temporary);
                            throw new InvalidDataException("Embedded file was empty.");
                        }
                        ReplaceFile(temporary, destination);
                        LogBootstrap("Extracted embedded tool: " + tool + " (" + new FileInfo(destination).Length + " bytes).");
                    }
                }
                catch (Exception ex)
                {
                    allSuccessful = false;
                    LogBootstrap("Could not extract " + tool + ": " + ex.Message);
                }
            }

            // Refresh bundled helper tools when the embedded manifest changes, while preserving
            // explicit Settings > Install/Update actions during ordinary launches of the same bundle.
            if (allSuccessful)
            {
                try { File.WriteAllText(markerPath, bundleVersion); }
                catch (Exception ex) { LogBootstrap("Unable to save bundled-tool version marker: " + ex.Message); }
            }
        }

        private static string GetEmbeddedBundleFingerprint(Assembly assembly, string fallbackVersion)
        {
            // The assembly version may remain unchanged across development/release rebuilds.
            // Prefer the generated manifest's stable tool-version/hash lines so newer embedded
            // yt-dlp/FFmpeg/Deno payloads replace stale per-user copies even when app version stays the same.
            string manifestName = assembly.GetManifestResourceNames().FirstOrDefault(n =>
                n.EndsWith(".BundledTools.manifest.txt", StringComparison.OrdinalIgnoreCase));
            if (manifestName == null) return fallbackVersion;

            try
            {
                using (Stream stream = assembly.GetManifestResourceStream(manifestName))
                {
                    if (stream == null) return fallbackVersion;
                    using (var reader = new StreamReader(stream, Encoding.UTF8, true, 4096, false))
                    {
                        string[] lines = reader.ReadToEnd().Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries);
                        string canonical = string.Join("\n", lines
                            .Select(line => line.Trim())
                            .Where(line => line.Length > 0 && !line.StartsWith("Built:", StringComparison.OrdinalIgnoreCase)));
                        using (SHA256 sha = SHA256.Create())
                        {
                            byte[] digest = sha.ComputeHash(Encoding.UTF8.GetBytes(canonical));
                            string hash = BitConverter.ToString(digest).Replace("-", "").ToLowerInvariant();
                            return fallbackVersion + ":" + hash;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                LogBootstrap("Unable to fingerprint bundled-tool manifest: " + ex.Message);
                return fallbackVersion;
            }
        }

        private static void LogBootstrap(string message)
        {
            try
            {
                string folder = Path.Combine(AppSettings.AppDataDir, "logs");
                Directory.CreateDirectory(folder);
                File.AppendAllText(Path.Combine(folder, "startup.log"), DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message + Environment.NewLine);
            }
            catch { }
        }

        private static HttpClient CreateHttp()
        {
            var h = new HttpClient(new HttpClientHandler { AllowAutoRedirect = true });
            h.Timeout = TimeSpan.FromMinutes(30);
            h.DefaultRequestHeaders.UserAgent.ParseAdd("FlickFetch/1.0.0");
            return h;
        }

        public bool HasYtDlp { get { return !string.IsNullOrEmpty(YtDlpPath) && File.Exists(YtDlpPath); } }
        public bool HasFfmpeg { get { return !string.IsNullOrEmpty(FfmpegPath) && File.Exists(FfmpegPath); } }
        public bool HasDeno { get { return !string.IsNullOrEmpty(DenoPath) && File.Exists(DenoPath); } }

        public void Refresh()
        {
            YtDlpPath = Find("yt-dlp.exe");
            FfmpegPath = Find("ffmpeg.exe");
            DenoPath = Find("deno.exe");
        }

        private string Find(string fileName)
        {
            string own = Path.Combine(BinDir, fileName);
            if (File.Exists(own)) return own;
            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string dir in path.Split(Path.PathSeparator))
            {
                try
                {
                    if (string.IsNullOrWhiteSpace(dir)) continue;
                    string c = Path.Combine(dir.Trim().Trim('"'), fileName);
                    if (File.Exists(c)) return c;
                }
                catch { }
            }
            return null;
        }

        // ------------------------------------------------------------------ versions / update

        public async Task<string> GetYtDlpVersionAsync()
        {
            if (!HasYtDlp) return null;
            try
            {
                CaptureResult r = await ProcessRunner.CaptureAsync(YtDlpPath, new[] { "--version" }, BinDir, 30000).ConfigureAwait(false);
                return r.ExitCode == 0 ? r.Stdout.Trim() : null;
            }
            catch { return null; }
        }

        public async Task<string> GetFfmpegVersionAsync()
        {
            if (!HasFfmpeg) return null;
            try
            {
                CaptureResult r = await ProcessRunner.CaptureAsync(FfmpegPath, new[] { "-version" }, BinDir, 15000).ConfigureAwait(false);
                if (r.ExitCode != 0) return null;
                string first = r.Stdout.Split('\n')[0].Trim();
                return first;
            }
            catch { return null; }
        }

        /// <summary>Runs "yt-dlp -U" and returns the console output.</summary>
        public async Task<string> UpdateYtDlpAsync()
        {
            if (!HasYtDlp) return "yt-dlp is not installed.";
            CaptureResult r = await ProcessRunner.CaptureAsync(YtDlpPath, new[] { "-U", "--color", "never" }, BinDir, 180000).ConfigureAwait(false);
            string text = (r.Stdout + "\n" + r.Stderr).Trim();
            return text.Length == 0 ? "(no output, exit code " + r.ExitCode + ")" : text;
        }

        // ------------------------------------------------------------------ installation

        public async Task InstallAsync(bool ytdlp, bool ffmpeg, bool deno, Action<string, double> report, CancellationToken ct)
        {
            Directory.CreateDirectory(BinDir);
            int total = (ytdlp ? 1 : 0) + (ffmpeg ? 1 : 0) + (deno ? 1 : 0);
            if (total == 0) return;
            int done = 0;
            Action<string, double> step = (msg, frac) =>
            {
                if (report != null) report(msg, (done + Math.Max(0.0, Math.Min(1.0, frac))) / total);
            };

            if (ytdlp) { await InstallYtDlpAsync(step, ct).ConfigureAwait(false); done++; }
            if (ffmpeg) { await InstallZipAsync(FfmpegUrl, "FFmpeg", new[] { "ffmpeg.exe", "ffprobe.exe" }, step, ct).ConfigureAwait(false); done++; }
            if (deno) { await InstallZipAsync(DenoUrl, "Deno", new[] { "deno.exe" }, step, ct).ConfigureAwait(false); done++; }

            Refresh();
            if (report != null) report("Done", 1.0);
        }

        private async Task InstallYtDlpAsync(Action<string, double> step, CancellationToken ct)
        {
            string dest = Path.Combine(BinDir, "yt-dlp.exe");
            string tmp = dest + ".download";
            step("Downloading yt-dlp...", 0);
            await DownloadToAsync(YtDlpUrl, tmp, f => step("Downloading yt-dlp...", f * 0.95), ct).ConfigureAwait(false);

            // Do not install an unverified executable if the official checksum cannot be obtained.
            string expected = null;
            try
            {
                string sums = await Http.GetStringAsync(YtDlpSumsUrl).ConfigureAwait(false);
                foreach (string line in sums.Split('\n'))
                {
                    string[] parts = line.Trim().Split(new[] { ' ', '*' }, StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length >= 2 && string.Equals(parts[1], "yt-dlp.exe", StringComparison.OrdinalIgnoreCase)) expected = parts[0];
                }
            }
            catch (Exception ex)
            {
                try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
                throw new InvalidOperationException("Could not retrieve the official yt-dlp SHA-256 checksum. The downloaded executable was not installed. Check your internet connection and retry.", ex);
            }

            if (string.IsNullOrWhiteSpace(expected) || expected.Length != 64 || expected.Any(c => !Uri.IsHexDigit(c)))
            {
                try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
                throw new InvalidDataException("The official yt-dlp checksum list did not contain a valid SHA-256 entry for yt-dlp.exe. The file was not installed.");
            }

            string actual;
            using (var sha = SHA256.Create())
            using (var fs = File.OpenRead(tmp))
                actual = BitConverter.ToString(sha.ComputeHash(fs)).Replace("-", "").ToLowerInvariant();
            if (!string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase))
            {
                try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
                throw new InvalidDataException("yt-dlp download failed its SHA-256 check. Please try again.");
            }

            ReplaceFile(tmp, dest);
            step("yt-dlp installed", 1);
        }

        private async Task InstallZipAsync(string url, string name, string[] wanted, Action<string, double> step, CancellationToken ct)
        {
            string tmp = Path.Combine(Path.GetTempPath(), "FlickFetch_" + Guid.NewGuid().ToString("N") + ".zip");
            try
            {
                step("Downloading " + name + "...", 0);
                await DownloadToAsync(url, tmp, f => step("Downloading " + name + "...", f * 0.9), ct).ConfigureAwait(false);
                step("Extracting " + name + "...", 0.92);
                using (ZipArchive zip = ZipFile.OpenRead(tmp))
                {
                    foreach (string want in wanted)
                    {
                        ZipArchiveEntry entry = zip.Entries.FirstOrDefault(e =>
                            string.Equals(Path.GetFileName(e.FullName), want, StringComparison.OrdinalIgnoreCase));
                        if (entry == null) throw new FileNotFoundException(want + " was not found inside the " + name + " archive.");
                        string dest = Path.Combine(BinDir, want);
                        string part = dest + ".new";
                        entry.ExtractToFile(part, true);
                        ReplaceFile(part, dest);
                    }
                }
                step(name + " installed", 1);
            }
            finally
            {
                try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
            }
        }

        private static void ReplaceFile(string source, string dest)
        {
            if (!File.Exists(dest))
            {
                File.Move(source, dest);
                return;
            }

            try
            {
                File.Replace(source, dest, null);
                return;
            }
            catch (PlatformNotSupportedException) { }
            catch (IOException) { }

            string backup = dest + ".replace-backup";
            try
            {
                if (File.Exists(backup)) File.Delete(backup);
                File.Move(dest, backup);
                try
                {
                    File.Move(source, dest);
                    File.Delete(backup);
                }
                catch
                {
                    if (!File.Exists(dest) && File.Exists(backup)) File.Move(backup, dest);
                    throw;
                }
            }
            finally
            {
                try { if (File.Exists(backup) && File.Exists(dest)) File.Delete(backup); } catch { }
            }
        }

        private static async Task DownloadToAsync(string url, string path, Action<double> progress, CancellationToken ct)
        {
            using (HttpResponseMessage resp = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false))
            {
                resp.EnsureSuccessStatusCode();
                long total = resp.Content.Headers.ContentLength ?? -1;
                using (Stream src = await resp.Content.ReadAsStreamAsync().ConfigureAwait(false))
                using (var fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true))
                {
                    var buf = new byte[81920];
                    long read = 0;
                    int n;
                    while ((n = await src.ReadAsync(buf, 0, buf.Length, ct).ConfigureAwait(false)) > 0)
                    {
                        await fs.WriteAsync(buf, 0, n, ct).ConfigureAwait(false);
                        read += n;
                        if (progress != null && total > 0) progress((double)read / total);
                    }
                }
            }
        }
    }
}
