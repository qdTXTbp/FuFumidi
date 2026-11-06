#!/usr/bin/env node
// ============================================================
// S6 无头冒烟编排器（不启动 GUI / 安装器 / msiexec 交互）
//
// 依次跑 resource_extras 里 #[ignore] 的真实网络测试，外加插件平台的
// catalog → download → 包内校验（两段式 install 命令在 main.rs，冻结不动）。
//
// 用法：
//   node scripts/tauri/s6-smoke.mjs                 # 全部用例
//   node scripts/tauri/s6-smoke.mjs --only=sf,gpu   # 只跑指定用例
//   node scripts/tauri/s6-smoke.mjs --no-plugin     # 跳过插件平台
//   node scripts/tauri/s6-smoke.mjs --json          # 只输出 JSON 摘要
//
// 输出：每个用例的耗时/字节数/校验结论；失败如实记录并以非 0 退出。
// ============================================================
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TAURI = path.join(ROOT, "shells", "tauri");
const PLATFORM = process.env.FUFUMIDI_PLATFORM_URL || "https://platform.fufumidi.de5.net";

const CASES = [
  { id: "sf", test: "s6_sf_real", label: "音色 SF2 真实下载（florestan 531,786B）", expect: "533KB" },
  { id: "utau", test: "s6_utau_real", label: "UTAU 声库真实下载+解包（chenzhe ~26MB）", expect: "~26MB" },
  { id: "gpu", test: "s6_gpu_sources_real", label: "GPU 分卷发现 + GitHub/CNB 长度 + Range 1MiB", expect: ">=1MiB" },
  { id: "omr-lang", test: "s6_omr_lang_real", label: "tessdata eng 完整版", expect: "~23MB" },
  { id: "omr-sr", test: "s6_omr_sr_real", label: "waifu2x SR 下载+解包", expect: "~35MB" },
  { id: "omr-engine", test: "s6_omr_engine_real", label: "Audiveris MSI 下载+SHA-256", expect: "85,062,430B" },
  { id: "homr-weight", test: "s6_homr_weight_real", label: "homr 权重（最小者）下载+解包", expect: "<=60MB" },
];

function parseArgs(argv) {
  const out = { only: null, plugin: true, json: false, timeoutMin: 25 };
  for (const a of argv.slice(2)) {
    if (a === "--json") out.json = true;
    else if (a === "--no-plugin") out.plugin = false;
    else if (a.startsWith("--only=")) out.only = a.slice(7).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--timeout-min=")) out.timeoutMin = Math.max(1, Number(a.slice(14)) || 25);
  }
  return out;
}

function log(...args) { console.log(...args); }

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: opts.timeoutMs || 30 * 60 * 1000,
    env: { ...process.env, ...(opts.env || {}) },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "", error: r.error ? String(r.error.message || r.error) : "" };
}

/** 跑一个 #[ignore] 测试，从输出里抓 ###S6 {json} 行。 */
function runCase(c, timeoutMin) {
  const started = Date.now();
  const args = ["test", "--offline", "--", "--ignored", "--test-threads=1", "--nocapture", c.test];
  const r = run("cargo", args, { cwd: TAURI, timeoutMs: timeoutMin * 60 * 1000 });
  const lines = (r.stdout + "\n" + r.stderr).split(/\r?\n/);
  const markers = [];
  for (const ln of lines) {
    const i = ln.indexOf("###S6 ");
    if (i < 0) continue;
    try { markers.push(JSON.parse(ln.slice(i + 6))); } catch (e) { /* 半截行忽略 */ }
  }
  const passed = r.code === 0 && markers.length > 0 && markers.every((m) => m.ok !== false);
  return {
    id: c.id, test: c.test, label: c.label, passed,
    elapsedMs: Date.now() - started,
    exitCode: r.code, markers,
    error: passed ? "" : (r.error || tail(lines.filter(Boolean), 6)),
  };
}

function tail(arr, n) { return arr.slice(-n).join(" | ").slice(0, 700); }

function curlJson(url, headers = []) {
  const args = ["--ssl-no-revoke", "-sS", "-L", "-m", "25", "-H", "User-Agent: FuFumidi"];
  for (const h of headers) args.push("-H", h);
  args.push(url);
  const r = run("curl.exe", args);
  if (r.code !== 0) throw new Error("curl failed: " + (r.stderr || r.error));
  return JSON.parse(r.stdout);
}

function pluginStep() {
  const started = Date.now();
  const out = { id: "plugin", test: "platform:catalog+download+inspect", label: "插件平台 catalog + 下载 + 包内校验", passed: false };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s6-plugin-"));
  try {
    const cat = curlJson(PLATFORM.replace(/\/+$/, "") + "/api/store/manifest/stable", ["accept: application/json"]);
    const plugins = Array.isArray(cat.plugins) ? cat.plugins : [];
    out.catalog = { channel: cat.channel, count: plugins.length, generatedAt: cat.generatedAt || "" };
    if (!plugins.length) {
      out.markers = [{ ok: true, note: "平台当前没有插件，跳过下载" }];
      out.passed = true;
      return out;
    }
    const p = plugins[0];
    const slug = p.slug;
    const version = p.version || "";
    const zipPath = path.join(tmp, slug + ".zip");
    const url = PLATFORM.replace(/\/+$/, "") + "/api/store/plugins/" + encodeURIComponent(slug) + "/download?source=app" + (version ? "&version=" + encodeURIComponent(version) : "");
    // 平台下载链路走 curl 会偶发 SSL/超时（实测）；PowerShell Invoke-WebRequest 走系统代理更稳，
    // 两条通道都试，先 WinINET 再 curl（与 main/omr.js 的 downloadPs 同一经验）。
    let via = "powershell";
    const psCmd =
      "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri " + JSON.stringify(url) +
      " -OutFile " + JSON.stringify(zipPath) +
      " -UseBasicParsing -TimeoutSec 240 -Headers @{'User-Agent'='FuFumidi';'Accept'='application/zip'}";
    let dl = run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCmd], { timeoutMs: 300000 });
    if (dl.code !== 0 || !fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) {
      via = "curl";
      dl = run("curl.exe", ["--ssl-no-revoke", "-sS", "-L", "--fail", "-m", "180", "-H", "User-Agent: FuFumidi", "-H", "Accept: application/zip", "-o", zipPath, url], { timeoutMs: 200000 });
    }
    if (dl.code !== 0 || !fs.existsSync(zipPath)) throw new Error("下载插件失败（powershell+curl 均失败）：" + (dl.stderr || dl.error));
    const bytes = fs.statSync(zipPath).size;
    const magic = fs.readFileSync(zipPath).subarray(0, 2).toString("latin1");
    // 用 bsdtar 列 zip 条目（Windows 10+ 自带），检查包内路径安全
    const list = run("tar", ["-tf", zipPath], { timeoutMs: 60000 });
    const entries = list.code === 0 ? list.stdout.split(/\r?\n/).filter(Boolean) : [];
    const unsafe = entries.filter((e) => e.startsWith("/") || e.includes("../") || /^[A-Za-z]:/.test(e));
    const manifestEntry = entries.find((e) => /(^|\/)plugin\.json$/.test(e)) || "";
    let manifest = null;
    if (manifestEntry) {
      const ex = run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
        "Expand-Archive -LiteralPath " + JSON.stringify(zipPath) + " -DestinationPath " + JSON.stringify(path.join(tmp, "x")) + " -Force"], { timeoutMs: 120000 });
      const mp = path.join(tmp, "x", manifestEntry);
      if (ex.code === 0 && fs.existsSync(mp)) manifest = JSON.parse(fs.readFileSync(mp, "utf8"));
    }
    out.markers = [{
      ok: magic === "PK" && entries.length > 0 && unsafe.length === 0,
      slug, version, bytes, catalogSize: p.size, magic, via,
      entries: entries.length, fileCount: p.fileCount,
      manifest: manifest ? { id: manifest.id, version: manifest.version, entry: manifest.entry, commands: (manifest.commands || []).length } : null,
      unsafeEntries: unsafe.length,
      note: "两段式 install 命令在 main.rs（冻结）：本次只做 platform 下载与等价 inspect，未安装/未启用",
    }];
    out.passed = out.markers[0].ok === true;
    return out;
  } catch (e) {
    out.error = String((e && e.message) || e);
    return out;
  } finally {
    out.elapsedMs = Date.now() - started;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
}

function fmtMs(ms) { return (ms / 1000).toFixed(1) + "s"; }
function fmtBytes(n) {
  if (typeof n !== "number") return "-";
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + " GB";
  if (n >= 1048576) return (n / 1048576).toFixed(2) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}
function summarize(c) {
  const m = (c.markers || []).reduce((acc, x) => ({ ...acc, ...x }), {});
  const bytes = m.bytes || m.weightBytes || m.rangeBytes || 0;
  const extra = [];
  if (m.riff !== undefined) extra.push("RIFF=" + m.riff);
  if (m.files !== undefined) extra.push("files=" + m.files);
  if (m.parts !== undefined) extra.push("parts=" + m.parts);
  if (m.installedModels !== undefined) extra.push("models=" + m.installedModels + "/" + m.totalModels);
  if (m.sha256) extra.push("sha256=" + String(m.sha256).slice(0, 12) + "…");
  if (m.github !== undefined) extra.push("github=" + fmtBytes(m.github) + " cnb=" + fmtBytes(m.cnb));
  if (m.entries !== undefined) extra.push("entries=" + m.entries);
  return { bytes, extra: extra.join(" ") };
}

function main() {
  const args = parseArgs(process.argv);
  const selected = args.only ? CASES.filter((c) => args.only.includes(c.id)) : CASES;
  if (!selected.length) { console.error("没有匹配的用例；可选：" + CASES.map((c) => c.id).join(",")); process.exit(2); }
  const results = [];
  if (!args.json) log("[S6] 开始：cargo test --offline -- --ignored（逐个可控）");
  for (const c of selected) {
    if (!args.json) process.stdout.write("[S6] " + c.id.padEnd(12) + " " + c.test + " … ");
    const r = runCase(c, args.timeoutMin);
    results.push(r);
    if (!args.json) {
      const s = summarize(r);
      log((r.passed ? "PASS" : "FAIL") + "  " + fmtMs(r.elapsedMs) + "  " + fmtBytes(s.bytes) + "  " + s.extra);
      if (!r.passed) log("      " + (r.error || ""));
    }
  }
  if (args.plugin) {
    if (!args.json) process.stdout.write("[S6] " + "plugin".padEnd(12) + " platform catalog/download/inspect … ");
    const r = pluginStep();
    results.push(r);
    if (!args.json) {
      const m = (r.markers || [])[0] || {};
      log((r.passed ? "PASS" : "FAIL") + "  " + fmtMs(r.elapsedMs || 0) + "  " + fmtBytes(m.bytes) + "  " + (m.note || m.entry || ""));
      if (!r.passed) log("      " + (r.error || ""));
    }
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    platform: PLATFORM,
    ok: results.every((r) => r.passed),
    cases: results.map((r) => {
      const s = summarize(r);
      return { id: r.id, test: r.test, passed: r.passed, elapsedMs: r.elapsedMs, exitCode: r.exitCode, bytes: s.bytes, extra: s.extra, markers: r.markers, error: r.error };
    }),
  };
  if (args.json) log(JSON.stringify(summary, null, 2));
  else {
    log("");
    log("[S6] 结果：" + (summary.ok ? "全部通过" : "有失败项"));
    log("```json");
    log(JSON.stringify(summary, null, 2));
    log("```");
  }
  process.exit(summary.ok ? 0 : 1);
}

main();
