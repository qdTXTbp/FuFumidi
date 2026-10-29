<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, reactive } from 'vue';
import Icon from './Icon.vue';
import CloudUserDialog from './CloudUserDialog.vue';
import { useAppStore, SIDEBAR_DEFAULT_W, SIDEBAR_MIN_W } from '../stores/app';
import { usePlaylistStore } from '../stores/playlist';
import { useCloudStore } from '../stores/cloud';
import logoUrl from '../assets/logo.png';
import { t } from '../core/i18n.js';
import { cleanTags, addTag, removeTagAt, tagSummary } from '../core/tags.js';
import { getAppVersion } from '../core/version.js';
import { fmtTime } from '../core/util.js';
import { fitMenu } from '../core/menu.js';

const app = useAppStore();
const state = app;
const cloud = useCloudStore();
const appVersion = ref('v3.1.8');
getAppVersion().then(v => { appVersion.value = v; });
const importFiles = (items, target) => app.importFiles(items, target);
const importWithPicker = (items) => app.importWithPicker(items);
const selectSong = (id) => app.selectSong(id);
// 双击播放：常规歌单软件的通用交互（单击选中 / 双击切歌并开始播放）
const playSong = (id) => app.playSongById(id);
const removeSong = (id, opts) => app.removeSong(id, opts);
const toast = (m, t) => app.toast(m, t);

const fileInput = ref(null);
const dragOver = ref(false);

const bridge = window.fuBridge;
const playlist = usePlaylistStore();

function isFav(id) { return playlist.isFavorite(id); }
function toggleFav(id) {
  const on = !playlist.isFavorite(id);
  playlist.toggleFavorite(id);
  toast(on ? t('已加入收藏') : t('已取消收藏'), 'ok');
}

/* ---------------- 侧边栏宽度拖动（带范围限制） ---------------- */
function startResize(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  app.sidebarResizing = true;
  document.body.classList.add('resize-col');
  const startX = e.clientX;
  const startW = app.sidebarWidth;
  // 视口限制：拖动时最多占到视口减去主区域最小宽度，避免把主区域挤没
  const maxW = Math.max(SIDEBAR_MIN_W, window.innerWidth - 360);
  const onMove = (ev) => {
    app.setSidebarWidth(Math.min(maxW, startW + (ev.clientX - startX)));
  };
  const onUp = () => {
    app.sidebarResizing = false;
    document.body.classList.remove('resize-col');
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}
function resetSidebarWidth() {
  app.setSidebarWidth(SIDEBAR_DEFAULT_W);
}
function onResizerKey(e) {
  if (e.key === 'ArrowLeft') { app.setSidebarWidth(app.sidebarWidth - 20); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { app.setSidebarWidth(app.sidebarWidth + 20); e.preventDefault(); }
  else if (e.key === 'Home') { resetSidebarWidth(); e.preventDefault(); }
}

/* ---------------- 歌单数据 ---------------- */
// 整理方式（默认/艺术家/专辑/流派/文件夹），持久化到 localStorage
const libSort = ref((() => { try { return localStorage.getItem('fufumidi_libsort') || 'default'; } catch (e) { return 'default'; } })());
watch(libSort, (v) => { try { localStorage.setItem('fufumidi_libsort', v); } catch (e) {} });

/* ---------------- 筛选（标签 / 流派 / 艺术家 / 专辑） ----------------
   ★ 2026-10-17 用户：「全部曲目里可以筛选标签、流派、艺术家」「还可以筛选专辑」。
   与「整理方式」分开：整理方式决定**顺序**，筛选决定**看哪一些**，两者可叠加、都可清空。
   选项从**当前歌单里真实出现过的值**里取（含计数）—— 不列永远选不中的空值。 */
const FILTER_KINDS = [
  { k: 'tag', label: '标签' }, { k: 'genre', label: '流派' },
  { k: 'artist', label: '艺术家' }, { k: 'album', label: '专辑' },
];
const filterOpen = ref(false);
const filterBtn = ref(null);
const filterPopStyle = ref({});
const filterKind = ref('tag');
const filterSel = reactive(new Set());
const filterCount = computed(() => filterSel.size);
function setFilterKind(k) { filterKind.value = k; filterSel.clear(); }
function toggleFilterVal(v) { if (filterSel.has(v)) filterSel.delete(v); else filterSel.add(v); }
function clearFilter() { filterSel.clear(); filterOpen.value = false; }
/** 筛选浮层：fixed 定位（侧栏/滚动容器会裁切 absolute 浮层），按视口夹紧、空间不足时翻到按钮上方 */
function positionFilterPop() {
  const el = filterBtn.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const width = Math.min(320, Math.max(200, window.innerWidth - 16));
  let left = r.left;
  if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
  if (left < 8) left = 8;
  const maxH = Math.max(180, Math.min(360, window.innerHeight - 24));
  const below = window.innerHeight - r.bottom - 8;
  const style = { left: left + 'px', width: width + 'px', maxHeight: Math.min(maxH, Math.max(180, below)) + 'px' };
  if (below >= 240) style.top = (r.bottom + 4) + 'px';
  else { style.bottom = Math.max(8, window.innerHeight - r.top + 4) + 'px'; style.maxHeight = Math.min(maxH, Math.max(180, r.top - 12)) + 'px'; }
  filterPopStyle.value = style;
}
function toggleFilter() {
  filterOpen.value = !filterOpen.value;
  if (filterOpen.value) nextTick(positionFilterPop);
}
function closeFilter() { filterOpen.value = false; }
function onDocDown(e) {
  if (!filterOpen.value) return;
  const tgt = e.target;
  if (filterBtn.value && filterBtn.value.contains(tgt)) return;
  if (tgt && tgt.closest && tgt.closest('.lib-filter-pop')) return;
  closeFilter();
}
// Esc：浮层自上而下关闭（筛选 → 右键菜单）。菜单用键盘打开后焦点在菜单里，
// 这里的捕获阶段兜底保证「焦点不巧落回行/遮罩」时 Esc 仍然有效。
function onDocKey(e) {
  if (e.key !== 'Escape') return;
  closeFilter();
  if (plMenu.value) closePlMenu();
  if (songMenu.value) closeSongMenu();
}
function tagValuesOf(id) {
  const tg = app.songTags(id) || {};
  if (filterKind.value === 'tag') return cleanTags(tg.tags);
  return [String(tg[filterKind.value] == null ? '' : tg[filterKind.value]).trim()].filter(Boolean);
}
const filterOptions = computed(() => {
  const m = new Map();
  for (const sg of app.queueSongs) {
    for (const v of tagValuesOf(sg.id)) m.set(v, (m.get(v) || 0) + 1);
  }
  return Array.from(m.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .map(([v, n]) => ({ v, n }));
});
function songMatchesFilter(sg) {
  if (!filterSel.size) return true;
  return tagValuesOf(sg.id).some((v) => filterSel.has(v));
}
const isAllView = computed(() => playlist.activePlaylistId === 'all');
const isFavView = computed(() => playlist.activePlaylistId === 'favorites');
/** 虚拟智能视图（全部曲目/收藏/最近播放/最常播放）：没有真实的歌单归属，不能「移除」 */
const isVirtualView = computed(() => ['all', 'favorites', 'recent', 'most'].includes(String(playlist.activePlaylistId)));
const activePlaylist = computed(() => playlist.activePlaylist);

const visibleSongs = computed(() => {
  const base = app.queueSongs.filter(songMatchesFilter);   // 先筛选，再排序
  if (libSort.value === 'default') return base;
  const key = (s) => {
    const tg = app.songTags(s.id) || {};
    if (libSort.value === 'artist') return (tg.artist || '—').toLowerCase();
    if (libSort.value === 'album') return ((tg.album || '—') + ' ' + s.name).toLowerCase();
    if (libSort.value === 'genre') return ((tg.genre || '—') + ' ' + s.name).toLowerCase();
    if (libSort.value === 'folder') {
      const fp = (s.meta && s.meta.fp) || '';
      const dir = fp.includes('\\') || fp.includes('/') ? fp.replace(/[\\/][^\\/]*$/, '').toLowerCase() : '—';
      return dir + ' ' + s.name.toLowerCase();
    }
    return s.name.toLowerCase();
  };
  return base.slice().sort((a, b) => key(a).localeCompare(key(b), 'zh'));
});
/* ---------------- 编辑信息弹窗（重命名 + 艺术家/专辑/流派 + 自定义标签） ----------------
   ★ 2026-10-17 用户：「侧边栏对歌曲的编辑信息功能要可以重命名和自定义标签」。
   原来是一串 prompt（艺术家 → 专辑 → 流派 → 封面），改三项要点三次确定；
   而标签是**多个**的，用 prompt 根本表达不了。现在五项一次放进一张卡里。 */
const infoTarget = ref(null);
const infoForm = reactive({ name: '', artist: '', album: '', genre: '', tags: [] });
const tagInput = ref('');
function openInfo(s) {
  if (!s) return;
  infoTarget.value = s;
  const tg = app.songTags(s.id) || {};
  infoForm.name = s.name || '';
  infoForm.artist = tg.artist || '';
  infoForm.album = tg.album || '';
  infoForm.genre = tg.genre || '';
  infoForm.tags = cleanTags(tg.tags);
  tagInput.value = '';
}
function closeInfo() { infoTarget.value = null; tagInput.value = ''; }
function addInfoTag() { infoForm.tags = addTag(infoForm.tags, tagInput.value); tagInput.value = ''; }
function removeInfoTag(i) { infoForm.tags = removeTagAt(infoForm.tags, i); }
async function saveInfo() {
  const s = infoTarget.value;
  if (!s) return;
  const renamed = await app.renameSong(s.id, infoForm.name);
  app.setSongTags(s.id, {
    artist: infoForm.artist.trim(), album: infoForm.album.trim(), genre: infoForm.genre.trim(),
    tags: cleanTags(infoForm.tags),
  });
  app.toast(renamed ? t('已重命名并保存信息') : t('信息已保存'), 'ok');
  closeInfo();
}
/** 列表行里展示的标签（最多 2 条，多的折成 +N） */
function rowTags(id) { const tg = app.songTags(id) || {}; return tagSummary(cleanTags(tg.tags)); }
// 旧的 prompt 版仍留着（右键菜单里没走弹窗时的兜底，其它页面也可能调用）
async function editTags(id) { try { await app.editTags(id); } catch (e) {} }
function tagOf(id) { return app.songTags(id) || {}; }
function rowCover(id) { const t = app.songTags(id); return t && t.cover ? t.cover : ''; }
function rowSub(s) {
  const tg = app.songTags(s.id) || {};
  const bits = [];
  if (tg.artist) bits.push(tg.artist);
  if (tg.album) bits.push(tg.album);
  const tgSum = rowTags(s.id);
  if (tgSum) bits.push(tgSum);
  return bits.join(' · ');
}

/* ---------------- 歌单批量管理（4.0.0 式子页面） ---------------- */
const batchManagerOpen = ref(false);
const batchManagerPl = ref(null);
const bmSel = ref(new Set());
const bmSongs = computed(() => {
  const pl = batchManagerPl.value;
  if (!pl) return [];
  const all = app.songs || [];
  return (pl.songIds || []).map(id => all.find(s => s.id === id)).filter(Boolean);
});
function openBatchManager(pl) {
  if (!pl) return;
  batchManagerPl.value = pl;
  bmSel.value = new Set();
  playlist.select(pl.id);
  batchManagerOpen.value = true;
}
function closeBatchManager() { batchManagerOpen.value = false; batchManagerPl.value = null; bmSel.value = new Set(); }
function bmIsSel(id) { return bmSel.value.has(id); }
function bmToggle(id) {
  const s = new Set(bmSel.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  bmSel.value = s;
}
function bmAll() {
  const ids = bmSongs.value.map(s => s.id);
  bmSel.value = ids.length && ids.every(id => bmSel.value.has(id)) ? new Set() : new Set(ids);
}
/** 移除：只把曲目移出本歌单，全部曲目与本地 .mid 文件都不动 */
function bmDelete() {
  const ids = [...bmSel.value];
  if (!ids.length) { toast(t('请先勾选曲目'), 'warn'); return; }
  openConfirm(t('移除曲目'), t('确定从本歌单移除选中的 ') + ids.length + t(' 首曲目？曲目仍保留在全部曲目中。'), () => {
    playlist.removeSongs(ids);
    bmSel.value = new Set();
    toast(t('已移除 ') + ids.length + t(' 首'), 'ok');
  });
}
/** 删除：从全部曲目与所有歌单移除，并删除本地 MIDI 文件（不可撤销） */
function bmDeleteForever() {
  const ids = [...bmSel.value];
  if (!ids.length) { toast(t('请先勾选曲目'), 'warn'); return; }
  openConfirm(
    t('删除曲目'),
    t('确定删除选中的 ') + ids.length + t(' 首曲目？将从全部曲目与所有歌单移除，并删除本地 MIDI 文件，不可撤销。'),
    () => {
      (async () => {
        for (const id of ids) await removeSong(id, { deleteFile: true });
        bmSel.value = new Set();
        toast(t('已删除 ') + ids.length + t(' 首'), 'ok');
      })();
    },
    t('删除')
  );
}
function bmMove(plId) {
  const pl = batchManagerPl.value;
  const ids = [...bmSel.value];
  if (!ids.length || !plId) { toast(t('请先勾选曲目'), 'warn'); return; }
  playlist.addToPlaylist(plId, ids);
  if (pl && pl.id !== plId) playlist.removeSongs(ids);
  bmSel.value = new Set();
  const target = playlist.playlists.find(p => p.id === plId);
  toast(t('已移动 ') + ids.length + t(' 首到「') + (target ? target.name : '') + '」', 'ok');
}
/** 勾选项是否已全部收藏（决定按钮显示「收藏」还是「取消收藏」） */
const bmAllFav = computed(() => {
  const ids = [...bmSel.value];
  return ids.length > 0 && ids.every(id => playlist.isFavorite(id));
});
/** 批量收藏/取消收藏：全部已收藏则统一取消，否则统一收藏；保留勾选便于继续移动/移除 */
function bmFav() {
  const ids = [...bmSel.value];
  if (!ids.length) { toast(t('请先勾选曲目'), 'warn'); return; }
  const turnOff = ids.every(id => playlist.isFavorite(id));
  for (const id of ids) if (turnOff === playlist.isFavorite(id)) playlist.toggleFavorite(id);
  toast((turnOff ? t('已取消收藏 ') : t('已收藏 ')) + ids.length + t(' 首'), 'ok');
}
/** 单行收藏切换（不改变勾选状态） */
function bmToggleFav(id) {
  const on = !playlist.isFavorite(id);
  playlist.toggleFavorite(id);
  toast(on ? t('已收藏') : t('已取消收藏'), 'ok');
}
/* 子页面内拖动排序 */
const bmDragId = ref(null);
const bmDragOverId = ref(null);
function bmDragStart(s, e) {
  bmDragId.value = s.id;
  if (e && e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', s.id); } catch (err) {}
  }
}
function bmDragOver(e, s) { if (bmDragId.value) bmDragOverId.value = s.id; }
function bmDrop(e, s) {
  const dragId = bmDragId.value, targetId = s.id;
  bmDragId.value = null; bmDragOverId.value = null;
  if (dragId && targetId && dragId !== targetId) {
    const pl = batchManagerPl.value;
    if (pl) {
      const ti = pl.songIds.indexOf(targetId);
      if (ti >= 0) playlist.moveSongToIndex(dragId, ti);
    }
  }
}
function bmDragEnd() { bmDragId.value = null; bmDragOverId.value = null; }

/* ---------------- 歌单右键菜单 ---------------- */
const plMenu = ref(null); // { x, y, pl }
// 菜单的来源行：关闭时把焦点还回去（键盘打开菜单的必要条件）
const menuReturnEl = ref(null);
/* ★ 落点按**真实尺寸**夹（旧版猜 130/246 高：菜单一变长，底部就落到窗口外点不到，
   用户 2026-10-14 报的就是这个）。见 core/menu.js。 */
const plMenuEl = ref(null);
const plMenuPos = ref(null);
const songMenuEl = ref(null);
const songMenuPos = ref(null);
/** 菜单打开时把焦点放进去：鼠标右键与 Shift+F10 走同一条路，键盘才按得到菜单项 */
async function placeMenu(el, pos, m, focusFirst) {
  await nextTick();
  const p = fitMenu(el.value, m.x, m.y);
  if (p) pos.value = p;
  if (focusFirst && el.value) {
    await nextTick();   // 位置写入后菜单才从 visibility:hidden 变可见，隐藏元素 focus() 无效
    const first = el.value.querySelector('button:not([disabled])');
    if (first) first.focus();
  }
}
/** 关闭菜单后把焦点还给打开它的那一行（否则焦点跟着被移除的节点掉回 body） */
function restoreMenuFocus() {
  const el = menuReturnEl.value;
  menuReturnEl.value = null;
  try { if (el && el.isConnected && typeof el.focus === 'function') el.focus(); } catch (e) {}
}
/** 键盘打开菜单的落点：行左下角，别落在窗口左上角 */
function menuAnchor(el) {
  try {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + 12), y: Math.round(r.bottom - 2) };
  } catch (e) { return { x: 12, y: 12 }; }
}
function openPlMenu(e, pl) {
  const pt = (e.clientX || e.clientY) ? { x: e.clientX, y: e.clientY } : menuAnchor(e.currentTarget);
  menuReturnEl.value = e.currentTarget || null;
  plMenu.value = { x: pt.x, y: pt.y, pl };
  plMenuPos.value = null;
  placeMenu(plMenuEl, plMenuPos, plMenu.value, true);
}
function closePlMenu() { plMenu.value = null; plMenuPos.value = null; restoreMenuFocus(); }

/* ---------------- 浮层的键盘模型（P1-3 / P1-4） ----------------
   曲库行与歌单行原来是 div + @click，键盘完全够不到。这里只补语义与键位，
   不动任何布局：元素仍是 div，行内样式、命中区、拖动排序都不变。
   · 曲目行 = listbox 的 option：Enter/Space 选中（批量模式切换勾选），Ctrl+Enter 播放（双击的等价物），
     Shift+F10 打开右键菜单；
   · 歌单/智能视图 = button：Enter/Space 切换，Shift+F10 打开歌单菜单；
   · 所有处理都先判 e.target === e.currentTarget：行内还有收藏 / 加歌单 / 编辑 / 删除按钮，
     它们的回车不能被整行抢走。 */
function onViewKey(e, id) {
  if (e.target !== e.currentTarget) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); playlist.select(id); }
}
function onPlaylistKey(e, pl) {
  if (e.target !== e.currentTarget) return;
  if (e.key === 'F10' && e.shiftKey) { e.preventDefault(); e.stopPropagation(); openPlMenu(e, pl); return; }
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); playlist.select(pl.id); }
}
function onSongRowKey(e, s) {
  if (e.target !== e.currentTarget) return;
  if (e.key === 'F10' && e.shiftKey) { e.preventDefault(); e.stopPropagation(); openSongMenu(e, s); return; }
  // listbox 的方向键：上下移动焦点（不顺手切歌 —— 选中即加载曲目，方向键不该触发重活）
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const el = e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
    if (el && el.focus) { e.preventDefault(); e.stopPropagation(); el.focus(); }
    return;
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault(); e.stopPropagation();
    if (!playlist.batchOn) playSong(s.id);
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault(); e.stopPropagation();
    if (playlist.batchOn) batchToggle(s.id); else selectSong(s.id);
  }
}
/** 菜单内的方向键 / Home / End 移动，Esc 关闭并把焦点还给来源行（role=menu 的键盘约定） */
function onMenuKey(e, elRef, close) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
  // 非模态菜单：Tab 收起菜单并把焦点还给来源行，不把焦点困在浮层里（也不留给已移除的节点）
  if (e.key === 'Tab') { e.preventDefault(); close(); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault(); e.stopPropagation();
  // 模板里传进来的是「已解包的 DOM 元素」，脚本里传进来的是 ref —— 两种都认
  const root = elRef && elRef.value ? elRef.value : (elRef && elRef.querySelector ? elRef : null);
  if (!root) return;
  const items = Array.from(root.querySelectorAll('button:not([disabled])'));
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  let n = 0;
  if (e.key === 'ArrowUp') n = i <= 0 ? items.length - 1 : i - 1;
  else if (e.key === 'ArrowDown') n = (i < 0 || i === items.length - 1) ? 0 : i + 1;
  else if (e.key === 'End') n = items.length - 1;
  items[n].focus();
}
function plMenuStyle() {
  const p = plMenuPos.value;
  return p ? { left: p.left + 'px', top: p.top + 'px' } : { left: '0px', top: '0px', visibility: 'hidden' };
}

/* ---------------- 曲目列表右键菜单（二级界面） ---------------- */
const SONG_MENU_W = 186;
const SONG_SUB_W = 168;
const songMenu = ref(null);   // { x, y, s }
const songSub = ref(false);   // 「添加到歌单」子菜单是否展开
function openSongMenu(e, s) {
  const pt = (e.clientX || e.clientY) ? { x: e.clientX, y: e.clientY } : menuAnchor(e.currentTarget);
  menuReturnEl.value = e.currentTarget || null;
  songMenu.value = { x: pt.x, y: pt.y, s };
  songSub.value = false;
  songMenuPos.value = null;
  placeMenu(songMenuEl, songMenuPos, songMenu.value, true);
  // 批量模式下右键任意一行，先把它纳入勾选集合，菜单随后可直接操作
  if (playlist.batchOn && !batchIsSel(s.id)) batchToggle(s.id);
}
function closeSongMenu() { songMenu.value = null; songSub.value = false; songMenuPos.value = null; restoreMenuFocus(); }
function songMenuStyle() {
  const p = songMenuPos.value;
  return p ? { left: p.left + 'px', top: p.top + 'px' } : { left: '0px', top: '0px', visibility: 'hidden' };
}
/** 子菜单是否向左弹出（贴近视口右缘时）：按**实际落点**算，不再按猜测宽度 */
const songSubFlip = computed(() => {
  const p = songMenuPos.value;
  if (!p) return false;
  return p.left + SONG_MENU_W + SONG_SUB_W > window.innerWidth;
});
/** 右键菜单内直接加入指定歌单（不经过「添加到歌单」弹窗） */
function songMenuAddTo(plId) {
  const s = songMenu.value && songMenu.value.s;
  if (!s) return;
  const pl = playlist.playlists.find(p => p.id === plId);
  if (pl) { playlist.addToPlaylist(plId, [s.id]); toast(t('已添加到「') + pl.name + '」', 'ok'); }
  closeSongMenu();
}
/** 曲目列表右键「批量管理」：歌单内打开 4.0.0 式子页面；聚合视图（全部曲目/收藏等）退回顶部工具栏批量模式 */
function songMenuBatch(s) {
  closeSongMenu();
  const cur = playlist.playlists.find(p => p.id === playlist.activePlaylistId);
  if (cur) { openBatchManager(cur); return; }
  if (!playlist.batchOn) playlist.toggleBatch();
  const sel = new Set(playlist.batchSelection);
  sel.add(s.id);
  playlist.setBatchSelected([...sel]);
}

/* ---------------- 歌曲拖动排序 ---------------- */
const dragId = ref(null);
const dragOverId = ref(null);
const canReorder = computed(() => !isFavView.value && playlist.songIds.length > 0);
function resetDrag() {
  dragId.value = null;
  dragOverId.value = null;
  document.querySelectorAll('.song-item').forEach(x => x.classList.remove('drag-before', 'drag-after'));
}
function dragStart(s, e) {
  dragId.value = s.id;
  dragOverId.value = s.id;
  if (e && e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', s.id); } catch (err) {}
  }
}
function dragOverRow(e, s) {
  if (!dragId.value || !canReorder.value) return;
  dragOverId.value = s.id;
}
function dragLeaveRow(e) {
  e.currentTarget.classList.remove('drag-before', 'drag-after');
}
function dragOverList() {
  if (dragId.value && canReorder.value) dragOverId.value = null;
}
function dropOn(e, target) {
  e.stopPropagation();
  if (dragId.value && target && dragId.value !== target.id) {
    const to = visibleSongs.value.findIndex(x => x.id === target.id);
    if (to >= 0) playlist.moveSongToIndex(dragId.value, to);
  }
  resetDrag();
}
function dropOnList() {
  if (!dragId.value || !canReorder.value) return;
  playlist.moveSongToEnd(dragId.value);
  resetDrag();
}

/* ---------------- 歌单拖动重排 ---------------- */
const plDragId = ref(null);
const plOverId = ref(null);
const canReorderPlaylists = computed(() => playlist.playlists.length > 1);
function plDragStart(p) {
  plDragId.value = p.id;
  plOverId.value = p.id;
}
function plDragOver(e, targetId) {
  if (!plDragId.value || plDragId.value === targetId) return;
  plOverId.value = targetId;
  const r = e.currentTarget.getBoundingClientRect();
  const before = (e.clientY - r.top) < r.height / 2;
  const row = e.currentTarget;
  row.classList.toggle('pl-drag-before', before);
  row.classList.toggle('pl-drag-after', !before);
}
function plDragLeave(e) {
  e.currentTarget.classList.remove('pl-drag-before', 'pl-drag-after');
}
function plDrop(e, targetId) {
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  const before = (e.clientY - r.top) < r.height / 2;
  if (plDragId.value && targetId && plDragId.value !== targetId) {
    playlist.movePlaylist(plDragId.value, targetId, before);
  }
  resetPlDrag();
}
function plDropEnd() {
  if (!plDragId.value || !canReorderPlaylists.value) return;
  playlist.movePlaylistToEnd(plDragId.value);
  resetPlDrag();
}
function resetPlDrag() {
  plDragId.value = null;
  plOverId.value = null;
  document.querySelectorAll('.pl-item').forEach(x => x.classList.remove('pl-drag-before', 'pl-drag-after'));
}

function baseName(p) { return String(p).split(/[\\/]/).pop() || t('未命名.mid'); }

/* ---------------- 歌单操作（master 交互） ---------------- */
const plCreating = ref(false);
const plCollapsed = ref(false);
const newPlName = ref('');
function createPl(name) {
  const n = (name == null ? newPlName.value : name).trim();
  if (n) {
    const id = playlist.create(n);
    toast(t('已创建歌单「') + n + '」', 'ok');
    if (id) playlist.select(id);
  }
  newPlName.value = '';
  plCreating.value = false;
  return playlist.playlists.find(p => p.name === n);
}
function onNewPlKey(e) {
  if (e.key === 'Enter') createPl();
  if (e.key === 'Escape') { plCreating.value = false; newPlName.value = ''; }
}

/* ---------------- 应用内弹窗：添加/重命名/确认 ---------------- */
const addToPlFor = ref(null);          // 待添加到歌单的曲目 id
const addToPlNew = ref('');
const renameTarget = ref(null);        // { pl }
const renameVal = ref('');
const confirmDlg = ref(null);          // { title, msg, onOk }

function openAddToPl(songId) { addToPlFor.value = songId; addToPlNew.value = ''; }
function closeAddToPl() { addToPlFor.value = null; }
function addToPlChoose(plId) {
  const id = addToPlFor.value;
  if (!id) return;
  const pl = playlist.playlists.find(p => p.id === plId);
  if (pl) { playlist.addToPlaylist(plId, [id]); toast(t('已添加到「') + pl.name + '」', 'ok'); }
  addToPlFor.value = null;
}
function addToPlCreate() {
  const id = addToPlFor.value;
  const name = addToPlNew.value.trim();
  if (!id || !name) return;
  let pl = playlist.playlists.find(p => p.name === name);
  if (!pl) { playlist.create(name); pl = playlist.playlists.find(p => p.name === name); }
  if (pl) { playlist.addToPlaylist(pl.id, [id]); toast(t('已添加到「') + pl.name + '」', 'ok'); }
  addToPlFor.value = null;
}
function openRename(pl) { renameTarget.value = pl; renameVal.value = pl.name; }
function closeRename() { renameTarget.value = null; }
function confirmRename() {
  const pl = renameTarget.value;
  if (!pl || !renameVal.value.trim()) return;
  playlist.rename(pl.id, renameVal.value.trim());
  toast(t('已重命名'), 'ok');
  renameTarget.value = null;
}
function openConfirm(title, msg, onOk, okText) { confirmDlg.value = { title, msg, onOk, okText: okText || t('删除') }; }
function closeConfirm() { confirmDlg.value = null; }
function runConfirm() {
  const d = confirmDlg.value;
  if (!d) return;
  closeConfirm();
  if (typeof d.onOk === 'function') d.onOk();
}
function deletePl(pl) {
  const last = playlist.playlists.length <= 1;
  openConfirm(last ? t('清空默认歌单') : t('删除歌单'),
    last ? t('确定清空当前默认歌单？') : t('删除歌单「') + pl.name + t('」') + t('？') + t(' 将从所有歌单移除。'),
    () => { playlist.remove(pl.id); toast(t('歌单已处理'), 'ok'); },
    last ? t('清空') : undefined);
}
/**
 * 移除：只解除歌曲与「当前歌单」的归入关系。
 * 永远不动资料库（全部曲目）与本地 .mid 文件；收藏页里的「移除」等价于取消收藏。
 */
function songRemove(s) {
  if (isFavView.value) { toggleFav(s.id); return; }
  if (isVirtualView.value) { toast(t('该视图是智能筛选而非歌单，请使用「删除」'), 'warn'); return; }
  playlist.removeSongs([s.id]);
  toast(t('已从歌单移除「') + s.name + t('」'), 'ok');
}
/** 删除：从全部曲目与所有歌单移除，并删除本地 MIDI 文件（不可撤销） */
function songDelete(s) {
  openConfirm(
    t('删除曲目'),
    t('将删除「') + s.name + t('」：从全部曲目与所有歌单移除，并删除本地 MIDI 文件。此操作不可撤销。'),
    () => {
      removeSong(s.id, { deleteFile: true });
      toast(t('已删除「') + s.name + t('」'), 'ok');
    },
    t('删除')
  );
}
/** 在资源管理器中定位曲目对应的真实 .mid 文件 */
async function songReveal(s) {
  try {
    const p = (s && s.meta && s.meta.path) || '';
    if (!bridge || typeof bridge.revealMidi !== 'function') { toast(t('当前环境不支持'), 'warn'); return; }
    const r = await bridge.revealMidi(p);
    if (r && r.ok) toast(r.fellBackToDir ? t('该曲目暂无本地文件，已打开曲库目录') : t('已在资源管理器中定位'), 'ok');
    else toast(t('打开失败：') + ((r && r.error) || ''), 'error');
  } catch (e) { toast(t('打开失败：') + String(e), 'error'); }
}
/* ---------------- 歌曲列表：批量管理（多选 / 全选 / 批量操作） ---------------- */
// 勾选状态存在 playlist store 的 batchOn / batchSelection；歌单右键「批量管理」复用同一套
const batchSel = computed(() => new Set(playlist.batchSelection));
const allVisibleSelected = computed(() => {
  const ids = visibleSongs.value.map(s => s.id);
  return ids.length > 0 && ids.every(id => batchSel.value.has(id));
});
const allSelectedFav = computed(() => {
  const ids = playlist.batchSelection;
  return ids.length > 0 && ids.every(id => playlist.isFavorite(id));
});
function batchIsSel(id) { return batchSel.value.has(id); }
function batchToggle(id) {
  const s = new Set(playlist.batchSelection);
  if (s.has(id)) s.delete(id); else s.add(id);
  playlist.setBatchSelected([...s]);
}
/** 全选/取消全选：作用于「当前可见」的曲目（已应用搜索与整理方式） */
function batchAll() {
  playlist.setBatchSelected(allVisibleSelected.value ? [] : visibleSongs.value.map(s => s.id));
}
function exitBatch() {
  playlist.setBatchSelected([]);
  if (playlist.batchOn) playlist.toggleBatch();
}
function batchMove(plId) {
  const ids = playlist.batchSelection.slice();
  if (!ids.length) { toast(t('请先勾选曲目'), 'warn'); return; }
  const target = playlist.playlists.find(p => p.id === plId);
  if (!target) return;
  playlist.addToPlaylist(plId, ids);
  // 目标不是当前歌单时等同「移动」：从当前歌单移除，避免同一首同时留在两边
  if (plId !== playlist.activePlaylistId) playlist.removeSongs(ids);
  playlist.setBatchSelected([]);
  toast(t('已移动 ') + ids.length + t(' 首到「') + target.name + '」', 'ok');
}
function batchFavorite() {
  const ids = playlist.batchSelection.slice();
  if (!ids.length) { toast(t('请先勾选曲目'), 'warn'); return; }
  // 选中的全部已收藏 → 这次取消收藏；否则统一设为收藏
  const turnOff = ids.every(id => playlist.isFavorite(id));
  for (const id of ids) if (turnOff === playlist.isFavorite(id)) playlist.toggleFavorite(id);
  playlist.setBatchSelected([]);
  toast((turnOff ? t('已取消收藏 ') : t('已收藏 ')) + ids.length + t(' 首'), 'ok');
}
/** 批量移除：只解除与「当前歌单」的归入关系，资料库与本地文件不动（收藏页=取消收藏） */
function batchRemove() {
  const ids = playlist.batchSelection.slice();
  if (!ids.length) { toast(t('请先勾选曲目'), 'warn'); return; }
  if (isFavView.value) { batchFavorite(); return; }
  if (isVirtualView.value) { toast(t('该视图是智能筛选而非歌单，请使用「删除」'), 'warn'); return; }
  openConfirm(t('移除曲目'), t('确定从当前歌单移除选中的 ') + ids.length + t(' 首曲目？曲目仍保留在全部曲目中。'), () => {
    playlist.removeSongs(ids);
    playlist.setBatchSelected([]);
    toast(t('已移除 ') + ids.length + t(' 首'), 'ok');
  });
}
/** 批量删除：从全部曲目与所有歌单移除，并删除本地 MIDI 文件（不可撤销） */
function batchDelete() {
  const ids = playlist.batchSelection.slice();
  if (!ids.length) { toast(t('请先勾选曲目'), 'warn'); return; }
  openConfirm(
    t('删除曲目'),
    t('确定删除选中的 ') + ids.length + t(' 首曲目？将从全部曲目与所有歌单移除，并删除本地 MIDI 文件，不可撤销。'),
    () => {
      // 串行 await：并发删除会让每次 removeSong 末尾的续播互相打断（播放抖动、重复解析）
      (async () => {
        for (const id of ids) await removeSong(id, { deleteFile: true });
        playlist.setBatchSelected([]);
        toast(t('已删除 ') + ids.length + t(' 首'), 'ok');
      })();
    },
    t('删除')
  );
}
// 切歌单 / 改搜索 / 换整理方式后，勾选集合里可能留下当前列表看不到的曲目，
// 那样「已选 N」与实际可操作对象不符 —— 只保留仍在可见列表里的。
watch([() => playlist.activePlaylistId, () => playlist.search, libSort], () => {
  if (!playlist.batchOn) return;
  const vis = new Set(visibleSongs.value.map(s => s.id));
  const kept = playlist.batchSelection.filter(id => vis.has(id));
  if (kept.length !== playlist.batchSelection.length) playlist.setBatchSelected(kept);
});

const emptyHint = computed(() => {
  if (playlist.search && !visibleSongs.value.length) return t('未找到匹配的曲目');
  if (isFavView.value) return t('收藏为空，点击歌曲右侧 ♥ 收藏。');
  if (isAllView.value) return t('暂无曲目。') + t('点击上方「导入到曲库」或直接拖入文件。');
  return t('歌单为空，点击歌曲右侧「＋」加入。');
});

/* ---------------- 歌曲信息显示 ---------------- */
function fmtDur(s) {
  const sec = s.song ? s.song.totalSec : s.meta.dur;
  return sec ? fmtTime(sec) : '';
}

/* ---------------- 导入 ---------------- */
async function onPick() {
  if (bridge && bridge.pickFile) {
    try {
      const p = await bridge.pickFile({ filters: [{ name: 'MIDI', extensions: ['mid', 'midi', 'kar', 'rmi'] }] });
      if (!p) return;
      const ab = await bridge.readBinary(p);
      if (!ab) { toast(t('读取文件失败'), 'error'); return; }
      await importWithPicker([{ name: baseName(p), bytes: new Uint8Array(ab) }]);
    } catch (e) { /* ignore */ }
    return;
  }
  fileInput.value && fileInput.value.click();
}

async function onPickFolder() {
  if (!bridge || !bridge.pickDirectory || !bridge.listMidiFiles || !bridge.readBinary) { toast(t('请使用桌面版选择文件夹'), 'warn'); return; }
  try {
    const dir = await bridge.pickDirectory();
    if (!dir) return;
    const files = await bridge.listMidiFiles(dir);
    if (!files || !files.length) { toast(t('文件夹里没有 MIDI 文件'), 'warn'); return; }
    const items = [];
    for (const p of files.slice(0, 100)) {
      try {
        const ab = await bridge.readBinary(p);
        if (ab) items.push({ name: baseName(p), bytes: new Uint8Array(ab) });
      } catch (e) {}
    }
    if (items.length) {
      // 与文件导入一致：先询问导入到哪个歌单（含批量）
      importWithPicker(items);
    }
  } catch (e) { /* ignore */ }
}

function onFileChange(e) {
  const files = Array.from(e.target.files || []);
  const items = files.map(f => ({ name: f.name, bytes: null }));
  Promise.all(files.map(f => f.arrayBuffer())).then(bufs => {
    importWithPicker(items.map((it, i) => ({ name: it.name, bytes: new Uint8Array(bufs[i]) })));
  });
  e.target.value = '';
}

function onDrop(e) {
  dragOver.value = false;
  const files = Array.from(e.dataTransfer.files || []).filter(f => /\.(mid|midi|kar|rmi|mp3|wav|flac|m4a|ogg|aac|opus)$/i.test(f.name));
  if (!files.length) return;
  Promise.all(files.map(f => f.arrayBuffer())).then(bufs => {
    importWithPicker(files.map((f, i) => ({ name: f.name, bytes: new Uint8Array(bufs[i]) })));
  });
}

onMounted(() => {
  playlist.hydrateFavorites();
  cloud.init();
  document.addEventListener('pointerdown', onDocDown, true);
  document.addEventListener('keydown', onDocKey, true);
  window.addEventListener('resize', positionFilterPop);
  window.addEventListener('scroll', positionFilterPop, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocDown, true);
  document.removeEventListener('keydown', onDocKey, true);
  window.removeEventListener('resize', positionFilterPop);
  window.removeEventListener('scroll', positionFilterPop, true);
});

// 云同步用户弹窗开关（点击左下角头像触发）
const showAuth = ref(false);
</script>

<template>
  <aside class="sidebar" role="navigation" :aria-label="t('侧边导航')" @dragover.prevent="dragOver = true" @dragleave="dragOver = false" @drop.prevent="onDrop">
    <div class="sidebar-body">
      <div class="side-actions">
        <button class="icon-btn side-act" data-guide="sidebar-import" :title="t('导入到曲库')" :aria-label="t('导入到曲库')" @click="onPick"><Icon name="import" :size="16" /><span class="pl-sr">{{ t('导入到曲库') }}</span></button>
        <button class="icon-btn side-act" :title="t('导入文件夹')" :aria-label="t('导入文件夹')" @click="onPickFolder"><Icon name="folder" :size="16" /></button>
      </div>
      <input ref="fileInput" id="midi-file-input" name="midi-file" type="file" accept=".mid,.midi,.kar,.rmi,.mp3,.wav,.flac,.m4a,.ogg,.aac,.opus" hidden multiple @change="onFileChange">

      <!-- 搜索 -->
      <div class="pl-search">
        <Icon name="search" :size="13" />
        <input id="sidebar-search" name="sidebar-search" v-model="playlist.search" class="text-input" :placeholder="t('搜索曲目')" :aria-label="t('搜索曲目')" />
        <button v-if="playlist.search" class="icon-btn" style="width:18px;height:18px;flex:none" :title="t('清空')" :aria-label="t('清空')" @click="playlist.search = ''"><Icon name="close" :size="11" /></button>
      </div>
      <div class="pl-controls">
        <select class="lib-sort" :title="t('整理方式')" :value="libSort" @change="libSort = $event.target.value">
          <option value="default">{{ t('默认') }}</option>
          <option value="artist">{{ t('按艺术家') }}</option>
          <option value="album">{{ t('按专辑') }}</option>
          <option value="genre">{{ t('按流派') }}</option>
          <option value="folder">{{ t('按文件夹') }}</option>
        </select>
        <!-- 筛选：标签 / 流派 / 艺术家 / 专辑（与整理方式叠加） -->
        <span class="lib-filter">
          <button ref="filterBtn" class="chip-btn" :class="{ on: filterCount > 0 }" :title="t('按标签 / 流派 / 艺术家 / 专辑筛选')" @click="toggleFilter">
            <Icon name="filter" :size="14" /><b v-if="filterCount" class="lib-filter-n">{{ filterCount }}</b>
          </button>
          <button v-if="filterCount" class="chip-btn" :title="t('清除筛选')" @click="clearFilter">✕</button>
        </span>
      </div>
      <Teleport to="body">
        <div v-if="filterOpen" class="lib-filter-pop" :style="filterPopStyle" @click.stop>
          <div class="lib-filter-kinds">
            <button v-for="k in FILTER_KINDS" :key="k.k" class="chip-btn" :class="{ on: filterKind === k.k }" @click="setFilterKind(k.k)">{{ t(k.label) }}</button>
          </div>
          <div class="lib-filter-vals">
            <button v-for="o in filterOptions" :key="o.v" class="chip-btn" :class="{ on: filterSel.has(o.v) }" @click="toggleFilterVal(o.v)">
              {{ o.v }}<span class="lib-filter-c">{{ o.n }}</span>
            </button>
            <span v-if="!filterOptions.length" class="muted small">{{ t('这首歌单里还没有这类信息') }}</span>
          </div>
        </div>
      </Teleport>

      <div class="nav-sep"></div>

      <!-- 歌单列表 -->
      <div class="pl-head" data-guide="sidebar-playlists">
        <span class="nav-group-title pl-title-icon" :title="t('MIDI 歌单')" :aria-label="t('MIDI 歌单')"><Icon name="list" :size="14" /></span>
        <div style="display:flex;gap:2px">
          <button class="icon-btn" style="width:24px;height:24px" :title="plCollapsed ? t('展开歌单') : t('折叠歌单')" :aria-label="plCollapsed ? t('展开歌单') : t('折叠歌单')" @click="plCollapsed = !plCollapsed">
            {{ plCollapsed ? '▸' : '▾' }}
          </button>
          <button class="icon-btn" style="width:24px;height:24px" :title="t('新建歌单')" :aria-label="t('新建歌单')" @click="plCreating = !plCreating">
            <Icon name="plus" :size="14" />
          </button>
        </div>
      </div>
      <div v-if="plCreating" class="pl-new">
        <input v-model="newPlName" class="text-input" style="flex:1;padding:var(--sp-1) var(--sp-2);font-size:var(--fs-sm)" :placeholder="t('歌单名')" :aria-label="t('歌单名')" @keydown.enter="onNewPlKey" @keydown.esc="onNewPlKey" autofocus />
        <button class="btn sm" style="padding:3px var(--sp-3)" @click="createPl()">{{ t('确定') }}</button>
      </div>

      <template v-if="!plCollapsed">
      <div class="pl-grid" data-guide="sidebar-views">
        <!-- 智能视图：div 保留（命中区/图标排版不动），补 button 语义 + 键盘 -->
        <div class="pl-item" role="button" tabindex="0" :title="t('全部曲目')" :class="{ on: isAllView }"
             :aria-current="isAllView ? 'true' : undefined" @click="playlist.select('all')" @keydown="onViewKey($event, 'all')">
          <Icon name="music" :size="13" /><span class="pl-sr">{{ t('全部曲目') }}</span><em>{{ state.songs.length }}</em>
        </div>
        <div class="pl-item" role="button" tabindex="0" :title="t('收藏')" :class="{ on: isFavView }"
             :aria-current="isFavView ? 'true' : undefined" @click="playlist.select('favorites')" @keydown="onViewKey($event, 'favorites')">
          <Icon name="heart" :size="13" /><span class="pl-sr">{{ t('收藏') }}</span><em>{{ playlist.favorites.length }}</em>
        </div>
        <div class="pl-item" role="button" tabindex="0" :title="t('最近播放')" :class="{ on: playlist.activePlaylistId === 'recent' }"
             :aria-current="playlist.activePlaylistId === 'recent' ? 'true' : undefined" @click="playlist.select('recent')" @keydown="onViewKey($event, 'recent')">
          <Icon name="clock" :size="13" /><span class="pl-sr">{{ t('最近播放') }}</span>
        </div>
        <div class="pl-item" role="button" tabindex="0" :title="t('最常播放')" :class="{ on: playlist.activePlaylistId === 'most' }"
             :aria-current="playlist.activePlaylistId === 'most' ? 'true' : undefined" @click="playlist.select('most')" @keydown="onViewKey($event, 'most')">
          <Icon name="zap" :size="13" /><span class="pl-sr">{{ t('最常播放') }}</span>
        </div>
      </div>
      <!-- 数字 1..9 = 切到第 N 个歌单（与 App.vue 的数字键处理一一对应，编号直接画在这里） -->
      <div class="pl-playlist-scroll">
      <div class="pl-item pl-playlist" v-for="(pl, plIdx) in playlist.playlists" :key="pl.id"
           :title="plIdx < 9 ? t('快捷键 ') + (plIdx + 1) : ''"
           role="button" tabindex="0" :aria-current="playlist.activePlaylistId === pl.id ? 'true' : undefined"
           :class="{ on: playlist.activePlaylistId === pl.id, dragging: plDragId === pl.id, dragTarget: plOverId === pl.id, dragable: canReorderPlaylists }"
           :draggable="canReorderPlaylists"
           @dragstart="plDragStart(pl)"
           @dragover.prevent="plDragOver($event, pl.id)"
           @dragleave="plDragLeave($event)"
           @drop.stop.prevent="plDrop($event, pl.id)"
           @dragend="resetPlDrag()"
           @contextmenu.prevent="openPlMenu($event, pl)"
           @keydown="onPlaylistKey($event, pl)"
           @click="playlist.select(pl.id)">
        <span v-if="canReorderPlaylists" class="pl-drag"><Icon name="drag" :size="12" /></span>
        <span v-if="plIdx < 9" class="pl-key">{{ plIdx + 1 }}</span>
        <Icon name="folder" :size="13" /><span class="pl-name" :title="pl.name">{{ pl.name }}</span><em>{{ pl.songIds.length }}</em>
      </div>
      </div>
      </template>

      <div class="sidebar-songs">
      <div class="nav-sep"></div>

      <!-- 歌曲列表（按当前歌单过滤） -->
      <div v-if="!visibleSongs.length" class="side-empty">
        <Icon name="music" :size="14" /><span>{{ t('暂无曲目') }}</span>
      </div>

      <!-- 批量管理模式工具栏：入口统一到曲目右键「批量管理」（歌单内直接开 4.0.0 式管理子页面） -->
      <div v-if="playlist.batchOn" class="bm-bar song-batch-bar">
        <span class="batch-count">{{ playlist.batchSelection.length }} {{ t('已选') }}</span>
        <button class="btn sm" @click="batchAll">{{ allVisibleSelected ? t('取消全选') : t('全选') }}</button>
        <select class="select-input" style="flex:1;min-width:0" :value="''" @change="e => e.target.value && (batchMove(e.target.value), e.target.value = '')">
          <option value="" disabled>{{ t('移到歌单…') }}</option>
          <option v-for="pl in playlist.playlists" :key="pl.id" :value="pl.id">{{ pl.name }}</option>
        </select>
        <button class="btn sm" @click="batchFavorite" :disabled="!playlist.batchSelection.length">{{ allSelectedFav ? t('取消收藏') : t('收藏') }}</button>
        <!-- 移除：仅解除与当前歌单的归入关系（智能筛选视图下不适用） -->
        <button v-if="!isVirtualView" class="btn sm" @click="batchRemove" :disabled="!playlist.batchSelection.length">{{ t('移除') }}</button>
        <!-- 删除：从全部曲目与所有歌单移除，并删除本地 MIDI 文件 -->
        <button class="btn sm danger" @click="batchDelete" :disabled="!playlist.batchSelection.length">{{ t('删除') }}</button>
        <button class="btn sm ghost" @click="exitBatch">{{ t('完成') }}</button>
      </div>

      <!-- 曲目行：listbox + option（P1-3）。行内仍有收藏/加歌单/编辑/删除按钮，键盘处理判 e.target 避免抢键 -->
      <div class="song-list" role="listbox" :aria-label="t('曲库')" :aria-multiselectable="playlist.batchOn ? 'true' : undefined"
           :class="{ 'drag-active': dragId && canReorder && !playlist.batchOn }" @dragover.prevent="dragOverList" @drop.prevent.stop="dropOnList">
        <div class="song-item" v-for="(s, i) in visibleSongs" :key="s.id"
           role="option" tabindex="0" :aria-selected="playlist.batchOn ? batchIsSel(s.id) : s.id === state.currentId"
           :aria-label="s.name"
           @keydown="onSongRowKey($event, s)"
           :class="{ active: s.id === state.currentId, dragging: dragId === s.id, dragTarget: dragOverId === s.id, 'batch-sel': playlist.batchOn && batchIsSel(s.id) }"
           :draggable="canReorder && !playlist.batchOn"
           @dragstart="dragStart(s, $event)"
           @dragover.prevent="dragOverRow($event, s)"
           @dragleave="dragLeaveRow($event)"
           @drop.stop.prevent="dropOn($event, s)"
           @dragend="resetDrag()"
           @contextmenu.prevent="openSongMenu($event, s)"
           @click="playlist.batchOn ? batchToggle(s.id) : selectSong(s.id)"
           @dblclick="playlist.batchOn ? batchToggle(s.id) : playSong(s.id)">
        <input v-if="playlist.batchOn" class="si-check" type="checkbox" :checked="batchIsSel(s.id)" :title="s.name" :aria-label="s.name" @click.stop="batchToggle(s.id)" />
        <span v-if="canReorder && !playlist.batchOn" class="si-drag" :title="t('拖动排序')" :aria-label="t('拖动排序')"><Icon name="drag" :size="13" /></span>
        <span class="si-num" v-if="(!state.playing || s.id !== state.currentId)">{{ i + 1 }}</span>
        <span class="si-num playing-ic" v-else>▶</span>
        <img v-if="rowCover(s.id)" class="si-cover" :src="rowCover(s.id)" alt="" />
        <div class="si-name">
          <b :title="s.name">{{ s.name }}</b>
          <small>{{ rowSub(s) ? rowSub(s) + ' · ' : '' }}{{ s.song ? s.song.tracks.length : (s.meta.tracks || '—') }} {{ t(' 轨 · ') }} {{ (s.meta.size / 1024).toFixed(0) }} KB<span v-if="fmtDur(s)"> · {{ fmtDur(s) }}</span></small>
        </div>
        <div class="si-tools" v-if="!playlist.batchOn">
          <button class="icon-btn heart" :class="{ on: isFav(s.id) }" style="width:26px;height:26px;font-size:var(--fs-md)" :title="t('收藏')" :aria-label="t('收藏')" @click.stop="toggleFav(s.id)">
            <Icon :name="isFav(s.id) ? 'heart' : 'heart-o'" :size="14" />
          </button>
          <button class="icon-btn" style="width:26px;height:26px;font-size:var(--fs-md)" :title="t('添加到歌单')" :aria-label="t('添加到歌单')" @click.stop="openAddToPl(s.id)">
            <Icon name="plus" :size="14" />
          </button>
          <button class="icon-btn" style="width:26px;height:26px;font-size:var(--fs-md)" :title="t('编辑信息（重命名 / 艺术家 / 专辑 / 流派 / 标签）')" :aria-label="t('编辑信息')" @click.stop="openInfo(s)">
            <Icon name="pencil" :size="13" />
          </button>
          <button class="icon-btn" style="width:26px;height:26px;font-size:var(--fs-md)" :title="isFavView ? t('取消收藏') : (isVirtualView ? t('删除（含本地文件）') : t('从歌单移除'))" :aria-label="t('移除')" @click.stop="isFavView ? toggleFav(s.id) : (isVirtualView ? songDelete(s) : songRemove(s))">
            <Icon name="trash" :size="14" />
          </button>
        </div>
        </div>
      </div>
      </div>
    </div>

    <div style="padding:var(--sp-3) var(--sp-4);border-top:1px solid var(--border)" class="small muted row">
      <!-- 版本号不折行：窄侧栏下「v5.0.0-beta.2」曾被折成两行（UX 复核第 6 条） -->
      <span class="tag ver-tag">{{ appVersion }}</span>
      <button class="cloud-user" style="margin-left:auto;display:flex;align-items:center;gap:var(--sp-2);background:none;border:none;color:inherit;cursor:pointer;padding:3px var(--sp-2);border-radius:var(--r-md)"
              :title="t('账号与云同步')" :aria-label="t('账号与云同步')" @click="showAuth = true">
        <span class="cloud-avatar">
          <svg viewBox="0 0 40 40" width="26" height="26" aria-hidden="true">
            <circle cx="20" cy="14" r="9" fill="var(--stone, #9aa0a6)"/>
            <path d="M7 36a13 13 0 0 1 26 0z" fill="var(--stone, #9aa0a6)"/>
          </svg>
        </span>
        <span class="cloud-uname" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:110px"
              :title="cloud.account ? cloud.account.email : t('未登录用户')">{{ cloud.account ? cloud.account.email : t('未登录用户') }}</span>
      </button>
    </div>

    <!-- 宽度拖动把手：拖拽调整侧边栏宽度（带范围限制） -->
    <div class="sidebar-resizer" role="separator" aria-orientation="vertical" tabindex="0"
         :title="t('拖动调整宽度')" :aria-label="t('拖动调整宽度')"
         @mousedown="startResize" @dblclick="resetSidebarWidth" @keydown="onResizerKey"></div>
  </aside>

  <!-- 弹窗通过 Teleport 挂到 body：.sidebar 的 backdrop-filter 会为 fixed 后代创建包含块，
       导致 position:fixed 被限制在侧边栏内，Teleport 到 body 后弹窗才能全屏居中 -->
  <Teleport to="body">
    <!-- 添加到歌单 -->
    <Transition name="ov">
      <div v-if="addToPlFor" class="ed-modal-mask" v-focus-trap role="dialog" aria-modal="true" :aria-label="t('添加到歌单')" @click.self="closeAddToPl" @keydown.esc="closeAddToPl">
        <div class="ed-modal" style="width:min(320px,92vw)">
          <div class="ed-modal-head">
            <b>{{ t('添加到歌单') }}</b>
            <button class="icon-btn" style="margin-left:auto" :title="t('关闭')" :aria-label="t('关闭')" @click="closeAddToPl"><Icon name="close" :size="14" /></button>
          </div>
          <div class="pl-add-list">
            <button class="pl-add-item" v-for="pl in playlist.playlists" :key="pl.id" @click="addToPlChoose(pl.id)">
              <Icon name="folder" :size="13" /><span class="pl-name">{{ pl.name }}</span><em>{{ pl.songIds.length }}</em>
            </button>
            <div v-if="!playlist.playlists.length" class="muted small" style="padding:var(--sp-2) 2px">{{ t('暂无歌单，可在下方新建') }}</div>
          </div>
          <div class="pl-add-new">
            <input id="pl-add-new-name" name="pl-add-new-name" v-model="addToPlNew" class="text-input" style="flex:1;min-width:0" :placeholder="t('新建歌单名')" :aria-label="t('新建歌单名')" @keydown.enter="addToPlCreate" @keydown.esc="closeAddToPl" />
            <button class="btn sm primary" @click="addToPlCreate">{{ t('新建并添加') }}</button>
          </div>
          <div class="ed-modal-foot">
            <button class="btn sm ghost" @click="closeAddToPl">{{ t('取消') }}</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 重命名歌单 -->
    <Transition name="ov">
      <div v-if="renameTarget" class="ed-modal-mask" v-focus-trap role="dialog" aria-modal="true" :aria-label="t('重命名歌单')" @click.self="closeRename" @keydown.esc="closeRename">
        <div class="ed-modal" style="width:min(320px,92vw)">
          <div class="ed-modal-head"><b>{{ t('重命名歌单') }}</b><button class="icon-btn" style="margin-left:auto" :title="t('关闭')" :aria-label="t('关闭')" @click="closeRename"><Icon name="close" :size="14" /></button></div>
          <div style="padding:var(--sp-4) var(--sp-1) var(--sp-1)">
            <input id="pl-rename-name" name="pl-rename-name" v-model="renameVal" class="text-input" style="width:100%" :aria-label="t('歌单名')" @keydown.enter="confirmRename" @keydown.esc="closeRename" />
          </div>
          <div class="ed-modal-foot">
            <button class="btn sm ghost" @click="closeRename">{{ t('取消') }}</button>
            <button class="btn sm primary" @click="confirmRename">{{ t('保存') }}</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 编辑信息：重命名 + 艺术家/专辑/流派 + 自定义标签 -->
    <Transition name="ov">
      <div v-if="infoTarget" class="ed-modal-mask" v-focus-trap role="dialog" aria-modal="true" :aria-label="t('编辑信息')" @click.self="closeInfo" @keydown.esc="closeInfo">
        <div class="ed-modal" style="width:min(430px,94vw)">
          <div class="ed-modal-head">
            <b>{{ t('编辑信息') }}</b>
            <button class="icon-btn" style="margin-left:auto" :title="t('关闭')" :aria-label="t('关闭')" @click="closeInfo"><Icon name="close" :size="14" /></button>
          </div>
          <div class="ed-info-body">
            <label class="ed-info-row">
              <span>{{ t('名称') }}</span>
              <input id="song-info-name" name="song-info-name" class="text-input" v-model="infoForm.name" :aria-label="t('歌曲名')" @keydown.enter="saveInfo" />
            </label>
            <label class="ed-info-row">
              <span>{{ t('艺术家') }}</span>
              <input id="song-info-artist" name="song-info-artist" class="text-input" v-model="infoForm.artist" :aria-label="t('艺术家')" @keydown.enter="saveInfo" />
            </label>
            <label class="ed-info-row">
              <span>{{ t('专辑') }}</span>
              <input id="song-info-album" name="song-info-album" class="text-input" v-model="infoForm.album" :aria-label="t('专辑')" @keydown.enter="saveInfo" />
            </label>
            <label class="ed-info-row">
              <span>{{ t('流派') }}</span>
              <input id="song-info-genre" name="song-info-genre" class="text-input" v-model="infoForm.genre" :aria-label="t('流派')" @keydown.enter="saveInfo" />
            </label>
            <div class="ed-info-row ed-info-tags">
              <span>{{ t('自定义标签') }}</span>
              <div class="ed-tag-box">
                <span v-for="(tg, i) in infoForm.tags" :key="tg + i" class="ed-tag-chip">
                  {{ tg }}
                  <button class="ed-tag-x" :title="t('移除标签')" :aria-label="t('移除标签')" @click.prevent="removeInfoTag(i)"><Icon name="close" :size="10" /></button>
                </span>
                <input id="song-info-tag" name="song-info-tag" class="ed-tag-input" v-model="tagInput"
                       :placeholder="t('输入标签后回车')" :aria-label="t('自定义标签')"
                       @keydown.enter.prevent="addInfoTag" @keydown.,.prevent="addInfoTag" />
              </div>
            </div>
            <p class="ed-info-hint">{{ t('重命名会同步改磁盘上的文件名；标签最多 24 条。') }}</p>
          </div>
          <div class="ed-modal-foot">
            <button class="btn sm ghost" @click="closeInfo">{{ t('取消') }}</button>
            <button class="btn sm primary" @click="saveInfo">{{ t('保存') }}</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 确认弹窗 -->
    <Transition name="ov">
      <div v-if="confirmDlg" class="ed-modal-mask ed-modal-top" v-focus-trap role="dialog" aria-modal="true" :aria-label="confirmDlg.title" @click.self="closeConfirm" @keydown.esc="closeConfirm">
        <div class="ed-modal" style="width:min(340px,92vw)">
          <div class="ed-modal-head"><b>{{ confirmDlg.title }}</b><button class="icon-btn" style="margin-left:auto" :title="t('关闭')" :aria-label="t('关闭')" @click="closeConfirm"><Icon name="close" :size="14" /></button></div>
          <div style="padding:var(--sp-4) var(--sp-1) var(--sp-1);line-height:1.6;color:var(--ink)" class="small">{{ confirmDlg.msg }}</div>
          <div class="ed-modal-foot">
            <button class="btn sm ghost" @click="closeConfirm">{{ t('取消') }}</button>
            <button class="btn sm danger" @click="runConfirm">{{ confirmDlg.okText }}</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 歌单右键菜单 -->
    <Transition name="ov">
      <div v-if="plMenu" class="pl-ctx-mask" @click.self="closePlMenu" @contextmenu.prevent="closePlMenu">
        <div ref="plMenuEl" class="pl-ctx-menu" :style="plMenuStyle()" role="menu" :aria-label="t('歌单')"
             @keydown="onMenuKey($event, plMenuEl, closePlMenu)">
          <button class="pl-ctx-item" @click="openBatchManager(plMenu.pl); closePlMenu()">{{ t('批量管理歌单') }}</button>
          <button class="pl-ctx-item" @click="openRename(plMenu.pl); closePlMenu()">{{ t('重命名') }}</button>
          <button class="pl-ctx-item danger" @click="deletePl(plMenu.pl); closePlMenu()">{{ t('删除歌单') }}</button>
        </div>
      </div>
    </Transition>

    <!-- 曲目右键菜单（二级界面：曲目列表） -->
    <Transition name="ov">
      <div v-if="songMenu" class="pl-ctx-mask" @click.self="closeSongMenu" @contextmenu.prevent="closeSongMenu">
        <div ref="songMenuEl" class="pl-ctx-menu song-ctx" :style="songMenuStyle()" role="menu" :aria-label="t('操作')"
             @keydown="onMenuKey($event, songMenuEl, closeSongMenu)">
          <button class="pl-ctx-item" @click="playSong(songMenu.s.id); closeSongMenu()">{{ t('播放') }}</button>
          <div class="ctx-sub-wrap" @mouseenter="songSub = true" @mouseleave="songSub = false">
            <button class="pl-ctx-item ctx-has-sub" @click="openAddToPl(songMenu.s.id); closeSongMenu()">
              <span>{{ t('添加到歌单') }}</span><span class="ctx-arrow">▸</span>
            </button>
            <div v-if="songSub" class="pl-ctx-menu ctx-sub" :class="{ flip: songSubFlip }">
              <button class="pl-ctx-item" v-for="pl in playlist.playlists" :key="pl.id" @click="songMenuAddTo(pl.id)">
                <span class="ctx-sub-name">{{ pl.name }}</span><em class="ctx-sub-num">{{ pl.songIds.length }}</em>
              </button>
              <div v-if="!playlist.playlists.length" class="muted small" style="padding:var(--sp-2) var(--sp-3)">{{ t('暂无歌单') }}</div>
              <div class="ctx-sep"></div>
              <button class="pl-ctx-item" @click="openAddToPl(songMenu.s.id); closeSongMenu()">{{ t('新建歌单…') }}</button>
            </div>
          </div>
          <button class="pl-ctx-item" @click="toggleFav(songMenu.s.id); closeSongMenu()">{{ isFav(songMenu.s.id) ? t('取消收藏') : t('收藏') }}</button>
          <button class="pl-ctx-item" @click="openInfo(songMenu.s); closeSongMenu()">{{ t('编辑信息') }}</button>
          <button class="pl-ctx-item" @click="songReveal(songMenu.s); closeSongMenu()">{{ t('打开所在文件夹') }}</button>
          <div class="ctx-sep"></div>
          <button class="pl-ctx-item" @click="songMenuBatch(songMenu.s)">{{ t('批量管理') }}</button>
          <!-- 移除：只解除与当前歌单的归入关系（全部曲目/收藏/智能筛选视图下不适用） -->
          <button v-if="!isVirtualView" class="pl-ctx-item" @click="songRemove(songMenu.s); closeSongMenu()">{{ t('从歌单移除') }}</button>
          <!-- 删除：从全部曲目与所有歌单移除，并删除本地 MIDI 文件 -->
          <button v-if="isFavView" class="pl-ctx-item danger" @click="toggleFav(songMenu.s.id); closeSongMenu()">{{ t('取消收藏') }}</button>
          <button v-else class="pl-ctx-item danger" @click="songDelete(songMenu.s); closeSongMenu()">{{ t('删除（含本地文件）') }}</button>
        </div>
      </div>
    </Transition>


    <!-- 歌单批量管理子页面（4.0.0 式管理菜单） -->
    <Transition name="ov">
      <div v-if="batchManagerOpen" class="ed-modal-mask" v-focus-trap role="dialog" aria-modal="true" :aria-label="t('批量管理歌单')" @click.self="closeBatchManager" @keydown.esc="closeBatchManager">
        <div class="ed-modal" style="width:min(560px,92vw)">
          <div class="ed-modal-head">
            <b>{{ t('批量管理歌单') }} · {{ batchManagerPl && batchManagerPl.name }}</b>
            <button class="icon-btn" style="margin-left:auto" :title="t('关闭')" :aria-label="t('关闭')" @click="closeBatchManager"><Icon name="close" :size="14" /></button>
          </div>
          <div class="bm-bar bm-manager-bar">
            <span class="batch-count">{{ bmSel.size }} {{ t('已选') }}</span>
            <button class="btn sm" @click="bmAll">{{ bmSongs.length && bmSongs.every(s => bmIsSel(s.id)) ? t('取消全选') : t('全选') }}</button>
            <span class="bm-spacer"></span>
            <button class="btn sm" :disabled="!bmSel.size" :title="t('批量收藏/取消收藏勾选的曲目')" @click="bmFav">
              <span class="bm-heart" :class="{ on: bmAllFav }">{{ bmAllFav ? '♥' : '♡' }}</span>
              {{ bmAllFav ? t('取消收藏') : t('收藏') }}
            </button>
            <select class="select-input bm-move" :value="''" :aria-label="t('移到歌单')" @change="e => e.target.value && (bmMove(e.target.value), e.target.value = '')">
              <option value="" disabled>{{ t('移到歌单…') }}</option>
              <option v-for="pl in playlist.playlists" :key="pl.id" :value="pl.id">{{ pl.name }}</option>
            </select>
            <button class="btn sm" @click="bmDelete" :disabled="!bmSel.size">{{ t('移除') }}</button>
            <button class="btn sm danger" @click="bmDeleteForever" :disabled="!bmSel.size">{{ t('删除') }}</button>
            <button class="btn sm ghost" @click="closeBatchManager">{{ t('完成') }}</button>
          </div>
          <div class="bm-list">
            <div v-if="!bmSongs.length" class="muted small" style="padding:var(--sp-3) var(--sp-1)">{{ t('当前歌单没有曲目') }}</div>
            <div v-for="s in bmSongs" :key="s.id" class="bm-item" :class="{ 'bm-drag-target': bmDragOverId === s.id, 'bm-fav-on': playlist.isFavorite(s.id) }"
                 draggable="true"
                 @dragstart="bmDragStart(s, $event)"
                 @dragover.prevent="bmDragOver($event, s)"
                 @drop.prevent="bmDrop($event, s)"
                 @dragend="bmDragEnd()"
                 @click="bmToggle(s.id)">
              <span class="bm-drag" :title="t('拖动排序')"><Icon name="drag" :size="13" /></span>
              <input type="checkbox" :checked="bmIsSel(s.id)" :aria-label="s.name" @click.stop="bmToggle(s.id)" />
              <span class="bm-name" :title="s.name">{{ s.name }}</span>
              <em class="muted small">{{ s.song ? s.song.tracks.length : (s.meta.tracks || '—') }} {{ t(' 轨') }}</em>
              <button class="bm-fav-btn" :class="{ on: playlist.isFavorite(s.id) }"
                      :title="playlist.isFavorite(s.id) ? t('取消收藏') : t('收藏')"
                      :aria-label="playlist.isFavorite(s.id) ? t('取消收藏') : t('收藏')"
                      @click.stop="bmToggleFav(s.id)">{{ playlist.isFavorite(s.id) ? '♥' : '♡' }}</button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 云同步/账号弹窗：未登录登录注册，已登录管理同步 -->
  <CloudUserDialog :open="showAuth" @close="showAuth = false" />
</template>

<style scoped>
.cloud-avatar {
  width: 28px; height: 28px; border-radius: 50%;
  background: var(--card, var(--surface-soft));
  display: inline-flex; align-items: center; justify-content: center;
  flex: none;
}
.cloud-avatar svg { display: block; border-radius: 50%; }
.cloud-user:hover { background: var(--hover, rgba(255,255,255,0.06)); }
.btn.sidebar-primary {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.btn.sidebar-primary:hover {
  background: color-mix(in srgb, var(--accent) 86%, var(--canvas));
  border-color: var(--accent);
}
.si-fav { color: var(--stone); font-size: var(--fs-md); }
.si-fav.on { color: var(--amber); }
/* 歌曲列表容器：拖拽高亮动画（上游 v3.0.0 恢复） */
.song-list { min-height: 18px; border-radius: var(--r-md); transition: box-shadow var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out); }
.song-list.drag-active { box-shadow: inset 0 0 0 1px var(--accent); background: color-mix(in srgb, var(--accent) 6%, transparent); }
.si-drag { display: inline-flex; align-items: center; color: var(--stone); cursor: grab; opacity: .35; margin-right: 2px; transition: opacity var(--motion-fast) var(--ease-out); user-select: none; }
.song-item:hover .si-drag, .song-item.dragging .si-drag { opacity: 1; }
.song-item.dragging { opacity: .45; }
.song-item.dragTarget { background: var(--surface-soft); box-shadow: inset 0 0 0 1px var(--accent); }

/* master 版歌单项：图标 + 计数 + hover 工具按钮 */
.pl-head { display: flex; align-items: center; justify-content: space-between; padding-right: var(--sp-2); }
.pl-hint { padding: 0 var(--sp-3) 2px; font-size: var(--fs-xs); color: var(--stone); }
.pl-new { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-1) var(--sp-3); }
/* 歌单列表容器：拖拽高亮动画（上游 v3.0.0 恢复） */
.pl-list { display: flex; flex-direction: column; gap: 2px; padding: 2px; margin-bottom: var(--sp-2); border: 1px solid transparent; border-radius: var(--r-md); transition: box-shadow var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out); }
.pl-list:has(.pl-item.dragging) { box-shadow: inset 0 0 0 1px var(--accent); background: color-mix(in srgb, var(--accent) 5%, transparent); }
.pl-item { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-md); color: var(--charcoal); cursor: pointer; border: 1px solid transparent; transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out); }
/* 智能入口 2×2 网格：全部曲目/收藏/最近播放/最常播放 两两并置，精简面板高度 */
.pl-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-1); padding: 0 var(--sp-2); margin-bottom: var(--sp-1); }
.pl-grid .pl-item { padding: var(--sp-2) var(--sp-2); gap: var(--sp-2); font-size: var(--fs-sm); min-width: 0; }
.pl-grid .pl-item span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-grid .pl-item em { flex: none; }
.pl-item:hover { background: var(--surface-soft); color: var(--ink); }
.pl-item.on { background: color-mix(in srgb, var(--brand-blue-200) 58%, transparent); color: var(--brand-blue-deep); font-weight: 600; }
.pl-item .pl-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 歌单的快捷键编号：小而未选中时低调，选中时高亮 */
.pl-item .pl-key { flex: none; width: 15px; text-align: center; font-size: var(--fs-xs); line-height: 15px;
                   border-radius: var(--r-sm); border: 1px solid var(--hairline); color: var(--stone); }
.pl-item.on .pl-key { border-color: var(--brand-blue); color: var(--brand-blue-deep); }
.pl-item em { font-style: normal; font-size: var(--fs-xs); color: var(--stone); font-variant-numeric: tabular-nums; }
.pl-item.on em { color: var(--brand-blue-deep); }
.pl-item .pl-tools { display: flex; gap: 2px; opacity: 0; transition: opacity var(--motion-fast) var(--ease-out); }
.pl-item:hover .pl-tools { opacity: 1; }
.pl-drag { display: inline-flex; align-items: center; color: var(--stone); opacity: .35; transition: opacity var(--motion-fast) var(--ease-out); user-select: none; }
.pl-item:hover .pl-drag, .pl-item.dragging .pl-drag { opacity: 1; }
.pl-item.dragging { opacity: .45; }
.pl-item.dragTarget { background: var(--surface-soft); }
.pl-item.pl-drag-before { box-shadow: 0 -2px 0 0 var(--accent) !important; }
.pl-item.pl-drag-after { box-shadow: 0 2px 0 0 var(--accent) !important; }

/* 曲目行：保持单行（曲名独占剩余宽度），工具按钮悬停时浮在右侧，
   不再参与布局计算 —— 否则 240px 侧栏里「序号/封面 + 曲名 + 4 个按钮」会折成三层、行高 100px+ */
.song-item .si-tools {
  position: absolute;
  top: 50%;
  right: 6px;
  transform: translateY(-50%);
  display: flex;
  gap: 2px;
  flex: none;
  padding: 2px 3px;
  border-radius: var(--r-md);
  background: linear-gradient(90deg, transparent, var(--surface-soft) 26%);
  box-shadow: none;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--motion-fast) var(--ease-out);
}
.song-item:hover .si-tools,
.song-item:focus-within .si-tools { opacity: 1; pointer-events: auto; }
.song-item.active:hover .si-tools { background: linear-gradient(90deg, transparent, var(--surface) 26%); }
.icon-btn.heart { color: var(--stone); }
.icon-btn.heart.on { color: var(--brand-coral); }

/* 搜索框 */
.pl-search { display: flex; align-items: center; gap: var(--sp-2); padding: 2px var(--sp-1); color: var(--stone); }
.pl-search .text-input { flex: 1; min-width: 0; padding: var(--sp-1) var(--sp-2); font-size: var(--fs-sm); }
.pl-search input::placeholder { color: var(--stone); opacity: .8; }
/* 第二行：整理方式 + 筛选（搜索框独占一行，窄侧栏不再把按钮挤出去） */
.pl-controls { display: flex; align-items: center; gap: var(--sp-2); padding: 2px var(--sp-1); }
.pl-controls .lib-sort { flex: 1; min-width: 0; }
.pl-controls .chip-btn { flex: none; }

/* 弹窗（与 ViewEdit 一致的应用内弹窗样式） */
.ed-modal-mask { position: fixed; inset: 0; background: rgba(10,10,10,0.35); display: flex; align-items: center; justify-content: center; z-index: var(--z-modal); }
/* 确认弹窗需要盖在批量管理子页面（同 z-index 且更靠后渲染）之上 */
.ed-modal-top { z-index: var(--z-modal-top); }
.ed-modal { width: min(560px, 92vw); background: var(--canvas); border-radius: var(--r-lg); box-shadow: 0 24px 64px rgba(16,24,40,0.2); padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); }
.ed-modal-head { display: flex; align-items: center; gap: var(--sp-3); font-size: var(--fs-lg); color: var(--ink); }
.ed-modal-head b { font-size: var(--fs-lg); }
.ed-modal-foot { display: flex; justify-content: flex-end; gap: var(--sp-2); }
.ed-modal-foot .btn.danger { border-color: rgba(212, 86, 86, 0.4); color: var(--error); }

/* 添加到歌单弹窗列表 */
.pl-add-list { display: flex; flex-direction: column; gap: 2px; max-height: 34vh; overflow-y: auto; }
.pl-add-item { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border: none; background: transparent; border-radius: var(--r-sm); font-size: var(--fs-md); color: var(--charcoal); cursor: pointer; text-align: left; transition: background var(--motion-fast) var(--ease-out); }
.pl-add-item:hover { background: var(--surface-soft); color: var(--ink); }
.pl-add-item .pl-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-add-item em { font-style: normal; font-size: var(--fs-xs); color: var(--stone); font-variant-numeric: tabular-nums; }
.pl-add-new { display: flex; align-items: center; gap: var(--sp-2); border-top: 1px dashed var(--hairline); padding-top: var(--sp-3); }

/* 侧边栏宽度拖动把手 */
.sidebar-resizer {
  position: absolute;
  top: 0; right: 0;
  width: 7px;
  height: 100%;
  cursor: col-resize;
  z-index: 6;
  touch-action: none;
}
.sidebar-resizer::after {
  content: '';
  position: absolute;
  top: 0; right: 1px;
  width: 2px;
  height: 100%;
  border-radius: var(--r-sm);
  background: transparent;
  transition: background var(--motion-fast) var(--ease-out);
}
.sidebar:hover .sidebar-resizer::after,
.sidebar-resizer:hover::after,
.sidebar-resizer:focus-visible::after,
body.resize-col .sidebar-resizer::after {
  background: color-mix(in srgb, var(--accent) 50%, transparent);
}
.sidebar-resizer:focus-visible { outline: none; }

/* 歌单右键菜单 */
.pl-ctx-mask { position: fixed; inset: 0; z-index: var(--z-ctx); }
.pl-ctx-menu { position: fixed; min-width: 176px; background: var(--surface); border: 1px solid color-mix(in srgb, var(--ornament) 32%, var(--hairline)); border-radius: var(--r-md); box-shadow: var(--shadow-lg); padding: var(--sp-1); backdrop-filter: var(--glass-blur); display: flex; flex-direction: column; gap: 2px; max-height: calc(100vh - 16px); overflow-y: auto; overscroll-behavior: contain; }
.pl-ctx-item { text-align: left; border: none; background: transparent; color: var(--ink); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-md); cursor: pointer; }
.pl-ctx-item:hover { background: var(--surface-soft); }
.pl-ctx-item.danger { color: var(--t-err); }
.pl-ctx-menu .ctx-sep { background: var(--hairline); }

/* 批量管理子页面 */
.bm-bar { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-3) var(--sp-1); flex-wrap: wrap; border-bottom: 1px solid var(--border); }
.bm-spacer { flex: 1; min-width: 0; }
.bm-move { flex: 0 1 150px; min-width: 104px; }
.bm-heart { color: var(--brand-magenta); font-size: var(--fs-sm); }
.bm-heart.on { color: var(--brand-coral); }
.bm-list { max-height: 52vh; overflow-y: auto; padding: var(--sp-2) var(--sp-1); display: flex; flex-direction: column; gap: 2px; }
.bm-item { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-2); border-radius: var(--r-md); cursor: pointer; }
.bm-item:hover { background: var(--surface-soft); }
.bm-item input { width: 14px; height: 14px; accent-color: var(--brand-blue); flex: none; }
.bm-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-md); color: var(--ink); }
.bm-fav-btn { flex: none; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--stone); font-size: var(--fs-sm); cursor: pointer; }
.bm-fav-btn:hover { background: var(--surface); color: var(--brand-coral); }
.bm-fav-btn.on { color: var(--brand-coral); }
.bm-item.bm-fav-on .bm-name { color: var(--ink-strong); }
.bm-drag-target { outline: 1px dashed var(--accent); background: var(--surface-soft); }
.bm-item[draggable="true"] { cursor: grab; }
.bm-item[draggable="true"]:active { cursor: grabbing; }
.bm-drag { display: inline-flex; align-items: center; color: var(--stone); cursor: grab; flex: none; }
/* 曲目列表上方的批量工具栏：比弹窗里的工具栏更紧凑，且不做分隔线 */
.song-batch-bar { padding: var(--sp-2) var(--sp-3); border-bottom: none; }
/* 批量模式下每行的勾选框 */
.si-check { width: 14px; height: 14px; flex: none; accent-color: var(--brand-blue); }
.song-item.batch-sel { background: var(--surface); box-shadow: inset 0 0 0 1px var(--accent); }

/* 曲目右键菜单：与歌单菜单同款，额外支持「添加到歌单」子菜单 */
.song-ctx { min-width: 186px; }
.ctx-sub-wrap { position: relative; }
.ctx-has-sub { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); width: 100%; }
.ctx-arrow { color: var(--stone); font-size: var(--fs-xs); line-height: 1; }
.pl-ctx-menu.ctx-sub {
  position: absolute; left: 100%; top: -4px; min-width: 168px;
  max-height: 46vh; overflow-y: auto;
}
.pl-ctx-menu.ctx-sub.flip { left: auto; right: 100%; }
.pl-ctx-menu.ctx-sub .pl-ctx-item { display: flex; align-items: center; gap: var(--sp-2); }
.ctx-sub-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctx-sub-num { font-style: normal; font-size: var(--fs-xs); color: var(--stone); font-variant-numeric: tabular-nums; }
.ctx-sep { height: 1px; background: var(--hairline); margin: 3px var(--sp-2); }
/* 筛选（与整理方式同排）：一个切换按钮 + 浮层（种类一行、取值一行带计数） */
.lib-filter { position: relative; display: inline-flex; align-items: center; gap: var(--sp-1); }
.lib-filter-n { color: var(--accent); margin-left: 3px; }
/* 浮层 fixed 定位（由 positionFilterPop 计算并夹紧视口）：侧栏/滚动容器不会裁切 */
.lib-filter-pop { position: fixed; z-index: 80; overflow: hidden; display: flex; flex-direction: column;
  padding: var(--sp-2); border: 1px solid var(--hairline); border-radius: var(--r-md); background: var(--surface); box-shadow: var(--shadow); }
.lib-filter-kinds { display: flex; flex-wrap: wrap; gap: var(--sp-1); padding-bottom: var(--sp-1); border-bottom: 1px solid var(--hairline-soft); }
.lib-filter-vals { display: flex; flex-wrap: wrap; gap: var(--sp-1); max-height: 190px; overflow: auto; padding-top: var(--sp-1); }
.lib-filter-c { color: var(--stone); margin-left: 3px; }
/* 编辑信息弹窗：四行输入 + 标签区（值全部走 token，界面审计的棘轮才不会被顶上去） */
.ed-info-body { padding: var(--sp-4) var(--sp-1) var(--sp-1); display: flex; flex-direction: column; gap: var(--sp-2); }
.ed-info-row { display: flex; align-items: center; gap: var(--sp-3); font-size: var(--fs-sm); color: var(--ink); }
.ed-info-row > span { flex: none; width: 62px; color: var(--stone); }
.ed-info-row .text-input { flex: 1; min-width: 0; }
.ed-info-tags { align-items: flex-start; }
.ed-tag-box { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1);
  padding: var(--sp-1); border: 1px solid var(--hairline); border-radius: var(--r-sm); background: var(--surface-soft); }
.ed-tag-chip { display: inline-flex; align-items: center; gap: var(--sp-1); padding: 1px var(--sp-2);
  border-radius: var(--r-pill); background: var(--accent-soft, var(--surface)); color: var(--accent);
  border: 1px solid var(--hairline); font-size: var(--fs-xs); }
.ed-tag-x { display: inline-flex; align-items: center; border: none; background: none; color: inherit; cursor: pointer; padding: 0; }
.ed-tag-input { flex: 1; min-width: 84px; border: none; background: none; outline: none; color: var(--ink); font-size: var(--fs-sm); }
.ed-info-hint { margin: 0; color: var(--stone); font-size: var(--fs-xs); line-height: 1.5; }

/* ── 侧栏拥挤治理（2026-10-22）──
   顶部操作固定，歌单区独立滚动，歌曲列表占剩余高度；歌单多时只滚歌单，不把曲目列表顶走。 */
.sidebar-body { overflow: hidden; min-height: 0; }
.pl-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-1);
  padding: 0 2px;
  margin-bottom: 2px;
}
.pl-grid .pl-item {
  padding: var(--sp-1) var(--sp-2);
  gap: var(--sp-1);
  font-size: var(--fs-xs);
  border-radius: var(--r-sm);
  min-width: 0;
}
.pl-grid .pl-item span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-grid .pl-item em { margin-left: 1px; flex: none; }
.pl-playlist-scroll {
  max-height: min(22vh, 176px);
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 2px;
  margin-bottom: var(--sp-1);
  overscroll-behavior: contain;
}
.pl-playlist-scroll::-webkit-scrollbar { width: 5px; }
.pl-playlist-scroll::-webkit-scrollbar-thumb { background: var(--hairline); border-radius: var(--r-pill); }
.pl-playlist { padding: 5px var(--sp-2); font-size: var(--fs-sm); }
.pl-playlist .pl-key { width: 13px; line-height: 13px; font-size: 0.62em; }
.pl-playlist em { font-size: var(--fs-xs); }
.sidebar-songs { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.sidebar-songs .song-list { flex: 1; min-height: 0; overflow-y: auto; }
.sidebar-songs .nav-sep { flex: none; }

/* 紧凑侧栏：无品牌区（logo 在左侧轨道）、图标化按钮、短标签 */
.side-actions { display: flex; align-items: center; gap: var(--sp-1); }
.side-act { width: 32px; height: 30px; border-radius: var(--r-sm); border: 1px solid var(--hairline); background: color-mix(in srgb, var(--surface) 60%, transparent); color: var(--text2); }
.side-act:hover { color: var(--accent-sky); border-color: color-mix(in srgb, var(--accent-sky) 35%, var(--hairline)); }
.side-empty { display: flex; align-items: center; justify-content: center; gap: var(--sp-1); padding: var(--sp-3); color: var(--text3); font-size: var(--fs-xs); }
.pl-title-icon { display: inline-flex; align-items: center; padding: var(--sp-1) var(--sp-2); color: var(--text3); }
.pl-grid .pl-item .pl-sr,
.pl-sr {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  padding: 0 !important;
  margin: -1px !important;
  overflow: hidden !important;
  clip: rect(0 0 0 0) !important;
  white-space: nowrap !important;
  border: 0 !important;
}
</style>