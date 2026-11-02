# FlickFetch Changelog

## [2.1.2] - 2026-11-02

### Fixed (update restart)
- The update helper now proves it is running before FlickFetch closes. If it cannot start, FlickFetch stays open and saves the verified update to `Downloads\FlickFetch Updates` (shown in its folder) instead of closing with nothing reopening.
- The helper confirms the new version stays open for a few seconds before it deletes the old exe.
- If the exe cannot be replaced in place, the old exe is restored, the new version is started from `Downloads\FlickFetch Updates`, and the next launch shows a message saying where it is. As a last resort the old version is reopened and the new file is shown.
- Helper progress is logged to `%LOCALAPPDATA%\FlickFetch\updates\apply-update.log`.

### Changed
- Downloads are saved as "Title.mp3" now, without the video id in brackets.
- Much smaller app: the exe is about 90-100 MB instead of 360 MB.
- Updates are now full downloads instead of small partial ones.

### Fixed
- Opening FlickFetch no longer adds a second taskbar icon next to the pinned one.
- Hovering the taskbar icon shows only "Flick Fetch".
- The update card in the sidebar shows a short summary instead of the whole changelog.
- The update card in the sidebar can be dismissed with the X. It comes back when a newer version is released, and "Check for updates" always works.

### Technical notes
_Not shown in the update window; kept here for the project history._

- The default filename template is `%(title).150B.%(ext)s`. Users still on the old default are migrated on first launch; custom templates are left alone.
- Build: electron-builder `compression: "maximum"` (was `"store"`), `electronLanguages: ["en-US"]`, and `build/afterPack.cjs` removes the unused WebGPU `dxcompiler.dll`. A compressed exe shares few byte blocks between releases, so differential updates fall back to the ZIP or full download.
- Taskbar: new `electron/services/taskbar-identity.cjs` sets the window's relaunch command to the real `FlickFetch.exe` and stamps the app ID onto an existing pinned shortcut (applies on the next launch).
- The exe description is "Flick Fetch" (`description` in `package.json`); the product name stays `FlickFetch` because `release.bat` validates it.

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
