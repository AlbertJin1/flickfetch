// Copyright © 2026 Jessie Albert Regualos. Application source and integration code.
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;

namespace FlickFetch
{
    /// <summary>Runs one queue item through yt-dlp and leaves it in a final state (Done / Failed / Canceled).</summary>
    public static class DownloadRunner
    {
        public static async Task RunAsync(DownloadItem it, ToolManager tools)
        {
            it.Status = ItemStatus.Starting;
            it.Stage = "";
            it.ErrorText = null;
            int code = -1;
            string fatal = null;

            try
            {
                if (string.IsNullOrEmpty(tools.YtDlpPath)) throw new FileNotFoundException("yt-dlp was not found.");

                var args = new List<string>(it.Args);
                args.Add("--");
                args.Add(it.Url);
                it.AddLog("> yt-dlp " + ProcessRunner.JoinArgs(args));

                code = await ProcessRunner.RunAsync(
                    tools.YtDlpPath, args, tools.BinDir,
                    line => OutputParser.Handle(it, line, false),
                    line => OutputParser.Handle(it, line, true),
                    p =>
                    {
                        it.Proc = p;
                        if (it.CancelRequested) ProcessRunner.KillTree(p);
                    }).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                fatal = ex.Message;
            }

            it.Proc = null;
            it.Speed = -1;
            it.Eta = -1;

            if (it.CancelRequested)
            {
                it.AddLog("Canceled.");
                it.Status = ItemStatus.Canceled;
            }
            else if (fatal != null)
            {
                it.ErrorText = fatal;
                it.AddLog("ERROR: " + fatal);
                it.Status = ItemStatus.Failed;
            }
            else if (code == 0)
            {
                it.FileProgress = 100;
                try
                {
                    if (!string.IsNullOrEmpty(it.FilePath) && File.Exists(it.FilePath))
                        it.FinalSize = new FileInfo(it.FilePath).Length;
                }
                catch { }
                it.Status = ItemStatus.Done;
            }
            else
            {
                if (string.IsNullOrEmpty(it.ErrorText)) it.ErrorText = "yt-dlp exited with code " + code + ".";
                it.ErrorText = AddHint(it.ErrorText, it.Url);
                it.AddLog("Failed: " + it.ErrorText);
                it.Status = ItemStatus.Failed;
            }
        }

        private static string AddHint(string error, string url)
        {
            string e = error.ToLowerInvariant();
            if (PlatformResolver.IsFacebookUrl(url) && (e.Contains("login") || e.Contains("cookie") || e.Contains("private") || e.Contains("unavailable")))
                return error + "  [Facebook tip: confirm the post is available to your account and configure cookies from your own logged-in browser in Settings → Network & login. Update yt-dlp if the URL format recently changed.]";
            if (PlatformResolver.IsInstagramUrl(url) && (e.Contains("login") || e.Contains("cookie") || e.Contains("private") || e.Contains("unavailable") || e.Contains("challenge")))
                return error + "  [Instagram tip: confirm the post/Reel is accessible to your account and configure cookies from your own logged-in browser in Settings → Network & login. Private posts and account challenges may not be available.]";
            if (e.Contains("sign in to confirm") || e.Contains("not a bot") || e.Contains("login required") || e.Contains("cookies"))
                return error + "  [Tip: Network tab > 'Cookies from browser' or a cookies file; also try Tools > Update yt-dlp.]";
            if (e.Contains("ffmpeg") || e.Contains("ffprobe"))
                return error + "  [Tip: Tools > Install / reinstall components to get FFmpeg.]";
            if (e.Contains("requested format is not available"))
                return error + "  [Tip: use the Formats button to see what is available, or choose 'Best quality'.]";
            if (e.Contains("unsupported url"))
                return error + "  [Tip: Tools > Update yt-dlp, or the site is not supported.]";
            return error;
        }
    }
}
