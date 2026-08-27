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
      return this.settings;
    },
    async save(patch: Partial<Settings>) {
      this.saving = true;
      try {
        const r = await fuApi.saveSettings(patch);
        if (r && r.ok) Object.assign(this.settings, patch);
        return r;
      } catch (e) {
        return { ok: false, error: String((e as any)?.message || e) };
      } finally {
        this.saving = false;
      }
    },
    setLocal(patch: Partial<Settings>) {
      Object.assign(this.settings, patch);
    },
  },
});
