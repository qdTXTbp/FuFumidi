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
      (window as any).__fufumidi_activeSoundfont = sf;
      try { localStorage.setItem('fufumidi_soundfont', sf); } catch (e) {}
      // P0-5：默认 GM 懒加载的同步标记（audio.js 首次 init 时同步直读，规避设置异步加载竞态）
      try { localStorage.setItem('fufumidi_default_gm', (this.settings as any).default_gm === false ? '0' : '1'); } catch (e) {}
      // 启动竞态自愈：restoreSongs→ensureAudio 可能先于本同步执行（引用未就绪 → 按内置初始化）。
      // 已应用音色与目标不一致时补加载；一致（含任意其他设置保存触发的 save）则跳过，避免 30MB SF2 反复重载。
      // P0-5：默认 GM 懒加载完成后 applied 会是 GeneralUser 路径，而设置里 active_soundfont 仍是
      // 'internal'（用户没显式选过）。这种「默认 GM 生效中」不是竞态，不要自愈回内置合成器。
      const gmDefault = (this.settings as any).default_gm !== false;
      const appliedIsDefaultGm = !!(gmDefault && prevApplied && prevApplied !== 'internal' && (window as any).__fufumidi_defaultGmApplied === prevApplied);
      if (prevApplied !== undefined && prevApplied !== sf && !(sf === 'internal' && appliedIsDefaultGm)) {
        import('../audio').then(({ setActiveSoundfontRef }) => { setActiveSoundfontRef(sf).catch(() => {}); }).catch(() => {});
      }
    },
  },
});
