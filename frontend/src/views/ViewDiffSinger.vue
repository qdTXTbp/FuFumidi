<script setup>
// DiffSinger 工作台：模块与声库（启用后才下载组件）/ 调教工作台（从曲库 MIDI 导入调教）
import { ref, computed, onMounted } from 'vue';
import Icon from '../components/Icon.vue';
import { useDiffsingerStore, getLastWavBytes } from '../stores/diffsinger';
import { useAppStore } from '../stores/app';
import { noteName } from '../core/util';
import { t } from '../core/i18n.js';
import { bridge, isDesktop } from '../api';

const store = useDiffsingerStore();
const app = useAppStore();

const TABS = [
  { id: 'studio', label: t('调教工作台'), ic: 'edit' },
  { id: 'module', label: t('模块与声库'), ic: 'box' },
];
const tab = ref('studio');
const busy = ref(false);
const msg = ref('');

async function run(fn) {
  busy.value = true;
  msg.value = '';
  try { const err = await fn(); if (err) msg.value = err; }
  catch (e) { msg.value = String((e && e.message) || e); }
  finally { busy.value = false; }
}

onMounted(async () => {
  store.init();
  if (!store.hasBridge) return;
  await store.loadStatus();
  await store.refreshVoicebanks();
  await store.refreshRegistry();
  if (store.voicebankDir) void store.inspect();
});

/* ---------------- 模块管理 ---------------- */
async function toggleEnabled() {
  await run(async () => {
    const err = await store.setEnabled(!store.enabled);
    if (!err && store.enabled && (!store.depsOk || !store.vocoderInstalled)) {
      msg.value = t('模块已启用。点击「安装组件」下载推理依赖与通用声码器后即可开始调教。');
    }
    return err;
  });
}

/* ---------------- 声库 ---------------- */
async function onImportZip() {
  await run(() => store.importZip());
}

/* ---------------- 曲库 MIDI 选择 ---------------- */
const pickerOpen = ref(false);
const pickerQ = ref('');
const pickerSong = ref(null);
const pickerTracks = ref([]);
const pickerBpm = ref(120);
const pickerTpb = ref(480);
const pickerTrackIdx = ref(0);
const pickerReplace = ref(true);
const pickerLoading = ref(false);

const filteredSongs = computed(() => {
  const q = pickerQ.value.trim().toLowerCase();
  const list = (app.songs || []).slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  if (!q) return list;
  return list.filter(s => String(s.name || '').toLowerCase().includes(q));
});

async function pickSong(song) {
  pickerSong.value = song;
  pickerTrackIdx.value = 0;
  pickerLoading.value = true;
  try {
    const r = await store.loadSongTracks(song);
    if (r.error) { msg.value = r.error; pickerSong.value = null; pickerTracks.value = []; }
    else { pickerTracks.value = r.tracks || []; pickerBpm.value = r.bpm || 120; pickerTpb.value = r.tpb || 480; }
  } finally { pickerLoading.value = false; }
}

function confirmImport() {
  const tr = pickerTracks.value[pickerTrackIdx.value];
  if (!tr || !pickerSong.value) return;
  const n = store.applyMidiTrack(tr, pickerBpm.value, pickerSong.value.name || '', pickerSong.value.id || '', pickerTpb.value, pickerReplace.value);
  pickerOpen.value = false;
  msg.value = t('已导入 ') + n + t(' 个音符') + (pickerReplace.value ? '' : t('（追加到现有音符后）'));
}

/* ---------------- 音符编辑 ---------------- */
function addNote() {
  const at = store.totalBeats;
  store.addNote(at, 60);
}
function pitchLabel(m) { return noteName(m) + ' (' + m + ')'; }

/* 模板事件取值辅助（模板内不能用 TS 断言） */
const evtVal = (e) => (e && e.target ? e.target.value : '');
const numVal = (e, def = 0) => { const v = Number(evtVal(e)); return Number.isFinite(v) ? v : def; };
const chkVal = (e) => !!(e && e.target && e.target.checked);

/* ---------------- 渲染与导出 ---------------- */
async function doRender() { await run(() => store.render()); }
async function doSaveWav() {
  const bytes = getLastWavBytes();
  if (!bytes || !bridge) return;
  const name = (store.sourceName || 'diffsinger') + '_vocal.wav';
  try { await bridge.saveBinary({ name, data: bytes }); } catch (e) { msg.value = String((e && e.message) || e); }
}

const fmtBytes = (n) => {
  n = Number(n) || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
};
</script>

<template>
  <div class="ds">
    <div class="ds-head">
      <div class="ds-title">
        <Icon name="utau" :size="16" />
        <b>{{ t('DiffSinger 调教') }}</b>
        <span class="tag">{{ t('AI 歌声合成') }}</span>
      </div>
      <div class="ds-tabs">
        <button v-for="tb in TABS" :key="tb.id" class="ds-tab" :class="{ on: tab === tb.id }" @click="tab = tb.id">
          <Icon :name="tb.ic" :size="13" /> {{ tb.label }}
        </button>
      </div>
      <div class="ds-meta">
        <span v-if="store.ready" class="ok-chip"><Icon name="spark" :size="12" /> {{ t('组件就绪') }}</span>
        <span v-else class="muted small">{{ t('模块未就绪') }}</span>
      </div>
    </div>

    <div class="ds-body">
      <!-- ================= 调教工作台 ================= -->
      <div v-if="tab === 'studio'" class="ds-studio">
        <section v-if="!store.hasBridge" class="ds-card">
          <div class="ds-empty"><Icon name="info" :size="18" />
            <p>{{ t('DiffSinger 歌声合成仅桌面版可用（需要 Python 引擎与 ONNX 推理组件）。') }}</p>
          </div>
        </section>

        <section v-else-if="!store.enabled" class="ds-card">
          <div class="ds-empty">
            <Icon name="box" :size="22" />
            <p><b>{{ t('DiffSinger 模块未启用') }}</b></p>
            <p class="muted small">{{ t('DiffSinger 是可选模块：未启用时不下载、不安装任何组件，与应用其他功能完全隔离。启用后可安装推理组件并导入声库。') }}</p>
            <button class="btn primary" :disabled="busy" @click="toggleEnabled"><Icon name="spark" :size="14" /> {{ t('启用 DiffSinger') }}</button>
          </div>
        </section>

        <template v-else>
          <!-- 顶栏：声库 / BPM / 来源 / 导入 MIDI -->
          <div class="ds-toolbar">
            <label class="ds-field">
              <span>{{ t('声库') }}</span>
              <select v-model="store.voicebankDir" @change="store.setVoicebank(store.voicebankDir)">
                <option value="" disabled>{{ t('选择声库…') }}</option>
                <option v-for="v in store.voicebanks" :key="v.dir" :value="v.dir">{{ v.name }}</option>
              </select>
            </label>
            <label class="ds-field sm">
              <span>{{ t('BPM') }}</span>
              <input type="number" min="20" max="400" :value="store.bpm" @change="store.setBpm(numVal($event, 120))" />
            </label>
            <button class="btn" :disabled="busy" @click="pickerOpen = true">
              <Icon name="music" :size="14" /> {{ t('从曲库选择 MIDI') }}
            </button>
            <button class="btn" :disabled="busy" @click="addNote"><Icon name="plus" :size="14" /> {{ t('添加音符') }}</button>
            <button class="btn danger" :disabled="busy || !store.notes.length" @click="store.clear()"><Icon name="trash" :size="14" /> {{ t('清空') }}</button>
            <span v-if="store.sourceName" class="muted small ds-src">{{ t('来源：') }}{{ store.sourceName }} · {{ store.notes.length }} {{ t('音符') }}</span>
            <span v-else class="muted small ds-src">{{ store.notes.length }} {{ t('音符') }}</span>
          </div>

          <!-- 声库信息 -->
          <div v-if="store.voicebankInfo" class="ds-vbinfo small">
            <Icon name="info" :size="13" />
            <span>{{ store.voicebankInfo.name }} · {{ store.voicebankInfo.phonemeCount }} {{ t('音素') }} · {{ t('词典') }} {{ store.voicebankInfo.dictionaryWords }} {{ t('词') }}</span>
            <span v-if="store.voicebankInfo.builtinVocoder" class="ok-chip">{{ t('自带声码器') }}</span>
            <span v-else class="muted">{{ t('使用通用声码器') }}</span>
          </div>

          <!-- 音符表 -->
          <div class="ds-notes">
            <div class="ds-notes-head ds-row">
              <span>#</span><span>{{ t('起点') }}</span><span>{{ t('时长') }}</span><span>{{ t('音高') }}</span>
              <span>{{ t('歌词') }}</span><span>{{ t('颤音') }}</span><span>{{ t('深度') }}</span><span>{{ t('频率') }}</span><span>{{ t('音分') }}</span><span></span>
            </div>
            <div class="ds-notes-body">
              <div v-for="(n, i) in store.sortedNotes" :key="n.id" class="ds-row" :class="{ sel: n.id === store.selectedId }" @click="store.selectedId = n.id">
                <span class="muted">{{ i + 1 }}</span>
                <span><input type="number" step="0.25" min="0" :value="n.startBeat" @change="store.updateNote(n.id, { startBeat: Math.max(0, numVal($event, 0)) })" /></span>
                <span><input type="number" step="0.125" min="0.125" :value="n.durBeat" @change="store.updateNote(n.id, { durBeat: Math.max(0.125, numVal($event, 1)) })" /></span>
                <span class="ds-pitch">
                  <input type="number" min="0" max="127" :value="n.pitch" @change="store.updateNote(n.id, { pitch: Math.max(0, Math.min(127, numVal($event, 60))) })" />
                  <em class="muted">{{ pitchLabel(n.pitch) }}</em>
                </span>
                <span><input type="text" class="ds-lyric" :value="n.lyric" @change="store.updateNote(n.id, { lyric: evtVal($event) })" /></span>
                <span><input type="checkbox" :checked="n.vibrato" @change="store.updateNote(n.id, { vibrato: chkVal($event) })" /></span>
                <span><input type="number" min="0" max="100" :value="n.vibDepth" :disabled="!n.vibrato" @change="store.updateNote(n.id, { vibDepth: numVal($event, 0) })" /></span>
                <span><input type="number" step="0.5" min="0" max="12" :value="n.vibFreq" :disabled="!n.vibrato" @change="store.updateNote(n.id, { vibFreq: numVal($event, 5.5) })" /></span>
                <span><input type="number" min="-100" max="100" :value="n.pitchOffset" @change="store.updateNote(n.id, { pitchOffset: Math.max(-100, Math.min(100, numVal($event, 0))) })" /></span>
                <span><button class="icon-btn" :title="t('删除')" @click.stop="store.removeNote(n.id)"><Icon name="trash" :size="13" /></button></span>
              </div>
              <div v-if="!store.notes.length" class="ds-empty small">
                <p class="muted">{{ t('还没有音符。点击「从曲库选择 MIDI」从已有音乐库导入旋律，或手动添加音符。') }}</p>
              </div>
            </div>
          </div>

          <!-- 渲染区 -->
          <div class="ds-render">
            <button class="btn primary big" :disabled="busy || store.rendering || !store.notes.length" @click="doRender">
              <Icon name="play" :size="15" /> {{ store.rendering ? t('渲染中…') : t('渲染歌声') }}
            </button>
            <div v-if="store.rendering" class="ds-prog">
              <div class="bar"><i :style="{ width: (store.renderPct || 0) + '%' }"></i></div>
              <span class="muted small">{{ store.renderText || (store.renderPct + '%') }}</span>
            </div>
            <div v-if="store.renderUrl" class="ds-audio">
              <audio controls :src="store.renderUrl"></audio>
              <button class="btn" @click="doSaveWav"><Icon name="save" :size="14" /> {{ t('导出 WAV') }}</button>
              <span class="muted small">{{ (store.lastDurationMs / 1000).toFixed(1) }}s</span>
            </div>
            <ul v-if="store.renderWarnings.length" class="ds-warn small">
              <li v-for="(w, i) in store.renderWarnings" :key="i"><Icon name="info" :size="12" /> {{ w }}</li>
            </ul>
          </div>
          <p v-if="msg" class="ds-msg small">{{ msg }}</p>
        </template>
      </div>

      <!-- ================= 模块与声库 ================= -->
      <div v-else class="ds-module">
        <!-- 启用状态 -->
        <section class="ds-card">
          <div class="ds-sec-title"><Icon name="gear" :size="14" /> {{ t('模块开关') }}</div>
          <div class="ds-switch-row">
            <button class="btn" :class="{ primary: !store.enabled }" :disabled="busy" @click="toggleEnabled">
              <Icon name="zap" :size="14" /> {{ store.enabled ? t('已启用（点击禁用）') : t('启用 DiffSinger') }}
            </button>
            <span class="muted small">{{ t('禁用保留已下载组件；重新启用即可继续使用。') }}</span>
          </div>
        </section>

        <!-- 组件状态与安装 -->
        <section v-if="store.enabled" class="ds-card">
          <div class="ds-sec-title"><Icon name="box" :size="14" /> {{ t('推理组件') }} <span class="muted small">（{{ t('启用后才下载，未启用零占用') }}）</span></div>
          <div class="ds-status-grid">
            <div class="ds-status" :class="{ ok: store.depsOk }">
              <Icon :name="store.depsOk ? 'spark' : 'info'" :size="15" />
              <div>
                <b>{{ t('Python 推理依赖') }}</b>
                <p class="muted small" v-if="store.depsOk">{{ t('就绪：') }}{{ store.depsMissing.length === 0 ? 'onnxruntime / pyyaml' : '' }}</p>
                <p class="muted small" v-else>{{ store.depsError || (t('缺失：') + store.depsMissing.join(', ')) }}</p>
              </div>
            </div>
            <div class="ds-status" :class="{ ok: store.vocoderInstalled }">
              <Icon :name="store.vocoderInstalled ? 'spark' : 'info'" :size="15" />
              <div>
                <b>{{ t('通用声码器') }}</b>
                <p class="muted small">{{ store.vocoderInstalled ? t('已安装（NSF-HiFiGAN）') : t('未安装（约 55 MB，下载后本地推理）') }}</p>
              </div>
            </div>
          </div>

          <div class="ds-install">
            <template v-if="!store.runtimeInstalling">
              <button class="btn primary" :disabled="busy || (store.depsOk && store.vocoderInstalled)" @click="run(() => store.installRuntime())">
                <Icon name="download" :size="14" /> {{ store.depsOk && store.vocoderInstalled ? t('组件已就绪') : t('安装组件') }}
              </button>
              <button class="btn danger" @click="run(() => store.uninstallRuntime(false))"><Icon name="trash" :size="14" /> {{ t('清理组件数据') }}</button>
            </template>
            <template v-else>
              <div class="ds-prog grow">
                <div class="bar"><i :style="{ width: (store.runtimePct || 0) + '%' }"></i></div>
                <span class="muted small">{{ store.runtimeText || t('安装中…') }}</span>
              </div>
              <button class="btn" @click="store.cancelRuntimeInstall()">{{ t('取消') }}</button>
            </template>
          </div>
        </section>

        <!-- 已导入声库 -->
        <section v-if="store.enabled" class="ds-card">
          <div class="ds-sec-title">
            <Icon name="mic" :size="14" /> {{ t('已导入声库') }}
            <button class="btn sm" :disabled="busy" @click="onImportZip"><Icon name="import" :size="13" /> {{ t('导入 zip / .oudep') }}</button>
          </div>
          <p class="muted small">{{ t('支持 OpenUTAU 格式的 DiffSinger 声库（含 dsconfig.yaml 的 zip）；.oudep 依赖包会安装为通用声码器。') }}</p>
          <div v-if="store.voicebanks.length" class="ds-vb-list">
            <div v-for="v in store.voicebanks" :key="v.dir" class="ds-vb" :class="{ on: v.dir === store.voicebankDir }" @click="store.setVoicebank(v.dir)">
              <Icon name="mic" :size="14" />
              <div class="ds-vb-main">
                <b>{{ v.name }}</b>
                <span class="muted small mono">{{ v.dir }}</span>
              </div>
              <span class="muted small">{{ fmtBytes(v.size) }}</span>
              <button class="icon-btn" :title="t('删除')" @click.stop="run(() => store.deleteVoicebank(v.dir))"><Icon name="trash" :size="13" /></button>
            </div>
          </div>
          <p v-else class="muted small">{{ t('还没有声库：导入本地 zip，或从下方公开声库一键下载。') }}</p>
        </section>

        <!-- 公开声库 -->
        <section v-if="store.enabled" class="ds-card">
          <div class="ds-sec-title"><Icon name="download" :size="14" /> {{ t('公开声库') }} <span class="muted small">（{{ t('来自作者公开仓库，使用条款以作者为准') }}）</span></div>
          <div v-for="it in store.registry" :key="it.id" class="ds-reg">
            <div class="ds-reg-main">
              <b>{{ it.name }}</b>
              <span class="muted small">{{ it.author }} · {{ it.lang }}</span>
              <p class="small">{{ it.desc }}</p>
              <p class="muted small">{{ it.license }}</p>
              <a class="small" :href="it.officialUrl" target="_blank" rel="noopener">{{ it.officialUrl }}</a>
            </div>
            <div class="ds-reg-act">
              <template v-if="!it.installed">
                <template v-if="store.vbProgress[it.id] && !store.vbProgress[it.id].done">
                  <div class="ds-prog">
                    <div class="bar"><i :style="{ width: (store.vbProgress[it.id].percent || 0) + '%' }"></i></div>
                  </div>
                  <button class="btn sm" @click="store.cancelVoicebankDownload(it.id)">{{ t('取消') }}</button>
                </template>
                <button v-else class="btn sm" :disabled="busy" @click="run(() => store.downloadVoicebank(it.id))"><Icon name="download" :size="13" /> {{ t('下载安装') }}</button>
              </template>
              <span v-else class="ok-chip"><Icon name="spark" :size="12" /> {{ t('已安装') }}</span>
            </div>
          </div>
        </section>
        <p v-if="msg" class="ds-msg small">{{ msg }}</p>
      </div>
    </div>

    <!-- MIDI 选择弹窗 -->
    <div v-if="pickerOpen" class="ds-modal-mask" @click.self="pickerOpen = false">
      <div class="ds-modal">
        <div class="ds-modal-head">
          <b>{{ t('从曲库选择 MIDI') }}</b>
          <button class="icon-btn" @click="pickerOpen = false"><Icon name="close" :size="15" /></button>
        </div>
        <div class="ds-modal-body">
          <div class="ds-modal-cols">
            <div class="ds-songlist">
              <div class="ds-search"><Icon name="search" :size="14" /><input v-model="pickerQ" :placeholder="t('搜索曲库…')" /></div>
              <div class="ds-songitems">
                <div v-for="s in filteredSongs" :key="s.id" class="ds-song" :class="{ on: pickerSong && pickerSong.id === s.id }" @click="pickSong(s)">
                  <Icon name="music" :size="13" />
                  <span class="ds-song-name">{{ s.name }}</span>
                </div>
                <p v-if="!filteredSongs.length" class="muted small ds-empty">{{ t('曲库为空') }}</p>
              </div>
            </div>
            <div class="ds-trackpane">
              <template v-if="pickerLoading"><p class="muted small">{{ t('解析中…') }}</p></template>
              <template v-else-if="pickerTracks.length">
                <p class="small"><b>{{ pickerSong ? pickerSong.name : '' }}</b> · {{ t('选择旋律轨道') }} · {{ pickerBpm }} BPM</p>
                <label v-for="(tr, i) in pickerTracks" :key="tr.index" class="ds-track" :class="{ on: pickerTrackIdx === i }">
                  <input type="radio" :value="i" v-model="pickerTrackIdx" />
                  <span>{{ tr.name }}</span>
                  <span class="muted small">{{ tr.noteCount }} {{ t('音符') }} · {{ noteName(tr.minPitch) }}–{{ noteName(tr.maxPitch) }}</span>
                </label>
                <label class="ds-replace"><input type="checkbox" v-model="pickerReplace" /> {{ t('替换现有音符（取消则追加）') }}</label>
                <button class="btn primary" @click="confirmImport"><Icon name="import" :size="14" /> {{ t('导入为基底旋律') }}</button>
              </template>
              <p v-else class="muted small">{{ t('先在左侧选择一首曲目') }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ds { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.ds-head { display: flex; align-items: center; gap: 14px; padding: 10px 18px; border-bottom: 1px solid var(--border); background: var(--canvas); }
.ds-title { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--ink); }
.ds-title b { font-size: 15px; }
.tag { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--brand-soft); color: var(--brand-text); border: 1px solid var(--brand); }
.ds-tabs { display: flex; gap: 4px; margin-left: 8px; }
.ds-tab { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--stone); font-size: 13px; cursor: pointer; }
.ds-tab:hover { background: var(--surface-muted); color: var(--ink); }
.ds-tab.on { background: var(--brand-soft); color: var(--brand-text); border-color: var(--brand); }
.ds-meta { margin-left: auto; }
.ds-body { flex: 1; min-height: 0; overflow: auto; padding: 14px 18px; display: flex; flex-direction: column; gap: 12px; }

.btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface); color: var(--ink); font-size: 13px; cursor: pointer; }
.btn:hover:not(:disabled) { border-color: var(--brand); color: var(--brand-text); }
.btn:disabled { opacity: .5; cursor: default; }
.btn.primary { background: var(--brand); border-color: var(--brand); color: #fff; }
.btn.primary:hover:not(:disabled) { filter: brightness(1.08); color: #fff; }
.btn.danger:hover:not(:disabled) { border-color: var(--danger, #d05555); color: var(--danger, #d05555); }
.btn.sm { padding: 4px 10px; font-size: 12px; }
.btn.big { padding: 10px 22px; font-size: 14px; }
.icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 7px; border: none; background: transparent; color: var(--stone); cursor: pointer; }
.icon-btn:hover { background: var(--surface-muted); color: var(--danger, #d05555); }
.muted { color: var(--stone); }
.small { font-size: 12px; }
.mono { font-family: ui-monospace, monospace; }
.ok-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 2px 8px; border-radius: 999px; background: rgba(46, 160, 103, .15); color: #2ea067; border: 1px solid rgba(46, 160, 103, .4); }

/* ---- 卡片 ---- */
.ds-card { border: 1px solid var(--border); border-radius: 12px; background: var(--canvas); padding: 14px 16px; }
.ds-sec-title { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--ink); margin-bottom: 10px; }
.ds-sec-title .btn { margin-left: auto; }
.ds-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 30px 16px; text-align: center; color: var(--ink); }
.ds-empty.small { padding: 14px; }

/* ---- 模块管理 ---- */
.ds-switch-row { display: flex; align-items: center; gap: 12px; }
.ds-status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; margin-bottom: 12px; }
.ds-status { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
.ds-status.ok { border-color: rgba(46, 160, 103, .5); }
.ds-install { display: flex; align-items: center; gap: 10px; }
.ds-install .grow { flex: 1; }
.ds-vb-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.ds-vb { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 10px; cursor: pointer; background: var(--surface); }
.ds-vb.on { border-color: var(--brand); background: var(--brand-soft); }
.ds-vb-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ds-vb-main .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ds-reg { display: flex; gap: 14px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
.ds-reg + .ds-reg { margin-top: 8px; }
.ds-reg-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.ds-reg-act { display: flex; flex-direction: column; align-items: flex-end; justify-content: center; gap: 6px; }
.ds-prog { display: flex; flex-direction: column; gap: 4px; min-width: 160px; }
.ds-prog .bar { height: 6px; border-radius: 999px; background: var(--surface-muted); overflow: hidden; }
.ds-prog .bar i { display: block; height: 100%; background: var(--brand); border-radius: 999px; transition: width .2s; }

/* ---- 调教工作台 ---- */
.ds-studio { display: flex; flex-direction: column; gap: 10px; }
.ds-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ds-field { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--stone); }
.ds-field select, .ds-field input { padding: 6px 9px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--ink); font-size: 13px; max-width: 220px; }
.ds-field.sm input { width: 74px; }
.ds-src { margin-left: auto; }
.ds-vbinfo { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border: 1px dashed var(--border); border-radius: 9px; color: var(--stone); }

.ds-notes { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--canvas); }
.ds-row { display: grid; grid-template-columns: 34px 84px 84px 118px 1fr 52px 64px 64px 64px 40px; gap: 6px; align-items: center; padding: 5px 10px; }
.ds-notes-head { background: var(--surface-muted); font-size: 12px; color: var(--stone); border-bottom: 1px solid var(--border); }
.ds-notes-body { max-height: 46vh; overflow: auto; }
.ds-row.sel { background: var(--brand-soft); }
.ds-row input[type="number"], .ds-row input[type="text"] { width: 100%; padding: 4px 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--ink); font-size: 12px; }
.ds-row input:focus { outline: none; border-color: var(--brand); }
.ds-pitch { display: flex; align-items: center; gap: 6px; }
.ds-pitch input { width: 56px; }
.ds-pitch em { font-style: normal; font-size: 11px; white-space: nowrap; }
.ds-lyric { min-width: 60px; }

.ds-render { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px; }
.ds-render > .btn { align-self: flex-start; }
.ds-audio { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ds-audio audio { height: 38px; max-width: 460px; }
.ds-warn { margin: 0; padding: 8px 12px; border: 1px solid rgba(217, 164, 65, .5); background: rgba(217, 164, 65, .1); border-radius: 9px; color: var(--ink); list-style: none; }
.ds-warn li { display: flex; gap: 6px; align-items: center; padding: 2px 0; }
.ds-msg { color: var(--brand-text); }

/* ---- 弹窗 ---- */
.ds-modal-mask { position: fixed; inset: 0; background: rgba(0, 0, 0, .45); display: flex; align-items: center; justify-content: center; z-index: 60; }
.ds-modal { width: min(760px, 92vw); max-height: 82vh; display: flex; flex-direction: column; background: var(--canvas); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
.ds-modal-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.ds-modal-body { padding: 12px 16px; overflow: auto; }
.ds-modal-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; min-height: 260px; }
.ds-search { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 8px; color: var(--stone); }
.ds-search input { flex: 1; border: none; background: transparent; color: var(--ink); font-size: 13px; outline: none; }
.ds-songitems { max-height: 46vh; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.ds-song { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 8px; cursor: pointer; color: var(--ink); }
.ds-song:hover { background: var(--surface-muted); }
.ds-song.on { background: var(--brand-soft); color: var(--brand-text); }
.ds-song-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ds-trackpane { display: flex; flex-direction: column; gap: 8px; }
.ds-track { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 9px; cursor: pointer; }
.ds-track.on { border-color: var(--brand); background: var(--brand-soft); }
.ds-replace { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--stone); }
@media (max-width: 720px) { .ds-modal-cols { grid-template-columns: 1fr; } .ds-row { grid-template-columns: 28px 64px 64px 100px 1fr 44px 54px 54px 54px 34px; } }
</style>
