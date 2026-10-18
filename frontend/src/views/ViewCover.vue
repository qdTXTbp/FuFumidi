<script setup>
// 翻唱工作流（一键）：一首歌 → 分离 → 扒谱 → 合成 → 混音 → 成品。
// 引擎侧只有一份实现（engine/engine_cover.py），界面只是选参数 + 看进度：
//   · 音色通道 ①DiffSinger 声库（扒谱出的音符 → 合成）
//   · 音色通道 ②GPT-SoVITS 音色（逐句拿原唱那一句当参考重合成，音色可复用下载的声库）
// 两条通道的产出同构（一条整长干声轨），后面的混音完全共用。
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import Icon from '../components/Icon.vue';
import { t } from '../core/i18n.js';
import { useAppStore } from '../stores/app';
import NumSlider from '../components/NumSlider.vue';

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
// P1-5：严格模式（字保留率 <95% 时停止混音，保留干声供调整后重试）
const charStrict = ref(false);
const lyrics = ref('auto');
const gsvRoot = ref('');
const gsvPython = ref('');

/* GPT-SoVITS 采样三参数（念白与翻唱共用）。
 * ★ 默认值不是我们定的 —— 是**实地读自本机那份 runtime**：
 *   `GPT_SoVITS/TTS_infer_pack/TTS.py:1142-1144` → top_k=15 / top_p=1 / temperature=1。
 *   滑块范围也取上游 WebUI 自己的范围（`inference_webui.py:1414-1420`），不自己编。
 * ★ 停在默认值上时**一个都不发** —— 于是"没动过"就等于完全用上游默认，
 *   上游以后改了默认值我们的行为也跟着变；只有用户真拖了才覆盖。
 *   （引擎侧同理：`_sampling_kwargs` 只取显式给了的。） */
const GSV_SAMPLING_DEF = { topK: 15, topP: 1, temperature: 1 };
const gsvTopK = ref(GSV_SAMPLING_DEF.topK);
const gsvTopP = ref(GSV_SAMPLING_DEF.topP);
const gsvTemperature = ref(GSV_SAMPLING_DEF.temperature);
/** 只把**真的改过**的采样参数发给引擎（相等的就不发）。 */
function gsvSamplingPayload() {
  const o = {};
  if (Number(gsvTopK.value) !== GSV_SAMPLING_DEF.topK) o.gsvTopK = Number(gsvTopK.value);
  if (Number(gsvTopP.value) !== GSV_SAMPLING_DEF.topP) o.gsvTopP = Number(gsvTopP.value);
  if (Number(gsvTemperature.value) !== GSV_SAMPLING_DEF.temperature) o.gsvTemperature = Number(gsvTemperature.value);
  return o;
}
/** 当前到底是"用上游默认"还是"覆盖了哪几项" —— 写在界面上，别让用户猜。 */
function gsvSamplingPayloadText() {
  const o = gsvSamplingPayload();
  const ks = Object.keys(o);
  if (!ks.length) return t('当前：完全用 GPT-SoVITS 自己的默认值（未覆盖任何一项）');
  return t('当前覆盖：') + ks.map((k) => k.replace('gsv', '').toLowerCase() + '=' + o[k]).join(' · ');
}
function resetGsvSampling() {
  gsvTopK.value = GSV_SAMPLING_DEF.topK;
  gsvTopP.value = GSV_SAMPLING_DEF.topP;
  gsvTemperature.value = GSV_SAMPLING_DEF.temperature;
  saveOpts();
  toast(t('已恢复上游默认采样参数'), 'ok');
}
const env = ref(null);
// 「音频处理」面板分离完可以直接过来：那边把音轨路径写进 localStorage，这里接手
const preVocals = ref('');
const preInst = ref('');

const running = ref(false);
const percent = ref(0);
const stage = ref('');
const logs = ref([]);
const result = ref(null);
// P1-5：逐句字级对齐里保留率 <95% 的句子（丢字/糊字 UI 标记；数据来自 engine_cover 的 info.gsv_char_report）
const charBadLines = computed(() => {
  const info = (result.value && result.value.info) || {};
  const rows = info.gsv_char_report;
  return Array.isArray(rows) ? rows : [];
});
const error = ref('');
let off = null;

const currentList = computed(() => (singerKind.value === 'gsv' ? singers.value.gsv : singers.value.diffsinger));
const currentSinger = computed(() => currentList.value.find((s) => s.id === singerId.value) || null);
/* ★ 选中项与当前分栏必须始终自洽。
   以前只在 load() 里选一次，而 localStorage 记住的「上次分栏」是**在列表拉回来之后**才恢复的：
   于是「上次用的 GPT-SoVITS」重启后，分栏高亮在 GPT-SoVITS，singerId 却还是 DiffSinger 的名字 →
   下拉框空白、也点不动（用户报的「无法选择资源中心下载的音色」就是这个）。
   这里改成 watch：分栏或列表一变，选中的 id 不在当前列表里就自动落到第一项。 */
watch([singerKind, currentList], () => {
  const list = currentList.value;
  if (!list.length) { singerId.value = ''; return; }
  if (!list.some((s) => s.id === singerId.value)) singerId.value = list[0].id;
}, { immediate: true });
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
    if (saved.gsvTopK != null) gsvTopK.value = Number(saved.gsvTopK);
    if (saved.gsvTopP != null) gsvTopP.value = Number(saved.gsvTopP);
    if (saved.gsvTemperature != null) gsvTemperature.value = Number(saved.gsvTemperature);
    if (saved.singerKind) singerKind.value = saved.singerKind;
    if (saved.charStrict != null) charStrict.value = !!saved.charStrict;
  } catch (e) {}
}

function saveOpts() {
  try {
    localStorage.setItem('fufumidi_cover_opts', JSON.stringify({
      outdir: outdir.value, device: device.value, clarityDb: clarityDb.value,
      gsvRoot: gsvRoot.value, gsvPython: gsvPython.value, singerKind: singerKind.value,
      gsvTopK: gsvTopK.value, gsvTopP: gsvTopP.value, gsvTemperature: gsvTemperature.value,
      charStrict: !!charStrict.value,
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
  singerKind.value = k;      // 选中项由上面的 watch 兜底（不在当前列表里就落到第一项）
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
    lyrics: lyrics.value, noResume: noResume.value, charStrict: !!charStrict.value,
    vocals: preVocals.value || undefined, instrumental: preInst.value || undefined,
    gsvRoot: gsvRoot.value, gsvPython: gsvPython.value,
    ...gsvSamplingPayload(),      // 只发改过的（相等就不发 = 用上游默认）
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
/** P1-5 手动修正：去调教页改歌词（未改动的句子在重跑时复用缓存，只重跑改过的句） */
function goSinger() { try { location.hash = '#/singer'; } catch (e) {} }

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
          <button class="btn" data-guide="cover-pick-audio" @click="pickAudio"><Icon name="import" :size="14" /> {{ t('选择音频') }}</button>
          <span class="muted small cv-ellipsis">{{ audio || t('支持 flac / wav / mp3 / m4a / ogg') }}</span>
        </div>
        <div class="cv-row" v-if="preVocals || preInst">
          <span class="cv-label">{{ t('复用分离结果') }}</span>
          <span class="muted small cv-ellipsis">{{ preVocals || '—' }} / {{ preInst || '—' }}</span>
          <button class="btn sm ghost" @click="preVocals = ''; preInst = ''">{{ t('清除') }}</button>
        </div>
        <div class="cv-row" data-guide="cover-lyrics">
          <span class="cv-label">{{ t('歌词') }}</span>
          <select class="text-input" v-model="lyrics" style="max-width:220px">
            <option value="auto">{{ t('自动（同名 .lrc / 音频内嵌 / 没有就哼唱）') }}</option>
          </select>
          <span class="muted small">{{ t('有 LRC 时每句都能对上；没有歌词就整首用「啦」哼唱') }}</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title"><span class="dot"></span>{{ t('② 选音色') }}</div>
        <div class="cv-seg" data-guide="cover-kind">
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
          <!-- 采样参数：范围与默认值都取上游自己的（见 script 里的说明）。
               停在默认值上 = 一个都不发 = 完全用上游默认。 -->
          <div class="cv-row">
            <span class="cv-label">{{ t('top-k') }}</span>
            <NumSlider v-model="gsvTopK" :min="1" :max="100" :step="1" style="flex:1" @change="saveOpts" />
            <b class="cv-val">{{ gsvTopK }}</b>
          </div>
          <div class="cv-row">
            <span class="cv-label">{{ t('top-p') }}</span>
            <NumSlider v-model="gsvTopP" :min="0" :max="1" :step="0.05" style="flex:1" @change="saveOpts" />
            <b class="cv-val">{{ Number(gsvTopP).toFixed(2) }}</b>
          </div>
          <div class="cv-row">
            <span class="cv-label">{{ t('温度') }}</span>
            <NumSlider v-model="gsvTemperature" :min="0" :max="1" :step="0.05" style="flex:1" @change="saveOpts" />
            <b class="cv-val">{{ Number(gsvTemperature).toFixed(2) }}</b>
          </div>
          <div class="cv-row">
            <span class="cv-label"></span>
            <span class="muted small" style="flex:1">
              {{ gsvSamplingPayloadText() }}
            </span>
            <button class="btn sm ghost" @click="resetGsvSampling">{{ t('恢复上游默认') }}</button>
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
      <label class="cv-check" v-if="singerKind === 'gsv'" :title="t('字级校验不通过时停止混音（干声会保留）')">
        <input type="checkbox" v-model="charStrict" data-guide="cover-char-strict" /> {{ t('咬字校验严格模式（保留率 <95% 时不混音）') }}
      </label>
      </div>

      <div class="card">
        <div class="card-title"><span class="dot"></span>{{ t('④ 开始') }}</div>
        <div class="cv-row">
          <button class="btn primary" data-guide="cover-run" :disabled="!canRun" @click="run">
            <Icon name="play2" :size="14" /> {{ t('开始翻唱') }}
          </button>
          <button class="btn danger" v-if="running" @click="cancel">{{ t('取消') }}</button>
          <span class="muted small">{{ stage }}</span>
        </div>
        <div class="cv-bar"><i :style="{ transform: 'scaleX(' + ((Math.max(0, Math.min(100, percent))) / 100) + ')' }"></i></div>
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
        <div v-if="charBadLines.length" class="cv-char-warn" data-guide="cover-char-align">
          <div class="cv-row"><span class="cv-label">{{ t('咬字校验') }}</span>
            <b>{{ charBadLines.length }}</b>&nbsp;{{ t('句字保留率 <95%（可能丢字/糊字）') }}</div>
          <div v-for="ln in charBadLines.slice(0, 20)" :key="ln.index" class="cv-row cv-char-line">
            <span class="cv-ellipsis">#{{ (ln.index != null ? ln.index : 0) + 1 }} {{ ln.text }}</span>
            <span class="cv-char-pct">{{ Math.round((Number(ln.retention) || 0) * 100) }}%</span>
          </div>
          <div class="cv-hint">{{ t('建议换参考音或缩短句子后重新合成这些句；字级明细见 gsv/gsv_lines.json 的 char_align') }}</div>
          <div class="cv-hint">{{ t('手动修正：去调教页改这些句的歌词后再合成 —— 未改动的句子会复用上次结果，只重跑改过的句。') }}</div>
          <button class="btn sm" style="margin-top:6px" data-guide="cover-char-goto-singer" @click="goSinger">{{ t('去改歌词') }}</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.cv-wrap { display: flex; flex-direction: column; gap: var(--sp-4); }
.cv-row { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; margin-top: 8px; }
.cv-label { font-size: var(--fs-sm); color: var(--stone); flex: none; }
.cv-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60ch; }
.cv-seg { display: flex; gap: var(--sp-2); margin-top: 6px; }
.cv-adv { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--hairline); }
.cv-check { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--steel); margin-top: 10px; }
.cv-bar { height: 8px; border-radius: var(--r-sm); background: var(--surface-soft); overflow: hidden; margin-top: 10px; }
.cv-bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--brand-blue, var(--t-info)), var(--t-info)); transition: transform var(--motion-base) var(--ease-out); }
.cv-err { margin-top: 10px; font-size: var(--fs-sm); color: var(--error); white-space: pre-wrap; }
.cv-log { margin-top: 10px; max-height: 220px; overflow: auto; font-size: var(--fs-sm); line-height: 1.6; background: var(--surface-soft); border-radius: var(--r-md); padding: 8px 10px; white-space: pre-wrap; }
.cv-char-warn { margin-top: 10px; padding: 8px 10px; border-radius: var(--r-md); background: var(--surface-soft); border-left: 2px solid var(--warn, var(--t-info)); }
.cv-char-line { margin-top: 4px; font-size: var(--fs-sm); }
.cv-char-pct { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--warn, var(--t-info)); }
.cv-hint { margin-top: 6px; font-size: var(--fs-xs); color: var(--stone); }
</style>
