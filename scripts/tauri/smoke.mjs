#!/usr/bin/env node
// Tauri 壳冒烟（T-115/T-116）：WebView2 CDP 直接调用真实 IPC，并检查 UI 渲染。
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeMidi } from "../../frontend/src/core/midi.js";
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
const MIDI_BYTES = Array.from(encodeMidi([{ name: "Smoke Song", ch: 0, program: 0, notes: [
  { start: 0, end: 480, midi: 60, vel: 100, ch: 0 },
  { start: 480, end: 960, midi: 64, vel: 90, ch: 0 },
], ccs: [], events: [] }], { division: 480 }));
fs.writeFileSync(MIDI, Buffer.from(MIDI_BYTES));
const OUT = path.join(FIX, "out.bin");
const WAV = path.join(FIX, "tone.wav");
const OUTMIDI = path.join(FIX, "tone.mid");
const LONGWAV = path.join(FIX, "long.wav");
const OUTLONG = path.join(FIX, "long.mid");
{
  const sr = 22050, n = sr;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / sr) * 0.25 * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(WAV, Buffer.concat([h, data]));
  // 120s 长音：用于取消测试（Basic Pitch 在暖 worker 上对短音频可能 100ms 内就完成）
  const n2 = sr * 120;
  const data2 = Buffer.alloc(n2 * 2);
  for (let i = 0; i < n2; i++) data2.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / sr) * 0.25 * 32767), i * 2);
  const h2 = Buffer.from(h);
  h2.writeUInt32LE(36 + data2.length, 4); h2.writeUInt32LE(data2.length, 40);
  fs.writeFileSync(LONGWAV, Buffer.concat([h2, data2]));
}
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
  "  const P = " + JSON.stringify({ fix: FIX, midi: MIDI, out: OUT, wav: WAV, outmidi: OUTMIDI, longwav: LONGWAV, outlong: OUTLONG, midiBytes: MIDI_BYTES }) + ";",
  "  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args || {});",
  "  const info = await inv('host_info');",
  "  const ver = await inv('app_version');",
  "  const py = await inv('python_selfcheck');",
  "  const eng = await inv('engine_probe');",
  "  const conv = await inv('convert', { req: { audio: P.wav, out: P.outmidi, mode: 'universal', model: 'basic', perf: 'balanced' } });",
  "  const worker = await inv('engine_worker_status');",
  "  const midiRaw = await inv('read_binary', { p: P.outmidi });",
  "  const midiBin = midiRaw instanceof ArrayBuffer ? new Uint8Array(midiRaw) : (midiRaw && midiRaw.buffer ? new Uint8Array(midiRaw.buffer, midiRaw.byteOffset, midiRaw.byteLength) : new Uint8Array(midiRaw || []));",
  "  const midiHeader = Array.from(midiBin.slice(0, 4)).map((x) => String.fromCharCode(x)).join('');",
  "  const saved = await inv('save_settings', { s: { smoke: true, n: 42 } });",
  "  const loaded = await inv('load_settings');",
  "  const set = await inv('db_kv_set', { key: 'smoke', value: { a: 1 } });",
  "  const got = await inv('db_kv_get', { key: 'smoke' });",
  "  const songPut = await inv('db_songs_put', { item: { id: 'smoke-song', name: 'Smoke Song' } });",
  "  const songs = await inv('db_songs_list');",
  "  const dbStat = await inv('db_status');",
  "  const songDel = await inv('db_songs_delete', { id: 'smoke-song' });",
  "  const songsAfter = await inv('db_songs_list');",
  "  const plPut = await inv('db_playlists_put', { item: { id: 'smoke-pl', name: 'Smoke PL' } });",
  "  const pls = await inv('db_playlists_list');",
  "  const convPause = inv('convert', { req: { audio: P.longwav, out: P.outlong + '.paused.mid', mode: 'universal', model: 'basic', perf: 'balanced' } }).catch((e) => ({ ok: false, error: String(e) }));",
  "  await new Promise((r) => setTimeout(r, 300));",
  "  const pauseR = await inv('set_transcribe_pause', { on: true });",
  "  await new Promise((r) => setTimeout(r, 900));",
  "  const settledEarly = await Promise.race([convPause.then(() => true), new Promise((r) => setTimeout(() => r(false), 80))]);",
  "  const resumeR = await inv('set_transcribe_pause', { on: false });",
  "  const pausedConv = await convPause;",
  "  const convPending = inv('convert', { req: { audio: P.longwav, out: P.outlong, mode: 'universal', model: 'basic', perf: 'balanced' } }).catch((e) => ({ ok: false, error: String(e) }));",
  "  await new Promise((r) => setTimeout(r, 400));",
  "  const cancelR = await inv('cancel', { id: 'smoke-cancel' });",
  "  const canceledConv = await convPending;",
  "  const workerAfterCancel = await inv('engine_worker_status');",
  "  const models = await inv('model_list');",
  "  const pList = await inv('presets_list');",
  "  const pSave = await inv('presets_save', { req: { name: 'Smoke Preset', mode: 'universal', params: { perf: 'quality' } } });",
  "  const pList2 = await inv('presets_list');",
  "  const pBind = await inv('presets_set_model', { key: 'basic', name: 'Smoke Preset' });",
  "  const pUnbind = await inv('presets_set_model', { key: 'basic', name: '' });",
  "  const pDel = await inv('presets_delete', { name: 'Smoke Preset' });",
  "  const pList3 = await inv('presets_list');",
  "  const sfs = await inv('soundfont_list');",
  "  const deps = await inv('dep_check');",
  "  const diag = await inv('diag_export');",
  "  const notifyR = await inv('notify', { title: 'smoke', body: 'tauri' });",
  "  const openBad = await inv('open_output', { p: P.out + '.missing' });",
  "  const extBad = await inv('open_external', { url: 'file:///tmp/x' });",
  "  const uiSongPut = await inv('db_songs_put', { item: { id: 'smoke-ui', name: 'Smoke UI Song', kind: 'midi', size: P.midiBytes.length, time: Date.now(), dur: 1, fp: '', path: '', bytes: P.midiBytes } });",
  "  const files = await inv('list_midi_files', { dir: P.fix });",
  "  const toU8 = (b) => { if (b instanceof ArrayBuffer) return new Uint8Array(b); if (b && b.buffer) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); return new Uint8Array(b || []); };",
  "  const bin = await inv('read_binary', { p: P.midi });",
  "  const header = Array.from(toU8(bin).slice(0, 4)).map((x) => String.fromCharCode(x)).join('');",
  "  const sb = await inv('save_binary', { opts: { path: P.out, bytes: [1, 2, 3, 4] } });",
  "  const back = toU8(await inv('read_binary', { p: P.out }));",
  "  const pages = [];",
  "  for (const route of [['transcribe', '#/transcribe'], ['resources', '#/resources'], ['piano3d', '#/piano3d'], ['music', '#/music']]) {",
  "    location.hash = route[1];",
  "    await new Promise((res) => setTimeout(res, 700));",
  "    pages.push({ name: route[0], hash: location.hash, textLen: (document.body.innerText || '').length, appChildren: (document.getElementById('app') || { childElementCount: 0 }).childElementCount });",
  "  }",
  "  location.hash = '#/home';",
  "  await new Promise((res) => setTimeout(res, 500));",
  "  return {",
  "    pages,",
  "    ui: { title: document.title, appChildren: (document.getElementById('app') || { childElementCount: -1 }).childElementCount, fuBridge: typeof window.fuBridge, tauri: typeof window.__TAURI__, hash: location.hash, textLen: (document.body.innerText || '').length },",
  "    info, ver, py, eng, conv, worker, midiHeader, saved, loaded, set, got, songPut, songs, dbStat, songDel, songsAfter, plPut, pls, models, pauseR, resumeR, settledEarly, pausedConv, cancelR, canceledConv, workerAfterCancel, pList, pSave, pList2, pBind, pUnbind, pDel, pList3, sfs, deps, diag, notifyR, openBad, extBad, uiSongPut, files, header, sb, backLen: back.length,",
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
  // 等 Tauri 注入 __TAURI_INTERNALS__ 且 Vue 挂载完成（新命令注册会让启动略慢）
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    try {
      const probe = await send(ws, 100 + i, "Runtime.evaluate", { expression: "typeof window.__TAURI_INTERNALS__ === 'object' && !!document.getElementById('app') && document.body.innerText.length > 50", returnByValue: true });
      ready = !!(probe.result && probe.result.value);
    } catch (e) {}
    if (!ready) await sleep(250);
  }
  if (!ready) throw new Error("page not ready for Tauri IPC (internals/app missing)");
  const ev = await send(ws, 3, "Runtime.evaluate", { expression: EXPR, awaitPromise: true, returnByValue: true });
  if (ev.exceptionDetails) throw new Error("JS exception: " + JSON.stringify(ev.exceptionDetails).slice(0, 500));
  const r = ev.result && ev.result.value;
  // 迁移验收：写入曲库 → 真刷新 → 侧栏必须显示这首歌（证明 Tauri 版曲库持久化 + 显示都正常）
  await send(ws, 500, "Page.reload", {});
  let ready2 = false;
  for (let i = 0; i < 100 && !ready2; i++) {
    try {
      const probe = await send(ws, 600 + i, "Runtime.evaluate", { expression: "typeof window.__TAURI_INTERNALS__ === 'object' && !!document.getElementById('app') && document.body.innerText.length > 50", returnByValue: true });
      ready2 = !!(probe.result && probe.result.value);
    } catch (e) {}
    if (!ready2) await sleep(250);
  }
  if (!ready2) throw new Error("page not ready after reload");
  // restoreSongs 是异步的：等曲库真正出现在界面上，别在加载中途采样
  let libShown = false;
  for (let i = 0; i < 60 && !libShown; i++) {
    try {
      const p = await send(ws, 800 + i, "Runtime.evaluate", { expression: "(document.body.innerText || '').indexOf('Smoke UI Song') >= 0", returnByValue: true });
      libShown = !!(p.result && p.result.value);
    } catch (e) {}
    if (!libShown) await sleep(250);
  }
  const libEv = await send(ws, 700, "Runtime.evaluate", { expression: "(async () => { const inv = window.__TAURI_INTERNALS__.invoke; let songs = []; try { songs = await inv('db_songs_list'); } catch (e) {} let bridgeSongs = null; try { bridgeSongs = await window.fuBridge.dbSongsList(); } catch (e) { bridgeSongs = 'ERR:' + (e && e.message || e); } let storeSongs = -1, manual = -1; try { const va = document.querySelector('#app').__vue_app__; const pinia = va.config.globalProperties.$pinia; const store = pinia._s.get('app'); storeSongs = (store.songs || []).length; await store.restoreSongs(); manual = (store.songs || []).length; } catch (e) { manual = -2; } return { apiBridgeReady: window.__apiBridgeReady, apiBridgeKeys: window.__apiBridgeKeys, restoreBridgeKeys: window.__restoreBridgeKeys, hasName: (document.body.innerText || '').indexOf('Smoke UI Song') >= 0, appChildren: (document.getElementById('app') || { childElementCount: 0 }).childElementCount, textLen: (document.body.innerText || '').length, songIds: songs.map((s) => s.id), bridgeIds: Array.isArray(bridgeSongs) ? bridgeSongs.map((s) => s.id) : bridgeSongs, storeSongs, manual, checkMidi: typeof window.fuBridge.checkMidi, body: (document.body.innerText || '').slice(0, 300) }; })()", awaitPromise: true, returnByValue: true });
  r.uiLibrary = libEv.result && libEv.result.value;
  // 清理测试曲目，避免污染临时数据根
  await send(ws, 701, "Runtime.evaluate", { expression: "(async () => { try { await window.__TAURI_INTERNALS__.invoke('db_songs_delete', { id: 'smoke-ui' }); } catch (e) {} return true; })()", awaitPromise: true, returnByValue: true });
  const shot = await send(ws, 4, "Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(ART, "smoke.png");
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  const checks = {
    host: !!r.info && r.info.ok === true,
    engineProbe: !!r.eng && r.eng.ok === true && !!r.eng.probe && r.eng.elapsedMs > 0,
    convert: !!r.conv && r.conv.ok === true && typeof r.conv.note_count === "number" && r.conv.logLines > 0 && r.midiHeader === "MThd",
    worker: !!r.worker && r.worker.ok === true && r.worker.running === true && r.worker.seq >= 1,
    dbSongs: r.songPut === true && Array.isArray(r.songs) && r.songs.length === 1 && r.songs[0].id === "smoke-song" && !!r.dbStat && r.dbStat.songs === 1 && r.songDel === true && Array.isArray(r.songsAfter) && r.songsAfter.length === 0,
    dbPlaylists: r.plPut === true && Array.isArray(r.pls) && r.pls.some((x) => x.id === "smoke-pl"),
    pause: !!r.pauseR && r.pauseR.ok === true && r.pauseR.paused === true && !!r.resumeR && r.resumeR.ok === true && r.settledEarly === false && !!r.pausedConv && r.pausedConv.ok === true,
    cancel: !!r.cancelR && r.cancelR.canceled === true && !!r.canceledConv && r.canceledConv.canceled === true && r.canceledConv.ok === false && !!r.workerAfterCancel && r.workerAfterCancel.running === false,
    presets: !!r.pList && r.pList.ok === true && !!r.pList.model_defaults && !!r.pList.model_defaults.basic && Array.isArray(r.pList.builtins) && r.pList.builtins.length >= 9 && !!r.pSave && r.pSave.saved === true && !!r.pList2 && r.pList2.last_used === "Smoke Preset" && !!r.pList2.presets && !!r.pList2.presets["Smoke Preset"] && !!r.pBind && r.pBind.model_preset && r.pBind.model_preset.basic === "Smoke Preset" && !!r.pUnbind && (!r.pUnbind.model_preset || !r.pUnbind.model_preset.basic) && !!r.pDel && r.pDel.deleted === true && !!r.pList3 && (!r.pList3.presets || !r.pList3.presets["Smoke Preset"]),
    soundfonts: Array.isArray(r.sfs) && r.sfs.length >= 1 && /\.sf[23]$/i.test((r.sfs[0] && r.sfs[0].path) || ""),
    depCheck: !!r.deps && r.deps.ok === true && !!r.deps.result && !!r.deps.result.groups,
    diagExport: !!r.diag && r.diag.ok === true && /diagnostics-\d+\.json$/.test(r.diag.path || ""),
    safeShellOps: !!r.notifyR && r.notifyR.ok === true && r.openBad.ok === false && r.extBad.ok === false,
    modelList: Array.isArray(r.models) && r.models.length >= 12 && ["basic_pitch","piano_transcription","muscriptor_small","yourmt3","miros","beat_this"].every((id) => r.models.some((m) => m.id === id)) && r.models.some((m) => m.kind === "separate"),
    version: typeof r.ver === "string" && r.ver.length > 0,
    python: !!r.py && r.py.ok === true,
    settings: !!r.saved && r.saved.ok === true && !!r.loaded && r.loaded.smoke === true && r.loaded.n === 42,
    kv: !!r.set && r.set.ok === true && !!r.got && r.got.a === 1,
    listMidi: Array.isArray(r.files) && r.files.some((f) => /smoke\.mid$/.test(f)),
    readBinary: r.header === "MThd",
    saveBinary: !!r.sb && r.sb.ok === true && r.backLen === 4,
    ui: r.ui.fuBridge === "object" && r.ui.tauri === "object" && r.ui.appChildren > 0 && r.ui.textLen > 200,
    uiRoutes: Array.isArray(r.pages) && r.pages.length === 4 && r.pages.every((p) => p.textLen > 80 && p.appChildren > 0 && p.hash.indexOf(p.name) >= 0),
    uiLibrary: !!r.uiLibrary && r.uiLibrary.hasName === true && r.uiLibrary.appChildren > 0 && r.uiSongPut === true,
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
