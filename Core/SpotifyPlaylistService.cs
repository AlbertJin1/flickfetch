// Copyright © 2026 Jessie Albert Regualos. Application source and integration code.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.ComponentModel;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace FlickFetch
{
    public sealed class SpotifyTrack : INotifyPropertyChanged
    {
        private string _youTubeMatchTitle = "";
        private string _youTubeMatchChannel = "";
        private string _youTubeMatchUrl = "";
        private string _youTubeMatchScoreText = "";
        private string _youTubeMatchNote = "";

        public event PropertyChangedEventHandler PropertyChanged;

        public int Number { get; set; }
        public string Title { get; set; } = "";
        public string Artist { get; set; } = "";
        public string Album { get; set; } = "";
        public int DurationMilliseconds { get; set; }
        public string SpotifyUrl { get; set; } = "";

        public string YouTubeMatchTitle
        {
            get => _youTubeMatchTitle;
            set { if (_youTubeMatchTitle != value) { _youTubeMatchTitle = value ?? ""; Raise(nameof(YouTubeMatchTitle)); Raise(nameof(YouTubeMatchDisplay)); } }
        }
        public string YouTubeMatchChannel
        {
            get => _youTubeMatchChannel;
            set { if (_youTubeMatchChannel != value) { _youTubeMatchChannel = value ?? ""; Raise(nameof(YouTubeMatchChannel)); Raise(nameof(YouTubeMatchDisplay)); } }
        }
        public string YouTubeMatchUrl
        {
            get => _youTubeMatchUrl;
            set { if (_youTubeMatchUrl != value) { _youTubeMatchUrl = value ?? ""; Raise(nameof(YouTubeMatchUrl)); } }
        }
        public string YouTubeMatchScoreText
        {
            get => _youTubeMatchScoreText;
            set { if (_youTubeMatchScoreText != value) { _youTubeMatchScoreText = value ?? ""; Raise(nameof(YouTubeMatchScoreText)); } }
        }
        public string YouTubeMatchNote
        {
            get => _youTubeMatchNote;
            set { if (_youTubeMatchNote != value) { _youTubeMatchNote = value ?? ""; Raise(nameof(YouTubeMatchNote)); Raise(nameof(YouTubeMatchDisplay)); } }
        }

        public string YouTubeMatchDisplay
        {
            get
            {
                if (!string.IsNullOrWhiteSpace(YouTubeMatchTitle))
                    return string.IsNullOrWhiteSpace(YouTubeMatchChannel) ? YouTubeMatchTitle : YouTubeMatchTitle + " — " + YouTubeMatchChannel;
                return string.IsNullOrWhiteSpace(YouTubeMatchNote) ? "Waiting for search" : YouTubeMatchNote;
            }
        }

        public string DurationText
        {
            get
            {
                if (DurationMilliseconds <= 0) return "—";
                TimeSpan t = TimeSpan.FromMilliseconds(DurationMilliseconds);
                return t.TotalHours >= 1
                    ? ((int)t.TotalHours).ToString(CultureInfo.InvariantCulture) + ":" + t.Minutes.ToString("00", CultureInfo.InvariantCulture) + ":" + t.Seconds.ToString("00", CultureInfo.InvariantCulture)
                    : ((int)t.TotalMinutes).ToString(CultureInfo.InvariantCulture) + ":" + t.Seconds.ToString("00", CultureInfo.InvariantCulture);
            }
        }

        private void Raise(string propertyName) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }

    public sealed class SpotifyPlaylist
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "Spotify playlist";
        public string Owner { get; set; } = "";
        public string Url { get; set; } = "";
        public List<SpotifyTrack> Tracks { get; } = new List<SpotifyTrack>();
    }

    /// <summary>
    /// Reads the track metadata Spotify exposes on public playlist embed pages.
    /// This avoids Spotify Developer Dashboard setup, API credentials, and OAuth.
    /// The embed page is an unofficial surface and may change; private playlists
    /// and tracks not exposed in the embed are not supported.
    /// </summary>
    public static class SpotifyPlaylistService
    {
        private static readonly HttpClient Client = CreateClient();
        private static readonly Regex PlaylistPathRegex = new Regex(
            @"^/(?:embed/)?(?:intl-[a-z]{2}/)?playlist/(?<id>[A-Za-z0-9]{10,40})/?$",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);
        private static readonly Regex PlaylistUriRegex = new Regex(
            @"^spotify:playlist:(?<id>[A-Za-z0-9]{10,40})$",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);
        private static readonly Regex NextDataRegex = new Regex(
            "<script[^>]*id=[\"']__NEXT_DATA__[\"'][^>]*>(?<json>.*?)</script>",
            RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.Compiled);

        private static HttpClient CreateClient()
        {
            var handler = new HttpClientHandler { AllowAutoRedirect = true, AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate | DecompressionMethods.Brotli };
            var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(30) };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36");
            client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("text/html"));
            client.DefaultRequestHeaders.AcceptLanguage.ParseAdd("en-US,en;q=0.9");
            return client;
        }

        public static bool TryGetPlaylistId(string url, out string id)
        {
            id = "";
            string value = (url ?? "").Trim();
            if (value.Length == 0) return false;
            Match uriMatch = PlaylistUriRegex.Match(value);
            if (uriMatch.Success) { id = uriMatch.Groups["id"].Value; return true; }
            if (!Uri.TryCreate(value, UriKind.Absolute, out Uri uri) ||
                !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)) return false;
            string host = uri.Host.ToLowerInvariant();
            if (host != "open.spotify.com" && host != "spotify.link" && !host.EndsWith(".spotify.link", StringComparison.Ordinal) &&
                host != "spotify.app.link" && !host.EndsWith(".spotify.app.link", StringComparison.Ordinal)) return false;
            Match pathMatch = PlaylistPathRegex.Match(uri.AbsolutePath);
            if (!pathMatch.Success) return false;
            id = pathMatch.Groups["id"].Value;
            return id.Length > 0;
        }

        public static bool CanImportPlaylistUrl(string url)
        {
            if (TryGetPlaylistId(url, out _)) return true;
            if (!Uri.TryCreate((url ?? "").Trim(), UriKind.Absolute, out Uri uri) ||
                !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)) return false;
            string host = uri.Host.ToLowerInvariant();
            return host == "spotify.link" || host.EndsWith(".spotify.link", StringComparison.Ordinal) ||
                   host == "spotify.app.link" || host.EndsWith(".spotify.app.link", StringComparison.Ordinal);
        }

        public static async Task<SpotifyPlaylist> FetchAsync(string url)
        {
            string playlistId = "";
            string original = (url ?? "").Trim();
            if (TryGetPlaylistId(original, out string directId)) playlistId = directId;
            else
            {
                if (!CanImportPlaylistUrl(original))
                    throw new InvalidOperationException("Paste a public Spotify playlist URL, for example https://open.spotify.com/playlist/…");
                using (HttpResponseMessage shortLinkResponse = await Client.GetAsync(original, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false))
                {
                    string finalUrl = shortLinkResponse.RequestMessage?.RequestUri?.AbsoluteUri ?? "";
                    if (!TryGetPlaylistId(finalUrl, out playlistId))
                        throw new InvalidOperationException("This share link did not resolve to a Spotify playlist. Check that it is a playlist link rather than a track or album.");
                }
            }

            string playlistUrl = "https://open.spotify.com/playlist/" + playlistId;
            string embedUrl = "https://open.spotify.com/embed/playlist/" + playlistId + "?utm_source=generator&theme=0";
            using HttpResponseMessage response = await Client.GetAsync(embedUrl).ConfigureAwait(false);
            string html = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
                throw new InvalidOperationException("Spotify did not return this public playlist (HTTP " + (int)response.StatusCode + "). The playlist may be private, unavailable, or temporarily blocked.");

            Match match = NextDataRegex.Match(html ?? "");
            if (!match.Success)
                throw new InvalidOperationException("Spotify did not expose playlist data on its public embed page. This may happen for private playlists or when Spotify changes its page format. No Spotify app or sign-in is required by FlickFetch.");

            using JsonDocument document = JsonDocument.Parse(WebUtility.HtmlDecode(match.Groups["json"].Value));
            JsonElement root = document.RootElement;
            JsonElement entity = FindObjectContainingArray(root, "trackList");
            if (entity.ValueKind != JsonValueKind.Object)
                throw new InvalidOperationException("No track list was present in Spotify's public embed page. Try a public playlist or export its track list to CSV.");

            var playlist = new SpotifyPlaylist
            {
                Id = playlistId,
                Url = playlistUrl,
                Name = ReadAnyString(entity, "title", "name", "nameText", "headerText", fallback: "Spotify playlist"),
                Owner = ReadAnyString(entity, "subtitle", "ownerName", "creator", fallback: "Public Spotify playlist")
            };
            JsonElement trackList = GetPropertyIgnoreCase(entity, "trackList");
            AddTracks(playlist, trackList);
            if (playlist.Tracks.Count == 0)
                throw new InvalidOperationException("The embed page contained a playlist but did not expose readable tracks. Spotify may have changed the page format or the playlist may not be public.");
            return playlist;
        }

        private static void AddTracks(SpotifyPlaylist playlist, JsonElement trackList)
        {
            IEnumerable<JsonElement> entries = trackList.ValueKind == JsonValueKind.Array
                ? trackList.EnumerateArray().ToArray()
                : trackList.ValueKind == JsonValueKind.Object && GetPropertyIgnoreCase(trackList, "items").ValueKind == JsonValueKind.Array
                    ? GetPropertyIgnoreCase(trackList, "items").EnumerateArray().ToArray()
                    : Enumerable.Empty<JsonElement>();

            int number = 0;
            foreach (JsonElement row in entries)
            {
                string title = ReadAnyString(row, "title", "name", fallback: "");
                if (string.IsNullOrWhiteSpace(title)) continue;
                string artist = ReadAnyString(row, "subtitle", "artist", "artists", "byline", fallback: "Unknown artist");
                string uri = ReadAnyString(row, "uri", "spotifyUri", fallback: "");
                string spotifyUrl = ReadAnyString(row, "externalUrl", "url", fallback: "");
                if (uri.StartsWith("spotify:track:", StringComparison.OrdinalIgnoreCase))
                    spotifyUrl = "https://open.spotify.com/track/" + uri.Substring("spotify:track:".Length);
                else if (!spotifyUrl.StartsWith("https://open.spotify.com/track/", StringComparison.OrdinalIgnoreCase))
                    spotifyUrl = "";

                string album = ReadAnyString(row, "album", "albumTitle", fallback: "");
                int duration = ReadDurationMilliseconds(row);
                playlist.Tracks.Add(new SpotifyTrack
                {
                    Number = ++number,
                    Title = title.Trim(),
                    Artist = artist.Trim(),
                    Album = album.Trim(),
                    DurationMilliseconds = duration,
                    SpotifyUrl = spotifyUrl
                });
            }
        }

        private static int ReadDurationMilliseconds(JsonElement row)
        {
            foreach (string key in new[] { "duration_ms", "durationMs", "duration", "durationMillis", "durationMilliseconds" })
            {
                JsonElement value = GetPropertyIgnoreCase(row, key);
                if (value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out double numeric))
                {
                    // Embed track-list values are generally milliseconds. Treat small
                    // values as seconds so minor schema changes do not break duration matching.
                    if (numeric > 0) return (int)Math.Min(int.MaxValue, numeric < 10000 ? numeric * 1000 : numeric);
                }
                if (value.ValueKind == JsonValueKind.Object)
                {
                    JsonElement ms = GetPropertyIgnoreCase(value, "totalMilliseconds");
                    if (ms.ValueKind == JsonValueKind.Number && ms.TryGetInt32(out int totalMs)) return Math.Max(0, totalMs);
                    ms = GetPropertyIgnoreCase(value, "milliseconds");
                    if (ms.ValueKind == JsonValueKind.Number && ms.TryGetInt32(out int milliseconds)) return Math.Max(0, milliseconds);
                    JsonElement seconds = GetPropertyIgnoreCase(value, "seconds");
                    if (seconds.ValueKind == JsonValueKind.Number && seconds.TryGetDouble(out double totalSeconds)) return (int)Math.Max(0, Math.Min(int.MaxValue, totalSeconds * 1000));
                }
                if (value.ValueKind == JsonValueKind.String && TryParseDuration(value.GetString(), out int parsedMilliseconds))
                    return parsedMilliseconds;
            }
            return 0;
        }

        private static bool TryParseDuration(string text, out int milliseconds)
        {
            milliseconds = 0;
            if (string.IsNullOrWhiteSpace(text)) return false;
            string[] parts = text.Trim().Split(':');
            if (parts.Length == 2 || parts.Length == 3)
            {
                int[] values = new int[parts.Length];
                for (int i = 0; i < parts.Length; i++)
                    if (!int.TryParse(parts[i], NumberStyles.Integer, CultureInfo.InvariantCulture, out values[i]) || values[i] < 0) return false;
                long totalSeconds = parts.Length == 2
                    ? (long)values[0] * 60 + values[1]
                    : (long)values[0] * 3600 + (long)values[1] * 60 + values[2];
                milliseconds = (int)Math.Min(int.MaxValue, totalSeconds * 1000L);
                return true;
            }
            if (TimeSpan.TryParse(text, CultureInfo.InvariantCulture, out TimeSpan time))
            {
                milliseconds = (int)Math.Max(0, Math.Min(int.MaxValue, time.TotalMilliseconds));
                return true;
            }
            return false;
        }

        private static JsonElement FindObjectContainingArray(JsonElement element, string propertyName)
        {
            if (element.ValueKind == JsonValueKind.Object)
            {
                foreach (JsonProperty property in element.EnumerateObject())
                {
                    if (string.Equals(property.Name, propertyName, StringComparison.OrdinalIgnoreCase) &&
                        (property.Value.ValueKind == JsonValueKind.Array || property.Value.ValueKind == JsonValueKind.Object)) return element;
                }
                foreach (JsonProperty property in element.EnumerateObject())
                {
                    JsonElement found = FindObjectContainingArray(property.Value, propertyName);
                    if (found.ValueKind != JsonValueKind.Undefined) return found;
                }
            }
            else if (element.ValueKind == JsonValueKind.Array)
            {
                foreach (JsonElement child in element.EnumerateArray())
                {
                    JsonElement found = FindObjectContainingArray(child, propertyName);
                    if (found.ValueKind != JsonValueKind.Undefined) return found;
                }
            }
            return default;
        }

        private static JsonElement GetPropertyIgnoreCase(JsonElement element, string name)
        {
            if (element.ValueKind != JsonValueKind.Object) return default;
            foreach (JsonProperty property in element.EnumerateObject())
                if (string.Equals(property.Name, name, StringComparison.OrdinalIgnoreCase)) return property.Value;
            return default;
        }

        private static string ReadAnyString(JsonElement element, string key1, string key2 = null, string key3 = null, string key4 = null, string key5 = null, string fallback = "")
        {
            foreach (string key in new[] { key1, key2, key3, key4, key5 }.Where(k => !string.IsNullOrWhiteSpace(k)))
            {
                JsonElement property = GetPropertyIgnoreCase(element, key);
                string value = ReadStringValue(property);
                if (!string.IsNullOrWhiteSpace(value)) return value;
            }
            return fallback ?? "";
        }

        private static string ReadStringValue(JsonElement value)
        {
            if (value.ValueKind == JsonValueKind.String) return value.GetString() ?? "";
            if (value.ValueKind == JsonValueKind.Array)
            {
                var values = value.EnumerateArray().Select(ReadStringValue).Where(s => !string.IsNullOrWhiteSpace(s)).ToArray();
                return string.Join(", ", values);
            }
            if (value.ValueKind == JsonValueKind.Object)
            {
                foreach (string key in new[] { "name", "title", "text", "subtitle", "label" })
                {
                    string result = ReadStringValue(GetPropertyIgnoreCase(value, key));
                    if (!string.IsNullOrWhiteSpace(result)) return result;
                }
            }
            return "";
        }
    }
}
