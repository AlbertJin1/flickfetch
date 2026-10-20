// Copyright © 2026 Jessie Albert Regualos. Application source and integration code.
using System;
using System.Globalization;

namespace FlickFetch
{
    /// <summary>
    /// Interprets yt-dlp output. We ask yt-dlp for machine-readable lines via
    /// --progress-template / --print, all prefixed with "@@":
    ///   @@P|downloaded|total|estimate|speed|eta|fragIndex|fragCount   (download progress)
    ///   @@PP|status|postprocessor                                      (post-processing)
    ///   @@T|playlistIndex|playlistCount|title                          (a new video starts)
    ///   @@F|finalFilePath                                              (file finished/moved)
    /// Everything else is logged as-is.
    /// </summary>
    public static class OutputParser
    {
        private static double D(string s)
        {
            double v;
            if (double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) return v;
            return -1;
        }

        public static void Handle(DownloadItem it, string line, bool isStderr)
        {
            if (line == null) return;

            if (line.StartsWith("@@P|", StringComparison.Ordinal))
            {
                string[] p = line.Split('|');
                if (p.Length < 8) return;
                double downloaded = D(p[1]);
                double total = D(p[2]);
                if (total <= 0) total = D(p[3]);
                double frag = D(p[6]), fragCount = D(p[7]);

                if (total > 0 && downloaded >= 0) it.FileProgress = Math.Min(100.0, downloaded * 100.0 / total);
                else if (fragCount > 0 && frag >= 0) it.FileProgress = Math.Min(100.0, frag * 100.0 / fragCount);
                else it.FileProgress = -1;

                if (total > 0) it.TotalBytes = (long)total;
                it.Speed = D(p[4]);
                it.Eta = D(p[5]);
                if (it.Status != ItemStatus.Processing || it.FileProgress >= 0) it.Status = ItemStatus.Downloading;
                return;
            }

            if (line.StartsWith("@@PP|", StringComparison.Ordinal))
            {
                string[] p = line.Split('|');
                if (p.Length >= 3 && p[1] == "started")
                {
                    it.Stage = p[2];
                    it.Status = ItemStatus.Processing;
                    it.Speed = -1; it.Eta = -1;
                }
                return;
            }

            if (line.StartsWith("@@T|", StringComparison.Ordinal))
            {
                string[] p = line.Split(new[] { '|' }, 4);
                if (p.Length == 4)
                {
                    int idx, cnt;
                    it.PlaylistIndex = int.TryParse(p[1], out idx) ? idx : 0;
                    it.PlaylistCount = int.TryParse(p[2], out cnt) ? cnt : 0;
                    it.Title = p[3];
                    it.FileProgress = 0;
                    it.Status = ItemStatus.Downloading;
                    it.AddLog("Downloading: " + p[3]);
                }
                return;
            }

            if (line.StartsWith("@@F|", StringComparison.Ordinal))
            {
                it.FilePath = line.Substring(4);
                it.AddLog("Saved: " + it.FilePath);
                return;
            }

            it.AddLog(line);
            if (isStderr && line.StartsWith("ERROR:", StringComparison.Ordinal))
                it.ErrorText = line.Substring(6).Trim();
        }
    }
}
