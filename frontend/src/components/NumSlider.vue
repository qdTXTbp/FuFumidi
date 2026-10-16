<script setup>
// 参数滑块：拖动 + **直接输入数值**（用户要求：所有功能的滑块都允许直接输入）。
//
// 为什么做成组件而不是给每个 <input type="range"> 旁边加一个数字框：
//   本仓库有 ~35 个参数滑块散在 9 个文件里，各写一份必然分叉（占位、步长、越界钳制、
//   键盘行为各不相同）。收敛到一个组件，行为才可能一致。
//
// ★ 钳制策略：输入过程中**不钳**（否则输 "1" 想打 "15" 会被 1 卡住），
//   失焦 / 回车时才钳到 [min, max] 并对齐 step。这样"输入 5"和"拖到 5"结果一样。
import { computed, ref, watch } from 'vue';

const props = defineProps({
  modelValue: { type: Number, default: 0 },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 100 },
  step: { type: Number, default: 1 },
  disabled: { type: Boolean, default: false },
  /** 数字框后缀，例如 ms / Hz / %（只影响显示） */
  unit: { type: String, default: '' },
  /** 数字框宽度（px）：默认 68，窄容器可传更小 */
  inputWidth: { type: Number, default: 68 },
  /* ★ 下面几个用来接住原来挂在 <input> 身上的东西：
     混音台的推子靠 class 与 --fill 才长成推子的样子，音量条还带 id/name/aria。
     不接住它们，替换成组件就会把这些外观与可测性一起弄丢。 */
  /** 原来挂在 range 上的 class（给内层 range，不是外套） */
  rangeClass: { type: String, default: '' },
  /** 原来挂在 range 上的 :style（例如 --fill 的填充比例） */
  rangeStyle: { type: [String, Object, Array], default: null },
  inputId: { type: String, default: '' },
  inputName: { type: String, default: '' },
  ariaLabel: { type: String, default: '' },
  /* ★ 布局紧的地方**不要数字框**（用户明确要求）。判据是量出来的，不是感觉：
     竖排推子（EQ 的 writing-mode: vertical-lr）、固定小宽的 range（88px / 96px）、
     行内本来就有读数（42px 标签 + 54px 读数）、紧凑列表行 —— 再塞一个数字框会把滑块压没。
     这些位置只保留滑块，行为与改造前完全一致。 */
  noInput: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'change']);

/** 小数位：跟着 step 走（step=0.05 → 两位），整数步长就不显示小数点。 */
const decimals = computed(() => {
  const s = String(props.step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : Math.min(4, s.length - i - 1);
});
// ★ 兜一层非有限值：参数可能是 undefined（还没设过）或非数字，
//   直接 toFixed 会显示成 NaN —— 界面出现 NaN 比空着更糟。
const shown = computed(() => {
  const n = Number(props.modelValue);
  return Number.isFinite(n) ? n.toFixed(decimals.value) : '';
});

// 输入框的本地字符串：允许"输到一半"的中间态（空串、只输了个负号）不被改写
const draft = ref(shown.value);
watch(shown, (v) => { draft.value = v; });

function clampStep(v) {
  let x = Number(v);
  if (!Number.isFinite(x)) x = props.min;
  const lo = Math.min(props.min, props.max);
  const hi = Math.max(props.min, props.max);
  x = Math.min(hi, Math.max(lo, x));
  const st = Number(props.step) || 0;
  if (st > 0) x = lo + Math.round((x - lo) / st) * st;
  // 浮点步长会留下 0.30000000000000004 这种尾巴，按 step 的小数位收一下
  return Number(x.toFixed(Math.max(decimals.value, 0)));
}

function onSlide(e) {
  const v = Number(e.target.value);
  draft.value = v.toFixed(decimals.value);
  emit("update:modelValue", v);
}
function commit() {
  const v = clampStep(draft.value);
  draft.value = v.toFixed(decimals.value);
  if (v !== Number(props.modelValue)) {
    emit("update:modelValue", v);
    emit("change", v);
  }
}
function onKey(e) {
  if (e.key === "Enter") { commit(); e.target.blur(); }
  else if (e.key === "Escape") { draft.value = shown.value; e.target.blur(); }
}
</script>

<template>
  <span class="numslider">
    <input class="numslider-range" :class="rangeClass" type="range" :id="inputId || null" :name="inputName || null"
           :aria-label="ariaLabel || null" :style="rangeStyle"
           :min="min" :max="max" :step="step"
           :disabled="disabled" :value="modelValue" @input="onSlide">
    <input v-if="!noInput" class="numslider-num" type="number" :min="min" :max="max" :step="step"
           :disabled="disabled" :value="draft" :style="{ width: inputWidth + 'px' }"
           @input="draft = $event.target.value" @blur="commit" @keydown="onKey">
    <span v-if="unit && !noInput" class="numslider-unit">{{ unit }}</span>
  </span>
</template>
