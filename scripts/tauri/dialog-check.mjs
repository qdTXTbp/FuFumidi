#!/usr/bin/env node
// 原生对话框实弹验收：打开 pick_file，用 PowerShell 向前台窗口发 Esc，断言 Promise 解析为 null。
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXE = process.env.FUFUMIDI_TAURI_EXE || path.join(ROOT, "poc", "tauri-poc", "target", "debug", "fufumidi-shell.exe");
const PORT = 9950 + Math.floor(Math.random() * 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = Object.assign({}, process.env, { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + PORT });
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
  for (let i = 0; i < 100; i++) {
    const p = await send(ws, 100 + i, "Runtime.evaluate", { expression: "typeof window.__TAURI_INTERNALS__ === 'object' && document.body.innerText.length > 30", returnByValue: true }).catch(() => null);
    if (p && p.result && p.result.value) break;
    await sleep(250);
  }
  await send(ws, 2, "Runtime.evaluate", { expression: "window.__dlgP = window.__TAURI_INTERNALS__.invoke('pick_file', { opts: { title: 'Dialog check' } }); 'started'", returnByValue: true });
  await sleep(1500);
  const ps = `$w = New-Object -ComObject WScript.Shell; $null = $w.AppActivate('FuFumidi'); Start-Sleep -Milliseconds 400; $w.SendKeys('{ESC}')`;
  execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { stdio: "ignore", timeout: 15000 });
  await sleep(1200);
  const ev = await send(ws, 3, "Runtime.evaluate", { expression: "Promise.race([ window.__dlgP.then((v) => ({ state: 'resolved', value: v }), (e) => ({ state: 'rejected', error: String(e) })), new Promise((r) => setTimeout(() => r({ state: 'pending' }), 4000)) ])", awaitPromise: true, returnByValue: true });
  const result = ev.result && ev.result.value;
  const shot = await send(ws, 4, "Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(ROOT, "shells", "tauri", "artifacts", "dialog-cancel.png");
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  const ok = !!(result && result.state === "resolved" && result.value === null);
  console.log(JSON.stringify({ ok, result, screenshot: shotPath }, null, 2));
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.error("FAIL", (e && e.stack) || e);
  console.error(log.join("").slice(-1200));
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch (e) {}
  try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch (e) {}
}
