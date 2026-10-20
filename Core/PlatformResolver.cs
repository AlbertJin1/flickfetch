// Copyright © 2026 Jessie Albert Regualos. Application source and integration code.
using System;

namespace FlickFetch
{
    public enum MediaPlatform
    {
        Other,
        Facebook,
        Instagram,
        Spotify
    }

    /// <summary>Identifies popular link types so the UI can give accurate, actionable guidance.</summary>
    public static class PlatformResolver
    {
        public static MediaPlatform Detect(string value)
        {
            if (!Uri.TryCreate(value?.Trim(), UriKind.Absolute, out Uri uri) ||
                (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
                return MediaPlatform.Other;

            string host = uri.Host.ToLowerInvariant();
            if (IsHost(host, "facebook.com") || IsHost(host, "fb.watch") || IsHost(host, "fb.com"))
                return MediaPlatform.Facebook;
            if (IsHost(host, "instagram.com") || IsHost(host, "instagr.am"))
                return MediaPlatform.Instagram;
            if (IsHost(host, "spotify.com") || IsHost(host, "spotify.link") || IsHost(host, "spotify.app.link"))
                return MediaPlatform.Spotify;
            return MediaPlatform.Other;
        }

        public static bool IsFacebookUrl(string value) => Detect(value) == MediaPlatform.Facebook;
        public static bool IsInstagramUrl(string value) => Detect(value) == MediaPlatform.Instagram;
        public static bool IsSpotifyUrl(string value) => Detect(value) == MediaPlatform.Spotify;

        private static bool IsHost(string host, string domain) =>
            string.Equals(host, domain, StringComparison.OrdinalIgnoreCase) ||
            host.EndsWith("." + domain, StringComparison.OrdinalIgnoreCase);
    }
}
