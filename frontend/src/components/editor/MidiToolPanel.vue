<script setup>
// 参数化 MIDI 工具面板（M2）：左边选工具、右边拖参数，**拖到哪听到/看到哪**。
//
// ★ 关键交互（借 Ableton Live 的 MIDI 工具 / Studio One 的 Note FX）：
//   拖动滑杆时立刻把变换套到选中的音符上（预览），但不写撤销栈；
//   Esc 一次还原，回车/「应用」才提交成**一个**撤销点。
//   面板本身不认识任何具体工具：工具表来自 core/midi-tools.js，控件由 params 生成。
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import Icon from '../Icon.vue';
import { t } from '../../core/i18n.js';
import {
  TOOL_GROUPS, MIDI_TOOLS, toolById, toolsOfGroup, defaultParams, formatParam,
  loadPresets, savePreset, deletePreset,
} from '../../core/midi-tools.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  editor: { type: Object, default: null },   // EditorCanvas 暴露出来的对象
  ctx: { type: Object, default: () => ({}) },// { tpb, scalePcs, track }
  selCount: { type: Number, default: 0 },
  initialTool: { type: String, default: '' },   // 从命令面板 / 右键菜单直达某条工具
});
const emit = defineEmits(['close']);

const toolId = ref(MIDI_TOOLS[0].id);
const params = ref(defaultParams(MIDI_TOOLS[0]));
const changed = ref(0);
const presets = ref(loadPresets());
const presetName = ref('');
const scaleOk = computed(() => Array.isArray(props.ctx && props.ctx.scalePcs) && props.ctx.scalePcs.length > 0);

const cur = computed(() => toolById(toolId.value) || MIDI_TOOLS[0]);
const curPresets = computed(() => (presets.value[toolId.value] || []));

function preview() {
  const ed = props.editor;
  if (!ed || !ed.previewing || !ed.previewing()) return;
  const tool = cur.value;
  const p = { ...params.value };
  changed.value = ed.applyPreviewNow((notes) => tool.apply(notes, p, props.ctx)) || 0;
}
function pick(id) {
  if (id === toolId.value) return;
  toolId.value = id;
  params.value = defaultParams(cur.value);
  presetName.value = '';
  preview();
}
function resetParams() { params.value = defaultParams(cur.value); preview(); }
function dice(k) { params.value[k] = Math.floor(Math.random() * 10000); preview(); }
function onInput() { preview(); }
function applyIt() {
  const ed = props.editor;
  if (!ed) return;
  if (!changed.value) return;                      // 没有变化就不提交（避免撤销栈里多一条空记录）
  const n = ed.commitPreview() || 0;
  emit('close', { applied: true, changed: n, tool: t(cur.value.name) });
}
function cancelIt() {
  const ed = props.editor;
  if (ed && ed.previewing && ed.previewing()) ed.cancelPreview();
  emit('close', { applied: false, changed: 0, tool: '' });
}
function loadPreset(rec) {
  params.value = { ...defaultParams(cur.value), ...(rec.params || {}) };
  presetName.value = rec.name;
  preview();
}
function doSavePreset() {
  const name = (presetName.value || '').trim();
  if (!name) return;
  presets.value = { ...presets.value, [toolId.value]: savePreset(toolId.value, name, params.value) };
}
function doDeletePreset(name) {
  presets.value = { ...presets.value, [toolId.value]: deletePreset(toolId.value, name) };
  if (presetName.value === name) presetName.value = '';
}
function onKey(e) {
  if (!props.open) return;
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') { if (e.key !== 'Escape') return; }
  if (e.key === 'Escape') { e.preventDefault(); cancelIt(); return; }
  if (e.key === 'Enter') { e.preventDefault(); applyIt(); }
}
window.addEventListener('keydown', onKey);
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

/* 打开 = 开始预览；关闭由按钮负责（父组件只切 open） */
watch(() => props.open, (v) => {
  if (v) {
    const ed = props.editor;
    const n = ed && ed.beginPreview ? ed.beginPreview() : 0;
    if (!n) { emit('close', { applied: false, changed: 0, tool: '' }); return; }
    toolId.value = toolById(props.initialTool) ? props.initialTool : MIDI_TOOLS[0].id;
    params.value = defaultParams(cur.value);
    changed.value = 0;
    preview();
  }
});
</script>

<template>
  <Transition name="ov">
  <div v-if="open" class="mtp-mask" @click.self="cancelIt">
    <div class="mtp-card">
      <div class="mtp-head">
        <b>{{ t('参数化工具') }}</b>
        <span class="muted small">{{ t('拖动即预览 · Esc 还原 · 回车应用') }}</span>
        <span class="mtp-count">{{ t('选中 ') }}{{ selCount }}{{ t(' 个音符') }}</span>
        <button class="icon-btn" style="margin-left:auto" :title="t('取消并还原')" @click="cancelIt"><Icon name="minus" :size="14" /></button>
      </div>

      <div class="mtp-body">
        <div class="mtp-list">
          <div v-for="g in TOOL_GROUPS" :key="g" class="mtp-grp">
            <div class="mtp-grp-h">{{ t(g) }}</div>
            <button v-for="tool in toolsOfGroup(g)" :key="tool.id" class="mtp-item"
                    :class="{ on: toolId === tool.id }" @click="pick(tool.id)">{{ t(tool.name) }}</button>
          </div>
        </div>

        <div class="mtp-form">
          <div class="mtp-title">
            <b>{{ t(cur.name) }}</b>
            <span class="muted small">{{ t(cur.hint) }}</span>
          </div>

          <div v-for="p in cur.params" :key="p.k" class="mtp-row">
            <span class="mtp-lab">{{ t(p.label) }}</span>
            <template v-if="p.type === 'int' || p.type === 'float'">
              <input class="mtp-range" type="range" :min="p.min" :max="p.max" :step="p.step || 1"
                     v-model.number="params[p.k]" @input="onInput" />
              <input class="num-input" type="number" :min="p.min" :max="p.max" :step="p.step || 1"
                     v-model.number="params[p.k]" @input="onInput" />
              <button v-if="p.dice" class="icon-btn" :title="t('换一个随机种子')" @click="dice(p.k)">⚄</button>
              <em class="mtp-val">{{ formatParam(p, params[p.k]) }}</em>
            </template>
            <template v-else-if="p.type === 'enum'">
              <select class="select-input" v-model="params[p.k]" @change="onInput">
                <option v-for="o in p.options" :key="o[0]" :value="o[0]">{{ t(o[1]) }}</option>
              </select>
            </template>
            <template v-else-if="p.type === 'bool'">
              <label class="mtp-check"><input type="checkbox" v-model="params[p.k]" @change="onInput" /><span>{{ formatParam(p, params[p.k]) }}</span></label>
            </template>
          </div>

          <div v-if="cur.id === 'scaleSnap' && !scaleOk" class="mtp-warn">
            {{ t('当前没有设定音阶（「更多 → 音阶」里选一个调），这条工具不会改变任何音符。') }}
          </div>

          <div class="mtp-presets">
            <span class="mtp-lab">{{ t('预设') }}</span>
            <button v-for="r in curPresets" :key="r.name" class="mtp-chip" :title="t('载入该预设')"
                    @click="loadPreset(r)">{{ r.name }}<i class="mtp-x" :title="t('删除预设')" @click.stop="doDeletePreset(r.name)">✕</i></button>
            <input class="text-input mtp-name" v-model="presetName" :placeholder="t('预设名')" @keyup.enter="doSavePreset" />
            <button class="btn sm" :disabled="!presetName.trim()" @click="doSavePreset">{{ t('保存') }}</button>
          </div>
        </div>
      </div>

      <div class="mtp-foot">
        <span class="mtp-changed" :class="{ zero: !changed }">
          {{ changed ? t('将改动 ') + changed + t(' 个音符') : t('当前参数下没有变化') }}
        </span>
        <button class="btn sm" @click="resetParams">{{ t('重置参数') }}</button>
        <button class="btn sm" @click="cancelIt">{{ t('取消') }}</button>
        <button class="btn sm primary" :disabled="!changed" @click="applyIt">{{ t('应用（回车）') }}</button>
      </div>
    </div>
  </div>
  </Transition>
</template>

<style scoped>
/* 弹窗外壳自带一份样式：.ed-modal* 是 ViewEdit 的**作用域**样式（scoped），
   在别的组件里不生效 —— 之前面板没遮罩、不居中、内容被页面穿透就是这个原因。 */
.mtp-mask { position: fixed; inset: 0; background: rgba(10, 10, 10, 0.35); display: flex; align-items: center; justify-content: center; z-index: var(--z-modal); }
.mtp-card { width: min(860px, 95vw); max-height: 88vh; background: var(--canvas); border-radius: 14px;
  box-shadow: 0 24px 64px rgba(16, 24, 40, 0.2); padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.mtp-head { display: flex; align-items: center; gap: 10px; font-size: 14px; color: var(--ink); }
.mtp-head b { font-size: 15px; }
.mtp-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.mtp-count { font-size: 11.5px; color: var(--accent); font-weight: 600; }
.mtp-body { display: flex; gap: 12px; min-height: 300px; }
.mtp-list { flex: none; width: 168px; display: flex; flex-direction: column; gap: 8px; max-height: 52vh; overflow-y: auto;
  border: 1px solid var(--hairline); border-radius: 10px; padding: 8px; background: var(--surface-soft); }
.mtp-grp-h { font-size: 10.5px; font-weight: 700; color: var(--stone); letter-spacing: .02em; margin: 2px 0 3px; }
.mtp-item { display: block; width: 100%; text-align: left; padding: 5px 8px; border: 1px solid transparent; border-radius: 7px;
  background: transparent; color: var(--ink); font-size: 12px; cursor: pointer; transition: background .14s ease, border-color .14s ease; }
.mtp-item:hover { background: var(--canvas); }
.mtp-item.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.mtp-form { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.mtp-title { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.mtp-title b { font-size: 14px; }
.mtp-row { display: flex; align-items: center; gap: 8px; }
.mtp-lab { flex: none; width: 74px; font-size: 11.5px; color: var(--stone); }
.mtp-range { flex: 1; min-width: 0; accent-color: var(--accent); }
.mtp-row .num-input { width: 64px; }
.mtp-val { flex: none; width: 62px; text-align: right; font-family: var(--mono); font-size: 11px; color: var(--slate); }
.mtp-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--slate); }
.mtp-warn { font-size: 11.5px; color: var(--warn, #b26a00); background: var(--surface-soft); border: 1px dashed var(--hairline); border-radius: 8px; padding: 6px 8px; }
.mtp-presets { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: auto; padding-top: 8px; border-top: 1px dashed var(--hairline); }
.mtp-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border: 1px solid var(--hairline); border-radius: 999px;
  background: var(--canvas); color: var(--ink); font-size: 11.5px; cursor: pointer; }
.mtp-chip:hover { border-color: var(--accent); }
.mtp-x { font-style: normal; color: var(--stone); font-size: 10px; }
.mtp-x:hover { color: var(--error, #d33); }
.mtp-name { width: 120px; }
.mtp-changed { margin-right: auto; font-size: 11.5px; color: var(--accent); font-weight: 600; }
.mtp-changed.zero { color: var(--stone); font-weight: 400; }
</style>
