# FlickFetch Changelog

## [Unreleased]

### Added (video detection on unsupported pages)
- When yt-dlp has no extractor for a link (or finds no playable format), FlickFetch now inspects the page the way you would in DevTools, then downloads the real file. Before, such links simply failed with "Unsupported URL".
- **What it looks for:** `<video src>`, `<source src type="video/mp4">` (also `data-src` and similar), `og:video` / `twitter:player:stream`, schema.org JSON-LD `contentUrl`, player configs inside scripts (including `\/`-escaped and `\u0026` URLs and `atob(...)` payloads), HLS (`.m3u8`) and DASH (`.mpd`) manifests, and the pages inside nested `<iframe>` players (up to 3 levels deep, 8 frames). HTML entities in signed URLs (`&amp;` in `?st=...&e=...`) are decoded, `<base>` and relative URLs are resolved, and images, subtitles, ads and preview clips are filtered or ranked down.
- **Players built by JavaScript:** if the raw HTML has no video (for example Fluid Player, which creates the `<video>` tag after load), a hidden, sandboxed browser window loads the page, tries to start playback muted, and reads the live DOM of every frame (`currentSrc`, `<source>` tags) plus the media requests the player makes, like DevTools' Elements and Network panels. Media requests are only recorded, never downloaded by the inspector.
- **Verified before downloading:** every candidate is probed with a one-chunk range request using the Referer a browser would send (the player frame, then the page, then its origin, then none). HTML error pages and blocked hot-links are rejected, and the working Referer is passed to yt-dlp (`--referer`, plus a browser `--user-agent`) so signed or hot-link protected CDN files such as `pool2.embedplayer.net/...mp4?st=...&e=...` download. The page title is used as the file title.
- Embedded YouTube/Vimeo/Dailymotion/etc. players found in a page are handed to yt-dlp as the fallback when no direct file exists.
- Failures now say what happened (for example "found 2 possible video links but none could be opened", or no video file found) instead of a bare yt-dlp error. Canceling works while a page is being inspected.
- New **Find video on unsupported pages** switch in Settings (on by default). Your cookies file and proxy are respected; with a proxy set, pre-verification is skipped and yt-dlp does the checking. Protected streams (DRM, `blob:` MSE players with no reachable manifest) cannot be downloaded.
- New `electron/services/page-sniffer.cjs` and `rendered-sniffer.cjs`, with tests in `tests/page-sniffer.test.cjs`.

### Added (in-app audio preview)
- **Preview** in the Spotify matcher now plays the matched version right inside FlickFetch, audio only, instead of opening YouTube in your browser. No video, no embedded web page.
- A player bar appears above the status bar with play/pause, a seek slider, elapsed/total time, volume and mute (volume is remembered). It keeps playing while you switch tabs, only one preview plays at a time, and the playing song is highlighted in the list. Keyboard and screen-reader friendly, and the system media keys / overlay work too.
- Each row's button reflects the state: Preview, Loading…, Pause, Resume, Replay or Retry. If a preview can't load you get a short, specific reason (for example a YouTube sign-in request, or an unavailable video) plus **Try again**, and an **Open on YouTube** button stays in the player as a fallback.
- How it works: the already-installed yt-dlp resolves a direct audio-only stream, and a small `ffpreview://` protocol in the main process streams it to a plain `<audio>` element. Seeking works, only small chunks are fetched at a time (so skipping through a playlist is cheap), expired stream links are refreshed automatically, and only YouTube video ids and Google video hosts are ever accepted. The Content-Security-Policy only gained `media-src 'self' ffpreview:`.
- **Reliable fallback:** if YouTube refuses the direct audio stream (HTTP 403/502), the preview automatically has yt-dlp fetch the audio the same way downloads do, into a temporary cache (`preview-cache` in the app data folder, at most 12 files, cleared on exit), and plays that file. Seeking is then instant. After two direct failures in a row, new previews skip the direct attempt. Details are logged as warnings.
- New `electron/services/preview-service.cjs` with tests in `tests/preview-service.test.cjs`.

### Changed (Spotify matcher)
- A candidate whose title is only *similar* is no longer flagged "Different title" when the uploading channel is one of the track's credited artists (for example "Future Islands" or "Future Islands - Topic" for a Future Islands song). That upload is treated as the real track and can be auto-matched. A name match on any credited artist counts, not just the first.
- It stays strict elsewhere: the same title from an unrelated channel, a different song on the artist's channel, or a wrong length are still flagged.

### Changed (differential updates)
- The build now uses electron-builder `compression: "store"`. The old LZMA-compressed payload meant a one-line change altered every byte of the exe, so no block ever matched and updates silently fell back to downloading everything. Unchanged files now stay byte-identical, so only the changed blocks are downloaded. The portable exe is larger on disk (about 2.5x); the Monitor's ZIP package keeps the full-download fallback small.
- Installed builds now use differential updates too. They previously always downloaded the whole portable exe; they now reuse blocks from the installed program files and any earlier saved release.
- The update dialog and toast report what was really transferred (for example "Downloaded 12.4 MB of 231.0 MB (only the changed parts)") and show how many blocks changed while downloading.
- The client no longer keeps the old exe in memory while rebuilding; it reads reusable blocks from disk.

### Changed (typography)
- New type system, bundled locally so it looks the same offline: **Bricolage Grotesque** for headings and the brand, **Instrument Sans** for interface text, and **JetBrains Mono** for versions, paths, shortcuts and logs. Previously the app named Inter but never shipped it, so it fell back to Segoe UI.
- The startup splash uses the same fonts.
- Removed the top workspace tab bar (the sidebar already has the same links) and fixed the Review dialog stealing focus from the feedback box while typing.

### Added (Check for updates dialog)
- **Check for updates** now opens a proper Software update dialog that runs a fresh check and shows one clear result: checking, up to date, update available (installed vs latest version, release notes, download/install with live progress), couldn't reach the Monitor (with Try again), or updates unavailable.
- Update checks now work in development runs (`npm run dev`) too. They are read-only: a development build never downloads or replaces anything. If the build is newer than the latest published release, the dialog says "You're ahead of the latest release" and calls it the latest unreleased version.
- The dialog labels the build (Development, Portable, or Installed) and shows when it was last checked.

## [2.1.1] - 2026-10-31

### Fixed (portable update cleanup)
- The portable updater now finds the running exe by its full path instead of the name "FlickFetch", so an exe the person renamed is waited for, replaced at the same path (keeping its name), and relaunched correctly.
- After a successful update the old exe, staged copies, the update script, and the staging folder contents are deleted. Anything still locked is removed on the next launch.
- Downloaded releases in `Downloads\FlickFetch Updates` that are not newer than the running version, plus interrupted `.part` files, are cleaned up automatically. The exe that is running is never deleted.
- The portable update checks that the exe folder is writable before downloading and explains how to fix it if it is not.

### Added (updates)
- Installed (non-portable) builds can now take updates. FlickFetch checks the Monitor, downloads the release through the same differential/compressed/full pipeline, verifies its SHA-256, and saves `FlickFetch-<version>-x64-Portable.exe` to `Downloads\FlickFetch Updates`, then shows it in its folder. Previously these builds only showed "Automatic updates unavailable".
- The portable build still updates in place and restarts. A verified file that is already in the folder is reused instead of downloaded again, and a different file with the same name is never overwritten.
- The sidebar update card is mode-aware (Download update / Update FlickFetch), shows readable progress phases, and offers Show in folder after a download.

### Changed (About dialog)
- Redesigned About FlickFetch: each helper tool now says what it does, shows a readable version (for example `N-127709` and `2.9.7` instead of truncated build strings), whether FlickFetch manages it or it comes from the system, and has a Show in folder button.
- yt-dlp update availability is shown in the tools list, and the main action reads Install missing tools when something is missing.
- Removed the duplicate version display and the Built with row; version and platform now sit under the app name.

### Changed
- All FlickFetch data (settings, download history, monitor state, helper tools, staged updates) is now stored in `%LOCALAPPDATA%\FlickFetch`. Nothing is created next to the exe anymore.
- An existing `FlickFetch-Data` folder beside the exe is migrated to AppData once on first launch, keeping the install id and settings, and then removed.

### Fixed
- After a successful in-app update the old exe (`.ff-backup`) is removed with retries, and any leftover backup or staged update files are cleaned up automatically on the next launch.
- Release uploads through the public tunnel no longer fail with HTTP 403: the uploader now sends base64 chunks on public routes and switches automatically if a raw chunk is rejected.

## [2.1.0] - 2026-10-31

### Added
- Added FlickFetch Monitor integration for installation registration, live session activity, periodic heartbeats, and clean session close events.
- Added secure in-app release checks and SHA-256-verified portable executable updates through the Universal App Monitor.
- Added an in-app review form that submits ratings and feedback to the FlickFetch review dashboard.
- Added release-to-monitor automation with ZIP packaging, resumable chunk uploads, and server-side release validation.

### Improved
- Aligned FlickFetch's Monitor client with PDF Studio: durable offline queue for session events, automatic `/api` to `/public/api` gateway fallback, redirect and error handling, and a friendly OS label such as "Windows 11 (x64)".
- Reviews are now saved in an encrypted outbox and retried until the Monitor confirms them; an automatic review prompt appears after about 30 minutes of use, with "Remind me later" and "Don't ask me again".
- Updates fall back from differential, to compressed, to the verified full executable, with download progress and strict URL and size checks.
- Kept monitor credentials out of the desktop client; the monitor gateway injects its server-only API key.
- Preserved the user data directory during self-updates.
