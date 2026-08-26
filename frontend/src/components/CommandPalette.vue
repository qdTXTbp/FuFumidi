<script setup>
// 命令面板（Ctrl+K）：搜索过滤命令列表，回车执行
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import Icon from './Icon.vue';
import { useAppStore, VIEWS } from '../stores/app';
import { t } from '../core/i18n.js';

const app = useAppStore();
const state = app;
const setView = (v) => app.setView(v);
const importFiles = (items) => app.importFiles(items);
const togglePlay = () => app.togglePlay();
const toggleLoop = () => app.toggleLoop();
const toggleMetro = () => app.toggleMetro();
const toast = (m, t) => app.toast(m, t);

const query = ref('');
const idx = ref(0);
const inputEl = ref(null);
const fileInput = ref(null);

const VIEW_ICONS = { home: 'home', play: 'play2', lyrics: 'music', edit: 'edit', viz: 'viz', analyze: 'chart', score: 'score', transcribe: 'transcribe', convert: 'convert' };

function close() { state.ui.paletteOpen = false; }

/* ---------------- 命令定义 ---------------- */
function buildCommands() {
  return [
    ...VIEWS.map(v => ({
      group: t('视图'),
      label: t(v.label),
      icon: VIEW_ICONS[v.id] || 'dot',
      run: () => { setView(v.id); close(); },
    })),
    {
      group: t('文件'),
      label: t('导入 MIDI'),
      icon: 'import',
      run: () => { close(); nextTick(() => fileInput.value && fileInput.value.click()); },
    },
    {
      group: t('系统'),
      label: t('打开设置'),
      icon: 'gear',
      run: () => { close(); state.ui.settingsOpen = true; },
    },
    {
      group: t('系统'),
      label: t('主题库'),
      icon: 'palette',
      run: () => { close(); state.ui.themesOpen = true; },
    },
    {
      group: t('系统'),
      label: t('新手引导'),
      icon: 'info',
      run: () => { close(); state.ui.guideOpen = true; },
    },
    {
      group: t('播放控制'),
      label: t('播放 / 暂停'),
      icon: 'play',
      run: () => { togglePlay(); close(); },
    },
    {
      group: t('播放控制'),
      label: t('切换循环'),
      icon: 'loop',
      run: () => { toggleLoop(); close(); },
    },
    {
      group: t('播放控制'),
      label: t('切换节拍器'),
      icon: 'metro',
      run: () => { toggleMetro(); close(); },
    },
  ];
}
const commands = ref(buildCommands());

/* ---------------- 过滤与分组 ---------------- */
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return commands.value;
  return commands.value.filter(c => (c.label + ' ' + c.group).toLowerCase().includes(q));
});
const groups = computed(() => {
  const map = {};
  for (const c of filtered.value) (map[c.group] = map[c.group] || []).push(c);
  return Object.entries(map);
});
watch(filtered, () => { idx.value = 0; });
// 语言切换时命令文案需要重建（label 来自 t()）
watch(() => state.ui.paletteOpen, (open) => { if (open) commands.value = buildCommands(); });

function runAt(i) {
  const c = filtered.value[i];
  if (c) { try { c.run(); } catch (e) { toast(String(e.message || e), 'error'); } }
}

/* ---------------- 键盘导航 ---------------- */
function onKey(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); idx.value = Math.min(idx.value + 1, filtered.value.length - 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); idx.value = Math.max(idx.value - 1, 0); }
  else if (e.key === 'Enter') { e.preventDefault(); runAt(idx.value); }
  else if (e.key === 'Escape') { e.preventDefault(); close(); }
}

onMounted(async () => { await nextTick(); inputEl.value && inputEl.value.focus(); });

/* ---------------- 导入 MIDI（命令面板内隐藏文件选择） ---------------- */
function onFileChange(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  Promise.all(files.map(f => f.arrayBuffer())).then(bufs => {
    importFiles(files.map((f, i) => ({ name: f.name, bytes: new Uint8Array(bufs[i]) })));
  }).catch(() => {});
  e.target.value = '';
}
</script>

<template>
  <div class="overlay top-aligned" @click.self="close">
    <div class="cmd-palette" role="dialog" aria-label="命令面板">
      <input ref="inputEl" v-model="query" class="cmd-input" :placeholder="t('输入命令或搜索…')" @keydown="onKey" />
      <div class="cmd-list">
        <template v-for="(g, gi) in groups" :key="g[0]">
          <div class="cmd-group">{{ g[0] }}</div>
          <button class="cmd-item" v-for="c in g[1]" :key="c.label" :class="{ on: filtered.indexOf(c) === idx }" @click="runAt(filtered.indexOf(c))">
            <span class="cmd-ic"><Icon :name="c.icon" :size="14" /></span>
            <span>{{ c.label }}</span>
            <span class="cmd-hint" v-if="c.hint">{{ c.hint }}</span>
          </button>
        </template>
        <div class="cmd-empty" v-if="!filtered.length">{{ t('无') }} — {{ query }}</div>
      </div>
      <div class="cmd-foot">
        <span>↑↓ {{ t('选择') }} · Enter {{ t('执行') }} · Esc {{ t('关闭') }}</span>
        <span style="margin-left:auto"><Icon name="kbd" :size="12" /> Ctrl+K</span>
      </div>
      <input ref="fileInput" type="file" accept=".mid,.midi,.kar,.rmi" hidden multiple @change="onFileChange" />
    </div>
  </div>
</template>
