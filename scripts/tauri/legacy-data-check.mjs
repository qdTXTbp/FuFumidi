#!/usr/bin/env node
// 只读验收：不设置 FUFUMIDI_DATA_ROOT/DB_FILE，Tauri 壳应直接读到 Electron 的
// %APPDATA%/FuFumidi/fufumidi/fufumidi.sqlite 与 legacy settings.json。
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXE = process.env.FUFUMIDI_TAURI_EXE || path.join(ROOT, "poc", "tauri-poc", "target", "debug", "fufumidi-shell.exe");
const PORT = 9800 + Math.floor(Math.random() * 150);
const ART = path.join(ROOT, "shells", "tauri", "artifacts");
fs.mkdirSync(ART, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = Object.assign({}, process.env);
delete env.FUFUMIDI_DATA_ROOT;
delete env.FUFUMIDI_DB_FILE;
delete env.FUFUMIDI_SETTINGS_FILE;
env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=" + PORT;
const child = spawn(EXE, [], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
const log = []; child.stdout.on("data", (d) => log.push(String(d))); child.stderr.on("data", (d) => log.push(String(d)));
const send = (ws, id, method, params) => new Promise((resolve, reject) => {
  const on = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.id !== id) return; ws.removeEventListener("message", on); m.error ? reject(new Error(m.error.message)) : resolve(m.result); };
  ws.addEventListener("message", on); ws.send(JSON.stringify({ id, method, params: params || {} }));
});
let ws = null;
try {
  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    try { const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json(); target = (list || []).find((t) => t.type === "page" && t.webSocketDebuggerUrl); } catch (e) {}
    if (!target) await sleep(250);
  }
  if (!target) throw new Error("CDP target not found");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws open failed")); });
  await send(ws, 1, "Runtime.enable", {});
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { const p = await send(ws, 100 + i, "Runtime.evaluate", { expression: "typeof window.__TAURI_INTERNALS__ === 'object' && document.body.innerText.length > 50", returnByValue: true }); ready = !!(p.result && p.result.value); } catch (e) {}
    if (!ready) await sleep(250);
  }
  if (!ready) throw new Error("app not ready");
  const r = await send(ws, 2, "Runtime.evaluate", { expression: "(async () => { const inv = window.__TAURI_INTERNALS__.invoke; const st = await inv('db_status'); const songs = await inv('db_songs_list'); const pls = await inv('db_playlists_list'); const set = await inv('load_settings'); return { status: st, songCount: songs.length, firstSong: songs[0] ? { id: songs[0].id, name: songs[0].name } : null, playlists: pls.length, settingsKeys: Object.keys(set || {}).length, theme: set && set.theme, sidebar: (document.body.innerText || '').slice(0, 200) }; })()", awaitPromise: true, returnByValue: true });
  const data = r.result && r.result.value;
  const shot = await send(ws, 3, "Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(ART, "legacy-library.png");
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  const ok = !!(data && data.status && data.status.kind === "sqlite" && data.songCount > 0 && data.status.songs === data.songCount);
  console.log(JSON.stringify({ ok, data, screenshot: shotPath }, null, 2));
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.error("FAIL", (e && e.stack) || e);
  console.error(log.join("").slice(-1500));
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch (e) {}
  try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch (e) {}
}
