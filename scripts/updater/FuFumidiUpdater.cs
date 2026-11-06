using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

class Updater {
  const string Api = "https://api.github.com/repos/qdTXTbp/FuFumidi/releases?per_page=30";
  const string CnbBase = "https://cnb.cool/FuFuCloud-mirror/FuFuMIDI/-/releases/download/";
  const string FallbackTag = "v6.5.0-alpha.3";
  const string FallbackName = "FuFumidi_6.5.0-alpha.3_x64-setup.exe";
  const long FallbackSize = 251905251;
  static bool dryRun = false;

  class Rel { public string Tag; public string Name; public long Size; public string Url; }

  static void Log(string s) {
    try {
      Console.WriteLine(s);
    } catch {}
    try {
      File.AppendAllText(Path.Combine(Path.GetTempPath(), "FuFumidi.update.log"),
        DateTime.Now.ToString("s") + " " + s + "\r\n", Encoding.UTF8);
    } catch {}
  }

  static string Arg(string[] a, string n) {
    for (int i = 0; i < a.Length - 1; i++) if (a[i] == n) return a[i + 1];
    return null;
  }
  static bool Has(string[] a, string n) {
    foreach (string s in a) if (s == n) return true;
    return false;
  }

  static string VersionOf(string dir) {
    try { return FileVersionInfo.GetVersionInfo(Path.Combine(dir, "FuFumidi.exe")).FileVersion.Trim(); }
    catch { return ""; }
  }

  static string HttpGet(string url) {
    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
    req.UserAgent = "FuFumidi-Updater";
    req.Accept = "application/vnd.github+json";
    req.Timeout = 20000;
    req.ReadWriteTimeout = 20000;
    req.AllowAutoRedirect = true;
    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
    using (StreamReader r = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
      return r.ReadToEnd();
  }

  static int Rank(string ch) {
    if (ch == null) return 4;
    ch = ch.ToLowerInvariant();
    if (ch == "rc") return 3;
    if (ch == "beta") return 2;
    if (ch == "alpha") return 1;
    return 0;
  }

  // >0 if a newer than b
  static int CompareVer(string a, string b) {
    Regex re = new Regex(@"^v?(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z]+)\.?(\d+))?");
    Match ma = re.Match(a ?? ""); Match mb = re.Match(b ?? "");
    if (!ma.Success || !mb.Success) return 0;
    for (int i = 1; i <= 3; i++) {
      int x = int.Parse(ma.Groups[i].Value), y = int.Parse(mb.Groups[i].Value);
      if (x != y) return x > y ? 1 : -1;
    }
    string ca = ma.Groups[4].Success ? ma.Groups[4].Value : null;
    string cb = mb.Groups[4].Success ? mb.Groups[4].Value : null;
    int ra = Rank(ca), rb = Rank(cb);
    if (ra != rb) return ra > rb ? 1 : -1;
    int na = ma.Groups[5].Success ? int.Parse(ma.Groups[5].Value) : 0;
    int nb = mb.Groups[5].Success ? int.Parse(mb.Groups[5].Value) : 0;
    if (na != nb) return na > nb ? 1 : -1;
    return 0;
  }

  static List<Rel> ParseReleases(string json) {
    List<Rel> list = new List<Rel>();
    int idx = 0;
    while (true) {
      int t = json.IndexOf("\"tag_name\"", idx);
      if (t < 0) break;
      int next = json.IndexOf("\"tag_name\"", t + 1);
      string chunk = json.Substring(t, (next < 0 ? json.Length : next) - t);
      idx = next < 0 ? json.Length : next;
      if (chunk.Contains("\"draft\":true")) continue;
      Match tm = Regex.Match(chunk, "\"tag_name\"\\s*:\\s*\"([^\"]+)\"");
      if (!tm.Success) continue;
      string tag = tm.Groups[1].Value;
      // 只接受 Tauri 安装包（*_x64-setup.exe），避免把旧 Electron alpha/beta 当成更新。
      Match am = Regex.Match(chunk,
        "\"name\"\\s*:\\s*\"([^\"]*_x64-setup\\.exe)\"[\\s\\S]*?\"size\"\\s*:\\s*(\\d+)[\\s\\S]*?\"browser_download_url\"\\s*:\\s*\"([^\"]+)\"");
      if (!am.Success) continue;
      long size = 0; long.TryParse(am.Groups[2].Value, out size);
      list.Add(new Rel { Tag = tag, Name = am.Groups[1].Value, Size = size, Url = am.Groups[3].Value });
    }
    return list;
  }

  static Rel LatestFromApi() {
    try {
      List<Rel> list = ParseReleases(HttpGet(Api));
      Rel best = null;
      foreach (Rel r in list) {
        if (best == null || CompareVer(r.Tag, best.Tag) > 0) best = r;
      }
      if (best != null) { Log("api latest=" + best.Tag + " asset=" + best.Name + " size=" + best.Size); return best; }
      Log("api returned no Tauri release asset");
    } catch (Exception e) {
      Log("api failed: " + e.Message);
    }
    return null;
  }

  static string CnbUrl(string tag) { return CnbBase + tag + "/FuFumidi.Install.exe"; }

  static bool Download(string url, string dest) {
    try {
      Log("download " + url);
      HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
      req.UserAgent = "FuFumidi-Updater";
      req.Timeout = 30000;
      req.ReadWriteTimeout = 180000;
      req.AllowAutoRedirect = true;
      using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
      using (Stream s = resp.GetResponseStream())
      using (FileStream f = File.Create(dest)) {
        byte[] buf = new byte[1 << 20];
        long total = 0; int n;
        while ((n = s.Read(buf, 0, buf.Length)) > 0) { f.Write(buf, 0, n); total += n; }
        Log("downloaded bytes=" + total);
      }
      return true;
    } catch (Exception e) { Log("download failed: " + e.Message); return false; }
  }

  static bool LooksLikePe(string path) {
    try {
      FileInfo fi = new FileInfo(path);
      if (fi.Length < 1000000) return false;
      using (FileStream fs = File.OpenRead(path)) {
        return fs.ReadByte() == 'M' && fs.ReadByte() == 'Z';
      }
    } catch { return false; }
  }

  static string FindLocalInstaller(string dir, Rel rel) {
    string p = Path.Combine(dir, "FuFumidi.Install.exe");
    try {
      if (!File.Exists(p)) return null;
      string v = FileVersionInfo.GetVersionInfo(p).FileVersion.Trim();
      long len = new FileInfo(p).Length;
      if (CompareVer(v, rel.Tag) == 0 && (rel.Size <= 0 || len == rel.Size)) {
        Log("reuse local installer version=" + v + " size=" + len);
        return p;
      }
      Log("local installer not usable version=" + v + " size=" + len);
    } catch {}
    return null;
  }

  static void StartApp(string dir) {
    try { Process.Start(Path.Combine(dir, "FuFumidi.exe")); }
    catch (Exception e) { Log("start failed: " + e.Message); }
  }

  static int Main(string[] args) {
    try {
      ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;
      dryRun = Has(args, "--dry-run");
      string dir = Arg(args, "-D");
      if (String.IsNullOrEmpty(dir)) dir = AppDomain.CurrentDomain.BaseDirectory;
      bool noStart = Has(args, "--no-start") || Has(args, "-O");
      string cur = VersionOf(dir);
      Log("current=" + cur + " dir=" + dir + " dry=" + dryRun);

      Rel rel = LatestFromApi();
      if (rel == null) {
        // 网络不可用/接口被墙：仍保留一个已知版本兜底，保证当前这台机器能更新。
        rel = new Rel { Tag = FallbackTag, Name = FallbackName, Size = FallbackSize, Url = CnbUrl(FallbackTag) };
        Log("fallback latest=" + rel.Tag);
      }
      if (CompareVer(rel.Tag, cur) <= 0) {
        Log("already up to date");
        if (!dryRun && !noStart) StartApp(dir);
        return 0;
      }
      Log("update available " + cur + " -> " + rel.Tag);

      string local = FindLocalInstaller(dir, rel);
      if (dryRun) {
        Log("dry-run would install " + (local != null ? local : rel.Url) + " with /S /D=" + dir);
        return 0;
      }
      string installer = null;
      if (local != null) {
        installer = local;
      } else {
        string tmp = Path.Combine(Path.GetTempPath(), "FuFumidi.Install." + Guid.NewGuid().ToString("N") + ".exe");
        // 国内优先 CNB 镜像，失败再回退 GitHub 资产地址。
        bool ok = Download(CnbUrl(rel.Tag), tmp);
        if (!ok) ok = Download(rel.Url, tmp);
        if (!ok || !LooksLikePe(tmp)) {
          try { File.Delete(tmp); } catch {}
          Log("no usable installer downloaded");
          if (!dryRun && !noStart) StartApp(dir);
          return 3;
        }
        installer = tmp;
      }

      foreach (Process p in Process.GetProcessesByName("FuFumidi")) {
        try { p.Kill(); } catch {}
      }
      Thread.Sleep(1000);
      Log("run installer: " + installer);
      // Tauri NSIS：/S 静默，/D= 必须是最后一个参数（不加引号）。
      Process ip = Process.Start(installer, "/S /D=" + dir);
      if (!ip.WaitForExit(900000)) Log("installer timeout");
      else Log("installer exit=" + ip.ExitCode);
      try { if (installer != local) File.Delete(installer); } catch {}
      string after = VersionOf(dir);
      Log("after=" + after);
      if (!noStart) StartApp(dir);
      return CompareVer(after, rel.Tag) == 0 ? 0 : 4;
    } catch (Exception e) {
      Log("fatal " + e.Message);
      return 1;
    }
  }
}
