// ============================================================
// 下载源偏好：国内（CNB）/ 全球（GitHub）
//
// 用途：让更新检查、增量更新、以及后续的模型 / 音色 / 壁纸等资产下载，
// 都能按用户选择的下载源走对应线路，并在该线路不可用时优雅回退。
//
// 取值：
//   'auto'   —— 默认。优先国内 CNB，不可用自动回退 GitHub（镜像 → 官方）
//   'cnb'    —— 国内优先（CNB）。CNB 不可用时回退 GitHub，保证更新不中断
//   'github' —— 全球优先（GitHub 官方直连），失败时回退国内镜像
// ============================================================
'use strict';

// ── CNB 镜像仓库（FuFumidi 的 Releases 镜像，公开可下载，无需认证） ──
const CNB_REPO_PATH = 'FuFuCloud-mirror/FuFuMIDI';
const CNB_WEB = 'https://cnb.cool/' + CNB_REPO_PATH + '/';
const CNB_RELEASES = CNB_WEB + '-/releases/';

// ── GitHub 上游仓库 ──
const GH_REPO = 'qdTXTbp/FuFumidi';
const GH_WEB = 'https://github.com/' + GH_REPO + '/';
const GH_API = 'https://api.github.com/repos/' + GH_REPO + '/';
const UA = 'FuFumidi';

// GitHub 加速镜像（顺序即国内偏好顺序）
const GH_MIRRORS = [
  { id: 'ghfast', prefix: 'https://ghfast.top/' },
  { id: 'ghproxy', prefix: 'https://gh-proxy.com/' },
  { id: 'ghproxy-net', prefix: 'https://ghproxy.net/' },
];

const SOURCES = ['auto', 'cnb', 'github'];
const SOURCE_LABELS = { auto: '自动（优先国内）', cnb: '国内 · CNB', github: '全球 · GitHub' };

function normSource(v) {
  const s = String(v || '').toLowerCase();
  return SOURCES.includes(s) ? s : 'auto';
}

/** 从设置对象解析下载源偏好 */
function sourceOf(settings) {
  try { return normSource(settings && settings.download_source); } catch (e) { return 'auto'; }
}

/** 该偏好下是否优先走国内 CNB */
function preferCnb(source) {
  const s = normSource(source);
  return s === 'auto' || s === 'cnb';
}

// ── CNB 下载地址 ──
/** 最新版资产：uploads/latest 锚点，固定地址（对应 GitHub 的 releases/latest/download） */
function cnbLatestUrl(file) { return CNB_RELEASES + 'latest/download/' + file; }
/** 指定 tag 资产（测试通道用固定 tag `beta`） */
function cnbTagUrl(tag, file) { return CNB_RELEASES + 'download/' + encodeURIComponent(tag) + '/' + file; }
/** 最新版 latest.yml（electron-builder 产物，含 version 字段，可用于免认证查版本） */
function cnbVersionUrl() { return cnbLatestUrl('latest.yml'); }

/** 把 GitHub raw/资产地址套上镜像前缀，得到候选下载地址（不改动非 GitHub 地址） */
function githubMirrorCandidates(url) {
  if (!/^https:\/\/github\.com\//i.test(String(url || ''))) return [url];
  return [...GH_MIRRORS.map((m) => m.prefix + url), url];
}

module.exports = {
  SOURCES,
  SOURCE_LABELS,
  normSource,
  sourceOf,
  preferCnb,
  // 仓库/地址常量
  CNB_REPO_PATH,
  CNB_WEB,
  CNB_RELEASES,
  GH_REPO,
  GH_WEB,
  GH_API,
  UA,
  GH_MIRRORS,
  // 地址构造
  cnbLatestUrl,
  cnbTagUrl,
  cnbVersionUrl,
  githubMirrorCandidates,
};
