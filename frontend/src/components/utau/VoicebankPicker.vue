<script setup>
// 统一声库选择器（UTAU 声库 ↔ DiffSinger AI 声库融合）
// ------------------------------------------------------------
// 设计目标：
//   1. 制作声库时只允许常规 UTAU 声库（见 ViewVoicebank / UtauLibrary），本组件不涉及制作；
//   2. 制作音频时可自由切换 UTAU 声库与 DiffSinger AI 声库 —— 这就是融合点。
//
// 用法：
//   <VoicebankPicker v-model="selectedDir" v-model:kind="engineKind" />
// engineKind: 'utau' | 'diffsinger'
// 切换引擎时，如果新引擎下已有对应类型的声库，会自动选中第一个可用项。
import { ref, computed, onMounted, onActivated, watch } from 'vue';
import Icon from '../Icon.vue';
import { t } from '../../core/i18n.js';

const props = defineProps({
  modelValue: { type: String, default: '' },
  kind: { type: String, default: 'utau' },       // 当前引擎
  compact: { type: Boolean, default: false },     // 紧凑模式（仅一个下拉）
  allowKindSwitch: { type: Boolean, default: true },
});
const emit = defineEmits(['update:modelValue', 'update:kind', 'change']);

const bridge = window.fuBridge;
const list = ref([]);
const loading = ref(false);
const err = ref('');
const curKind = ref(props.kind === 'diffsinger' ? 'diffsinger' : 'utau');

const ENGINE_META = {
  utau: { label: 'UTAU', desc: '常规拼接合成（音源库）' },
  diffsinger: { label: 'DiffSinger', desc: 'AI 歌声合成（神经网络）' },
};

const filtered = computed(() => list.value.filter(v => v.kind === curKind.value));
const utauCount = computed(() => list.value.filter(v => v.kind === 'utau').length);
const dsCount = computed(() => list.value.filter(v => v.kind === 'diffsinger').length);

async function refresh() {
  if (!bridge || !bridge.voicebankUnified) { err.value = t('当前环境不支持声库列表'); return; }
  loading.value = true;
  try {
    const r = await bridge.voicebankUnified();
    if (r && r.ok) {
      list.value = r.list || [];
      err.value = '';
      syncKindFromSelection();
    } else err.value = (r && r.error) || t('加载声库失败');
  } catch (e) {
    err.value = String((e && e.message) || e);
  } finally {
    loading.value = false;
  }
}

/** 依据当前已选声库回推引擎类型：避免重进页面时开关与已选声库不一致 */
function syncKindFromSelection() {
  const cur = props.modelValue;
  if (!cur) return;
  const hit = list.value.find(v => v.dir === cur);
  if (hit && hit.kind !== curKind.value) {
    curKind.value = hit.kind;
    emit('update:kind', hit.kind);
  }
}

/** 切换引擎：若当前选中的声库不属于新引擎，自动回退到该引擎下第一个可用项 */
function switchKind(k) {
  if (k === curKind.value) return;
  curKind.value = k;
  emit('update:kind', k);
  const pool = list.value.filter(v => v.kind === k);
  const stillValid = pool.some(v => v.dir === props.modelValue);
  if (!stillValid) {
    const next = pool.length ? pool[0].dir : '';
    emit('update:modelValue', next);
    emit('change', { kind: k, dir: next });
  } else {
    emit('change', { kind: k, dir: props.modelValue });
  }
}

function pick(dir) {
  emit('update:modelValue', dir);
  emit('change', { kind: curKind.value, dir });
}

function baseName(dir) { return dir ? String(dir).replace(/^.*[\\/]/, '') : ''; }

watch(() => props.kind, (v) => { if (v && v !== curKind.value) switchKind(v); });
onMounted(refresh);
// KeepAlive 保活：本组件在 <KeepAlive> 的视图树里，离开再回来不会重跑 onMounted，
// 于是「在资源中心下载完声库，回到工作台下拉里却看不到」——切回时主动重扫一次。
onActivated(refresh);
defineExpose({ refresh });
</script>

<template>
  <div class="vbp" :class="{ compact }">
    <!-- 引擎切换：UTAU ↔ DiffSinger（融合点） -->
    <div v-if="allowKindSwitch && !compact" class="vbp-engines">
      <button
        v-for="(meta, k) in ENGINE_META" :key="k"
        class="vbp-eng" :class="{ on: curKind === k }"
        :title="t(meta.desc)"
        @click="switchKind(k)"
      >
        <Icon :name="k === 'diffsinger' ? 'spark' : 'utau'" :size="13" />
        <b>{{ meta.label }}</b>
        <i>{{ k === 'utau' ? utauCount : dsCount }}</i>
      </button>
    </div>

    <div class="vbp-row">
      <label class="vbp-sel">
        <span class="vbp-lb">{{ curKind === 'diffsinger' ? t('AI 声库') : t('UTAU 声库') }}</span>
        <select
          :value="modelValue"
          @change="pick($event.target.value)"
        >
          <option value="">{{ t('未选择') }}</option>
          <option v-for="v in filtered" :key="v.id" :value="v.dir">{{ v.name }}</option>
        </select>
      </label>
      <span v-if="curKind === 'diffsinger' && !dsCount" class="vbp-hint">
        {{ t('尚无 AI 声库，去「资源中心 → 模型管理 → DiffSinger 声库」下载') }}
      </span>
      <button class="vbp-refresh" :title="t('刷新声库列表')" @click="refresh"><Icon name="refresh" :size="13" /></button>
    </div>

    <div v-if="err" class="vbp-err"><Icon name="info" :size="12" /> {{ err }}</div>
  </div>
</template>

<style scoped>
.vbp { display: flex; flex-direction: column; gap: 8px; }
.vbp-engines { display: inline-flex; gap: 4px; padding: 3px; border: 1px solid var(--hairline); border-radius: 10px; background: var(--surface-soft); align-self: flex-start; }
.vbp-eng { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border: 0; border-radius: 8px; background: transparent; color: var(--stone); font-size: 12.5px; font-weight: 600; cursor: pointer; transition: background .15s, color .15s; }
.vbp-eng:hover { color: var(--ink); }
.vbp-eng.on { background: var(--surface); color: var(--ink); box-shadow: 0 1px 3px rgba(0,0,0,.12); }
.vbp-eng.on i { background: color-mix(in srgb, var(--brand-coral) 16%, transparent); color: var(--brand-coral); }
.vbp-eng i { font-style: normal; font-size: 10.5px; padding: 0 6px; line-height: 15px; border-radius: 20px; background: var(--surface-soft); color: var(--stone); }
.vbp-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.vbp-sel { display: flex; align-items: center; gap: 7px; flex: 1; min-width: 180px; }
.vbp-lb { font-size: 11.5px; color: var(--stone); white-space: nowrap; }
.vbp-sel select { flex: 1; height: 30px; padding: 0 8px; border: 1px solid var(--hairline); border-radius: 8px; background: var(--surface); color: var(--ink); font-size: 12.5px; cursor: pointer; min-width: 0; }
.vbp-hint { font-size: 11px; color: var(--stone); }
.vbp-refresh { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: 1px solid var(--hairline); border-radius: 8px; background: transparent; color: var(--stone); cursor: pointer; flex: 0 0 auto; }
.vbp-refresh:hover { background: var(--surface-soft); color: var(--ink); }
.vbp-err { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--brand-coral); }
.compact .vbp-row { gap: 6px; }
</style>
