// Copyright © 2026 Jessie Albert Regualos. Application source and integration code.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace FlickFetch
{
    /// <summary>Translates the user's options into yt-dlp command-line arguments.</summary>
    public static class ArgsBuilder
    {
        public static readonly string[] PresetNames =
        {
            "Best quality (video + audio)",
            "Up to 2160p (4K)",
            "Up to 1440p",
            "Up to 1080p",
            "Up to 720p",
            "Up to 480p",
            "Up to 360p",
            "Audio only (extract)",
            "Custom format string...",
        };

        public const int PresetAudioOnly = 7;
        public const int PresetCustom = 8;
        private static readonly int[] Heights = { 0, 2160, 1440, 1080, 720, 480, 360 };

        private static readonly Regex TimeRx = new Regex(@"^(\d+:){0,2}\d+(\.\d+)?$", RegexOptions.Compiled);
        private static readonly Regex RateRx = new Regex(@"^\d+(\.\d+)?[KkMmGg]?$", RegexOptions.Compiled);
        private static readonly Regex UrlRx = new Regex(@"^(https?://\S+|ytsearch\d*:.+|ytsearchdate\d*:.+)$",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);

        public static bool IsAcceptedUrl(string s)
        {
            return !string.IsNullOrWhiteSpace(s) && UrlRx.IsMatch(s.Trim());
        }

        /// <summary>Returns an error message, or null if the settings are valid.</summary>
        public static string Validate(AppSettings s)
        {
            if (string.IsNullOrWhiteSpace(s.OutputDir)) return "Please choose an output folder.";
            if (s.Preset == PresetCustom && string.IsNullOrWhiteSpace(s.CustomFormat))
                return "Enter a custom format string (or pick another quality).";
            if (!string.IsNullOrWhiteSpace(s.SectionStart) && !TimeRx.IsMatch(s.SectionStart.Trim()))
                return "Start time must look like 90, 1:30 or 00:01:30.";
            if (!string.IsNullOrWhiteSpace(s.SectionEnd) && !TimeRx.IsMatch(s.SectionEnd.Trim()))
                return "End time must look like 90, 1:30 or 00:01:30.";
            if (!string.IsNullOrWhiteSpace(s.RateLimit) && !RateRx.IsMatch(s.RateLimit.Trim()))
                return "Speed limit must look like 500K, 2M or 1.5M.";
            if (!string.IsNullOrWhiteSpace(s.CookiesFile) && !File.Exists(s.CookiesFile.Trim()))
                return "The cookies file does not exist.";
            return null;
        }

        /// <summary>Options shared by every yt-dlp call (downloads, info, formats).</summary>
        public static List<string> BuildCommonArgs(AppSettings s, ToolManager tools)
        {
            var a = new List<string> { "--ignore-config", "--encoding", "utf-8", "--color", "never" };

            if (tools != null && !string.IsNullOrEmpty(tools.FfmpegPath))
            {
                a.Add("--ffmpeg-location");
                a.Add(tools.FfmpegPath);
            }
            if (!string.IsNullOrWhiteSpace(s.Proxy)) { a.Add("--proxy"); a.Add(s.Proxy.Trim()); }
            if (!string.IsNullOrWhiteSpace(s.CookiesFile)) { a.Add("--cookies"); a.Add(s.CookiesFile.Trim()); }
            else if (!string.IsNullOrWhiteSpace(s.CookiesBrowser)) { a.Add("--cookies-from-browser"); a.Add(s.CookiesBrowser.Trim()); }
            return a;
        }

        public static List<string> BuildDownloadArgs(AppSettings s, ToolManager tools)
        {
            var a = BuildCommonArgs(s, tools);
            bool audioOnly = s.Preset == PresetAudioOnly;

            // Machine-readable progress + file info (parsed by OutputParser)
            a.AddRange(new[]
            {
                "--quiet", "--progress", "--newline", "--windows-filenames",
                "--progress-template",
                "download:@@P|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s",
                "--progress-template",
                "postprocess:@@PP|%(progress.status)s|%(progress.postprocessor)s",
                "--print", "before_dl:@@T|%(playlist_index)s|%(n_entries)s|%(title)s",
                "--print", "after_move:@@F|%(filepath)s",
            });

            // Destination
            string template = string.IsNullOrWhiteSpace(s.Template) ? "%(title).150B [%(id)s].%(ext)s" : s.Template.Trim();
            if (s.Playlist) template = "%(playlist_title&{}/|)s%(playlist_index&{} - |)s" + template;
            a.Add("-P"); a.Add(s.OutputDir.Trim());
            a.Add("-o"); a.Add(template);
            a.Add(s.Playlist ? "--yes-playlist" : "--no-playlist");

            // Format selection
            string fmt;
            if (s.Preset >= 1 && s.Preset <= 6)
            {
                int h = Heights[s.Preset];
                fmt = "bv*[height<=?" + h + "]+ba/b[height<=?" + h + "]";
            }
            else if (audioOnly) fmt = "ba/b";
            else if (s.Preset == PresetCustom) fmt = s.CustomFormat.Trim();
            else fmt = "bv*+ba/b";
            a.Add("-f"); a.Add(fmt);

            if (audioOnly)
            {
                a.Add("-x");
                if (!string.IsNullOrWhiteSpace(s.AudioFormat) && s.AudioFormat != "best")
                { a.Add("--audio-format"); a.Add(s.AudioFormat); }
                if (!string.IsNullOrWhiteSpace(s.AudioQuality))
                { a.Add("--audio-quality"); a.Add(s.AudioQuality); }
            }
            else
            {
                string c = (s.Container ?? "auto").ToLowerInvariant();
                if (c == "mp4" || c == "mkv" || c == "webm")
                {
                    a.Add("--merge-output-format"); a.Add(c);
                    if (c != "webm") { a.Add("--remux-video"); a.Add(c); }
                }
                if (c == "mp4" && s.PreferCompat)
                { a.Add("-S"); a.Add("vcodec:h264,res,acodec:m4a"); }
            }

            // Subtitles
            if (s.Subs)
            {
                a.Add("--write-subs");
                if (s.AutoSubs) a.Add("--write-auto-subs");
                a.Add("--sub-langs");
                a.Add(string.IsNullOrWhiteSpace(s.SubLangs) ? "en.*" : s.SubLangs.Trim());
                if (s.EmbedSubs && !audioOnly) a.Add("--embed-subs");
                else { a.Add("--convert-subs"); a.Add("srt"); }
            }

            if (s.EmbedThumb) a.Add("--embed-thumbnail");
            if (s.EmbedMeta) a.Add("--embed-metadata");
            if (s.Sponsor) { a.Add("--sponsorblock-remove"); a.Add("sponsor,selfpromo,interaction,intro,outro"); }

            // Output behaviour
            if (s.Restrict) a.Add("--restrict-filenames");
            if (s.Overwrite) a.Add("--force-overwrites");
            if (s.InfoJson) a.Add("--write-info-json");
            if (s.Description) a.Add("--write-description");
            if (s.WriteThumb) { a.Add("--write-thumbnail"); a.Add("--convert-thumbnails"); a.Add("jpg"); }
            if (s.UseArchive)
            {
                Directory.CreateDirectory(AppSettings.AppDataDir);
                a.Add("--download-archive");
                a.Add(Path.Combine(AppSettings.AppDataDir, "archive.txt"));
            }

            string st = (s.SectionStart ?? "").Trim(), en = (s.SectionEnd ?? "").Trim();
            if (st.Length > 0 || en.Length > 0)
            {
                a.Add("--download-sections");
                a.Add("*" + (st.Length > 0 ? st : "0") + "-" + (en.Length > 0 ? en : "inf"));
            }

            // Network
            if (!string.IsNullOrWhiteSpace(s.RateLimit)) { a.Add("--limit-rate"); a.Add(s.RateLimit.Trim()); }
            if (s.Fragments > 1) { a.Add("--concurrent-fragments"); a.Add(s.Fragments.ToString()); }
            a.Add("--retries"); a.Add(Math.Max(0, s.Retries).ToString());
            a.Add("--fragment-retries"); a.Add(Math.Max(0, s.Retries).ToString());

            // User's own extra arguments go last so they can override anything above
            a.AddRange(SplitArgs(s.ExtraArgs));
            return a;
        }

        /// <summary>Splits a command-line string into arguments, honouring double quotes.</summary>
        public static List<string> SplitArgs(string text)
        {
            var res = new List<string>();
            if (string.IsNullOrWhiteSpace(text)) return res;
            var sb = new StringBuilder();
            bool inQuotes = false, has = false;
            foreach (char c in text)
            {
                if (c == '"') { inQuotes = !inQuotes; has = true; continue; }
                if (!inQuotes && char.IsWhiteSpace(c))
                {
                    if (has || sb.Length > 0) { res.Add(sb.ToString()); sb.Length = 0; has = false; }
                    continue;
                }
                sb.Append(c);
            }
            if (has || sb.Length > 0) res.Add(sb.ToString());
            return res;
        }
    }
}
