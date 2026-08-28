<script setup>
import { ref, computed, onMounted } from 'vue';
import Icon from './Icon.vue';
import { useAppStore } from '../stores/app';
import { usePlaylistStore } from '../stores/playlist';
import logoUrl from '../assets/logo.png';
import { t } from '../core/i18n.js';
import { getAppVersion } from '../core/version.js';
import { fmtTime } from '../core/util.js';

const app = useAppStore();
const state = app;
const appVersion = ref('v3.1.5');
getAppVersion().then(v => { appVersion.value = v; });
const importFiles = (items) => app.importFiles(items);
const selectSong = (id) => app.selectSong(id);
const removeSong = (id) => app.removeSong(id);
const toast = (m, t) => app.toast(m, t);

const fileInput = ref(null);
const dragOver = ref(false);

const bridge = window.fuBridge;
const playlist = usePlaylistStore();

function isFav(id) { return playlist.isFavorite(id); }
function toggleFav(id) { playlist.toggleFavorite(id); }

/* ---------------- 歌单数据 ---------------- */
const batchOn = ref(false);
const batchSel = ref(new Set());

const isAllView = computed(() => playlist.activePlaylistId === 'all');
const isFavView = computed(() => playlist.activePlaylistId === 'favorites');
const activePlaylist = computed(() => playlist.activePlaylist);

const visibleSongs = computed(() => app.queueSongs);

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
function batchDeleteLibrary() {
  if (!batchSel.value.size) { toast('请先勾选曲目', 'warn'); return; }
  openConfirm(t('删除曲目'), t('确定从资料库删除 ') + batchSel.value.size + t(' 首曲目？') + t(' 将从所有歌单移除。'), async () => {
    const ids = [...batchSel.value];
    for (const id of ids) await removeSong(id);
    playlist.removeFromAllPlaylists(ids);
    batchSel.value = new Set();
    toast(t('已删除 ') + ids.length + t(' 首'), 'ok');
  });
}
function batchMoveToPl(plId) {
  const ids = [...batchSel.value];
  if (!ids.length || !plId) return;
  playlist.addToPlaylist(plId, ids);
  if (!isAllView.value && !isFavView.value) playlist.removeSongs(ids);
  batchSel.value = new Set();
  const pl = playlist.playlists.find(p => p.id === plId);
  toast(t('已移动 ') + ids.length + t(' 首到「') + (pl ? pl.name : '') + '」', 'ok');
}

/* ---------------- 歌曲拖动排序 ---------------- */
const dragId = ref(null);
const dragOverId = ref(null);
const canReorder = computed(() => !batchOn.value && !isFavView.value && playlist.songIds.length > 0);
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
function selectSongOrBatch(s) {
  if (batchOn.value) toggleSel(s.id);
  else selectSong(s.id);
}

/* ---------------- 歌单操作（master 交互） ---------------- */
const plCreating = ref(false);
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
    last ? t('确定清空当前默认歌单？') : t('删除歌单「') + pl.name + '」？' + t(' 将从所有歌单移除。'),
    () => { playlist.remove(pl.id); toast(t('歌单已处理'), 'ok'); },
    last ? t('清空') : undefined);
}
function removeFromCurrentPl(s) {
  if (isFavView.value) { toggleFav(s.id); return; }
  if (isAllView.value) {
    openConfirm(t('删除曲目'), t('确定从资料库删除「') + s.name + '」？' + t(' 将从所有歌单移除。'), () => {
      removeSong(s.id);
      playlist.removeFromAllPlaylists([s.id]);
    });
  } else {
    playlist.removeSongs([s.id]);
  }
}
const emptyHint = computed(() => {
  if (playlist.search && !visibleSongs.value.length) return t('未找到匹配的曲目');
  if (isFavView.value) return t('收藏为空，点击歌曲右侧 ♥ 收藏。');
  if (isAllView.value) return t('暂无曲目。') + t('点击上方「导入 MIDI」或直接拖入文件。');
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

onMounted(() => { playlist.hydrateFavorites(); });
</script>

<template>
  <aside class="sidebar" role="navigation" aria-label="t('侧边导航')" @dragover.prevent="dragOver = true" @dragleave="dragOver = false" @drop.prevent="onDrop">
    <div class="sidebar-brand">
      <div class="brand-logo"><img :src="logoUrl" alt="FuFumidi" /></div>
      <div>
        <div class="brand-name">FuFumidi</div>
        <div class="brand-sub">{{ t('播放 · 编辑 · 转录 · 乐谱') }}</div>
      </div>
    </div>

    <div class="sidebar-body">
      <button class="btn primary" style="width:100%;justify-content:center" @click="onPick">
        <Icon name="import" :size="15" /> {{ t('导入 MIDI') }}
      </button>
      <button class="btn sm" style="width:100%;justify-content:center;margin-top:6px" @click="onPickFolder">
        <Icon name="folder" :size="14" /> {{ t('导入文件夹') }}
      </button>
      <input ref="fileInput" id="midi-file-input" name="midi-file" type="file" accept=".mid,.midi,.kar,.rmi" hidden multiple @change="onFileChange">

      <div class="nav-sep"></div>

      <!-- 歌单列表 -->
      <div class="pl-head">
        <span class="nav-group-title" style="padding:6px 12px 4px">{{ t('MIDI 歌单') }}</span>
        <button class="icon-btn" style="width:24px;height:24px" :title="t('新建歌单')" aria-label="t('新建歌单')" @click="plCreating = !plCreating">
          <Icon name="plus" :size="14" />
        </button>
      </div>
      <div v-if="plCreating" class="pl-new">
        <input v-model="newPlName" class="text-input" style="flex:1;padding:4px 8px;font-size:12px" :placeholder="t('歌单名')" @keydown.enter="onNewPlKey" @keydown.esc="onNewPlKey" autofocus />
        <button class="btn sm" style="padding:3px 10px" @click="createPl">{{ t('确定') }}</button>
      </div>

      <div class="pl-item" :class="{ on: isAllView }" @click="playlist.select('all')">
        <Icon name="music" :size="13" /><span>{{ t('全部曲目') }}</span><em>{{ state.songs.length }}</em>
      </div>
      <div class="pl-item" :class="{ on: isFavView }" @click="playlist.select('favorites')">
        <Icon name="heart" :size="13" /><span>{{ t('收藏') }}</span><em>{{ playlist.favorites.length }}</em>
      </div>
      <div class="pl-item" v-for="pl in playlist.playlists" :key="pl.id"
           :class="{ on: playlist.activePlaylistId === pl.id, dragging: plDragId === pl.id, dragTarget: plOverId === pl.id, dragable: canReorderPlaylists }"
           :draggable="canReorderPlaylists"
           @dragstart="plDragStart(pl)"
           @dragover.prevent="plDragOver($event, pl.id)"
           @dragleave="plDragLeave($event)"
           @drop.stop.prevent="plDrop($event, pl.id)"
           @dragend="resetPlDrag()"
           @click="playlist.select(pl.id)">
        <span v-if="canReorderPlaylists" class="pl-drag"><Icon name="drag" :size="12" /></span>
        <Icon name="folder" :size="13" /><span class="pl-name" :title="pl.name">{{ pl.name }}</span><em>{{ pl.songIds.length }}</em>
        <span class="pl-tools">
          <button class="icon-btn" style="width:20px;height:20px;font-size:11px" :title="t('重命名')" aria-label="t('重命名')" @click.stop="openRename(pl)">✎</button>
          <button class="icon-btn" style="width:20px;height:20px;font-size:11px" :title="t('删除歌单')" aria-label="t('删除歌单')" @click.stop="deletePl(pl)">✕</button>
        </span>
      </div>

      <div class="nav-sep"></div>

      <!-- 搜索 -->
      <div class="pl-search">
        <Icon name="search" :size="13" />
        <input id="sidebar-search" name="sidebar-search" v-model="playlist.search" class="text-input" :placeholder="t('搜索曲目')" aria-label="t('搜索曲目')" />
        <button v-if="playlist.search" class="icon-btn" style="width:18px;height:18px;flex:none" :title="t('清空')" aria-label="t('清空')" @click="playlist.search = ''"><Icon name="close" :size="11" /></button>
      </div>

      <!-- 歌曲列表（按当前歌单过滤） -->
      <div v-if="!visibleSongs.length" class="muted small" style="padding:8px 12px;line-height:1.6">
        {{ emptyHint }}
      </div>

      <div class="song-list" role="list" :class="{ 'drag-active': dragId && canReorder }" @dragover.prevent="dragOverList" @drop.prevent.stop="dropOnList">
        <div class="song-item" v-for="(s, i) in visibleSongs" :key="s.id"
           :class="{ active: s.id === state.currentId, batching: batchOn, dragging: dragId === s.id, dragTarget: dragOverId === s.id }"
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
          <small>{{ s.song ? s.song.tracks.length : (s.meta.tracks || '—') }} {{ t(' 轨 · ') }} {{ (s.meta.size / 1024).toFixed(0) }} KB<span v-if="fmtDur(s)"> · {{ fmtDur(s) }}</span></small>
        </div>
        <div class="si-tools">
          <button class="icon-btn heart" :class="{ on: isFav(s.id) }" style="width:26px;height:26px;font-size:13px" :title="t('收藏')" aria-label="t('收藏')" @click.stop="toggleFav(s.id)">
            <Icon :name="isFav(s.id) ? 'heart' : 'heart-o'" :size="14" />
          </button>
          <button class="icon-btn" style="width:26px;height:26px;font-size:13px" :title="t('添加到歌单')" aria-label="t('添加到歌单')" @click.stop="openAddToPl(s.id)">
            <Icon name="plus" :size="14" />
          </button>
          <button class="icon-btn" style="width:26px;height:26px;font-size:13px" :title="t('移除')" aria-label="t('移除')" @click.stop="removeFromCurrentPl(s)">
            <Icon name="trash" :size="14" />
          </button>
        </div>
        </div>
      </div>

      <!-- 批量管理工具栏 -->
      <div v-if="batchOn" class="batch-bar">
        <button class="btn sm" @click="batchAll">{{ t('全选') }}</button>
        <button class="btn sm ghost danger" @click="batchDeleteLibrary" :disabled="!batchSel.size">
          <Icon name="trash" :size="13" /> {{ t('删除') }}({{ batchSel.size }})
        </button>
        <select class="select-input" style="flex:1;min-width:0" :value="''" @change="e => e.target.value && (batchMoveToPl(e.target.value), e.target.value = '')">
          <option value="" disabled>{{ t('移到歌单…') }}</option>
          <option v-for="pl in playlist.playlists" :key="pl.id" :value="pl.id">{{ pl.name }}</option>
        </select>
        <button class="btn sm ghost" @click="toggleBatch">{{ t('完成') }}</button>
      </div>
      <button v-else-if="visibleSongs.length" class="btn sm ghost" style="width:100%;margin-top:2px" @click="toggleBatch">
        <Icon name="check" :size="13" /> {{ t('批量管理') }}
      </button>
    </div>

    <div style="padding:10px 14px;border-top:1px solid var(--border)" class="small muted row">
      <span class="tag">{{ appVersion }}</span>
      <span style="margin-left:auto">{{ t('离线 · Vue 3') }}</span>
    </div>
  </aside>

  <!-- 弹窗通过 Teleport 挂到 body：.sidebar 的 backdrop-filter 会为 fixed 后代创建包含块，
       导致 position:fixed 被限制在侧边栏内，Teleport 到 body 后弹窗才能全屏居中 -->
  <Teleport to="body">
    <!-- 添加到歌单 -->
    <Transition name="ov">
      <div v-if="addToPlFor" class="ed-modal-mask" role="dialog" aria-modal="true" :aria-label="t('添加到歌单')" @click.self="closeAddToPl" @keydown.esc="closeAddToPl">
        <div class="ed-modal" style="width:min(320px,92vw)">
          <div class="ed-modal-head">
            <b>{{ t('添加到歌单') }}</b>
            <button class="icon-btn" style="margin-left:auto" :title="t('关闭')" aria-label="t('关闭')" @click="closeAddToPl"><Icon name="close" :size="14" /></button>
          </div>
          <div class="pl-add-list">
            <button class="pl-add-item" v-for="pl in playlist.playlists" :key="pl.id" @click="addToPlChoose(pl.id)">
              <Icon name="folder" :size="13" /><span class="pl-name">{{ pl.name }}</span><em>{{ pl.songIds.length }}</em>
            </button>
            <div v-if="!playlist.playlists.length" class="muted small" style="padding:8px 2px">{{ t('暂无歌单，可在下方新建') }}</div>
          </div>
          <div class="pl-add-new">
            <input id="pl-add-new-name" name="pl-add-new-name" v-model="addToPlNew" class="text-input" style="flex:1;min-width:0" :placeholder="t('新建歌单名')" aria-label="t('新建歌单名')" @keydown.enter="addToPlCreate" @keydown.esc="closeAddToPl" />
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
      <div v-if="renameTarget" class="ed-modal-mask" role="dialog" aria-modal="true" :aria-label="t('重命名歌单')" @click.self="closeRename" @keydown.esc="closeRename">
        <div class="ed-modal" style="width:min(320px,92vw)">
          <div class="ed-modal-head"><b>{{ t('重命名歌单') }}</b><button class="icon-btn" style="margin-left:auto" :title="t('关闭')" aria-label="t('关闭')" @click="closeRename"><Icon name="close" :size="14" /></button></div>
          <div style="padding:14px 4px 4px">
            <input id="pl-rename-name" name="pl-rename-name" v-model="renameVal" class="text-input" style="width:100%" :aria-label="t('歌单名')" @keydown.enter="confirmRename" @keydown.esc="closeRename" />
          </div>
          <div class="ed-modal-foot">
            <button class="btn sm ghost" @click="closeRename">{{ t('取消') }}</button>
            <button class="btn sm primary" @click="confirmRename">{{ t('保存') }}</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 确认弹窗 -->
    <Transition name="ov">
      <div v-if="confirmDlg" class="ed-modal-mask" role="dialog" aria-modal="true" :aria-label="confirmDlg.title" @click.self="closeConfirm" @keydown.esc="closeConfirm">
        <div class="ed-modal" style="width:min(340px,92vw)">
          <div class="ed-modal-head"><b>{{ confirmDlg.title }}</b><button class="icon-btn" style="margin-left:auto" :title="t('关闭')" aria-label="t('关闭')" @click="closeConfirm"><Icon name="close" :size="14" /></button></div>
          <div style="padding:14px 4px 4px;line-height:1.6;color:var(--ink)" class="small">{{ confirmDlg.msg }}</div>
          <div class="ed-modal-foot">
            <button class="btn sm ghost" @click="closeConfirm">{{ t('取消') }}</button>
            <button class="btn sm danger" @click="runConfirm">{{ confirmDlg.okText }}</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
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
/* 歌曲列表容器：拖拽高亮动画（上游 v3.0.0 恢复） */
.song-list { min-height: 18px; border-radius: 10px; transition: box-shadow .12s, background .12s; }
.song-list.drag-active { box-shadow: inset 0 0 0 1px var(--accent); background: color-mix(in srgb, var(--accent) 6%, transparent); }
.si-drag { display: inline-flex; align-items: center; color: var(--stone); cursor: grab; opacity: .35; margin-right: 2px; transition: opacity .12s; user-select: none; }
.song-item:hover .si-drag, .song-item.dragging .si-drag { opacity: 1; }
.song-item.dragging { opacity: .45; }
.song-item.dragTarget { background: var(--surface-soft); box-shadow: inset 0 0 0 1px var(--accent); }

/* master 版歌单项：图标 + 计数 + hover 工具按钮 */
.pl-head { display: flex; align-items: center; justify-content: space-between; padding-right: 6px; }
.pl-new { display: flex; align-items: center; gap: 6px; padding: 4px 12px; }
/* 歌单列表容器：拖拽高亮动画（上游 v3.0.0 恢复） */
.pl-list { display: flex; flex-direction: column; gap: 2px; padding: 2px; margin-bottom: 6px; border: 1px solid transparent; border-radius: 10px; transition: box-shadow .12s, background .12s; }
.pl-list:has(.pl-item.dragging) { box-shadow: inset 0 0 0 1px var(--accent); background: color-mix(in srgb, var(--accent) 5%, transparent); }
.pl-item { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-radius: var(--radius-sm); font-size: 13px; color: var(--charcoal); cursor: pointer; border: 1px solid transparent; transition: background 0.12s, color 0.12s, border-color 0.12s, box-shadow 0.12s; }
.pl-item:hover { background: var(--surface-soft); color: var(--ink); }
.pl-item.on { background: color-mix(in srgb, var(--brand-blue-200) 58%, transparent); color: var(--brand-blue-deep); font-weight: 600; }
.pl-item .pl-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-item em { font-style: normal; font-size: 11px; color: var(--stone); font-variant-numeric: tabular-nums; }
.pl-item.on em { color: var(--brand-blue-deep); }
.pl-item .pl-tools { display: flex; gap: 2px; opacity: 0; transition: opacity 0.14s; }
.pl-item:hover .pl-tools { opacity: 1; }
.pl-drag { display: inline-flex; align-items: center; color: var(--stone); opacity: .35; transition: opacity .12s; user-select: none; }
.pl-item:hover .pl-drag, .pl-item.dragging .pl-drag { opacity: 1; }
.pl-item.dragging { opacity: .45; }
.pl-item.dragTarget { background: var(--surface-soft); }
.pl-item.pl-drag-before { box-shadow: 0 -2px 0 0 var(--accent) !important; }
.pl-item.pl-drag-after { box-shadow: 0 2px 0 0 var(--accent) !important; }

/* master 版歌曲工具按钮：普通布局（非绝对定位） */
.song-item .si-tools { display: flex; gap: 2px; opacity: 0; transition: opacity 0.14s; flex: none; background: transparent; position: static; transform: none; padding: 0; }
.song-item:hover .si-tools { opacity: 1; }
.icon-btn.heart { color: var(--stone); }
.icon-btn.heart.on { color: var(--brand-coral); }

/* 批量管理 */
.song-check { width: 15px; height: 15px; accent-color: var(--brand-blue); flex: none; cursor: pointer; }
.batch-bar { display: flex; align-items: center; gap: 6px; padding: 6px 2px; flex-wrap: wrap; border-top: 1px dashed var(--hairline); margin-top: 4px; }
.batch-bar .select-input { padding: 4px 6px; font-size: 12px; }

/* 搜索框 */
.pl-search { display: flex; align-items: center; gap: 6px; padding: 2px 4px; color: var(--stone); }
.pl-search .text-input { flex: 1; min-width: 0; padding: 4px 8px; font-size: 12px; }
.pl-search input::placeholder { color: var(--stone); opacity: .8; }

/* 弹窗（与 ViewEdit 一致的应用内弹窗样式） */
.ed-modal-mask { position: fixed; inset: 0; background: rgba(10,10,10,0.35); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.ed-modal { width: min(560px, 92vw); background: var(--canvas); border-radius: 14px; box-shadow: 0 24px 64px rgba(16,24,40,0.2); padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.ed-modal-head { display: flex; align-items: center; gap: 10px; font-size: 14px; color: var(--ink); }
.ed-modal-head b { font-size: 15px; }
.ed-modal-foot { display: flex; justify-content: flex-end; gap: 8px; }
.ed-modal-foot .btn.danger { border-color: rgba(212, 86, 86, 0.4); color: var(--error); }

/* 添加到歌单弹窗列表 */
.pl-add-list { display: flex; flex-direction: column; gap: 2px; max-height: 34vh; overflow-y: auto; }
.pl-add-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border: none; background: transparent; border-radius: var(--radius-sm); font-size: 13px; color: var(--charcoal); cursor: pointer; text-align: left; transition: background 0.12s; }
.pl-add-item:hover { background: var(--surface-soft); color: var(--ink); }
.pl-add-item .pl-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-add-item em { font-style: normal; font-size: 11px; color: var(--stone); font-variant-numeric: tabular-nums; }
.pl-add-new { display: flex; align-items: center; gap: 6px; border-top: 1px dashed var(--hairline); padding-top: 10px; }
</style>
