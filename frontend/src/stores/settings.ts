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
    // 把当前音色库选择同步到全局引用，供 audio 初始化时读取加载
    _syncSoundfontRef() {
      if (typeof window === 'undefined') return;
      window.__fufumidi_activeSoundfont = (this.settings as any).active_soundfont || 'internal';
    },
  },
});
