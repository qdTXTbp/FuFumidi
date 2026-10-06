// Pinia：编辑**工作区布局** —— 「编辑」页与「调教」页共用同一套。
//
// ★ 为什么要有这个 store：检查器开关/宽度、卷帘高度、视图模式以前散在 7 份各写各的
//   localStorage 键里（fufumidi_edit_insp / _insp_w / fufumidi_roll_h / fufumidi_edit.view …），
//   于是「一键切到调教布局 / 校对布局」根本无从下手，用户每次都要手动拖面板。
//   现在收进一个对象 + 四套预设，并且**沿用原来的键名**（老用户的设置不会丢）。
import { reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';

export type PresetId = 'arrange' | 'sing' | 'proof' | 'mix';
export type ViewMode = 'piano' | 'drum' | 'score';
export type Density = 'compact' | 'normal' | 'roomy';

export interface Layout {
  inspOpen: boolean;
  inspW: number;          // 0 = 用 CSS 默认宽度
  rollH: number;          // 卷帘区最小高度（px）
  viewMode: ViewMode;
  density: Density;
  scale: number;          // 全局 UI 缩放 0.9 ~ 1.3（M9b）
}

export const LAYOUT_PRESETS: { id: PresetId; label: string; hint: string; layout: Layout }[] = [
  { id: 'arrange', label: '编曲', hint: '卷帘最大、检查器收起', layout: { inspOpen: false, inspW: 0, rollH: 420, viewMode: 'piano', density: 'normal' } },
  { id: 'sing', label: '调教', hint: '检查器常开、卷帘偏高', layout: { inspOpen: true, inspW: 320, rollH: 420, viewMode: 'piano', density: 'normal' } },
  { id: 'proof', label: '校对', hint: '乐谱视图 + 检查器（识谱校对用）', layout: { inspOpen: true, inspW: 300, rollH: 320, viewMode: 'score', density: 'normal' } },
  { id: 'mix', label: '混音', hint: '卷帘压扁、给混音台让位', layout: { inspOpen: true, inspW: 280, rollH: 240, viewMode: 'piano', density: 'compact' } },
];

const KEY = 'fufumidi.workspace';
const KEY_PRESET = 'fufumidi.workspace.preset';
const BASE: Layout = { inspOpen: true, inspW: 0, rollH: 380, viewMode: 'piano', density: 'normal', scale: 1 };
/** UI 缩放可用档位（M9b）。界面全是 px 布局，所以用 CSS zoom 整体缩放最省事也最一致。 */
export const SCALES = [0.9, 1, 1.15, 1.3];

function num(v: any, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function readLayout(): Layout {
  const out: Layout = { ...BASE };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const j = JSON.parse(raw);
      Object.assign(out, {
        inspOpen: j.inspOpen !== false,
        inspW: num(j.inspW, out.inspW),
        rollH: num(j.rollH, out.rollH),
        viewMode: (['piano', 'drum', 'score'].includes(j.viewMode) ? j.viewMode : out.viewMode) as ViewMode,
        density: (['compact', 'normal', 'roomy'].includes(j.density) ? j.density : out.density) as Density,
        scale: Math.max(0.9, Math.min(1.3, num(j.scale, out.scale))),
      });
      return out;
    }
    // 迁移旧键（老用户第一次打开新版本时走这里）
    out.inspOpen = localStorage.getItem('fufumidi_edit_insp') !== '0';
    out.inspW = num(localStorage.getItem('fufumidi_edit_insp_w'), out.inspW);
    out.rollH = num(localStorage.getItem('fufumidi_roll_h'), out.rollH);
  } catch (e) { /* 读不到就用默认 */ }
  return out;
}

export const useWorkspace = defineStore('workspace', () => {
  const layout = reactive<Layout>(readLayout());
  let preset = ref<PresetId>('arrange');
  try {
    const p = localStorage.getItem(KEY_PRESET);
    if (p && LAYOUT_PRESETS.some((x) => x.id === p)) preset.value = p as PresetId;
  } catch (e) {}

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(layout)); } catch (e) {}
  }
  function applyPreset(id: PresetId) {
    const p = LAYOUT_PRESETS.find((x) => x.id === id);
    if (!p) return;
    Object.assign(layout, p.layout);
    preset.value = id;
    try { localStorage.setItem(KEY_PRESET, id); } catch (e) {}
    save();
  }
  function toggleInspector(on?: boolean) {
    layout.inspOpen = typeof on === 'boolean' ? on : !layout.inspOpen;
  }
  watch(layout, save, { deep: true });
  return { layout, preset, presets: LAYOUT_PRESETS, applyPreset, toggleInspector, save };
});
