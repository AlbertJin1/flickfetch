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

The download queue, yt-dlp argument builder, helper-tool manager, settings schema, legacy `settings.ini` migration, Spotify matcher, and preload IPC contracts remain intact. The preload exposes the startup handshake and a restricted set of main-window controls; the renderer never receives direct Node or Electron module access. The default app version is now 2.1.1.


## Desktop window chrome and navigation refinement

- The main Electron window now uses a frameless window with an app-owned, Chromium-inspired title strip. It includes workspace tabs, helper-engine health, Help and Settings shortcuts, and working minimize, maximize/restore, and close controls. The title strip remains draggable outside its controls and tabs.
- Main-process window actions are exposed through a narrow preload API and are restricted to the main application window. Maximize/restore state is sent back to the renderer so the titlebar icon stays synchronized.
- The sidebar can be collapsed or expanded at runtime. The preference is stored locally, the compact state has accessible labels, and narrower windows automatically use an icon-rail layout to preserve workspace width.
- The renderer now supports a 780 px minimum window width and responsive queue/profile layouts; the settings navigation reflows into a horizontal tab strip on narrower windows.

## Dropdown controls

- Native selects in download profiles, settings, and Spotify candidate review are replaced by one shared dropdown control.
- Menus are rendered in a document-level portal so they are not clipped by scrollable dialogs. Positioning adapts to available viewport space.
- Controls support keyboard navigation (Arrow keys, Home/End, Enter/Space, Escape, and Tab), disabled states, visible focus, and selected-state indicators.


## Downloads + Spotify matcher redesign (2.1.x)

**Downloads** — one composer (paste → choose Video/Audio → Download) with the queue visible immediately beneath it. Stat cards were replaced by live counts on the queue filter tabs; in-row progress shows percent, speed and time left; secondary actions (retry failed, clear finished, cancel everything) live in a *Manage* menu; Video/Audio is a single switch so no controls are ever shown disabled; pasting a Spotify link offers the matcher instead of failing. Waiting items are listed in the order they will actually start.

**Spotify matcher** — a three-step flow (Import → Find audio → Review & download) with a stepper. One primary action per state: *Find & download songs*, then *Download N ready songs* / *Review N songs*. Rows are single-status and compact; only songs that need a decision show a version picker. "No match" rows offer *Search YouTube*.

Implementation: `src/components/DownloadsWorkspace.jsx`, `SpotifyWorkspace.jsx`, shared controls in `src/components/ui.jsx`, styles in `src/workspaces.css` (namespaced `.ff-*`, 14px body / 12px minimum). No IPC, settings or service changes.
