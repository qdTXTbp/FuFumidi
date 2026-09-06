// Pinia：应用设置
import { defineStore } from 'pinia';
import { fuApi } from '../api';
import type { Settings } from '../types/ipc';

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    settings: {} as Settings,
    loaded: false,
    saving: false,
  }),
  actions: {
    async load() {
      if (this.loaded) return this.settings;
      try {
        this.settings = (await fuApi.getSettings()) || {};
      } catch (e) {
        this.settings = {};
      }
      this.loaded = true;
      this._syncSoundfontRef();
      return this.settings;
    },
    async save(patch: Partial<Settings>) {
      this.saving = true;
      try {
        const r = await fuApi.saveSettings(patch);
        if (r && r.ok) { Object.assign(this.settings, patch); this._syncSoundfontRef(); }
        return r;
      } catch (e) {
        return { ok: false, error: String((e as any)?.message || e) };
      } finally {
        this.saving = false;
      }
    },
    setLocal(patch: Partial<Settings>) {
      Object.assign(this.settings, patch);
      this._syncSoundfontRef();
    },
    // 把当前音色库选择同步到全局引用 + localStorage（audio.js 启动时同步直读，规避加载竞态）
    _syncSoundfontRef() {
      if (typeof window === 'undefined') return;
      const sf = (this.settings as any).active_soundfont || 'internal';
      const prevApplied = (window as any).__fufumidi_appliedSoundfont;
      window.__fufumidi_activeSoundfont = sf;
      try { localStorage.setItem('fufumidi_soundfont', sf); } catch (e) {}
      // 启动竞态自愈：restoreSongs→ensureAudio 可能先于本同步执行（引用未就绪 → 按内置初始化）。
      // 已应用音色与目标不一致时补加载；一致（含任意其他设置保存触发的 save）则跳过，避免 30MB SF2 反复重载。
      if (prevApplied !== undefined && prevApplied !== sf) {
        import('../audio').then(({ setActiveSoundfontRef }) => { setActiveSoundfontRef(sf).catch(() => {}); }).catch(() => {});
      }
    },
  },
});
