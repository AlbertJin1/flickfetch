// Copyright © 2026 Jessie Albert Regualos. Application source and integration code.
using Avalonia;
using Avalonia.Fonts.Inter;
using System;
using System.IO;
using System.Threading.Tasks;

namespace FlickFetch
{
    internal static class Program
    {
        [STAThread]
        public static int Main(string[] args)
        {
            AppDomain.CurrentDomain.UnhandledException += (s, e) => LogCrash("AppDomain.UnhandledException", e.ExceptionObject as Exception);
            TaskScheduler.UnobservedTaskException += (s, e) => { LogCrash("TaskScheduler.UnobservedTaskException", e.Exception); e.SetObserved(); };
            try
            {
                return BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
            }
            catch (Exception ex)
            {
                LogCrash("Startup", ex);
                return 1;
            }
        }

        public static AppBuilder BuildAvaloniaApp() => AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace();

        /// <summary>Writes unexpected errors to %LocalAppData%\FlickFetch\logs\crash.log so a silent exit can be diagnosed.</summary>
        internal static void LogCrash(string source, Exception ex)
        {
            try
            {
                string folder = Path.Combine(AppSettings.AppDataDir, "logs");
                Directory.CreateDirectory(folder);
                File.AppendAllText(Path.Combine(folder, "crash.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  [" + source + "]" + Environment.NewLine +
                    (ex == null ? "(no exception object)" : ex.ToString()) + Environment.NewLine + Environment.NewLine);
            }
            catch { }
        }
    }
}
