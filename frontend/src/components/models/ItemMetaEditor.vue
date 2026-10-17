<template>
  <!-- 条目元数据编辑（目录页「编辑」按钮）：改名 / 作者 / 来源 / 标签 / 分类。
       写入走 core/usermeta.js → bridge.usermeta.set（四页共用一张表，主进程落盘）。
       清空某字段 = 回到原始值；「恢复默认」清掉该条目的全部用户改动。 -->
  <div class="ime-scrim" @click.self="$emit('close')">
    <div class="ime" role="dialog" aria-modal="true">
      <div class="ime-head">
        <span class="ime-ic"><Icon name="edit" :size="15" /></span>
        <div class="ime-title">
          <b>{{ t('编辑条目信息') }}</b>
          <small class="ime-raw">{{ rawName || '' }}</small>
        </div>
        <button class="icon-btn" style="margin-left:auto" @click="$emit('close')"><Icon name="close" :size="15" /></button>
      </div>
      <div class="ime-body">
        <label class="ime-field">
          <span>{{ t('显示名称') }}</span>
          <input v-model="form.name" type="text" :placeholder="rawName || t('（用原始名称）')" />
        </label>
        <label class="ime-field">
          <span>{{ t('作者') }}</span>
          <input v-model="form.author" type="text" :placeholder="t('（空 = 不显示）')" />
        </label>
        <label class="ime-field">
          <span>{{ t('来源') }}</span>
          <input v-model="form.source" type="text" :placeholder="t('（空 = 不显示）')" />
        </label>
        <label class="ime-field">
          <span>{{ t('标签') }}</span>
          <input v-model="tagText" type="text" :placeholder="t('用逗号分隔，如：中文,女声,高音')" />
        </label>
        <label class="ime-field">
          <span>{{ t('分类') }}</span>
          <input v-model="form.category" type="text" :placeholder="t('（空 = 用原始分类）')" />
        </label>
      </div>
      <div class="ime-foot">
        <button class="btn sm ghost" :disabled="busy" @click="reset">{{ t('恢复默认') }}</button>
        <span style="margin-left:auto"></span>
        <button class="btn sm" :disabled="busy" @click="$emit('close')">{{ t('取消') }}</button>
        <button class="btn sm primary" :disabled="busy" @click="save">{{ busy ? t('保存中…') : t('保存') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import Icon from '../Icon.vue';
import { t } from '../../core/i18n.js';
import { metaOf, setMeta, clearMeta } from '../../core/usermeta.js';

const props = defineProps({
  kind: { type: String, required: true },
  item: { type: Object, required: true },
  rawName: { type: String, default: '' },
});
defineEmits(['close']);

// 稳定键：目录条目有的带 id、有的只有 path（DS 目录）/ name —— 与 metaOf 的取值口径对齐
const itemId = computed(() => (props.item && (props.item.id ?? props.item.path ?? props.item.name)) ?? '');

const form = reactive({ name: '', author: '', source: '', category: '' });
const tagText = ref('');
const busy = ref(false);

onMounted(() => {
  const m = metaOf(props.kind, itemId.value) || {};
  form.name = m.name || '';
  form.author = m.author || '';
  form.source = m.source || '';
  form.category = m.category || '';
  tagText.value = (m.tags || []).join(',');
});

async function save() {
  busy.value = true;
  try {
    const tags = tagText.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    // 空字段 = 回到原始值（usermeta 的语义：空字段不会出现）
    await setMeta(props.kind, itemId.value, {
      name: form.name.trim(),
      author: form.author.trim(),
      source: form.source.trim(),
      category: form.category.trim(),
      tags,
    });
  } finally {
    busy.value = false;
    emitClose();
  }
}

async function reset() {
  busy.value = true;
  try { await clearMeta(props.kind, itemId.value); } finally {
    busy.value = false;
    emitClose();
  }
}

function emitClose() { /* eslint-disable-line no-unused-vars */ }
</script>

<style scoped>
.ime-scrim { position: fixed; inset: 0; z-index: 80; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--scrim, rgba(0,0,0,.5)) 70%, transparent); backdrop-filter: blur(3px); }
.ime { width: min(460px, calc(100vw - 40px)); max-height: calc(100vh - 80px); display: flex; flex-direction: column; border: 1px solid var(--hairline); border-radius: var(--r-lg); background: var(--surface); box-shadow: var(--shadow-lg); overflow: hidden; }
.ime-head { display: flex; align-items: center; gap: var(--sp-3); padding: 14px 16px; border-bottom: 1px solid var(--hairline); }
.ime-ic { display: inline-flex; width: 30px; height: 30px; align-items: center; justify-content: center; border-radius: var(--r-md); background: var(--surface-soft); color: var(--brand-coral); }
.ime-title { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.ime-title b { font-size: var(--fs-md); color: var(--ink); }
.ime-raw { font-size: var(--fs-xs); color: var(--stone); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ime-body { display: flex; flex-direction: column; gap: var(--sp-3); padding: 16px; overflow-y: auto; }
.ime-field { display: flex; flex-direction: column; gap: var(--sp-1); }
.ime-field > span { font-size: var(--fs-sm); font-weight: 600; color: var(--slate); }
.ime-field input { padding: 8px 11px; border: 1px solid var(--hairline); border-radius: var(--r-md); background: var(--surface-soft); color: var(--ink); font-size: var(--fs-sm); outline: none; }
.ime-field input:focus { border-color: var(--accent); }
.ime-foot { display: flex; align-items: center; gap: var(--sp-2); padding: 12px 16px; border-top: 1px solid var(--hairline); }
</style>
