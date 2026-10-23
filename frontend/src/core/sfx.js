// ============================================================
// 全局音效：合成音，不需要外部音频文件；分类音量 + 方案 + 自定义。
// 存储：localStorage('fufumidi_sfx_v1')，不影响主题/壁纸/引擎设置。
// ============================================================
import { reactive } from 'vue';

export const SFX_KEY = 'fufumidi_sfx_v1';

export const SFX_CATEGORIES = [
  { id: 'ui', defaultVolume: 1, defaultEnabled: true },
  { id: 'task', defaultVolume: 1, defaultEnabled: true },
  { id: 'chime', defaultVolume: 1, defaultEnabled: true },
];

export const SFX_SCHEMES = {
  light:  { master: 0.35, ui: 0.08, task: 0.35, chime: 0.45, style: 'soft' },
  standard:{ master: 1, ui: 1, task: 1, chime: 1, style: 'bright' },
  immersive:{ master: 0.75, ui: 0.18, task: 0.70, chime: 0.80, style: 'bright' },
};

function defaults() {
  return {
    v: 2,
    enabled: true,
    master: 1,
    scheme: 'standard',
    chimeStyle: 'bright',
    categories: {
      ui: { enabled: true, volume: 1 },
      task: { enabled: true, volume: 1 },
      chime: { enabled: true, volume: 1 },
    },
  };
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, Number(n) || 0)); }

function isLegacyDefault(src) {
  const cats = src.categories || {};
  const vol = (id) => (cats[id] && cats[id].volume != null ? Number(cats[id].volume) : NaN);
  return !src.v && src.scheme === 'standard' &&
    Math.abs(Number(src.master) - 0.55) < 0.001 &&
    Math.abs(vol('ui') - 0.12) < 0.001 &&
    Math.abs(vol('task') - 0.55) < 0.001 &&
    Math.abs(vol('chime') - 0.65) < 0.001;
}

function normalize(raw) {
  const d = defaults();
  const src = raw && typeof raw === 'object' ? raw : {};
  if (isLegacyDefault(src)) return d;
  const out = d;
  out.v = 2;
  out.enabled = src.enabled !== false;
  out.master = clamp(src.master != null ? src.master : d.master, 0, 1);
  out.scheme = ['light', 'standard', 'immersive', 'custom'].includes(src.scheme) ? src.scheme : d.scheme;
  out.chimeStyle = ['bright', 'soft', 'short'].includes(src.chimeStyle) ? src.chimeStyle : d.chimeStyle;
  for (const c of SFX_CATEGORIES) {
    const item = src.categories && src.categories[c.id] ? src.categories[c.id] : {};
    out.categories[c.id] = {
      enabled: item.enabled !== false,
      volume: clamp(item.volume != null ? item.volume : c.defaultVolume, 0, 1),
    };
  }
  return out;
}

function read() {
  try { return normalize(JSON.parse(localStorage.getItem(SFX_KEY) || 'null')); } catch (e) { return defaults(); }
}

export const sfxConfig = reactive(read());

export function saveSfxConfig(patch = null) {
  if (patch && typeof patch === 'object') {
    Object.assign(sfxConfig, patch);
  }
  try { localStorage.setItem(SFX_KEY, JSON.stringify(sfxConfig)); } catch (e) {}
}

export function setSfxEnabled(v) { sfxConfig.enabled = !!v; saveSfxConfig(); }
export function setSfxMaster(v) { sfxConfig.master = clamp(v, 0, 1); saveSfxConfig(); }
export function setSfxCategory(id, patch) {
  const c = sfxConfig.categories[id];
  if (!c) return;
  if (patch && patch.enabled != null) c.enabled = !!patch.enabled;
  if (patch && patch.volume != null) c.volume = clamp(patch.volume, 0, 1);
  saveSfxConfig();
}
export function applySfxScheme(id) {
  if (!SFX_SCHEMES[id]) return;
  sfxConfig.scheme = id;
  sfxConfig.master = SFX_SCHEMES[id].master;
  sfxConfig.chimeStyle = SFX_SCHEMES[id].style;
  for (const c of SFX_CATEGORIES) {
    sfxConfig.categories[c.id].volume = SFX_SCHEMES[id][c.id];
    sfxConfig.categories[c.id].enabled = true;
  }
  saveSfxConfig();
}
export function resetSfx() {
  const d = defaults();
  Object.assign(sfxConfig, d);
  saveSfxConfig();
}

let _ctx = null;
function context() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!_ctx) _ctx = new AC();
    if (_ctx.state === 'suspended') _ctx.resume().catch(() => {});
    return _ctx;
  } catch (e) { return null; }
}

function tone(ctx, freq, start, dur, peak, type = 'sine') {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(start); osc.stop(start + dur + 0.02);
}

function volumeFor(category) {
  if (!sfxConfig.enabled) return 0;
  const c = sfxConfig.categories[category];
  if (!c || !c.enabled) return 0;
  return clamp(sfxConfig.master * c.volume, 0, 1);
}

/** 播放一个命名音效；未知名称静默。 */
export function playSfx(name, category = 'ui') {
  const v = volumeFor(category);
  if (v <= 0.0001) return false;
  const ctx = context();
  if (!ctx) return false;
  const t0 = ctx.currentTime + 0.005;
  try {
    if (name === 'click') tone(ctx, 880, t0, 0.035, v * 0.22, 'sine');
    else if (name === 'toggle') { tone(ctx, 620, t0, 0.05, v * 0.20); tone(ctx, 930, t0 + 0.05, 0.06, v * 0.16); }
    else if (name === 'success') { [523.25, 659.25, 783.99].forEach((f, i) => tone(ctx, f, t0 + i * 0.09, 0.16, v * 0.20)); }
    else if (name === 'error') { [392, 311].forEach((f, i) => tone(ctx, f, t0 + i * 0.12, 0.2, v * 0.18)); }
    else if (name === 'notify') { tone(ctx, 880, t0, 0.08, v * 0.15); tone(ctx, 1174.66, t0 + 0.1, 0.12, v * 0.12); }
    else if (name === 'complete') {
      const freqs = sfxConfig.chimeStyle === 'short' ? [659.25, 880] : sfxConfig.chimeStyle === 'soft' ? [523.25, 659.25, 783.99] : [659.25, 880, 1318.5];
      freqs.forEach((f, i) => tone(ctx, f, t0 + i * 0.11, 0.2, v * 0.18));
    }
    else return false;
    return true;
  } catch (e) { return false; }
}

/** 转录完成提示音：成功上行，失败下行；音量归入“转录完成”分类。 */
export function playDoneChime(failed = false) {
  return playSfx(failed ? 'error' : 'complete', 'chime');
}

/**
 * 全局交互点击音：只在语义按钮/标签/导航项上播放，输入框与拖动不播。
 * 低音量，默认仅 12%，用户可在“音效”设置里关闭或调低。
 */
export function installSfxClicks() {
  if (typeof document === 'undefined' || document.__fuSfxClickInstalled) return;
  document.__fuSfxClickInstalled = true;
  document.addEventListener('pointerdown', (e) => {
    if (!sfxConfig.enabled) return;
    const target = e.target && e.target.closest ? e.target.closest('button, a, [role="button"], .tab, .nav-item, .side-item, .song-tab') : null;
    if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true') return;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    playSfx('click', 'ui');
  }, { passive: true, capture: true });
}
