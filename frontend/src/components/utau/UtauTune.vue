<script setup>
// 调声检查器（UTAU 工作台左栏）：音符信息 + 全部调声参数 + 子音/发声 + UTAU flags
// 与曲谱同屏显示——选中音符即可在右侧曲谱与左侧参数之间来回微调
import { computed, onMounted, ref } from 'vue';
import Icon from '../Icon.vue';
import { useUtauStore, UTAU_PARAMS, paramValue } from '../../stores/utau';
import { t } from '../../core/i18n.js';

const store = useUtauStore();
const n = computed(() => store.selected);
const bridge = window.fuBridge;

function patch(p) { if (n.value) store.updateNote(n.value.id, p); }
const u = v => Math.max(0, Math.min(200, parseFloat(v) || 100));
const vf = v => Math.max(1, Math.min(12, parseFloat(v) || 5.5));
const vfd = v => Math.max(0, Math.min(2000, parseFloat(v) || 0));

/** 参数作用于整个选中集合（未多选时即当前音符）；原地拖拽不入历史 */
const ids = () => (store.selectedIds.length ? [...store.selectedIds] : (n.value ? [n.value.id] : []));
function begin() { if (ids().length) store.pushUndo(); }
function setParam(key, v) { const list = ids(); if (list.length) store.setParams(list, key, Number(v), false); }
function resetParam(key, def) { const list = ids(); if (list.length) store.setParams(list, key, def); }
function resetAll() { const list = ids(); if (list.length) store.resetParams(list); }
function val(key) { return n.value ? paramValue(n.value, key) : 0; }

// UTAU flags：引擎真实规格（utau:flags）优先，取不到时用内置兜底表（网页版/引擎缺失）
const flagsOpen = ref(false);
const flagSpecs = ref([]);
const flagUnsupported = ref([]);
const FALLBACK_FLAGS = [
  ['g', '0', '-100~100', '共振峰/性别：正更粗更男，负更细更女'],
  ['B', '50', '0~100', '气声（合成前）'],
  ['b', '0', '0~100', '气声（合成后）'],
  ['t', '0', '-100~100', '音高微调，单位 10 音分'],
  ['a', '100', '1~400', '辅音区伸缩：<100 拉长，>100 压缩'],
  ['Y', '100', '0~100', '辅音气声比例：越小咬字越清晰'],
  ['H', '0', '0~99', '低通：削高频、强调低频'],
  ['h', '0', '0~99', '强调高频（不动气声）'],
  ['C', '0', '0~100', '低通：11kHz 以上递减'],
  ['c', '50', '0~100', 'C 的共振峰前版本'],
  ['D', '0', '0~100', '削中频'],
  ['E', '0', '0~100', '削低频与高频'],
  ['P', '86', '0~100', '压限器：越小音量起伏越均衡'],
  ['F', '—', '0~40', '共振峰滤波强度（截止 = 采样基频 × F）'],
  ['L', '—', '0~100', '共振峰滤波固定频率（170Hz × L）'],
  ['N', '—', '—', '关闭共振峰处理（变调退回线性重采样）'],
];
function loadFlags() {
  if (!bridge || typeof bridge.utauFlags !== 'function') return;
  bridge.utauFlags().then(r => {
    if (r && r.ok && Array.isArray(r.supported) && r.supported.length) {
      flagSpecs.value = r.supported.map(f => [f.flag, f.default == null ? '—' : String(f.default),
        (f.min == null || f.max == null) ? '—' : f.min + '~' + f.max, f.desc]);
      flagUnsupported.value = (r.unsupported || []).map(f => f.flag + '（' + f.desc + '）');
    }
  }).catch(() => {});
}
const flagRows = computed(() => (flagSpecs.value.length ? flagSpecs.value : FALLBACK_FLAGS));
onMounted(loadFlags);
</script>

<template>
  <aside class="utn">
    <div v-if="!n" class="utn-sec utn-empty">
      <div class="utn-h"><Icon name="cursor" :size="12" />{{ t('音符检查器') }}</div>
      <p class="muted small">{{ t('在曲谱中选中一个音符即可调声。') }}</p>
    </div>

    <template v-else>
      <div class="utn-sec">
        <div class="utn-h"><Icon name="cursor" :size="12" />{{ t('音符检查器') }}</div>
        <div class="utn-row"><span>{{ t('唱音') }}</span><b>{{ n.lyric || '—' }}</b></div>
        <div class="utn-row"><span>{{ t('起点') }}</span><b>{{ n.startBeat }} {{ t('拍') }}</b></div>
        <div class="utn-row"><span>{{ t('时长') }}</span><b>{{ n.durBeat }} {{ t('拍') }}</b></div>
        <div class="utn-row"><span>{{ t('选中') }}</span><b>{{ store.selectedIds.length || 1 }}</b></div>
      </div>

      <div class="utn-sec">
        <div class="utn-h"><Icon name="spark" :size="12" />{{ t('调声参数') }}</div>
        <div v-for="p in UTAU_PARAMS" :key="p.key" class="utn-sl">
          <div class="utn-row"><span>{{ t(p.label) }}</span><b>{{ val(p.key) }}</b></div>
          <input type="range" :min="p.min" :max="p.max" step="1" :value="val(p.key)"
                 :title="t('拖动改值 · 双击复位')"
                 @pointerdown="begin" @input="e => setParam(p.key, e.target.value)" @dblclick="resetParam(p.key, p.def)" />
        </div>
        <div class="utn-btns">
          <button class="btn sm" @click="resetAll">{{ t('重置全部参数') }}</button>
        </div>
      </div>

      <div class="utn-sec">
        <div class="utn-h"><Icon name="music" :size="12" />{{ t('子音与发声') }}</div>
        <div class="utn-row"><span>{{ t('子音速度') }}</span>
          <input class="text-input utn-num" type="number" min="0" max="200" :value="n.velocity" @change="e => patch({ velocity: u(e.target.value) })" /></div>
        <div class="utn-row"><span>{{ t('音量 %') }}</span>
          <input class="text-input utn-num" type="number" min="0" max="200" :value="n.volume" @change="e => patch({ volume: u(e.target.value) })" /></div>
        <label class="utn-switch">
          <input type="checkbox" :checked="!!n.vibrato" @change="e => patch({ vibrato: !!e.target.checked })" />
          <span>{{ t('颤音') }} · {{ n.vibrato ? t('开') : t('关') }}</span>
        </label>
        <div class="utn-row" :class="{ dim: !n.vibrato }"><span>{{ t('颤音频率 Hz') }}</span>
          <input class="text-input utn-num" type="number" min="1" max="12" step="0.1" :value="n.vibFreq" :disabled="!n.vibrato" @change="e => patch({ vibFreq: vf(e.target.value) })" /></div>
        <div class="utn-row" :class="{ dim: !n.vibrato }"><span>{{ t('颤音渐入 ms') }}</span>
          <input class="text-input utn-num" type="number" min="0" max="2000" step="10" :value="n.vibFade || 0" :disabled="!n.vibrato" @change="e => patch({ vibFade: vfd(e.target.value) })" /></div>
      </div>

      <div class="utn-sec">
        <div class="utn-h utn-h-btn" @click="flagsOpen = !flagsOpen">
          <Icon name="kbd" :size="12" />{{ t('UTAU flags') }}
          <em>{{ flagsOpen ? '▾' : '▸' }}</em>
        </div>
        <input class="text-input utn-flags" :value="n.flags" :placeholder="t('如 g-10B60t5（可留空）')" @change="e => patch({ flags: e.target.value })" />
        <template v-if="flagsOpen">
          <table class="utn-flags-tb">
            <tr v-for="r in flagRows" :key="r[0]">
              <td class="f">{{ r[0] }}</td><td class="d">{{ r[1] }}</td><td class="rng">{{ r[2] }}</td><td class="desc">{{ t(r[3]) }}</td>
            </tr>
          </table>
          <div class="muted small">{{ t('引擎渲染时生效；未支持的 flag 会在渲染结果里提示。') }}</div>
          <div v-if="flagUnsupported.length" class="muted small">{{ t('不支持：') }}{{ flagUnsupported.join('、') }}</div>
        </template>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.utn { width: var(--inspector-w); flex: none; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
.utn-sec { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 9px 10px; display: flex; flex-direction: column; gap: 7px; }
.utn-h { display: flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700; color: var(--muted); }
.utn-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 12px; color: var(--stone); }
.utn-row > span { flex: none; }
.utn-row b { color: var(--ink); font-weight: 600; font-size: 11.5px; font-family: var(--mono); font-variant-numeric: tabular-nums; }
.utn-row.dim { opacity: .5; }
.utn-sl { display: flex; flex-direction: column; gap: 2px; }
.utn-sl input[type="range"] { width: 100%; accent-color: var(--accent); }
.utn-num { width: 74px; padding: 3px 6px; font-size: 12px; text-align: right; }
.utn-flags { width: 100%; padding: 5px 8px; font-size: 12px; }
.utn-switch { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink); cursor: pointer; }
.utn-btns { display: flex; gap: 5px; }
.utn-btns .btn { flex: 1; justify-content: center; font-size: 11px; padding: 3px 6px; }
.utn-empty p { margin: 0; line-height: 1.6; }
.utn-h-btn { cursor: pointer; user-select: none; }
.utn-h-btn em { margin-left: auto; font-style: normal; font-size: 10px; }
.utn-flags-tb { width: 100%; border-collapse: collapse; font-size: 10.5px; }
.utn-flags-tb td { padding: 2px 3px; border-bottom: 1px solid var(--hairline-soft); color: var(--stone); vertical-align: top; }
.utn-flags-tb td.f { color: var(--accent); font-family: var(--mono); font-weight: 700; width: 14px; }
.utn-flags-tb td.d { width: 30px; text-align: right; color: var(--ink); font-family: var(--mono); }
.utn-flags-tb td.rng { width: 60px; text-align: right; font-family: var(--mono); }
.utn-flags-tb td.desc { line-height: 1.35; }
</style>
