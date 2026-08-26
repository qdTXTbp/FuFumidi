<script setup>
import { ref } from 'vue';
import Icon from './Icon.vue';
import { state, importFiles, selectSong, removeSong, toast, setView } from '../store.js';
import logoUrl from '../assets/logo.png';

const fileInput = ref(null);
const dragOver = ref(false);

const bridge = window.fuBridge;

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
      <input ref="fileInput" id="midi-file-input" name="midi-file" type="file" accept=".mid,.midi,.kar,.rmi" hidden multiple @change="onFileChange">

      <div class="nav-sep"></div>
      <div class="nav-group-title">MIDI 歌单 <span class="muted" style="float:right;text-transform:none;letter-spacing:0">{{ state.songs.length }}</span></div>

      <div v-if="!state.songs.length" class="muted small" style="padding:8px 12px;line-height:1.6">
        暂无曲目。<br>点击上方「导入 MIDI」或直接拖入文件。
      </div>

      <div class="song-item"
           v-for="(s, i) in state.songs"
           :key="s.id"
           :class="{ active: s.id === state.currentId }"
           @click="selectSong(s.id)">
        <span class="si-num" v-if="!state.playing || s.id !== state.currentId">{{ i + 1 }}</span>
        <span class="si-num playing-ic" v-else>▶</span>
        <div class="si-name">
          <b>{{ s.name }}</b>
          <small>{{ s.song ? s.song.tracks.length : (s.meta.tracks || '—') }} 轨 · {{ (s.meta.size / 1024).toFixed(0) }} KB</small>
        </div>
        <div class="si-tools">
          <button class="icon-btn" style="width:26px;height:26px;font-size:13px" title="移除" @click.stop="removeSong(s.id)">
            <Icon name="trash" :size="14" />
          </button>
        </div>
      </div>

      <div class="nav-sep" v-if="state.songs.length"></div>
      <div class="nav-group-title">导航</div>
      <button class="nav-item" v-for="v in ['home', 'play', 'lyrics', 'edit', 'viz', 'analyze', 'score', 'convert']" :key="v"
              :class="{ active: state.view === v }" @click="setView(v)">
        <span class="nav-ic"><Icon :name="v === 'home' ? 'home' : v === 'play' ? 'play2' : v === 'lyrics' ? 'music' : v === 'edit' ? 'edit' : v === 'viz' ? 'viz' : v === 'analyze' ? 'chart' : v === 'score' ? 'score' : 'convert'" :size="15" /></span>
        {{ { home: '首页', play: '演奏', lyrics: '歌词', edit: '编辑', viz: '可视化', analyze: '分析', score: '乐谱', convert: '转换' }[v] }}
      </button>
    </div>

    <div style="padding:10px 14px;border-top:1px solid var(--border)" class="small muted row">
      <span class="tag">v2.0.1</span>
      <span style="margin-left:auto">离线 · 单文件</span>
    </div>
  </aside>
</template>
