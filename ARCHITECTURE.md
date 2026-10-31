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
   │  allow-listed window.flickfetch API
   ▼
Electron preload (electron/preload.cjs)
   │  ipcRenderer.invoke / ipcRenderer.on
   ▼
Electron main (electron/main.cjs)
   ├── ToolManager          helper tool resolution, install, update, version checks
   ├── DownloadService      queue, yt-dlp processes, progress, history, cancellation
   └── Spotify service      public embed parsing, YouTube search, match ranking, CSV
```

## Startup lifecycle

1. Electron creates a small, frameless splash window and a hidden main window.
2. The splash window presents a lightweight local HTML/CSS animation; it does not depend on the React bundle or a network resource.
3. The hidden renderer restores local settings, persisted queue state, application metadata, and downloader helper-tool status.
4. The preload exposes a one-way `signalReady()` method. React calls it after initialization settles, including recoverable initialization errors.
5. Electron fades the main window into view and closes the splash. A 25-second safety fallback prevents an indefinitely visible splash if the renderer cannot signal readiness.

## Process boundaries

The renderer has no Node integration and cannot directly spawn processes or access the filesystem. The preload exposes named methods only. Each IPC handler validates and normalizes the values it receives before calling the corresponding service.

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
