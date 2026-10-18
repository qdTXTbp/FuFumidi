<script setup>
// 翻唱工作流（一键）：一首歌 → 分离 → 变声 → 混音 → 成品。
// 引擎侧只有一份实现（engine/engine_cover.py），界面只是选参数 + 看进度。
//
// ★ 扒谱与歌词环节已删除：RVC 是「把原唱的人声换成另一个音色」，旋律/节奏/咬字
//   本来就来自原唱，不需要歌词也不需要音符表。
// ★ 音色 = 导入的 RVC 模型（模型管理 → 翻唱模型）。应用不内置、不代下载。
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import { t } from '../core/i18n.js';
import { useAppStore } from '../stores/app';

const app = useAppStore();
const router = useRouter();
const bridge = window.fuBridge;
const isDesktop = !!bridge;

const audio = ref('');
const outdir = ref('');
const name = ref('');
const singers = ref([]);
const singerId = ref('');
const device = ref('auto');
const clarityDb = ref(2.0);
const noResume = ref(false);
/* ---- RVC 参数：常用项 + 高级（默认折叠），全部交给引擎，界面不做任何 DSP ---- */
const transpose = ref(0);
const f0Method = ref('rmvpe');
const indexRate = ref(0.3);
const advOpen = ref(false);
const rmsMixRate = ref(0.25);
const protect = ref(0.33);
const chunkSec = ref(60);
const autoPredictF0 = ref(false);
/* ---- 人声分离：**可选**。'' = 不分离（整曲变声）；选了就用用户指定的那个模型 ---- */
const sepOptions = ref([]);
const selectedSepId = ref('');
/* ★ 不给「中值滤波半径（filter_radius）」旋钮：那是老版 RVC 的参数，当前上游
   pipeline 里已经不存在（0bed2df 的决定）——  upstream 没有的参数就不给旋钮。 */
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

const currentSinger = computed(() => singers.value.find((s) => s.id === singerId.value) || null);
const canRun = computed(() => !!audio.value && !!currentSinger.value && !!currentSinger.value.ready && !!outdir.value && !running.value);

/* ★ 选中项与列表必须始终自洽（这个坑上游踩过一次，别重犯）：
   localStorage 里记住的「上次模型」是在列表拉回来**之后**才恢复的 —— 那个模型要是已经被删了，
   singerId 就指向一个不存在的条目 → 下拉框空白、「开始翻唱」也点不动。
   这里用 watch 兜底：列表或选中项一变，不在列表里就落到第一项。 */
watch(singers, (list) => {
  if (!list.length) { singerId.value = ''; return; }
  if (!list.some((s) => s.id === singerId.value)) singerId.value = list[0].id;
}, { immediate: true });

function toast(m, type) { try { app.toast(m, type || 'info'); } catch (e) {} }

async function load() {
  if (!isDesktop || !bridge.coverSingers) return;
  try {
    const r = await bridge.coverSingers();
    if (r && r.ok) {
      singers.value = r.rvc || [];
      if (singers.value.length && !singers.value.some((s) => s.id === singerId.value)) singerId.value = singers.value[0].id;
    }
  } catch (e) {}
  try {
    // 分离模型是**可选项**：这里只列出「已下载」的，没下载的不出现（不强迫任何人装模型）
    const ml = await bridge.modelList();
    sepOptions.value = (ml || []).filter((m) => m.kind === 'separate' && m.exists)
      .map((m) => ({ id: m.id, name: m.name, ready: m.sepReady !== false }));
    if (selectedSepId.value && !sepOptions.value.some((m) => m.id === selectedSepId.value)) selectedSepId.value = '';
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
    if (saved.singerId) singerId.value = saved.singerId;
    if (saved.selectedSepId != null) selectedSepId.value = String(saved.selectedSepId);
    if (saved.transpose != null) transpose.value = saved.transpose;
    if (saved.f0Method) f0Method.value = saved.f0Method;
    if (saved.indexRate != null) indexRate.value = saved.indexRate;
  } catch (e) {}
}

function saveOpts() {
  try {
    localStorage.setItem('fufumidi_cover_opts', JSON.stringify({
      outdir: outdir.value, device: device.value, clarityDb: clarityDb.value,
      singerId: singerId.value, transpose: transpose.value,
      f0Method: f0Method.value, indexRate: indexRate.value,
      selectedSepId: selectedSepId.value,
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

async function run() {
  if (!canRun.value) return;
  running.value = true; percent.value = 0; stage.value = ''; logs.value = []; result.value = null; error.value = '';
  saveOpts();
  const singer = currentSinger.value;
  const payload = {
    audio: audio.value, outdir: outdir.value, name: name.value || undefined,
    singer: { kind: 'rvc', id: singer.id, path: singer.dir },
    device: device.value, clarityDb: Number(clarityDb.value) || 0,
    noResume: noResume.value,
    vocals: preVocals.value || undefined, instrumental: preInst.value || undefined,
    sepMode: selectedSepId.value ? undefined : 'off',
    sepModel: selectedSepId.value ? { id: selectedSepId.value } : undefined,
    transpose: Number(transpose.value) || 0,
    f0Method: f0Method.value,
    indexRate: Number(indexRate.value),
    rmsMixRate: Number(rmsMixRate.value),
    protect: Number(protect.value),
    chunkSec: Number(chunkSec.value) || 60,
    autoPredictF0: !!autoPredictF0.value,
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

/** 没有模型时给一条能走的路：直接去模型管理的翻唱模型页 */
function gotoModels() {
  try { router.push({ path: '/resources', query: { tab: 'model', m: 'rvc' } }); } catch (e) {}
}

/* ---- 直接导入 RVC 模型：不用跳去模型管理页 ----
   语义与 RvcModelPanel 完全一致（登记引用 / 逐个文件 / zip），导入后刷新本页的音色下拉。 */
const importBusy = ref(false);

async function importRvcFolder() {
  if (importBusy.value) return;
  if (!bridge || !bridge.rvcPickFolder) return toast(t('请使用桌面版 FuFumidi'), 'warn');
  const picked = await bridge.rvcPickFolder();
  if (!picked || picked.canceled) return;
  importBusy.value = true;
  try {
    const r = await bridge.rvcImportFolder(picked.dir, {}).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
    if (r && r.ok) { toast(t('已导入') + '：' + (r.model && r.model.name), 'ok'); await load(); }
    else toast((r && r.error) || t('失败'), 'warn');
  } finally { importBusy.value = false; }
}

async function importRvcFiles() {
  if (importBusy.value) return;
  if (!bridge || !bridge.rvcPickFiles) return toast(t('请使用桌面版 FuFumidi'), 'warn');
  const picked = await bridge.rvcPickFiles();
  if (!picked || picked.canceled || !picked.files) return;
  // 按扩展名归类（与面板同一套规则：认得出的先认，认不出的去卡片上「校正」）
  const files = {};
  for (const pth of picked.files) {
    const low = String(pth).toLowerCase();
    if (low.endsWith('.pth') || low.endsWith('.pt')) files.model = files.model || pth;
    else if (low.endsWith('.index')) files.index = pth;
    else if (low.endsWith('.yaml') || low.endsWith('.yml')) files.config = pth;
  }
  if (!files.model) return toast(t('没认出权重文件（.pth / .pt）'), 'warn');
  importBusy.value = true;
  try {
    const r = await bridge.rvcImportFiles(files, { name: String(files.model).replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') })
      .catch((e) => ({ ok: false, error: String(e && e.message || e) }));
    if (r && r.ok) { toast(t('已导入') + '：' + (r.model && r.model.name), 'ok'); await load(); }
    else toast((r && r.error) || t('失败'), 'warn');
  } finally { importBusy.value = false; }
}

async function importRvcZip() {
  if (importBusy.value) return;
  if (!bridge || !bridge.rvcPickZip) return toast(t('请使用桌面版 FuFumidi'), 'warn');
  const picked = await bridge.rvcPickZip();
  if (!picked || picked.canceled) return;
  importBusy.value = true;
  try {
    const r = await bridge.rvcImportZip(picked.path, {}).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
    if (r && r.ok) { toast(t('已导入') + '：' + (r.model && r.model.name), 'ok'); await load(); }
    else toast((r && r.error) || t('失败'), 'warn');
  } finally { importBusy.value = false; }
}

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
        <div class="page-sub">{{ t('一首歌 → 分离 → 变声 → 混音 → 成品。音色来自你导入的 RVC 模型（应用不内置、不代下载）。') }}</div>
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
        <!-- 人声分离：可选。不选 = 整曲直接变声；选了 = 先分离再只变声人声（需要已下载分离模型） -->
        <div class="cv-row">
          <span class="cv-label">{{ t('人声分离') }}</span>
          <select class="text-input" v-model="selectedSepId" style="max-width:420px" @change="saveOpts">
            <option value="">{{ t('不分离 —— 变声整曲') }}</option>
            <option v-for="m in sepOptions" :key="m.id" :value="m.id">{{ m.name }}<template v-if="m.ready === false">（{{ t('加速未就绪，将用 CPU') }}）</template></option>
          </select>
          <span class="muted small">{{ t('分离模型需要先在「模型管理」里下载；不选就整曲直接变声') }}</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title"><span class="dot"></span>{{ t('② 选音色') }}</div>
        <div class="cv-row">
          <select class="text-input" data-guide="cover-singer" v-model="singerId" style="max-width:420px" @change="saveOpts">
            <option v-for="s in singers" :key="s.id" :value="s.id">{{ s.name }}<template v-if="s.arch"> —— {{ s.arch }}</template><template v-if="s.note"> · {{ s.note }}</template></option>
          </select>
          <span v-if="!singers.length" class="muted small">{{ t('还没有导入 RVC 模型：可直接在这里导入，也可以去「模型管理 → RVC 模型」里管理') }}</span>
        </div>
        <!-- 导入行：常驻，不跟空列表联动 —— 想加第二个模型时不必先删一个 -->
        <div class="cv-row">
          <span class="cv-label">{{ t('导入模型') }}</span>
          <button class="btn sm" :disabled="importBusy" @click="importRvcFolder"><Icon name="folder" :size="13" /> {{ t('选文件夹（登记引用，不复制）') }}</button>
          <button class="btn sm" :disabled="importBusy" @click="importRvcFiles"><Icon name="import" :size="13" /> {{ t('逐个选文件（手填元数据）') }}</button>
          <button class="btn sm" :disabled="importBusy" @click="importRvcZip"><Icon name="box" :size="13" /> {{ t('导入 zip') }}</button>
          <button class="btn sm ghost" @click="gotoModels">{{ t('去模型管理') }}</button>
        </div>
        <div class="cv-row">
          <span class="cv-label">{{ t('变调（半音）') }}</span>
          <input class="text-input cv-num" type="number" v-model.number="transpose" step="1" @change="saveOpts" />
          <span class="cv-label">{{ t('f0 算法') }}</span>
          <select class="text-input" v-model="f0Method" style="max-width:120px" @change="saveOpts">
            <option value="rmvpe">rmvpe</option>
            <option value="pm">pm</option>
            <option value="harvest">harvest</option>
            <option value="crepe">crepe</option>
          </select>
          <span class="cv-label">{{ t('index 检索') }}</span>
          <input class="text-input cv-num" type="number" v-model.number="indexRate" step="0.05" min="0" max="1" @change="saveOpts" />
        </div>
        <div class="cv-adv">
          <button class="btn sm ghost" @click="advOpen = !advOpen">{{ t('高级') }} {{ advOpen ? '▲' : '▼' }}</button>
          <div v-if="advOpen" class="cv-adv-grid">
            <label class="cv-field"><span>{{ t('包络混入') }}</span><input class="text-input cv-num" type="number" v-model.number="rmsMixRate" step="0.05" min="0" max="1" /></label>
            <label class="cv-field"><span>{{ t('清辅音保护') }}</span><input class="text-input cv-num" type="number" v-model.number="protect" step="0.01" min="0" max="0.5" /></label>
            <label class="cv-field"><span>{{ t('分块秒数') }}</span><input class="text-input cv-num" type="number" v-model.number="chunkSec" step="10" min="10" /></label>
            <label class="cv-check"><input type="checkbox" v-model="autoPredictF0" /> {{ t('自动预测 f0') }}</label>
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
        <label class="cv-check"><input type="checkbox" v-model="noResume" /> {{ t('不复用上次的中间结果（分离 / 变声全部重算）') }}</label>
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
            {{ t('音色') }} {{ result.info.singer || '—' }} ·
            {{ t('变调（半音）') }} {{ result.info.transpose }} ·
            {{ t('f0 算法') }} {{ result.info.f0_method }} ·
            {{ t('配平') }} {{ result.info.level_match_db }} dB
          </span>
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
.cv-num { max-width: 92px; }
.cv-adv { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--hairline); }
.cv-adv-grid { display: flex; gap: var(--sp-3); flex-wrap: wrap; margin-top: var(--sp-2); }
.cv-field { display: flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--steel); }
.cv-check { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--steel); margin-top: 10px; }
.cv-bar { height: 8px; border-radius: var(--r-sm); background: var(--surface-soft); overflow: hidden; margin-top: 10px; }
.cv-bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--brand-blue, var(--t-info)), var(--t-info)); transition: transform var(--motion-base) var(--ease-out); }
.cv-err { margin-top: 10px; font-size: var(--fs-sm); color: var(--error); white-space: pre-wrap; }
.cv-log { margin-top: 10px; max-height: 220px; overflow: auto; font-size: var(--fs-sm); line-height: 1.6; background: var(--surface-soft); border-radius: var(--r-md); padding: 8px 10px; white-space: pre-wrap; }
</style>
