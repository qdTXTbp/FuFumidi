// ============================================================
// 主题库：内置主题 + 即时换肤（CSS 变量）+ 图片提取主色生成主题
// 设计遵循 MiniMax 极简黑白风格：换肤通过覆盖强调色族变量实现，
// 画布/墨色等中性色保持不变（--canvas/--surface/--ink/--hairline）。
// ============================================================

const LS_THEME = 'fufumidi_theme';
const LS_ACCENT = 'fufumidi_accent';

export const THEMES = [
  { id: 'fufu',    name: '芙芙蓝', desc: '芙宁娜 · 蔚蓝深海',   accent: '#4f94e0', accent2: '#8fc0f0', hue: 213 },
  { id: 'deep',    name: '青绿',   desc: 'FuFumidi 经典 · 青绿主色', accent: '#00c9b1', accent2: '#2ee6cd', hue: 174 },
  { id: 'night',   name: '极夜蓝', desc: '冷冽深海蓝',         accent: '#3b82f6', accent2: '#60a5fa', hue: 217 },
  { id: 'aurora',  name: '极光紫', desc: '紫色霓虹',           accent: '#a78bfa', accent2: '#c4b5fd', hue: 258 },
  { id: 'sunrise', name: '晨曦橙', desc: '温暖日出橙',         accent: '#fb923c', accent2: '#fdba74', hue: 24 },
  { id: 'rose',    name: '玫瑰粉', desc: '柔和樱粉',           accent: '#f472b6', accent2: '#f9a8d4', hue: 330 },
  { id: 'moss',    name: '苔藓绿', desc: '森林沉稳绿',         accent: '#4ade80', accent2: '#86efac', hue: 142 },
  { id: 'ember',   name: '余烬红', desc: '炽热炭红',           accent: '#f87171', accent2: '#fca5a5', hue: 0 },
  { id: 'gold',    name: '鎏金',   desc: '暖金奢华',           accent: '#fbbf24', accent2: '#fcd34d', hue: 45 },
  { id: 'light',   name: '浅色',   desc: '明亮浅色 · 适合白天', accent: '#00a88f', accent2: '#00c9b1', hue: 174 },
];

export function themeById(id) { return THEMES.find(t => t.id === id) || THEMES[0]; }

// 由 hue 生成同色系辅助色（饱和度/明度参数化，保证深浅层次）
function hsl(h, s, l, a) { return a != null ? `hsla(${h},${s}%,${l}%,${a})` : `hsl(${h},${s}%,${l}%)`; }

export function paletteFromAccent(accentHex, hue) {
  return {
    accent: accentHex,
    accent2: hsl(hue, 85, 62),
    'accent-dim': `hsla(${hue}, 60%, 55%, 0.14)`,
    'brand-blue-mid': hsl(hue, 78, 58),
    'brand-blue-deep': hsl(hue, 80, 42),
    'brand-blue-700': hsl(hue, 70, 34),
    'brand-blue-200': hsl(hue, 85, 84),
  };
}

// 应用主题：把调色板写成 CSS 变量（含原令牌里的强调色族）——纯应用，不做持久化
export function applyTheme(name, accent) {
  if (typeof document === 'undefined') return;
  const t = themeById(name);
  const R = document.documentElement.style;
  const a = accent || t.accent;
  const pal = paletteFromAccent(a, t.hue);
  R.setProperty('--accent', a);
  R.setProperty('--accent2', pal.accent2);
  R.setProperty('--accent-dim', pal['accent-dim']);
  R.setProperty('--brand-blue', a);
  R.setProperty('--brand-blue-mid', pal['brand-blue-mid']);
  R.setProperty('--brand-blue-deep', pal['brand-blue-deep']);
  R.setProperty('--brand-blue-700', pal['brand-blue-700']);
  R.setProperty('--brand-blue-200', pal['brand-blue-200']);
  R.setProperty('--accent-rgb', hexToRgb(a));
}

// 主题强调色的 rgb 三元组（canvas 不能用 CSS 变量，需读成 "r,g,b" 字符串）
export function accentRgb() {
  if (typeof document === 'undefined') return '20,86,240';
  const v = document.documentElement.style.getPropertyValue('--accent') || getComputedStyle(document.documentElement).getPropertyValue('--accent');
  return hexToRgb(String(v).trim()) || '20,86,240';
}
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255);
}

// 应用 + 持久化（localStorage 优先 + Electron settings 兜底）
export function saveTheme(name, accent) {
  applyTheme(name, accent);
  try {
    localStorage.setItem(LS_THEME, name);
    if (accent) localStorage.setItem(LS_ACCENT, accent);
    else localStorage.removeItem(LS_ACCENT);
  } catch (e) {}
  if (window.fuBridge && typeof window.fuBridge.saveSettings === 'function') {
    window.fuBridge.saveSettings({ theme: name, accent: accent || '' }).catch(() => {});
  }
}

// 读取当前主题（localStorage 优先，作为启动防闪烁的第一来源）
export function loadTheme() {
  let name = 'fufu', accent = '';
  try { name = localStorage.getItem(LS_THEME) || 'fufu'; accent = localStorage.getItem(LS_ACCENT) || ''; } catch (e) {}
  return { name, accent };
}

// 内置主题预览条色块
export function themeSwatches(t) {
  const pal = paletteFromAccent(t.accent, t.hue);
  return [pal.accent, pal.accent2, pal['accent-dim'], '#e5e7eb', '#ffffff'];
}

// 图片提取主色：canvas 缩到 8×8，收集较饱和像素取平均色 → 提升饱和度与亮度 → 主色
export function extractAccentFromImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = 8; cv.height = 8;
        const cx = cv.getContext('2d');
        cx.drawImage(img, 0, 0, 8, 8);
        const { data } = cx.getImageData(0, 0, 8, 8);
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 128) continue;
          const mx = Math.max(data[i], data[i + 1], data[i + 2]), mn = Math.min(data[i], data[i + 1], data[i + 2]);
          const sat = mx === 0 ? 0 : (mx - mn) / mx;
          if (sat > 0.15) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
        }
        if (!n) { r = data[0]; g = data[1]; b = data[2]; n = 1; }
        r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
        const hsv = rgbToHsv(r, g, b);
        hsv.s = Math.min(1, hsv.s * 1.6 + 0.15);
        hsv.v = Math.min(1, hsv.v * 1.25 + 0.12);
        const accentHex = hsvToHex(hsv);
        const hue = hslFromHex(accentHex);
        resolve({ accentHex, hue });
      } catch (e) { reject(e); }
      finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片加载失败')); };
    img.src = url;
  });
}

/* ---------------- 颜色工具（RGB/HSV/HSL/HEX，照搬 legacy） ---------------- */
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: mx === 0 ? 0 : d / mx, v: mx };
}

function hsvToHex({ h, s, v }) {
  const c = v * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}

function hslFromHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const v = m ? m[1] : '4f94e0';
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}
