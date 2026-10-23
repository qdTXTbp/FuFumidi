// Pinia：音符瀑布的**背景设置** —— 「可视化」页与「导出视频」共用同一份。
//
// ★ 为什么要有这个 store：导出页以前自带一套「背景色 + 背景图片」（VE.bgColor / VE.bgImage），
//   跟可视化页的背景设置**毫无关系** —— 用户在瀑布流里挑的图片、透明档、模糊/暗化，
//   导出的成片一概不认，看到的和导出的是两幅画。现在两边读写同一个 store、同一个
//   localStorage 键、同一个绘制函数（core/viz.js 的 paintVizBg），任何一处改动两边立刻同步。
// ★ 2026-10-17（用户："音符瀑布背景允许设定动态壁纸"）：新增 `wallpaper` 档 —— 拿应用**壁纸库**
//   里的动态壁纸（视频）当瀑布流背景。与应用整窗背景（App.vue 的 custom_wallpaper）**互相独立**：
//   两处各挑各的，谁也不覆盖谁。
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
/* ★ 2026-10-17 加了 wallPath（动态壁纸）：它是**纯新增字段**，老记录没有它就落到默认 ''，
   因此**不动 BG_VER** —— 一动 BG_VER，老用户存的图片/纯色/模糊/暗化会被整条丢掉重来。 */
export const BG_DEFAULTS = { v: BG_VER, mode: 'transparent', color: '#0b1020', blur: 12, dim: 0.35, path: '', wallPath: '', fx: { ...FX_DEFAULTS } };   // ui-tokens-allow: color 是持久化的用户默认值，不是样式

/* 瀑布流视效开关（2026-10 升级）。顺序即界面顺序；每项都能单独关掉回到旧观感。 */
/* 用户自定义主题（D8：命名交给用户）—— 与内置主题分开存，卸载/升级不丢 */
export const FX_USER_KEY = 'fufumidi.viz.fxthemes';
export type FxUserThemes = Record<string, Record<string, unknown>>;

export const FX_ITEMS = [
  { k: 'keys3d', label: '3D 键盘', hint: '立体键盘：透视 + 键面厚度 + 侧面 + 按压下沉（关掉 = 平板键，透视也一起关）' },
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
  { k: 'wallpaper', label: '动态壁纸' },
  { k: 'transparent', label: '透明' },
];

function read() {
  try {
    const s = JSON.parse(localStorage.getItem(BG_KEY) || 'null');
    if (s && typeof s === 'object' && s.v === BG_VER) {
      // fx 要**逐键**合并：整体覆盖会把后来新增的档位丢成 undefined（viz.js 那边再补默认，
      // 于是界面显示"开"、实际却是默认值，用户改了不生效）
      return { ...BG_DEFAULTS, ...s, v: BG_VER, path: s.path || '', wallPath: s.wallPath || '', fx: { ...FX_DEFAULTS, ...(s.fx || {}) } };
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

/** 动态壁纸：路径 → 可播放 URL。本地路径转 file://，http(s) 原样透传（在线壁纸直接流） */
function wallFileUrl(p: string) {
  if (!p) return '';
  if (/^(https?:|file:|data:)/i.test(p)) return p;
  const norm = String(p).replace(/\\/g, '/');
  return 'file:///' + norm.replace(/^([A-Za-z]):/, '$1:');
}
function baseName(p: string) {
  return String(p || '').split(/[\\/]/).pop() || '';
}

export const useVizBgStore = defineStore('vizbg', () => {
  const app = useAppStore();
  const bg = reactive(read());
  // ★ 解码后的图片**不进响应式**：HTMLImageElement 被 Proxy 包住后 drawImage 会抛
  //   （Illegal invocation），所以它住在闭包里，只通过 imageEl()/drawOpts() 取。
  let image: HTMLImageElement | null = null;
  let objUrl = '';
  let loading: Promise<boolean> | null = null;

  /* ---------------- 动态壁纸（wallpaper 档）----------------
   * 视频元素与图片同理**不进响应式**：HTMLVideoElement 被 Proxy 包住后 drawImage 同样会抛。
   * 它住在闭包里，drawOpts() 只在"就绪"时把它交出去。 */
  const wallReady = ref(false);
  const wallActive = ref(false);
  const wallName = ref('');
  let wallVideo: HTMLVideoElement | null = null;
  let wallTimer = 0, wallLast = -1, wallStall = 0;

  function save() {
    try { localStorage.setItem(BG_KEY, JSON.stringify({ ...bg, v: BG_VER })); } catch (e) { /* 隐私模式忽略 */ }
  }
  function videoReady() { return !!(wallVideo && wallVideo.readyState >= 2 && wallVideo.videoWidth > 0); }
  /** 交给绘制函数的背景参数（含已解码的图片 / 已就绪的视频帧源） */
  function drawOpts() {
    return {
      mode: bg.mode, color: bg.color, blur: bg.blur, dim: bg.dim, image,
      // ★ 视频**逐帧都在变**：core/viz.js 的离屏背景位图缓存对它是失效的（那边按 mode 分流）
      video: (bg.mode === 'wallpaper' && videoReady()) ? wallVideo : null,
    };
  }
  function imageEl() { return image; }

  /** 造/换动态壁纸解码器：一个 muted + loop 的 <video>，只作为"当前帧"的来源 */
  async function ensureWall(): Promise<boolean> {
    const src = wallFileUrl(bg.wallPath);
    if (!src || typeof document === 'undefined') { wallReady.value = false; return false; }
    if (!wallVideo) {
      const v = document.createElement('video');
      v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
      v.setAttribute('aria-hidden', 'true');
      // ★ 必须进 DOM、且保持"被合成"：完全不参与布局的视频在部分 Chromium 版本里不给帧。
      //   2px + z-index:-1 既看不见、又仍然解码（实测能持续 drawImage 出新帧）。
      v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
      document.body.appendChild(v);
      wallVideo = v;
    }
    if (wallVideo.dataset.src !== src) {
      wallVideo.dataset.src = src;
      wallReady.value = false;
      wallVideo.src = src;
      wallVideo.load();
    }
    const v = wallVideo;
    const ok = await new Promise<boolean>((res) => {
      if (videoReady()) { res(true); return; }
      let done = false;
      const fin = (val: boolean) => { if (!done) { done = true; clearTimeout(tm); res(val); } };
      const tm = setTimeout(() => fin(videoReady()), 8000);
      v.addEventListener('loadeddata', () => fin(true), { once: true });
      v.addEventListener('error', () => fin(false), { once: true });
    });
    wallReady.value = ok && videoReady();
    // 画面已在台前 → 直接开播并挂上看门狗（init() 里解码完成时墙上并没有人再喊一次"激活"）
    if (wallReady.value && wallActive.value) setWallActive(true);
    else if (wallReady.value) void v.play().catch(() => { /* 静音自动播放通常不会被拒 */ });
    return wallReady.value;
  }

  /** 停摆自愈：主线程长任务（切页/重绘）后 muted 视频可能不再送帧（paused=false 但 currentTime 不动）。
   *  App.vue 的整窗壁纸有一套同样的看门狗 —— 这里针对瀑布流背景再来一份，否则画面会"冻住一帧"。 */
  function wallWatchdog() {
    const v = wallVideo;
    if (!v || !wallActive.value || bg.mode !== 'wallpaper' || document.hidden
      || v.paused || v.readyState < 2 || !v.duration || !isFinite(v.duration)) { wallLast = -1; wallStall = 0; return; }
    if (v.currentTime === wallLast) {
      if (++wallStall >= 4) {
        wallStall = 0;
        try { v.currentTime = v.currentTime > 0.1 ? v.currentTime - 0.1 : 0.1; void v.play().catch(() => {}); } catch (e) { /* 忽略 */ }
      }
    } else wallStall = 0;
    wallLast = v.currentTime;
  }

  /** 页面在不在台前：离开可视化/导出页就暂停解码，别白烧 GPU */
  function setWallActive(on: boolean) {
    wallActive.value = !!on;
    clearInterval(wallTimer); wallTimer = 0;
    if (!wallVideo) return;
    if (on && bg.mode === 'wallpaper' && wallReady.value) {
      void wallVideo.play().catch(() => { /* 忽略 */ });
      wallTimer = window.setInterval(wallWatchdog, 600);
    } else {
      try { wallVideo.pause(); } catch (e) { /* 忽略 */ }
    }
  }

  /** 把某张静态图片设为**音符瀑布背景**（本地路径或 file 地址） */
  async function setImagePath(p: string) {
    bg.path = String(p || '').trim();
    bg.mode = 'image';
    save();
    if (!bg.path) { image = null; return false; }
    return await ensureImage();
  }

  /** 把某张动态壁纸设为**音符瀑布背景**（本地路径或 https 地址都行） */
  async function setWall(p: string) {
    bg.wallPath = String(p || '').trim();
    bg.mode = 'wallpaper';
    wallName.value = baseName(bg.wallPath);
    save();
    if (!bg.wallPath) { wallReady.value = false; return false; }
    const ok = await ensureWall();
    if (ok) setWallActive(true);
    else app.toast(t('动态壁纸加载失败'), 'error');   // 成功提示由调用方给（壁纸库里点的那一下）
    return ok;
  }
  /** 关掉动态壁纸：释放解码器，退回主题底（避免"档位还写着动态壁纸、画面却是空的"） */
  function clearWall() {
    bg.wallPath = ''; wallName.value = ''; wallReady.value = false;
    if (wallVideo) {
      try { wallVideo.pause(); wallVideo.removeAttribute('src'); wallVideo.load(); } catch (e) { /* 忽略 */ }
      wallVideo.dataset.src = '';
    }
    if (bg.mode === 'wallpaper') bg.mode = 'theme';
    save();
  }

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
    // 动态壁纸档：有路径就当场解码开播；切走别的档就暂停（别在看不见的地方烧解码）
    if (m === 'wallpaper' && bg.wallPath) void ensureWall().then((ok) => setWallActive(!!ok));
    else setWallActive(m === 'wallpaper');
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
  /** 启动时把上次选的图/动态壁纸读回来（路径有效才用；没了就退回主题，不留「假档位」） */
  async function init() {
    // 老格式（没有 v）的数据一律丢弃并把新默认写回去 —— 否则那条陈旧记录会一直躺在 localStorage 里
    try {
      const raw = JSON.parse(localStorage.getItem(BG_KEY) || 'null');
      if (!raw || raw.v !== BG_VER) save();
    } catch (e) { save(); }
    if (bg.wallPath) {
      wallName.value = baseName(bg.wallPath);
      if (bg.mode === 'wallpaper') {
        const okw = await ensureWall();
        if (!okw) {
          bg.mode = 'theme'; bg.wallPath = ''; save();
          app.toast(t('上次的动态壁纸已找不到，已切回主题'), 'warn');
        }
      }
    }
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
           wallReady, wallActive, wallName, setWall, setImagePath, clearWall, setWallActive, wallFileUrl,
           setMode, setColor, setBlur, setDim, ensureImage, pickImage, init };
});
