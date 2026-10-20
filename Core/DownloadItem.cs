// Copyright © 2026 Jessie Albert Regualos. Application source and integration code.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;

namespace FlickFetch
{
    public enum ItemStatus { Queued, Starting, Downloading, Processing, Done, Failed, Canceled }

    /// <summary>One queue entry (a single URL, which may expand to a whole playlist).</summary>
    public class DownloadItem
    {
        private static int _next;

        public int Id = Interlocked.Increment(ref _next);
        public string Url;
        public string[] Args;              // snapshot of options taken when the link was added
        public string OutputDir;

        public volatile ItemStatus Status = ItemStatus.Queued;
        public string Title;
        public double FileProgress = -1;   // 0..100 of the current file, -1 = unknown
        public int PlaylistIndex;
        public int PlaylistCount;
        public double Speed = -1;          // bytes / second
        public double Eta = -1;            // seconds
        public long TotalBytes;
        public long FinalSize;
        public string Stage = "";
        public string FilePath;
        public string ErrorText;
        public volatile bool CancelRequested;
        public Process Proc;

        private readonly List<string> _log = new List<string>();
        public int LogVersion;

        public bool IsActive
        {
            get { return Status == ItemStatus.Starting || Status == ItemStatus.Downloading || Status == ItemStatus.Processing; }
        }

        public bool IsFinished
        {
            get { return Status == ItemStatus.Done || Status == ItemStatus.Failed || Status == ItemStatus.Canceled; }
        }

        public double OverallProgress
        {
            get
            {
                if (Status == ItemStatus.Done) return 100;
                double f = FileProgress;
                if (f < 0) return -1;
                if (PlaylistCount > 1 && PlaylistIndex > 0)
                    return Math.Min(100.0, ((PlaylistIndex - 1) * 100.0 + f) / PlaylistCount);
                return f;
            }
        }

        public void AddLog(string line)
        {
            lock (_log)
            {
                _log.Add(line);
                if (_log.Count > 3000) _log.RemoveRange(0, 500);
                LogVersion++;
            }
        }

        public string GetLogText()
        {
            lock (_log) { return string.Join(Environment.NewLine, _log); }
        }

        public void ResetForRetry()
        {
            Status = ItemStatus.Queued;
            FileProgress = -1; Speed = -1; Eta = -1; TotalBytes = 0; FinalSize = 0;
            Stage = ""; ErrorText = null; CancelRequested = false; PlaylistIndex = 0; PlaylistCount = 0;
            AddLog("---- retry ----");
        }
    }
}
