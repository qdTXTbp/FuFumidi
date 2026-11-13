<script setup>
// 批量导出 MusicXML：一次把曲库里多选的曲目写成多个 .musicxml 文件。
// 入口有两个：乐谱页工具栏「批量」、曲库批量管理栏「导出 XML」。
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import { t } from '../core/i18n.js';
import { fuApi } from '../api';
import { useAppStore } from '../stores/app';
import { useSettingsStore } from '../stores/settings';
import { xmlBatch, closeXmlBatch } from '../core/xml_batch_state.js';
import { loadSongForExport, jobsForSong } from '../core/xml_batch.js';

const state = useAppStore();
const settingsStore = useSettingsStore();

const mode = ref('score');        // score=整份总谱 / parts=每轨分谱
const dir = ref('');
const saveAsDefault = ref(true);
const selected = ref([]);
const running = ref(false);
const finished = ref(false);
const done = ref(0);
const total = ref(0);
const okN = ref(0);
const currentName = ref('');
const failures = ref([]);

const songs = computed(() => (state.songs || []).filter((s) => s && s.kind !== 'audio'));
const pct = computed(() => (total.value ? Math.min(1, done.value / total.value) : 0));
const summary = computed(() => t('批量导出完成：成功 {ok} 个，失败 {fail} 个')
  .replace('{ok}', okN.value).replace('{fail}', failures.value.length));
const progressText = computed(() => {
  if (running.value) return t('正在导出 {done}/{total}：{name}')
    .replace('{done}', done.value).replace('{total}', total.value).replace('{name}', currentName.value);
  return finished.value ? summary.value : '';
});

watch(() => xmlBatch.open, async (open) => {
  if (!open) return;
  running.value = false; finished.value = false; failures.value = [];
  done.value = 0; total.value = 0; okN.value = 0; currentName.value = '';
  mode.value = 'score'; saveAsDefault.value = true;
  const valid = (id) => songs.value.some((s) => s.id === id);
  const pre = (xmlBatch.preselect || []).filter(valid);
  selected.value = pre.length ? pre : (valid(state.currentId) ? [state.currentId] : []);
  let s = settingsStore.settings || {};
  try { s = (fuApi.getSettings ? await fuApi.getSettings() : null) || s; }
  catch (e) { /* 设置读不到就按未配置处理 */ }
  dir.value = String(s['export.default_dir'] || '');
});

function selectAll() { selected.value = songs.value.map((s) => s.id); }
function selectNone() { selected.value = []; }
function close() { if (!running.value) closeXmlBatch(); }

async function pickDir() {
  try {
    const p = await fuApi.pickDirectory(dir.value ? { defaultPath: dir.value } : undefined);
    if (p) dir.value = String(p);
  } catch (e) {
    state.toast(t('选择目录失败：{msg}').replace('{msg}', String((e && e.message) || e)), 'warn');
  }
}

function cleanDir(p) { return String(p || '').trim().replace(/[\\/]+$/, ''); }

async function run() {
  if (running.value) return;
  if (!selected.value.length) { state.toast(t('请先选择要导出的曲目'), 'warn'); return; }
  if (typeof fuApi.writeBinary !== 'function') { state.toast(t('桌面版才能批量导出'), 'warn'); return; }
  let outDir = cleanDir(dir.value);
  if (!outDir) {
    await pickDir();
    outDir = cleanDir(dir.value);
    if (!outDir) return;
  }
  // 一次选好目录就记住：下次单曲导出 / 批量导出的保存框都从这里开始
  if (saveAsDefault.value) {
    try { await settingsStore.save({ 'export.default_dir': outDir }); }
    catch (e) { /* 偏好没存上不影响本次导出 */ }
  }
  running.value = true; finished.value = false; failures.value = [];
  done.value = 0; total.value = selected.value.length; okN.value = 0;
  const used = new Set();
  for (const id of selected.value.slice()) {
    const item = songs.value.find((s) => s.id === id);
    currentName.value = (item && item.name) || String(id);
    try {
      const song = await loadSongForExport(item, fuApi);
      if (!song) throw new Error(t('无法解析 MIDI'));
      for (const job of jobsForSong(item, song, mode.value, used)) {
        const bytes = new TextEncoder().encode(job.xml);
        const r = await fuApi.writeBinary(outDir + '/' + job.file, Array.from(bytes));
        if (r && r.ok) okN.value += 1;
        else failures.value.push(job.file + '：' + ((r && r.error) || t('写入失败')));
      }
    } catch (e) {
      failures.value.push(currentName.value + '：' + String((e && e.message) || e));
    }
    done.value += 1;
  }
  running.value = false;
  finished.value = true;
  state.toast(summary.value, failures.value.length ? 'warn' : 'ok');
}

function openOutput() {
  if (!dir.value || !fuApi.openOutput) return;
  fuApi.openOutput(cleanDir(dir.value)).catch(() => {});
}

function onKey(e) {
  if (e.key === 'Escape' && xmlBatch.open && !running.value) closeXmlBatch();
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <Transition name="ov">
    <div v-if="xmlBatch.open" class="overlay" role="dialog" aria-modal="true" :aria-label="t('批量导出 MusicXML')" @click.self="close">
      <div class="overlay-card xbe-card">
        <div class="xbe-head">
          <b><Icon name="save" :size="16" />{{ t('批量导出 MusicXML') }}</b>
          <button class="icon-btn" :title="t('关闭')" :aria-label="t('关闭')" :disabled="running" @click="close"><Icon name="close" :size="14" /></button>
        </div>

        <div class="xbe-body">
          <p class="xbe-hint">{{ t('从曲库中选择要导出的曲目，一次生成多个 .musicxml 文件。') }}</p>

          <div class="xbe-row">
            <label class="xbe-label" for="xbe-mode">{{ t('导出内容') }}</label>
            <select id="xbe-mode" v-model="mode" class="ov-input" :disabled="running">
              <option value="score">{{ t('整份总谱（每首一个文件）') }}</option>
              <option value="parts">{{ t('每轨分谱（每首每轨一个文件）') }}</option>
            </select>
          </div>

          <div class="xbe-row">
            <label class="xbe-label" for="xbe-dir">{{ t('输出目录') }}</label>
            <input id="xbe-dir" v-model="dir" class="ov-input mono xbe-dir" :placeholder="t('留空 = 每次询问')" :aria-label="t('输出目录')" :disabled="running" />
            <button class="btn sm" :disabled="running" @click="pickDir">{{ t('浏览') }}</button>
          </div>
          <label class="ov-check xbe-default">
            <input type="checkbox" v-model="saveAsDefault" :disabled="running" />{{ t('同时设为导出默认目录') }}
          </label>

          <div class="xbe-list-head">
            <b>{{ t('曲目') }}（{{ selected.length }} / {{ songs.length }}）</b>
            <button class="btn sm ghost" :disabled="running" @click="selectAll">{{ t('全选') }}</button>
            <button class="btn sm ghost" :disabled="running" @click="selectNone">{{ t('清空所选') }}</button>
          </div>
          <div class="xbe-list">
            <label v-for="s in songs" :key="s.id" class="xbe-item">
              <input type="checkbox" :value="s.id" v-model="selected" :disabled="running" />
              <span :title="s.name">{{ s.name }}</span>
            </label>
            <div v-if="!songs.length" class="xbe-empty">{{ t('曲库里还没有 MIDI 曲目') }}</div>
          </div>

          <div v-if="running || finished" class="xbe-progress">
            <div class="xbe-pbar"><i :style="{ transform: 'scaleX(' + pct + ')' }"></i></div>
            <span class="xbe-ptxt" :title="progressText">{{ progressText }}</span>
          </div>
          <div v-if="failures.length" class="xbe-fails">
            <b>{{ t('导出失败的文件') }}</b>
            <div v-for="(f, i) in failures" :key="i" class="xbe-fail" :title="f">{{ f }}</div>
          </div>
        </div>

        <div class="xbe-foot">
          <button v-if="finished && dir" class="btn sm ghost" @click="openOutput">{{ t('打开输出目录') }}</button>
          <span class="xbe-spacer"></span>
          <button class="btn ghost" :disabled="running" @click="close">{{ finished ? t('完成') : t('取消') }}</button>
          <button class="btn primary" :disabled="running || !selected.length" @click="run">{{ t('开始导出') }}</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.xbe-card { width: min(560px, 92vw); padding: var(--sp-4); }
.xbe-head { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-2); }
.xbe-head b { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-lg); color: var(--ink); }
.xbe-head .icon-btn { margin-left: auto; }
.xbe-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: var(--sp-2); }
.xbe-hint { margin: 0; font-size: var(--fs-sm); line-height: 1.6; color: var(--text-muted, var(--stone)); }
.xbe-row { display: flex; align-items: center; gap: var(--sp-2); }
.xbe-label { flex: none; width: 80px; font-size: var(--fs-sm); color: var(--ink); }
.xbe-dir { flex: 1; min-width: 0; }
.xbe-default { font-size: var(--fs-sm); color: var(--text-muted, var(--stone)); }
.xbe-list-head { display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-1); }
.xbe-list-head b { font-size: var(--fs-sm); color: var(--ink); margin-right: auto; }
.xbe-list { display: flex; flex-direction: column; gap: 0; max-height: 220px; overflow-y: auto;
  border: 1px solid var(--hairline); border-radius: var(--r-md); padding: var(--sp-1); }
.xbe-item { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-1) var(--sp-2);
  border-radius: var(--r-sm); font-size: var(--fs-sm); color: var(--ink); cursor: pointer; }
.xbe-item:hover { background: var(--surface-muted, var(--surface-soft)); }
.xbe-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.xbe-empty { padding: var(--sp-4); text-align: center; font-size: var(--fs-sm); color: var(--text-muted, var(--stone)); }
.xbe-progress { display: flex; align-items: center; gap: var(--sp-2); }
.xbe-pbar { flex: none; width: 140px; height: 6px; border-radius: var(--r-pill); background: var(--surface-soft); overflow: hidden; }
.xbe-pbar i { display: block; height: 100%; background: var(--accent); border-radius: var(--r-pill);
  transform-origin: left; transition: transform var(--motion-base) var(--ease-out); }
.xbe-ptxt { flex: 1; min-width: 0; font-size: var(--fs-xs); color: var(--text-muted, var(--stone));
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.xbe-fails { max-height: 96px; overflow-y: auto; font-size: var(--fs-xs); color: var(--t-err); }
.xbe-fails b { display: block; margin-bottom: var(--sp-1); }
.xbe-fail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.xbe-foot { display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-3); }
.xbe-spacer { flex: 1; }
</style>
