<script setup>
import { ref, computed } from 'vue';
import Icon from './Icon.vue';
import { state, importFiles, selectSong, removeSong, toast, setView, VIEWS,
         createPlaylist, selectPlaylist, deletePlaylist, removeSongsFromActivePlaylist, removeSongsFromLibrary } from '../store.js';
import logoUrl from '../assets/logo.png';

const fileInput = ref(null);
const dragOver = ref(false);

const bridge = window.fuBridge;

function loadFavs() {
  try { return new Set(JSON.parse(localStorage.getItem('fufumidi_favs') || '[]')); } catch (e) { return new Set(); }
}
const favs = ref(loadFavs());
function toggleFav(id) {
  const s = new Set(favs.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  favs.value = s;
  try { localStorage.setItem('fufumidi_favs', JSON.stringify([...s])); } catch (e) {}
}

/* ---------------- 歌单数据 ---------------- */
const batchOn = ref(false);
const batchSel = ref(new Set());

const activePlaylist = computed(() => state.playlists.find(p => p.id === state.activePlaylistId) || null);
const isFavView = computed(() => state.activePlaylistId === 'favorites');

const visibleSongs = computed(() => {
  const q = (state.playlistSearch || '').trim().toLowerCase();
  let arr;
  if (isFavView.value) {
    arr = state.songs.filter(s => favs.value.has(s.id));
  } else {
    arr = state.songs.filter(s => activePlaylist.value?.songIds?.includes(s.id));
  }
  if (state.playlistFavOnly) arr = arr.filter(s => favs.value.has(s.id));
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
  try { localStorage.setItem('fufumidi_favs', JSON.stringify([...favs.value])); } catch (e) {}
  toast('已收藏 ' + batchSel.value.size + ' 首', 'ok');
}
function batchUnfav() {
  for (const id of batchSel.value) if (favs.value.has(id)) { const s = new Set(favs.value); s.delete(id); favs.value = s; }
  try { localStorage.setItem('fufumidi_favs', JSON.stringify([...favs.value])); } catch (e) {}
  toast('已取消收藏 ' + batchSel.value.size + ' 首', 'ok');
}
function batchRemove() {
  if (!batchSel.value.size) { toast('请先勾选曲目', 'warn'); return; }
  const n = batchSel.value.size;
  removeSongsFromActivePlaylist([...batchSel.value]);
  batchSel.value = new Set();
  toast('已从当前歌单移除 ' + n + ' 首', 'ok');
}
function batchDeleteLibrary() {
  if (!batchSel.value.size) { toast('请先勾选曲目', 'warn'); return; }
  if (!window.confirm('确定从资料库删除 ' + batchSel.value.size + ' 首曲目？')) return;
  const ids = [...batchSel.value];
  removeSongsFromLibrary(ids);
  batchSel.value = new Set();
  toast('已删除 ' + ids.length + ' 首', 'ok');
}

function baseName(p) { return String(p).split(/[\\/]/).pop() || '未命名.mid'; }

function newPlaylist() {
  const name = window.prompt('歌单名称', '');
  if (!name || !name.trim()) return;
  createPlaylist(name.trim());
  toast('已创建歌单「' + name.trim() + '」', 'ok');
}
function removeCurrentPlaylist() {
  const pid = state.activePlaylistId;
  if (pid === 'favorites') { toast('收藏视图不能删除', 'warn'); return; }
  const pl = activePlaylist.value;
  if (!pl) return;
  if (!window.confirm(state.playlists.length <= 1 ? '清空当前默认歌单？' : '删除歌单「' + pl.name + '」？')) return;
  const r = deletePlaylist(pid);
  if (r && r.ok) toast(r.cleared ? '歌单已清空' : '歌单已删除', 'ok');
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
    if (!files || !files.length) { toast('文件夹里没有 MIDI 文件', 'warn'); return; }
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
</script>

<template>
  <aside class="sidebar" @dragover.prevent="dragOver = true" @dragleave="dragOver = false" @drop.prevent="onDrop">
    <div class="sidebar-brand">
      <div class="brand-logo"><img :src="logoUrl" alt="FuFumidi" /></div>
      <div>
        <div class="brand-name">FuFumidi</div>
        <div class="brand-sub">播放 · 编辑 · 转录 · 乐谱</div>
      </div>
    </div>

    <div class="sidebar-body">
      <button class="btn primary" style="width:100%;justify-content:center" @click="onPick">
        <Icon name="import" :size="15" /> 导入 MIDI
      </button>
      <button class="btn sm" style="width:100%;justify-content:center;margin-top:6px" @click="onPickFolder">
        <Icon name="folder" :size="14" /> 导入文件夹
      </button>
      <input ref="fileInput" id="midi-file-input" name="midi-file" type="file" accept=".mid,.midi,.kar,.rmi" hidden multiple @change="onFileChange">

      <div class="nav-sep"></div>
      <div class="nav-group-title">MIDI 歌单 <span class="muted" style="float:right;text-transform:none;letter-spacing:0">{{ visibleSongs.length }}</span></div>

      <!-- 歌单选择 + 新建 -->
      <div class="pl-toolbar">
        <select class="select-input" :value="state.activePlaylistId" @change="selectPlaylist($event.target.value)" style="flex:1;min-width:0;padding:5px 8px;font-size:12px">
          <option value="favorites">★ 收藏（{{ favs.size }}）</option>
          <option v-for="p in state.playlists" :key="p.id" :value="p.id">{{ p.name }}（{{ p.songIds.length }}）</option>
        </select>
        <button class="icon-btn" title="新建歌单" @click="newPlaylist" style="width:28px;height:28px"><Icon name="plus" :size="14" /></button>
      </div>

      <!-- 搜索/收藏/批量 -->
      <div class="pl-toolbar">
        <input class="text-input" style="flex:1;min-width:0;padding:5px 8px;font-size:12px" placeholder="搜索曲目" v-model="state.playlistSearch" />
        <button class="chip-btn" :class="{ active: state.playlistFavOnly }" title="只显示收藏" @click="state.playlistFavOnly = !state.playlistFavOnly">★</button>
        <button class="chip-btn" :class="{ active: batchOn }" title="批量管理" @click="toggleBatch">批量</button>
        <button class="chip-btn" title="删除当前歌单" @click="removeCurrentPlaylist" :disabled="state.activePlaylistId === 'favorites'">删</button>
      </div>

      <!-- 批量操作条 -->
      <div v-if="batchOn" class="pl-batch">
        <button class="chip-btn" @click="batchAll">全选</button>
        <button class="chip-btn" @click="batchFav">收藏</button>
        <button class="chip-btn" @click="batchUnfav">取消收藏</button>
        <button class="chip-btn danger" @click="batchRemove">移除歌单</button>
        <button class="chip-btn danger" @click="batchDeleteLibrary">删除库</button>
        <button class="chip-btn" @click="toggleBatch">退出</button>
        <span class="muted small">已选 {{ batchSel.size }}</span>
      </div>

      <div v-if="!visibleSongs.length" class="muted small" style="padding:8px 12px;line-height:1.6">
        {{ state.playlists.length ? '当前歌单为空' : '暂无曲目' }}。<br>点击上方「导入 MIDI」或「导入文件夹」。
      </div>

      <div class="song-item"
           v-for="(s, i) in visibleSongs"
           :key="s.id"
           :class="{ active: s.id === state.currentId }"
           @click="selectSongOrBatch(s)">
        <input v-if="batchOn" type="checkbox" class="song-check" :checked="isSel(s.id)" @click.stop="toggleSel(s.id)" />
        <span class="si-num" v-if="!batchOn && (!state.playing || s.id !== state.currentId)">{{ i + 1 }}</span>
        <span class="si-num playing-ic" v-else-if="!batchOn">▶</span>
        <div class="si-name">
          <b>{{ s.name }}</b>
          <small>{{ s.song ? s.song.tracks.length : (s.meta.tracks || '—') }} 轨 · {{ (s.meta.size / 1024).toFixed(0) }} KB</small>
        </div>
        <div class="si-tools">
          <button class="icon-btn si-fav" :class="{ on: favs.has(s.id) }" style="width:26px;height:26px;font-size:13px" title="收藏" @click.stop="toggleFav(s.id)">★</button>
          <button class="icon-btn" style="width:26px;height:26px;font-size:13px" title="从当前歌单移除" @click.stop="removeSongsFromActivePlaylist([s.id])">
            <Icon name="trash" :size="14" />
          </button>
        </div>
      </div>

      <div class="nav-sep" v-if="state.songs.length"></div>
      <div class="nav-group-title">导航</div>
      <button class="nav-item" v-for="v in VIEWS" :key="v.id"
              :class="{ active: state.view === v.id }" @click="setView(v.id)">
        <span class="nav-ic"><Icon :name="v.ic" :size="15" /></span>
        {{ v.label }}
      </button>
    </div>

    <div style="padding:10px 14px;border-top:1px solid var(--border)" class="small muted row">
      <span class="tag">v2.2.0</span>
      <span style="margin-left:auto">离线 · Vue 3</span>
    </div>
  </aside>
</template>

<style scoped>
.si-fav { color: var(--stone); font-size: 13px; }
.si-fav.on { color: var(--amber); }
.pl-toolbar { display: flex; align-items: center; gap: 5px; margin-bottom: 5px; }
.pl-batch { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; padding: 5px 8px; margin-bottom: 5px; border: 1px dashed var(--hairline); border-radius: 10px; background: var(--surface-soft); }
.song-check { width: 14px; height: 14px; accent-color: var(--ink); }
</style>
