// ============================================================
// P1-12 控件契约（跨视图同一语义 → 同一快捷键 / 同一行为）
// ============================================================
// 只做"声明 + 校验"，不碰 DOM：视图把自己的控件按下表登记，脚本/测试校验
//  · 同一快捷键不能绑两个不同语义（冲突）
//  · 同一语义在不同视图不能给不同快捷键（行为漂移）
//  · 已声明的语义不能没有实现（漏检）
import { normalizeCombo } from './commands.js';

/** 吸附档位（拍的比例）——模板与编辑器共用，避免两处各写一份 */
export const SNAP_OPTIONS = [
  [0, '关'],
  [0.0625, '1/16'],
  [0.125, '1/8'],
  [0.25, '1/4'],
  [0.5, '1/2'],
  [1, '1 拍'],
  [2, '2 拍'],
];

/**
 * 控件语义表：id 用 area.action 形式；keys 是**规范键位**（所有视图必须一致）。
 * required=true 表示编辑器类视图必须实现；views 说明该控件出现在哪些视图。
 */
export const CONTROL_SPECS = [
  { id: 'transport.play', label: '播放/暂停', keys: ['Space'], area: 'transport', views: ['edit', 'sing', 'home', 'play'], required: true },
  { id: 'transport.stop', label: '停止', keys: [''], area: 'transport', views: ['edit', 'sing', 'play'], required: false },
  { id: 'transport.record', label: '录音', keys: [''], area: 'transport', views: ['edit'], required: false },
  { id: 'transport.loop', label: '循环', keys: ['L'], area: 'transport', views: ['edit', 'sing', 'play'], required: false },
  { id: 'transport.metronome', label: '节拍器', keys: [''], area: 'transport', views: ['edit', 'sing'], required: false },
  { id: 'edit.undo', label: '撤销', keys: ['Mod+Z'], area: 'edit', views: ['edit', 'sing'], required: true },
  { id: 'edit.redo', label: '重做', keys: ['Mod+Shift+Z', 'Ctrl+Y'], area: 'edit', views: ['edit', 'sing'], required: true },
  { id: 'edit.save', label: '保存', keys: ['Mod+S'], area: 'file', views: ['edit', 'sing'], required: true },
  { id: 'file.open', label: '打开', keys: ['Mod+O'], area: 'file', views: ['edit', 'home'], required: false },
  { id: 'edit.export', label: '导出', keys: [''], area: 'file', views: ['edit', 'sing', 'convert'], required: false },
  { id: 'edit.quantize', label: '量化', keys: ['Q'], area: 'edit', views: ['edit', 'sing'], required: false },
  { id: 'edit.split', label: '切开音符', keys: ['S'], area: 'edit', views: ['edit', 'sing'], required: false },
  { id: 'edit.delete', label: '删除', keys: ['Delete'], area: 'edit', views: ['edit', 'sing', 'arrange'], required: true },
  { id: 'edit.duplicate', label: '复制（重复）', keys: ['Mod+D'], area: 'edit', views: ['edit', 'sing'], required: false },
  { id: 'view.zoomIn', label: '放大', keys: ['Mod+='], area: 'view', views: ['edit', 'sing', 'arrange'], required: false },
  { id: 'view.zoomOut', label: '缩小', keys: ['Mod+-'], area: 'view', views: ['edit', 'sing', 'arrange'], required: false },
  { id: 'edit.selectAll', label: '全选', keys: ['Mod+A'], area: 'edit', views: ['edit', 'sing', 'arrange'], required: false },
];

/** @param {string} id @returns {object|null} */
export function specOf(id) { return CONTROL_SPECS.find((s) => s.id === id) || null; }

/** 某语义的规范键位（规范化后的数组；空键位已剔除） */
export function keysOf(id) {
  const s = specOf(id);
  if (!s) return [];
  return (s.keys || []).map((k) => normalizeCombo(k)).filter(Boolean);
}

/**
 * 校验一组视图登记：entries = [{view, id, keys:[...], style?}]
 * @returns {{ok:boolean, problems:Array<{kind:string, detail:string}>}}
 */
export function validateControlContract(entries) {
  const problems = [];
  const list = (Array.isArray(entries) ? entries : []).filter(Boolean);
  /** id → 已登记的 view（同一语义在不同视图各登记一次是正常的；同视图登记两次才是重复） */
  const seenIds = new Map();
  /** @type {Map<string, {id:string, view:string}>} */
  const keyOwners = new Map();
  for (const e of list) {
    const spec = specOf(e.id);
    if (!spec) { problems.push({ kind: 'unknown', detail: '未声明的控件语义：' + e.id }); continue; }
    const viewKey = e.view || '';
    if (seenIds.has(e.id) && seenIds.get(e.id) === viewKey) {
      problems.push({ kind: 'duplicate', detail: '同一语义在同一视图被登记多次：' + e.id }); continue;
    }
    seenIds.set(e.id, viewKey);
    const keys = (e.keys || []).map((k) => normalizeCombo(k)).filter(Boolean);
    const canon = keysOf(e.id);
    // 行为漂移：登记的键位与规范键位集合不一致
    if (canon.length !== keys.length || keys.some((k) => !canon.includes(k))) {
      problems.push({ kind: 'deviation', detail: e.id + ' 键位与规范不一致：[' + keys.join(', ') + '] ≠ [' + canon.join(', ') + ']' });
    }
    for (const k of keys) {
      const owner = keyOwners.get(k);
      if (owner && owner.id !== e.id) {
        problems.push({ kind: 'conflict', detail: '快捷键 ' + k + ' 同时绑给 ' + owner.id + ' 与 ' + e.id });
      } else {
        keyOwners.set(k, { id: e.id, view: e.view || '' });
      }
    }
  }
  // 必需项缺失
  const required = CONTROL_SPECS.filter((s) => s.required).map((s) => s.id);
  for (const r of required) if (!seenIds.has(r)) problems.push({ kind: 'missing', detail: '缺少必需控件：' + r });
  return { ok: problems.length === 0, problems };
}

/** 规范登记（视图"全量实现"的理想状态），供测试/默认注册用 */
export function canonicalEntries(views) {
  const out = [];
  for (const spec of CONTROL_SPECS) {
    if (views && !spec.views.some((v) => views.includes(v))) continue;
    out.push({ view: (views || ['edit'])[0], id: spec.id, keys: (spec.keys || []).map((k) => normalizeCombo(k)).filter(Boolean) });
  }
  return out;
}
