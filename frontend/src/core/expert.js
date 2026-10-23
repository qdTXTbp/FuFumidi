// ============================================================
// P1-12 专家模式（novice / expert）：收敛 OMR / 翻唱 / GPU 等高级入口
// ============================================================
// 设置字段沿用已有的 advanced_mode（main/settings.js 默认 false），不自造新键：
// 老用户设置文件里没有这个键时按"普通模式"处理（与默认值一致）。
// ★ 本模块不 import stores（Node 测试要能直接跑）：views 由调用方显式传入。

export const EXPERT_FEATURES = {
  omr: { label: '光学识谱（OMR）', hint: '识别图片 / PDF 谱面并转成 MIDI' },
  cover: { label: '翻唱工作流', hint: '分离 → 扒谱 → 合成 → 混音' },
  gpu: { label: 'GPU 推理加速', hint: '下载 CUDA 增强包，显著加快转录' },
};

/** 当前是否专家模式（设置对象来自 settings store） */
export function isExpertMode(settings) { return !!(settings && settings.advanced_mode); }

/** 某高级功能是否该显示；未知功能不算高级，保持可见 */
export function featureVisible(feature, settings) {
  if (!(feature in EXPERT_FEATURES)) return true;
  return isExpertMode(settings);
}

/** 过滤导航视图：带 expert 标记的视图只在专家模式显示 */
export function visibleViews(views, settings) {
  const list = Array.isArray(views) ? views : [];
  return list.filter((v) => !v || !v.expert || isExpertMode(settings));
}
