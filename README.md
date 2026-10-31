# FlickFetch 2.1

**Copyright © 2026 Jessie Albert Regualos.** FlickFetch is a desktop media workspace converted from the former Avalonia/.NET application to **React + Electron + Tailwind CSS**. The renderer is a React application; Electron owns the native window, settings, filesystem dialogs, clipboard monitoring, downloader processes, queue lifecycle, and tool installation.

## Technology

- **React 19.3** for the user interface.
- **Electron 45.1** for the desktop runtime and native integration.
- **Tailwind CSS 4.3** for application styling.
- **Vite 8.3** for development and renderer builds.
- **yt-dlp** for supported media extraction and download.
- **FFmpeg / FFprobe** for merging, remuxing, subtitle handling, and media processing.
- **Deno** for JavaScript-runtime support required by some yt-dlp extractors.

## Interface and onboarding

- A dedicated animated Electron startup splash appears before the main workspace. The main window stays hidden until React restores local settings, queue state, app metadata, and downloader-tool status, then fades into view. A bounded fallback prevents a stuck splash if renderer initialization fails.
- Refreshed workspace UI with a midnight navigation rail, teal accent system, clearer hierarchy, consistent controls, responsive queue columns, and compact/collapsed navigation.
- Screen transitions, hover feedback, animated status indicators, modal entrances, and loading states use restrained motion. The stylesheet honors the operating system's reduced-motion preference.
- First-run interactive guide with four guided steps: add a link, configure preferences, manage the queue, and use Spotify matcher. The guide includes a working URL submission field and direct links to the relevant workspace and settings.
- The interactive guide remains available from the sidebar and Help control. Shortcuts: `Ctrl + ,` opens Settings and `Ctrl + Shift + G` opens the guide.

## Features

### Downloads workspace

- Paste one or multiple media links, one link per line; `Ctrl + Enter` adds them to the queue. Drag URL text or `.txt` / `.url` link-list files onto the app to import them too.
- Add supported URLs and yt-dlp search expressions.
- Pages yt-dlp does not support are inspected for their real video (`<video><source type="video/mp4">`, `og:video`, HLS/DASH manifests, nested player iframes, and players built by JavaScript), the source is verified with the right Referer, and then downloaded. Controlled by **Find video on unsupported pages** in Settings.
- Queue items retain a snapshot of the options selected when they were added.
- Queue controls: pause/resume new queue processing, stop all, cancel one task, retry failed/canceled tasks, remove finished tasks, and clear finished items.
- Concurrent downloads with configurable concurrency, fragment count, retries, and speed limit.
- Live title, playlist position, per-file/overall progress, transfer speed, ETA, processing stage, saved path, error text, and per-task activity log.
- Local history survives application restarts; an active download found after an unclean exit is marked as interrupted.
- Quick inspect for media information and available formats without downloading.
- Output folder selection and opening/revealing completed files.

### Download options

- Best quality or maximum height presets from 360p to 4K, audio-only extraction, and a custom yt-dlp format expression.
- MP4, MKV, WebM, automatic container selection, and optional H.264/AAC compatibility preference.
- Audio extraction formats: MP3, M4A, Opus, FLAC, WAV, AAC, Vorbis, or best available.
- Full-playlist toggle, output template, restricted filenames, overwrite behavior, download archive, JSON metadata, description, thumbnail, and section clipping.
- Subtitles, auto-generated subtitles, subtitle languages, and embedding/conversion behavior.
- Thumbnail/metadata embedding and SponsorBlock removal where supported by the source.
- Browser cookies (Chrome, Edge, Firefox, Brave, Opera, Vivaldi), a user-supplied cookies file, proxy, speed cap, fragments, retries, concurrency, and extra yt-dlp arguments.

### Spotify playlist matcher

- Paste a Spotify playlist link into the main URL box or import it from the Spotify workspace. Import a **public** playlist using the metadata visible on Spotify's public embed page. No Spotify Developer application, OAuth, API key, or Spotify login is required.
- Import public playlist track title, artist, album, duration, and track link when exposed by the embed data.
- Search YouTube through yt-dlp for up to ten candidates per track.
- Rank suggestions using title/artist token overlap, duration similarity, and signals such as Topic channels, official-audio labels, live versions, and music-video labels.
- Review and choose among candidate results, open the Spotify/YouTube source, and add an individual reviewed match to the normal download queue.
- **Preview** any candidate audio-only inside the app (play/pause, seek, volume) before downloading. The preview uses yt-dlp to resolve an audio stream and does not open a browser or embed YouTube's web player.
- Export playlist and suggestion data to CSV.

Match scores are **heuristic suggestions**, not proof that two links contain the same recording. The application does not automatically bulk-download a Spotify playlist. Private playlists, tracks not exposed by the public embed, and changes to Spotify's unofficial embed format may prevent import.

### Settings and tools

- **Portable build:** when run from the single-file portable exe (`publish\FlickFetch.exe`), all data (settings, history, and the downloaded yt-dlp/FFmpeg/Deno tools) is stored in `%LOCALAPPDATA%\FlickFetch`; nothing is created next to the exe. A `FlickFetch-Data` folder left by older versions is migrated automatically.
- Otherwise, settings are stored as JSON in the per-user application data directory. On Windows, FlickFetch reuses the original `%LOCALAPPDATA%\FlickFetch` directory and imports legacy `settings.ini` values into `settings.json` on first launch, preserving the existing `bin` folder and helper executables.
- Optional clipboard monitoring detects copied media links and asks before adding them; it does not start a download without user action.
- On Windows x64, the Tools page can install/repair yt-dlp, FFmpeg/FFprobe, and Deno into the app's user-data `bin` folder.
- The yt-dlp executable is installed only after its SHA-256 value matches the official `SHA2-256SUMS` file.
- The app can run yt-dlp's built-in updater for a locally managed copy.

## Requirements

- **Node.js 22.12 or later** and npm for development/building (Vite 8 requires a recent Node 20/22 runtime).
- Windows x64 is the supported packaged target. The automatic helper-tool installer currently downloads Windows x64 binaries.
- On macOS/Linux, you can build the app from source, but must install compatible `yt-dlp`, `ffmpeg`, `ffprobe`, and `deno` executables yourself and make them available on `PATH`. The provided release scripts are Windows-oriented.
- An internet connection is required to install npm dependencies, install/update helper tools, read public Spotify embeds, and search YouTube.

## Development

```bash
npm install
npm run dev
```

This starts Vite and Electron together. Renderer code is under `src/`; Electron main/preload, the startup splash (`electron/splash.html`), and native services are under `electron/`.

## Validation and release builds

```bash
npm run check
npm test
npm run build
npm run dist:win
```

`npm run dist:win` creates a Windows x64 NSIS installer. To create a portable executable:

```bash
npm run dist:portable
```

Build artifacts are written to `release/`. The packaged app downloads helper tools on first setup rather than embedding large third-party executables in the installer. Install the helper components through **Settings → Downloader tools** after first launch.

## Architecture and security

- `electron/main.cjs` owns IPC handlers, app settings, native dialogs, clipboard watching, tool management, Spotify operations, and queue lifecycle.
- `electron/preload.cjs` exposes a small, allow-listed `window.flickfetch` API. It does not expose Node.js or Electron objects directly to React.
- `electron/services/download-service.cjs` builds yt-dlp argument arrays, starts child processes without a shell, parses machine-readable progress, manages cancellation/retry/concurrency, and persists history.
- `electron/services/tool-manager.cjs` resolves helper tools, downloads release assets, verifies yt-dlp's official SHA-256, and installs/upgrades tools.
- `electron/services/spotify-service.cjs` reads public playlist embed metadata and ranks YouTube search candidates. The renderer cannot execute shell commands or read arbitrary files directly.

The Electron renderer uses context isolation, disabled Node integration, and a sandboxed preload. Advanced custom yt-dlp arguments are intentionally passed through as user-configured command-line options; only enter arguments you understand.

## Supported sources and responsible use

yt-dlp extractors and source-site behavior change over time. A URL being accepted does not guarantee that the content is publicly accessible, supported, or downloadable. Facebook and Instagram posts may require cookies from an account you control; private posts, account challenges, unavailable media, DRM, paywalls, and access controls are not bypassed. Only download material you own or are authorized to save, and follow the source service's terms and applicable law.

FlickFetch is independent and is not affiliated with, endorsed by, or sponsored by Meta, Instagram, Facebook, Spotify, YouTube, yt-dlp, FFmpeg, or Deno.

## Licensing

The original FlickFetch application UI and integration code are attributed to Jessie Albert Regualos. Third-party libraries, executables, trademarks, platform services, and content retain their own copyrights and licenses. Review [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and the upstream licenses for the exact versions bundled or installed before redistribution. The FFmpeg build selected by the Windows installer is a GPL build; verify applicable source and redistribution obligations before publishing a packaged release.

## Universal App Monitor integration

FlickFetch is registered as its own `flickfetch` application in the Universal App Monitor. Packaged builds send an installation-scoped open/heartbeat/close session, check for releases, and can submit a 1–5 star review with optional written feedback. Monitor identity is stored in `monitor-state.json` alongside the portable data folder. Reviews and device activity are tagged as FlickFetch and remain separate from PDF Studio records.

The desktop client uses the public, allow-listed HTTPS client gateway. **No Monitor API key is embedded in FlickFetch.** The Monitor server must keep `MONITOR_API_KEY` in its server environment/private config. The release workstation uses its separate publishing key through `FLICKFETCH_MONITOR_KEY`, `MONITOR_API_KEY`, or a `monitor-key.txt` file beside `publish_to_monitor.ps1`. Run `release.bat [auto|public|local] [-Force] [-NoZip]` (or `release.bat noupload` to build only); `auto` tries the LAN Monitor first, then the public URL. Review submissions are associated with the app version, device name, operating system, local IP address, and a stable installation ID.

### Deploying the Monitor changes

1. Deploy the updated Universal App Monitor project, including `src/apps.php`, `src/releases.php`, `public/api/client-gateway.php`, and `public/reviews.php`.
2. Ensure the server has its existing strong `MONITOR_API_KEY` configured. Keep it server-side; never copy it into FlickFetch or the public web directory.
3. Check that `flickfetch` appears in the Monitor application selector and that the Releases and Reviews pages accept `?app=flickfetch`.
4. Keep the client gateway's upstream base URL on the Monitor's HTTPS API. The shipped default points to the same `pdfstudio-monitor` deployment used by PDF Studio; set the server-side `PDFSTUDIO_MONITOR_API_BASE` only when your deployment uses a different internal upstream.

### Building and publishing FlickFetch

Set the publishing key once on the Windows release workstation (open a new terminal after setting it):

```powershell
[Environment]::SetEnvironmentVariable('FLICKFETCH_MONITOR_KEY', 'YOUR_MONITOR_PUBLISHING_KEY', 'User')
```

Optional base URL override:

```powershell
[Environment]::SetEnvironmentVariable('FLICKFETCH_MONITOR_URL', 'https://your-host/your-monitor-base', 'User')
```

Run `release.bat` to build the portable Windows x64 executable and publish it to the monitor. Use `release.bat noupload` to build without uploading, or `release.bat -Force` to replace an identical version when the monitor allows it. The publisher reads the executable's product/version metadata and the matching `CHANGELOG.md` section, creates a compressed ZIP package, verifies SHA-256 values, and uploads in resumable 4 MiB chunks. The Monitor then stores the canonical executable, ZIP cache, and differential-update manifest.

In-app replacement is enabled only for the **Windows portable executable** created by `build_publish.bat`; installed builds are not silently replaced in protected install folders. The updater first requests missing content-defined chunks when a compatible differential manifest exists, otherwise downloads the verified ZIP (or legacy raw executable), checks the final executable size and SHA-256, and stages a rollback-capable replacement. The AppData folder, user settings, download history, and installed helper tools are preserved.
