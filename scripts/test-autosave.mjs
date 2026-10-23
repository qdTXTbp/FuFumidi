import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const A = require('../main/autosave.js');

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), "fufumidi-autosave-")); }

test("autosave：写入→列表→读取→清除（原样往返）", () => {
  const root = tmpRoot();
  const model = { tracks: [{ notes: [{ start: 0, midi: 60 }] }], title: "草稿" };
  const w = A.writeAutosave(root, "doc-a", model, { title: "曲 A", kind: "edit" });
  assert.equal(w.ok, true);
  assert.ok(w.path.endsWith(".json"));
  assert.ok(fs.existsSync(w.path));
  assert.ok(!fs.existsSync(w.path + ".tmp"), "原子写不能留 .tmp");

  const list = A.listAutosaves(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].docId, "doc-a");
  assert.equal(list[0].meta.title, "曲 A");
  assert.ok(list[0].bytes > 0);

  const r = A.readAutosave(root, "doc-a");
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, model);
  assert.equal(r.meta.kind, "edit");

  const c = A.clearAutosave(root, "doc-a");
  assert.equal(c.removed, true);
  assert.equal(A.readAutosave(root, "doc-a").ok, false);
  assert.equal(A.clearAutosave(root, "doc-a").removed, false, "重复清除不报错");
});

test("autosave：任意 docId 都能安全落盘（不可打印字符走哈希名）", () => {
  const root = tmpRoot();
  const weird = "工程/草稿: 2026-10-18 *?<>|";
  const w = A.writeAutosave(root, weird, { v: 1 });
  assert.equal(w.ok, true);
  const name = path.basename(w.path);
  assert.match(name, /^h_[0-9a-f]{16}\.json$/, "非法文件名应转成 h_<sha1前缀>.json");
  assert.equal(A.readAutosave(root, weird).data.v, 1, "读取仍按原 docId");
  assert.equal(A.safeId("normal_id-1.2"), "normal_id-1.2", "合法字符保持原样");
});

test("autosave：列表按时间倒序、坏草稿跳过", () => {
  const root = tmpRoot();
  A.writeAutosave(root, "old", { a: 1 });
  // 手动把 old 的时间戳改早，避免同毫秒导致顺序不稳定
  const dir = A.autosaveDir(root);
  const oldFile = path.join(dir, "old.json");
  const j = JSON.parse(fs.readFileSync(oldFile, "utf8"));
  j.ts = 1000;
  fs.writeFileSync(oldFile, JSON.stringify(j));
  A.writeAutosave(root, "new", { a: 2 });
  fs.writeFileSync(path.join(dir, "broken.json"), "{ 不是 json");
  const list = A.listAutosaves(root);
  assert.deepEqual(list.map((x) => x.docId), ["new", "old"]);
  assert.equal(fs.existsSync(path.join(dir, "broken.json")), true, "坏草稿不被删除（留给人工排查）");
});

test("autosave：写失败明确报错（不可序列化模型）", () => {
  const root = tmpRoot();
  const circular = {};
  circular.self = circular;
  const w = A.writeAutosave(root, "c", circular);
  assert.equal(w.ok, false);
  assert.match(w.error, /无法序列化/);
  assert.equal(A.listAutosaves(root).length, 0);
});

test("autosave：格式不符的 JSON 不被当成草稿", () => {
  const root = tmpRoot();
  const dir = A.autosaveDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "x.json"), JSON.stringify({ hello: 1 }));
  assert.equal(A.listAutosaves(root).length, 0);
  assert.equal(A.readAutosave(root, "x").ok, false);
});

test("autosave：空目录/不存在目录都安全返回", () => {
  const root = path.join(tmpRoot(), "not-created-yet");
  assert.deepEqual(A.listAutosaves(root), []);
  assert.equal(A.readAutosave(root, "none").ok, false);
});
