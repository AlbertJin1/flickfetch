// Copyright © 2026 Jessie Albert Regualos. Application source and integration code.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace FlickFetch
{
    public class CaptureResult
    {
        public int ExitCode;
        public string Stdout = "";
        public string Stderr = "";
    }

    public static class ProcessRunner
    {
        /// <summary>Quotes one argument following the Windows command-line rules.</summary>
        public static string Quote(string a)
        {
            if (a == null) a = "";
            if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return a;
            var sb = new StringBuilder();
            sb.Append('"');
            int bs = 0;
            foreach (char c in a)
            {
                if (c == '\\') { bs++; }
                else if (c == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); bs = 0; }
                else { sb.Append('\\', bs); bs = 0; sb.Append(c); }
            }
            sb.Append('\\', bs * 2);
            sb.Append('"');
            return sb.ToString();
        }

        public static string JoinArgs(IEnumerable<string> args)
        {
            var parts = new List<string>();
            foreach (string a in args) parts.Add(Quote(a));
            return string.Join(" ", parts.ToArray());
        }

        private static ProcessStartInfo MakeStartInfo(string exe, IEnumerable<string> args, string extraPath)
        {
            var psi = new ProcessStartInfo
            {
                FileName = exe,
                Arguments = JoinArgs(args),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false),
                StandardErrorEncoding = new UTF8Encoding(false),
            };
            if (!string.IsNullOrEmpty(extraPath))
            {
                string cur = Environment.GetEnvironmentVariable("PATH") ?? "";
                psi.EnvironmentVariables["PATH"] = extraPath + Path.PathSeparator + cur;
            }
            psi.EnvironmentVariables["PYTHONUTF8"] = "1";
            psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
            return psi;
        }

        /// <summary>Runs a process, streaming each output line to the callbacks. Returns the exit code.</summary>
        public static Task<int> RunAsync(string exe, IEnumerable<string> args, string extraPath,
            Action<string> onOut, Action<string> onErr, Action<Process> onStarted)
        {
            ProcessStartInfo psi = MakeStartInfo(exe, args, extraPath);
            return Task.Run(() =>
            {
                using (var p = new Process { StartInfo = psi })
                {
                    p.OutputDataReceived += (s, e) => { if (e.Data != null && onOut != null) onOut(e.Data); };
                    p.ErrorDataReceived += (s, e) => { if (e.Data != null && onErr != null) onErr(e.Data); };
                    p.Start();
                    if (onStarted != null) onStarted(p);
                    p.BeginOutputReadLine();
                    p.BeginErrorReadLine();
                    p.WaitForExit();
                    return p.ExitCode;
                }
            });
        }

        /// <summary>Runs a short-lived process and captures everything it prints.</summary>
        public static Task<CaptureResult> CaptureAsync(string exe, IEnumerable<string> args, string extraPath, int timeoutMs)
        {
            return CaptureAsync(exe, args, extraPath, timeoutMs, CancellationToken.None);
        }

        /// <summary>Runs a short-lived process and can terminate it when cancellation is requested.</summary>
        public static Task<CaptureResult> CaptureAsync(string exe, IEnumerable<string> args, string extraPath, int timeoutMs, CancellationToken cancellationToken)
        {
            ProcessStartInfo psi = MakeStartInfo(exe, args, extraPath);
            return Task.Run(() =>
            {
                cancellationToken.ThrowIfCancellationRequested();
                var res = new CaptureResult();
                var so = new StringBuilder();
                var se = new StringBuilder();
                using (var p = new Process { StartInfo = psi })
                {
                    p.OutputDataReceived += (s, e) => { if (e.Data != null) lock (so) so.AppendLine(e.Data); };
                    p.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (se) se.AppendLine(e.Data); };
                    p.Start();
                    using (cancellationToken.Register(() => KillTree(p)))
                    {
                        p.BeginOutputReadLine();
                        p.BeginErrorReadLine();
                        if (timeoutMs > 0)
                        {
                            if (!p.WaitForExit(timeoutMs))
                            {
                                KillTree(p);
                                res.ExitCode = -1;
                                lock (se) se.AppendLine("Timed out.");
                            }
                            else { p.WaitForExit(); res.ExitCode = p.ExitCode; }
                        }
                        else { p.WaitForExit(); res.ExitCode = p.ExitCode; }
                        cancellationToken.ThrowIfCancellationRequested();
                    }
                }
                lock (so) res.Stdout = so.ToString();
                lock (se) res.Stderr = se.ToString();
                return res;
            }, cancellationToken);
        }

        /// <summary>Kills a process and all of its children (yt-dlp.exe spawns a child).</summary>
        public static void KillTree(Process p)
        {
            try
            {
                if (p == null || p.HasExited) return;
#if NET5_0_OR_GREATER
                p.Kill(true);
#else
                var k = Process.Start(new ProcessStartInfo("taskkill", "/PID " + p.Id + " /T /F")
                    { CreateNoWindow = true, UseShellExecute = false });
                if (k != null) k.WaitForExit(3000);
#endif
            }
            catch { }
        }
    }
}
