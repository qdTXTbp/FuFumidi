<!--
  声库面板 —— 从原「声库」独立页（ViewBanks.vue）并入「调教」页。

  并入原因：声库（做/装/管）与编辑器（选歌手、画音符、渲染）是同一条工作流的两半，
  分成两个顶栏入口会让用户在两个页面之间来回跳。现在它们同页、以页签切换。

  ★ 不透明底：本面板与 .sing 容器都用 --canvas / --surface 实心色。
    动态壁纸开启时 .app-main 是透明的（styles.css 的 .app-shell.wallpaper-on），
    如果这里也用 glass/半透明，密集文字会压在壁纸上看不清 —— 这正是改版前的实测问题。
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import Icon from '../Icon.vue';
import { t } from '../../core/i18n.js';
import { useDiffsingerStore } from '../../stores/diffsinger';
import { useSingerStore } from '../../stores/singer';
import {
  parseOto, formatOto, decodeOtoFile, encodeOtoFile, diffOto, b64ToBytes, bytesToB64, detectEol,
} from '../../core/oto.js';

const ds = useDiffsingerStore();
const singerStore = useSingerStore();

onMounted(() => {
  void singerStore.loadBanks();
  /* 验收桥（与其它页同一套开关）：别名表的读/改/存/试听在 CDP 里要能直接驱动 */
  if (localStorage.getItem('fufumidi_debug') === '1') {
    (window as any).__vbPanelDebug = {
      oto, otoQuery, otoShown, audition, auditionPitch,
      openOto, saveOto, restoreOto, closeOto, addOtoRow, removeOtoRow, markDirty,
      auditionAlias, auditionBatch, stopAudition, playBytes,
      parseOto, formatOto, decodeOtoFile, encodeOtoFile, diffOto, b64ToBytes, bytesToB64,
    };
  }
});

const busy = ref(false);
const msg = ref('');
/* 注：UTAU 声库制作已是调教页的独立页签（编辑器 / 声库 / 声库制作），
   面板里不再重复一块「制作」区域 —— 用户明确要求去掉。 */

/* ---- 声库体检（P2-16）：装库时就把「能不能用」算清楚，别等渲染失败 ---- */
type ProbeCheck = { id: string; level: 'ok' | 'warn' | 'error'; text: string; fix?: string };
const probe = ref<{ dir: string; name: string; busy: boolean; error: string; checks: ProbeCheck[]; stats: any } | null>(null);

/** 拿当前工程里正在用的歌词一起查覆盖（有轨在用这个库时才传） */
function lyricsFor(dir: string): string[] {
  const out: string[] = [];
  for (const tk of singerStore.tracks || []) {
    if (tk.kind !== 'voice' || tk.singer !== dir) continue;
    for (const n of tk.notes || []) if (n.lyric) out.push(String(n.lyric));
  }
  return out;
}

async function runProbe(b: any) {
  const bridge = (window as any).fuBridge;
  if (!bridge || typeof bridge.probeVoicebank !== 'function') {
    msg.value = t('当前环境不支持声库体检（请使用桌面版）');
    return;
  }
  probe.value = { dir: b.dir, name: b.name, busy: true, error: '', checks: [], stats: null };
  try {
    const r = await bridge.probeVoicebank({ voicebank: b.dir, engine: b.engine, lyrics: lyricsFor(b.dir) });
    if (!r || !r.ok) {
      if (probe.value) { probe.value.busy = false; probe.value.error = (r && r.error) || t('体检失败'); }
      return;
    }
    if (probe.value) {
      probe.value.busy = false;
      probe.value.checks = r.checks || [];
      probe.value.stats = r.stats || null;
    }
  } catch (e: any) {
    if (probe.value) { probe.value.busy = false; probe.value.error = String((e && e.message) || e); }
  }
}

/** 声库列表只有**一个**来源（singer store 的 `banks`），不按引擎分区。 */
const filter = ref<'all' | 'utau' | 'diffsinger'>('all');
const allBanks = computed(() => singerStore.banks);
const shown = computed(() =>
  filter.value === 'all' ? allBanks.value : allBanks.value.filter(b => b.engine === filter.value));
/** 某个目录被哪些轨道用着（避免误删正在用的声库） */
const usedIn = (dir: string) => singerStore.bankInUse(dir);

async function refresh() { await singerStore.loadBanks(); }

async function run(fn: () => Promise<any>) {
  busy.value = true;
  msg.value = '';
  try { msg.value = (await fn()) || ''; }
  catch (e) { msg.value = String((e && (e as any).message) || e); }
  finally { busy.value = false; }
}

/* ============================================================
   M8f 声库管理 2.0：别名表可编辑 + 试听
   ------------------------------------------------------------
   §0.2⑤ 列的两条："声库不能试听、别名表不可编辑"。
   读/判码/解析/写回全在渲染进程做（core/oto.js + core/shift_jis.js），
   主进程只负责把字节读出来 / 写回去并备份 —— 于是"编辑一个别名"不会把整库的编码换掉。
   ============================================================ */

type OtoState = {
  dir: string; name: string; busy: boolean; error: string;
  encoding: 'utf8' | 'sjis'; eol: '\r\n' | '\n'; entries: any[]; passthrough: string[]; loose: string[];
  original: any; dirty: boolean; stat: { changed: number; added: number; removed: number } | null;
};
const oto = ref<OtoState | null>(null);
const otoQuery = ref('');
const auditionPitch = ref(60);
const audition = ref<{ alias: string; busy: boolean; info: string } | null>(null);
const batchOn = ref(false);
let batchStop = false;
let audioEl: HTMLAudioElement | null = null;
let audioUrl = '';

const otoShown = computed(() => {
  const list = (oto.value && oto.value.entries) || [];
  const q = otoQuery.value.trim().toLowerCase();
  if (!q) return list;
  return list.filter((e: any) =>
    String(e.alias).toLowerCase().includes(q) || String(e.file).toLowerCase().includes(q));
});

function stopAudio() {
  if (audioEl) { try { audioEl.pause(); } catch (e) { /* 已结束 */ } }
  if (audioUrl) { try { URL.revokeObjectURL(audioUrl); } catch (e) { /* 已释放 */ } }
  audioUrl = '';
}

function playBytes(bytes: Uint8Array): Promise<void> {
  stopAudio();
  return new Promise((resolve) => {
    audioUrl = URL.createObjectURL(new Blob([bytes as any], { type: 'audio/wav' }));
    const a = new Audio(audioUrl);
    audioEl = a;
    a.onended = () => resolve();
    a.onerror = () => resolve();
    a.play().catch(() => resolve());
  });
}

async function openOto(b: any) {
  const bridge = (window as any).fuBridge;
  if (!bridge || typeof bridge.utauReadOto !== 'function') {
    msg.value = t('当前环境不支持读取 oto.ini（请使用桌面版）');
    return;
  }
  stopAudio();
  oto.value = {
    dir: b.dir, name: b.name, busy: true, error: '', encoding: 'sjis', eol: '\n',
    entries: [], passthrough: [], loose: [], original: null, dirty: false, stat: null,
  };
  try {
    const r = await bridge.utauReadOto({ voicebank: b.dir });
    if (!r || !r.ok) {
      if (oto.value) { oto.value.busy = false; oto.value.error = (r && r.error) || t('读取失败'); }
      return;
    }
    const dec = decodeOtoFile(b64ToBytes(r.base64 || ''));
    const parsed = parseOto(dec.text);
    if (oto.value) {
      oto.value.busy = false;
      oto.value.encoding = dec.encoding;
      oto.value.eol = detectEol(dec.text);      // 写回时按原样：只改数字，不把整个文件的换行符换掉
      oto.value.entries = parsed.entries;
      oto.value.passthrough = parsed.passthrough;
      oto.value.loose = parsed.loose;
      oto.value.original = parseOto(dec.text);
    }
  } catch (e: any) {
    if (oto.value) { oto.value.busy = false; oto.value.error = String((e && e.message) || e); }
  }
}

function markDirty() {
  const cur = oto.value;
  if (!cur) return;
  cur.dirty = true;
  cur.stat = diffOto(cur.original, { entries: cur.entries });
}

function restoreOto() {
  const cur = oto.value;
  if (!cur || !cur.original) return;
  cur.entries = JSON.parse(JSON.stringify(cur.original.entries || []));
  cur.dirty = false;
  cur.stat = null;
  cur.error = '';
}

function addOtoRow() {
  const cur = oto.value;
  if (!cur) return;
  cur.entries.unshift({ file: '', alias: '', offset: 0, consonant: 0, blank: 0, preutterance: 0, overlap: 0, extra: [] });
  markDirty();
}

function removeOtoRow(e: any) {
  const cur = oto.value;
  if (!cur) return;
  const i = cur.entries.indexOf(e);
  if (i >= 0) cur.entries.splice(i, 1);
  markDirty();
}

async function saveOto() {
  const cur = oto.value;
  if (!cur) return;
  const bridge = (window as any).fuBridge;
  if (!bridge || typeof bridge.utauSaveOto !== 'function') {
    msg.value = t('当前环境不支持写回 oto.ini（请使用桌面版）');
    return;
  }
  const text = formatOto({ entries: cur.entries, passthrough: cur.passthrough, loose: cur.loose }, cur.eol);
  const bytes = encodeOtoFile(text, cur.encoding);
  cur.busy = true;
  cur.error = '';
  try {
    const r = await bridge.utauSaveOto({ voicebank: cur.dir, base64: bytesToB64(bytes) });
    if (!r || !r.ok) { cur.error = (r && r.error) || t('保存失败'); return; }
    cur.dirty = false;
    cur.stat = null;
    msg.value = t('已保存 oto.ini（原文件已备份为 oto.ini.bak）');
    await singerStore.loadBanks();
  } catch (e: any) {
    cur.error = String((e && e.message) || e);
  } finally {
    cur.busy = false;
  }
}

function closeOto() {
  batchStop = true;
  batchOn.value = false;
  stopAudio();
  oto.value = null;
}

/** 试听一个别名：走真实引擎渲染一个长音（改完 oto 再听，差别是听得出来的） */
async function auditionAlias(alias: string) {
  const cur = oto.value;
  const bridge = (window as any).fuBridge;
  if (!cur || !bridge || typeof bridge.utauRenderTrack !== 'function') return;
  audition.value = { alias, busy: true, info: '' };
  try {
    const r = await bridge.utauRenderTrack({
      voicebank: cur.dir,
      notes: [{ startBeat: 0, durBeat: 2, pitch: auditionPitch.value, lyric: alias }],
      sampleNote: 'C4',
      bpm: 120,
    });
    if (!r || !r.ok) {
      audition.value = { alias, busy: false, info: (r && r.error) || t('试听失败') };
      return;
    }
    const bytes = r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes || []);
    audition.value = {
      alias, busy: false,
      info: t('已渲染 ') + bytes.length + t(' 字节 · ') + Math.round(r.duration_ms || 0) + ' ms',
    };
    await playBytes(bytes);
  } catch (e: any) {
    audition.value = { alias, busy: false, info: String((e && e.message) || e) };
  }
}

/** 连播前 N 个（按当前筛选），装库后快速过一遍听感 */
async function auditionBatch(n = 8) {
  const list = otoShown.value.slice(0, n);
  if (!list.length) return;
  batchStop = false;
  batchOn.value = true;
  try {
    for (const e of list) {
      if (batchStop) break;
      await auditionAlias(e.alias);
    }
  } finally {
    batchOn.value = false;
  }
}

function stopAudition() {
  batchStop = true;
  batchOn.value = false;
  stopAudio();
}
</script>

<template>
  <div class="vbp-page">
    <div class="vbp-head">
      <Icon name="box" :size="15" />
      <b>{{ t('声库管理') }}</b>
      <span class="muted small">{{ t('UTAU 与 DiffSinger 的声库都在这里；类型只作标签，不分区') }}</span>
      <span class="sp" />
      <button class="btn" :disabled="busy" @click="run(refresh)">
        <Icon name="refresh" :size="12" /> {{ t('刷新') }}
      </button>
    </div>

    <Transition name="fade">
      <p v-if="msg" class="vbp-msg small">{{ msg }}</p>
    </Transition>

    <!-- ============ 已装声库：一份混排列表 ============ -->
    <section class="vbp-card vbp-card-in" style="--i: 0" data-guide="banks-installed">
      <div class="vbp-title">
        <Icon name="mic" :size="13" /> {{ t('已装声库') }}
        <span class="sp" />
        <span class="seg">
          <button :class="{ on: filter === 'all' }" @click="filter = 'all'">{{ t('全部') }} ({{ allBanks.length }})</button>
          <button :class="{ on: filter === 'utau' }" @click="filter = 'utau'">
            UTAU ({{ allBanks.filter(b => b.engine === 'utau').length }})
          </button>
          <button :class="{ on: filter === 'diffsinger' }" @click="filter = 'diffsinger'">
            DiffSinger ({{ allBanks.filter(b => b.engine === 'diffsinger').length }})
          </button>
        </span>
      </div>

      <p v-if="!shown.length" class="muted small">{{ t('还没有声库。') }}</p>
      <ul v-else class="vbp-list">
        <li v-for="(b, i) in shown" :key="b.engine + b.dir" class="vbp-row" :style="{ '--i': i }">
          <span class="tag" :class="'e-' + b.engine">{{ b.engine === 'utau' ? 'UTAU' : 'DS' }}</span>
          <span class="nm">{{ b.name }}</span>
          <span class="dir muted small" :title="b.dir">{{ b.dir }}</span>
          <span v-if="usedIn(b.dir)" class="inuse">{{ t('使用中') }}</span>
          <button class="btn" :disabled="probe && probe.busy"
                  :title="t('体检：目录/编码/别名/缺采样/歌词覆盖一次算清')"
                  @click="runProbe(b)"><Icon name="target" :size="12" /> {{ t('体检') }}</button>
          <button v-if="b.engine === 'utau'" class="btn"
                  :title="t('打开别名表：改原音设定 / 逐条试听（写回前自动备份 oto.ini.bak）')"
                  @click="openOto(b)"><Icon name="edit" :size="12" /> {{ t('别名表') }}</button>
          <button v-if="b.engine === 'diffsinger'" class="btn danger"
                  :disabled="busy || usedIn(b.dir)"
                  @click="run(() => ds.deleteVoicebank(b.dir))"><Icon name="trash" :size="12" /> {{ t('删除') }}</button>
          <span v-else class="muted small">{{ t('在 UTAU 声库管理器里删除') }}</span>
        </li>
      </ul>

      <!-- 体检结果：一行一条，error 红、warn 黄，附可执行建议 -->
      <Transition name="vbp-drop">
      <div v-if="probe" class="vbp-probe">
        <div class="vbp-probe-head">
          <b>{{ t('体检：') }}{{ probe.name }}</b>
          <span v-if="probe.busy" class="muted small">{{ t('检查中…') }}</span>
          <span class="sp" />
          <button class="btn" @click="probe = null"><Icon name="close" :size="12" /> {{ t('关闭') }}</button>
        </div>
        <p v-if="probe.error" class="edt-msg small bad">{{ probe.error }}</p>
        <ul class="vbp-checks">
          <li v-for="(c, i) in probe.checks" :key="c.id" :class="c.level" class="vbp-check" :style="{ '--i': i }">
            <i>{{ c.level === 'ok' ? '✓' : (c.level === 'warn' ? '!' : '×') }}</i>
            <span class="txt">{{ c.text }}</span>
            <span v-if="c.fix" class="fix muted small">{{ c.fix }}</span>
          </li>
        </ul>
        <p v-if="probe.stats" class="muted small">
          {{ t('统计：') }}{{ JSON.stringify(probe.stats) }}
        </p>
      </div>
      </Transition>

      <!-- ============ M8f 别名表：可编辑 + 逐条试听 ============ -->
      <Transition name="vbp-drop">
      <div v-if="oto" class="vbp-probe" data-guide="banks-oto">
        <div class="vbp-probe-head">
          <b>{{ t('别名表：') }}{{ oto.name }}</b>
          <span class="tag" :title="t('写回时保持原编码与行尾')">{{ oto.encoding === 'utf8' ? 'UTF-8' : 'Shift-JIS' }} · {{ oto.eol === '\r\n' ? 'CRLF' : 'LF' }}</span>
          <span class="muted small">{{ oto.entries.length }}{{ t(' 条原音设定') }}</span>
          <span v-if="oto.dirty" class="dirty">
            {{ t('未保存') }}<template v-if="oto.stat">（{{ t('改 ') }}{{ oto.stat.changed }}/{{ t('增 ') }}{{ oto.stat.added }}/{{ t('删 ') }}{{ oto.stat.removed }}）</template>
          </span>
          <span class="sp" />
          <label class="muted small vbp-pitch" :title="t('试听用的音高（MIDI 音符号，60 = C4）')">
            {{ t('试听音高') }}
            <input type="number" class="text-input oto-num" v-model.number="auditionPitch" min="12" max="108" />
          </label>
          <button class="btn" :disabled="!otoShown.length || batchOn" @click="auditionBatch(8)">
            <Icon name="play2" :size="12" /> {{ t('连播前 8 个') }}
          </button>
          <button v-if="batchOn" class="btn danger" @click="stopAudition">
            <Icon name="stop" :size="12" /> {{ t('停止') }}
          </button>
          <button class="btn" :disabled="oto.busy || !oto.dirty" @click="restoreOto">
            <Icon name="refresh" :size="12" /> {{ t('还原') }}
          </button>
          <button class="btn primary" :disabled="oto.busy || !oto.dirty" @click="saveOto">
            <Icon name="save" :size="12" /> {{ t('保存 oto.ini') }}
          </button>
          <button class="btn" @click="closeOto"><Icon name="close" :size="12" /> {{ t('关闭') }}</button>
        </div>
        <p v-if="oto.error" class="edt-msg small bad">{{ oto.error }}</p>
        <p v-if="audition" class="muted small vbp-audition">
          {{ t('试听：') }}{{ audition.alias }} — {{ audition.busy ? t('正在渲染…') : audition.info }}
        </p>
        <div class="vbp-oto-tools">
          <input class="text-input vbp-oto-search" :placeholder="t('搜索别名 / 文件名')" v-model="otoQuery" />
          <span class="muted small">{{ otoShown.length }} / {{ oto.entries.length }}</span>
          <button class="btn sm" @click="addOtoRow"><Icon name="plus" :size="12" /> {{ t('加一条') }}</button>
          <span class="muted small">{{ t('改完点「保存 oto.ini」；引擎读的是磁盘上的文件，改完再试听就是新的。') }}</span>
        </div>
        <div class="vbp-oto-wrap">
          <table class="vbp-oto">
            <thead>
              <tr>
                <th>{{ t('别名') }}</th>
                <th>offset</th><th>consonant</th><th>blank</th><th>preutterance</th><th>overlap</th>
                <th>{{ t('文件') }}</th><th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in otoShown" :key="e.file + '|' + e.alias">
                <td><input class="text-input oto-alias" v-model="e.alias" @change="markDirty" /></td>
                <td><input type="number" class="text-input oto-num" v-model.number="e.offset" step="0.5" @change="markDirty" /></td>
                <td><input type="number" class="text-input oto-num" v-model.number="e.consonant" step="0.5" @change="markDirty" /></td>
                <td><input type="number" class="text-input oto-num" v-model.number="e.blank" step="0.5" @change="markDirty" /></td>
                <td><input type="number" class="text-input oto-num" v-model.number="e.preutterance" step="0.5" @change="markDirty" /></td>
                <td><input type="number" class="text-input oto-num" v-model.number="e.overlap" step="0.5" @change="markDirty" /></td>
                <td class="muted small oto-file" :title="e.file">{{ e.file }}</td>
                <td>
                  <!-- ★ 必须套一层 inline-flex：.icon-btn 是 display:grid，直接放 td 里会竖排（上一轮的坑） -->
                  <span class="vb-tools">
                    <button class="icon-btn" :title="t('试听这个别名')" @click="auditionAlias(e.alias)"><Icon name="play2" :size="12" /></button>
                    <button class="icon-btn" :title="t('删除这一条')" @click="removeOtoRow(e)"><Icon name="trash" :size="12" /></button>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="oto.loose.length" class="muted small">
          {{ t('有 ') }}{{ oto.loose.length }}{{ t(' 行不是标准 oto 格式，保存时会原样写回。') }}
        </p>
      </div>
      </Transition>
    </section>


    <!-- ============ DiffSinger 推理组件 ============ -->
    <section class="vbp-card vbp-card-in" style="--i: 1" data-guide="banks-ds">
      <div class="vbp-title">
        <Icon name="gear" :size="13" /> {{ t('DiffSinger 推理组件') }}
        <span class="sp" />
        <button class="btn" :class="{ primary: !ds.enabled }" :disabled="busy"
                @click="run(() => ds.setEnabled(!ds.enabled))">
          <Icon :name="ds.enabled ? 'minus' : 'zap'" :size="12" /> {{ ds.enabled ? t('停用模块') : t('启用模块') }}
        </button>
      </div>
      <p class="muted small">{{ t('停用会保留已下载的组件；未启用时零占用。') }}</p>

      <div v-if="ds.enabled" class="vbp-grid">
        <div class="vbp-st" :class="{ ok: ds.depsOk }">
          <b>{{ t('Python 组件') }}</b>
          <p v-if="ds.depsOk" class="muted small">
            {{ t('就绪：') }}{{ ds.depsMissing.length === 0 ? 'onnxruntime / pyyaml' : '' }}
          </p>
          <p v-else class="muted small">{{ ds.depsError || (t('缺失：') + ds.depsMissing.join(', ')) }}</p>
          <button v-if="!ds.depsOk" class="btn" :disabled="busy" @click="run(() => ds.installRuntime())">
            <Icon name="download" :size="12" /> {{ t('安装') }}
          </button>
        </div>
        <div class="vbp-st" :class="{ ok: ds.vocoderInstalled }">
          <b>{{ t('声码器') }}</b>
          <p class="muted small">
            {{ ds.vocoderInstalled ? t('已安装（NSF-HiFiGAN）') : t('未安装（约 55 MB，下载后本地推理）') }}
          </p>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* ★ 实心底：壁纸开启时 .app-main 透明，这里必须自己铺不透明底，否则文字压在壁纸上 */
.vbp-page { height: 100%; overflow: auto; background: var(--canvas); padding: 12px 16px 18px; }
.vbp-head { display: flex; align-items: center; gap: 10px; padding-bottom: 10px;
            border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.vbp-head b { font-size: 14px; }
.vbp-msg { margin: 8px 0 0; color: var(--brand-text); }
.vbp-card { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px;
            margin-top: 12px; background: var(--surface); }
.vbp-title { display: flex; align-items: center; gap: 7px; font-size: 12.5px; margin-bottom: 8px; }
.vbp-title .sp { flex: 1; }
.vbp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.vbp-st { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--canvas); }
.vbp-st.ok { border-color: rgba(80, 190, 120, .5); }
.vbp-st b { font-size: 12px; }
.vbp-list { list-style: none; margin: 0; padding: 0; }
.vbp-list li { display: flex; align-items: center; gap: 8px; padding: 5px 0;
               border-bottom: 1px solid var(--border); }
.vbp-list li:last-child { border-bottom: none; }
.vbp-probe { margin-top: 10px; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--canvas); }
.vbp-probe-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.vbp-probe-head .sp { flex: 1; }
.vbp-checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.vbp-checks li { display: flex; align-items: baseline; gap: 6px; font-size: 12px; }
.vbp-checks li i { font-style: normal; width: 12px; text-align: center; }
.vbp-checks li.ok i { color: var(--success-text, #4caf50); }
.vbp-checks li.warn i { color: var(--warn-text, #d9a300); }
.vbp-checks li.error i { color: var(--danger-text, #e05252); }
.vbp-checks li .txt { flex: 0 1 auto; }
.vbp-checks li .fix { flex: 1 1 180px; }
.vbp-list .nm { font-size: 12.5px; flex: none; }
.vbp-list .dir { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seg { display: inline-flex; gap: 4px; }
.seg button { font-size: 11px; padding: 2px 9px; border-radius: 9px; cursor: pointer;
              border: 1px solid var(--border); background: var(--canvas); color: inherit; }
.seg button.on { border-color: var(--brand); background: var(--brand-soft); color: var(--brand-text); }
.vbp-list .tag { font-size: 10px; padding: 1px 5px; border-radius: 4px;
                 border: 1px solid var(--border); flex: none; }

/* ---------------- 动效：跟全局一套（0.2~0.34s + cubic-bezier(.2,.7,.3,1)） ----------------
   ★ 这一页原来一个过渡都没有：切到「声库」页签是整页硬切，列表、体检结果都是「啪」地出现。 */
/* 两块卡片：入页时错位滑入 */
.vbp-card-in { animation: vbpCardIn .3s cubic-bezier(.2, .7, .3, 1) both;
               animation-delay: calc(var(--i, 0) * 60ms); }
@keyframes vbpCardIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
/* 声库行：逐行入场 + 悬停高亮（行多时延迟封顶，不然最后一行要等一秒） */
.vbp-row { animation: vbpRowIn .28s cubic-bezier(.2, .7, .3, 1) both;
           animation-delay: calc(min(var(--i, 0), 12) * 26ms);
           border-radius: 6px; transition: background .18s ease, transform .18s ease; }
.vbp-row:hover { background: color-mix(in srgb, var(--brand-soft) 60%, transparent); transform: translateX(2px); }
@keyframes vbpRowIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
/* 体检面板：高度 + 透明度一起过渡（max-height 给足余量，内容多了也不会被裁） */
.vbp-drop-enter-active, .vbp-drop-leave-active {
  transition: opacity .24s cubic-bezier(.2,.7,.3,1), transform .24s cubic-bezier(.2,.7,.3,1), max-height .3s cubic-bezier(.2,.7,.3,1);
  overflow: hidden; max-height: 1200px; }
.vbp-drop-enter-from, .vbp-drop-leave-to { opacity: 0; transform: translateY(-6px); max-height: 0; }
/* 体检结果逐条入场 */
.vbp-check { animation: vbpCheckIn .24s cubic-bezier(.2, .7, .3, 1) both;
             animation-delay: calc(min(var(--i, 0), 16) * 22ms); }
@keyframes vbpCheckIn { from { opacity: 0; transform: translateX(-4px); } to { opacity: 1; transform: none; } }
/* 分段筛选 / 卡片状态：状态变化平滑过渡，不要瞬间跳色 */
.seg button { transition: border-color .18s ease, background .18s ease, color .18s ease; }
.vbp-st { transition: border-color .28s cubic-bezier(.2,.7,.3,1), background .28s ease; }
.tag.e-utau { background: rgba(80, 190, 120, .18); }
.tag.e-diffsinger { background: rgba(64, 140, 255, .18); }
.vbp-list .inuse { font-size: 10.5px; color: var(--brand-text); flex: none; }

/* ---- M8f 别名表 ---- */
.vbp-oto-tools { display: flex; align-items: center; gap: 8px; margin: 6px 0; flex-wrap: wrap; }
.vbp-oto-search { width: 200px; }
.vbp-oto-wrap { max-height: 46vh; overflow: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
.vbp-oto { width: 100%; border-collapse: collapse; font-size: 12px; }
.vbp-oto th { position: sticky; top: 0; z-index: 1; background: var(--surface-muted);
              border-bottom: 1px solid var(--border); padding: 4px 6px; text-align: left;
              white-space: nowrap; font-weight: 600; }
.vbp-oto td { border-bottom: 1px solid var(--border); padding: 2px 6px; }
.vbp-oto tr:hover td { background: color-mix(in srgb, var(--brand-soft) 45%, transparent); }
.vbp-oto .oto-num { width: 62px; padding: 2px 4px; font-size: 12px; }
.vbp-oto .oto-alias { width: 92px; padding: 2px 4px; font-size: 12px; }
.vbp-oto .oto-file { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vbp-oto .vb-tools { display: inline-flex; gap: 2px; }
.vbp-pitch { display: inline-flex; align-items: center; gap: 5px; }
.vbp-pitch .oto-num { width: 54px; padding: 2px 4px; font-size: 12px; }
.vbp-audition { margin: 4px 0; }
.vbp-probe .dirty { font-size: 11.5px; color: var(--warn-text, #d9a300); }
.vbp-probe .tag { font-size: 10px; padding: 1px 5px; border-radius: 4px; border: 1px solid var(--border); }
</style>
