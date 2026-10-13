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
});
const emit = defineEmits(['update:modelValue', 'change']);

/** 小数位：跟着 step 走（step=0.05 → 两位），整数步长就不显示小数点。 */
const decimals = computed(() => {
  const s = String(props.step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : Math.min(4, s.length - i - 1);
});
const shown = computed(() => Number(props.modelValue).toFixed(decimals.value));

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
    <input class="numslider-range" type="range" :min="min" :max="max" :step="step"
           :disabled="disabled" :value="modelValue" @input="onSlide">
    <input class="numslider-num" type="number" :min="min" :max="max" :step="step"
           :disabled="disabled" :value="draft" :style="{ width: inputWidth + 'px' }"
           @input="draft = $event.target.value" @blur="commit" @keydown="onKey">
    <span v-if="unit" class="numslider-unit">{{ unit }}</span>
  </span>
</template>
