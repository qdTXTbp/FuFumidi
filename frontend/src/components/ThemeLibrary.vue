<script setup>
// 主题库：深色 / 浅色两大分类，点击卡片立即换肤（同一主题两种明暗基底各自成卡）；
// 上传图片提取主色生成自定义主题（两个分类中各有一张卡，按所在分类的基底应用）
import { ref, computed, onMounted } from 'vue';
import Icon from './Icon.vue';
import { useAppStore } from '../stores/app';
import { t } from '../core/i18n.js';

const app = useAppStore();
const state = app;
const toast = (m, t) => app.toast(m, t);
import { THEMES, themePreviewPal, saveTheme, saveCustomHue, loadCustomHue, extractAccentFromImage, loadMode } from '../core/theme.js';

const bridge = window.fuBridge;

const fileInput = ref(null);
const current = ref('fufu');
const curMode = ref('light');
const customAccent = ref('');
const customHue = ref(213);

const COLOR_THEMES = THEMES.filter(x => x.id !== 'light' && x.id !== 'hc');

// 两大分类：深色（各主题暗色版 + 高对比 + 自定义）/ 浅色（各主题亮色版 + 经典浅色 + 自定义）
const SECTIONS = [
  { mode: 'dark', label: '深色主题', ic: 'moon' },
  { mode: 'light', label: '浅色主题', ic: 'sun' },
];
function buildList(mode) {
  const list = COLOR_THEMES.map(x => ({ ...x, mode }));
  list.push(mode === 'dark'
    ? { id: 'hc', name: '高对比', desc: '无障碍 · 黑底高亮', accent: '#00ffcc', accent2: '#66ffdd', hue: 170, mode }
    : { id: 'light', name: '经典浅色', desc: '明亮通透 · 适合白天', accent: '#3a7ad9', accent2: '#4f94e0', hue: 174, mode });
  if (customAccent.value) {
    list.push({ id: 'custom', name: t('自定义主题'), desc: t('由你的图片生成'), accent: customAccent.value, hue: customHue.value, custom: true, mode });
  }
  for (const th of list) th._pal = themePreviewPal(th, mode);
  return list;
}
const darkList = computed(() => buildList('dark'));
const lightList = computed(() => buildList('light'));
const listFor = (mode) => (mode === 'dark' ? darkList.value : lightList.value);

function isActive(th) {
  return current.value === th.id && curMode.value === th.mode;
}

onMounted(async () => {
  // 当前主题高亮：localStorage 优先，settings 兜底
  curMode.value = loadMode();
  try { customAccent.value = localStorage.getItem('fufumidi_accent') || ''; } catch (e) {}
  customHue.value = loadCustomHue();
  let lsTheme = null;
  try { lsTheme = localStorage.getItem('fufumidi_theme'); } catch (e) {}
  if (lsTheme) { current.value = lsTheme; return; }
  if (bridge && bridge.getSettings) {
    try { const s = await bridge.getSettings() || {}; if (s.theme) current.value = s.theme; } catch (e) {}
  }
});

function pickTheme(th) {
  current.value = th.id;
  curMode.value = th.mode;
  saveTheme(th.id, th.custom ? customAccent.value : '', th.mode);
  toast(t('已应用主题：') + t(th.name) + ' · ' + t(th.mode === 'dark' ? '深色' : '浅色'));
}

async function onImage(e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const { accentHex, hue } = await extractAccentFromImage(f);
    customAccent.value = accentHex;
    customHue.value = Array.isArray(hue) ? (hue[0] || 0) : 213;
    saveCustomHue(customHue.value);
    current.value = 'custom';
    saveTheme('custom', accentHex, curMode.value);
    toast(t('已生成自定义主题'));
  } catch (err) {
    toast(t('生成失败：') + String(err.message || err), 'error');
  }
}
</script>

<template>
  <div class="overlay" @click.self="state.ui.themesOpen = false">
    <div class="overlay-card thm-lib" style="width:780px">
      <div class="settings-head">
        <Icon name="palette" :size="17" />
        <span class="settings-title">{{ t('主题库') }}</span>
      </div>
      <p class="ov-note">{{ t('点击卡片立即换肤。每个主题都有深色与浅色两种基底，也可自定义强调色。') }}</p>

      <div class="thm-body">
        <div class="thm-sec" v-for="sec in SECTIONS" :key="sec.mode">
          <div class="thm-sec-head">
            <Icon :name="sec.ic" :size="13" />
            <span>{{ t(sec.label) }}</span>
            <em>{{ listFor(sec.mode).length }}</em>
          </div>
          <div class="thm-grid">
            <div class="thm-card" v-for="th in listFor(sec.mode)" :key="sec.mode + '-' + th.id"
                 :class="{ on: isActive(th) }" @click="pickTheme(th)">
              <div class="thm-prev" :style="{ background: th._pal.bg1, borderColor: th._pal.border }">
                <div class="thp-side" :style="{ background: th._pal.bg2 }">
                  <i :style="{ background: th._pal.accent }"></i>
                  <i :style="{ background: th._pal.border2 }"></i>
                  <i :style="{ background: th._pal.border2 }"></i>
                </div>
                <div class="thp-main">
                  <i :style="{ background: th._pal.border2 }"></i>
                  <i class="short" :style="{ background: th._pal.border }"></i>
                  <span class="thp-btn" :style="{ background: th._pal.accent }"></span>
                </div>
              </div>
              <div class="thm-name">
                {{ t(th.name) }}
                <span class="thm-badge" :style="{ background: th._pal.accent }"></span>
              </div>
              <div class="thm-desc">{{ t(th.desc) }}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="thm-custom">
        <span>{{ t('上传一张图片，自动提取特征色生成专属主题') }}</span>
        <button class="btn sm" @click="fileInput && fileInput.click()">📁 {{ t('选择图片生成主题') }}</button>
        <input ref="fileInput" type="file" accept="image/*" hidden @change="onImage" />
      </div>
      <div class="thm-custom" style="margin-top:10px">
        <span>{{ t('视频动态壁纸') }}</span>
        <button class="btn sm" @click="state.ui.wallpaperOpen = true; state.ui.themesOpen = false">🎬 {{ t('壁纸库') }}</button>
      </div>
    </div>
  </div>
</template>
