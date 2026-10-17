// C2 TaskCenter 前端 store：任务列表来自主进程（离开页面不丢），事件 10Hz 合并广播。
import { defineStore } from 'pinia';
import { fuApi } from '../api';

export interface TaskItem {
  id: string; kind: string; title: string;
  status: 'running' | 'done' | 'error' | 'canceled';
  progress: number; startedAt: number; endedAt: number | null;
  result?: any; error?: string; logs?: string[]; cancelable?: boolean;
}

let bound = false;

export const useTasksStore = defineStore("tasks", {
  state: () => ({
    tasks: [] as TaskItem[],
    loaded: false,
  }),
  getters: {
    running: (s) => s.tasks.filter((t) => t.status === 'running'),
    runningCount(): number { return this.running.length; },
  },
  actions: {
    async refresh() {
      try {
        const list = await (fuApi as any).tasks?.list?.();
        if (Array.isArray(list)) this.tasks = list;
      } catch (e) { /* 主进程不可用时保持空列表 */ }
      this.loaded = true;
      if (!bound) {
        bound = true;
        try {
          (fuApi as any).tasks?.onUpdate?.((ev: any) => { if (ev && Array.isArray(ev.tasks)) this.tasks = ev.tasks; });
        } catch (e) {}
      }
    },
    applyEvent(ev: any) {
      if (ev && Array.isArray(ev.tasks)) this.tasks = ev.tasks;
    },
    async cancel(id: string) {
      try { return await (fuApi as any).tasks?.cancel?.(id); } catch (e) { return { ok: false, error: String(e) }; }
    },
  },
});