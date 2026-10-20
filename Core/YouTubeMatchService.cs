// Copyright © 2026 Jessie Albert Regualos. Application source and integration code.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace FlickFetch
{
    public sealed class YouTubeMatch
    {
        public string Title { get; set; } = "";
        public string Channel { get; set; } = "";
        public string Url { get; set; } = "";
        public double DurationSeconds { get; set; } = -1;
        public int Score { get; set; }
        public bool LikelyMusicVideo { get; set; }
        public string MatchLabel { get; set; } = "Review";
    }

    /// <summary>
    /// Finds candidate YouTube pages for a Spotify track using yt-dlp's search extractor.
    /// Results are ranked heuristically; users must review them. This service never downloads media.
    /// </summary>
    public static class YouTubeMatchService
    {
        private const int SearchResultCount = 10;
        private static readonly Regex MusicVideoRegex = new Regex(
            @"\b(official\s+)?(music\s+video|video\s+official|official\s+video|mv)\b|\b4k\s+(music\s+)?video\b",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);
        private static readonly Regex LiveRegex = new Regex(
            @"\b(live|concert|performance|session|stage\s+version)\b",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);
        private static readonly Regex VisualizerRegex = new Regex(
            @"\b(visuali[sz]er|dance\s+video|reaction|karaoke|instrumental)\b",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);
        private static readonly Regex AudioSignalRegex = new Regex(
            @"\b(official\s+audio|audio\s+only|provided\s+to\s+youtube\s+by|lyrics?)\b",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);
        private static readonly HashSet<string> StopWords = new HashSet<string>(StringComparer.Ordinal)
        {
            "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "by",
            "feat", "featuring", "ft", "official", "audio", "video", "lyrics", "lyric", "topic"
        };

        public static async Task<YouTubeMatch> FindBestMatchAsync(SpotifyTrack track, ToolManager tools, CancellationToken cancellationToken)
        {
            if (track == null) throw new ArgumentNullException(nameof(track));
            if (tools == null || !tools.HasYtDlp)
                throw new InvalidOperationException("yt-dlp is not installed. Open Settings → Tools and install or repair the downloader tools first.");
            if (string.IsNullOrWhiteSpace(track.Title))
                throw new InvalidOperationException("This playlist item has no searchable title.");

            cancellationToken.ThrowIfCancellationRequested();
            string artist = (track.Artist ?? "").Trim();
            string title = track.Title.Trim();
            string query = (artist.Length == 0 ? title : artist + " " + title) + " official audio";
            var args = new List<string>
            {
                "--ignore-config", "--encoding", "utf-8", "--color", "never",
                "--quiet", "--no-warnings", "--ignore-errors", "--skip-download",
                "--flat-playlist", "--dump-single-json",
                "ytsearch" + SearchResultCount.ToString(CultureInfo.InvariantCulture) + ":" + query
            };

            CaptureResult capture = await ProcessRunner.CaptureAsync(
                tools.YtDlpPath, args, tools.BinDir, 45000, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (capture.ExitCode != 0 && string.IsNullOrWhiteSpace(capture.Stdout))
            {
                string detail = (capture.Stderr ?? "").Trim();
                if (detail.Length > 420) detail = detail.Substring(0, 420) + "…";
                throw new InvalidOperationException("YouTube search failed" + (detail.Length == 0 ? "." : ": " + detail));
            }

            List<YouTubeMatch> candidates = ParseCandidates(capture.Stdout);
            if (candidates.Count == 0)
                throw new InvalidOperationException("YouTube did not return any usable search results for this track.");

            foreach (YouTubeMatch candidate in candidates)
                Rank(track, candidate);

            return candidates
                .OrderByDescending(c => c.Score)
                .ThenBy(c => c.LikelyMusicVideo)
                .First();
        }

        private static List<YouTubeMatch> ParseCandidates(string json)
        {
            var results = new List<YouTubeMatch>();
            if (string.IsNullOrWhiteSpace(json)) return results;
            using (JsonDocument document = JsonDocument.Parse(json))
            {
                JsonElement root = document.RootElement;
                if (!root.TryGetProperty("entries", out JsonElement entries) || entries.ValueKind != JsonValueKind.Array)
                    return results;

                foreach (JsonElement entry in entries.EnumerateArray())
                {
                    string id = ReadString(entry, "id");
                    string title = ReadString(entry, "title");
                    string url = ReadString(entry, "webpage_url");
                    if (url.Length == 0) url = ReadString(entry, "original_url");
                    if (url.Length == 0) url = ReadString(entry, "url");
                    if (url.Length == 0 && id.Length == 11) url = "https://www.youtube.com/watch?v=" + id;
                    if (url.StartsWith("/watch?", StringComparison.Ordinal)) url = "https://www.youtube.com" + url;
                    if (url.Length == 0 || title.Length == 0) continue;

                    // Avoid exposing extractor-internal or non-watch URLs as clickable matches.
                    if (!Uri.TryCreate(url, UriKind.Absolute, out Uri parsed) ||
                        (parsed.Host != "youtube.com" && !parsed.Host.EndsWith(".youtube.com", StringComparison.OrdinalIgnoreCase) &&
                         parsed.Host != "youtu.be" && !parsed.Host.EndsWith(".youtube-nocookie.com", StringComparison.OrdinalIgnoreCase)))
                    {
                        if (id.Length != 11) continue;
                        url = "https://www.youtube.com/watch?v=" + id;
                    }

                    results.Add(new YouTubeMatch
                    {
                        Title = title,
                        Channel = FirstNonEmpty(ReadString(entry, "channel"), ReadString(entry, "uploader"), ReadString(entry, "channel_title")),
                        Url = url,
                        DurationSeconds = ReadDuration(entry)
                    });
                }
            }
            return results;
        }

        private static void Rank(SpotifyTrack track, YouTubeMatch candidate)
        {
            string sourceTitle = Normalize(track.Title);
            string candidateTitle = Normalize(candidate.Title);
            string artist = Normalize(track.Artist);
            string channel = Normalize(candidate.Channel);
            string combined = (candidateTitle + " " + channel).Trim();

            double titleCoverage = TokenCoverage(sourceTitle, candidateTitle);
            double artistCoverage = TokenCoverage(artist, combined);
            int score = (int)Math.Round(titleCoverage * 48 + artistCoverage * 32, MidpointRounding.AwayFromZero);

            if (track.DurationMilliseconds > 0 && candidate.DurationSeconds > 0)
            {
                double delta = Math.Abs(track.DurationMilliseconds / 1000.0 - candidate.DurationSeconds);
                if (delta <= 2.5) score += 18;
                else if (delta <= 6) score += 14;
                else if (delta <= 12) score += 9;
                else if (delta <= 25) score += 3;
                else score -= 12;
            }

            bool topicChannel = (candidate.Channel ?? "").IndexOf("- Topic", StringComparison.OrdinalIgnoreCase) >= 0;
            bool audioSignal = AudioSignalRegex.IsMatch(candidate.Title) ||
                               (candidate.Title ?? "").IndexOf("provided to YouTube by", StringComparison.OrdinalIgnoreCase) >= 0;
            candidate.LikelyMusicVideo = MusicVideoRegex.IsMatch(candidate.Title) ||
                Regex.IsMatch(candidate.Channel ?? "", @"\bvevo\b", RegexOptions.IgnoreCase);
            bool live = LiveRegex.IsMatch(candidate.Title);
            bool visualizer = VisualizerRegex.IsMatch(candidate.Title);

            if (topicChannel) score += 14;
            if (audioSignal) score += 12;
            if (candidate.LikelyMusicVideo) score -= 42;
            if (live) score -= 28;
            if (visualizer) score -= 18;

            candidate.Score = Math.Max(0, Math.Min(100, score));
            string kind = candidate.LikelyMusicVideo ? "video — review" :
                          (topicChannel || audioSignal) ? "audio signal" : "review";
            candidate.MatchLabel = candidate.Score >= 80 ? "Strong · " + kind :
                                   candidate.Score >= 62 ? "Good · " + kind : "Review · " + kind;
        }

        private static double TokenCoverage(string target, string candidate)
        {
            HashSet<string> targetTokens = Tokens(target);
            if (targetTokens.Count == 0) return 0;
            HashSet<string> candidateTokens = Tokens(candidate);
            return (double)targetTokens.Count(candidateTokens.Contains) / targetTokens.Count;
        }

        private static HashSet<string> Tokens(string value)
        {
            return new HashSet<string>(Regex.Split(Normalize(value), @"[^a-z0-9]+")
                .Where(token => token.Length > 1 && !StopWords.Contains(token)), StringComparer.Ordinal);
        }

        private static string Normalize(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "";
            string decomposed = value.Normalize(NormalizationForm.FormD);
            var builder = new StringBuilder(decomposed.Length);
            foreach (char c in decomposed)
            {
                if (CharUnicodeInfo.GetUnicodeCategory(c) == UnicodeCategory.NonSpacingMark) continue;
                builder.Append(char.IsLetterOrDigit(c) ? char.ToLowerInvariant(c) : ' ');
            }
            return Regex.Replace(builder.ToString(), @"\s+", " ").Trim();
        }

        private static double ReadDuration(JsonElement element)
        {
            if (element.TryGetProperty("duration", out JsonElement duration) &&
                duration.ValueKind == JsonValueKind.Number && duration.TryGetDouble(out double seconds)) return seconds;
            string value = ReadString(element, "duration_string");
            if (value.Length == 0) return -1;
            string[] parts = value.Split(':');
            double total = 0;
            foreach (string part in parts)
            {
                if (!double.TryParse(part, NumberStyles.Float, CultureInfo.InvariantCulture, out double number)) return -1;
                total = total * 60 + number;
            }
            return total;
        }

        private static string ReadString(JsonElement element, string name)
        {
            try
            {
                if (!element.TryGetProperty(name, out JsonElement value) || value.ValueKind != JsonValueKind.String) return "";
                return value.GetString() ?? "";
            }
            catch { return ""; }
        }

        private static string FirstNonEmpty(params string[] values)
        {
            return values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value)) ?? "";
        }
    }
}
