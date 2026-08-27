<script setup>
// 主题库：点击卡片立即换肤；上传图片提取主色生成自定义主题
import { ref, computed, onMounted } from 'vue';
import Icon from './Icon.vue';
import { useAppStore } from '../stores/app';
import { t } from '../core/i18n.js';

const app = useAppStore();
const state = app;
const toast = (m, t) => app.toast(m, t);
import { THEMES, themeSwatches, saveTheme, extractAccentFromImage, loadMode } from '../core/theme.js';

const bridge = window.fuBridge;

const fileInput = ref(null);
const current = ref('fufu');

// 自定义主题（图片生成）实时并入网格
const themeList = computed(() => {
  const list = THEMES.map(x => ({ ...x }));
  if (!list.some(x => x.id === current.value) && current.value !== 'fufu') {
    list.push({ id: current.value, name: t('自定义主题'), desc: t('由你的图片生成'), accent: '#a78bfa', accent2: '#c4b5fd', hue: 258, custom: true });
  }
  return list;
});

onMounted(async () => {
  // 当前主题高亮：localStorage 优先，settings 兜底
  let lsTheme = null;
  try { lsTheme = localStorage.getItem('fufumidi_theme'); } catch (e) {}
  if (lsTheme) { current.value = lsTheme; return; }
  if (bridge && bridge.getSettings) {
    try { const s = await bridge.getSettings() || {}; if (s.theme) current.value = s.theme; } catch (e) {}
  }
});

function pickTheme(th) {
  current.value = th.id;
  saveTheme(th.id, '', loadMode());
  toast(t('已应用主题：') + t(th.name));
}

async function onImage(e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const { accentHex } = await extractAccentFromImage(f);
    current.value = 'custom';
    saveTheme('custom', accentHex, loadMode());
    toast(t('已生成自定义主题'));
  } catch (err) {
    toast(t('生成失败：') + String(err.message || err), 'error');
  }
}
</script>

<template>
  <div class="overlay" @click.self="state.ui.themesOpen = false">
    <div class="overlay-card" style="width:640px">
      <div class="settings-head">
        <Icon name="palette" :size="17" />
        <span class="settings-title">{{ t('主题库') }}</span>
      </div>
      <p class="ov-note">{{ t('点击卡片立即换肤；可自定义强调色。') }}</p>

      <div class="thm-grid">
        <div class="thm-card" v-for="th in themeList" :key="th.id" :class="{ on: current === th.id }" @click="pickTheme(th)">
          <div class="thm-prev">
            <i v-for="(c, i) in themeSwatches(th)" :key="i" :style="{ background: c }"></i>
          </div>
          <div class="thm-name">{{ t(th.name) }}</div>
          <div class="thm-desc">{{ t(th.desc) }}</div>
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
