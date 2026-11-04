#!/usr/bin/env node
// Tauri 壳冒烟（T-115/T-116）：WebView2 CDP 直接调用真实 IPC，并检查 UI 渲染。
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ART = path.join(ROOT, "shells", "tauri", "artifacts");
fs.mkdirSync(ART, { recursive: true });
const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const exeArg = argv.indexOf("--exe");
const EXE = (exeArg >= 0 ? argv[exeArg + 1] : "") || path.join(ROOT, "poc", "tauri-poc", "target", "debug", "fufumidi-shell.exe");
const PORT = 9400 + Math.floor(Math.random() * 400);
const DATA = path.join(ART, "data-" + Date.now());
const FIX = path.join(ART, "tmp-" + Date.now());
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(FIX, { recursive: true });
const MIDI = path.join(FIX, "smoke.mid");
fs.writeFileSync(MIDI, Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0]));
const OUT = path.join(FIX, "out.bin");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const child = spawn(EXE, [], { cwd: ROOT, env: Object.assign({}, process.env, {
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + PORT,
  FUFUMIDI_DATA_ROOT: DATA,
}), stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (d) => log.push(String(d)));
child.stderr.on("data", (d) => log.push(String(d)));
const send = (ws, id, method, params) => new Promise((resolve, reject) => {
  const onMsg = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.id !== id) return;
    ws.removeEventListener("message", onMsg); m.error ? reject(new Error(m.error.message)) : resolve(m.result); };
  ws.addEventListener("message", onMsg);
  ws.send(JSON.stringify({ id, method, params: params || {} }));
});
const EXPR = [
  "(async () => {",
  "  const P = " + JSON.stringify({ fix: FIX, midi: MIDI, out: OUT }) + ";",
  "  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args || {});",
  "  const info = await inv('host_info');",
  "  const ver = await inv('app_version');",
  "  const py = await inv('python_selfcheck');",
  "  const saved = await inv('save_settings', { s: { smoke: true, n: 42 } });",
  "  const loaded = await inv('load_settings');",
  "  const set = await inv('db_kv_set', { key: 'smoke', value: { a: 1 } });",
  "  const got = await inv('db_kv_get', { key: 'smoke' });",
  "  const files = await inv('list_midi_files', { dir: P.fix });",
  "  const toU8 = (b) => { if (b instanceof ArrayBuffer) return new Uint8Array(b); if (b && b.buffer) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); return new Uint8Array(b || []); };",
  "  const bin = await inv('read_binary', { p: P.midi });",
  "  const header = Array.from(toU8(bin).slice(0, 4)).map((x) => String.fromCharCode(x)).join('');",
  "  const sb = await inv('save_binary', { opts: { path: P.out, bytes: [1, 2, 3, 4] } });",
  "  const back = toU8(await inv('read_binary', { p: P.out }));",
  "  return {",
  "    ui: { title: document.title, appChildren: (document.getElementById('app') || { childElementCount: -1 }).childElementCount, fuBridge: typeof window.fuBridge, tauri: typeof window.__TAURI__, hash: location.hash, textLen: (document.body.innerText || '').length },",
  "    info, ver, py, saved, loaded, set, got, files, header, sb, backLen: back.length,",
  "  };",
  "})()",
].join("\n");
try {
  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    try { const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
      target = (list || []).find((t) => t.type === "page" && t.webSocketDebuggerUrl); } catch (e) {}
    if (!target) await sleep(250);
  }
  if (!target) throw new Error("CDP target not found\n" + log.join("").slice(-1500));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws open failed")); });
  await send(ws, 1, "Runtime.enable", {});
  await send(ws, 2, "Page.enable", {});
  const ev = await send(ws, 3, "Runtime.evaluate", { expression: EXPR, awaitPromise: true, returnByValue: true });
  if (ev.exceptionDetails) throw new Error("JS exception: " + JSON.stringify(ev.exceptionDetails).slice(0, 500));
  const r = ev.result && ev.result.value;
  const shot = await send(ws, 4, "Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(ART, "smoke.png");
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  const checks = {
    host: !!r.info && r.info.ok === true,
    version: typeof r.ver === "string" && r.ver.length > 0,
    python: !!r.py && r.py.ok === true,
    settings: !!r.saved && r.saved.ok === true && !!r.loaded && r.loaded.smoke === true && r.loaded.n === 42,
    kv: !!r.set && r.set.ok === true && !!r.got && r.got.a === 1,
    listMidi: Array.isArray(r.files) && r.files.length === 1 && /smoke\.mid$/.test(r.files[0]),
    readBinary: r.header === "MThd",
    saveBinary: !!r.sb && r.sb.ok === true && r.backLen === 4,
    ui: r.ui.fuBridge === "object" && r.ui.tauri === "object" && r.ui.appChildren > 0 && r.ui.textLen > 200,
  };
  const ok = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ ok, checks, result: r, screenshot: shotPath }, null, 2));
  ws.close();
  if (!keep) { try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch (e) {} }
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.error("[tauri-smoke] FAIL:", (e && e.stack) || e);
  console.error(log.join("").slice(-2000));
  try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch (err) {}
  process.exitCode = 1;
}
