// Copyright © 2026 Jessie Albert Regualos. Application source and integration code.
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Markup.Xaml;
using Avalonia.Platform.Storage;
using Avalonia.Threading;
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace FlickFetch
{
    public partial class SettingsWindow : Window
    {
        private readonly AppSettings _settings;
        private readonly ToolManager _tools;
        private readonly Func<bool> _hasActiveDownloads;

        public SettingsWindow(AppSettings settings, ToolManager tools, Func<bool> hasActiveDownloads)
        {
            _settings = settings;
            _tools = tools;
            _hasActiveDownloads = hasActiveDownloads ?? (() => false);
            InitializeComponent();
            LoadValues();
        }

        private void Window_Loaded(object sender, EventArgs e) { }

        private void LoadValues()
        {
            CustomFormatBox.Text = _settings.CustomFormat ?? "";
            AudioQualityBox.ItemsSource = new[] { "0", "320K", "256K", "192K", "128K", "96K" };
            AudioQualityBox.SelectedItem = _settings.AudioQuality;
            if (AudioQualityBox.SelectedIndex < 0) AudioQualityBox.SelectedIndex = 0;
            TemplateBox.Text = _settings.Template ?? "%(title).150B [%(id)s].%(ext)s";
            RestrictCheck.IsChecked = _settings.Restrict;
            OverwriteCheck.IsChecked = _settings.Overwrite;
            InfoJsonCheck.IsChecked = _settings.InfoJson;
            DescriptionCheck.IsChecked = _settings.Description;
            WriteThumbCheck.IsChecked = _settings.WriteThumb;
            ArchiveCheck.IsChecked = _settings.UseArchive;
            SectionStartBox.Text = _settings.SectionStart ?? "";
            SectionEndBox.Text = _settings.SectionEnd ?? "";

            SubsCheck.IsChecked = _settings.Subs;
            AutoSubsCheck.IsChecked = _settings.AutoSubs;
            EmbedSubsCheck.IsChecked = _settings.EmbedSubs;
            SubtitleLanguagesBox.Text = _settings.SubLangs ?? "en.*";
            ThumbCheck.IsChecked = _settings.EmbedThumb;
            MetadataCheck.IsChecked = _settings.EmbedMeta;
            SponsorCheck.IsChecked = _settings.Sponsor;

            BrowserBox.ItemsSource = new[] { "(none)", "chrome", "edge", "firefox", "brave", "opera", "vivaldi", "chromium", "safari" };
            BrowserBox.SelectedItem = string.IsNullOrWhiteSpace(_settings.CookiesBrowser) ? "(none)" : _settings.CookiesBrowser;
            if (BrowserBox.SelectedIndex < 0) BrowserBox.SelectedItem = "(none)";
            ProxyBox.Text = _settings.Proxy ?? "";
            CookiesFileBox.Text = _settings.CookiesFile ?? "";
            RateLimitBox.Text = _settings.RateLimit ?? "";
            FragmentsBox.ItemsSource = Enumerable.Range(1, 16).ToArray();
            FragmentsBox.SelectedItem = Clamp(_settings.Fragments, 1, 16);
            RetriesBox.ItemsSource = Enumerable.Range(0, 51).ToArray();
            RetriesBox.SelectedItem = Clamp(_settings.Retries, 0, 50);
            ParallelBox.ItemsSource = Enumerable.Range(1, 6).ToArray();
            ParallelBox.SelectedItem = Clamp(_settings.Parallel, 1, 6);

            AutoStartCheck.IsChecked = _settings.AutoStart;
            ClipboardCheck.IsChecked = _settings.WatchClipboard;
            AutoUpdateCheck.IsChecked = _settings.AutoUpdate;
            ExtraArgsBox.Text = _settings.ExtraArgs ?? "";
            ToolsStatusText.Text = "Tool directory: " + _tools.BinDir;
        }

        private static int Clamp(int value, int min, int max) => value < min ? min : value > max ? max : value;

        private async void Save_Click(object sender, RoutedEventArgs e)
        {
            AppSettings pending = CopySettings(_settings);
            pending.CustomFormat = (CustomFormatBox.Text ?? "").Trim();
            pending.AudioQuality = AudioQualityBox.SelectedItem as string ?? "0";
            pending.Template = string.IsNullOrWhiteSpace(TemplateBox.Text) ? "%(title).150B [%(id)s].%(ext)s" : (TemplateBox.Text ?? "").Trim();
            pending.Restrict = RestrictCheck.IsChecked == true;
            pending.Overwrite = OverwriteCheck.IsChecked == true;
            pending.InfoJson = InfoJsonCheck.IsChecked == true;
            pending.Description = DescriptionCheck.IsChecked == true;
            pending.WriteThumb = WriteThumbCheck.IsChecked == true;
            pending.UseArchive = ArchiveCheck.IsChecked == true;
            pending.SectionStart = (SectionStartBox.Text ?? "").Trim();
            pending.SectionEnd = (SectionEndBox.Text ?? "").Trim();

            pending.Subs = SubsCheck.IsChecked == true;
            pending.AutoSubs = AutoSubsCheck.IsChecked == true;
            pending.EmbedSubs = EmbedSubsCheck.IsChecked == true;
            pending.SubLangs = (SubtitleLanguagesBox.Text ?? "").Trim();
            pending.EmbedThumb = ThumbCheck.IsChecked == true;
            pending.EmbedMeta = MetadataCheck.IsChecked == true;
            pending.Sponsor = SponsorCheck.IsChecked == true;

            string selectedBrowser = BrowserBox.SelectedItem as string;
            pending.CookiesBrowser = string.Equals(selectedBrowser, "(none)", StringComparison.Ordinal) ? "" : (selectedBrowser ?? "");
            pending.Proxy = (ProxyBox.Text ?? "").Trim();
            pending.CookiesFile = (CookiesFileBox.Text ?? "").Trim();
            pending.RateLimit = (RateLimitBox.Text ?? "").Trim();
            pending.Fragments = Convert.ToInt32(FragmentsBox.SelectedItem ?? 4);
            pending.Retries = Convert.ToInt32(RetriesBox.SelectedItem ?? 10);
            pending.Parallel = Convert.ToInt32(ParallelBox.SelectedItem ?? 2);

            pending.AutoStart = AutoStartCheck.IsChecked == true;
            pending.WatchClipboard = ClipboardCheck.IsChecked == true;
            pending.AutoUpdate = AutoUpdateCheck.IsChecked == true;
            pending.ExtraArgs = (ExtraArgsBox.Text ?? "").Trim();

            string validation = ArgsBuilder.Validate(pending);
            if (validation != null)
            {
                await MessageBox.Show(this, validation, "Check settings", MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }
            CopyInto(pending, _settings);
            _settings.Save();
            Close(true);
        }

        private static AppSettings CopySettings(AppSettings source)
        {
            var copy = new AppSettings();
            CopyInto(source, copy);
            return copy;
        }

        private static void CopyInto(AppSettings source, AppSettings destination)
        {
            foreach (PropertyInfo property in typeof(AppSettings).GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                if (!property.CanRead || !property.CanWrite) continue;
                property.SetValue(destination, property.GetValue(source, null), null);
            }
        }

        private void Cancel_Click(object sender, RoutedEventArgs e)
        {
            Close(false);
        }

        private async void BrowseCookies_Click(object sender, RoutedEventArgs e)
        {
            var files = await StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
            {
                Title = "Choose a Netscape-format cookies.txt file",
                AllowMultiple = false,
                FileTypeFilter = new[]
                {
                    new FilePickerFileType("Cookie files") { Patterns = new[] { "*.txt" } },
                    new FilePickerFileType("All files") { Patterns = new[] { "*.*" } }
                }
            });
            if (files.Count > 0) CookiesFileBox.Text = files[0].Path?.LocalPath ?? string.Empty;
        }

        private async void UpdateYtDlp_Click(object sender, RoutedEventArgs e)
        {
            if (!await EnsureToolsCanChangeAsync()) return;
            if (!_tools.HasYtDlp)
            {
                await MessageBox.Show(this, "yt-dlp is not currently installed. Use Install / reinstall tools first.", "Update yt-dlp", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }
            try
            {
                ToolsStatusText.Text = "Checking for yt-dlp updates…";
                string output = await _tools.UpdateYtDlpAsync();
                ToolsStatusText.Text = output;
                await MessageBox.Show(this, output, "yt-dlp update", MessageBoxButton.OK, MessageBoxImage.Information);
            }
            catch (Exception ex)
            {
                ToolsStatusText.Text = "Update failed: " + ex.Message;
                await MessageBox.Show(this, ex.Message, "yt-dlp update", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }

        private async void ReinstallTools_Click(object sender, RoutedEventArgs e)
        {
            if (!await EnsureToolsCanChangeAsync()) return;
            MessageBoxResult confirm = await MessageBox.Show(this,
                "Download the latest yt-dlp, FFmpeg and Deno components and replace the installed copies?\n\nThis requires an internet connection and can download a large FFmpeg archive.",
                "Install / reinstall tools", MessageBoxButton.YesNo, MessageBoxImage.Question);
            if (confirm != MessageBoxResult.Yes) return;

            ToolsProgress.IsVisible = true;
            ToolsProgress.Value = 0;
            try
            {
                await _tools.InstallAsync(true, true, true, (message, fraction) => Dispatcher.UIThread.Post(() =>
                {
                    ToolsStatusText.Text = message;
                    ToolsProgress.Value = Math.Max(0, Math.Min(100, fraction * 100));
                }), CancellationToken.None);
                ToolsStatusText.Text = "All downloader tools installed successfully.";
                await MessageBox.Show(this, "The downloader tools have been updated.", "Tools ready", MessageBoxButton.OK, MessageBoxImage.Information);
            }
            catch (Exception ex)
            {
                ToolsStatusText.Text = "Tool installation failed: " + ex.Message;
                await MessageBox.Show(this, "Installation did not finish.\n\n" + ex.Message, "Tool installation", MessageBoxButton.OK, MessageBoxImage.Error);
            }
            finally { ToolsProgress.IsVisible = false; }
        }

        private async Task<bool> EnsureToolsCanChangeAsync()
        {
            if (!_hasActiveDownloads()) return true;
            await MessageBox.Show(this, "Stop active downloads before changing the downloader tools.", "Tools are in use", MessageBoxButton.OK, MessageBoxImage.Information);
            return false;
        }

        private async void ShowVersions_Click(object sender, RoutedEventArgs e)
        {
            _tools.Refresh();
            string ytdlp = await _tools.GetYtDlpVersionAsync();
            string ffmpeg = await _tools.GetFfmpegVersionAsync();
            var text = new StringBuilder();
            text.AppendLine("yt-dlp: " + (ytdlp ?? "not installed"));
            text.AppendLine("Path: " + (_tools.YtDlpPath ?? "(none)"));
            text.AppendLine();
            text.AppendLine("FFmpeg: " + (ffmpeg ?? "not installed"));
            text.AppendLine("Path: " + (_tools.FfmpegPath ?? "(none)"));
            text.AppendLine();
            text.AppendLine("Deno: " + (_tools.HasDeno ? _tools.DenoPath : "not installed"));
            text.AppendLine();
            text.AppendLine("Settings: " + AppSettings.FilePath);
            text.AppendLine("Bundled tool extraction directory: " + _tools.BinDir);
            await MessageBox.Show(this, text.ToString(), "Downloader tool versions", MessageBoxButton.OK, MessageBoxImage.Information);
        }
    }
}
