// Copyright © 2026 Jessie Albert Regualos. Application source and integration code.
using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Interactivity;
using System.Threading.Tasks;

namespace FlickFetch
{
    internal enum MessageBoxButton { OK, YesNo }
    internal enum MessageBoxImage { Information, Warning, Error, Question }
    internal enum MessageBoxResult { None, OK, Yes, No }

    /// <summary>A compact, Fluent-styled modal dialog built with native Avalonia controls.</summary>
    internal static class MessageBox
    {
        public static async Task<MessageBoxResult> Show(
            Window owner, string message, string title,
            MessageBoxButton buttons = MessageBoxButton.OK,
            MessageBoxImage image = MessageBoxImage.Information)
        {
            var dialog = new Window
            {
                Title = title ?? "FlickFetch",
                Width = 440,
                MinWidth = 360,
                MaxWidth = 560,
                SizeToContent = SizeToContent.Height,
                CanResize = false,
                ShowInTaskbar = false,
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
                Background = Brushes.White,
            };

            var root = new Grid { Margin = new Thickness(22) };
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var heading = new TextBlock
            {
                Text = title ?? "FlickFetch",
                FontSize = 17,
                FontWeight = FontWeight.Bold,
                Foreground = Brush("#172033"),
                Margin = new Thickness(0, 0, 0, 12)
            };
            Grid.SetRow(heading, 0);
            root.Children.Add(heading);

            var body = new Grid { ColumnSpacing = 12, Margin = new Thickness(0, 0, 0, 18) };
            body.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var glyph = new TextBlock
            {
                Text = image == MessageBoxImage.Error ? "!" : image == MessageBoxImage.Warning ? "⚠" : image == MessageBoxImage.Question ? "?" : "i",
                FontSize = 18,
                FontWeight = FontWeight.Bold,
                Foreground = Brush(image == MessageBoxImage.Error ? "#C2414B" : image == MessageBoxImage.Warning ? "#AA741B" : "#5B5CE2"),
                VerticalAlignment = VerticalAlignment.Top,
                HorizontalAlignment = HorizontalAlignment.Center,
                Width = 26
            };
            body.Children.Add(glyph);
            var content = new TextBlock
            {
                Text = message ?? string.Empty,
                FontSize = 11.5,
                Foreground = Brush("#4E5A70"),
                TextWrapping = TextWrapping.Wrap,
                MaxWidth = 470
            };
            Grid.SetColumn(content, 1);
            body.Children.Add(content);
            Grid.SetRow(body, 1);
            root.Children.Add(body);

            var actions = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Spacing = 8 };
            if (buttons == MessageBoxButton.YesNo)
            {
                var no = Button("No", false);
                no.Click += (s, e) => dialog.Close(MessageBoxResult.No);
                actions.Children.Add(no);
                var yes = Button("Yes", true);
                yes.Click += (s, e) => dialog.Close(MessageBoxResult.Yes);
                actions.Children.Add(yes);
            }
            else
            {
                var ok = Button("OK", true);
                ok.Click += (s, e) => dialog.Close(MessageBoxResult.OK);
                actions.Children.Add(ok);
            }
            Grid.SetRow(actions, 2);
            root.Children.Add(actions);
            dialog.Content = root;

            return await dialog.ShowDialog<MessageBoxResult>(owner);
        }

        private static Button Button(string label, bool primary)
        {
            var button = new Button { Content = label, MinWidth = 84, Padding = new Thickness(14, 8) };
            button.Classes.Add(primary ? "primary" : "secondary");
            return button;
        }

        private static IBrush Brush(string value) => new SolidColorBrush(Color.Parse(value));
    }
}
