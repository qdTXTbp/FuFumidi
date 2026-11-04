#!/usr/bin/env node
// 参数契约审计：Tauri bridge call(cmd, args) 与 Rust #[tauri::command] 参数名对照。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rs = fs.readFileSync(path.join(ROOT, "shells/tauri/src/main.rs"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "frontend/src/bridge/tauri.js"), "utf8");
const commands = new Map();
for (const m of rs.matchAll(/#\[tauri::command\]\s*(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)/g)) {
  const params = [];
  for (const p of m[2].split(",")) {
    const pm = p.match(/^\s*(?:mut\s+)?([A-Za-z_$][\w$]*)\s*:/);
    if (!pm) continue;
    const ty = p.slice(pm[0].length).trim();
    if (/AppHandle|State<|WebviewWindow|Window\b/.test(ty)) continue;
    params.push(pm[1]);
  }
  commands.set(m[1], params);
}
function callArgs(src) {
  const out = new Map();
  const re = /call\(\s*['"]([\w]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== ',') { out.set(m[1], new Set()); continue; }
    i++;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '{') { out.set(m[1], new Set()); continue; }
    const start = i;
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    const body = src.slice(start + 1, i - 1);
    // 去掉嵌套对象/数组，只留顶层键（启发式）
    let flat = body.replace(/\{[^{}]*\}/g, '');
    flat = flat.replace(/\[[^\[\]]*\]/g, '');
    const args = new Set();
    for (const km of flat.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) args.add(km[1]);
    for (const part of flat.split(',')) {
      const t = part.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) args.add(t);
    }
    out.set(m[1], args);
  }
  return out;
}
const calls = callArgs(js);
const rows = [];
for (const [name, args] of calls) {
  if (!commands.has(name)) { rows.push({ name, missing: [], extra: [...args], unknown: true }); continue; }
  const params = commands.get(name);
  const missing = params.filter((p) => !args.has(p));
  const extra = [...args].filter((k) => !params.includes(k));
  if (missing.length || extra.length) rows.push({ name, missing, extra, unknown: false });
}
const out = [];
out.push("# Tauri 参数契约审计（静态）", "");
out.push("> 由 node scripts/tauri/arg-audit.mjs --write 生成；只解析源码，不启动窗口。");
out.push("> 启发式：多行/嵌套对象参数可能有误报。", "");
out.push("| 指标 | 数值 |", "|---|---:|");
out.push("| Rust command | " + commands.size + " |", "| bridge call | " + calls.size + " |", "| 参数不一致 | " + rows.length + " |", "");
out.push("## 不一致列表", "");
if (!rows.length) out.push("（无）");
for (const r of rows) {
  out.push("- " + r.name + (r.unknown ? "（Rust 未找到命令）" : ""));
  if (r.missing.length) out.push("  - bridge 缺参数: " + r.missing.join(", "));
  if (r.extra.length) out.push("  - bridge 多参数: " + r.extra.join(", "));
}
out.push("", "## 说明", "", "Rust 端注入参数（AppHandle/State/WebviewWindow）已排除；无参 call 不列出。", "");
if (process.argv.includes("--write")) { fs.writeFileSync(path.join(ROOT, "docs/rust/ARG-AUDIT.md"), out.join("\n"), "utf8"); console.log("[arg-audit] mismatches=" + rows.length); } else { console.log(out.join("\n")); }