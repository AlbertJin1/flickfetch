# FlickFetch architecture

```text
Electron splash window (electron/splash.html)
   │  animated startup shell; main window remains hidden
   ▼
React renderer (src/)
   │  restores settings, queue, app info, and tool status
   │  signals app:renderer-ready when initialization settles
   ▼
Electron main reveals the main window and closes splash
   │  allow-listed window.flickfetch API (app, settings, downloads, tools, window controls)
   ▼
Electron preload (electron/preload.cjs)
   │  ipcRenderer.invoke / ipcRenderer.on
   ▼
Electron main (electron/main.cjs)
   ├── ToolManager          helper tool resolution, install, update, version checks
   ├── DownloadService      queue, yt-dlp processes, progress, history, cancellation
   ├── Spotify service      public embed parsing, YouTube search, match ranking, CSV
   └── Preview service      yt-dlp audio-stream resolve + ffpreview:// range proxy for in-app playback
```

## Audio preview lifecycle

1. The renderer calls `flickfetch.preview.prepare(youtubeUrl)`. The main process extracts the 11-character video id (anything else is rejected) and runs yt-dlp with an audio-only, direct-HTTPS format selector. The stream URL and the few headers it needs are cached until shortly before the stream's own `expire` time.
2. The renderer's single shared `<audio>` element loads `ffpreview://track/<id>`. A privileged custom protocol handler in the main process answers its `Range` requests by proxying the cached stream. Open-ended ranges are served in 2 MiB chunks, so seeking and abandoning a preview never downloads the whole file.
3. If the upstream rejects the cached URL (403/410), the service re-resolves once and retries. If the direct stream still fails, yt-dlp downloads the audio into `preview-cache` and the protocol handler serves that file with full Range support. Failures reach the UI as a short message from `prepare`, or as a media error with a retry action.
4. The player state lives in `src/lib/preview-player.jsx` above the workspaces, so playback survives tab switches. The playback position is a separate context that only the player bar subscribes to.

## Page inspection fallback

1. yt-dlp always runs first. If it fails with its generic extractor ("Unsupported URL", "No video formats found", ...) and **Find video on unsupported pages** is on, the item switches to *Inspecting page for video* and keeps its download slot (cancelable).
2. **Static stage** (`page-sniffer.cjs`): Node `fetch` reads the page and nested iframes, parses `<video>/<source type>`, `og:video`, JSON-LD, script player configs and manifests, and ranks candidates (live DOM > `<source>` > network > og/JSON-LD > scripts > links; ads/previews demoted; higher resolution preferred). Node `fetch` is used because Chromium's network stack refuses cross-origin `Referer` headers on programmatic requests.
3. **Rendered stage** (`rendered-sniffer.cjs`), only if nothing verified: a hidden window in a private in-memory session (sandbox, no preload, permissions/pop-ups/downloads denied, muted, images and fonts blocked) loads the page, starts playback, and reports each frame's live DOM plus media requests (recorded from `webRequest.onBeforeSendHeaders`, then cancelled).
4. **Verification:** each candidate gets a 2 KB range request with candidate Referers; HTML bodies and non-media types are rejected. The first verified source wins and its Referer is passed to yt-dlp with a browser User-Agent and the page title. The result stays attached to the original link in history.

## Startup lifecycle

1. Electron creates a small, frameless splash window and a hidden main window.
2. The splash window presents a lightweight local HTML/CSS animation; it does not depend on the React bundle or a network resource.
3. The hidden renderer restores local settings, persisted queue state, application metadata, and downloader helper-tool status.
4. The preload exposes a one-way `signalReady()` method. React calls it after initialization settles, including recoverable initialization errors.
5. Electron fades the main window into view and closes the splash. A 25-second safety fallback prevents an indefinitely visible splash if the renderer cannot signal readiness.

## Process boundaries

The renderer has no Node integration and cannot directly spawn processes or access the filesystem. The preload exposes named methods only. Window-control IPC is restricted to the main application window; other handlers validate and normalize values before calling the corresponding service. The main window is frameless and the renderer supplies the draggable titlebar and window-control buttons.

## Queue lifecycle

1. The renderer submits one or more links.
2. The main process validates each link, snapshots the current settings, and creates a queue item.
3. The scheduler starts items up to the configured concurrency limit.
4. yt-dlp receives an argument array through `spawn` (not a shell command string).
5. Machine-readable progress templates update each item; normal output and errors are appended to its activity log.
6. Completed, failed, and canceled items are saved to the local history JSON file.

## Spotify matching lifecycle

1. The app resolves the playlist ID and reads `__NEXT_DATA__` from the public Spotify embed page.
2. Track metadata is normalized into local objects.
3. yt-dlp searches YouTube for candidate results, which are ranked by title/artist coverage, duration similarity, and audio/video metadata clues.
4. The UI exposes the top candidates for manual review. A user can open a candidate, change the selection, or add that one URL to the regular download queue.

Scores are recommendations only. The app does not claim exact track identity or grant rights to save a candidate.

## Universal App Monitor lifecycle

1. A packaged desktop build loads or creates a stable 32-hex installation ID in `monitor-state.json` under the app's user-data directory.
2. The main process reports `open`, periodic `heartbeat`, and best-effort `close` events to the public HTTPS client gateway, using the same transport as PDF Studio: manual redirects, an automatic `/api` to `/public/api` fallback, and a durable `monitor-usage-queue.json` so events that cannot be delivered offline are retried (4xx rejections are dropped and logged to `monitor-usage.log`). Every request is explicitly tagged `app: flickfetch`; the server gateway injects the secret API key and allow-lists the app ID.
3. The renderer can request a latest-release check and displays a release card when a newer version is available. The Windows portable build can install it; an installed build reports that automatic self-replacement is unsupported.
4. The portable exe is built with electron-builder `compression: "maximum"` (LZMA), `electronLanguages: ["en-US"]`, and an `afterPack` hook (`build/afterPack.cjs`) that removes the unused WebGPU shader compiler, which brings the exe from about 360 MB (the old `compression: "store"` build) to roughly 90-100 MB. The trade-off is that a compressed payload shifts every byte when anything changes, so block-level differential updates rarely match; the client detects that and uses the compressed ZIP or raw executable endpoint instead (a full download). The `psd-chunks-v1` manifest path still runs and is used automatically if a build ever shares enough blocks with the installed files. The client chunks the files it already has, downloads only the blocks it lacks, validates every block, reconstructs the exact executable, and reports how many bytes were actually transferred. To go back to small delta updates at the cost of a 360 MB exe, set `compression` to `"store"` in `package.json`.
5. Before applying an update, the client verifies the executable's release size and SHA-256 and stages it in app data. A detached PowerShell helper waits for the app/portable bootstrapper to exit, verifies the staged file, backs up the old launcher, retries a locked-file move, rolls back on failure, then restarts FlickFetch. The adjacent portable data directory is never replaced.
6. The Review FlickFetch dialog submits a 1–5 star rating and optional name/comment. The review is first written to an encrypted outbox (`review-outbox.enc`, Electron `safeStorage`) and retried with backoff until the Monitor acknowledges it, so an offline or interrupted submit is never lost. The client gateway validates and tags the review with the FlickFetch app ID; the Monitor stores it in the application-filtered Reviews dashboard. An automatic prompt appears after about 30 minutes of use (paused 90 days after a review, with snooze and opt-out), using `review-queue-policy.cjs` shared with PDF Studio. Remote device enable/disable is not used: the Monitor's `access.php` currently serves PDF Studio only.

The release publishing credential is read only by `publish_to_monitor.ps1` on the release workstation. The desktop client contains only the public gateway URL and no shared Monitor API secret.
