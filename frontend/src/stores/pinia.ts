import { createPinia } from 'pinia';

// 全局唯一 Pinia 实例：main.ts 和旧 store.js 兼容层共用同一个实例
export const pinia = createPinia();
