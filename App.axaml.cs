// Copyright © 2026 Jessie Albert Regualos. Application source and integration code.
using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Avalonia.Threading;

namespace FlickFetch
{
    public partial class App : Application
    {
        public override void Initialize() => AvaloniaXamlLoader.Load(this);

        public override void OnFrameworkInitializationCompleted()
        {
            // Log UI-thread exceptions (timers, event handlers) instead of letting them silently end the process.
            Dispatcher.UIThread.UnhandledException += (s, e) =>
            {
                Program.LogCrash("UI thread", e.Exception);
                e.Handled = true;
            };

            if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
                desktop.MainWindow = new MainWindow();
            base.OnFrameworkInitializationCompleted();
        }
    }
}
