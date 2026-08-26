<script setup>
import { computed } from 'vue';
import Icon from '../components/Icon.vue';
import { useAppStore } from '../stores/app';
import { ensureAudio } from '../audio.js';
import { encodeMidi } from '../core/midi.js';

const app = useAppStore();
const state = app;
const setView = (v) => app.setView(v);
const selectSong = (id) => app.selectSong(id);
const currentSong = computed(() => app.currentSong);
const importFiles = (items) => app.importFiles(items);
const setTempo = (v) => app.setTempo(v);
const setTrackVol = (i, v) => app.setTrackVol(i, v);
const setTrackPan = (i, v) => app.setTrackPan(i, v);
const toggleTrackMute = (i) => app.toggleTrackMute(i);
const toggleTrackSolo = (i) => app.toggleTrackSolo(i);

const QUICK = [
  { ic: 'transcribe', title: '开始转录', sub: '音频转 MIDI · 本地引擎', view: 'transcribe', soon: false },
  { ic: 'edit', title: '打开编辑器', sub: '逐音符精修 MIDI', view: 'edit', soon: false },
  { ic: 'viz', title: '可视化分析', sub: '频谱 · 波形 · 声部', view: 'viz', soon: true },
  { ic: 'chart', title: 'MIDI 分析器', sub: '音符密度 · 音域 · 调性', view: 'analyze', soon: true },
  { ic: 'score', title: '乐谱视图', sub: '五线谱 · 简谱 · TAB', view: 'score', soon: true },
  { ic: 'convert', title: '格式转换', sub: 'MIDI → WAV / MP4', view: 'convert', soon: true },
];

function go(v) { setView(v); }
function openUpdate() {
  state.ui.settingsTab = 'update';
  state.ui.settingsOpen = true;
}

const bridge = window.fuBridge;
function bufToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64ToBuf(b64) {
  const s = atob(b64);
  const arr = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
  return arr;
}
async function saveProject() {
  const song = currentSong.value && currentSong.value.song;
  if (!song) { window.alert('请先载入 MIDI 文件'); return; }
  const midiBytes = encodeMidi(song.tracks.map(t => ({ name: t.name, program: t.program, ch: t.ch, notes: t.notes, ccs: t.ccs || [] })),
    { division: song.tpb, tempoMap: song.tempoMap, sigMap: song.sigMap });
  const { player } = ensureAudio();
  const proj = {
    app: 'FuFumidi', version: '2.2.0',
    fileName: song.name || 'project',
    midi: bufToB64(midiBytes),
    speed: state.tempo || 1,
    loop: { on: state.loop, start: player ? player.loopStart : 0, end: player ? player.loopEnd : 0 },
    mixer: state.tracks.map((t, i) => ({ vol: t.vol, pan: t.pan, mute: !!t.mute, solo: !!t.solo })),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(proj));
  const name = (song.name || 'project').replace(/\.midi?$/i, '') + '.fufu';
  try {
    if (bridge && bridge.saveBinary) {
      const r = await bridge.saveBinary({ name, data: Array.from(bytes) });
      if (r && r.ok) window.alert('已保存工程：' + r.path);
      else if (r && !r.canceled) window.alert('保存工程失败');
    } else {
      const blob = new Blob([bytes], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      window.alert('已保存工程');
    }
  } catch (e) { window.alert('保存工程失败：' + (e.message || e)); }
}
async function openProject() {
  if (!bridge || !bridge.pickFile || !bridge.readBinary) { window.alert('请使用桌面版打开工程'); return; }
  try {
    const p = await bridge.pickFile({ filters: [{ name: 'FuFumidi 工程', extensions: ['fufu'] }] });
    if (!p) return;
    const bytes = await bridge.readBinary(p);
    const proj = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(bytes)));
    if (!proj || !proj.midi) { window.alert('不是有效的工程文件'); return; }
    await importFiles([{ name: proj.fileName || 'project.mid', bytes: b64ToBuf(proj.midi) }]);
    if (proj.speed) setTempo(proj.speed);
    if (Array.isArray(proj.mixer)) {
      proj.mixer.forEach((m, i) => {
        if (!state.tracks[i]) return;
        if (m.vol != null) setTrackVol(i, m.vol);
        if (m.pan != null) setTrackPan(i, m.pan);
        if (m.mute && !state.tracks[i].mute) toggleTrackMute(i);
        if (m.solo && !state.tracks[i].solo) toggleTrackSolo(i);
      });
    }
    if (proj.loop && proj.loop.on) {
      state.loop = true;
      const { player } = ensureAudio();
      player.setLoop(true, proj.loop.start || 0, proj.loop.end || (currentSong.value && currentSong.value.song.totalTicks) || 0);
    }
    window.alert('已打开工程');
  } catch (e) { window.alert('解析工程失败：' + (e.message || e)); }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-ic"><Icon name="home" :size="20" /></div>
      <div>
        <div class="page-title">首页工作区</div>
        <div class="page-sub">快速开始 · 最近曲目 · 播放状态</div>
      </div>
    </div>

    <div class="grid grid-3">
      <button class="home-card" v-for="q in QUICK" :key="q.title" @click="go(q.view)">
        <span class="hc-ic"><Icon :name="q.ic" :size="18" /></span>
        <div><b>{{ q.title }}</b><small>{{ q.sub }}{{ q.soon ? ' · 即将上线' : '' }}</small></div>
      </button>
      <button class="home-card" @click="openUpdate">
        <span class="hc-ic"><Icon name="import" :size="18" /></span>
        <div><b>检查更新</b><small>GitHub 新版本 · 国内镜像</small></div>
      </button>
      <button class="home-card" @click="openProject">
        <span class="hc-ic"><Icon name="folder" :size="18" /></span>
        <div><b>打开工程</b><small>载入 .fufu</small></div>
      </button>
      <button class="home-card" @click="saveProject" :disabled="!currentSong">
        <span class="hc-ic"><Icon name="save" :size="18" /></span>
        <div><b>保存工程</b><small>.fufu</small></div>
      </button>
    </div>

    <div class="home-section">
      <div class="home-sec-head"><Icon name="clock" :size="14" />最近曲目</div>
      <div v-if="!state.songs.length" class="card muted small" style="text-align:center;padding:26px">
        还没有导入曲目 —— 点击左侧「导入 MIDI」开始。
      </div>
      <div class="card" style="padding:6px" v-else>
        <div class="song-item" v-for="(s, i) in [...state.songs].reverse().slice(0, 8)" :key="s.id"
             :class="{ active: s.id === state.currentId }" @click="selectSong(s.id)">
          <span class="si-num">{{ i + 1 }}</span>
          <div class="si-name"><b>{{ s.name }}</b><small>{{ s.song ? s.song.tracks.length : (s.meta.tracks || 0) }} 轨</small></div>
          <span class="tag" v-if="s.id === state.currentId && state.playing">播放中</span>
        </div>
      </div>
    </div>
  </div>
</template>
