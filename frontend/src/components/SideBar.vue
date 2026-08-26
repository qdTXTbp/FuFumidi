<script setup>
import { ref, computed } from 'vue';
import Icon from './Icon.vue';
import {
  state, importFiles, selectSong, removeSong, toast, setView,
  plSongs, createPlaylist, renamePlaylist, deletePlaylist, addSongToPl, removeSongFromPl,
  isFav, toggleFav, setBatchMode, toggleBatchSel, batchRemoveSongs, batchMoveToPl,
} from '../store.js';
import { t } from '../core/i18n.js';
import logoUrl from '../assets/logo.png';

const fileInput = ref(null);
const dragOver = ref(false);
const plCreating = ref(false);
const newPlName = ref('');

const bridge = window.fuBridge;
const NAV = [
  { v: 'home', ic: 'home', cn: '首页' },
  { v: 'play', ic: 'play2', cn: '演奏' },
  { v: 'lyrics', ic: 'music', cn: '歌词' },
  { v: 'edit', ic: 'edit', cn: '编辑' },
  { v: 'viz', ic: 'viz', cn: '可视化' },
  { v: 'analyze', ic: 'chart', cn: '分析' },
  { v: 'score', ic: 'score', cn: '乐谱' },
  { v: 'convert', ic: 'convert', cn: '转换' },
];

const plCount = (pl) => {
  if (pl === 'all') return state.songs.length;
  if (pl === 'fav') return state.favs.length;
  const p = state.playlists.find(x => x.id === pl);
  return p ? p.items.length : 0;
};

// 当前歌单的歌曲列表
const shown = computed(() => plSongs.value);

function baseName(p) { return String(p).split(/[\\/]/).pop() || '未命名.mid'; }

async function onPick() {
  if (bridge && bridge.pickFile) {
    try {
      const p = await bridge.pickFile({ filters: [{ name: 'MIDI', extensions: ['mid', 'midi', 'kar', 'rmi'] }] });
      if (!p) return;
      const ab = await bridge.readBinary(p);
      if (!ab) { toast('读取文件失败', 'error'); return; }
      importFiles([{ name: baseName(p), bytes: new Uint8Array(ab) }]);
    } catch (e) { /* ignore */ }
    return;
  }
  fileInput.value && fileInput.value.click();
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

function addToPlPrompt(songId) {
  const name = window.prompt('添加到歌单（输入歌单名，不存在则自动创建）', '');
  if (!name || !name.trim()) return;
  let pl = state.playlists.find(p => p.name === name.trim());
  if (!pl) pl = createPlaylist(name.trim());
  if (pl) { addSongToPl(pl.id, songId); toast('已添加到「' + pl.name + '」', 'ok'); }
}
function removeFromCurrentPl(songId) {
  if (state.activePl === 'fav') {
    const i = state.favs.indexOf(songId);
    if (i >= 0) { state.favs.splice(i, 1); saveFavsOnly(); toast('已移出收藏', 'ok'); }
    return;
  }
  if (state.activePl !== 'all') removeSongFromPl(state.activePl, songId);
  else removeSong(songId);
}
function saveFavsOnly() { try { localStorage.setItem('fufumidi_favs', JSON.stringify(state.favs)); } catch (e) {} }
function renamePlPrompt(pl) {
  const name = window.prompt('重命名歌单', pl.name);
  if (name && name.trim()) renamePlaylist(pl.id, name.trim());
}
function createPl() {
  if (newPlName.value.trim() && createPlaylist(newPlName.value)) newPlName.value = '';
  plCreating.value = false;
}
function onNewPlKey(e) {
  if (e.key === 'Enter') createPl();
  if (e.key === 'Escape') { plCreating.value = false; newPlName.value = ''; }
}
</script>

<template>
  <aside class="sidebar" @dragover.prevent="dragOver = true" @dragleave="dragOver = false" @drop.prevent="onDrop">
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
      <input ref="fileInput" id="midi-file-input" name="midi-file" type="file" accept=".mid,.midi,.kar,.rmi" hidden multiple @change="onFileChange">

      <div class="nav-sep"></div>

      <!-- 歌单列表 -->
      <div class="pl-head">
        <span class="nav-group-title" style="padding:6px 12px 4px">{{ t('MIDI 歌单') }}</span>
        <button class="icon-btn" style="width:24px;height:24px" :title="t('新建歌单')" @click="plCreating = !plCreating">
          <Icon name="plus" :size="14" />
        </button>
      </div>
      <div v-if="plCreating" class="pl-new">
        <input v-model="newPlName" class="text-input" style="flex:1;padding:4px 8px;font-size:12px" placeholder="歌单名" @keydown.enter="onNewPlKey" @keydown.esc="onNewPlKey" autofocus />
        <button class="btn sm" style="padding:3px 10px" @click="createPl">确定</button>
      </div>

      <div class="pl-item" :class="{ on: state.activePl === 'all' }" @click="state.activePl = 'all'">
        <Icon name="music" :size="13" /><span>{{ t('全部曲目') }}</span><em>{{ plCount('all') }}</em>
      </div>
      <div class="pl-item" :class="{ on: state.activePl === 'fav' }" @click="state.activePl = 'fav'">
        <Icon name="heart" :size="13" /><span>{{ t('收藏') }}</span><em>{{ plCount('fav') }}</em>
      </div>
      <div class="pl-item" v-for="pl in state.playlists" :key="pl.id" :class="{ on: state.activePl === pl.id }" @click="state.activePl = pl.id">
        <Icon name="folder" :size="13" /><span class="pl-name" :title="pl.name">{{ pl.name }}</span><em>{{ pl.items.length }}</em>
        <span class="pl-tools">
          <button class="icon-btn" style="width:20px;height:20px;font-size:11px" :title="t('重命名')" @click.stop="renamePlPrompt(pl)">✎</button>
          <button class="icon-btn" style="width:20px;height:20px;font-size:11px" :title="t('删除歌单')" @click.stop="deletePlaylist(pl.id)">✕</button>
        </span>
      </div>

      <div class="nav-sep"></div>

      <!-- 歌曲列表（按当前歌单过滤） -->
      <div v-if="!shown.length" class="muted small" style="padding:8px 12px;line-height:1.6">
        {{ state.activePl === 'fav' ? t('收藏为空，点击歌曲右侧 ♥ 收藏。') : state.activePl === 'all' ? (t('暂无曲目。') + '<br>' + t('点击上方「导入 MIDI」或直接拖入文件。')) : t('歌单为空，点击歌曲右侧「＋」加入。') }}
      </div>

      <div class="song-item"
           v-for="(s, i) in shown"
           :key="s.id"
           :class="{ active: s.id === state.currentId, batching: state.batchMode }"
           @click="state.batchMode ? toggleBatchSel(s.id) : selectSong(s.id)">
        <input v-if="state.batchMode" type="checkbox" class="batch-check" :checked="state.batchSel.includes(s.id)" @click.stop="toggleBatchSel(s.id)" />
        <span class="si-num" v-if="!state.batchMode && (!state.playing || s.id !== state.currentId)">{{ i + 1 }}</span>
        <span class="si-num playing-ic" v-else-if="!state.batchMode">▶</span>
        <div class="si-name">
          <b>{{ s.name }}</b>
          <small>{{ s.song ? s.song.tracks.length : (s.meta.tracks || '—') }} {{ t('轨') }} · {{ (s.meta.size / 1024).toFixed(0) }} KB</small>
        </div>
        <div class="si-tools">
          <button class="icon-btn heart" :class="{ on: isFav(s.id) }" style="width:26px;height:26px;font-size:13px" :title="t('收藏')" @click.stop="toggleFav(s.id)">
            <Icon :name="isFav(s.id) ? 'heart' : 'heart-o'" :size="14" />
          </button>
          <button class="icon-btn" style="width:26px;height:26px;font-size:13px" :title="t('添加到歌单')" @click.stop="addToPlPrompt(s.id)">
            <Icon name="plus" :size="14" />
          </button>
          <button class="icon-btn" style="width:26px;height:26px;font-size:13px" :title="t('移除')" @click.stop="removeFromCurrentPl(s.id)">
            <Icon name="trash" :size="14" />
          </button>
        </div>
      </div>

      <!-- 批量管理工具栏 -->
      <div v-if="state.batchMode" class="batch-bar">
        <button class="btn sm" @click="state.batchSel = shown.map(s => s.id)">{{ t('全选') }}</button>
        <button class="btn sm ghost danger" @click="batchRemoveSongs" :disabled="!state.batchSel.length">
          <Icon name="trash" :size="13" /> {{ t('删除') }}({{ state.batchSel.length }})
        </button>
        <select class="select-input" style="flex:1;min-width:0" :value="''" @change="e => e.target.value && (batchMoveToPl(e.target.value), e.target.value = '')">
          <option value="" disabled>{{ t('移到歌单…') }}</option>
          <option v-for="pl in state.playlists" :key="pl.id" :value="pl.id">{{ pl.name }}</option>
        </select>
        <button class="btn sm ghost" @click="setBatchMode(false)">{{ t('完成') }}</button>
      </div>
      <button v-else-if="shown.length" class="btn sm ghost" style="width:100%;margin-top:2px" @click="setBatchMode(true)">
        <Icon name="check" :size="13" /> {{ t('批量管理') }}
      </button>

      <div class="nav-sep" v-if="shown.length || state.songs.length"></div>
      <div class="nav-group-title">{{ t('导航') }}</div>
      <button class="nav-item" v-for="n in NAV" :key="n.v"
              :class="{ active: state.view === n.v }" @click="setView(n.v)">
        <span class="nav-ic"><Icon :name="n.ic" :size="15" /></span>
        {{ t(n.cn) }}
      </button>
    </div>

    <div style="padding:10px 14px;border-top:1px solid var(--border)" class="small muted row">
      <span class="tag">v2.0.1</span>
      <span style="margin-left:auto">{{ t('离线 · 单文件') }}</span>
    </div>
  </aside>
</template>
