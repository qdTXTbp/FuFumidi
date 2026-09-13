<script setup>
// 用户弹窗：未登录 -> 登录/注册（带动画切换）；登录后 -> 账号信息 + 立即同步 + 退出登录
import { ref, reactive, watch, onMounted, onBeforeUnmount } from 'vue';
import { useCloudStore } from '../stores/cloud';
import Icon from './Icon.vue';
import CloudSyncChoiceDialog from './CloudSyncChoiceDialog.vue';
import { t } from '../core/i18n.js';

const props = defineProps({ open: { type: Boolean, default: false } });
const emit = defineEmits(['close']);

// Turnstile 承载页：Turnstile 会校验来源域名，Electron 渲染层是本地协议无法直接嵌，
// 因此用 iframe 加载我们域名下托管的人机验证页，页面通过 postMessage 回传 token。
const TS_ORIGIN = 'https://fusync.de5.net';
const TS_URL = TS_ORIGIN + '/turnstile';

const cloud = useCloudStore();
const email = ref('');
const password = ref('');
const mode = ref('login');
const formErr = ref('');
const localBusy = ref(false);
// 登录时检测到本地与云端存档冲突（两个都非空），需用户选择保留哪一侧
const conflict = ref(null);
const conflictMsg = ref('');
// 人机验证
const tsToken = ref('');
const tsErr = ref('');

function onMessage(e) {
  if (e.origin !== TS_ORIGIN) return;
  const d = e.data;
  if (!d || typeof d !== 'object') return;
  if (d.type === 'turnstile-token') { tsToken.value = d.token || ''; tsErr.value = ''; }
  else if (d.type === 'turnstile-expired') { tsToken.value = ''; }
  else if (d.type === 'turnstile-error') { tsErr.value = d.error || t('人机验证加载失败'); }
}
onMounted(() => window.addEventListener('message', onMessage));
onBeforeUnmount(() => window.removeEventListener('message', onMessage));

watch(() => props.open, (v) => {
  if (v) {
    email.value = cloud.account?.email || '';
    password.value = '';
    formErr.value = '';
    conflict.value = null;
    conflictMsg.value = '';
    tsToken.value = ''; tsErr.value = '';
    syncChoiceOpen.value = false;
  }
});

function switchMode() {
  mode.value = mode.value === 'login' ? 'register' : 'login';
  formErr.value = '';
}

async function submit() {
  if (!email.value || !password.value) { formErr.value = t('请输入邮箱与密码'); return; }
  localBusy.value = true;
  formErr.value = '';
  const r = await (mode.value === 'login'
    ? cloud.login(email.value, password.value, tsToken.value)
    : cloud.register(email.value, password.value, tsToken.value));
  localBusy.value = false;
  if (!r || !r.ok) { formErr.value = r?.error || t('操作失败'); return; }
  if (r.conflict) { conflict.value = { localN: r.localN, cloudN: r.cloudN, localSongs: r.localSongs, cloudSongs: r.cloudSongs }; return; }
  emit('close');
}

async function resolveConflict(choose) {
  localBusy.value = true;
  conflictMsg.value = '';
  const r = await cloud.resolveConflict(choose);
  localBusy.value = false;
  if (!r || !r.ok) { conflictMsg.value = r?.error || t('操作失败'); return; }
  emit('close');
}

function close() { emit('close'); }
// 立即同步：先选择以本机还是云端存档为准（选择框叠在本弹窗之上）
const syncChoiceOpen = ref(false);
function doSync() { syncChoiceOpen.value = true; }
async function doLogout() { await cloud.logout(); emit('close'); }
</script>

<template>
  <Teleport to="body">
    <Transition name="ov">
      <div v-if="open" class="ed-modal-mask cloud-user-mask" role="dialog" aria-modal="true" :aria-label="t('账号与云同步')"
           @click.self="close" @keydown.esc="close" tabindex="0">
        <div class="ed-modal" style="width:min(360px,92vw)">
          <div class="ed-modal-head">
            <b>{{ cloud.account ? t('云同步') : t('登录 / 注册') }}</b>
            <button class="icon-btn" style="margin-left:auto" :title="t('关闭')" :aria-label="t('关闭')" @click="close"><Icon name="close" :size="14" /></button>
          </div>

          <!-- 冲突：本机与云端存档都非空，须用户选择保留哪一侧 -->
          <div v-if="conflict" class="cloud-user-body" style="display:flex;flex-direction:column;gap:10px;padding:6px 2px">
            <div style="font-size:13px;font-weight:600">{{ t('检测到歌单存档冲突') }}</div>
            <div class="muted" style="font-size:12px">{{ t('本机存档') }}{{ t('：') }}{{ conflict.localSongs || 0 }} {{ t('曲') }} / {{ conflict.localN }} {{ t('个歌单') }}</div>
            <div class="muted" style="font-size:12px">{{ t('云端存档') }}{{ t('：') }}{{ conflict.cloudSongs || 0 }} {{ t('曲') }} / {{ conflict.cloudN }} {{ t('个歌单') }}</div>
            <div class="muted" style="font-size:12px">{{ t('请选择保留哪一份；选择后另一份将被覆盖。') }}</div>
            <div v-if="conflictMsg" style="font-size:12px;color:#e05858">{{ conflictMsg }}</div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
              <button class="btn sm ghost" @click="resolveConflict('cloud')" :disabled="localBusy">{{ localBusy ? t('处理中…') : t('保留云端') }}</button>
              <button class="btn sm primary" @click="resolveConflict('local')" :disabled="localBusy">{{ localBusy ? t('处理中…') : t('保留本机') }}</button>
            </div>
          </div>

          <!-- 已登录：账号信息 + 同步管理 -->
          <div v-else-if="cloud.account" class="cloud-user-body" style="display:flex;flex-direction:column;gap:12px;padding:4px 2px">
            <div class="cloud-user-row" style="display:flex;align-items:center;gap:10px">
              <span class="cloud-avatar">
                <svg viewBox="0 0 40 40" width="30" height="30" aria-hidden="true">
                  <circle cx="20" cy="14" r="9" fill="#9aa0a6"/>
                  <path d="M7 36a13 13 0 0 1 26 0z" fill="#9aa0a6"/>
                </svg>
              </span>
              <div style="min-width:0">
                <div style="font-size:13px;font-weight:600">{{ cloud.account.email }}</div>
                <div class="muted" style="font-size:12px">{{ t('已登录') }}</div>
              </div>
            </div>
            <div v-if="cloud.err" style="font-size:12px;color:#e05858">{{ cloud.err }}</div>
            <div v-if="cloud.last && cloud.last.ok" style="font-size:12px;color:var(--muted)">
              {{ t('上次同步：上传') }} {{ cloud.last.uploadedSongs }} {{ t('曲 /') }} {{ cloud.last.uploadedPlaylists }} {{ t('单，下载') }} {{ cloud.last.downloadedSongs }} {{ t('曲') }}
            </div>
            <div v-if="cloud.last && cloud.last.ok && cloud.last.missingBytes" style="font-size:12px;color:#e0a558">
              {{ t('有') }} {{ cloud.last.missingBytes }} {{ t('首曲目在本机找不到 MIDI 内容，已跳过备份') }}
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end">
              <button class="btn sm ghost" @click="doLogout" :disabled="cloud.busy">{{ t('退出登录') }}</button>
              <button class="btn sm primary" @click="doSync" :disabled="cloud.busy">{{ cloud.busy ? t('同步中…') : t('立即同步') }}</button>
            </div>
          </div>

          <!-- 未登录：登录 / 注册表单 -->
          <div v-else class="cloud-user-body" style="display:flex;flex-direction:column;gap:10px;padding:4px 2px">
            <input v-model="email" class="text-input" type="text" :placeholder="t('邮箱')" style="width:100%" />
            <input v-model="password" class="text-input" type="password" :placeholder="mode==='register' ? t('密码（至少 8 位）') : t('密码')" style="width:100%"
                   @keydown.enter="submit" />
            <!-- 人机验证：iframe 加载托管页，通过 postMessage 回传 token -->
            <div class="cloud-ts">
              <iframe :src="TS_URL" class="cloud-ts-frame" :title="t('人机验证')"></iframe>
              <div v-if="tsErr" class="cloud-ts-err">{{ tsErr }}</div>
            </div>
            <div v-if="formErr" style="font-size:12px;color:#e05858">{{ formErr }}</div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px">
              <button class="btn sm ghost" @click="switchMode" :disabled="localBusy">{{ mode==='login' ? t('注册新账号') : t('返回登录') }}</button>
              <button class="btn sm primary" @click="submit" :disabled="localBusy">{{ localBusy ? t('处理中…') : (mode==='login' ? t('登录') : t('注册')) }}</button>
            </div>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 立即同步：选择以本机还是云端存档为准 -->
    <CloudSyncChoiceDialog :open="syncChoiceOpen" @close="syncChoiceOpen = false" />
  </Teleport>
</template>

<style scoped>
/* 覆盖层：自包含定位（.ed-modal-mask 的全局定位是 SideBar 的 scoped 样式，跨组件不生效） */
.cloud-user-mask {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
}
.cloud-user-mask .ed-modal {
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
.cloud-user-mask .ed-modal-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.cloud-user-mask .ed-modal-head b { font-size: 14px; }
.cloud-user-mask .btn { white-space: nowrap; }
.cloud-avatar {
  width: 34px; height: 34px; border-radius: 50%;
  background: var(--card, #2a2e37);
  display: inline-flex; align-items: center; justify-content: center;
  flex: none;
}
.cloud-avatar svg { display: block; border-radius: 50%; }
.cloud-user-mask:focus { outline: none; }
.cloud-ts { display: flex; flex-direction: column; align-items: center; }
.cloud-ts-frame { width: 100%; height: 80px; border: 0; background: transparent; }
.cloud-ts-err { font-size: 11px; color: #e05858; text-align: center; margin-top: 4px; line-height: 1.5; }
</style>