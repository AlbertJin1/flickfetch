// Copyright © 2026 Jessie Albert Regualos. Application source and integration code.
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Input.Platform;
using Avalonia.Layout;
using Avalonia.Interactivity;
using Avalonia.Markup.Xaml;
using Avalonia.Media;
using Avalonia.Platform.Storage;
using Avalonia.Threading;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace FlickFetch
{
    public partial class MainWindow : Window
    {
        private AppSettings _settings;
        private readonly ToolManager _tools;
        private readonly List<DownloadItem> _items = new List<DownloadItem>();
        private readonly ObservableCollection<DownloadQueueRow> _rows = new ObservableCollection<DownloadQueueRow>();
        private readonly DispatcherTimer _timer;
        private bool _queueRunning = true;
        private bool _initializing = true;
        private bool _isClosing;
        private string _lastClipboard = "";
        private DownloadItem _logItem;
        private int _logVersionShown = -1;
        private bool _clipboardPolling;
        private readonly DispatcherTimer _toastTimer;

        public MainWindow()
        {
            _settings = AppSettings.Load();
            _tools = new ToolManager();
            InitializeComponent();

            QueueGrid.ItemsSource = _rows;
            QualityBox.ItemsSource = ArgsBuilder.PresetNames;
            ContainerBox.ItemsSource = new[] { "auto", "mp4", "mkv", "webm" };
            AudioFormatBox.ItemsSource = new[] { "mp3", "m4a", "opus", "flac", "wav", "aac", "vorbis", "best" };

            LoadMainSettings();
            UrlBox_TextChanged(this, null);
            _initializing = false;
            _toastTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
            _toastTimer.Tick += (s, e) => { _toastTimer.Stop(); ToastPanel.IsVisible = false; };

            _timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
            _timer.Tick += (s, e) => OnTick();
            _timer.Start();
        }

        private async void Window_Loaded(object sender, EventArgs e)
        {
            await OnShownAsync();
        }

        private void LoadMainSettings()
        {
            QualityBox.SelectedIndex = Clamp(_settings.Preset, 0, ArgsBuilder.PresetNames.Length - 1);
            ContainerBox.SelectedItem = _settings.Container;
            if (ContainerBox.SelectedIndex < 0) ContainerBox.SelectedItem = "mp4";
            AudioFormatBox.SelectedItem = _settings.AudioFormat;
            if (AudioFormatBox.SelectedIndex < 0) AudioFormatBox.SelectedItem = "mp3";
            PlaylistCheckBox.IsChecked = _settings.Playlist;
            CompatCheckBox.IsChecked = _settings.PreferCompat;
            OutputPathBox.Text = _settings.OutputDir;
            UpdateFormatEnabled();
        }

        private void SaveMainSettings()
        {
            _settings.Preset = Math.Max(0, QualityBox.SelectedIndex);
            _settings.Container = ContainerBox.SelectedItem as string ?? "mp4";
            _settings.AudioFormat = AudioFormatBox.SelectedItem as string ?? "mp3";
            _settings.Playlist = PlaylistCheckBox.IsChecked == true;
            _settings.PreferCompat = CompatCheckBox.IsChecked == true;
            _settings.OutputDir = (OutputPathBox.Text ?? "").Trim();
            _settings.Save();
        }

        private static int Clamp(int value, int min, int max) => value < min ? min : value > max ? max : value;

        private void UpdateFormatEnabled()
        {
            int p = QualityBox.SelectedIndex;
            bool audioOnly = p == ArgsBuilder.PresetAudioOnly;
            ContainerBox.IsEnabled = !audioOnly;
            CompatCheckBox.IsEnabled = !audioOnly;
            AudioFormatBox.IsEnabled = audioOnly;
        }

        private void Format_Changed(object sender, RoutedEventArgs e)
        {
            if (_initializing) return;
            UpdateFormatEnabled();
            SaveMainSettings();
        }

        private async Task OnShownAsync()
        {
            try
            {
                if (!_tools.HasYtDlp)
                {
                    MessageBoxResult answer = await MessageBox.Show(this,
                        "FlickFetch could not find its yt-dlp engine. Install the required tools now?\n\n" +
                        "The tools are normally embedded in the release build and are extracted to your local profile on first launch.",
                        "First-time setup", MessageBoxButton.YesNo, MessageBoxImage.Question);
                    if (answer == MessageBoxResult.Yes)
                        await InstallComponentsAsync(true, !_tools.HasFfmpeg, !_tools.HasDeno);
                }
                await RefreshToolInfoAsync();
                if (_settings.AutoUpdate && _tools.HasYtDlp && IsOwnCopy(_tools.YtDlpPath))
                {
                    FooterStatusText.Text = "Checking yt-dlp for updates…";
                    try { await _tools.UpdateYtDlpAsync(); }
                    catch (Exception ex) { FooterStatusText.Text = "yt-dlp update check failed: " + ex.Message; }
                    await RefreshToolInfoAsync();
                }
                FooterStatusText.Text = _tools.HasYtDlp ? "Ready · paste a link to create a download" : "Setup required · yt-dlp is not installed";
            }
            catch (Exception ex)
            {
                ToolStatusText.Text = "Setup issue";
                ToolStatusDot.Fill = new SolidColorBrush(Color.FromRgb(210, 89, 89));
                FooterStatusText.Text = ex.Message;
            }
        }

        private bool IsOwnCopy(string path)
        {
            try
            {
                return string.Equals(Path.GetFullPath(Path.GetDirectoryName(path)), Path.GetFullPath(_tools.BinDir), StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
        }

        private async Task RefreshToolInfoAsync()
        {
            _tools.Refresh();
            string version = await _tools.GetYtDlpVersionAsync();
            bool ready = _tools.HasYtDlp && _tools.HasFfmpeg && _tools.HasDeno;
            ToolStatusDot.Fill = new SolidColorBrush(ready ? Color.FromRgb(39, 166, 118) : Color.FromRgb(217, 154, 49));
            ToolStatusText.Text = _tools.HasYtDlp
                ? "yt-dlp " + (string.IsNullOrWhiteSpace(version) ? "installed" : version) + (_tools.HasFfmpeg ? " · FFmpeg" : " · FFmpeg missing")
                : "Tools not installed";
        }

        private async void Add_Click(object sender, RoutedEventArgs e) => await AddFromTextBoxAsync();

        private async void SpotifyPlaylist_Click(object sender, RoutedEventArgs e)
        {
            string[] urls = (UrlBox.Text ?? "").Split(new[] { '\r', '\n', '\t', ' ' }, StringSplitOptions.RemoveEmptyEntries);
            string playlistUrl = urls.FirstOrDefault(SpotifyPlaylistService.CanImportPlaylistUrl);
            if (playlistUrl == null)
            {
                await MessageBox.Show(this, "Paste a public Spotify playlist link into the URL box first.", "Playlist link required", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }
            await ImportSpotifyPlaylistAsync(playlistUrl);
        }

        private async Task ImportSpotifyPlaylistAsync(string playlistUrl)
        {
            try
            {
                FooterStatusText.Text = "Reading public playlist metadata…";
                SpotifyPlaylist playlist = await SpotifyPlaylistService.FetchAsync(playlistUrl);
                UrlBox.Text = string.Empty;
                FooterStatusText.Text = "Playlist loaded · searching YouTube audio-first matches…";
                var window = new SpotifyPlaylistWindow(playlist, _tools);
                await window.ShowDialog(this);
                FooterStatusText.Text = "Playlist match review closed";
            }
            catch (Exception ex)
            {
                await MessageBox.Show(this,
                    "FlickFetch could not read this public playlist. No Spotify app setup or sign-in is used.\n\n" + ex.Message +
                    "\n\nPrivate playlists and some very long playlists may not expose a complete track list on Spotify's public embed page.",
                    "Playlist import failed", MessageBoxButton.OK, MessageBoxImage.Warning);
                FooterStatusText.Text = "Playlist import failed";
            }
            finally { }
        }

        private async Task AddFromTextBoxAsync()
        {
            string[] urls = (UrlBox.Text ?? "").Split(new[] { '\r', '\n', '\t', ' ' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(s => s.Trim()).Where(s => s.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            if (urls.Length == 0)
            {
                await MessageBox.Show(this, "Paste a media URL or a public Spotify playlist link first.", "Nothing to add", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }

            string[] spotifyPlaylists = urls.Where(SpotifyPlaylistService.CanImportPlaylistUrl).ToArray();
            if (spotifyPlaylists.Length > 0)
            {
                if (urls.Length != 1 || spotifyPlaylists.Length != 1)
                {
                    await MessageBox.Show(this, "Process a Spotify playlist by itself. Paste one playlist link, click Add to queue, and FlickFetch will load its public track list and find YouTube audio-first candidates for review.", "One playlist at a time", MessageBoxButton.OK, MessageBoxImage.Information);
                    return;
                }
                await ImportSpotifyPlaylistAsync(spotifyPlaylists[0]);
                return;
            }

            SaveMainSettings();
            string invalidSettings = ArgsBuilder.Validate(_settings);
            if (invalidSettings != null)
            {
                await MessageBox.Show(this, invalidSettings, "Check download settings", MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }

            string[] valid = urls.Where(ArgsBuilder.IsAcceptedUrl).ToArray();
            if (valid.Length == 0)
            {
                await MessageBox.Show(this, "Paste at least one valid http(s) video or playlist URL first.", "No links found", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }

            string[] spotifyLinks = valid.Where(PlatformResolver.IsSpotifyUrl).ToArray();
            if (spotifyLinks.Length > 0)
            {
                await MessageBox.Show(this,
                    "FlickFetch can import public Spotify playlist links, but Spotify track and album URLs are not direct media downloads. Paste a playlist link to find YouTube audio-first matches.",
                    "Unsupported Spotify link", MessageBoxButton.OK, MessageBoxImage.Information);
                valid = valid.Where(url => !PlatformResolver.IsSpotifyUrl(url)).ToArray();
                if (valid.Length == 0) return;
            }

            foreach (string url in valid)
            {
                var item = new DownloadItem
                {
                    Url = url,
                    Title = url,
                    OutputDir = _settings.OutputDir,
                    Args = ArgsBuilder.BuildDownloadArgs(_settings, _tools).ToArray()
                };
                MediaPlatform platform = PlatformResolver.Detect(url);
                item.AddLog("Added to FlickFetch queue." + (platform == MediaPlatform.Other ? "" : " Detected platform: " + platform + "."));
                if (platform == MediaPlatform.Facebook) item.AddLog("Facebook videos/Reels require an accessible video URL; if sign-in is required, configure cookies from your own browser under Settings → Network & login.");
                if (platform == MediaPlatform.Instagram) item.AddLog("Instagram posts/Reels require an accessible post; if sign-in is required, configure cookies from your own browser under Settings → Network & login.");
                _items.Add(item);
                _rows.Add(new DownloadQueueRow(item, _rows.Count + 1));
            }

            UrlBox.Text = string.Empty;
            QueueGrid.SelectedIndex = _rows.Count - 1;
            
            EmptyQueuePanel.IsVisible = false;
            FooterStatusText.Text = valid.Length + (valid.Length == 1 ? " link added to queue" : " links added to queue");
            ShowToast("Added to queue", valid.Length + (valid.Length == 1 ? " link is ready in the download queue." : " links are ready in the download queue."));
            if (_settings.AutoStart) _queueRunning = true;
            UpdateQueueButton();
            UpdateQueueSummary();
            await Task.CompletedTask;
        }

        private void UrlBox_TextChanged(object sender, TextChangedEventArgs e)
        {
            if (UrlPlaceholder != null)
                UrlPlaceholder.IsVisible = string.IsNullOrWhiteSpace(UrlBox.Text);
        }

        private async void UrlBox_PreviewKeyDown(object sender, KeyEventArgs e)
        {
            if (e.Key == Key.Enter && (e.KeyModifiers & KeyModifiers.Control) == KeyModifiers.Control)
            {
                e.Handled = true;
                await AddFromTextBoxAsync();
            }
        }

        private void Window_DragOver(object sender, DragEventArgs e)
        {
            bool canAccept = e.DataTransfer.Formats.Contains(DataFormat.File) || e.DataTransfer.Formats.Contains(DataFormat.Text);
            e.DragEffects = canAccept ? DragDropEffects.Copy : DragDropEffects.None;
            e.Handled = true;
        }

        private async void Window_Drop(object sender, DragEventArgs e)
        {
            try
            {
                var collected = new List<string>();
                if (e.DataTransfer.Formats.Contains(DataFormat.File))
                {
                    var files = e.DataTransfer.TryGetFiles();
                    if (files != null)
                    {
                        foreach (var file in files)
                        {
                            string path = file.Path?.LocalPath;
                            if (string.IsNullOrWhiteSpace(path)) continue;
                            if (File.Exists(path) && Path.GetExtension(path).Equals(".txt", StringComparison.OrdinalIgnoreCase))
                                collected.AddRange(File.ReadAllLines(path));
                            else if (ArgsBuilder.IsAcceptedUrl(path))
                                collected.Add(path);
                        }
                    }
                }

                if (collected.Count == 0 && e.DataTransfer.Formats.Contains(DataFormat.Text))
                    collected.Add(e.DataTransfer.TryGetText() ?? string.Empty);

                string[] urls = collected
                    .SelectMany(value => (value ?? string.Empty).Split(new[] { '\r', '\n', '\t', ' ' }, StringSplitOptions.RemoveEmptyEntries))
                    .Where(ArgsBuilder.IsAcceptedUrl)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToArray();

                if (urls.Length > 0)
                {
                    UrlBox.Text = string.Join(Environment.NewLine, urls);
                    await AddFromTextBoxAsync();
                }
            }
            catch (Exception ex)
            {
                await MessageBox.Show(this, ex.Message, "Import links", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
            finally
            {
                e.Handled = true;
            }
        }

        private async void PasteLinks_Click(object sender, RoutedEventArgs e)
        {
            try
            {
                var clipboard = TopLevel.GetTopLevel(this)?.Clipboard;
                string clip = clipboard == null ? "" : (await clipboard.TryGetTextAsync() ?? "");
                if (string.IsNullOrWhiteSpace(clip)) return;
                UrlBox.Text = string.IsNullOrWhiteSpace(UrlBox.Text) ? clip : (UrlBox.Text ?? string.Empty).TrimEnd() + Environment.NewLine + clip;
                UrlBox.Focus();
                UrlBox.CaretIndex = (UrlBox.Text ?? string.Empty).Length;
            }
            catch (Exception ex) { await MessageBox.Show(this, ex.Message, "Clipboard", MessageBoxButton.OK, MessageBoxImage.Warning); }
        }

        private async void BrowseOutput_Click(object sender, RoutedEventArgs e)
        {
            var folders = await StorageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions
            {
                Title = "Choose the download destination",
                AllowMultiple = false
            });
            if (folders.Count > 0)
            {
                string path = folders[0].Path?.LocalPath;
                if (!string.IsNullOrWhiteSpace(path))
                {
                    OutputPathBox.Text = path;
                    SaveMainSettings();
                }
            }
        }

        private static string ExistingDirectory(string path)
        {
            try { return Directory.Exists(path) ? path : Environment.GetFolderPath(Environment.SpecialFolder.MyVideos); }
            catch { return Environment.GetFolderPath(Environment.SpecialFolder.MyVideos); }
        }

        private async void OpenOutput_Click(object sender, RoutedEventArgs e) => await OpenFolderAsync(OutputPathBox.Text);

        private async void Settings_Click(object sender, RoutedEventArgs e)
        {
            SaveMainSettings();
            var window = new SettingsWindow(_settings, _tools, () => _items.Any(i => i.IsActive));
            if (await window.ShowDialog<bool>(this))
            {
                _settings.Save();
                LoadMainSettings();
                _tools.Refresh();
                await RefreshToolInfoAsync();
                FooterStatusText.Text = "Settings saved";
                ShowToast("Settings saved", "Your preferences have been updated.");
            }
        }

        private async void About_Click(object sender, RoutedEventArgs e)
        {
            string version = System.Reflection.Assembly.GetExecutingAssembly().GetName().Version == null ? "unknown" : System.Reflection.Assembly.GetExecutingAssembly().GetName().Version.ToString(3);
            string about = "FlickFetch\nVersion " + version + "\n\n" +
                "An independent Avalonia download manager using yt-dlp and FFmpeg for supported video sources, including accessible Facebook videos/Reels and Instagram posts/Reels.\n\n" +
                "Public Spotify playlist links can be parsed without a Spotify developer app or sign-in; FlickFetch then finds YouTube audio-first match suggestions for review.\n\n" +
                "Copyright © 2026 Jessie Albert Regualos.\n" +
                "Application UI and integration code. Third-party tools retain their respective copyrights and licenses.\n\n" +
                "Only download content you own or are authorized to save, and follow the source site's terms.";
            await MessageBox.Show(this, about, "About FlickFetch", MessageBoxButton.OK, MessageBoxImage.Information);
        }

        private async void Info_Click(object sender, RoutedEventArgs e)
        {
            string url = await FirstUrlAsync();
            if (url == null) return;
            if (!_tools.HasYtDlp) { await MessageBox.Show(this, "yt-dlp is not installed yet. Use Settings → Tools to install it.", "Tool unavailable", MessageBoxButton.OK, MessageBoxImage.Warning); return; }
            try
            {
                FooterStatusText.Text = "Inspecting video information…";
                var args = ArgsBuilder.BuildCommonArgs(_settings, _tools);
                args.AddRange(new[] { "--dump-single-json", "--skip-download", "--no-warnings", "--no-playlist", "--", url });
                CaptureResult result = await ProcessRunner.CaptureAsync(_tools.YtDlpPath, args, _tools.BinDir, 120000);
                if (result.ExitCode != 0) throw new InvalidOperationException(string.IsNullOrWhiteSpace(result.Stderr) ? result.Stdout : result.Stderr);
                using JsonDocument doc = JsonDocument.Parse(result.Stdout);
                JsonElement root = doc.RootElement;
                var sb = new StringBuilder();
                sb.AppendLine("TITLE\n" + JsonString(root, "title", "(unknown)") + "\n");
                sb.AppendLine("CHANNEL / CREATOR\n" + JsonString(root, "uploader", JsonString(root, "channel", "(unknown)")) + "\n");
                sb.AppendLine("DURATION\n" + FormatDuration(JsonNumber(root, "duration")) + "\n");
                sb.AppendLine("UPLOADED\n" + JsonString(root, "upload_date", "(unknown)") + "\n");
                sb.AppendLine("SOURCE URL\n" + JsonString(root, "webpage_url", url) + "\n");
                sb.AppendLine("DESCRIPTION\n" + JsonString(root, "description", "(not supplied)"));
                await ShowTextWindowAsync("Video information", sb.ToString(), 760, 620);
            }
            catch (Exception ex) { await MessageBox.Show(this, "Could not inspect this URL.\n\n" + ex.Message, "Video information", MessageBoxButton.OK, MessageBoxImage.Warning); }
            finally { FooterStatusText.Text = "Ready"; }
        }

        private async void Formats_Click(object sender, RoutedEventArgs e)
        {
            string url = await FirstUrlAsync();
            if (url == null) return;
            if (!_tools.HasYtDlp) { await MessageBox.Show(this, "yt-dlp is not installed yet. Use Settings → Tools to install it.", "Tool unavailable", MessageBoxButton.OK, MessageBoxImage.Warning); return; }
            try
            {
                FooterStatusText.Text = "Loading available formats…";
                var args = ArgsBuilder.BuildCommonArgs(_settings, _tools);
                args.AddRange(new[] { "-F", "--no-warnings", "--", url });
                CaptureResult result = await ProcessRunner.CaptureAsync(_tools.YtDlpPath, args, _tools.BinDir, 120000);
                string output = (result.Stdout + Environment.NewLine + result.Stderr).Trim();
                if (result.ExitCode != 0 && string.IsNullOrWhiteSpace(output)) output = "yt-dlp returned exit code " + result.ExitCode;
                await ShowTextWindowAsync("Available formats", output, 920, 650);
            }
            catch (Exception ex) { await MessageBox.Show(this, ex.Message, "Available formats", MessageBoxButton.OK, MessageBoxImage.Warning); }
            finally { FooterStatusText.Text = "Ready"; }
        }

        private async Task<string> FirstUrlAsync()
        {
            string[] urls = (UrlBox.Text ?? "").Split(new[] { '\r', '\n', '\t', ' ' }, StringSplitOptions.RemoveEmptyEntries);
            string url = urls.FirstOrDefault(u => ArgsBuilder.IsAcceptedUrl(u) && !PlatformResolver.IsSpotifyUrl(u));
            if (url == null)
            {
                bool hasSpotify = urls.Any(PlatformResolver.IsSpotifyUrl);
                string message = hasSpotify
                    ? "Spotify URLs do not expose downloadable audio here. Use 'Spotify playlist' to import tracks and find YouTube audio-first match suggestions, or use Spotify's official app for offline playback."
                    : "Paste a video or playlist URL in the URL box first.";
                await MessageBox.Show(this, message, "No downloadable video URL supplied", MessageBoxButton.OK, MessageBoxImage.Information);
            }
            SaveMainSettings();
            return url;
        }

        private static string JsonString(JsonElement root, string name, string fallback)
        {
            try { return root.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.String ? value.GetString() : fallback; }
            catch { return fallback; }
        }

        private static double JsonNumber(JsonElement root, string name)
        {
            try { return root.TryGetProperty(name, out JsonElement value) && value.TryGetDouble(out double d) ? d : -1; }
            catch { return -1; }
        }

        private static string FormatDuration(double seconds)
        {
            if (seconds < 0) return "(unknown)";
            TimeSpan t = TimeSpan.FromSeconds(seconds);
            return t.TotalHours >= 1 ? ((int)t.TotalHours) + ":" + t.Minutes.ToString("00") + ":" + t.Seconds.ToString("00") : t.Minutes + ":" + t.Seconds.ToString("00");
        }

        private async Task ShowTextWindowAsync(string title, string text, double width, double height)
        {
            var window = new Window
            {
                Title = title,
                Width = width,
                Height = height,
                MinWidth = 540,
                MinHeight = 320,
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
                Background = new SolidColorBrush(Color.Parse("#F4F6FB"))
            };
            var grid = new Grid { Margin = new Thickness(18), RowSpacing = 10 };
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var heading = new TextBlock { Text = title, FontSize = 18, FontWeight = FontWeight.Bold, Margin = new Thickness(0, 0, 0, 12) };
            Grid.SetRow(heading, 0); grid.Children.Add(heading);
            var box = new TextBox
            {
                Text = text ?? "",
                IsReadOnly = true,
                AcceptsReturn = true,
                TextWrapping = TextWrapping.NoWrap,
                FontFamily = new FontFamily("Consolas"),
                FontSize = 11.5,
                Padding = new Thickness(12),
                Background = Brushes.White
            };
            ScrollViewer.SetVerticalScrollBarVisibility(box, Avalonia.Controls.Primitives.ScrollBarVisibility.Auto);
            ScrollViewer.SetHorizontalScrollBarVisibility(box, Avalonia.Controls.Primitives.ScrollBarVisibility.Auto);
            Grid.SetRow(box, 1); grid.Children.Add(box);
            var buttons = new StackPanel { Orientation = Avalonia.Layout.Orientation.Horizontal, HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Right, Margin = new Thickness(0, 12, 0, 0) };
            var copy = new Button { Content = "Copy text", Margin = new Thickness(0, 0, 8, 0) }; copy.Classes.Add("secondary");
            copy.Click += async (s, e) => { try { var clipboard = TopLevel.GetTopLevel(window)?.Clipboard; if (clipboard != null) await clipboard.SetTextAsync(box.Text ?? ""); } catch { } };
            var close = new Button { Content = "Close", IsDefault = true }; close.Classes.Add("primary");
            close.Click += (s, e) => window.Close();
            buttons.Children.Add(copy); buttons.Children.Add(close);
            Grid.SetRow(buttons, 2); grid.Children.Add(buttons);
            window.Content = grid;
            await window.ShowDialog(this);
        }


        private void ShowToast(string title, string message)
        {
            ToastTitle.Text = title ?? "FlickFetch";
            ToastMessage.Text = message ?? string.Empty;
            ToastPanel.IsVisible = true;
            _toastTimer.Stop();
            _toastTimer.Start();
        }

        private void RefreshQueueRows()
        {
            foreach (DownloadQueueRow row in _rows) row.Refresh();
            QueueGrid.InvalidateVisual();
        }

        private void StartPause_Click(object sender, RoutedEventArgs e)
        {
            _queueRunning = !_queueRunning;
            UpdateQueueButton();
            FooterStatusText.Text = _queueRunning ? "Queue resumed" : "Queue paused · active downloads continue";
        }

        private void UpdateQueueButton() => StartPauseButton.Content = _queueRunning ? "Pause queue" : "Start queue";

        private void StopAll_Click(object sender, RoutedEventArgs e)
        {
            _queueRunning = false;
            UpdateQueueButton();
            CancelItems(_items.Where(i => !i.IsFinished).ToList());
            FooterStatusText.Text = "Stop requested for all queued and active items";
        }

        private void RetryFailed_Click(object sender, RoutedEventArgs e)
        {
            bool any = false;
            foreach (DownloadItem item in _items.Where(i => i.Status == ItemStatus.Failed || i.Status == ItemStatus.Canceled))
            {
                item.ResetForRetry();
                any = true;
            }
            if (any) { _queueRunning = true; UpdateQueueButton(); FooterStatusText.Text = "Failed downloads returned to queue"; }
        }

        private void ClearFinished_Click(object sender, RoutedEventArgs e)
        {
            RemoveItems(_items.Where(i => i.IsFinished).ToList());
            FooterStatusText.Text = "Finished queue items cleared";
        }

        private void CancelItems(List<DownloadItem> list)
        {
            foreach (DownloadItem item in list)
            {
                if (item.IsFinished) continue;
                item.CancelRequested = true;
                if (item.Status == ItemStatus.Queued)
                {
                    item.Status = ItemStatus.Canceled;
                    item.AddLog("Canceled.");
                }
                else ProcessRunner.KillTree(item.Proc);
            }
        }

        private List<DownloadItem> SelectedItems()
        {
            var rows = QueueGrid.SelectedItems?.OfType<DownloadQueueRow>().Select(r => r.Item).ToList();
            if (rows != null && rows.Count > 0) return rows;
            return QueueGrid.SelectedItem is DownloadQueueRow selected ? new List<DownloadItem> { selected.Item } : new List<DownloadItem>();
        }

        private void RemoveItems(List<DownloadItem> list)
        {
            foreach (DownloadItem item in list)
            {
                if (!item.IsFinished)
                {
                    item.CancelRequested = true;
                    ProcessRunner.KillTree(item.Proc);
                }
                _items.Remove(item);
                DownloadQueueRow row = _rows.FirstOrDefault(r => r.Item == item);
                if (row != null) _rows.Remove(row);
                if (_logItem == item) { _logItem = null; _logVersionShown = -1; LogBox.Text = string.Empty; }
            }
            for (int i = 0; i < _rows.Count; i++) _rows[i].Number = i + 1;
            RefreshQueueRows();
            EmptyQueuePanel.IsVisible = _rows.Count == 0;
            UpdateQueueSummary();
        }

        private void QueueGrid_SelectionChanged(object sender, SelectionChangedEventArgs e) => UpdateLogPane(true);

        private async void CopyLog_Click(object sender, RoutedEventArgs e)
        {
            try { var clipboard = TopLevel.GetTopLevel(this)?.Clipboard; if (clipboard != null) await clipboard.SetTextAsync(LogBox.Text ?? ""); FooterStatusText.Text = "Log copied to clipboard"; }
            catch (Exception ex) { await MessageBox.Show(this, ex.Message, "Copy log", MessageBoxButton.OK, MessageBoxImage.Warning); }
        }

        private void OnTick()
        {
            if (_isClosing) return;
            if (_settings.WatchClipboard) PollClipboard();
            PumpQueue();
            RefreshQueueRows();
            EmptyQueuePanel.IsVisible = _rows.Count == 0;
            UpdateQueueSummary();
            UpdateLogPane(false);
        }

        private void PumpQueue()
        {
            if (!_queueRunning || !_tools.HasYtDlp) return;
            int active = _items.Count(i => i.IsActive);
            int max = Math.Max(1, _settings.Parallel);
            foreach (DownloadItem item in _items.Where(i => i.Status == ItemStatus.Queued).ToList())
            {
                if (active >= max) break;
                active++;
                _ = RunSafeAsync(item);
            }
        }

        private async Task RunSafeAsync(DownloadItem item)
        {
            try { await DownloadRunner.RunAsync(item, _tools); }
            catch (Exception ex)
            {
                item.ErrorText = ex.Message;
                item.AddLog("ERROR: " + ex.Message);
                item.Status = ItemStatus.Failed;
            }
            RefreshQueueRows();
        }

        private void UpdateQueueSummary()
        {
            int active = _items.Count(i => i.IsActive);
            int queued = _items.Count(i => i.Status == ItemStatus.Queued);
            int done = _items.Count(i => i.Status == ItemStatus.Done);
            int failed = _items.Count(i => i.Status == ItemStatus.Failed);
            double speed = _items.Where(i => i.Status == ItemStatus.Downloading && i.Speed > 0).Sum(i => i.Speed);
            string summary = _items.Count + " items  ·  " + active + " active  ·  " + queued + " queued  ·  " + done + " completed  ·  " + failed + " failed";
            if (speed > 0) summary += "  ·  " + FormatBytes(speed) + "/s";
            if (!_queueRunning && queued > 0) summary += "  ·  PAUSED";
            QueueSummaryText.Text = summary;
        }

        private void UpdateLogPane(bool force)
        {
            DownloadItem selected = SelectedItems().FirstOrDefault();
            if (selected == null) selected = _items.LastOrDefault(i => i.IsActive) ?? _items.LastOrDefault();
            if (selected == null)
            {
                if (_logItem != null || !string.IsNullOrEmpty(LogBox.Text)) { _logItem = null; _logVersionShown = -1; LogBox.Text = string.Empty; }
                return;
            }
            if (force || _logItem != selected || _logVersionShown != selected.LogVersion)
            {
                _logItem = selected;
                _logVersionShown = selected.LogVersion;
                LogBox.Text = selected.GetLogText() ?? string.Empty;
                LogBox.CaretIndex = LogBox.Text.Length;
            }
        }

        private async void PollClipboard()
        {
            if (_clipboardPolling) return;
            _clipboardPolling = true;
            try
            {
                var clipboard = TopLevel.GetTopLevel(this)?.Clipboard;
                if (clipboard == null) return;
                string clip = (await clipboard.TryGetTextAsync() ?? "").Trim();
                if (clip.Length == 0 || clip == _lastClipboard) return;
                _lastClipboard = clip;
                if (clip.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).Any(ArgsBuilder.IsAcceptedUrl))
                {
                    string current = UrlBox.Text ?? "";
                    if (!current.Contains(clip, StringComparison.OrdinalIgnoreCase))
                        UrlBox.Text = string.IsNullOrWhiteSpace(current) ? clip : current.TrimEnd() + Environment.NewLine + clip;
                }
            }
            catch { }
            finally { _clipboardPolling = false; }
        }

        private async Task InstallComponentsAsync(bool yt, bool ffmpeg, bool deno)
        {
            if (_items.Any(i => i.IsActive))
            {
                await MessageBox.Show(this, "Stop active downloads before changing the downloader tools.", "Tools are in use", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }
            FooterStatusText.Text = "Preparing tool installation…";
            try
            {
                await _tools.InstallAsync(yt, ffmpeg, deno, (message, fraction) => Dispatcher.UIThread.Post(() => FooterStatusText.Text = message + "  " + (fraction * 100).ToString("0") + "%"), CancellationToken.None);
                await RefreshToolInfoAsync();
                FooterStatusText.Text = "Downloader tools installed";
            }
            catch (Exception ex)
            {
                FooterStatusText.Text = "Tool installation failed";
                await MessageBox.Show(this, "The component installation did not complete.\n\n" + ex.Message, "Tool installation", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }

        private async void MainWindow_Closing(object sender, WindowClosingEventArgs e)
        {
            if (_isClosing)
            {
                _timer.Stop();
                _toastTimer?.Stop();
                SaveMainSettings();
                return;
            }
            if (_items.Any(i => i.IsActive))
            {
                e.Cancel = true;
                MessageBoxResult answer = await MessageBox.Show(this, "Downloads are still running. Stop them and exit FlickFetch?", "Downloads in progress", MessageBoxButton.YesNo, MessageBoxImage.Warning);
                if (answer != MessageBoxResult.Yes) return;
                _isClosing = true;
                _timer.Stop();
                _toastTimer?.Stop();
                CancelItems(_items.Where(i => !i.IsFinished).ToList());
                SaveMainSettings();
                Close();
                return;
            }
            _isClosing = true;
            _timer.Stop();
            _toastTimer?.Stop();
            CancelItems(_items.Where(i => !i.IsFinished).ToList());
            SaveMainSettings();
        }

        private async Task OpenFolderAsync(string path)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(path)) return;
                Directory.CreateDirectory(path);
                Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
            }
            catch (Exception ex) { await MessageBox.Show(this, ex.Message, "Open folder", MessageBoxButton.OK, MessageBoxImage.Error); }
        }

        private static string FormatBytes(double bytes)
        {
            string[] units = { "B", "KiB", "MiB", "GiB", "TiB" };
            int i = 0;
            while (bytes >= 1024 && i < units.Length - 1) { bytes /= 1024; i++; }
            return (i == 0 ? bytes.ToString("0") : bytes.ToString("0.0")) + " " + units[i];
        }

        private static string FormatEta(double seconds)
        {
            if (seconds < 0) return "—";
            TimeSpan span = TimeSpan.FromSeconds(seconds);
            return span.TotalHours >= 1 ? ((int)span.TotalHours) + ":" + span.Minutes.ToString("00") + ":" + span.Seconds.ToString("00") : span.Minutes.ToString("00") + ":" + span.Seconds.ToString("00");
        }

        private sealed class DownloadQueueRow : System.ComponentModel.INotifyPropertyChanged
        {
            public event System.ComponentModel.PropertyChangedEventHandler PropertyChanged;
            public DownloadItem Item { get; }
            private int _number;
            public int Number
            {
                get => _number;
                set { if (_number != value) { _number = value; Raise(nameof(Number)); } }
            }
            public string Url => Item.Url ?? "";
            public string DisplayTitle => string.IsNullOrWhiteSpace(Item.Title) ? Item.Url : Item.Title;
            public string StatusText => StatusName(Item);
            public string ProgressCaption => Item.Status == ItemStatus.Queued ? "Waiting" :
                Item.Status == ItemStatus.Starting ? "Starting" :
                Item.Status == ItemStatus.Downloading ? "Downloading" :
                Item.Status == ItemStatus.Processing ? "Processing" :
                Item.Status == ItemStatus.Failed ? "Failed" :
                Item.Status == ItemStatus.Canceled ? "Canceled" : "Downloaded";
            public double ProgressValue => Item.OverallProgress < 0 ? 0 : Math.Max(0, Math.Min(100, Item.OverallProgress));
            public string ProgressText => Item.OverallProgress < 0 ? "—" : Item.OverallProgress.ToString("0") + "%";
            public string SpeedText => Item.Speed > 0 ? FormatBytes(Item.Speed) + "/s" : "—";
            public string EtaText => Item.Eta >= 0 ? FormatEta(Item.Eta) : "—";
            public DownloadQueueRow(DownloadItem item, int number) { Item = item; Number = number; }

            public void Refresh()
            {
                Raise(nameof(DisplayTitle)); Raise(nameof(Url)); Raise(nameof(StatusText));
                Raise(nameof(ProgressCaption)); Raise(nameof(ProgressValue)); Raise(nameof(ProgressText));
                Raise(nameof(SpeedText)); Raise(nameof(EtaText));
            }

            private void Raise(string name) => PropertyChanged?.Invoke(this, new System.ComponentModel.PropertyChangedEventArgs(name));

            private static string StatusName(DownloadItem item)
            {
                switch (item.Status)
                {
                    case ItemStatus.Queued: return "Queued";
                    case ItemStatus.Starting: return "Starting";
                    case ItemStatus.Downloading: return "Downloading";
                    case ItemStatus.Processing: return string.IsNullOrWhiteSpace(item.Stage) ? "Processing" : "Processing · " + item.Stage;
                    case ItemStatus.Done: return "Completed";
                    case ItemStatus.Failed: return "Failed";
                    case ItemStatus.Canceled: return "Canceled";
                    default: return "—";
                }
            }
        }
    }
}
