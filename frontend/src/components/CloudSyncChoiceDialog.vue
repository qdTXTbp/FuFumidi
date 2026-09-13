<script setup>
// 手动同步选择框：先展示本机与云端存档规模，让用户决定以哪一份为准。
// 使用本机 = push（本机覆盖云端）；使用云端 = pull（云端覆盖本机）。
import { ref, computed, watch } from 'vue';
import { useCloudStore } from '../stores/cloud';
import Icon from './Icon.vue';
import { t } from '../core/i18n.js';

const props = defineProps({ open: { type: Boolean, default: false } });
const emit = defineEmits(['close']);

const cloud = useCloudStore();

watch(() => props.open, async (v) => {
  if (!v) return;
  cloud.resetCounts();
  await cloud.loadCounts();
});

async function choose(mode) {
  const r = await cloud.sync(mode);
  if (!r || !r.ok) return; // 失败信息由 cloud.err 展示
  emit('close');
}
function close() { emit('close'); }

// 云端为空而本机有存档时禁用「使用云端存档」：
// 该选项会以云端为基准覆盖本机，云端为空就等于把本机存档整体删除（此前已发生过一次）。
const cloudEmpty = computed(() => {
  const c = cloud.counts;
  if (!c) return false;
  const local = (c.localSongs || 0) + (c.localPlaylists || 0);
  const remote = (c.cloudSongs || 0) + (c.cloudPlaylists || 0);
  return remote === 0 && local > 0;
});
</script>

<template>
  <Teleport to="body">
    <Transition name="ov">
      <div v-if="open" class="ed-modal-mask cloud-choice-mask" role="dialog" aria-modal="true" :aria-label="t('选择要使用的存档')"
           @click.self="close" @keydown.esc="close" tabindex="0">
        <div class="ed-modal" style="width:min(360px,92vw)">
          <div class="ed-modal-head">
            <b>{{ t('选择要使用的存档') }}</b>
            <button class="icon-btn" style="margin-left:auto" :title="t('关闭')" :aria-label="t('关闭')" @click="close"><Icon name="close" :size="14" /></button>
          </div>

          <div style="display:flex;flex-direction:column;gap:10px;padding:4px 2px">
            <template v-if="cloud.counts">
              <div class="muted" style="font-size:12px">{{ t('本机存档') }}{{ t('：') }}{{ cloud.counts.localSongs }} {{ t('曲') }} / {{ cloud.counts.localPlaylists }} {{ t('个歌单') }}</div>
              <div class="muted" style="font-size:12px">{{ t('云端存档') }}{{ t('：') }}{{ cloud.counts.cloudSongs }} {{ t('曲') }} / {{ cloud.counts.cloudPlaylists }} {{ t('个歌单') }}</div>
              <div class="muted" style="font-size:12px">{{ t('请选择以哪一份为准；选择后另一份将被覆盖。') }}</div>
            </template>
            <div v-else style="font-size:12px;color:var(--stone)">
              {{ cloud.busy ? t('正在读取存档…') : t('未能读取存档信息') }}
            </div>
            <!-- 进度：分批传输可能持续几分钟，给出阶段 + 已用时，避免看起来像卡死 -->
            <div v-if="cloud.busy && cloud.progress" style="display:flex;flex-direction:column;gap:6px">
              <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--stone)">
                <span>{{ (cloud.progress && cloud.progress.text) || t('正在同步…') }}</span>
                <span>{{ cloud.elapsed }}s</span>
              </div>
              <div v-if="cloud.progress && cloud.progress.total" style="height:6px;background:var(--surface-soft);border-radius:999px;overflow:hidden;border:1px solid var(--hairline)">
                <div style="height:100%;background:linear-gradient(90deg,#4f94e0,#8fc0f0);transition:width .2s"
                     :style="{ width: Math.min(100, Math.round(((cloud.progress.done || 0) / (cloud.progress.total || 1)) * 100)) + '%' }"></div>
              </div>
            </div>
            <div v-if="cloud.err" style="font-size:12px;color:#e05858">{{ cloud.err }}</div>
            <div v-if="cloudEmpty" style="font-size:12px;color:#e0a558">
              {{ t('云端存档为空，使用云端会清空本机存档，已禁用该选项。请选择「使用本机存档」上传。') }}
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
              <button class="btn sm ghost" @click="close" :disabled="cloud.busy">{{ t('取消') }}</button>
              <button class="btn sm ghost" @click="choose('pull')" :disabled="cloud.busy || cloudEmpty">{{ t('使用云端存档') }}</button>
              <button class="btn sm primary" @click="choose('push')" :disabled="cloud.busy">{{ cloud.busy ? t('同步中…') : t('使用本机存档') }}</button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 覆盖层自包含定位（同 CloudUserDialog），层级需高于账号弹窗 */
.cloud-choice-mask {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
}
.cloud-choice-mask .ed-modal {
  width: min(360px, 92vw);
  background: var(--card, #ffffff);
  color: var(--text, inherit);
  border: 1px solid var(--hairline, rgba(128, 128, 128, 0.25));
  border-radius: 14px;
  padding: 16px 18px;
  box-shadow: 0 14px 44px rgba(0, 0, 0, 0.35);
  max-height: 86vh;
  overflow: auto;
}
.cloud-choice-mask .ed-modal-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.cloud-choice-mask .ed-modal-head b { font-size: 14px; }
.cloud-choice-mask .btn { white-space: nowrap; }
.cloud-choice-mask:focus { outline: none; }
</style>
