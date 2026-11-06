// 模型下载：**跨页共享**的状态（资源中心卡片 / 顶部全局下载条）
// ------------------------------------------------------------
// 为什么提升到 store：下载从资源中心发起，但用户随时会切页。
//   · 旧实现 ViewModels 与 App.vue 各自维护一份 prog、各自订阅 model:progress；
//     切页后资源中心那份没了，顶部条也只显示 active（暂停会被当成失败移除）。
//   · 现在状态只在这里一份：事件订阅只做一次，两个视图都读同一份，
//     暂停后切页再回来仍是「已暂停」，顶部条也能直接「继续/取消」。
//   · model_list.active 仍作为兜底：刷新列表时由 syncActive() 对账。
import { defineStore } from 'pinia';
import {
  beginEntry, applyProgress, applyResult, markPauseRequested, markCancelRequested,
} from '../core/model-download.js';

type DlEntry = {
  canPause?: boolean;
  active?: boolean;
  paused?: boolean;
  done?: boolean;
  canceled?: boolean;
  percent?: number;
  speed?: number;
  received?: number;
  total?: number;
  text?: string;
  error?: string;
  pauseReq?: boolean;
  cancelReq?: boolean;
  [key: string]: any;
};

type DlItem = {
  id: string;
  name?: string;
  kind?: string;
  downloadable?: boolean;
  [key: string]: any;
};

// 模块级（非响应式）：同一次会话内每个 id 的尝试序号，防止旧 Promise 覆盖新状态
const seq: Record<string, number> = {};
let subscribed = false;

function bridgeNow(): any {
  return (window as any).fuBridge || null;
}

export const useModelDownloadStore = defineStore('modelDownloads', {
  state: () => ({
    /** id -> { active, paused, canceled, percent, speed, received, total, text, error } */
    prog: {} as Record<string, DlEntry>,
    /** id -> { name, kind }：顶部全局条要显示模型名 */
    names: {} as Record<string, { name: string; kind?: string }>,
    /** 完成 / 失败后 +1：资源中心 watch 它刷新 model_list（不把「暂停」当结束） */
    refreshTick: 0,
    namesFetched: false,
  }),

  getters: {
    entryOf(state) {
      return (id: string): DlEntry | undefined => state.prog[id];
    },
    nameOf(state) {
      return (id: string): string => {
        const n = state.names[id];
        return (n && n.name) || id;
      };
    },
    /** 顶部通知条数据：下载中 + 已暂停；完成/失败不再显示（详情回资源中心看） */
    barItems(state): Array<DlEntry & { id: string; name: string }> {
      const out: Array<DlEntry & { id: string; name: string }> = [];
      for (const id of Object.keys(state.prog)) {
        const p = state.prog[id];
        if (!p || !(p.active || p.paused)) continue;
        const n = state.names[id];
        // DiffSinger AI 声库走独立下载通道，没有暂停能力：条上只给「取消」
        out.push({ ...p, id, name: (n && n.name) || id, canPause: !String(id).startsWith('dsms:') });
      }
      // 下载中排前面，已暂停排后面（顺序稳定，不随事件抖动）
      out.sort((a, b) => Number(!!b.active) - Number(!!a.active));
      return out;
    },
  },

  actions: {
    /** 只订阅一次 model:progress（App 启动即调；切页不丢）。 */
    ensureEvents() {
      if (subscribed) return;
      const b = bridgeNow();
      if (!b || !b.onModelProgress) return;
      subscribed = true;
      b.onModelProgress((p: any) => this.applyProgress(p));
    },

    applyProgress(p: any) {
      if (!p || !p.id) return;
      // DiffSinger AI 声库（dsms: 前缀）不在 model_list 里；主进程直接用 label 给展示名
      if (p.label) this.names[p.id] = { name: String(p.label) };
      this.prog[p.id] = applyProgress(this.prog[p.id], p) as DlEntry;
      // 完成/失败才让资源中心刷新列表；暂停/取消不刷新（避免把「已暂停」显示成未安装）
      if (p.done) {
        this.refreshTick++;
        if (!this.names[p.id]) void this.ensureNames();
      } else if (p.error && !p.paused && !p.canceled) {
        this.refreshTick++;
      }
    },

    /** 资源中心 refresh() 拿到 model_list 后写入名字（顶部条用） */
    setNames(list: any) {
      if (!Array.isArray(list)) return;
      for (const m of list) {
        if (!m || !m.id) continue;
        this.names[m.id] = { name: m.name || m.id, kind: m.kind };
      }
      this.namesFetched = true;
    },

    async ensureNames() {
      if (this.namesFetched) return;
      const b = bridgeNow();
      if (!b || !b.modelList) return;
      try {
        const arr = await b.modelList();
        this.setNames(arr);
      } catch (e) { /* 名字拿不到只影响显示，不影响下载 */ }
    },

    /** 刷新 model_list 后对账：后端仍标 active 的条目恢复成「下载中」。
     *  本地更细的状态（暂停/失败/已完成）优先，不被 active 覆盖。 */
    syncActive(list: any) {
      for (const m of list || []) {
        if (!m || !m.id) continue;
        const cur = this.prog[m.id];
        if (m.active && (!cur || (!cur.active && !cur.paused && !cur.done && !cur.error))) {
          this.prog[m.id] = { ...(cur || {}), active: true, percent: (cur && cur.percent) || 0 } as DlEntry;
        }
      }
    },

    forget(id: string) {
      if (id) delete this.prog[id];
    },

    /** 开始 / 继续（暂停后重入）/ 重试。返回后端结果，由调用方决定 toast 文案。 */
    async start(item: DlItem, channel = 'huggingface'): Promise<any> {
      if (!item || !item.id) return { ok: false, error: 'invalid model' };
      const b = bridgeNow();
      if (!b || !b.modelDownload) return { ok: false, error: 'no bridge' };
      if (item.downloadable === false) return { ok: false, refused: 'bundled' };
      const cur = this.prog[item.id];
      if (cur && cur.active) return { ok: false, active: true };
      const attempt = (seq[item.id] = (seq[item.id] || 0) + 1);
      this.prog[item.id] = beginEntry(cur) as DlEntry;
      if (item.name) this.names[item.id] = { name: item.name, kind: item.kind };
      try {
        const r = await b.modelDownload(item.id, channel);
        if (seq[item.id] !== attempt) return { ok: false, stale: true };
        this.prog[item.id] = applyResult(this.prog[item.id], r) as DlEntry;
        // 完成或失败才刷新列表；暂停/取消等用户动作
        if (!r || r.ok) this.refreshTick++;
        else if (!r.paused && !r.canceled) this.refreshTick++;
        return r || { ok: false };
      } catch (e: any) {
        if (seq[item.id] === attempt) {
          this.prog[item.id] = applyResult(this.prog[item.id], { ok: false, error: String((e && e.message) || e) }) as DlEntry;
          this.refreshTick++;
        }
        return { ok: false, error: String((e && e.message) || e) };
      }
    },

    /** 暂停：modelPause 保留断点；后端返回 ok:false 时恢复「下载中」，不骗用户。 */
    async pause(id: string): Promise<any> {
      // DiffSinger AI 声库（dsms:）没有 modelPause 通道，别假装能暂停
      if (String(id).startsWith('dsms:')) return { ok: false, unsupported: true };
      const cur = this.prog[id];
      if (!cur || !cur.active) return { ok: true, paused: false };
      const b = bridgeNow();
      if (!b || !b.modelPause) return { ok: false, error: 'no bridge' };
      this.prog[id] = markPauseRequested(cur) as DlEntry;
      try {
        const r = await b.modelPause(id);
        if (r && r.ok === false) {
          this.prog[id] = { ...this.prog[id], pauseReq: false, active: true, paused: false } as DlEntry;
        }
        return r || { ok: true };
      } catch (e: any) {
        this.prog[id] = { ...this.prog[id], pauseReq: false, active: true, paused: false } as DlEntry;
        return { ok: false, error: String((e && e.message) || e) };
      }
    },

    /** 取消：modelCancel（后端会清断点）；取消不是失败，允许重新点下载。 */
    async cancel(id: string): Promise<any> {
      if (!id) return { ok: true };
      const b = bridgeNow();
      if (this.prog[id] && this.prog[id].active) this.prog[id] = markCancelRequested(this.prog[id]) as DlEntry;
      let r: any = { ok: true };
      try {
        // DiffSinger AI 声库走独立取消通道（modelCancel 只认常规模型 id，旧实现踩过）
        if (String(id).startsWith('dsms:') && b && b.diffsingerMsCancelDownload) {
          r = await b.diffsingerMsCancelDownload(String(id).slice(5));
        } else if (b && b.modelCancel) {
          r = await b.modelCancel(id);
        }
      } catch (e: any) {
        r = { ok: false, error: String((e && e.message) || e) };
      }
      this.prog[id] = {
        ...(this.prog[id] || {}), active: false, paused: false, canceled: true, error: '', percent: 0, speed: 0,
      } as DlEntry;
      this.refreshTick++;
      return r;
    },
  },
});
