// Pinia：音符瀑布的**背景设置** —— 「可视化」页与「导出视频」共用同一份。
//
// ★ 为什么要有这个 store：导出页以前自带一套「背景色 + 背景图片」（VE.bgColor / VE.bgImage），
//   跟可视化页的背景设置**毫无关系** —— 用户在瀑布流里挑的图片、透明档、模糊/暗化，
//   导出的成片一概不认，看到的和导出的是两幅画。现在两边读写同一个 store、同一个
//   localStorage 键、同一个绘制函数（core/viz.js 的 paintVizBg），任何一处改动两边立刻同步。
import { reactive } from 'vue';
import { defineStore } from 'pinia';
import { t } from '../core/i18n.js';
import { useAppStore } from './app';

export const BG_KEY = 'fufumidi.viz.bg';
/* ★ 改默认值 / 改结构时把 BG_VER +1：老数据直接忽略，否则「新默认值」对老用户永远不生效
   （这次就把默认从「主题」改成「透明」，顺便清掉之前调试留下的图片档）。 */
export const BG_VER = 2;
export const BG_DEFAULTS = { v: BG_VER, mode: 'transparent', color: '#0b1020', blur: 12, dim: 0.35, path: '' };

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
      return { ...BG_DEFAULTS, ...s, v: BG_VER, path: s.path || '' };
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

  return { bg, BG_MODES, save, drawOpts, imageEl, setMode, setColor, setBlur, setDim,
           ensureImage, pickImage, init };
});