#!/usr/bin/env node
// 静态 IPC 覆盖统计：preload 暴露的方法 vs Tauri 桥已映射的方法（不启动任何窗口）。
// 用法：node scripts/tauri/ipc-coverage.mjs [--json] [--write]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pre = fs.readFileSync(path.join(ROOT, "preload.js"), "utf8");
const tau = fs.readFileSync(path.join(ROOT, "frontend/src/bridge/tauri.js"), "utf8");

function methods(src) {
  const set = new Set();
  for (const m of src.matchAll(/^\s{2,6}([a-zA-Z_$][\w$]*)\s*:\s*(?:\(|function|async)/gm)) set.add(m[1]);
  return set;
}
function channels(src, kind) {
  const set = new Set();
  const re = kind === "invoke" ? /invoke\(\s*['"]([^'"]+)['"]/g : /call\(\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) set.add(m[1]);
  return set;
}
function category(name) {
  if (/^diffsinger/i.test(name)) return "diffsinger";
  if (/^rvc/i.test(name)) return "rvc";
  if (/^utau|voicebank/i.test(name)) return "utau/voicebank";
  if (/^gpu|homr|sr/i.test(name)) return "gpu/运行时增强";
  if (/^update|speedtest|updateSpeedtest/i.test(name)) return "更新/测速";
  if (/^score|export|video|renderFile|render/i.test(name)) return "导出/渲染";
  if (/^db|library|midi|dupe|verify|scan|reveal|clean/i.test(name)) return "曲库/数据";
  if (/^model|install|catalog|download|platform|inventory/i.test(name)) return "模型/安装/平台";
  if (/^wallpaper|plugin|separate|cover|stem|audioDuration|audio|exportAudio/i.test(name)) return "资源/音频/扩展";
  if (/^pick|pathForFile|open|folder|writeBinary|writeMidi|copyAsset|diag|dataRoot/i.test(name)) return "文件/诊断";
  if (/^on[A-Z]|takePending|rendererReady|fullScreen|zoom/i.test(name)) return "事件/窗口";
  if (/^(appUninstall|autosave|autostart|hotkeys|lang|clean|cleanup|probe|detect|status|set|view|open|report|submit|pin|preview|save|search|sources|demo|generate|sing|get|has|read|status)/.test(name)) return "设置/杂项";
  return "其他";
}
const pm = methods(pre), tm = methods(tau);
const missing = [...pm].filter((x) => !tm.has(x)).sort();
const cats = new Map();
for (const m of missing) { const c = category(m); cats.set(c, (cats.get(c) || 0) + 1); }
const summary = {
  preloadMethods: pm.size,
  tauriMethods: tm.size,
  missingCount: missing.length,
  preloadInvokeChannels: channels(pre, "invoke").size,
  tauriCallChannels: channels(tau, "call").size,
  categories: Object.fromEntries([...cats].sort((a, b) => b[1] - a[1])),
  missing,
};
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log("[ipc-coverage] preload methods " + pm.size + " / tauri methods " + tm.size + " / missing " + missing.length);
  console.log("[ipc-coverage] preload invoke channels " + summary.preloadInvokeChannels + " / tauri call channels " + summary.tauriCallChannels);
  for (const [c, n] of [...cats].sort((a, b) => b[1] - a[1])) console.log("  - " + c + ": " + n);
}
if (process.argv.includes("--write")) {
  const md = [
    "# Tauri IPC 覆盖（静态统计）",
    "",
    "> 由 `node scripts/tauri/ipc-coverage.mjs --write` 生成；只统计桥方法名，不启动窗口。",
    "",
    "| 指标 | 数值 |",
    "|---|---:|",
    "| preload 暴露方法 | " + pm.size + " |",
    "| Tauri 桥已映射方法 | " + tm.size + " |",
    "| 尚未映射 | **" + missing.length + "** |",
    "| preload IPC invoke 通道 | " + summary.preloadInvokeChannels + " |",
    "| Tauri call 通道 | " + summary.tauriCallChannels + " |",
    "",
    "## 缺口分类",
    "",
    "| 分类 | 数量 |",
    "|---|---:|",
    ...[...cats].sort((a, b) => b[1] - a[1]).map(([c, n]) => "| " + c + " | " + n + " |"),
    "",
    "## 尚未映射的方法",
    "",
    "```text",
    missing.join("\n"),
    "```",
    "",
    "说明：统计是**方法名**级别，可能有少数同名嵌套/别名误差；以桥适配层实际调用为准。",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(ROOT, "docs/rust/IPC-COVERAGE.md"), md, "utf8");
  console.log("[ipc-coverage] wrote docs/rust/IPC-COVERAGE.md");
}
