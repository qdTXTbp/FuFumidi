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
// ============================================================
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REPO = "qdTXTbp/FuFumidi";
const API = "https://api.github.com/repos/" + REPO;
const argv = process.argv.slice(2);
const opt = (n, d = "") => { const i = argv.indexOf("--" + n); return i >= 0 ? (argv[i + 1] || "") : d; };
const BRANCH = opt("branch", "release/5.0.0");
const DRY = argv.includes("--dry");

const git = (...a) => execFileSync("git", a, { cwd: new URL("..", import.meta.url).pathname.replace(/^\//, ""), encoding: "utf8" }).trim();
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
let ahead = git("rev-list", "--reverse", parent + "..HEAD").split(/\r?\n/).filter(Boolean);
if (!ahead.length) { console.log("本地没有领先远端的提交（远端 " + parent.slice(0, 8) + " / 本地 " + head.slice(0, 8) + "）"); process.exit(0); }
console.log("远端 " + parent.slice(0, 8) + " → 本地 " + head.slice(0, 8) + "，待推 " + ahead.length + " 个提交" + (DRY ? "（--dry 只预览）" : ""));

for (const sha of ahead) {
  const msg = git("log", "-1", "--format=%B", sha).trim();
  const changed = git("show", "--name-status", "--format=", sha).split(/\r?\n/).filter(Boolean)
    .map(l => { const [st, ...rest] = l.split(/\t/); return { st: st[0], path: rest.join("\t") }; });
  if (DRY) { console.log("  [dry] " + sha.slice(0, 8) + "  " + changed.length + " 文件  " + msg.split("\n")[0].slice(0, 50)); continue; }
  const pc = await api("/git/commits/" + parent);
  const tree = [];
  for (const c of changed) {
    if (c.st === "D") { tree.push({ path: c.path, mode: "100644", type: "blob", sha: null }); continue; }
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
