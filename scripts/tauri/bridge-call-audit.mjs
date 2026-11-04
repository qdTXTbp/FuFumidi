#!/usr/bin/env node
// 桥调用审计：前端实际用到的 bridge.* 方法 vs Tauri 桥已有方法（静态解析，不启动窗口）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|ts|vue|mjs)$/.test(e.name)) out.push(p);
  }
}
const files = [];
walk(path.join(ROOT, "frontend/src"), files);
const calls = new Map();
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  for (const m of text.matchAll(/\bbridge\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g)) {
    const a = m[1], b = m[2] || "";
    const key = b ? a + "." + b : a;
    if (!calls.has(key)) calls.set(key, new Set());
    calls.get(key).add(path.relative(ROOT, f).replace(/\\/g, "/"));
  }
}
const tau = fs.readFileSync(path.join(ROOT, "frontend/src/bridge/tauri.js"), "utf8");
const top = new Set();
const nested = new Set();
let parent = "";
for (const line of tau.split(/\r?\n/)) {
  const lead = (line.match(/^ */) || [""])[0].length;
  const t = line.trim();
  if (!t || t.startsWith("//")) continue;
  if (lead <= 4 && (t === "}," || t === "}" || t === "};")) { parent = ""; continue; }
  const obj = t.match(/^([A-Za-z_$][\w$]*):\s*\{/);
  if (obj) { parent = lead === 4 ? obj[1] : ""; continue; }
  const m = t.match(/^([A-Za-z_$][\w$]*):\s*(?:\(|function|async)/);
  if (!m) continue;
  if (lead >= 6 && parent) nested.add(parent + "." + m[1]);
  else if (lead === 4) top.add(m[1]);
}
const missing = [...calls.keys()].filter((k) => !top.has(k) && !nested.has(k)).sort();
const lines = [];
lines.push("# 前端 bridge.* 调用 vs Tauri 桥（静态审计）", "");
lines.push("> 由 `node scripts/tauri/bridge-call-audit.mjs --write` 生成；只解析源码，不启动窗口。");
lines.push("> 这是**启发式**审计：动态拼接、可选守卫和事件回调可能造成少量误报。", "");
lines.push("| 指标 | 数值 |"); lines.push("|---|---:|");
lines.push("| 前端调用的 bridge 方法（去重） | " + calls.size + " |");
lines.push("| Tauri 顶层方法 | " + top.size + " |");
lines.push("| Tauri 嵌套方法 | " + nested.size + " |");
lines.push("| **未找到实现** | **" + missing.length + "** |"); lines.push("");
lines.push("## 未找到实现的方法", "");
if (!missing.length) lines.push("（无）");
for (const k of missing) lines.push("- `" + k + "` — " + [...calls.get(k)].slice(0, 4).join(", ") + (calls.get(k).size > 4 ? " …" : ""));
lines.push("", "## 说明", "", "顶层别名（如 copyAsset/openExternal）是对 Electron preload 调用习惯的兼容层；嵌套调用（bridge.storage.report）按 parent.child 匹配。", "");
const outPath = path.join(ROOT, "docs/rust/BRIDGE-CALLS.md");
if (process.argv.includes("--write")) { fs.writeFileSync(outPath, lines.join("\n"), "utf8"); console.log("[bridge-calls] wrote docs/rust/BRIDGE-CALLS.md"); }
else { console.log(lines.join("\n")); }
