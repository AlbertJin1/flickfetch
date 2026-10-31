# FlickFetch 2.1 — UI/UX refresh

## Visual direction

The interface uses a midnight-blue navigation rail and a bright, quiet workspace with teal as its primary accent. Cards and controls share consistent corner radii, border contrast, and spacing. The sidebar exposes the key workspaces first, keeps tool health visible, and can be collapsed for a wider work area.

## Startup splash and hand-off

- `electron/splash.html` is a self-contained local document with no remote assets.
- Electron opens the splash immediately while the main `BrowserWindow` remains hidden.
- React initializes settings, the download snapshot, app metadata, and helper-tool status before calling `window.flickfetch.app.signalReady()`.
- The main window fades in after the ready signal; Electron then closes the splash.
- A 25-second main-process fallback prevents the splash from remaining on screen forever if the renderer fails to report readiness.

## Interactive first-run guide

The guide is displayed when `flickfetch-guide-v1` has not been marked complete in the renderer's local storage. It contains four selectable steps:

1. Add a media link, including an actual URL entry field connected to the normal queue handler.
2. Open download settings and review output, quality, subtitles, and network options.
3. Open the downloads workspace and learn the queue, progress, and history controls.
4. Open Spotify matcher and review the public playlist matching workflow.

The guide can be reopened from the sidebar or top-bar Help control. Skipping or finishing records the guide as completed. Settings can be opened above the guide layer and closed without losing guide progress.

## Motion and accessibility

- Workspace content animates in on navigation.
- Cards, buttons, navigation items, dialogs, the guide illustration, and the engine status indicator use restrained transitions.
- The splash animation and guide illustration honor `prefers-reduced-motion`.
- Keyboard focus remains visible and the guide uses dialog semantics and labelled controls.
- Keyboard shortcuts: `Ctrl + ,` opens Settings; `Ctrl + Shift + G` opens the guide; `Escape` dismisses the guide/about dialog.

## Compatibility notes

The download queue, yt-dlp argument builder, helper-tool manager, settings schema, legacy `settings.ini` migration, Spotify matcher, and preload IPC contracts remain intact. The only new preload method is the one-way `app.signalReady()` startup handshake. The default app version is now 2.1.0.
