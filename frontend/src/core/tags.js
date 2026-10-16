// 曲目自定义标签的纯函数（"编辑信息"里的标签输入用）。
// ★ 抽出来是为了能单测：界面里 trim/去空/去重/上限这四件事最容易写漏，
//   而它们一旦写漏，用户会看到空白标签、重复标签、或者标签列表无限长。
export const TAG_MAX = 24;          // 单曲标签条数上限（再多列表行会被标签挤爆）
export const TAG_LEN = 16;          // 单条标签长度上限（中文 16 字已经足够表意）

/** 规整一条标签：去空白、去 # 前缀、截断超长 */
export function cleanTag(raw) {
  let s = String(raw == null ? '' : raw).trim();
  while (s.startsWith('#')) s = s.slice(1).trim();
  if (!s) return '';
  return s.length > TAG_LEN ? s.slice(0, TAG_LEN) : s;
}

/** 加入一条标签：空的不加、重复的（忽略大小写）不加、超上限不加。返回新数组 */
export function addTag(list, raw) {
  const t = cleanTag(raw);
  const arr = Array.isArray(list) ? list.slice() : [];
  if (!t) return arr;
  if (arr.some((x) => String(x).toLowerCase() === t.toLowerCase())) return arr;
  if (arr.length >= TAG_MAX) return arr;
  arr.push(t);
  return arr;
}

/** 删除第 i 条（越界就原样返回，界面不用先判） */
export function removeTagAt(list, i) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const k = Number(i);
  if (!Number.isInteger(k) || k < 0 || k >= arr.length) return arr;
  arr.splice(k, 1);
  return arr;
}

/** 一次性规整（读旧数据 / 保存前都过一遍） */
export function cleanTags(list) {
  let out = [];
  for (const x of (Array.isArray(list) ? list : [])) out = addTag(out, x);
  return out;
}

/** 列表行里展示用：最多 max 条，多的折成 +N */
export function tagSummary(list, max = 2) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return '';
  const head = arr.slice(0, max).join(' ');
  return arr.length > max ? head + ' +' + (arr.length - max) : head;
}
