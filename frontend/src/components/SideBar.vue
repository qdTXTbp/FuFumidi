<script setup>
import { ref, computed, onMounted } from 'vue';
import Icon from './Icon.vue';
import { useAppStore } from '../stores/app';
import { usePlaylistStore } from '../stores/playlist';
import logoUrl from '../assets/logo.png';
import { t } from '../core/i18n.js';

const app = useAppStore();
const state = app;
const importFiles = (items) => app.importFiles(items);
const selectSong = (id) => app.selectSong(id);
const removeSong = (id) => app.removeSong(id);
const toast = (m, t) => app.toast(m, t);

const fileInput = ref(null);
const dragOver = ref(false);

const bridge = window.fuBridge;
const playlist = usePlaylistStore();

function loadFavs() {
  try { return new Set(JSON.parse(localStorage.getItem('fufumidi_favs') || '[]')); } catch (e) { return new Set(); }
}
const favs = ref(loadFavs());
function persistFavs() {
  try { localStorage.setItem('fufumidi_favs', JSON.stringify([...favs.value])); } catch (e) {}
  const b = window.fuBridge;
  if (b && b.dbKvSet) { try { b.dbKvSet('favorites', [...favs.value]); } catch (e) {} }
}
async function hydrateFavs() {
  const b = window.fuBridge;
  if (b && b.dbKvGet) {
    try {
      const v = await b.dbKvGet('favorites');
      if (Array.isArray(v)) {
        favs.value = new Set(v);
        try { localStorage.setItem('fufumidi_favs', JSON.stringify([...favs.value])); } catch (e) {}
      } else {
        persistFavs(); // 迁移旧 localStorage 收藏到 SQLite
      }
    } catch (e) {}
  }
}
function toggleFav(id) {
  const s = new Set(favs.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  favs.value = s;
  persistFavs();
}

/* ---------------- 歌单数据 ---------------- */
const batchOn = ref(false);
const batchSel = ref(new Set());

const activePlaylist = computed(() => playlist.activePlaylist);
const isFavView = computed(() => playlist.activePlaylistId === 'favorites');

const visibleSongs = computed(() => {
  const q = (playlist.search || '').trim().toLowerCase();
  let arr;
  if (isFavView.value) {
    arr = state.songs.filter(s => favs.value.has(s.id));
  } else {
    const ids = playlist.songIds;
    arr = state.songs.filter(s => ids.includes(s.id));
    const order = new Map(ids.map((id, idx) => [id, idx]));
    arr = arr.slice().sort((a, b) => {
      const ia = order.has(a.id) ? order.get(a.id) : Number.MAX_SAFE_INTEGER;
      const ib = order.has(b.id) ? order.get(b.id) : Number.MAX_SAFE_INTEGER;
      return ia - ib;
    });
  }
  if (playlist.favOnly) arr = arr.filter(s => favs.value.has(s.id));
  if (q) arr = arr.filter(s => (s.name || '').toLowerCase().includes(q));
  return arr;
});

function isSel(id) { return batchSel.value.has(id); }
function toggleSel(id) {
  const s = new Set(batchSel.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  batchSel.value = s;
}
function toggleBatch() {
  batchOn.value = !batchOn.value;
  batchSel.value = new Set();
}
function batchAll() {
  const ids = visibleSongs.value.map(s => s.id);
  const all = ids.length && ids.every(id => batchSel.value.has(id));
  batchSel.value = all ? new Set() : new Set(ids);
}
function batchFav() {
  for (const id of batchSel.value) if (!favs.value.has(id)) { const s = new Set(favs.value); s.add(id); favs.value = s; }
  persistFavs();
  toast(t('已收藏 ') + batchSel.value.size + t(' 首'), 'ok');
}
function batchUnfav() {
  for (const id of batchSel.value) if (favs.value.has(id)) { const s = new Set(favs.value); s.delete(id); favs.value = s; }
  persistFavs();
  toast(t('已取消收藏 ') + batchSel.value.size + t(' 首'), 'ok');
}
function batchRemove() {
  if (!batchSel.value.size) { toast(t('请先勾选曲目'), 'warn'); return; }
  const n = batchSel.value.size;
  playlist.removeSongs([...batchSel.value]);
  batchSel.value = new Set();
  toast(t('已从当前歌单移除 ') + n + t(' 首'), 'ok');
}
async function batchDeleteLibrary() {
  if (!batchSel.value.size) { toast('请先勾选曲目', 'warn'); return; }
  if (!window.confirm(t('确定从资料库删除 ') + batchSel.value.size + t(' 首曲目？'))) return;
  const ids = [...batchSel.value];
  for (const id of ids) await removeSong(id);
  playlist.removeFromAllPlaylists(ids);
  batchSel.value = new Set();
  toast(t('已删除 ') + ids.length + t(' 首'), 'ok');
}

const dragId = ref(null);
const dragOverId = ref(null);
const canReorder = computed(() =>
  !batchOn.value &&
  !isFavView.value &&
  !playlist.search &&
  !playlist.favOnly &&
  playlist.songIds.length > 0
);
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
  if (dragId.value && canReorder.value) {
    dragOverId.value = null;
  }
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

const playlistName = ref('');
const playlistNameOpen = ref(false);
const plCollapsed = ref(false);
function openNewPlaylist() {
  playlistName.value = '';
  playlistNameOpen.value = true;
}
function confirmNewPlaylist() {
  const name = playlistName.value.trim();
  if (!name) return;
  playlist.create(name);
  playlistNameOpen.value = false;
  playlistName.value = '';
  toast(t('已创建歌单「') + name + '」', 'ok');
}
function removeCurrentPlaylist() {
  const pid = playlist.activePlaylistId;
  if (pid === 'favorites') { toast(t('收藏视图不能删除'), 'warn'); return; }
  const pl = activePlaylist.value;
  if (!pl) return;
  if (!window.confirm(playlist.playlists.length <= 1 ? '清空当前默认歌单？' : '删除歌单「' + pl.name + '」？')) return;
  playlist.remove(pid);
  toast(t('歌单已处理'), 'ok');
}

function selectSongOrBatch(s) {
  if (batchOn.value) toggleSel(s.id);
  else selectSong(s.id);
}

async function onPick() {
  if (bridge && bridge.pickFile) {
    try {
      const p = await bridge.pickFile({ filters: [{ name: 'MIDI', extensions: ['mid', 'midi', 'kar', 'rmi'] }] });
      if (!p) return;
      const ab = await bridge.readBinary(p);
      if (!ab) { toast('读取文件失败', 'error'); return; }
      await importFiles([{ name: baseName(p), bytes: new Uint8Array(ab) }]);
    } catch (e) { /* ignore */ }
    return;
  }
  fileInput.value && fileInput.value.click();
}

async function onPickFolder() {
  if (!bridge || !bridge.pickDirectory || !bridge.listMidiFiles || !bridge.readBinary) { toast('请使用桌面版选择文件夹', 'warn'); return; }
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
      await importFiles(items);
      toast('已导入文件夹 ' + items.length + ' 个 MIDI', 'ok');
    }
  } catch (e) { /* ignore */ }
}

function onFileChange(e) {
  const files = Array.from(e.target.files || []);
  const items = files.map(f => ({ name: f.name, bytes: null }));
  Promise.all(files.map(f => f.arrayBuffer())).then(bufs => {
    importFiles(items.map((it, i) => ({ name: it.name, bytes: new Uint8Array(bufs[i]) })));
  });
  e.target.value = '';
}

function onDrop(e) {
  dragOver.value = false;
  const files = Array.from(e.dataTransfer.files || []).filter(f => /\.(mid|midi|kar|rmi)$/i.test(f.name));
  if (!files.length) return;
  Promise.all(files.map(f => f.arrayBuffer())).then(bufs => {
    importFiles(files.map((f, i) => ({ name: f.name, bytes: new Uint8Array(bufs[i]) })));
  });
}

onMounted(hydrateFavs);
</script>

<template>
  <aside class="sidebar" role="navigation" aria-label="t('侧边导航')" @dragover.prevent="dragOver = true" @dragleave="dragOver = false" @drop.prevent="onDrop">
    <div class="sidebar-brand">
      <div class="brand-logo"><img :src="logoUrl" alt="FuFumidi" /></div>
      <div>
        <div class="brand-name">FuFumidi</div>
        <div class="brand-sub">播放 · 编辑 · 转录 · 乐谱</div>
      </div>
    </div>

    <div class="sidebar-body">
      <button class="btn sidebar-primary" style="width:100%;justify-content:center" @click="onPick">
        <Icon name="import" :size="15" /> 导入 MIDI
      </button>
      <button class="btn sm" style="width:100%;justify-content:center;margin-top:6px" @click="onPickFolder">
        <Icon name="folder" :size="14" /> 导入文件夹
      </button>
      <input ref="fileInput" id="midi-file-input" name="midi-file" type="file" accept=".mid,.midi,.kar,.rmi" hidden multiple @change="onFileChange">

      <div class="nav-sep"></div>
      <div class="nav-group-title">
        <button class="pl-collapse" :title="plCollapsed ? t('展开歌单') : t('折叠歌单')" :aria-label="plCollapsed ? t('展开歌单') : t('折叠歌单')" @click="plCollapsed = !plCollapsed">
          {{ plCollapsed ? '▸' : '▾' }}
        </button>
        {{ t('MIDI 歌单') }} <span class="muted" style="float:right;text-transform:none;letter-spacing:0">{{ visibleSongs.length }}</span>
      </div>

      <template v-if="!plCollapsed">
<div class="pl-toolbar pl-head">
        <span class="pl-head-title">{{ t('歌单') }}</span>
        <button class="icon-btn" :title="t('新建歌单')" aria-label="t('新建歌单')" @click="openNewPlaylist" style="width:28px;height:28px"><Icon name="plus" :size="14" /></button>
      </div>

      <div class="pl-list" role="list" @dragover.prevent @drop.prevent.stop="plDropEnd">
        <div class="pl-item" role="listitem" :class="{ active: isFavView }" @click="playlist.select('favorites')">
          <span class="pl-star">★</span>
          <span class="pl-name">{{ t('收藏') }}</span>
          <span class="pl-count">{{ favs.size }}</span>
        </div>
        <div v-for="p in playlist.playlists" :key="p.id" class="pl-item"
             :class="{ active: playlist.activePlaylistId === p.id, dragging: plDragId === p.id, dragTarget: plOverId === p.id, dragable: canReorderPlaylists }"
             :draggable="canReorderPlaylists"
             @dragstart="plDragStart(p)"
             @dragover.prevent="plDragOver($event, p.id)"
             @dragleave="plDragLeave($event)"
             @drop.stop.prevent="plDrop($event, p.id)"
             @dragend="resetPlDrag()"
             @click="playlist.select(p.id)">
          <span v-if="canReorderPlaylists" class="pl-drag"><Icon name="drag" :size="12" /></span>
          <span class="pl-name">{{ p.name }}</span>
          <span class="pl-count">{{ p.songIds.length }}</span>
        </div>
      </div>

      </template>
      <div class="pl-toolbar">
        <input class="text-input" style="flex:1;min-width:0;padding:5px 8px;font-size:12px" :placeholder="t('搜索曲目')" aria-label="t('搜索曲目')" v-model="playlist.search" />
        <button class="chip-btn" :class="{ active: playlist.favOnly }" :title="t('只显示收藏')" @click="playlist.favOnly = !playlist.favOnly">★</button>
        <button class="chip-btn" :class="{ active: batchOn }" :title="t('批量管理')" @click="toggleBatch"><Icon name="menu" :size="13" />批量</button>
        <button class="chip-btn" :title="t('删除当前歌单')" @click="removeCurrentPlaylist" :disabled="playlist.activePlaylistId === 'favorites'"><Icon name="trash" :size="13" />删</button>
      </div>

      <div v-if="batchOn" class="pl-batch">
        <button class="chip-btn" @click="batchAll"><Icon name="target" :size="13" />{{ t('全选') }}</button>
        <button class="chip-btn" @click="batchFav">★ {{ t('收藏') }}</button>
        <button class="chip-btn" @click="batchUnfav">☆ {{ t('取消收藏') }}</button>
        <button class="chip-btn danger" @click="batchRemove"><Icon name="trash" :size="13" />{{ t('移除歌单') }}</button>
        <button class="chip-btn danger" @click="batchDeleteLibrary"><Icon name="trash" :size="13" />{{ t('删除库') }}</button>
        <button class="chip-btn" @click="toggleBatch"><Icon name="minus" :size="13" />{{ t('退出') }}</button>
        <span class="muted small">{{ t('已选 ') }}{{ batchSel.size }}</span>
      </div>

      <div class="song-list" role="list" :class="{ 'drag-active': dragId && canReorder }" @dragover.prevent="dragOverList" @drop.prevent.stop="dropOnList">
        <div v-if="!visibleSongs.length" class="muted small" style="padding:8px 12px;line-height:1.6">
          {{ playlist.playlists.length ? t('当前歌单为空') : t('暂无曲目') }}。<br>{{ t('点击上方「导入 MIDI」或「导入文件夹」。') }}
        </div>

        <div class="song-item" role="listitem"
             v-for="(s, i) in visibleSongs"
             :key="s.id"
             :class="{ active: s.id === state.currentId, dragging: dragId === s.id, dragTarget: dragOverId === s.id }"
             :draggable="canReorder"
             @dragstart="dragStart(s, $event)"
             @dragover.prevent="dragOverRow($event, s)"
             @dragleave="dragLeaveRow($event)"
             @drop.stop.prevent="dropOn($event, s)"
             @dragend="resetDrag()"
             @click="selectSongOrBatch(s)">
          <input v-if="batchOn" type="checkbox" class="song-check" :checked="isSel(s.id)" @click.stop="toggleSel(s.id)" />
          <span v-if="!batchOn && canReorder" class="si-drag" :title="t('拖动排序')" aria-label="t('拖动排序')"><Icon name="drag" :size="13" /></span>
          <span class="si-num" v-if="!batchOn && (!state.playing || s.id !== state.currentId)">{{ i + 1 }}</span>
          <span class="si-num playing-ic" v-else-if="!batchOn">▶</span>
          <div class="si-name">
            <b>{{ s.name }}</b>
            <small>{{ s.song ? s.song.tracks.length : (s.meta.tracks || '—') }} {{ t(' 轨 · ') }} {{ (s.meta.size / 1024).toFixed(0) }} KB</small>
          </div>
          <div class="si-tools">
            <button class="icon-btn si-fav" :class="{ on: favs.has(s.id) }" style="width:26px;height:26px;font-size:13px" :title="t('收藏')" aria-label="t('收藏')" @click.stop="toggleFav(s.id)">★</button>
            <button class="icon-btn" style="width:26px;height:26px;font-size:13px" :title="t('从当前歌单移除')" aria-label="t('从当前歌单移除')" @click.stop="playlist.removeSongs([s.id])">
              <Icon name="trash" :size="14" />
            </button>
          </div>
        </div>
      </div>

    </div>

    <Teleport to="body">
      <div v-if="playlistNameOpen" class="side-modal-mask" @click.self="playlistNameOpen = false">
        <div class="side-modal">
          <b>{{ t('新建歌单') }}</b>
          <input v-model="playlistName" class="text-input" :placeholder="t('歌单名称')" @keydown.enter="confirmNewPlaylist" autofocus />
          <div class="row" style="gap:8px;justify-content:flex-end">
            <button class="btn sm ghost" @click="playlistNameOpen = false">{{ t('取消') }}</button>
            <button class="btn sm primary" @click="confirmNewPlaylist">{{ t('确定') }}</button>
          </div>
        </div>
      </div>
    </Teleport>
    <div style="padding:10px 14px;border-top:1px solid var(--border)" class="small muted row">
      <span class="tag">v3.0.0</span>
      <span style="margin-left:auto">{{ t('离线 · Vue 3') }}</span>
    </div>
  </aside>
</template>

<style scoped>
.btn.sidebar-primary {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #fff;
  font-weight: 600;
}
.btn.sidebar-primary:hover {
  background: color-mix(in srgb, var(--accent) 86%, #000);
  border-color: var(--accent);
}
.si-fav { color: var(--stone); font-size: 13px; }
.si-fav.on { color: var(--amber); }
.song-list { min-height: 18px; border-radius: 10px; transition: box-shadow .12s, background .12s; }
.song-list.drag-active { box-shadow: inset 0 0 0 1px var(--accent); background: color-mix(in srgb, var(--accent) 6%, transparent); }
.si-drag { display: inline-flex; align-items: center; color: var(--stone); cursor: grab; opacity: .35; margin-right: 2px; transition: opacity .12s; user-select: none; }
.song-item:hover .si-drag, .song-item.dragging .si-drag { opacity: 1; }
.song-item.dragging { opacity: .45; }
.song-item.dragTarget { background: var(--surface-soft); box-shadow: inset 0 0 0 1px var(--accent); }
.pl-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.pl-head-title { font-size: 11px; font-weight: 700; color: var(--stone); letter-spacing: .4px; text-transform: uppercase; }
.pl-collapse { background: transparent; border:none; cursor:pointer; color: var(--slate); font-size:11px; padding:2px 4px; border-radius:4px; }
.pl-collapse:hover { background: var(--surface-soft); color: var(--ink); }
.pl-list { display: flex; flex-direction: column; gap: 3px; padding: 2px; margin-bottom: 6px; border: 1px solid transparent; border-radius: 10px; transition: box-shadow .12s, background .12s; }
.pl-list:has(.pl-item.dragging) { box-shadow: inset 0 0 0 1px var(--accent); background: color-mix(in srgb, var(--accent) 5%, transparent); }
.pl-item { display: flex; align-items: center; gap: 6px; padding: 7px 8px; border-radius: 9px; border: 1px solid transparent; cursor: pointer; color: var(--ink); font-size: 12.5px; transition: background .12s, border-color .12s, box-shadow .12s; }
.pl-item:hover { background: var(--surface-soft); }
.pl-item.active { background: var(--surface); border-color: var(--hairline); }
.pl-item.dragging { opacity: .45; }
.pl-item.dragTarget { background: var(--surface-soft); }
.pl-item.drag-before { box-shadow: 0 -2px 0 0 var(--accent) !important; }
.pl-item.drag-after { box-shadow: 0 2px 0 0 var(--accent) !important; }
.pl-item.pl-dragable { cursor: grab; }
.pl-drag { display: inline-flex; align-items: center; color: var(--stone); opacity: .35; transition: opacity .12s; user-select: none; }
.pl-item:hover .pl-drag, .pl-item.dragging .pl-drag { opacity: 1; }
.pl-star { color: var(--amber); }
.pl-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-count { color: var(--stone); font-size: 11px; font-variant-numeric: tabular-nums; }
.pl-toolbar { display: flex; align-items: center; gap: 5px; margin-bottom: 5px; }
.pl-batch { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; padding: 5px 8px; margin-bottom: 5px; border: 1px dashed var(--hairline); border-radius: 10px; background: var(--surface-soft); }
.song-check { width: 14px; height: 14px; accent-color: var(--ink); }
.side-modal-mask { position: fixed; inset:0; background: rgba(0,0,0,.35); display:grid; place-items:center; z-index: 500; }
.side-modal { background: var(--canvas); border:1px solid var(--hairline); border-radius:12px; padding:14px; width:280px; display:flex; flex-direction:column; gap:10px; box-shadow: var(--shadow-lg); }
.side-modal input { width:100%; }

</style>