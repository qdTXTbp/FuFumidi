#!/usr/bin/env node
// 从 main/soundfonts.js 的 REGISTRY 字面量生成 Tauri 侧静态注册表（不启动窗口）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = fs.readFileSync(path.join(ROOT, "main/soundfonts.js"), "utf8");
const start = src.indexOf("const REGISTRY = [");
const end = src.indexOf("\n  ];", start);
if (start < 0 || end < 0) throw new Error("REGISTRY literal not found");
const block = src.slice(start, end + 5);
const pre = "const _releaseBase='https://example.invalid'; const CNB_SF_FILES=new Set();";
const registry = new Function(pre + "\n" + block + "; return REGISTRY;")();
const FIELDS = ["id","name","version","desc","size","minSize","maxSize","fileName","repoFile","bundledPath","license","category","manual","officialUrl","overLimit","slow","fileSize","ext"];
const out = registry.map((it) => { const o = {}; for (const f of FIELDS) if (it[f] !== undefined) o[f] = it[f]; return o; });
fs.writeFileSync(path.join(ROOT, "shells/tauri/src/soundfont_registry.json"), JSON.stringify(out, null, 2) + "\n", "utf8");
console.log("[sf-registry] entries=" + out.length);