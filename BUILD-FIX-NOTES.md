# FlickFetch UI migration and build notes

Copyright © 2026 Jessie Albert Regualos for the original application code. Third-party components retain their own licenses.

## Avalonia UI migration

- Replaced the former WPF / WPF-UI app shell with Avalonia UI 12.1.4 and its Fluent theme. The project now targets `net8.0` and has an Avalonia desktop entry point in `Program.cs`.
- Migrated the main, Settings, and Spotify playlist review windows to `.axaml` with native Avalonia controls. Shared application styles define the palette, typography, buttons, text fields, checkboxes, progress bars, list rows, and tab styling.
- Redesigned the main window around a link composer, download-profile card, save-location panel, progress-aware queue, activity log, status strip, and toast notifications. Settings and Spotify review share the same visual system.
- Replaced WPF message dialogs with a small Avalonia modal-dialog helper, and switched folder/file pickers and clipboard operations to Avalonia's platform services. Restored drag-and-drop import for text, URL, and `.txt` link-list drops.
- Kept the existing download engine, yt-dlp / FFmpeg / Deno management, preferences model, queue logic, Spotify public-playlist parser, YouTube matching service, and CSV export workflow. Spotify track match fields now notify Avalonia bindings when they update.
- Updated build/release metadata and dependency notices to remove WPF-UI-specific steps. `build_publish.bat` still stages and verifies bundled helper tools and publishes the self-contained Windows x64 executable.

## Spotify playlist behavior

Playlist import still reads metadata exposed by the public Spotify embed page, without a Spotify developer app, API key, OAuth callback, or sign-in flow. The page format is unofficial; private playlists and tracks not exposed publicly are unsupported. YouTube matches remain suggestions for review, not guarantees of identity or permission.

## Build-log repair (October 2026)

The first Windows publish log identified Avalonia 12 clipboard API changes and WPF-only `TextBox` object-initializer properties. The source has been patched as follows:

- Imported `Avalonia.Input.Platform` so clipboard extension methods resolve.
- Replaced removed `IClipboard.GetTextAsync()` calls with `TryGetTextAsync()`.
- Kept `SetTextAsync()` as the Avalonia 12 clipboard extension method.
- Replaced WPF-style `TextBox.VerticalScrollBarVisibility` / `HorizontalScrollBarVisibility` initializer entries with Avalonia `ScrollViewer.SetVerticalScrollBarVisibility` and `SetHorizontalScrollBarVisibility` calls.
- Qualified Avalonia's `Orientation` and `HorizontalAlignment` enum values to avoid a property/type name collision.
- Awaited modal dialogs in asynchronous handlers and made the related dialog helper flows awaitable to avoid fire-and-forget UI behavior and `CS4014` warnings.

## Build-log repair #2 (AXAML compiler errors AVLN2000 / AVLN2200 / AVLN3000)

The Avalonia XAML compiler rejected WPF-style property and event names. Fixed as follows:

| File | Problem | Avalonia fix |
|---|---|---|
| `App.axaml` (eyebrow style) | `TextBlock.CharacterSpacing` does not exist in Avalonia | `LetterSpacing` (same unit: device-independent pixels) |
| `MainWindow.axaml` (`PlaylistCheckBox`, `CompatCheckBox`) | `Checked` / `Unchecked` events not available | single `IsCheckedChanged` event (handler `Format_Changed` already takes `RoutedEventArgs` and is guarded by `_initializing`) |
| `MainWindow.axaml` (`LogBox`) | `TextBox.VerticalScrollBarVisibility` / `HorizontalScrollBarVisibility` are not TextBox properties | attached properties `ScrollViewer.VerticalScrollBarVisibility` / `ScrollViewer.HorizontalScrollBarVisibility` |
| `MainWindow.axaml` (`ToastPanel`) | `Panel.ZIndex` is a WPF attached property | `ZIndex` (property on `Visual`) |

## Runtime fix: app exited immediately after launch (October 2026)

- **Cause:** In WPF `TextBox.Text` defaults to `""`; in Avalonia it defaults to `null`. `UpdateLogPane` evaluated `LogBox.Text.Length` on the first 250 ms UI timer tick, throwing `NullReferenceException` on the UI thread and ending the process.
- **Fix:** Null-safe checks in `UpdateLogPane`, the paste/append paths for `UrlBox`, and every `Text.Trim()` in `SettingsWindow` (a Save would have crashed the same way).
- **Diagnostics:** `Program.cs` and `App.axaml.cs` now log unhandled startup, UI-thread, AppDomain and task exceptions to `%LocalAppData%\FlickFetch\logs\crash.log`. UI-thread exceptions are logged and the app keeps running rather than exiting silently.

## Runtime fix #2: NullReferenceException in `MainWindow..ctor()` (crash.log)

- **Cause:** The three window constructors called `AvaloniaXamlLoader.Load(this)` directly. That loads the XAML but does not assign the `x:Name` fields (`QueueGrid`, `QualityBox`, `LogBox`, ...), so they stayed `null` and the first use (`QueueGrid.ItemsSource = _rows`) threw.
- **Fix:** `MainWindow`, `SettingsWindow` and `SpotifyPlaylistWindow` now call the source-generated `InitializeComponent()`, which loads the XAML and binds every named control. (`App.Initialize()` correctly keeps `AvaloniaXamlLoader.Load(this)`, since `App.axaml` has no named controls.)

## Validation status

- Parsed all `.axaml` files and `FlickFetch.csproj` as XML after the patch.
- Checked the edited source for the removed `GetTextAsync()` calls and stale method names.
- Verified the project archive contents and ZIP integrity.
- **A fresh compile/publish and interactive UI smoke test could not be run in this environment because the .NET SDK is not installed and network access for installing it is unavailable.** Run `dotnet restore`, `dotnet build -c Release`, and `build_publish.bat` on the Windows development machine with the .NET 8 SDK. If the compiler surfaces any new diagnostics after these original errors are removed, use the new `build-publish.log` output to complete that final verification. Please test window scaling, folder/file pickers, clipboard access, queue progress, playlist matching, and exit confirmation before distribution.
