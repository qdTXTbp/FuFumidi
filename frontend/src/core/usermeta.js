// ============================================================
// 用户元数据的渲染端单例：四种目录（调教模型 / UTAU 声库 / DiffSinger 声库 / 音色）共用一张表
// ============================================================
// 主进程落盘在数据根的 usermeta.json（见 main/usermeta.js）。
// 这里只负责：读一次、按 "<kind>:<id>" 取、把用户排序与顶置套到列表上。
//
// 为什么排序/顶置要放在这一层而不是各页自己存：
//   资源中心四页的数据来源不同、且每次刷新都会重算；用户排序写回各自的结构里刷新即丢。
//   统一走这张表，**四页行为才可能一致**（P4-3 的要求）。
import { reactive } from 'vue';

const table = reactive({});
let loaded = false;
let inflight = null;

function bridge() {
  return (typeof window !== 'undefined' && window.fuBridge) ? window.fuBridge : null;
}

/** 读一次元数据表（并发调用共用同一个请求）。force=true 时强制重读。 */
export async function loadUserMeta(force) {
  const b = bridge();
  if (!b || !b.usermeta || !b.usermeta.list) {
    // 没有桥 = 根本没有用户元数据（网页版），那就该是**空表**。
    // 不清空的话，先加载过桌面数据再失去桥的场景会把旧内容留在内存里，
    // 排序/顶置会按一份"其实不存在"的表生效 —— 语义必须是确定的。
    for (const k of Object.keys(table)) delete table[k];
    loaded = true;
    return table;
  }
  if (loaded && !force) return table;
  if (inflight && !force) return inflight;
  inflight = (async () => {
    try {
      const r = await b.usermeta.list();
      if (r && r.ok && r.items) {
        for (const k of Object.keys(table)) delete table[k];
        Object.assign(table, r.items);
      }
    } catch (e) { /* 读不到就当没有用户改动，不影响目录显示 */ }
    loaded = true;
    inflight = null;
    return table;
  })();
  return inflight;
}

/** 该条目的用户改动；没有则空对象（**空 = 用原始值**）。 */
export function metaOf(kind, id) {
  if (id === undefined || id === null) return {};
  return table[String(kind) + ':' + String(id)] || {};
}

/** 展示名：用户改过用用户的，否则原始名。 */
export function displayName(kind, it) {
  return metaOf(kind, it && it.id).name || ((it && it.name) || '');
}
export function authorOf(kind, it) { return metaOf(kind, it && it.id).author || ''; }
export function tagsOf(kind, it) { return metaOf(kind, it && it.id).tags || []; }
export function categoryOf(kind, it) {
  return metaOf(kind, it && it.id).category || ((it && it.category) || '');
}
export function isPinned(kind, it) { return metaOf(kind, it && it.id).pinned === true; }

/** 搜索用的文本：名字 / 作者 / 标签 / 分类 + 调用方给的原始字段。 */
export function searchHay(kind, it, extra) {
  const parts = [displayName(kind, it), it && it.name, authorOf(kind, it),
    categoryOf(kind, it), tagsOf(kind, it).join(' '), extra || ''];
  return parts.filter(Boolean).join(' ').toLowerCase();
}

/** 排序：**顶置优先** → 用户 order → 原始顺序（稳定，没动过的不会乱跳）。 */
export function orderList(kind, list) {
  return (list || [])
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      const ma = metaOf(kind, a.it && a.it.id);
      const mb = metaOf(kind, b.it && b.it.id);
      const pa = ma.pinned === true ? 0 : 1;
      const pb = mb.pinned === true ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const oa = Number.isFinite(ma.order) ? ma.order : Number.MAX_SAFE_INTEGER;
      const ob = Number.isFinite(mb.order) ? mb.order : Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      return a.i - b.i;
    })
    .map((x) => x.it);
}

async function write(kind, id, patch) {
  const b = bridge();
  if (!b || !b.usermeta || !b.usermeta.set) return false;
  const r = await b.usermeta.set(kind, id, patch);
  if (!(r && r.ok)) return false;
  await loadUserMeta(true);
  return true;
}

/** 顶置开关（写回数据根的表）。 */
export async function togglePin(kind, id) {
  const now = metaOf(kind, id).pinned === true;
  return write(kind, id, { pinned: !now });
}

/** 改名 / 作者 / 来源 / 标签 / 分类。清空某字段 = 回到原始值。 */
export async function setMeta(kind, id, patch) { return write(kind, id, patch); }

/** 清掉这个条目的全部用户改动。 */
export async function clearMeta(kind, id) {
  const b = bridge();
  if (!b || !b.usermeta || !b.usermeta.remove) return false;
  const r = await b.usermeta.remove(kind, id);
  if (!(r && r.ok)) return false;
  await loadUserMeta(true);
  return true;
}

/** 把「可见子集的新顺序」回填到「全量顺序」里它们占据的那些位置上。
 *
 *  ★ 为什么必须有这一步：分类/搜索时列表只是全集的一个子集。如果直接把子集的顺序整体写下去，
 *    没显示出来的条目还留着旧的 order，两边就会交错。
 *    第一版的做法是"过滤时干脆禁止拖拽"（draggable=false）—— 结果用户在「原神」这样的
 *    分类里根本排不了序（实测反馈）。
 *    正确语义是：**可见条目占据的那些位置不动，只把它们的内部顺序换成刚拖出来的样子**；
 *    没显示的条目一个都不动。这样筛选状态下拖动既有确定语义，又不会打乱别处。
 *
 *  例：全量 [A,B,C,D,E]，可见 [A,C,E]；把 E 拖到最前 → 可见 [E,A,C]
 *      → 回填后 [E,B,A,D,C]。可见项的显示顺序正是 [E,A,C]，而 B/D 原地不动。
 *
 *  ⚠ 跨分组的拖动在**分组视图**里可能看不出变化（例如把 A 组的条目拖到 B 组的条目旁）：
 *    条目归哪一组由数据决定、不由顺序决定。顺序本身是写对了的。
 */
export function mergeSubsetOrder(allIds, subsetOrderedIds) {
  const inSubset = new Set(subsetOrderedIds);
  const out = [];
  let k = 0;
  for (const id of (allIds || [])) out.push(inSubset.has(id) ? subsetOrderedIds[k++] : id);
  return out;
}

/** 保存某个 kind 的展示顺序（传**完整**列表的 id，顺序即展示顺序）。 */
export async function saveOrder(kind, ids) {
  const b = bridge();
  if (!b || !b.usermeta || !b.usermeta.reorder) return false;
  const r = await b.usermeta.reorder(kind, ids);
  if (!(r && r.ok)) return false;
  await loadUserMeta(true);
  return true;
}
