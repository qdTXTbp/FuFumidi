// 演奏法库（P1-3）：Key Switch 技法名映射的可编辑条目。
// 条目形状：{ id, name, builtin, map: { midi(0-24): '技法名' } }
// 内置三套（Spitfire / VSL / EastWest）+ 用户自定义库（localStorage 持久化）。

export const BUILTIN_ARTICULATIONS = [
  {
    id: 'spitfire', name: 'Spitfire', builtin: true,
    map: { 0: 'Legato', 1: 'Staccato', 2: 'Tremolo', 3: 'Pizzicato', 4: 'Spiccato', 5: 'Marcato', 6: 'Sustain', 7: 'Con Sordino', 8: 'Flautando', 9: 'Harmonics', 10: 'Trill' },
  },
  {
    id: 'vsl', name: 'VSL', builtin: true,
    map: { 0: 'Legato', 1: 'Detache', 2: 'Staccato', 3: 'Spiccato', 4: 'Pizzicato', 5: 'Tremolo', 6: 'Trill', 7: 'Sforzando', 8: 'Marcato', 9: 'Portamento' },
  },
  {
    id: 'eastwest', name: 'EastWest', builtin: true,
    map: { 0: 'Legato', 1: 'Staccato', 2: 'Tremolo', 3: 'Pizzicato', 4: 'Spiccato', 5: 'Marcato', 6: 'Sustain', 7: 'Con Sordino', 8: 'Harmonics', 9: 'Trill', 10: 'Flautando' },
  },
];

const LS_KEY = 'fufumidi_articulations';

export function loadUserArticulations() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter(a => a && a.id && a.map) : [];
  } catch (e) { return []; }
}
export function saveUserArticulations(list) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list || [])); } catch (e) {}
}
/** 全部可用库：内置 + 用户 */
export function listArticulations() {
  return BUILTIN_ARTICULATIONS.concat(loadUserArticulations());
}
export function findArticulation(id) {
  return listArticulations().find(a => a.id === id) || null;
}
/** 把某个库的技法名并入现有 Key Switch 映射（只覆盖该库给出的键，其余保留） */
export function applyArticulation(map, id) {
  const lib = findArticulation(id);
  if (!lib) return { ...(map || {}) };
  const out = { ...(map || {}) };
  for (const k of Object.keys(lib.map)) {
    const m = Number(k);
    if (Number.isFinite(m) && m >= 0 && m <= 24 && lib.map[k]) out[m] = lib.map[k];
  }
  return out;
}
/** 新建或覆盖同名的用户库，返回库对象 */
export function upsertUserArticulation(name, map) {
  const n = String(name || '').trim();
  if (!n) return null;
  const clean = {};
  for (const k of Object.keys(map || {})) {
    const m = Number(k);
    if (Number.isFinite(m) && m >= 0 && m <= 24 && map[k]) clean[m] = String(map[k]);
  }
  const list = loadUserArticulations();
  const hit = list.find(a => a.name === n);
  if (hit) { hit.map = clean; saveUserArticulations(list); return hit; }
  const item = { id: 'u_' + Date.now().toString(36), name: n, builtin: false, map: clean };
  list.push(item);
  saveUserArticulations(list);
  return item;
}
export function removeUserArticulation(id) {
  const list = loadUserArticulations().filter(a => a.id !== id);
  saveUserArticulations(list);
}
