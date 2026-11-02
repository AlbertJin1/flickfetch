# FlickFetch Changelog

## [2.1.7] - 2026-11-02

### Fixed
- Opening the review window no longer lights up the 1-star button. The first star used to receive keyboard focus, which the dialog treated as hovering it. Focus now goes to the dialog itself, and stars only highlight under the mouse or the chosen rating.

### Improved (review window)
- The stars are a proper rating group: arrow keys, Home/End or the keys 1-5 pick a rating, and Tab moves on to the next field.
- A clear focus ring shows keyboard position without changing the rating preview.
- Tab stays inside the window, Escape closes it, and Ctrl+Enter submits.
- The feedback box shows a character counter, and the error clears once you choose a rating.

## [2.1.6] - 2026-11-02

### Fixed (portable updater, now modelled on PDF Studio)
- The update is downloaded and verified in the background and kept beside the exe as `<name>.new` *before* you press Update. Pressing **Update now** then only renames files (running exe to `.ff-backup`, the verified `.new` onto the exact original path) and reopens it. Before, the new exe was written and renamed in the same instant, which antivirus scanning could block, so the update fell through to the helpers or to `Downloads\FlickFetch Updates`.
- **Update later** keeps the verified update staged. On the next launch FlickFetch re-checks its size, Windows header and SHA-256 and offers it again; a damaged, truncated or already-installed one is discarded.
- If downloads are still running, **Update now** asks first instead of stopping them silently.
- The cmd and PowerShell helpers and the saved copy in `Downloads\FlickFetch Updates` remain as fallbacks, now fed from the already verified staged file.
- Cleanup never deletes a postponed update, and removes leftover `.old`, `.ff-backup` and `.new.part` files.

## [2.1.5] - 2026-11-02

### Fixed
- Making the in-place update more reliable: the exe rename retries for a few seconds when antivirus is still scanning the new file.
- If the exe still cannot be renamed, a plain `cmd.exe` helper (no PowerShell) swaps and reopens it, then the PowerShell helper is tried, and only then is the verified file saved to `Downloads\FlickFetch Updates`.
- When an update could not be installed automatically, the message now says exactly why (for example `rename: EPERM ...`), so a failure can be diagnosed.

## [2.1.4] - 2026-11-02

### Fixed
- Updating the portable exe now replaces the exe you opened, at the same path and with the same name, and reopens it. It no longer depends on a background PowerShell helper (which did not start on some PCs, leaving the new version in `Downloads\FlickFetch Updates`). The old exe is renamed to `.ff-backup` while the app runs and deleted by the new version a few seconds after it opens.
- The PowerShell helper is now only a backup for when the exe cannot be renamed, and the saved copy in `Downloads\FlickFetch Updates` is the last resort.

## [2.1.3] - 2026-11-02

### Fixed
- A FlickFetch icon pinned to the taskbar from an older build no longer shows the long description when you hover it while FlickFetch is closed. It shows only "Flick Fetch". The old text was stored inside the pinned shortcut; FlickFetch now rewrites it on launch. If Windows still shows the old text, restart Windows Explorer or unpin and re-pin once.

### Fixed (update restart)
- The update helper now proves it is running before FlickFetch closes. If it cannot start, FlickFetch stays open and saves the verified update to `Downloads\FlickFetch Updates` (shown in its folder) instead of closing with nothing reopening.
- The helper confirms the new version stays open for a few seconds before it deletes the old exe.
- If the exe cannot be replaced in place, the old exe is restored, the new version is started from `Downloads\FlickFetch Updates`, and the next launch shows a message saying where it is. As a last resort the old version is reopened and the new file is shown.
- Helper progress is logged to `%LOCALAPPDATA%\FlickFetch\updates\apply-update.log`.

## [2.1.2] - 2026-11-02

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
