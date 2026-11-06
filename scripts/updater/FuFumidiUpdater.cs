using System;
using System.IO;
using System.Net;
using System.Diagnostics;
using System.Threading;

class Updater {
  static string Arg(string[] a, string name) {
    for (int i = 0; i < a.Length - 1; i++) if (a[i] == name) return a[i+1];
    return null;
  }
  static void Log(string s) {
    try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "FuFumidi.update.log"), DateTime.Now + " " + s + "\r\n"); } catch {}
  }
  static void Main(string[] args) {
    ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;
    string dir = Arg(args, "-D");
    if (String.IsNullOrEmpty(dir)) dir = AppDomain.CurrentDomain.BaseDirectory;
    string[] urls = {
      "https://github.com/qdTXTbp/FuFumidi/releases/latest/download/FuFumidi.Install.exe",
      "https://cnb.cool/FuFuCloud-mirror/FuFuMIDI/-/releases/latest/download/FuFumidi.Install.exe"
    };
    foreach (string url in urls) {
      string tmp = Path.Combine(Path.GetTempPath(), "FuFumidi.Install." + Guid.NewGuid().ToString("N") + ".exe");
      try {
        Log("download " + url);
        using (WebClient wc = new WebClient()) {
          wc.Headers.Add("User-Agent", "FuFumidi-Updater");
          wc.DownloadFile(url, tmp);
        }
        FileInfo fi = new FileInfo(tmp);
        if (fi.Length < 1000000) throw new Exception("too small " + fi.Length);
        using (FileStream fs = File.OpenRead(tmp)) {
          if (fs.ReadByte() != 'M' || fs.ReadByte() != 'Z') throw new Exception("not PE");
        }
        Log("downloaded " + fi.Length);
        foreach (Process p in Process.GetProcessesByName("FuFumidi")) { try { p.Kill(); } catch {} }
        Thread.Sleep(1000);
        Process p2 = Process.Start(tmp, "-I -S -D \"" + dir + "\"");
        p2.WaitForExit(600000);
        Log("installer exit " + p2.ExitCode);
        try { Process.Start(Path.Combine(dir, "FuFumidi.exe")); } catch {}
        return;
      } catch (Exception e) { Log("failed " + e.Message); try { File.Delete(tmp); } catch {} }
    }
    Log("all sources failed");
  }
}