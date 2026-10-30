// ============================================================
// P1-14 B4 设置可搜索：设置项索引 + 模糊搜索（纯逻辑）
// ============================================================
// 为什么单独建索引而不是扫描 DOM 文本：
//   · 设置项分散在 7 个页签、部分文案是 i18n 键，DOM 文本随语言变化；
//   · 索引可以带"别名"（用户口头说法：字号/字大/缩放/显卡/更新慢…），搜索命中率更高；
//   · 纯函数便于测试，UI 只负责渲染结果并在点击后滚动到 data-setting 锚点。

/**
 * @typedef {{id:string, tab:string, label:string, hint?:string, aliases?:string[]}} SettingEntry
 */
export const SETTINGS_INDEX = [







  { id: 'engine_mode', tab: 'feature', label: '默认引擎模式', hint: '转录新音频时默认使用的识别引擎', aliases: ['识别引擎', 'basic_pitch', 'piano', 'demucs', '模型'] },
  { id: 'perf_mode', tab: 'feature', label: '默认性能模式', hint: '最高质量 / 均衡 / 低配省资源', aliases: ['性能', 'CPU', '省资源', 'perf'] },
  { id: 'output_dir', tab: 'feature', label: '默认输出目录', hint: '转录结果的保存位置', aliases: ['保存目录', '导出目录', 'output', '路径'] },
  { id: 'expert_mode', tab: 'feature', label: '专家模式', hint: '显示 OMR / 翻唱 / GPU 等高级入口', aliases: ['高级', 'advanced', 'OMR', '翻唱', 'GPU'] },
  { id: 'ai_mode', tab: 'feature', label: 'AI 生成（可选）', hint: '本地生成命令；产物带 AI 标注（默认关）', aliases: ['ai', '生成', '人工智能', 'ace-step', '本地模型'] },
  { id: 'vst3_mode', tab: 'feature', label: 'VST3 离线渲染（可选）', hint: '自备 pedalboard 宿主与 .vst3 插件；不随包分发', aliases: ['vst', 'vst3', '插件', 'pedalboard', '插件宿主'] },
  { id: 'file_assoc', tab: 'feature', label: '文件关联', hint: '双击 .mid 时用本应用打开', aliases: ['关联', '默认打开', 'midi'] },
  { id: 'watch_dir', tab: 'feature', label: '监视文件夹', hint: '新文件自动导入曲库', aliases: ['自动导入', '监视', 'watch'] },
  { id: 'hotkeys', tab: 'keys', label: '快捷键', hint: '全局快捷键绑定与录制', aliases: ['热键', 'shortcut', 'keybind', '按键'] },
  { id: 'update_channel', tab: 'update', label: '更新通道', hint: '稳定版 / 内测版', aliases: ['更新', '内测', 'beta', 'channel'] },
  { id: 'update_check', tab: 'update', label: '检查更新', hint: '立即检查并下载新版本', aliases: ['升级', '新版本', 'update'] },
  { id: 'download_source', tab: 'update', label: '下载源', hint: '自动 / 国内 / 全球', aliases: ['下载速度', '镜像', 'cnb', 'github'] },
  { id: 'gpu_install', tab: 'gpu', label: 'GPU 加速', hint: '下载 CUDA 增强包并启用推理加速', aliases: ['显卡', 'cuda', '加速', 'gpu'] },
  { id: 'cloud_account', tab: 'cloud', label: '云同步', hint: '账号登录 / 同步歌曲与设置', aliases: ['同步', '云', '账号', 'cloud'] },
  { id: 'feedback', tab: 'feedback', label: '反馈', hint: '报告问题 / 提出建议', aliases: ['问题', '建议', 'bug', 'feedback'] },
];

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 搜索设置项。
 * 排序：精确 > 前缀 > 包含；label 命中权重高于 hint/aliases；同分按索引顺序。
 * @param {string} query
 * @param {number} limit
 * @returns {SettingEntry[]}
 */
export function searchSettings(query, limit = 12) {
  const q = norm(query);
  if (!q) return [];
  const lim = Math.max(1, Math.min(50, Number(limit) || 12));
  const out = [];
  SETTINGS_INDEX.forEach((e, i) => {
    const label = norm(e.label);
    const hint = norm(e.hint);
    const aliases = (e.aliases || []).map(norm);
    let score = 0;
    if (label === q) score = 100;
    else if (label.startsWith(q)) score = 80;
    else if (label.includes(q)) score = 60;
    else if (aliases.some((a) => a === q)) score = 55;
    else if (aliases.some((a) => a.startsWith(q))) score = 40;
    else if (aliases.some((a) => a.includes(q))) score = 30;
    else if (hint.includes(q)) score = 20;
    if (score > 0) out.push({ entry: e, score, order: i });
  });
  out.sort((a, b) => b.score - a.score || a.order - b.order);
  return out.slice(0, lim).map((x) => x.entry);
}

/** 命中项所在页签（去重，供结果分组显示） */
export function tabsOfHits(hits) {
  const seen = new Set();
  const out = [];
  for (const h of hits || []) {
    if (seen.has(h.tab)) continue;
    seen.add(h.tab);
    out.push(h.tab);
  }
  return out;
}

/** 校验索引：id 唯一、tab 合法 */
export function validateSettingsIndex(tabs) {
  const problems = [];
  const ids = new Set();
  const allowed = new Set(Array.isArray(tabs) && tabs.length ? tabs : ['appearance', 'gpu', 'feature', 'keys', 'cloud', 'update', 'feedback']);
  for (const e of SETTINGS_INDEX) {
    if (!e || !e.id) problems.push({ kind: 'invalid', detail: '设置项缺 id' });
    else if (ids.has(e.id)) problems.push({ kind: 'duplicate', detail: '设置项 id 重复：' + e.id });
    else ids.add(e.id);
    if (!allowed.has(e.tab)) problems.push({ kind: 'tab', detail: e.id + ' 指向未知页签：' + e.tab });
    if (!e.label) problems.push({ kind: 'label', detail: e.id + ' 缺 label' });
  }
  return { ok: problems.length === 0, problems };
}
