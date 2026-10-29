// 全局界面材质：默认 / 玻璃 / 亚克力 / 云母 / 磨砂 / 天鹅绒
// 只负责把 data-material 挂到 <html>，具体视觉在 styles.css 的 material 段里。
export const MATERIALS = [
  { id: 'default', label: '默认' },
  { id: 'glass', label: '玻璃' },
  { id: 'acrylic', label: '亚克力' },
  { id: 'mica', label: '云母' },
  { id: 'frosted', label: '磨砂' },
  { id: 'velvet', label: '天鹅绒' },
];
const IDS = MATERIALS.map((m) => m.id);
export function normalizeMaterial(v) { return IDS.includes(String(v || '')) ? String(v) : 'default'; }
export function applyMaterial(v) {
  if (typeof document === 'undefined') return 'default';
  const id = normalizeMaterial(v);
  try { document.documentElement.dataset.material = id; } catch (e) {}
  return id;
}
