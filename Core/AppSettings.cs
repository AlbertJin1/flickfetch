// Copyright © 2026 Jessie Albert Regualos. Application source and integration code.
using System;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;

namespace FlickFetch
{
    /// <summary>All user options. Persisted as a simple key=value file (no external dependencies).</summary>
    public class AppSettings
    {
        // ---- Format ----
        public string OutputDir { get; set; } = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.MyVideos), "FlickFetch");
        public int Preset { get; set; } = 0;              // see ArgsBuilder.PresetNames
        public string CustomFormat { get; set; } = "";
        public string Container { get; set; } = "mp4";    // auto | mp4 | mkv | webm
        public bool PreferCompat { get; set; } = false;   // prefer H.264/AAC when container is mp4
        public string AudioFormat { get; set; } = "mp3";
        public string AudioQuality { get; set; } = "0";   // 0 = best, or e.g. 192K
        public bool Playlist { get; set; } = false;

        // ---- Extras ----
        public bool Subs { get; set; } = false;
        public bool AutoSubs { get; set; } = false;
        public bool EmbedSubs { get; set; } = true;
        public string SubLangs { get; set; } = "en.*";
        public bool EmbedThumb { get; set; } = true;
        public bool EmbedMeta { get; set; } = true;
        public bool Sponsor { get; set; } = false;

        // ---- Output ----
        public string Template { get; set; } = "%(title).150B [%(id)s].%(ext)s";
        public bool Restrict { get; set; } = false;
        public bool Overwrite { get; set; } = false;
        public bool InfoJson { get; set; } = false;
        public bool Description { get; set; } = false;
        public bool WriteThumb { get; set; } = false;
        public bool UseArchive { get; set; } = false;
        public string SectionStart { get; set; } = "";
        public string SectionEnd { get; set; } = "";

        // ---- Network ----
        public string CookiesBrowser { get; set; } = "";
        public string CookiesFile { get; set; } = "";
        public string Proxy { get; set; } = "";
        public string RateLimit { get; set; } = "";
        public int Fragments { get; set; } = 4;
        public int Retries { get; set; } = 10;
        public int Parallel { get; set; } = 2;

        // ---- Advanced / app ----
        public string ExtraArgs { get; set; } = "";
        public bool AutoStart { get; set; } = true;
        public bool WatchClipboard { get; set; } = false;
        public bool AutoUpdate { get; set; } = true;

        // Spotify public playlist matching reads public embed metadata and does not
        // require Spotify app credentials, OAuth, or any saved account settings.

        // ------------------------------------------------------------------
        public static string AppDataDir
        {
            get
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FlickFetch");
            }
        }

        public static string FilePath { get { return Path.Combine(AppDataDir, "settings.ini"); } }

        public static AppSettings Load()
        {
            var s = new AppSettings();
            try
            {
                if (!File.Exists(FilePath)) return s;
                foreach (var line in File.ReadAllLines(FilePath, Encoding.UTF8))
                {
                    int i = line.IndexOf('=');
                    if (i <= 0) continue;
                    string key = line.Substring(0, i).Trim();
                    string val = Unescape(line.Substring(i + 1));
                    PropertyInfo p = typeof(AppSettings).GetProperty(key, BindingFlags.Public | BindingFlags.Instance);
                    if (p == null || !p.CanWrite) continue;
                    try
                    {
                        if (p.PropertyType == typeof(string)) p.SetValue(s, val, null);
                        else if (p.PropertyType == typeof(int)) p.SetValue(s, int.Parse(val, CultureInfo.InvariantCulture), null);
                        else if (p.PropertyType == typeof(bool)) p.SetValue(s, bool.Parse(val), null);
                    }
                    catch { /* ignore a bad value, keep default */ }
                }
            }
            catch { }
            return s;
        }

        public void Save()
        {
            try
            {
                Directory.CreateDirectory(AppDataDir);
                var sb = new StringBuilder();
                foreach (PropertyInfo p in typeof(AppSettings).GetProperties(BindingFlags.Public | BindingFlags.Instance))
                {
                    object v = p.GetValue(this, null);
                    string text = v is bool ? ((bool)v ? "true" : "false")
                        : v is int ? ((int)v).ToString(CultureInfo.InvariantCulture)
                        : (v as string ?? "");
                    sb.Append(p.Name).Append('=').Append(Escape(text)).Append('\n');
                }
                File.WriteAllText(FilePath, sb.ToString(), new UTF8Encoding(false));
            }
            catch { }
        }

        private static string Escape(string s)
        {
            return s.Replace("\\", "\\\\").Replace("\r", "").Replace("\n", "\\n");
        }

        private static string Unescape(string s)
        {
            var sb = new StringBuilder();
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (c == '\\' && i + 1 < s.Length)
                {
                    char n = s[++i];
                    sb.Append(n == 'n' ? '\n' : n);
                }
                else sb.Append(c);
            }
            return sb.ToString();
        }
    }
}
