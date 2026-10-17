// ============================================================
// 自动保存草稿（P0-2 的主进程存储层）
// ============================================================
// 只做「字节落盘」这一件事：前端给 docId + 可序列化模型，这里原子写入数据根的
// temp/autosave/<safeId>.json，并提供 list/read/clear 给崩溃恢复 UI。
//
// 约定：
//   · **不覆盖用户工程文件**：草稿永远在 temp/autosave 下，恢复与否由用户决定；
//   · 原子写：先写 .tmp 再 rename，进程被杀不会留下半个 JSON 被当成有效草稿；
//   · 大小上限 32MB：超过说明存错对象了（例如把音频字节塞进来），直接拒绝；
//   · docId 可以是任意字符串，文件名用安全化后的 id（不可打印字符走 sha1 前缀）。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 32 * 1024 * 1024;
const SAFE_RE = /^[A-Za-z0-9._-]{1,120}$/;

function safeId(docId) {
  const s = String(docId == null ? "" : docId);
  if (SAFE_RE.test(s)) return s;
  return "h_" + crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
}
function autosaveDir(root) { return path.join(root, "autosave"); }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }

function writeAutosave(root, docId, model, meta) {
  const dir = ensureDir(autosaveDir(root));
  const id = safeId(docId);
  let payload;
  try {
    const ts = Date.now();
    payload = JSON.stringify({ format: "fufumidi-autosave", version: 1, docId: String(docId), ts, meta: meta || {}, data: model });
  } catch (e) { return { ok: false, error: "草稿无法序列化：" + String((e && e.message) || e) }; }
  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes > MAX_BYTES) return { ok: false, error: "草稿过大（" + (bytes / 1048576).toFixed(1) + "MB > 32MB），已拒绝写入" };
  const file = path.join(dir, id + ".json");
  const tmp = file + ".tmp";
  try {
    fs.writeFileSync(tmp, payload, "utf8");
    fs.renameSync(tmp, file);
    return { ok: true, path: file, ts: JSON.parse(payload).ts, bytes };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function listAutosaves(root) {
  const dir = autosaveDir(root);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const fp = path.join(dir, name);
    try {
      const st = fs.statSync(fp);
      const raw = fs.readFileSync(fp, "utf8");
      const j = JSON.parse(raw);
      if (!j || j.format !== "fufumidi-autosave") continue;
      out.push({
        docId: j.docId,
        id: name.slice(0, -5),
        ts: j.ts || st.mtimeMs,
        meta: j.meta || {},
        bytes: st.size,
        path: fp,
      });
    } catch (_) { /* 坏草稿跳过，不让一份损坏文件拖垮恢复列表 */ }
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

function readAutosave(root, docId) {
  const fp = path.join(autosaveDir(root), safeId(docId) + ".json");
  try {
    const j = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (!j || j.format !== "fufumidi-autosave") return { ok: false, error: "不是自动保存草稿" };
    return { ok: true, docId: j.docId, ts: j.ts, meta: j.meta || {}, data: j.data, path: fp };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

function clearAutosave(root, docId) {
  const fp = path.join(autosaveDir(root), safeId(docId) + ".json");
  try { fs.unlinkSync(fp); return { ok: true, removed: true }; }
  catch (e) { return { ok: true, removed: false }; }
}

/** 注册 IPC（由 main/project.js 调用；root 一般是 Paths.tempDir()） */
function registerAutosaveIpc({ ipcMain, root }) {
  if (!ipcMain || !root) return;
  ipcMain.handle("autosave:write", (_e, payload) => {
    const p = payload || {};
    if (p.docId == null) return { ok: false, error: "缺少 docId" };
    return writeAutosave(root, p.docId, p.model, p.meta);
  });
  ipcMain.handle("autosave:list", () => listAutosaves(root));
  ipcMain.handle("autosave:read", (_e, docId) => readAutosave(root, docId));
  ipcMain.handle("autosave:clear", (_e, docId) => clearAutosave(root, docId));
}

module.exports = { writeAutosave, listAutosaves, readAutosave, clearAutosave, registerAutosaveIpc, autosaveDir, safeId, MAX_BYTES };