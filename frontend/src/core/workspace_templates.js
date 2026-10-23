// ============================================================
// P1-12 工作区模板（钢琴改编 / 乐队编曲 / 短视频 BGM）
// ============================================================
// 模板只描述**编辑器偏好**（吸附 / 视图 / 颜色 / CC 泳道等），不写死任何工程数据；
// applyTemplate() 返回一个 patch，由调用方合进现有偏好（没提到的键保持原值）。
// 这样模板不会偷偷改用户的曲目，也便于以后在设置里新增模板。
import { SNAP_OPTIONS } from './ui_contract.js';

export const WORKSPACE_TEMPLATES = [
  {
    id: 'piano',
    label: '钢琴改编',
    desc: '按拍吸附、音高着色、关闭 CC —— 对着谱面改音符最顺手',
    prefs: { snapRatio: 0.25, viewMode: 'piano', colorMode: 'pitch', ccEnabled: false },
  },
  {
    id: 'band',
    label: '乐队编曲',
    desc: '半拍吸附、按轨着色、打开 CC 泳道 —— 多轨编配与表情调整',
    prefs: { snapRatio: 0.125, viewMode: 'piano', colorMode: 'track', ccEnabled: true },
  },
  {
    id: 'shortvideo',
    label: '短视频 BGM',
    desc: '十六分吸附、时间线优先、打开力度/CC —— 卡点剪辑与快速出片',
    prefs: { snapRatio: 0.0625, viewMode: 'piano', colorMode: 'velocity', ccEnabled: true },
  },
];

const SNAP_VALUES = SNAP_OPTIONS.map((x) => Number(x[0]));
function normalizeSnap(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0.0625;
  // 夹到最近一档，避免模板给出不在吸附下拉里的值（UI 会显示空的 select）
  let best = SNAP_VALUES[0], bestDiff = Infinity;
  for (const s of SNAP_VALUES) {
    const d = Math.abs(s - n);
    if (d < bestDiff) { bestDiff = d; best = s; }
  }
  return best;
}

/** 列模板（返回副本，调用方随便改） */
export function listTemplates() { return WORKSPACE_TEMPLATES.map((t) => ({ ...t, prefs: { ...t.prefs } })); }

/** 取模板；未知 id 返回 null */
export function getTemplate(id) {
  const t = WORKSPACE_TEMPLATES.find((x) => x.id === id);
  return t ? { ...t, prefs: { ...t.prefs } } : null;
}

/** 清洗模板偏好：吸附夹到合法档位，颜色/视图非法值丢弃 */
export function normalizeTemplatePrefs(prefs) {
  const p = prefs && typeof prefs === 'object' ? prefs : {};
  const out = {};
  if (p.snapRatio != null) out.snapRatio = normalizeSnap(p.snapRatio);
  if (p.viewMode === 'piano' || p.viewMode === 'score' || p.viewMode === 'drum') out.viewMode = p.viewMode;
  if (typeof p.colorMode === 'string' && p.colorMode) out.colorMode = p.colorMode;
  if (p.ccEnabled != null) out.ccEnabled = !!p.ccEnabled;
  return out;
}

/**
 * 把模板应用到当前偏好：只覆盖模板里存在的键。
 * @returns {{prefs:object, changed:string[]}}
 */
export function applyTemplate(current, id) {
  const tpl = getTemplate(id);
  if (!tpl) return { prefs: { ...(current || {}) }, changed: [] };
  const patch = normalizeTemplatePrefs(tpl.prefs);
  const next = { ...(current || {}), ...patch };
  const changed = Object.keys(patch).filter((k) => current == null || current[k] !== patch[k]);
  return { prefs: next, changed };
}

/** 当前偏好匹配哪个模板（UI 可高亮）；没有完全匹配返回 '' */
export function matchTemplate(current) {
  if (!current) return '';
  for (const t of WORKSPACE_TEMPLATES) {
    const patch = normalizeTemplatePrefs(t.prefs);
    if (Object.keys(patch).every((k) => current[k] === patch[k])) return t.id;
  }
  return '';
}
