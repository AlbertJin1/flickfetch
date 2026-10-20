// Copyright © 2026 Jessie Albert Regualos. Application source and integration code.
using Avalonia;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Markup.Xaml;
using Avalonia.Platform.Storage;
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace FlickFetch
{
    public partial class SpotifyPlaylistWindow : Window
    {
        private readonly SpotifyPlaylist _playlist;
        private readonly ToolManager _tools;
        private CancellationTokenSource _matchCancellation;

        public SpotifyPlaylistWindow(SpotifyPlaylist playlist, ToolManager tools)
        {
            _playlist = playlist ?? throw new ArgumentNullException(nameof(playlist));
            _tools = tools ?? throw new ArgumentNullException(nameof(tools));
            InitializeComponent();
            PlaylistNameText.Text = string.IsNullOrWhiteSpace(_playlist.Name) ? "Spotify playlist" : _playlist.Name;
            PlaylistMetaText.Text = (string.IsNullOrWhiteSpace(_playlist.Owner) ? "Spotify" : "By " + _playlist.Owner) +
                "  ·  " + _playlist.Tracks.Count + (_playlist.Tracks.Count == 1 ? " item" : " items");
            TracksGrid.ItemsSource = _playlist.Tracks;
            FooterText.Text = "Loading audio-first YouTube match suggestions…";
            MatchCountText.Text = "0 / " + _playlist.Tracks.Count + " tracks";
            MatchProgress.Maximum = Math.Max(1, _playlist.Tracks.Count);
        }

        private async void Window_Loaded(object sender, EventArgs e)
        {
            await Task.Delay(100);
            await RunMatchesAsync();
        }

        private async void OpenPlaylist_Click(object sender, RoutedEventArgs e) => await OpenUrlAsync(_playlist.Url, "Spotify playlist");

        private async void FindMatches_Click(object sender, RoutedEventArgs e) => await RunMatchesAsync();

        private async Task RunMatchesAsync()
        {
            if (_matchCancellation != null)
            {
                _matchCancellation.Cancel();
                FindMatchesButton.Content = "Canceling…";
                FindMatchesButton.IsEnabled = false;
                return;
            }

            if (_playlist.Tracks.Count == 0)
            {
                await MessageBox.Show(this, "This playlist does not contain any searchable tracks.", "No playlist items", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }
            if (_tools == null || !_tools.HasYtDlp)
            {
                await MessageBox.Show(this, "YouTube matching needs yt-dlp. Open Settings → Tools and install or repair the downloader tools, then try again.", "Tools required", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }

            var cancellation = new CancellationTokenSource();
            _matchCancellation = cancellation;
            FindMatchesButton.Content = "Cancel search";
            FindMatchesButton.IsEnabled = true;
            MatchProgress.Value = 0;
            MatchProgress.Maximum = Math.Max(1, _playlist.Tracks.Count);
            MatchCountText.Text = "0 / " + _playlist.Tracks.Count + " tracks";
            int found = 0;
            int failed = 0;
            int total = _playlist.Tracks.Count;

            try
            {
                for (int i = 0; i < total; i++)
                {
                    cancellation.Token.ThrowIfCancellationRequested();
                    SpotifyTrack track = _playlist.Tracks[i];
                    FooterText.Text = "Searching " + (i + 1) + " of " + total + " · " + track.Title;
                    MatchProgress.Value = i;
                    MatchCountText.Text = i + " / " + total + " tracks";
                    try
                    {
                        YouTubeMatch match = await YouTubeMatchService.FindBestMatchAsync(track, _tools, cancellation.Token);
                        if (match != null)
                        {
                            track.YouTubeMatchTitle = match.Title;
                            track.YouTubeMatchChannel = match.Channel;
                            track.YouTubeMatchUrl = match.Url;
                            track.YouTubeMatchScoreText = match.Score.ToString() + "% · " + match.MatchLabel;
                            track.YouTubeMatchNote = "";
                            found++;
                        }
                        else
                        {
                            track.YouTubeMatchTitle = "";
                            track.YouTubeMatchChannel = "";
                            track.YouTubeMatchUrl = "";
                            track.YouTubeMatchScoreText = "No match";
                            track.YouTubeMatchNote = "No usable result found";
                            failed++;
                        }
                    }
                    catch (OperationCanceledException) { throw; }
                    catch (Exception ex)
                    {
                        track.YouTubeMatchTitle = "";
                        track.YouTubeMatchChannel = "";
                        track.YouTubeMatchUrl = "";
                        track.YouTubeMatchScoreText = "Search failed";
                        track.YouTubeMatchNote = "Search failed: " + ex.Message;
                        failed++;
                    }

                    TracksGrid.InvalidateVisual();
                    MatchProgress.Value = i + 1;
                    MatchCountText.Text = (i + 1) + " / " + total + " tracks";
                    await Task.Delay(80, cancellation.Token);
                }

                MatchProgress.Value = total;
                MatchCountText.Text = total + " / " + total + " tracks";
                FooterText.Text = "Matching complete · " + found + " candidate" + (found == 1 ? "" : "s") +
                    (failed == 0 ? "" : " · " + failed + " item(s) need review") + " · review links before downloading";
            }
            catch (OperationCanceledException)
            {
                FooterText.Text = "Search canceled. Matches already found are kept.";
            }
            catch (Exception ex)
            {
                FooterText.Text = "YouTube matching stopped: " + ex.Message;
                await MessageBox.Show(this, "Could not finish YouTube matching.\n\n" + ex.Message, "YouTube matching", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
            finally
            {
                cancellation.Dispose();
                _matchCancellation = null;
                FindMatchesButton.IsEnabled = true;
                FindMatchesButton.Content = "Search again";
                MatchCountText.Text = Math.Min((int)MatchProgress.Value, _playlist.Tracks.Count) + " / " + _playlist.Tracks.Count + " tracks";
                TracksGrid.InvalidateVisual();
            }
        }

        private async void OpenYouTubeMatch_Click(object sender, RoutedEventArgs e)
        {
            if (TracksGrid.SelectedItem is SpotifyTrack track && !string.IsNullOrWhiteSpace(track.YouTubeMatchUrl))
            {
                await OpenUrlAsync(track.YouTubeMatchUrl, "YouTube match");
                return;
            }
            await MessageBox.Show(this, "Select a playlist item with a YouTube match first. Run Find YouTube audio matches if you have not searched yet.", "No YouTube match selected", MessageBoxButton.OK, MessageBoxImage.Information);
        }

        private async void OpenSelected_Click(object sender, RoutedEventArgs e)
        {
            if (TracksGrid.SelectedItem is SpotifyTrack track && !string.IsNullOrWhiteSpace(track.SpotifyUrl))
            {
                await OpenUrlAsync(track.SpotifyUrl, "Spotify track");
                return;
            }
            await MessageBox.Show(this, "Select a track or episode first.", "No track selected", MessageBoxButton.OK, MessageBoxImage.Information);
        }

        private async void ExportCsv_Click(object sender, RoutedEventArgs e)
        {
            var file = await StorageProvider.SaveFilePickerAsync(new FilePickerSaveOptions
            {
                Title = "Export playlist metadata and YouTube match suggestions",
                SuggestedFileName = SafeFileName(_playlist.Name) + ".csv",
                DefaultExtension = "csv",
                FileTypeChoices = new[] { new FilePickerFileType("CSV file") { Patterns = new[] { "*.csv" }, MimeTypes = new[] { "text/csv" } } }
            });
            if (file == null) return;
            string filePath = file.Path?.LocalPath;
            if (string.IsNullOrWhiteSpace(filePath)) return;
            try
            {
                var sb = new StringBuilder();
                sb.AppendLine("Number,Title,Artist or Show,Album or Podcast,Duration,Spotify URL,YouTube Match Title,YouTube Match Channel,YouTube Match URL,YouTube Match Score,Playlist URL");
                foreach (SpotifyTrack track in _playlist.Tracks)
                {
                    sb.Append(Csv(track.Number.ToString())).Append(',')
                      .Append(Csv(track.Title)).Append(',')
                      .Append(Csv(track.Artist)).Append(',')
                      .Append(Csv(track.Album)).Append(',')
                      .Append(Csv(track.DurationText)).Append(',')
                      .Append(Csv(track.SpotifyUrl)).Append(',')
                      .Append(Csv(track.YouTubeMatchTitle)).Append(',')
                      .Append(Csv(track.YouTubeMatchChannel)).Append(',')
                      .Append(Csv(track.YouTubeMatchUrl)).Append(',')
                      .Append(Csv(track.YouTubeMatchScoreText)).Append(',')
                      .Append(Csv(_playlist.Url)).AppendLine();
                }
                File.WriteAllText(filePath, sb.ToString(), new UTF8Encoding(true));
                await MessageBox.Show(this, "Playlist metadata and any YouTube match suggestions were exported successfully. Spotify and YouTube links are included for review and attribution.", "Export complete", MessageBoxButton.OK, MessageBoxImage.Information);
            }
            catch (Exception ex)
            {
                await MessageBox.Show(this, "Could not export the CSV file.\n\n" + ex.Message, "Export failed", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }

        private void Close_Click(object sender, RoutedEventArgs e)
        {
            if (_matchCancellation != null) _matchCancellation.Cancel();
            Close();
        }

        private async Task OpenUrlAsync(string url, string sourceName)
        {
            if (string.IsNullOrWhiteSpace(url)) return;
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
            catch (Exception ex) { await MessageBox.Show(this, "Could not open the " + sourceName + ".\n\n" + ex.Message, "Open link", MessageBoxButton.OK, MessageBoxImage.Warning); }
        }

        private static string Csv(string value)
        {
            string text = value ?? "";
            return "\"" + text.Replace("\"", "\"\"") + "\"";
        }

        private static string SafeFileName(string name)
        {
            string result = string.Join("_", (name ?? "Spotify playlist").Split(Path.GetInvalidFileNameChars(), StringSplitOptions.RemoveEmptyEntries));
            return string.IsNullOrWhiteSpace(result) ? "Spotify playlist" : result;
        }
    }
}
