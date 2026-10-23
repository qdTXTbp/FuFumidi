<script setup>
import { computed, onMounted, ref } from 'vue';
import Icon from '../components/Icon.vue';
import { useAppStore } from '../stores/app';
import { ensureAudio } from '../audio.js';
import { encodeMidi } from '../core/midi.js';
import { t } from '../core/i18n.js';
import mascot from '../assets/mascot.png';
import { getAppVersion } from '../core/version.js';
import { fmtTime } from '../core/util.js';
// 立绘（全身，透明底）：用户要求「立绘放到工具里」—— 首页是工具内最大的静态位。
// 小尺寸位（侧栏 38px、文档 nav 36px）用的是头像特写 build 出来的 assets/logo.png，
// 立绘缩到那个尺寸只剩一条竖线，认不出人。
import mascotUrl from '../assets/mascot.png';

const app = useAppStore();
const state = app;
const setView = (v) => app.setView(v);
const selectSong = (id) => app.selectSong(id);
const currentSong = computed(() => app.currentSong);
const recentSongs = computed(() => (state.songs || []).slice(-6).reverse());
const appVersion = ref('');
const engineReady = computed(() => !!(bridge && bridge.convert));
const currentTracks = computed(() => (currentSong.value && currentSong.value.song ? currentSong.value.song.tracks.length : 0));
onMounted(async () => { try { appVersion.value = String(await getAppVersion() || '').replace(/^v/i, ''); } catch (e) {} });
const importFiles = (items) => app.importFiles(items);
const setTempo = (v) => app.setTempo(v);
const setTrackVol = (i, v) => app.setTrackVol(i, v);
const setTrackPan = (i, v) => app.setTrackPan(i, v);
const toggleTrackMute = (i) => app.toggleTrackMute(i);
const toggleTrackSolo = (i) => app.toggleTrackSolo(i);

const QUICK = [
  { ic: 'music', title: t('音乐'), sub: t('演奏 · 歌词 · 编辑'), view: 'music', soon: false },
  { ic: 'viz', title: t('视图'), sub: t('可视化 · 分析 · 乐谱'), view: 'views', soon: false },
  { ic: 'convert', title: t('转译'), sub: t('转录 · 转换'), view: 'transcode', soon: false },
  { ic: 'box', title: t('资源中心'), sub: t('模型 · 音色 · 资源'), view: 'resources', soon: false },
  // ★ 下载进行中的进度弹窗会压在顶部导航上，从首页直接进这一页，
  //   就不必"先关弹窗再切页"。
  // 「调教」= 编辑器（选歌手 / 画音符 / 渲染）+ 声库（UTAU / DiffSinger / 组件）同页两页签。
  { ic: 'utau', title: t('调教'), sub: t('歌声合成 · 声库 · 渲染'), view: 'singer', soon: false },
  // 插件中心入口（应用内打开，不跳浏览器）
  { ic: 'extension', title: t('插件中心'), sub: t('浏览 · 一键安装'), view: 'plugins', soon: false },
];

function go(v) { setView(v); }
function openGuide() { state.ui.guideOpen = true; }
/** 首页 → 调试工具 · 全局体检（settingsTab 用 'gpu'，体检区块就在那个标签页里） */
function openHealth() {
  // 用户反馈：点首页这张卡应当直接落到「反馈」页（体检 + 反馈 + 诊断包都在那一页）
  state.ui.settingsTab = 'feedback';
  state.ui.settingsOpen = true;
}
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
  if (!song) { app.alertDialog({ msg: t('请先载入 MIDI 文件') }); return; }
  const midiBytes = encodeMidi(song.tracks.map(t => ({ name: t.name, program: t.program, ch: t.ch, notes: t.notes, ccs: t.ccs || [] })),
    { division: song.tpb, tempoMap: song.tempoMap, sigMap: song.sigMap });
  const { player } = ensureAudio();
  const ver = (await getAppVersion()).replace(/^v/i, '');
  const proj = {
    app: 'FuFumidi', version: ver || '3.1.8',
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
      if (r && r.ok) app.alertDialog({ msg: t('已保存工程：') + r.path });
      else if (r && !r.canceled) app.alertDialog({ msg: t('保存工程失败') });
    } else {
      const blob = new Blob([bytes], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      app.alertDialog({ msg: t('已保存工程') });
    }
  } catch (e) { app.alertDialog({ msg: t('保存工程失败：') + (e.message || e) }); }
}
function continueWork() {
  if (currentSong.value) setView('edit');
  else setView('transcode');
}
async function pickMidi() {
  if (!bridge || !bridge.pickFile || !bridge.readBinary) { app.alertDialog({ msg: t('请使用桌面版导入 MIDI') }); return; }
  try {
    const p = await bridge.pickFile({ filters: [{ name: t('MIDI'), extensions: ['mid', 'midi'] }], multi: true });
    if (!p) return;
    const paths = Array.isArray(p) ? p : [p];
    const items = [];
    for (const fp of paths) {
      try {
        const bytes = await bridge.readBinary(fp);
        items.push({ name: String(fp).replace(/^.*[\\/]/, ''), bytes });
      } catch (e) {}
    }
    if (items.length) app.importWithPicker(items);
  } catch (e) { app.alertDialog({ msg: t('导入失败：') + (e.message || e) }); }
}
async function openProject() {
  if (!bridge || !bridge.pickFile || !bridge.readBinary) { app.alertDialog({ msg: t('请使用桌面版打开工程') }); return; }
  try {
    const p = await bridge.pickFile({ filters: [{ name: t('FuFumidi 工程'), extensions: ['fufu'] }] });
    if (!p) return;
    const bytes = await bridge.readBinary(p);
    const proj = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(bytes)));
    if (!proj || !proj.midi) { app.alertDialog({ msg: t('不是有效的工程文件') }); return; }
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
    app.alertDialog({ msg: t('已打开工程') });
  } catch (e) { app.alertDialog({ msg: t('解析工程失败：') + (e.message || e) }); }
}
</script>

<template>
  <div class="page home-view">
    <div class="home-head">
      <div>
        <div class="brand-eyebrow">{{ t('WORKSPACE') }}</div>
        <h1 class="home-title">{{ currentSong ? t('继续上次的工作') : t('开始你的下一首') }}</h1>
        <p class="home-sub">{{ currentSong ? t('继续编辑、转录或导出。') : t('导入 MIDI 或音频，本地完成其余工作。') }}</p>
      </div>
      <div class="home-head-actions">
        <button class="btn ghost" @click="openProject"><Icon name="folder" :size="14" />{{ t('打开工程') }}</button>
        <button class="btn primary" @click="pickMidi"><Icon name="import" :size="14" />{{ t('导入 MIDI') }}</button>
      </div>
    </div>

    <div class="home-top">
      <section class="card home-hero brand-frame">
        <img class="home-hero-mascot" :src="mascot" alt="" aria-hidden="true" />
        <template v-if="currentSong">
          <div class="home-hero-top">
            <div class="home-cover"><Icon name="music" :size="26" /></div>
            <div class="home-hero-copy">
              <h2 class="home-hero-title">{{ currentSong.song ? currentSong.song.name : currentSong.name }}</h2>
              <div class="home-meta">
                <span>{{ currentTracks }} {{ t('轨') }}</span>
                <span v-if="currentSong.song && currentSong.song.totalSec">{{ fmtTime(currentSong.song.totalSec) }}</span>
                <span>{{ t('本地工程') }}</span>
              </div>
            </div>
            <button class="btn ghost sm" @click="setView('music')">{{ t('在曲库中查看') }}</button>
          </div>
          <div class="home-wave" aria-hidden="true"><i v-for="n in 48" :key="n" :style="{ height: (10 + ((n * 37) % 30)) + 'px' }"></i></div>
          <div class="home-hero-actions">
            <button class="btn primary" @click="continueWork"><Icon name="edit" :size="14" />{{ t('继续编辑') }}</button>
            <button class="btn ghost" @click="setView('transcode')"><Icon name="transcribe" :size="14" />{{ t('继续转录') }}</button>
            <span class="home-status-inline"><i></i>{{ state.playing ? t('正在播放') : t('已就绪') }}</span>
          </div>
        </template>
        <template v-else>
          <div class="home-empty">
            <div class="home-empty-ic"><Icon name="import" :size="26" /></div>
            <div>
              <h2 class="home-hero-title">{{ t('拖入 MIDI 或音频开始') }}</h2>
              <p>{{ t('也可从曲库导入，或直接转录。') }}</p>
              <div class="home-hero-actions">
                <button class="btn primary" @click="pickMidi"><Icon name="import" :size="14" />{{ t('导入 MIDI') }}</button>
                <button class="btn ghost" @click="setView('transcode')">{{ t('音频转 MIDI') }}</button>
              </div>
            </div>
          </div>
        </template>
      </section>

      <section class="card home-status">
        <div class="home-status-head"><span>{{ t('系统就绪') }}</span><span class="tag ok">{{ t('可用') }}</span></div>
        <div class="home-status-row"><span class="dot" :class="{ warn: !engineReady }"></span><span>{{ t('本地引擎') }}</span><b>{{ engineReady ? t('桌面版') : t('仅浏览器') }}</b></div>
        <div class="home-status-row"><span class="dot"></span><span>{{ t('曲库') }}</span><b>{{ state.songs.length }} {{ t('首') }}</b></div>
        <div class="home-status-row"><span class="dot"></span><span>{{ t('运行模式') }}</span><b>{{ t('离线') }}</b></div>
        <div class="home-status-sep"></div>
        <div class="home-status-row muted"><span>{{ t('版本') }}</span><b>v{{ appVersion || '—' }}</b></div>
        <div class="home-status-actions">
          <button class="btn ghost sm" @click="openHealth"><Icon name="info" :size="13" />{{ t('体检') }}</button>
          <button class="btn ghost sm" @click="state.ui.settingsOpen = true"><Icon name="gear" :size="13" />{{ t('设置') }}</button>
        </div>
      </section>
    </div>

    <div class="home-actions">
      <button class="card home-action" @click="setView('transcode')">
        <span class="home-action-ic"><Icon name="transcribe" :size="18" /></span>
        <span><b>{{ t('音频转 MIDI') }}</b><small>{{ t('本地转录 · 队列') }}</small></span>
        <Icon name="arrow" :size="14" />
      </button>
      <button class="card home-action" @click="setView('views')">
        <span class="home-action-ic"><Icon name="viz" :size="18" /></span>
        <span><b>{{ t('打开工作台') }}</b><small>{{ t('乐谱 · 分析 · 编排') }}</small></span>
        <Icon name="arrow" :size="14" />
      </button>
      <button class="card home-action" @click="state.ui.appearanceOpen = true">
        <span class="home-action-ic"><Icon name="wallpaper" :size="18" /></span>
        <span><b>{{ t('外观与壁纸') }}</b><small>{{ t('主题 · 壁纸') }}</small></span>
        <Icon name="arrow" :size="14" />
      </button>
    </div>

    <section class="card home-recent">
      <div class="home-recent-head">
        <h3>{{ t('最近项目') }}</h3>
        <button class="btn ghost sm" @click="setView('music')">{{ t('查看全部') }}</button>
      </div>
      <div v-if="!recentSongs.length" class="home-recent-empty">{{ t('暂无曲目，导入一首开始。') }}</div>
      <div v-else class="home-recent-list">
        <button v-for="s in recentSongs" :key="s.id" class="home-recent-row" :class="{ active: s.id === state.currentId }" @click="selectSong(s.id)">
          <span class="home-recent-thumb"><Icon name="music" :size="14" /></span>
          <span class="home-recent-name"><b>{{ s.name }}</b><small>{{ s.song ? s.song.tracks.length : (s.meta.tracks || 0) }} {{ t('轨') }}<template v-if="s.song?.totalSec"> · {{ fmtTime(s.song.totalSec) }}</template></small></span>
          <span class="tag" v-if="s.id === state.currentId">{{ t('当前') }}</span>
          <Icon name="arrow" :size="13" />
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.home-view { max-width: 1280px; }
.home-head { display: flex; align-items: flex-end; gap: var(--sp-4); margin-bottom: 20px; }
.home-title { font-size: var(--fs-2xl); line-height: 1.15; margin: 7px 0 0; }
.home-sub { margin: 8px 0 0; color: var(--text3); font-size: var(--fs-sm); }
.home-head-actions { margin-left: auto; display: flex; gap: var(--sp-2); }
.home-top { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(260px, .72fr); gap: var(--sp-3); }
.home-hero { position: relative; padding: 18px 126px 18px 20px; overflow: hidden; background: linear-gradient(120deg, color-mix(in srgb, var(--accent-sapphire) 15%, transparent), color-mix(in srgb, var(--accent-sea) 8%, transparent) 55%, var(--surface)); }
.home-hero-mascot { position: absolute; right: 8px; top: 4px; height: 170px; width: auto; max-width: 130px; object-fit: contain; pointer-events: none; user-select: none; filter: drop-shadow(0 18px 30px rgba(0,0,0,.28)); z-index: 0; opacity: .98; }
.home-hero > :not(.home-hero-mascot) { position: relative; z-index: 1; }
.home-hero-top { display: flex; align-items: flex-start; gap: var(--sp-3); }
.home-cover { width: 66px; height: 66px; border-radius: var(--r-md); display: grid; place-items: center; background: linear-gradient(145deg, color-mix(in srgb, var(--accent-sapphire) 28%, var(--surface)), var(--surface-soft)); color: var(--accent-sky); border: 1px solid color-mix(in srgb, var(--ornament) 35%, var(--hairline)); flex: none; }
.home-hero-copy { min-width: 0; }
.home-hero-title { margin: 2px 0 0; font-size: var(--fs-xl); line-height: 1.25; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.home-meta { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: 9px; color: var(--text3); font-family: var(--font-num); font-size: var(--fs-xs); }
.home-meta span { border: 1px solid var(--hairline); border-radius: var(--r-sm); padding: 2px 6px; }
.home-hero-actions { display: flex; align-items: center; gap: var(--sp-2); margin-top: 17px; }
.home-hero-actions .btn { min-height: 32px; }
.home-status-inline { margin-left: auto; display: flex; align-items: center; gap: var(--sp-2); color: var(--text3); font-size: var(--fs-xs); }
.home-status-inline i { width: 6px; height: 6px; border-radius: 50%; background: var(--t-ok); box-shadow: 0 0 0 4px color-mix(in srgb, var(--t-ok) 12%, transparent); }
.home-wave { display: flex; align-items: center; gap: var(--sp-1); height: 48px; margin: 19px 0 2px; opacity: .9; }
.home-wave i { display: block; width: 3px; border-radius: var(--r-sm); background: linear-gradient(180deg, var(--accent-sky), var(--accent-sapphire)); opacity: .8; }
.home-empty { display: flex; align-items: center; gap: var(--sp-2); min-height: 154px; }
.home-empty-ic { width: 54px; height: 54px; border-radius: var(--r-lg); display: grid; place-items: center; background: color-mix(in srgb, var(--accent-sapphire) 12%, var(--surface)); border: 1px solid color-mix(in srgb, var(--accent-sky) 25%, var(--hairline)); color: var(--accent-sky); flex: none; }
.home-empty h2 { margin: 0; }
.home-empty p { margin: 7px 0 0; color: var(--text3); font-size: var(--fs-sm); line-height: 1.6; }
.home-empty .home-hero-actions { margin-top: 14px; }
.home-status { padding: 17px; display: flex; flex-direction: column; }
.home-status-head { display: flex; align-items: center; justify-content: space-between; font-size: var(--fs-md); font-weight: 600; margin-bottom: 8px; }
.home-status-row { display: flex; align-items: center; gap: var(--sp-2); min-height: 28px; color: var(--text2); font-size: var(--fs-sm); }
.home-status-row b { margin-left: auto; color: var(--text3); font-family: var(--font-num); font-size: var(--fs-xs); font-weight: 400; }
.home-status-row .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--t-ok); flex: none; }
.home-status-row .dot.warn { background: var(--t-warn); }
.home-status-row.muted { color: var(--text3); }
.home-status-sep { height: 1px; background: var(--hairline); margin: 9px 0; }
.home-status-actions { display: flex; gap: var(--sp-2); margin-top: 12px; }
.home-actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--sp-3); margin-top: 14px; }
.home-action { display: flex; align-items: center; gap: var(--sp-3); padding: 14px; text-align: left; transition: border-color var(--dur-1), background var(--dur-1); }
.home-action:hover { border-color: color-mix(in srgb, var(--accent-sky) 40%, var(--hairline)); background: color-mix(in srgb, var(--accent-sapphire) 4%, var(--surface)); }
.home-action > svg { margin-left: auto; color: var(--text3); flex: none; }
.home-action-ic { width: 32px; height: 32px; border-radius: var(--r-md); display: grid; place-items: center; background: color-mix(in srgb, var(--accent-sapphire) 11%, var(--surface-soft)); color: var(--accent-sky); flex: none; }
.home-action b { display: block; font-size: var(--fs-md); font-weight: 600; color: var(--text); }
.home-action small { display: block; margin-top: 3px; color: var(--text3); font-size: var(--fs-xs); }
.home-recent { margin-top: 14px; padding: 0; overflow: hidden; }
.home-recent-head { display: flex; align-items: center; padding: 14px 18px; border-bottom: 1px solid var(--hairline); }
.home-recent-head h3 { margin: 0; font-size: var(--fs-md); }
.home-recent-head .btn { margin-left: auto; }
.home-recent-list { display: flex; flex-direction: column; }
.home-recent-row { display: flex; align-items: center; gap: var(--sp-3); padding: 11px 18px; border-bottom: 1px solid var(--hairline); text-align: left; background: transparent; color: var(--text2); }
.home-recent-row:last-child { border-bottom: 0; }
.home-recent-row:hover, .home-recent-row.active { background: color-mix(in srgb, var(--accent-sapphire) 5%, var(--surface)); }
.home-recent-thumb { width: 30px; height: 30px; border-radius: var(--r-sm); background: var(--surface-soft); color: var(--accent-sky); display: grid; place-items: center; flex: none; }
.home-recent-name { min-width: 0; flex: 1; }
.home-recent-name b { display: block; color: var(--text); font-size: var(--fs-sm); font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.home-recent-name small { display: block; margin-top: 2px; color: var(--text3); font-family: var(--font-num); font-size: var(--fs-xs); }
.home-recent-row > svg { color: var(--text3); flex: none; }
.home-recent-empty { padding: 28px; text-align: center; color: var(--text3); font-size: var(--fs-sm); }
@media (max-width: 1100px) { .home-top { grid-template-columns: 1fr; } .home-head { align-items: flex-start; flex-direction: column; } .home-head-actions { margin-left: 0; } }
@media (max-width: 760px) { .home-actions { grid-template-columns: 1fr; } .home-hero { padding-right: 22px; } .home-hero-mascot { height: 150px; right: 6px; top: 4px; opacity: .55; } .home-hero-title { font-size: var(--fs-lg); } }
</style>
