// 云同步账号状态：侧边栏头像、设置页、登录弹窗共用。
// 实际同步逻辑在 core/cloudSync.ts（渲染层，便于同步后直接刷新界面状态）。
import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  cloudStatus, cloudLogin, cloudRegister, cloudLogout, cloudSync, cloudResolveConflict, cloudFetchCounts, cloudSongsDir,
  setSyncProgressHandler,
  type CloudSyncOutcome, type CloudCounts, type SyncProgress,
} from '../core/cloudSync';
import { useAppStore } from './app';
import { usePlaylistStore } from './playlist';

export interface CloudAccount {
  email: string;
  userId: string;
}

export const useCloudStore = defineStore('cloud', () => {
  const account = ref<CloudAccount | null>(null);
  const busy = ref(false);
  const err = ref('');
  const last = ref<CloudSyncOutcome | null>(null);
  // 手动同步前展示的两侧存档规模（loadCounts 填充）
  const counts = ref<CloudCounts | null>(null);
  // 云同步曲目的落盘目录（与本地曲库分开）
  const dir = ref('');
  // 同步进度与已用时：几百分批传输时界面必须有反馈，否则看起来像卡死
  const progress = ref<SyncProgress | null>(null);
  const elapsed = ref(0);
  let _tick: any = null;
  function startTicker() {
    stopTicker();
    const t0 = Date.now();
    elapsed.value = 0;
    _tick = setInterval(() => { elapsed.value = Math.floor((Date.now() - t0) / 1000); }, 500);
  }
  function stopTicker() { if (_tick) { clearInterval(_tick); _tick = null; } }

  /** 同步结果落到界面：删除的曲目从内存移除、新增的补进来、歌单换成最新快照 */
  async function applyOutcome(out: CloudSyncOutcome | null | undefined) {
    if (!out || !out.ok || !out.changed) return;
    try {
      const app = useAppStore();
      const pl = usePlaylistStore();
      if (out.removedSongIds && out.removedSongIds.length) app.dropSongsLocal(out.removedSongIds);
      await app.mergeSongsFromDb();
      if (out.playlists) pl.applyDbSnapshot(out.playlists);
    } catch (e) {
      /* 界面刷新失败不影响同步结果 */
    }
  }

  async function init() {
    try {
      const r = await cloudStatus();
      account.value = (r?.account as CloudAccount) || null;
    } catch (_) {
      account.value = null;
    }
    dir.value = await cloudSongsDir();
  }

  async function login(email: string, password: string, turnstile?: string | null) {
    busy.value = true; err.value = '';
    try {
      const out = await cloudLogin(email, password, turnstile);
      if (out && out.ok) {
        account.value = { email, userId: '' };
        await applyOutcome(out);
      } else {
        err.value = (out && out.error) || '登录失败';
      }
      return out;
    } finally { busy.value = false; }
  }

  async function register(email: string, password: string, turnstile?: string | null) {
    busy.value = true; err.value = '';
    try {
      const out = await cloudRegister(email, password, turnstile);
      if (out && out.ok) {
        account.value = { email, userId: '' };
        await applyOutcome(out);
      } else {
        err.value = (out && out.error) || '注册失败';
      }
      return out;
    } finally { busy.value = false; }
  }

  async function resolveConflict(choose: 'local' | 'cloud') {
    busy.value = true; err.value = '';
    try {
      const out = await cloudResolveConflict(choose);
      if (out && out.ok) await applyOutcome(out);
      else err.value = (out && out.error) || '操作失败';
      return out;
    } finally { busy.value = false; }
  }

  async function logout() {
    try { await cloudLogout(); } catch (_) {}
    account.value = null;
  }

  async function sync(mode: 'merge' | 'push' | 'pull' = 'merge') {
    busy.value = true; err.value = ''; progress.value = null;
    setSyncProgressHandler((p) => { progress.value = p; });
    startTicker();
    try {
      const out = await cloudSync(mode);
      last.value = out;
      if (out && !out.ok) err.value = out.error || '同步失败';
      else await applyOutcome(out);
      return out;
    } finally {
      setSyncProgressHandler(null);
      stopTicker();
      busy.value = false;
    }
  }

  /** 读取本机与云端存档规模（手动同步前询问使用哪一份） */
  async function loadCounts() {
    busy.value = true; err.value = '';
    try {
      const r = await cloudFetchCounts();
      counts.value = r && r.ok ? r : null;
      if (!r || !r.ok) err.value = (r && r.error) || '读取存档信息失败';
      return r;
    } finally { busy.value = false; }
  }

  function resetCounts() { counts.value = null; err.value = ''; }

  return { account, busy, err, last, counts, dir, progress, elapsed, init, login, register, logout, sync, resolveConflict, loadCounts, resetCounts };
});
