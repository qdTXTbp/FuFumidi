#!/usr/bin/env node
// ============================================================
// 用 GitHub Git Data API 推送本地提交（不走 git push）。
//
// 为什么需要（用户 2026-10-14 的决定：**以后都走 Git Data API**）：
//   本机到 github.com:443 经常连不上（git push 直接 fatal），但 api.github.com 一直可用 ——
//   所以推送改成：blob → tree → commit → PATCH ref。
//
// 用法：node scripts/api-push.mjs [--branch release/5.0.0] [--dry]
//   token 从 git 凭据管理器取（与 get-token.py 同一来源），不写进仓库。
//
// ★ 顺序：先读远端 ref，只重放**它之后**的本地提交 —— 本地已经推过的提交再重放一次
//   会造出内容相同、SHA 不同的重复提交（2026-10-14 踩过）。
//
// ★ 远端那个 SHA 是**上一次 API 推送造出来的，本地根本没有这个对象**，所以不能直接
//   `git rev-list <远端SHA>..HEAD`（会 fatal: Invalid revision range —— 第二次推送必踩）。
//   做法：把远端提交按**树**映射回本地等价提交（树相同 = 内容相同），再算区间。
//   远端 SHA 仍然作为新提交的 parent 用（Git Data API 认得它，不需要本地有）。
// ============================================================
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REPO = "qdTXTbp/FuFumidi";
const API = "https://api.github.com/repos/" + REPO;
const argv = process.argv.slice(2);
const opt = (n, d = "") => { const i = argv.indexOf("--" + n); return i >= 0 ? (argv[i + 1] || "") : d; };
const BRANCH = opt("branch", "release/5.0.0");
const DRY = argv.includes("--dry");

const DIR = new URL("..", import.meta.url).pathname.replace(/^\//, "");
const git = (...a) => execFileSync("git", a, { cwd: DIR, encoding: "utf8" }).trim();
// 探测用的 git 调用：把 stderr 丢掉，否则"对象不存在"会把 fatal 打到控制台（虽然已被 catch）
const gitHas = (rev) => { try { execFileSync("git", ["cat-file", "-e", rev], { cwd: DIR, stdio: "ignore" }); return true; } catch { return false; } };
const cred = () => {
  const out = execFileSync("git", ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n", encoding: "utf8" });
  const line = out.split(/\r?\n/).find(l => l.startsWith("password="));
  if (!line) throw new Error("git 凭据管理器里没有 github.com 的口令");
  return line.slice(9);
};
const TOKEN = cred();
const H = { Authorization: "token " + TOKEN, "User-Agent": "FuFumidi-Release", Accept: "application/vnd.github+json" };

async function api(path, init = {}) {
  const r = await fetch(API + path, { ...init, headers: { ...H, "Content-Type": "application/json; charset=utf-8", ...(init.headers || {}) } });
  const txt = await r.text();
  if (!r.ok) throw new Error(path + " → HTTP " + r.status + " " + txt.slice(0, 300));
  return txt ? JSON.parse(txt) : null;
}
const post = (p, body) => api(p, { method: "POST", body: JSON.stringify(body) });

const head = git("rev-parse", "HEAD");
const remote = await api("/git/ref/heads/" + BRANCH);
let parent = remote.object.sha;
if (parent === head) { console.log("远端已经是最新（" + head.slice(0, 8) + "），无需推送"); process.exit(0); }
let base = gitHas(parent + "^{commit}") ? parent : null;   // 本地有这个提交就用它
if (!base) {
  const remoteTree = (await api("/git/commits/" + parent)).tree.sha;
  const line = git("log", "--format=%H %T", "HEAD").split(/\r?\n/)
    .find(l => l.endsWith(" " + remoteTree));
  if (!line) {
    throw new Error("远端 " + parent.slice(0, 8) + " 的树 " + remoteTree.slice(0, 8) +
      " 在本地找不到等价提交 —— 本地与远端已分叉，不自动重放；先人工比对再决定");
  }
  base = line.split(" ")[0];
  console.log("远端 " + parent.slice(0, 8) + " 是上次 API 推送造的（本地无此对象），按树映射到本地 " + base.slice(0, 8));
}
let ahead = git("rev-list", "--reverse", base + "..HEAD").split(/\r?\n/).filter(Boolean);
if (!ahead.length) { console.log("本地没有领先远端的提交（远端 " + parent.slice(0, 8) + " / 本地 " + head.slice(0, 8) + "）"); process.exit(0); }
console.log("远端 " + parent.slice(0, 8) + " → 本地 " + head.slice(0, 8) + "，待推 " + ahead.length + " 个提交" + (DRY ? "（--dry 只预览）" : ""));

for (const sha of ahead) {
  const msg = git("log", "-1", "--format=%B", sha).trim();
  // ★ 两个坑都在这里（2026-10-16 各踩过一次，都真的打断了推送）：
  //   ① 重命名：--name-status 对 R/C 输出三段（R100\t旧\t新），旧代码 rest.join("\t")
  //      会拼出一个不存在的路径 → cat-file fatal。重命名还必须**显式删掉旧路径**：
  //      新提交是 base_tree（远端父提交）加上增量，父树里那个旧文件不会自己消失，
  //      不删就在远端留一个幽灵文件。
  //   ② 非 ASCII 路径：不带 -z 时 git 会给带中文的路径**加双引号并八进制转义**
  //      （"docs/assets/brand/\345\276\275\350\256\260-512.png"），照样 cat-file 不到。
  //      所以用 -z 拿 NUL 分隔的**原始字节路径**（不再有引号/转义，含制表符的路径也安全）。
  const parts = execFileSync("git", ["show", "--name-status", "-z", "--format=", sha], { cwd: DIR, encoding: "utf8" })
    .split("\0");
  const changed = [];
  for (let i = 0; i < parts.length;) {
    const st = parts[i++];
    if (!st) continue;
    if (st[0] === "R" || st[0] === "C") { const from = parts[i++], path = parts[i++]; changed.push({ st: st[0], from, path }); }
    else changed.push({ st: st[0], path: parts[i++] });
  }
  if (DRY) { console.log("  [dry] " + sha.slice(0, 8) + "  " + changed.length + " 文件  " + msg.split("\n")[0].slice(0, 50)); continue; }
  const pc = await api("/git/commits/" + parent);
  const tree = [];
  for (const c of changed) {
    if (c.st === "D") { tree.push({ path: c.path, mode: "100644", type: "blob", sha: null }); continue; }
    if (c.st === "R") tree.push({ path: c.from, mode: "100644", type: "blob", sha: null });   // 先删旧路径
    const buf = execFileSync("git", ["cat-file", "blob", sha + ":" + c.path], { maxBuffer: 1 << 28 });
    const blob = await post("/git/blobs", { content: buf.toString("base64"), encoding: "base64" });
    tree.push({ path: c.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const t = await post("/git/trees", { base_tree: pc.tree.sha, tree });
  const commit = await post("/git/commits", { message: msg, tree: t.sha, parents: [parent] });
  parent = commit.sha;
  console.log("  → " + commit.sha.slice(0, 8) + "  " + changed.length + " 文件  " + msg.split("\n")[0].slice(0, 50));
}
if (DRY) process.exit(0);
const upd = await api("/git/refs/heads/" + BRANCH, { method: "PATCH", body: JSON.stringify({ sha: parent, force: false }) });
console.log("★ refs/heads/" + BRANCH + " → " + upd.object.sha.slice(0, 8));
