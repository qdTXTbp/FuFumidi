<script setup>
// 翻唱工作流（一键）：一首歌 → 分离 → 扒谱 → 合成 → 混音 → 成品。
// 引擎侧只有一份实现（engine/engine_cover.py），界面只是选参数 + 看进度：
//   · 音色通道 ①DiffSinger 声库（扒谱出的音符 → 合成）
//   · 音色通道 ②GPT-SoVITS 音色（逐句拿原唱那一句当参考重合成，音色可复用下载的声库）
// 两条通道的产出同构（一条整长干声轨），后面的混音完全共用。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from '../components/Icon.vue';
import { t } from '../core/i18n.js';
import { useAppStore } from '../stores/app';

const app = useAppStore();
const bridge = window.fuBridge;
const isDesktop = !!bridge;

const audio = ref('');
const outdir = ref('');
const name = ref('');
const singers = ref({ diffsinger: [], gsv: [] });
const singerKind = ref('diffsinger');
const singerId = ref('');
const device = ref('auto');
const clarityDb = ref(2.0);
const noResume = ref(false);
const lyrics = ref('auto');
const gsvRoot = ref('');
const gsvPython = ref('');
const env = ref(null);
// 「音频处理」面板分离完可以直接过来：那边把音轨路径写进 localStorage，这里接手
const preVocals = ref('');
const preInst = ref('');

const running = ref(false);
const percent = ref(0);
const stage = ref('');
const logs = ref([]);
const result = ref(null);
const error = ref('');
let off = null;

const currentList = computed(() => (singerKind.value === 'gsv' ? singers.value.gsv : singers.value.diffsinger));
const currentSinger = computed(() => currentList.value.find((s) => s.id === singerId.value) || null);
const gsvReady = computed(() => !!(env.value && env.value.gsv && env.value.gsv.found));
const canRun = computed(() => !!audio.value && !!currentSinger.value && !!outdir.value && !running.value);

function toast(m, type) { try { app.toast(m, type || 'info'); } catch (e) {} }

async function load() {
  if (!isDesktop || !bridge.coverSingers) return;
  try {
    const r = await bridge.coverSingers();
    if (r && r.ok) {
      singers.value = { diffsinger: r.diffsinger || [], gsv: r.gsv || [] };
      if (!singers.value.diffsinger.length && singers.value.gsv.length) singerKind.value = 'gsv';
      const list = currentList.value;
      if (list.length && !list.some((s) => s.id === singerId.value)) singerId.value = list[0].id;
    }
  } catch (e) {}
  try {
    const e2 = await bridge.coverEnv();
    if (e2 && e2.ok) {
      env.value = e2;
      if (!gsvRoot.value && e2.gsv && e2.gsv.root) gsvRoot.value = e2.gsv.root;
      if (!gsvPython.value && e2.gsv && e2.gsv.python) gsvPython.value = e2.gsv.python;
    }
  } catch (e) {}
  try {
    const pre = JSON.parse(localStorage.getItem('fufumidi_cover_prefill') || '{}');
    if (pre && (pre.vocals || pre.instrumental)) {
      preVocals.value = pre.vocals || '';
      preInst.value = pre.instrumental || '';
      if (pre.audio) audio.value = pre.audio;
      if (pre.outdir) outdir.value = pre.outdir;
      localStorage.removeItem('fufumidi_cover_prefill');
      toast(t('已带入音频处理面板的分离结果，可直接开始翻唱'), 'ok');
    }
  } catch (e) {}
  try {
    const saved = JSON.parse(localStorage.getItem('fufumidi_cover_opts') || '{}');
    if (saved.outdir) outdir.value = saved.outdir;
    if (saved.device) device.value = saved.device;
    if (saved.clarityDb != null) clarityDb.value = saved.clarityDb;
    if (saved.gsvRoot) gsvRoot.value = saved.gsvRoot;
    if (saved.gsvPython) gsvPython.value = saved.gsvPython;
    if (saved.singerKind) singerKind.value = saved.singerKind;
  } catch (e) {}
}

function saveOpts() {
  try {
    localStorage.setItem('fufumidi_cover_opts', JSON.stringify({
      outdir: outdir.value, device: device.value, clarityDb: clarityDb.value,
      gsvRoot: gsvRoot.value, gsvPython: gsvPython.value, singerKind: singerKind.value,
    }));
  } catch (e) {}
}

async function pickAudio() {
  if (!bridge.coverPickAudio) return toast(t('请使用桌面版 FuFumidi'), 'warn');
  const r = await bridge.coverPickAudio();
  if (r && r.ok) {
    audio.value = r.path;
    if (!name.value) name.value = String(r.path).replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') + '_翻唱';
    if (!outdir.value) {
      const dir = String(r.path).replace(/[\\/][^\\/]*$/, '');
      outdir.value = dir + '\\' + (name.value || 'cover');
    }
  }
}

async function pickDir() {
  const r = await bridge.coverPickDir();
  if (r && r.ok) outdir.value = r.path;
}

/** 选一次 GPT-SoVITS 目录就够：主进程写进 runtime.json，以后自动带出来 */
async function pickGsvRoot() {
  if (!bridge.coverPickGsvRoot) return;
  const r = await bridge.coverPickGsvRoot();
  if (r && r.ok) { gsvRoot.value = r.root || ''; if (r.python) gsvPython.value = r.python; toast(t('已记住 GPT-SoVITS 运行时'), 'ok'); }
  else if (r && r.error) toast(r.error, 'warn');
}
async function pickGsvPython() {
  if (!bridge.coverPickGsvPython) return;
  const r = await bridge.coverPickGsvPython();
  if (r && r.ok) { gsvPython.value = r.python || ''; toast(t('已记住解释器'), 'ok'); }
}

function switchKind(k) {
  singerKind.value = k;
  const list = currentList.value;
  singerId.value = list.length ? list[0].id : '';
  saveOpts();
}

async function run() {
  if (!canRun.value) return;
  running.value = true; percent.value = 0; stage.value = ''; logs.value = []; result.value = null; error.value = '';
  saveOpts();
  const singer = currentSinger.value;
  const payload = {
    audio: audio.value, outdir: outdir.value, name: name.value || undefined,
    singer: { kind: singer.kind, path: singer.dir, id: singer.id },
    device: device.value, clarityDb: Number(clarityDb.value) || 0,
    lyrics: lyrics.value, noResume: noResume.value,
    vocals: preVocals.value || undefined, instrumental: preInst.value || undefined,
    gsvRoot: gsvRoot.value, gsvPython: gsvPython.value,
  };
  try {
    const r = await bridge.coverRun(payload);
    if (!r || !r.ok) { running.value = false; error.value = (r && r.error) || t('启动失败'); toast(error.value, 'error'); }
  } catch (e) {
    running.value = false; error.value = String(e && e.message || e); toast(error.value, 'error');
  }
}

async function cancel() {
  try { await bridge.coverCancel(); } catch (e) {}
}

function openPath(p) { try { bridge.coverOpen(p); } catch (e) {} }

onMounted(() => {
  load();
  if (bridge && bridge.onCoverProgress) {
    off = bridge.onCoverProgress((p) => {
      if (!p) return;
      if (p.log) { logs.value.push(p.log); if (logs.value.length > 300) logs.value.shift(); }
      if (typeof p.percent === 'number' && p.percent >= 0) percent.value = p.percent;
      if (p.text) stage.value = p.text;
      if (p.done) {
        running.value = false;
        if (p.ok) {
          result.value = p.result || {};
          percent.value = 100;
          stage.value = t('完成');
          toast(t('翻唱完成'), 'ok');
        } else if (p.aborted) {
          stage.value = t('已取消');
        } else {
          error.value = p.error || t('失败');
          toast(error.value, 'error');
        }
      }
    });
  }
});
onBeforeUnmount(() => { if (off) { try { off(); } catch (e) {} off = null; } });
</script>

<template>
  <div class="page page-flat cv-wrap">
    <div class="page-head">
      <div class="page-ic"><Icon name="mic" :size="20" /></div>
      <div>
        <div class="page-title">{{ t('翻唱') }}</div>
        <div class="page-sub">{{ t('一首歌 → 分离 → 扒谱 → 合成 → 混音 → 成品。人声分离复用「音频处理」那套模型，音色可以是你下载的 DiffSinger 声库或 GPT-SoVITS 音色。') }}</div>
      </div>
    </div>

    <div v-if="!isDesktop" class="card"><div class="card-title">{{ t('请使用桌面版 FuFumidi') }}</div></div>

    <template v-else>
      <div class="card">
        <div class="card-title"><span class="dot"></span>{{ t('① 选歌') }}</div>
        <div class="cv-row">
          <button class="btn" @click="pickAudio"><Icon name="import" :size="14" /> {{ t('选择音频') }}</button>
          <span class="muted small cv-ellipsis">{{ audio || t('支持 flac / wav / mp3 / m4a / ogg') }}</span>
        </div>
        <div class="cv-row" v-if="preVocals || preInst">
          <span class="cv-label">{{ t('复用分离结果') }}</span>
          <span class="muted small cv-ellipsis">{{ preVocals || '—' }} / {{ preInst || '—' }}</span>
          <button class="btn sm ghost" @click="preVocals = ''; preInst = ''">{{ t('清除') }}</button>
        </div>
        <div class="cv-row">
          <span class="cv-label">{{ t('歌词') }}</span>
          <select class="text-input" v-model="lyrics" style="max-width:220px">
            <option value="auto">{{ t('自动（同名 .lrc / 音频内嵌 / 没有就哼唱）') }}</option>
          </select>
          <span class="muted small">{{ t('有 LRC 时每句都能对上；没有歌词就整首用「啦」哼唱') }}</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title"><span class="dot"></span>{{ t('② 选音色') }}</div>
        <div class="cv-seg">
          <button class="btn sm" :class="{ primary: singerKind === 'diffsinger' }" @click="switchKind('diffsinger')">
            {{ t('DiffSinger 声库') }}（{{ singers.diffsinger.length }}）
          </button>
          <button class="btn sm" :class="{ primary: singerKind === 'gsv' }" @click="switchKind('gsv')">
            GPT-SoVITS {{ t('音色') }}（{{ singers.gsv.length }}）
          </button>
        </div>
        <div class="cv-row">
          <select class="text-input" v-model="singerId" style="max-width:420px">
            <option v-for="s in currentList" :key="s.kind + s.id" :value="s.id">{{ s.name }} —— {{ s.note }}</option>
          </select>
          <span v-if="!currentList.length" class="muted small">
            {{ singerKind === 'gsv' ? t('还没有 GPT-SoVITS 音色，去「资源中心」下载') : t('还没有 DiffSinger 声库，去「调教 → 声库」安装') }}
          </span>
        </div>
        <div v-if="singerKind === 'gsv'" class="cv-adv">
          <div class="cv-row">
            <span class="cv-label">{{ t('运行时') }}</span>
            <input class="text-input" v-model="gsvRoot" style="flex:1;min-width:220px" :placeholder="t('GPT-SoVITS 目录（含 GPT_SoVITS/）')" @change="saveOpts" />
            <button class="btn sm" @click="pickGsvRoot"><Icon name="folder" :size="13" /> {{ t('选择') }}</button>
          </div>
          <div class="cv-row">
            <span class="cv-label">{{ t('解释器') }}</span>
            <input class="text-input" v-model="gsvPython" style="flex:1;min-width:220px" :placeholder="t('装好 torch 的 python.exe')" @change="saveOpts" />
            <button class="btn sm" @click="pickGsvPython"><Icon name="folder" :size="13" /> {{ t('选择') }}</button>
          </div>
          <div class="muted small" v-if="!gsvReady">
            {{ t('没找到 GPT-SoVITS 运行时：指向一份已有安装，或把路径写进 数据目录/gpt-sovits/runtime.json。') }}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title"><span class="dot"></span>{{ t('③ 输出与选项') }}</div>
        <div class="cv-row">
          <button class="btn sm" @click="pickDir"><Icon name="folder" :size="13" /> {{ t('输出目录') }}</button>
          <span class="muted small cv-ellipsis">{{ outdir || t('未选择') }}</span>
        </div>
        <div class="cv-row">
          <span class="cv-label">{{ t('名称') }}</span>
          <input class="text-input" v-model="name" style="max-width:260px" :placeholder="t('成品文件名')" />
          <span class="cv-label">{{ t('设备') }}</span>
          <select class="text-input" v-model="device" style="max-width:120px" @change="saveOpts">
            <option value="auto">{{ t('自动') }}</option>
            <option value="cuda">GPU</option>
            <option value="cpu">CPU</option>
          </select>
          <span class="cv-label">{{ t('清晰度') }}</span>
          <select class="text-input" v-model.number="clarityDb" style="max-width:100px" @change="saveOpts">
            <option :value="0">{{ t('关') }}</option>
            <option :value="1.5">+1.5 dB</option>
            <option :value="2">+2 dB</option>
            <option :value="2.5">+2.5 dB</option>
            <option :value="3">+3 dB</option>
          </select>
        </div>
        <label class="cv-check"><input type="checkbox" v-model="noResume" /> {{ t('不复用上次的中间结果（分离 / 扒谱 / 合成全部重算）') }}</label>
      </div>

      <div class="card">
        <div class="card-title"><span class="dot"></span>{{ t('④ 开始') }}</div>
        <div class="cv-row">
          <button class="btn primary" :disabled="!canRun" @click="run">
            <Icon name="play2" :size="14" /> {{ t('开始翻唱') }}
          </button>
          <button class="btn danger" v-if="running" @click="cancel">{{ t('取消') }}</button>
          <span class="muted small">{{ stage }}</span>
        </div>
        <div class="cv-bar"><i :style="{ width: Math.max(0, Math.min(100, percent)) + '%' }"></i></div>
        <div v-if="error" class="cv-err">{{ error }}</div>
        <pre v-if="logs.length" class="cv-log">{{ logs.slice(-40).join('\n') }}</pre>
      </div>

      <div v-if="result && result.out" class="card">
        <div class="card-title"><span class="dot"></span>{{ t('成品') }}</div>
        <div class="cv-row"><span class="cv-label">{{ t('成品') }}</span><span class="cv-ellipsis">{{ result.out }}</span>
          <button class="btn sm" @click="openPath(String(result.out).replace(/[^\\/]*$/, ''))">{{ t('打开文件夹') }}</button></div>
        <div class="cv-row" v-if="result.dry"><span class="cv-label">{{ t('干声') }}</span><span class="cv-ellipsis">{{ result.dry }}</span></div>
        <div class="cv-row" v-if="result.readme"><span class="cv-label">{{ t('说明') }}</span><span class="cv-ellipsis">{{ result.readme }}</span></div>
        <div class="cv-row" v-if="result.info">
          <span class="muted small">
            {{ t('音符') }} {{ result.info.notes }} · BPM {{ result.info.bpm }} ·
            {{ t('音色') }} {{ result.info.singer || '—' }} ·
            {{ t('配平') }} {{ result.info.level_match_db }} dB
          </span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.cv-wrap { display: flex; flex-direction: column; gap: 14px; }
.cv-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.cv-label { font-size: 12px; color: var(--stone); flex: none; }
.cv-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60ch; }
.cv-seg { display: flex; gap: 8px; margin-top: 6px; }
.cv-adv { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--hairline); }
.cv-check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--steel); margin-top: 10px; }
.cv-bar { height: 8px; border-radius: 6px; background: var(--surface-soft); overflow: hidden; margin-top: 10px; }
.cv-bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--brand-blue, #4facfe), #00f2fe); transition: width .25s ease; }
.cv-err { margin-top: 10px; font-size: 12px; color: var(--error); white-space: pre-wrap; }
.cv-log { margin-top: 10px; max-height: 220px; overflow: auto; font-size: 11.5px; line-height: 1.6; background: var(--surface-soft); border-radius: 8px; padding: 8px 10px; white-space: pre-wrap; }
</style>
