<script setup>
// 统一外观抽屉（2026-10-22）：主题 / 明暗模式 / 壁纸 / 减弱动态，一处改完即时预览。
// 保留原有主题库与壁纸库入口，不替换旧数据与键名。
import { computed, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { useAppStore } from '../stores/app';
import { useSettingsStore } from '../stores/settings';
import { useVizBgStore } from '../stores/vizbg';
import { t } from '../core/i18n.js';
import { MATERIALS, applyMaterial } from '../core/material.js';
import { THEMES, themeById, saveTheme, loadTheme, loadMode, setMode } from '../core/theme.js';
import WallpaperLibrary from './WallpaperLibrary.vue';
import WallpaperEnginePanel from './WallpaperEnginePanel.vue';
import { applyDisplayPrefs, loadDisplayPrefs, saveFontSize, saveDensity, saveUiScale, UI_SCALE_MIN, UI_SCALE_MAX, UI_SCALE_STEP } from '../core/display.js';
import { setLang, getLang } from '../core/i18n.js';

const app = useAppStore();
const state = app;
const settingsStore = useSettingsStore();
const vizBg = useVizBgStore();
const vbg = vizBg.bg;
const wpApplyTarget = ref('app'); // app | viz
const tab = ref('theme');
const material = computed(() => String((settingsStore.settings && settingsStore.settings.ui_material) || 'default'));
function setMaterial(id) { try { applyMaterial(id); } catch (e) {} settingsStore.setLocal({ ui_material: id }); settingsStore.save({ ui_material: id }).catch(() => {}); }             // theme | wallpaper | display
const wpSource = ref('local');         // local | library | we
const bridge = window.fuBridge;

const mode = ref(loadMode());
const theme = ref(loadTheme().name);
const FEATURED = ['fufu', 'night', 'gold', 'light'];
const featured = computed(() => FEATURED.map((id) => themeById(id)));
const currentName = computed(() => themeById(theme.value).name);
const cfg = computed(() => settingsStore.settings || {});
const hasWallpaper = computed(() => !!(cfg.value.wallpaper_enabled && cfg.value.custom_wallpaper));
const isVizTarget = computed(() => wpApplyTarget.value === 'viz');
const vizActive = computed(() => vbg.mode !== 'theme');

const isImage = computed(() => cfg.value.wallpaper_kind === 'image' || /\.(jpg|jpeg|png|webp|avif|gif)$/i.test(String(cfg.value.custom_wallpaper || '')));
const previewUrl = computed(() => fileUrl(cfg.value.custom_wallpaper));
async function setDesktopWallpaper() {
  const p = cfg.value.custom_wallpaper || '';
  if (!p || !window.fuBridge || !window.fuBridge.wallpaper) { app.toast(t('当前壁纸不能设为桌面'), 'warn'); return; }
  const r = await window.fuBridge.wallpaper.setDesktop(p);
  app.toast(r && r.ok ? t('已设为桌面壁纸') : t('设为桌面壁纸失败：') + ((r && r.error) || ''), r && r.ok ? 'ok' : 'warn');
}
const wpName = computed(() => (cfg.value.custom_wallpaper || '').replace(/^.*[\\/]/, '') || t('未选择壁纸'));
const dim = computed({ get: () => Number(cfg.value.wallpaper_dim ?? 18), set: (v) => saveWp({ wallpaper_dim: Number(v) }) });
const blur = computed({ get: () => Number(cfg.value.wallpaper_blur ?? 0), set: (v) => saveWp({ wallpaper_blur: Number(v) }) });
const fit = computed(() => cfg.value.wallpaper_fit || 'cover');
const reduceMotion = ref(false);
const accent = ref(loadTheme().accent || '');
const lang = ref(getLang());
const dp0 = loadDisplayPrefs();
const fontSize = ref(dp0.font_size || 'standard');
const density = ref(dp0.density || 'comfortable');
const uiScale = ref(dp0.ui_scale || 1);
function chooseAccent() { theme.value = loadTheme().name; saveTheme(theme.value, accent.value, mode.value); }
function resetAccent() { accent.value = ''; theme.value = loadTheme().name; saveTheme(theme.value, '', mode.value); }
function setFont(v) { fontSize.value = v; saveFontSize(v); applyDisplayPrefs({ font_size: v, density: density.value, ui_scale: uiScale.value }); }
function setDensity(v) { density.value = v; saveDensity(v); applyDisplayPrefs({ font_size: fontSize.value, density: v, ui_scale: uiScale.value }); }
function setUiScale(v) { uiScale.value = Number(v); saveUiScale(uiScale.value); applyDisplayPrefs({ font_size: fontSize.value, density: density.value, ui_scale: uiScale.value }); }
function setLanguage(v) { lang.value = v; setLang(v); try { window.fuBridge.saveSettings({ lang: v }).catch(() => {}); } catch (e) {} }

function fileUrl(p) {
  if (!p) return '';
  if (/^(https?:|file:|data:)/i.test(p)) return p;
  return 'file:///' + String(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1:');
}
function close() { state.ui.appearanceOpen = false; }
function chooseMode(m) { mode.value = m; setMode(m); }
function chooseTheme(th) { theme.value = th.id; accent.value = ''; saveTheme(th.id, '', mode.value); }
async function saveWp(patch) {
  try { settingsStore.setLocal(patch); await settingsStore.save(patch); } catch (e) { app.toast(t('外观保存失败') + '：' + String((e && e.message) || e), 'error'); }
}
function toggleWallpaper() { saveWp({ wallpaper_enabled: !cfg.value.wallpaper_enabled }); }
function setFit(v) { saveWp({ wallpaper_fit: v }); }
function setVizMode(m) { vizBg.setMode(m); }
function pickVizImage() { void vizBg.pickImage(); }

function clearVizWall() { vizBg.clearWall(); }
function saveVizBg() { vizBg.save(); }
function openThemes() { state.ui.themesOpen = true; }
function openSound() { state.ui.appearanceOpen = false; state.ui.settingsTab = 'sound'; state.ui.settingsOpen = true; }
async function pickLocal() {
  if (isVizTarget.value) { void pickVizImage(); return; }
  void pickImage();
}
function clearLocal() {
  if (isVizTarget.value) { clearVizWall(); return; }
  saveWp({ wallpaper_enabled: false, custom_wallpaper: '' });
}
async function pickImage() {
  if (!bridge || !bridge.pickFile) return;
  try {
    const p = await bridge.pickFile({ filters: [{ name: t('图片'), extensions: ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'] }] });
    if (!p) return;
    await saveWp({ custom_wallpaper: p, wallpaper_enabled: true, wallpaper_kind: 'image', wallpaper_provider: 'native' });
    app.toast(t('已应用本地图片壁纸'), 'ok');
  } catch (e) { app.toast(t('应用失败：') + String((e && e.message) || e), 'error'); }
}
function toggleMotion() {
  reduceMotion.value = !reduceMotion.value;
  try { localStorage.setItem('fufumidi_reduce_motion', reduceMotion.value ? '1' : '0'); } catch (e) {}
  document.documentElement.classList.toggle('reduce-motion', reduceMotion.value);
}
onMounted(async () => {
  try { await settingsStore.load(); } catch (e) {}
  try { await vizBg.init(); vizBg.setWallActive(vbg.mode === 'wallpaper'); } catch (e) {}
  try { reduceMotion.value = localStorage.getItem('fufumidi_reduce_motion') === '1'; } catch (e) {}
  document.documentElement.classList.toggle('reduce-motion', reduceMotion.value);
});
</script>

<template>
  <Teleport to="body">
    <div class="ap-mask" @click.self="close">
      <aside class="ap-drawer" role="dialog" aria-modal="true" :aria-label="t('外观')">
        <header class="ap-head">
          <div><span class="ap-eyebrow">APPEARANCE</span><h2>{{ t('外观') }}</h2></div>
          <button class="icon-btn" :title="t('关闭')" :aria-label="t('关闭')" @click="close"><Icon name="close" :size="16" /></button>
        </header>

        <nav class="ap-tabs" role="tablist">
          <button :class="{ on: tab === 'theme' }" @click="tab = 'theme'">{{ t('主题') }}</button>
          <button :class="{ on: tab === 'wallpaper' }" @click="tab = 'wallpaper'">{{ t('壁纸') }}</button>
          <button :class="{ on: tab === 'display' }" @click="tab = 'display'">{{ t('显示') }}</button>
        </nav>

        <section v-show="tab === 'theme'" class="ap-sec ap-sec-first">
          <div class="ap-sec-head"><span>{{ t('主题') }}</span><button class="ap-link" @click="openThemes">{{ t('全部主题库') }} <Icon name="forward" :size="12" /></button></div>
          <div class="ap-modes">
            <button :class="{ on: mode === 'dark' }" @click="chooseMode('dark')">{{ t('深色') }}</button>
            <button :class="{ on: mode === 'light' }" @click="chooseMode('light')">{{ t('浅色') }}</button>
            <button :class="{ on: mode === 'auto' }" @click="chooseMode('auto')">{{ t('跟随系统') }}</button>
          </div>
          <div class="ap-th-grid">
            <button v-for="th in featured" :key="th.id" class="ap-th" :class="{ on: theme === th.id }" @click="chooseTheme(th)">
              <i :style="{ background: 'linear-gradient(135deg,' + th.accent + ',' + th.accent2 + ')' }"></i>
              <b>{{ t(th.name) }}</b>
              <small>{{ theme === th.id ? t('当前') : t(th.desc) }}</small>
              <span v-if="theme === th.id" class="ap-th-check"><Icon name="check" :size="12" /></span>
            </button>
          </div>
          <div class="ap-row"><span>{{ t('强调色') }}</span><div class="ap-color"><input type="color" :value="accent || themeById(theme).accent" @input="accent = $event.target.value; chooseAccent()" /><button class="ap-link" @click="resetAccent">{{ t('还原默认') }}</button></div></div>
          <div class="ap-row"><span>{{ t('界面材质') }}</span><div class="ap-material-grid"><button v-for="m in MATERIALS" :key="m.id" class="ap-material" :class="[ 'mat-' + m.id, { on: material === m.id } ]" :title="t(m.label)" @click="setMaterial(m.id)"><i></i><span>{{ t(m.label) }}</span></button></div></div>
        </section>

        <section v-show="tab === 'wallpaper'" class="ap-sec ap-sec-first">
          <div class="ap-sec-head">
            <span>{{ t('壁纸') }}</span>
            <span class="ap-state" :class="{ on: isVizTarget ? vizActive : hasWallpaper }">{{ (isVizTarget ? vizActive : hasWallpaper) ? t('已启用') : t('未启用') }}</span>
          </div>
          <div class="ap-row ap-row-tight"><span>{{ t('应用目标') }}</span><div class="ap-seg"><button :class="{ on: wpApplyTarget === 'app' }" @click="wpApplyTarget = 'app'">{{ t('整窗壁纸') }}</button><button :class="{ on: wpApplyTarget === 'viz' }" @click="wpApplyTarget = 'viz'">{{ t('音符瀑布背景') }}</button></div></div>

          <div class="ap-wp-sources">
            <button :class="{ on: wpSource === 'local' }" @click="wpSource = 'local'">{{ t('本地') }}</button>
            <button :class="{ on: wpSource === 'library' }" @click="wpSource = 'library'">{{ t('壁纸库') }}</button>
            <button :class="{ on: wpSource === 'we' }" @click="wpSource = 'we'">Wallpaper Engine</button>
          </div>

          <template v-if="wpSource === 'local'">
            <template v-if="!isVizTarget">
              <div class="ap-preview" :class="{ empty: !hasWallpaper }">
                <img v-if="hasWallpaper && isImage && previewUrl" :src="previewUrl" alt="" />
                <div v-else class="ap-preview-ph"><Icon :name="hasWallpaper ? 'play' : 'wallpaper'" :size="30" /><span>{{ hasWallpaper ? wpName : t('选择一张壁纸或导入图片') }}</span></div>
                <span v-if="hasWallpaper" class="ap-preview-tag">{{ isImage ? t('普通壁纸') : t('动态壁纸') }} · {{ wpName }}</span>
              </div>
              <div class="ap-wp-actions">
                <button class="btn sm" @click="pickImage">{{ t('导入图片') }}</button>
                <button v-if="isImage && hasWallpaper" class="btn sm" @click="setDesktopWallpaper">{{ t('设为桌面壁纸') }}</button>
                <button v-if="hasWallpaper" class="btn sm ghost" @click="toggleWallpaper">{{ t('关闭壁纸') }}</button>
                <button v-else class="btn sm ghost" @click="toggleWallpaper">{{ t('启用壁纸') }}</button>
              </div>
              <div class="ap-row"><span>{{ t('适配方式') }}</span><div class="ap-seg"><button :class="{ on: fit === 'cover' }" @click="setFit('cover')">{{ t('填充') }}</button><button :class="{ on: fit === 'contain' }" @click="setFit('contain')">{{ t('完整显示') }}</button></div></div>
              <div class="ap-slider"><label>{{ t('模糊') }}<b>{{ blur }} px</b></label><input type="range" min="0" max="24" step="1" :value="blur" @input="blur = Number($event.target.value)" /></div>
            </template>
            <template v-else>
              <div class="ap-modes ap-viz-modes">
                <button :class="{ on: vbg.mode === 'theme' }" @click="setVizMode('theme')">{{ t('主题') }}</button>
                <button :class="{ on: vbg.mode === 'solid' }" @click="setVizMode('solid')">{{ t('纯色') }}</button>
                <button :class="{ on: vbg.mode === 'image' }" @click="setVizMode('image')">{{ t('图片') }}</button>
                <button :class="{ on: vbg.mode === 'wallpaper' }" @click="setVizMode('wallpaper')">{{ t('动态壁纸') }}</button>
                <button :class="{ on: vbg.mode === 'transparent' }" @click="setVizMode('transparent')">{{ t('透明') }}</button>
              </div>
              <div v-if="vbg.mode === 'solid'" class="ap-row"><span>{{ t('背景色') }}</span><input type="color" class="ap-color-input" :value="vbg.color" @input="vbg.color = $event.target.value; saveVizBg()" /></div>
              <div class="ap-wp-actions"><button class="btn sm" @click="pickVizImage"><Icon name="folder" :size="13" />{{ t('选择图片') }}</button><button v-if="vbg.wallPath || vbg.path" class="btn sm ghost" @click="clearLocal">{{ t('清除') }}</button></div>
              <template v-if="vbg.mode === 'image' || vbg.mode === 'wallpaper'">
                <div class="ap-slider"><label>{{ t('模糊') }}<b>{{ vbg.blur }} px</b></label><input type="range" min="0" max="40" step="1" :value="vbg.blur" @input="vbg.blur = Number($event.target.value); saveVizBg()" /></div>
                <div class="ap-slider"><label>{{ t('暗化') }}<b>{{ Math.round(vbg.dim * 100) }}%</b></label><input type="range" min="0" max="80" step="5" :value="Math.round(vbg.dim * 100)" @input="vbg.dim = Number($event.target.value) / 100; saveVizBg()" /></div>
              </template>
            </template>
          </template>

          <template v-else-if="wpSource === 'library'">
            <WallpaperLibrary class="ap-library" :target="wpApplyTarget" />
          </template>

          <template v-else>
            <WallpaperEnginePanel :target="wpApplyTarget" />
          </template>

          <p class="ap-note">{{ isVizTarget ? t('这里只控制音符瀑布背景，不影响整窗壁纸。') : t('同一时间只使用一个整窗背景，切换来源会替换旧背景。') }}</p>
        </section>

        <section v-show="tab === 'display'" class="ap-sec ap-sec-first">
          <div class="ap-sec-head"><span>{{ t('显示与语言') }}</span></div>
          <div class="ap-row"><span>{{ t('界面字号') }}</span><div class="ap-seg"><button :class="{ on: fontSize === 'standard' }" @click="setFont('standard')">{{ t('标准') }}</button><button :class="{ on: fontSize === 'large' }" @click="setFont('large')">{{ t('大') }}</button><button :class="{ on: fontSize === 'xlarge' }" @click="setFont('xlarge')">{{ t('超大') }}</button></div></div>
          <div class="ap-row"><span>{{ t('界面密度') }}</span><div class="ap-seg"><button :class="{ on: density === 'compact' }" @click="setDensity('compact')">{{ t('紧凑') }}</button><button :class="{ on: density === 'comfortable' }" @click="setDensity('comfortable')">{{ t('舒适') }}</button><button :class="{ on: density === 'relaxed' }" @click="setDensity('relaxed')">{{ t('宽松') }}</button></div></div>
          <div class="ap-slider"><label>{{ t('界面缩放') }}<b>{{ Math.round(uiScale * 100) }}%</b></label><input type="range" :min="UI_SCALE_MIN" :max="UI_SCALE_MAX" :step="UI_SCALE_STEP" :value="uiScale" @input="setUiScale($event.target.value)" /></div>
          <div class="ap-row"><span>{{ t('界面语言') }}</span><select class="ap-select" :value="lang" @change="setLanguage($event.target.value)"><option value="zh">简体中文</option><option value="zh-Hant">繁體中文</option><option value="en">English</option><option value="ja">日本語</option></select></div>
          <div class="ap-row"><span>{{ t('减少动态效果') }}</span><button class="ap-switch" :class="{ on: reduceMotion }" :aria-pressed="reduceMotion" @click="toggleMotion"><i></i></button></div>
          <p class="ap-note">{{ t('关闭过渡与壁纸动效，适合长时间工作或低性能设备。') }}</p>
        </section>

        <footer class="ap-foot">
          <button class="btn sm ghost" @click="openSound"><Icon name="volume" :size="13" /> {{ t('音效设置') }}</button>
          <span class="ap-note">{{ t('设置会立即应用并记住。') }}</span>
        </footer>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.ap-material-grid { display: flex; gap: var(--sp-2); flex-wrap: wrap; justify-content: flex-end; }
.ap-material { width: 46px; border: 1px solid var(--hairline); border-radius: var(--r-sm); background: var(--surface); color: var(--text3); padding: 3px 2px; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); }
.ap-material.on { border-color: var(--accent-sky); color: var(--text); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent-sky) 30%, transparent); }
.ap-material i { width: 28px; height: 12px; border-radius: var(--r-sm); border: 1px solid color-mix(in srgb, var(--text) 12%, transparent); }
.ap-material.mat-default i { background: var(--surface-soft); }
.ap-material.mat-glass i { background: linear-gradient(135deg, rgba(255,255,255,.52), rgba(140,190,255,.15)); backdrop-filter: blur(5px); }
.ap-material.mat-acrylic i { background: linear-gradient(120deg, rgba(255,255,255,.68), rgba(150,170,220,.28)); }
.ap-material.mat-mica i { background: linear-gradient(145deg, rgba(255,255,255,.55), rgba(90,140,210,.22) 55%, rgba(255,255,255,.24)); }
.ap-material.mat-frosted i { background: rgba(220,230,245,.48); filter: blur(1px); }
.ap-material.mat-velvet i { background: radial-gradient(circle at 30% 20%, rgba(255,255,255,.22), rgba(30,35,55,.92)); }

.ap-tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; padding: 2px; margin-bottom: var(--sp-2); border: 1px solid var(--hairline); border-radius: var(--r-md); background: var(--surface-soft); }
.ap-tabs button { border: 0; border-radius: var(--r-sm); padding: var(--sp-2); background: transparent; color: var(--text3); font-size: var(--fs-sm); cursor: pointer; }
.ap-tabs button.on { background: var(--surface); color: var(--text); box-shadow: var(--sh-1); }
.ap-sec-first { border-top: 0; padding-top: var(--sp-3); }
.ap-wp-sources { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--sp-1); margin-top: var(--sp-3); }
.ap-wp-sources button { border: 1px solid var(--hairline); border-radius: var(--r-sm); background: var(--surface); color: var(--text3); padding: 6px; font-size: var(--fs-xs); cursor: pointer; }
.ap-wp-sources button.on { color: var(--text); border-color: color-mix(in srgb, var(--accent-sky) 45%, var(--hairline)); background: color-mix(in srgb, var(--accent-sapphire) 10%, var(--surface)); }
.ap-row-tight { margin-top: var(--sp-3); }

.ap-mask { position: fixed; inset: 0; z-index: var(--z-overlay); background: color-mix(in srgb, var(--canvas) 38%, transparent); }
.ap-drawer { position: absolute; right: 0; top: 0; bottom: 0; overflow-y: auto; background-color: color-mix(in srgb, var(--canvas) 92%, transparent); backdrop-filter: var(--glass-blur); border-left: 1px solid color-mix(in srgb, var(--ornament) 34%, var(--hairline)); box-shadow: var(--sh-3); padding: var(--sp-5); color: var(--text); animation: ap-in var(--motion-base) var(--ease-out); }
@keyframes ap-in { from { opacity: 0; transform: translateX(18px); } to { opacity: 1; transform: none; } }
.ap-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-3); margin-bottom: var(--sp-5); }
.ap-eyebrow { color: var(--accent-sky); font: var(--fs-xs) var(--font-num); letter-spacing: .16em; }
.ap-head h2 { margin: var(--sp-1) 0 0; font-size: var(--fs-xl); letter-spacing: -.02em; }
.ap-sec { padding: var(--sp-4) 0; border-top: 1px solid var(--hairline); }
.ap-sec-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); margin-bottom: var(--sp-2); font-size: var(--fs-sm); font-weight: 700; color: var(--text); }
.ap-link { border: 0; background: transparent; color: var(--accent-sky); font-size: var(--fs-xs); cursor: pointer; display: inline-flex; align-items: center; gap: var(--sp-1); }
.ap-modes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; padding: 2px; border: 1px solid var(--hairline); border-radius: var(--r-md); background: var(--surface-soft); }
.ap-modes button { border: 0; border-radius: var(--r-sm); padding: var(--sp-2); color: var(--text3); background: transparent; font-size: var(--fs-sm); cursor: pointer; }
.ap-modes button.on { background: var(--surface); color: var(--text); box-shadow: var(--sh-1); }
.ap-th-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-2); margin-top: var(--sp-2); }
.ap-th { position: relative; text-align: left; display: grid; grid-template-columns: 20px 1fr; gap: var(--sp-1) var(--sp-2); align-items: center; padding: var(--sp-2); border: 1px solid var(--hairline); border-radius: var(--r-md); background: color-mix(in srgb, var(--surface) 58%, transparent); color: var(--text); cursor: pointer; }
.ap-th:hover { border-color: color-mix(in srgb, var(--accent-sky) 35%, var(--hairline)); }
.ap-th.on { border-color: var(--accent-sky); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-sky) 20%, transparent); }
.ap-th i { width: 20px; height: 20px; border-radius: var(--r-sm); display: block; }
.ap-th b { font-size: var(--fs-sm); font-weight: 600; }
.ap-th small { grid-column: 2; font-size: var(--fs-xs); color: var(--text3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ap-th-check { position: absolute; right: var(--sp-1); top: var(--sp-1); color: var(--accent-sky); }
.ap-note { margin: var(--sp-2) 0 0; color: var(--text3); font-size: var(--fs-xs); line-height: 1.6; }
.ap-state { color: var(--text3); font-size: var(--fs-xs); font-weight: 400; }
.ap-state.on { color: var(--accent-sky); }
.ap-wp-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; padding: 2px; border: 1px solid var(--hairline); border-radius: var(--r-md); background: var(--surface-soft); }
.ap-wp-tabs button { display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-1); border: 0; border-radius: var(--r-sm); padding: var(--sp-2); background: transparent; color: var(--text3); font-size: var(--fs-sm); cursor: pointer; }
.ap-wp-tabs button.on { background: var(--surface); color: var(--text); box-shadow: var(--sh-1); }
.ap-preview { position: relative; height: 152px; margin-top: var(--sp-2); border: 1px solid var(--hairline); border-radius: var(--r-md); overflow: hidden; background: linear-gradient(135deg, color-mix(in srgb, var(--accent-sapphire) 16%, var(--surface)), var(--surface-soft)); }
.ap-preview img { width: 100%; height: 100%; object-fit: cover; opacity: .72; }
.ap-preview-ph { width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-1); color: var(--text3); font-size: var(--fs-xs); }
.ap-preview-tag { position: absolute; left: var(--sp-2); bottom: var(--sp-2); max-width: calc(100% - var(--sp-4)); padding: 2px var(--sp-2); border-radius: var(--r-pill); background: color-mix(in srgb, var(--canvas) 70%, transparent); color: var(--text2); font-size: var(--fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ap-wp-actions { display: flex; gap: var(--sp-2); margin-top: var(--sp-2); flex-wrap: wrap; }
.ap-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); margin-top: var(--sp-3); font-size: var(--fs-sm); color: var(--text2); }
.ap-seg { display: inline-flex; padding: 2px; border: 1px solid var(--hairline); border-radius: var(--r-sm); background: var(--surface-soft); }
.ap-seg button { border: 0; background: transparent; color: var(--text3); min-height: 28px; padding: 0 var(--sp-2); border-radius: var(--r-xs); font-size: var(--fs-xs); cursor: pointer; }
.ap-seg button.on { background: var(--surface); color: var(--text); }
.ap-slider { margin-top: var(--sp-3); }
.ap-slider label { display: flex; align-items: center; justify-content: space-between; color: var(--text2); font-size: var(--fs-sm); }
.ap-slider label b { color: var(--accent-sky); font: var(--fs-xs) var(--font-num); }
.ap-slider input { width: 100%; accent-color: var(--accent-sapphire); margin-top: var(--sp-1); }
.ap-switch { width: 34px; height: 18px; border-radius: var(--r-pill); border: 1px solid var(--hairline); background: var(--surface-soft); position: relative; cursor: pointer; }
.ap-switch i { position: absolute; width: 12px; height: 12px; border-radius: 50%; left: 2px; top: 2px; background: var(--text3); transition: transform var(--dur-1), background var(--dur-1); }
.ap-switch.on { background: color-mix(in srgb, var(--accent-sapphire) 38%, var(--surface)); border-color: color-mix(in srgb, var(--accent-sky) 40%, var(--hairline)); }
.ap-switch.on i { transform: translateX(16px); background: var(--accent-sky); }
.ap-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); padding-top: var(--sp-4); border-top: 1px solid var(--hairline); }
.ap-foot .ap-note { margin: 0; }
@media (max-width: 640px) { .ap-drawer { width: 100vw; padding: var(--sp-4); } }
.ap-color { display: flex; align-items: center; gap: var(--sp-2); }
.ap-color input[type="color"] { width: 34px; height: 24px; padding: 0; border: 1px solid var(--hairline); border-radius: var(--r-sm); background: none; cursor: pointer; }
.ap-select { border: 1px solid var(--hairline); border-radius: var(--r-sm); background: var(--surface-soft); color: var(--text); padding: var(--sp-1) var(--sp-2); font-size: var(--fs-sm); }
.ap-library { margin-top: var(--sp-3); border-top: 1px solid var(--hairline); padding-top: var(--sp-3); }
.ap-drawer { width: min(580px, 94vw) !important; }
.ap-viz-modes { grid-template-columns: repeat(3, 1fr); }
.ap-color-input { width: 44px; height: 26px; border: 1px solid var(--hairline); border-radius: var(--r-sm); background: transparent; padding: 1px; }
.ap-subsec { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--hairline); }
.ap-subsec .ap-sec-head { margin-bottom: 8px; }
</style>