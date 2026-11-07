// ============================================================
// 模型候选下载源：自有仓库的「国内 CNB / 国外 GitHub」双端
//
// 为什么单独成模块：候选源怎么排是**能出错又不能靠肉眼验**的逻辑
// （2026-11-07 之前 beat_this 只声明了 GitHub raw，国内直连整条不可用；
//  而 mirrors 又被无条件排到最前，用户把下载源选成「全球」也不生效）。
// 拆出来后 scripts/test-model-sources.mjs 能直接断言排序，不必起 Electron。
//
// 约定：
//   spec.url     —— 主源（自有 GitHub 仓库的 raw / Release 资产）
//   spec.mirrors —— 额外候选；其中 cnb.cool 的算「国内」，其余算「国外」
// 最终顺序交给 download-source.js 的 orderUrls 按用户设置（自动/国内/全球）排。
// ============================================================
'use strict';

const DS = require('./download-source');

const MODELS_CNB_REPO = DS.CNB_MIRROR_REPOS.models;

// GitHub 侧加速前缀。顺序按本机实测可用性排（gh.jasonzeng 与分卷下载同一入口）。
// ★ 它们只加速 GitHub，不代理上传；raw 直连在国内多为 0 吞吐，必须留在最后。
const GH_MIRROR_PREFIXES = [
  'https://gh.jasonzeng.dev/',
  'https://ghfast.top/',
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
  'https://hub.gitmirror.com/',
  'https://raw.gitmirror.com/',
];

const GITHUB_RE = /^https:\/\/(raw\.githubusercontent\.com|github\.com)\//i;
const MODELS_GH_RAW_RE = /^https:\/\/raw\.githubusercontent\.com\/monologue82\/Models\/main\/(.+)$/i;
const CNB_RE = /^https:\/\/cnb\.cool\//i;

function isCnbUrl(u) { return CNB_RE.test(String(u || '')); }

/** 去空、去重（保序） */
function uniq(list) {
  const out = [];
  const seen = new Set();
  for (const u of list || []) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/**
 * 由注册表条目推导候选下载地址。
 * @param {object} spec  模型条目（url / mirrors）
 * @param {object} [opts] { source: 'auto'|'cnb'|'github' }
 * @returns {string[]} 按下载源偏好排好序的候选地址（至少 1 条，或 0 条表示条目没配地址）
 */
function mirrorUrls(spec, opts) {
  const o = opts || {};
  const source = DS.normSource(o.source === undefined ? 'auto' : o.source);
  const raw = String((spec && spec.url) || '');
  const extra = Array.isArray(spec && spec.mirrors) ? spec.mirrors.filter(Boolean) : [];
  const extraCnb = extra.filter(isCnbUrl);
  const extraGh = extra.filter((u) => !isCnbUrl(u));

  // 没有主源：只用 mirrors（旧条目兼容）
  if (!raw) return uniq(DS.orderUrls(extraCnb, extraGh, source));

  if (GITHUB_RE.test(raw)) {
    const gh = [raw, ...GH_MIRROR_PREFIXES.map((p) => p + raw)];
    // 自有 Models 仓库的 raw → 同一路径在 CNB 整树镜像上也有一份（字节相同）
    const m = raw.match(MODELS_GH_RAW_RE);
    const derivedCnb = m ? DS.cnbRepoRawUrl(MODELS_CNB_REPO, 'main', m[1]) : null;
    const cnb = derivedCnb ? [derivedCnb, ...extraCnb] : extraCnb;
    return uniq(DS.orderUrls(cnb, [...extraGh, ...gh], source));
  }

  // 非 GitHub 主源（第三方仓库 / 自有 CNB）：mirrors 里的国内/国外仍按偏好排
  return uniq(DS.orderUrls(extraCnb, [...extraGh, raw], source));
}

module.exports = { mirrorUrls, isCnbUrl, GH_MIRROR_PREFIXES, MODELS_CNB_REPO };
