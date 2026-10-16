// Pinia：音符瀑布的**背景设置** —— 「可视化」页与「导出视频」共用同一份。
//
// ★ 为什么要有这个 store：导出页以前自带一套「背景色 + 背景图片」（VE.bgColor / VE.bgImage），
//   跟可视化页的背景设置**毫无关系** —— 用户在瀑布流里挑的图片、透明档、模糊/暗化，
//   导出的成片一概不认，看到的和导出的是两幅画。现在两边读写同一个 store、同一个
//   localStorage 键、同一个绘制函数（core/viz.js 的 paintVizBg），任何一处改动两边立刻同步。
import { reactive, ref } from 'vue';
import { defineStore } from 'pinia';
import { t } from '../core/i18n.js';
import { useAppStore } from './app';
// ★ 视效开关的**单一来源**是 core/viz.js 的 FX_DEFAULTS —— store 只负责持久化与转交，
//   不在两边各写一份默认值（写两份必然漂移：viz.js 加了新档、store 的默认还停在旧形状）。
import { FX_DEFAULTS, FX_PARAMS, FX_COLORBY } from '../core/viz.js';
// ★ 重做后的"主题"是**视觉主题**（舞台/键面/音符材质/后处理），住在 core/viz/state/themes.js，
//   旧 viz.js 那套"主题=参数 diff"已退役 —— 那正是"换主题看不出区别"的原因。
import { THEMES } from '../core/viz/state/themes.js';

export const BG_KEY = 'fufumidi.viz.bg';
/* ★ 改默认值 / 改结构时把 BG_VER +1：老数据直接忽略，否则「新默认值」对老用户永远不生效
   （这次就把默认从「主题」改成「透明」，顺便清掉之前调试留下的图片档）。 */
export const BG_VER = 2;
export const BG_DEFAULTS = { v: BG_VER, mode: 'transparent', color: '#0b1020', blur: 12, dim: 0.35, path: '', fx: { ...FX_DEFAULTS } };   // ui-tokens-allow: color 是持久化的用户默认值，不是样式

/* 瀑布流视效开关（2026-10 升级）。顺序即界面顺序；每项都能单独关掉回到旧观感。 */
/* 用户自定义主题（D8：命名交给用户）—— 与内置主题分开存，卸载/升级不丢 */
export const FX_USER_KEY = 'fufumidi.viz.fxthemes';
export type FxUserThemes = Record<string, Record<string, unknown>>;

export const FX_ITEMS = [
  { k: 'keys3d', label: '3D 键盘', hint: '键面 + 厚度 + 按压下沉' },
  { k: 'particles', label: '粒子光效', hint: '击键火花 + 冲击波环' },
  { k: 'beams', label: '落键光柱', hint: '按键向上洒光' },
  { k: 'hitLine', label: '击键光带', hint: '整条击键线随击键亮起' },
  { k: 'gloss', label: '音符质感', hint: '落点光晕 + 白热内芯 + 边缘高光' },
  { k: 'keyNames', label: '键名标注', hint: '在每个白键上标音名（跟弹学习用）' },
  { k: 'grid', label: '网格线', hint: '键位竖线与小节线（想要干净画面、或导出叠加层时关掉）' },
];

export const BG_MODES = [
  { k: 'theme', label: '主题' },
  { k: 'solid', label: '纯色' },
  { k: 'image', label: '图片' },
  { k: 'transparent', label: '透明' },
];

function read() {
  try {
    const s = JSON.parse(localStorage.getItem(BG_KEY) || 'null');
    if (s && typeof s === 'object' && s.v === BG_VER) {
      // fx 要**逐键**合并：整体覆盖会把后来新增的档位丢成 undefined（viz.js 那边再补默认，
      // 于是界面显示"开"、实际却是默认值，用户改了不生效）
      return { ...BG_DEFAULTS, ...s, v: BG_VER, path: s.path || '', fx: { ...FX_DEFAULTS, ...(s.fx || {}) } };
    }
  } catch (e) { /* 存储坏了就用默认值 */ }
  return { ...BG_DEFAULTS };
}

/* ★ 只持久化**文件路径**，不存 blob: URL —— blob URL 是「本次会话」的，重启后必然失效。
   早先存了 blob URL，结果重启应用后档位还写着「图片」、画面却是主题底。 */
function mimeOf(p: string) {
  return /\.png$/i.test(p) ? 'image/png'
    : (/\.gif$/i.test(p) ? 'image/gif'
      : (/\.webp$/i.test(p) ? 'image/webp'
        : (/\.bmp$/i.test(p) ? 'image/bmp' : 'image/jpeg')));
}

function decode(src: string): Promise<HTMLImageElement | null> {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = src;
  });
}

export const useVizBgStore = defineStore('vizbg', () => {
  const app = useAppStore();
  const bg = reactive(read());
  // ★ 解码后的图片**不进响应式**：HTMLImageElement 被 Proxy 包住后 drawImage 会抛
  //   （Illegal invocation），所以它住在闭包里，只通过 imageEl()/drawOpts() 取。
  let image: HTMLImageElement | null = null;
  let objUrl = '';
  let loading: Promise<boolean> | null = null;

  function save() {
    try { localStorage.setItem(BG_KEY, JSON.stringify({ ...bg, v: BG_VER })); } catch (e) { /* 隐私模式忽略 */ }
  }
  /** 交给绘制函数的背景参数（含已解码的图片） */
  function drawOpts() {
    return { mode: bg.mode, color: bg.color, blur: bg.blur, dim: bg.dim, image };
  }
  function imageEl() { return image; }

  /* ---------------- 视效主题（D1/D8）----------------
   * 内置**视觉主题**在 core/viz/state/themes.js（单一来源）；用户主题在这里，名字由用户起。
 * 用户主题存的是 { viz: 视觉主题 id, fx: 参数 diff } —— 两样都要能存能还原。 */
  const userThemes = reactive<FxUserThemes>(readUserThemes());
  const VIZ_THEMES = Object.keys(THEMES).map((k) => ({ k, label: (THEMES as any)[k].name }));
  const themeName = ref<string>((bg as any).theme || 'studio');
  function vizTheme(): string { return (bg as any).theme || 'studio'; }
  /** 导出超采样倍率（1/1.5/2）—— 只在导出侧用；实时不需要 */
  const ssaa = ref<number>((bg as any).ssaa || 1);
  function setSsaa(v: number) {
    const n = Math.max(1, Math.min(2, Number(v) || 1));
    (bg as any).ssaa = n; ssaa.value = n; save();
  }
  function setVizTheme(id: string) {
    (bg as any).theme = id;
    themeName.value = id;
    save();
  }
  function readUserThemes(): FxUserThemes {
    try {
      const o = JSON.parse(localStorage.getItem(FX_USER_KEY) || '{}');
      return (o && typeof o === 'object') ? o : {};
    } catch (e) { return {}; }
  }
  function saveUserThemes() {
    try { localStorage.setItem(FX_USER_KEY, JSON.stringify(userThemes)); } catch (e) { /* 忽略 */ }
  }
  /** 主题清单：内置视觉主题 + 用户主题（带 user 标记，UI 据此分组/显示删除） */
  function themeList() {
    return VIZ_THEMES.map((t) => ({ k: t.k, label: t.label, user: false }))
      .concat(Object.keys(userThemes).map((k) => ({ k, label: k, user: true })));
  }
  /** 应用主题：内置主题只切视觉主题；用户主题同时还原视觉主题与参数 diff */
  function applyTheme(name: string) {
    const u = userThemes[name];
    if (u) {
      if (u.viz) (bg as any).theme = u.viz;
      (bg as any).fx = { ...FX_DEFAULTS, ...((bg as any).fx || {}), ...((u.fx as any) || {}) };
    } else if ((THEMES as any)[name]) {
      (bg as any).theme = name;
    }
    themeName.value = name;
    save();
  }
  /** 用当前参数存成自定义主题（命名由用户决定） */
  function saveTheme(name: string) {
    const n = String(name || '').trim();
    if (!n) return false;
    const cur = { ...((bg as any).fx || {}) };
    // 只存与默认值不同的部分：主题更小、也更清楚"这套主题改了什么"
    const diff: Record<string, unknown> = {};
    for (const k of Object.keys(FX_DEFAULTS)) {
      if (cur[k] !== (FX_DEFAULTS as any)[k]) diff[k] = cur[k];
    }
    userThemes[n] = { viz: (bg as any).theme || 'studio', fx: diff };
    saveUserThemes();
    (bg as any).theme = n;
    themeName.value = n;
    save();
    return true;
  }
  function deleteTheme(name: string) {
    if (!(name in userThemes)) return false;
    delete userThemes[name];
    saveUserThemes();
    if (themeName.value === name) applyTheme('studio');
    return true;
  }
  /** 改一个视效参数/开关（用户手改后主题名退成"自定义"，避免"主题"与实际值不符） */
  function setFxAny(k: string, v: unknown) {
    if (!(bg as any).fx) (bg as any).fx = { ...FX_DEFAULTS };
    (bg as any).fx[k] = v;
    (bg as any).theme = '自定义';
    themeName.value = '自定义';
    save();
  }
  /** 交给绘制函数的视效开关（与背景同源，导出页读同一份） */
  function fxOpts() { return { ...((bg as any).fx || {}) }; }
  function setFx(k: string, v: boolean) { setFxAny(k, !!v); }
  function resetFx(on: boolean) {
    (bg as any).fx = Object.fromEntries(Object.keys(FX_DEFAULTS).map((k) => [k, on]));
    save();
  }

  function setMode(m: string) {
    if (m === 'image' && !bg.path) { void pickImage(); return; }
    bg.mode = m;
    save();
    if (m === 'image' && bg.path && !image) void ensureImage();
  }
  function setColor(c: string) { bg.color = c; save(); }
  function setBlur(v: number | string) { bg.blur = Number(v) || 0; save(); }
  function setDim(v: number | string) { bg.dim = Number(v) || 0; save(); }

  /** 从磁盘路径读图并解码；返回是否成功 */
  async function loadFromPath(p: string) {
    const b = (window as any).fuBridge;
    if (!p || !b || typeof b.readBinary !== 'function') return false;
    const ab = await b.readBinary(p);
    if (!ab) return false;
    if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch (e) { /* 忽略 */ } }
    objUrl = URL.createObjectURL(new Blob([ab], { type: mimeOf(p) }));
    image = await decode(objUrl);
    return !!image;
  }
  /** 确保图片已解码（两个页面都调；只读一次盘） */
  function ensureImage(): Promise<boolean> {
    if (image) return Promise.resolve(true);
    if (!bg.path) return Promise.resolve(false);
    if (!loading) loading = loadFromPath(bg.path).finally(() => { loading = null; });
    return loading;
  }
  async function pickImage() {
    const b = (window as any).fuBridge;
    if (!b || typeof b.pickFile !== 'function') { app.toast(t('当前环境不支持选择图片'), 'warn'); return; }
    const p = await b.pickFile({ filters: [{ name: t('图片'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }] });
    if (!p) return;
    if (!(await loadFromPath(p))) { app.toast(t('读取图片失败'), 'error'); return; }
    bg.path = p; bg.mode = 'image'; save();
  }
  /** 启动时把上次选的图读回来（路径有效才用；图没了就退回主题，不留「假图片档」） */
  async function init() {
    // 老格式（没有 v）的数据一律丢弃并把新默认写回去 —— 否则那条陈旧记录会一直躺在 localStorage 里
    try {
      const raw = JSON.parse(localStorage.getItem(BG_KEY) || 'null');
      if (!raw || raw.v !== BG_VER) save();
    } catch (e) { save(); }
    if (!bg.path) return;
    const ok = await ensureImage();
    if (!ok && bg.mode === 'image') {
      bg.mode = 'theme'; bg.path = ''; save();
      app.toast(t('上次的自定义背景图已找不到，已切回主题'), 'warn');
    }
  }

  return { bg, BG_MODES, FX_ITEMS, FX_PARAMS, FX_COLORBY, VIZ_THEMES,
           userThemes, themeName, vizTheme, setVizTheme, themeList, applyTheme, saveTheme, deleteTheme,
           ssaa, setSsaa,
           save, drawOpts, fxOpts, setFx, setFxAny, resetFx, imageEl,
           setMode, setColor, setBlur, setDim, ensureImage, pickImage, init };
});