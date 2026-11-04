#!/usr/bin/env node
// 为 Tauri NSIS 安装包准备 resources（与 Electron extraResources 对齐）：
// - python：排除 torch/torchvision/torchaudio/demucs/piano_transcription_inference 与对应 Scripts
// - engine：排除 tests/__pycache__
// - soundfonts：sf2/sf3 + license
// - models：只带 basic_pitch_quant.onnx（与 electron-builder.base.yml 一致）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "shells/tauri/bundle");
const EXCLUDED_PY = [/[\\/]Lib[\\/]site-packages[\\/](torch|torchvision|torchaudio|demucs|piano_transcription_inference)([\\/]|$)/, /[\\/]Scripts[\\/](torchrun|demucs|f2py|torchfrtrace)\.exe$/i];
const EXCLUDED_ENGINE = [/[\\/]tests?([\\/]|$)/, /[\\/]__pycache__([\\/]|$)/];
function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (filter && filter(s)) continue;
    if (e.isDirectory()) copyDir(s, d, filter);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}
function sizeOf(p) {
  let total = 0;
  const walk = (x) => {
    const st = fs.statSync(x);
    if (st.isFile()) total += st.size;
    else for (const f of fs.readdirSync(x)) walk(path.join(x, f));
  };
  try { walk(p); } catch (e) {}
  return total;
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
copyDir(path.join(ROOT, "resources/python"), path.join(OUT, "python"), (s) => EXCLUDED_PY.some((re) => re.test(s)));
copyDir(path.join(ROOT, "engine"), path.join(OUT, "engine"), (s) => EXCLUDED_ENGINE.some((re) => re.test(s)));
fs.mkdirSync(path.join(OUT, "soundfonts"), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, "renderer/vendor/soundfonts"))) {
  if (/\.(sf2|sf3|txt)$/i.test(f)) fs.copyFileSync(path.join(ROOT, "renderer/vendor/soundfonts", f), path.join(OUT, "soundfonts", f));
}
fs.mkdirSync(path.join(OUT, "models"), { recursive: true });
const basic = path.join(ROOT, "resources/models/basic_pitch_quant.onnx");
if (fs.existsSync(basic)) fs.copyFileSync(basic, path.join(OUT, "models/basic_pitch_quant.onnx"));
const elevate = path.join(ROOT, "resources/elevate.exe");
if (fs.existsSync(elevate)) fs.copyFileSync(elevate, path.join(OUT, "elevate.exe"));
const manifest = {
  python: sizeOf(path.join(OUT, "python")),
  engine: sizeOf(path.join(OUT, "engine")),
  soundfonts: sizeOf(path.join(OUT, "soundfonts")),
  models: sizeOf(path.join(OUT, "models")),
};
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("[tauri-stage] " + JSON.stringify(manifest));
