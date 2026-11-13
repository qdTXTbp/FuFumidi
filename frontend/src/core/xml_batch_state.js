// ============================================================
// 批量导出 MusicXML 弹窗的全局开关（乐谱工具栏 / 曲库批量栏共用）
// ============================================================
// 只有一个实例挂在 App.vue 上，两个入口都通过 openXmlBatch(ids) 打开并预选，
// 免得同一个弹窗在多个视图里各渲染一份、状态互相打架。
import { reactive } from 'vue';

export const xmlBatch = reactive({ open: false, preselect: [] });

/** @param {string[]} [ids] 预选的曲目 id；不传则由弹窗自己挑当前曲 */
export function openXmlBatch(ids) {
  xmlBatch.preselect = Array.isArray(ids) ? ids.filter(Boolean).slice() : [];
  xmlBatch.open = true;
}

export function closeXmlBatch() {
  xmlBatch.open = false;
}
