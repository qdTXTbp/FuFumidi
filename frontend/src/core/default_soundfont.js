// ============================================================
// P0-5 默认 GM 音色懒加载 —— 纯决策逻辑（副作用在 audio.js / 音色工坊）
// ============================================================
// 背景：桌面端默认走内置 Web Audio 合成器（音色一般），而随包分发的
// renderer/vendor/soundfonts/GeneralUser.sf2（29.8MB）一直没被默认用起来。
// 这里只回答两个问题（便于单测）：
//   1. 音色列表里哪个是「默认 GM」；
//   2. 当前该不该懒加载它（用户显式选过音色 / 明确关掉就不再抢）。
export const DEFAULT_GM_KEY = 'fufumidi_default_gm';

/** 从 soundfonts.list() 的结果里挑默认 GM：优先 GeneralUser，其次名字像 GM 的 */
export function pickDefaultSoundfont(list) {
  const arr = Array.isArray(list) ? list : [];
  const cands = arr.filter((it) => it && typeof it.path === "string" && /\.sf2$/i.test(it.path));
  const find = (re) => cands.find((it) => re.test(String(it.id || "")) || re.test(String(it.name || "")));
  return find(/generaluser/i) || find(/general[\s_-]*midi/i) || find(/^gm\b/i) || null;
}

/**
 * 是否应该懒加载默认 GM。
 * @param {{explicitSource?: string|null, defaultGmFlag?: string}} o
 *   explicitSource：localStorage 的 fufumidi_soundfont（用户显式选过音色 → 尊重）
 *   defaultGmFlag：localStorage 的 fufumidi_default_gm（"0" = 用户关掉了）
 */
export function shouldLazyLoadDefaultGm(o = {}) {
  const flag = o.defaultGmFlag;
  if (flag === "0" || flag === 0 || flag === false) return false;
  const explicit = o.explicitSource;
  if (explicit && explicit !== "internal") return false;
  return true;
}

/** 把设置里的 default_gm（默认开）转成 localStorage 标记 */
export function defaultGmFlagOf(settingValue) {
  return settingValue === false ? "0" : "1";
}