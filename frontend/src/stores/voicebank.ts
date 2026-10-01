// 声库计数共享状态（Pinia）
// ------------------------------------------------------------
// 背景：DiffSinger AI 声库不在 modelList（常规模型清单）里，所以
// ViewModels 页签的 countFor('diffsinger') 恒为 0，导致「DiffSinger 声库 0」，
// 而点进去目录里明明有 163 个可下载声库 —— 用户感知即「可下载声库数量为 0」。
//
// 这里用一个极轻量的共享 store：DiffSingerCatalog 拉到目录后把真实统计写进来，
// ViewModels / 其它视图读它渲染数量，避免各页面各自请求、口径不一致。
import { defineStore } from 'pinia';

export const useVoicebankStore = defineStore('voicebank', {
  state: () => ({
    // DiffSinger AI 声库（ModelScope 目录）
    dsTotal: 0,        // 目录总数（含占位）
    dsAvailable: 0,    // 可下载（权重已就绪）
    dsInstalled: 0,    // 本地已安装
    dsPlaceholder: 0,  // 上游占位待发布
    dsLoaded: false,   // 是否已完成一次目录加载（用于避免闪现 0）
    // UTAU 声库（开源 / 免费一键装）
    utauInstalled: 0,
    utauTotal: 0,
  }),
  actions: {
    setDiffsingerStats(s: { total?: number; available?: number; placeholder?: number } | null | undefined) {
      if (!s) return;
      this.dsTotal = Number(s.total) || 0;
      this.dsAvailable = Number(s.available) || 0;
      this.dsPlaceholder = Number(s.placeholder) || 0;
      this.dsLoaded = true;
    },
    setDiffsingerInstalled(n: number) { this.dsInstalled = Number(n) || 0; },
    setUtauCounts(installed: number, total: number) {
      this.utauInstalled = Number(installed) || 0;
      this.utauTotal = Number(total) || 0;
    },
  },
});
