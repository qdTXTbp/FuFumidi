#!/usr/bin/env node
// 从 main/soundfonts.js 的 REGISTRY 字面量 + 同文件的镜像常量生成 Tauri 侧静态注册表（不启动窗口）。
//
// 2026-11-06（S6）：以前的版本用 _releaseBase = "https://example.invalid" 和空的 CNB 集合去求值，
// 于是**所有 url 都丢了**（脚本只导出 id/name/size 之类的展示字段），Tauri 侧的
// sf_workshop_download 根本没有可用的下载地址。现在把 main/soundfonts.js 里的
//   _ghHosts / _releaseBase / CNB_SF_FILES / CNB_SF_RELEASE_FILES
// 原样切出来一起求值，并复用 main/download-source.js 的 CNB 地址构造与排序，
// 输出 Rust 侧真正要用的 urls / fromRepo 字段（顺序 = 国内优先 CNB 打头）。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const require = createRequire(import.meta.url);
const DS = require(path.join(ROOT, "main/download-source.js"));

const src = fs.readFileSync(path.join(ROOT, "main/soundfonts.js"), "utf8");

/** 从源码里切出一个声明（含结尾分号），找不到就抛错（不能悄悄退化成假地址）。 */
function sliceDecl(name, openMarker, closeMarker) {
  const start = src.indexOf(openMarker);
  if (start < 0) throw new Error("main/soundfonts.js 里找不到 " + name);
  const end = src.indexOf(closeMarker, start);
  if (end < 0) throw new Error("main/soundfonts.js 里 " + name + " 没有闭合");
  return src.slice(start, end + closeMarker.length);
}

const hostsDecl = sliceDecl("_ghHosts", "const _ghHosts = [", "];");
const releaseDecl = sliceDecl("_releaseBase", "const _releaseBase =", ";");
const cnbFilesDecl = sliceDecl("CNB_SF_FILES", "const CNB_SF_FILES = new Set([", "]);");
const cnbReleaseDecl = sliceDecl("CNB_SF_RELEASE_FILES", "const CNB_SF_RELEASE_FILES = new Set([", "]);");

const regStart = src.indexOf("const REGISTRY = [");
const regEnd = src.indexOf("\n  ];", regStart);
if (regStart < 0 || regEnd < 0) throw new Error("REGISTRY literal not found");
const registryDecl = "const REGISTRY = " + src.slice(regStart + "const REGISTRY = ".length, regEnd + 4);

const prelude = [hostsDecl, releaseDecl, cnbFilesDecl, cnbReleaseDecl].join("\n");
const ctx = new Function(prelude + "\n" + registryDecl + "\nreturn { REGISTRY: REGISTRY, _ghHosts: _ghHosts, CNB_SF_FILES: CNB_SF_FILES, CNB_SF_RELEASE_FILES: CNB_SF_RELEASE_FILES };")();
const REGISTRY = ctx.REGISTRY;
const ghHosts = ctx._ghHosts;
const CNB_RAW_FILES = ctx.CNB_SF_FILES;
const CNB_RELEASE_FILES = ctx.CNB_SF_RELEASE_FILES;

// 与 main/soundfonts.js 的 SF2_LOAD_LIMIT 一致：超过它的条目在渲染层读不进来。
const SF2_LOAD_LIMIT = 512 * 1024 * 1024;

function decodeBase(url) {
  const seg = String(url || "").split("?")[0].split("/").pop() || "";
  try { return decodeURIComponent(seg); } catch (e) { return seg; }
}

function cnbFor(item) {
  for (const u of item.urls || []) {
    const base = decodeBase(u);
    if (!base) continue;
    if (CNB_RELEASE_FILES.has(base)) {
      return DS.cnbRepoReleaseUrl(DS.CNB_MIRROR_REPOS.fufumidi, "soundfonts-v1", base);
    }
    if (CNB_RAW_FILES.has(base)) {
      return DS.cnbRepoRawUrl(DS.CNB_MIRROR_REPOS.soundfonts, "main", base);
    }
  }
  return null;
}

/** GitHub raw 候选 URL（fromRepo + repoFile 派生镜像路径）——与 Electron githubRawCandidates 一致。 */
function githubRawCandidates(item) {
  if (!item.fromRepo || !item.repoFile) return [];
  const enc = item.repoFile.split("/").map(function (x) { return encodeURIComponent(x); }).join("/");
  return ghHosts.map(function (h) { return h + "/" + item.fromRepo + "/main/" + enc; });
}

/** 汇总候选地址（与 Electron orderSfUrls 完全一致：CNB 补一条 + 按下载源偏好排序）。 */
function orderedUrls(item) {
  const list = githubRawCandidates(item).concat(item.urls || []).filter(Boolean);
  return DS.orderUrls(cnbFor(item), list);
}

const FIELDS = [
  "id", "name", "version", "desc", "size", "minSize", "maxSize", "fileName", "repoFile",
  "bundledPath", "license", "category", "manual", "officialUrl", "overLimit", "slow",
  "fileSize", "ext", "fromRepo", "urls",
];

let withUrls = 0;
const out = REGISTRY.map(function (it) {
  const o = {};
  for (const f of FIELDS) if (it[f] !== undefined) o[f] = it[f];
  o.fromRepo = it.fromRepo === undefined ? null : it.fromRepo;
  const urls = orderedUrls(it);
  o.urls = urls;
  if (it.manual) {
    if (!o.officialUrl) throw new Error(it.id + ": manual 条目必须有 officialUrl");
  } else {
    if (!urls.length) throw new Error(it.id + ": 没有可用下载地址（fromRepo/repoFile/urls 全空）");
    withUrls += 1;
  }
  for (const u of urls) {
    if (!/^https:\/\//.test(u)) throw new Error(it.id + ": 非法地址 " + u);
    if (u.indexOf("example.invalid") >= 0) throw new Error(it.id + ": 仍是占位地址 " + u);
  }
  if (typeof it.size === "number" && it.size > SF2_LOAD_LIMIT) o.overLimit = true;
  return o;
});

const target = path.join(ROOT, "shells/tauri/src/soundfont_registry.json");
fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n", "utf8");
const totalUrls = out.reduce(function (s, x) { return s + (x.urls ? x.urls.length : 0); }, 0);
console.log("[sf-registry] entries=" + out.length + " downloadable=" + withUrls + " totalUrls=" + totalUrls);