# FlickFetch

**Copyright © 2026 Jessie Albert Regualos** for the original FlickFetch application UI and integration code. Third-party software retains its separate copyrights and licenses; read `THIRD-PARTY-NOTICES.md` before distributing a release.

FlickFetch is a modern desktop download manager built with Avalonia UI and .NET 8. The interface uses Avalonia XAML with a Fluent theme and shared design tokens. It uses yt-dlp for supported video sources and FFmpeg for merging and conversion.

## Platform support

- **Facebook videos and Reels:** paste an accessible Facebook video/Reel URL and add it to the queue. Posts requiring login may require cookies from a browser account you control, configured under **Settings → Network & login**. Private or unavailable posts cannot be fetched just because the link is known.
- **Instagram posts and Reels:** paste an accessible post/Reel URL and add it to the queue. Login-required content may require your own browser cookies in **Settings → Network & login**. Account challenges, private posts, and changing site behavior can prevent extraction. Keep yt-dlp updated.
- **Spotify playlists:** paste a public Spotify playlist URL directly into the main URL box and click **Add to queue** (or **Import public Spotify playlist**). FlickFetch reads the track metadata exposed by Spotify's public embed page—no Spotify Developer app, Client ID field, API key, OAuth, or sign-in. It then searches YouTube for audio-first candidates using track title, artist and duration, prioritizes “Official Audio” / “Artist - Topic” clues, ranks likely music videos and live/visualizer results lower, and opens a review window with progress and CSV export. The embed format is unofficial and may change; private playlists and some items in long playlists may not be exposed. Match scores are heuristic suggestions, not guarantees.
- Other HTTP(S) sources are passed to yt-dlp, whose available extractors can change as websites update.

The app supports sources only where the user is authorized and the source is available. It does not bypass paywalls, account restrictions, DRM, or platform access controls.

## Spotify playlist matching

Playlist import uses the public `open.spotify.com/embed/playlist/{id}` page rather than the Spotify Web API. This removes the old developer app setup, callback registration, OAuth login, and saved Client ID configuration. Only metadata visible to the public embed can be read; private playlists are not supported, and Spotify can change this unofficial page format without notice.

Spotify and YouTube links are treated as match suggestions, not proof that a result is the same recording or can legally be downloaded. The matching screen provides selected-result opening and CSV export; it does not automatically bulk-download music based on a Spotify playlist. Use FlickFetch's normal downloader only for material you own or are authorized to save, and follow the source service's terms.

## Windows build

Requirements: Windows 10/11 and the **.NET 8 SDK** on the build computer. The release build requires internet access to download and verify the helper-tool assets.

- `build_publish.bat` — downloads yt-dlp, FFmpeg/FFprobe and Deno, verifies yt-dlp's official SHA-256, embeds them, and publishes a self-contained single-file `publish\FlickFetch.exe` for `win-x64`. Full diagnostics are saved in `build-publish.log`; dependency-staging output is saved in `tool-preparation.log`.
- `release.bat` — builds the EXE and produces a versioned ZIP with the EXE, SHA-256 manifest, third-party notices, and available upstream license/source materials.

The .NET runtime, app code and helper-tool payloads are embedded in the single EXE. At first launch, the app extracts child-process tools under `%LocalAppData%\FlickFetch\bin`. An embedded tool-manifest fingerprint is used to refresh bundled payloads when their hashes/tags change even if the application assembly version has not changed. This is required because Windows launches yt-dlp, FFmpeg, FFprobe and Deno as separate processes; no extra tool folder needs to ship beside the EXE.

The single EXE will be large because FFmpeg and Deno are bundled. The provided release scripts publish a self-contained Windows x64 executable. Avalonia itself supports multiple platforms, but the bundled downloader and release scripts are currently configured for Windows. A real build requires the .NET SDK, an internet connection for tool staging, and Windows for release smoke tests.

## Copyright and licensing

The original FlickFetch UI and integration code are attributed to Jessie Albert Regualos. This does not claim ownership of yt-dlp, FFmpeg, Deno, or any third-party media, platform or API. Review `THIRD-PARTY-NOTICES.md` and the `third-party-licenses` / `third-party-sources` folders produced during release. Verify the exact corresponding-source and redistribution obligations of every binary and library before public distribution.

FlickFetch is independent and is not affiliated with, endorsed by, or sponsored by Meta, Instagram, Facebook, Spotify, YouTube, or the maintainers of yt-dlp / FFmpeg / Deno. Respect copyright, platform terms, privacy, and content-owner permissions.


## Build verification notes

Playlist metadata import uses Spotify public embed JSON and no longer contains an OAuth callback listener or Spotify API credential flow. The settings dialog explains public playlist matching and its limits. The publish script preserves compiler output in its log; bundled-tool refreshes use a manifest fingerprint, and the runtime yt-dlp installer verifies the official SHA-256 checksum before installing.


## UI framework

FlickFetch uses [Avalonia UI](https://avaloniaui.net/) and its Fluent theme for the main, Settings, and Spotify playlist review windows. A shared design system provides consistent typography, color tokens, cards, buttons, list-row templates, progress bars, modal dialogs, and toast notifications. Package licensing information is recorded in `THIRD-PARTY-NOTICES.md`.
