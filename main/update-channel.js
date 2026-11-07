'use strict';
// ============================================================
// 更新通道判定（纯函数，主进程与测试共用）
// ============================================================
// ★ 2026-11-07 事故：正式通道用户收到了测试版更新，且更新失败。
//   根因不是"取最大"本身，而是**取最大之前没有按通道过滤候选**：
//   resolveRelease('stable') 会把 CNB 与 GitHub 两个源的版本一起比较，
//   只要某个源的 releases/latest 被测试版短暂顶替（发布侧误用 latest 锚点、
//   或第三方镜像缓存了 prerelease），6.5.0-beta.1 > 6.4.5 就会胜出，
//   然后被标成 channel:'stable' —— 更新器拿正式锚点的包去装测试版，
//   找不到 metadata-<ver>.json / 验签不过，更新必然失败。
//
//   所以这里的规则是硬约束：**正式通道只接受正式版**，不是"比较后取最大"。
//   版本号再高，只要带预发布后缀或 prerelease 标记，就不允许进入 stable 候选集。

/** 预发布版本：tag 带 -alpha/-beta/-rc/-dev/-preview/-nightly 等后缀，或 release.prerelease=true。
 *  注意不能只认 beta|rc：线上实际出现过 v6.5.0-alpha.3 / -beta.1，漏掉 alpha 就会串味。 */
const PRERELEASE_TAG_RE = /^v?\d+\.\d+\.\d+-(?:alpha|beta|rc|dev|preview|nightly|a|b)[.\-\d]*$/i;
const STABLE_TAG_RE = /^v?\d+\.\d+\.\d+$/i;

function normChannel(v) {
  return String(v || '').toLowerCase() === 'beta' ? 'beta' : 'stable';
}

function isPrereleaseTag(tag) {
  const s = String(tag || '').trim();
  if (PRERELEASE_TAG_RE.test(s)) return true;
  // 兜底：任何带 '-' 后缀的版本号都按预发布处理（宁可漏报，不可错发给正式用户）
  const base = s.replace(/^v/i, '');
  return /^\d+\.\d+\.\d+-/.test(base) && !STABLE_TAG_RE.test(s);
}

function isStableTag(tag) {
  return STABLE_TAG_RE.test(String(tag || '').trim()) && !isPrereleaseTag(tag);
}

/** 一个 release 是否属于测试通道（只看自身，不看用户选了什么） */
function isBetaRelease(rel) {
  if (!rel) return false;
  if (rel.prerelease === true) return true;
  return isPrereleaseTag(rel.tag_name);
}

/** 该 release 是否允许出现在用户所选通道的候选集里。
 *  stable：必须是正式版（且 tag 合法）；beta：正式版与测试版都允许
 *  （测试通道下若当时没有测试版，会回退到正式版，但那时必须用正式锚点更新）。 */
function allowsRelease(channel, rel) {
  if (!rel || !rel.tag_name) return false;
  if (normChannel(channel) === 'stable') return !isBetaRelease(rel);
  return true;
}

/** 这个 release 实际来自哪个通道 —— 下载源 / 验签清单 / 更新器 --source 都必须用它。
 *  ★ 绝不能用「用户选了什么」去覆盖：测试通道回退到正式版时，若仍按 beta 下载，
 *    就会拿 beta 锚点的包去装正式版（或反过来），更新必然失败。 */
function channelOfRelease(rel) {
  return isBetaRelease(rel) ? 'beta' : 'stable';
}

module.exports = {
  normChannel,
  isPrereleaseTag,
  isStableTag,
  isBetaRelease,
  allowsRelease,
  channelOfRelease,
};
