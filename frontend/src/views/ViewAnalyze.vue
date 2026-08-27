<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Icon from '../components/Icon.vue';
import { useAppStore } from '../stores/app';
import { analyzeSong, barChart, hBarChart, DUR_LABELS } from '../core/analysis.js';

const app = useAppStore();
const currentSong = computed(() => app.currentSong);
const setView = (v) => app.setView(v);
const toast = (m, t) => app.toast(m, t);
import { TRACK_COLORS, KEY_NAME, noteName, fmtTime } from '../core/util.js';
import { getPlayer } from '../audio.js';
import { t } from '../core/i18n.js';

const densityZoom = ref(1);
const data = ref(null);
let resizeHandler = null;

function cssVar(name, fb) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fb;
  } catch (e) { return fb; }
}

function collect() {
  const song = currentSong.value && currentSong.value.song;
  data.value = song ? analyzeSong(song) : null;
}

function draw() {
  const a = data.value;
  if (!a) return;
  const song = currentSong.value.song;

  // 音高分布
  barChart(byId('azPitch'), a.pitch, {
    hotAt: i => i === 0,
    labels: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'],
  });
  // 力度分布
  barChart(byId('azVel'), a.vel);
  // 时值分布
  barChart(byId('azDur'), a.dur, { labels: DUR_LABELS });
  // 音轨概览
  hBarChart(byId('azTracks'), song.tracks.map((tr, i) => ({
    label: tr.name, val: tr.notes.length, color: TRACK_COLORS[i % TRACK_COLORS.length],
  })));
  // 小节密度（可缩放）
  const sigN = a.sig.num || 4, barTicks = song.tpb * sigN;
  const fullBars = Math.max(1, Math.ceil(song.totalTicks / barTicks));
  const bars = Math.max(1, Math.ceil(fullBars / densityZoom.value));
  const dens = new Array(bars).fill(0);
  for (const tr of song.tracks) for (const n of tr.notes) {
    const bi = Math.floor(n.start / barTicks);
    if (bi < bars) dens[bi]++;
  }
  barChart(byId('azDensity'), dens, {
    max: Math.max(1, ...dens),
    labels: [1, Math.ceil(bars / 4), Math.ceil(bars / 2), Math.ceil(bars * 3 / 4), bars].map(x => String(Math.min(bars, Math.max(1, x)))),
  });

  // 音频 / MIDI 对齐对比
  const cvCmp = byId('azCompare');
  if (cvCmp && cvCmp.clientWidth) {
    const dpr = window.devicePixelRatio || 1;
    const w = cvCmp.clientWidth, h = cvCmp.clientHeight || 140;
    const W = Math.floor(w * dpr), H = Math.floor(h * dpr);
    if (cvCmp.width !== W || cvCmp.height !== H) { cvCmp.width = W; cvCmp.height = H; }
    const ctx = cvCmp.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const total = song.totalSec || 1;
    ctx.fillStyle = cssVar('--surface-soft', 'rgba(10,10,10,0.03)'); ctx.fillRect(0, 0, w, h);
    const audio = song.audio;
    if (audio && audio.peaks && audio.peaks.length) {
      ctx.fillStyle = 'rgba(20,86,240,0.28)';
      const step = audio.peaks.length / w;
      for (let x = 0; x < w; x++) {
        const idx = Math.floor(x * step); const v = (audio.peaks[idx] || 0);
        const bh = Math.max(1, v * (h / 2 - 6));
        ctx.fillRect(x, h / 2 - bh, 1, bh * 2);
      }
    }
    ctx.fillStyle = 'rgba(255,85,48,0.85)';
    for (const tr of song.tracks) for (const n of tr.notes) {
      const x = Math.round(song.baseSec(n.start) / total * w);
      ctx.fillRect(x, 4, 1, h - 8);
    }
    ctx.fillStyle = cssVar('--slate', 'rgba(10,10,10,0.55)'); ctx.font = '10px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(t('蓝：音频波形 · 橙：MIDI 起音'), 4, 2);
  }

  // 力度动态曲线
  const velCv = byId('azVelCurve');
  if (velCv && velCv.clientWidth) {
    const dpr = window.devicePixelRatio || 1;
    const w = velCv.clientWidth, h = velCv.clientHeight || 120;
    const W = Math.floor(w * dpr), H = Math.floor(h * dpr);
    if (velCv.width !== W || velCv.height !== H) { velCv.width = W; velCv.height = H; }
    const ctx = velCv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = cssVar('--surface-soft', 'rgba(10,10,10,0.03)'); ctx.fillRect(0, 0, w, h);
    const seg = a.velCurve.length;
    ctx.strokeStyle = 'rgba(20,86,240,0.85)'; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let i = 0; i < seg; i++) {
      const v = a.velCurve[i];
      const x = i / (seg - 1) * w, y = h - 4 - (h - 12) * v;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function byId(id) { return document.getElementById(id); }

function summaryText() {
  const a = data.value;
  if (!a) return '';
  let txt = t('整体概况：') + a.key + ' · ' + a.all + t(' 个音符 · 音域 ') + (a.all ? noteName(a.lo) + ' – ' + noteName(a.hi) : '—') + t(' · 平均密度 ') + a.avg.toFixed(1) + t(' 音符/秒');
  if (a.avg > 8) txt += t('。该曲音符较密集，快速段落可能有较高演奏难度');
  else if (a.avg < 2) txt += t('。该曲节奏较舒缓，整体律动平稳');
  else txt += t('。整体密度适中，节奏律动较为均衡');
  return txt + '。';
}

function chordChips() {
  const a = data.value;
  if (!a || !a.chords.length) return [];
  const sigN = a.sig.num || 4;
  const DEGREE = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ'];
  const SCALE = [0, 2, 4, 5, 7, 9, 11];
  return a.chords.map(c => {
    const cr = KEY_NAME.indexOf(c.name.replace(/m$/, ''));
    const idx = SCALE.indexOf(((cr - a.rootPc) + 12) % 12);
    return {
      deg: idx >= 0 ? DEGREE[idx] : '♯',
      name: c.name,
      count: c.count,
      bars: c.bars.slice(0, 12).join(','),
      first: c.bars[0],
    };
  });
}

function jumpToBar(bar) {
  const song = currentSong.value && currentSong.value.song;
  if (!song) return;
  setView('edit');
  const bt = song.tpb * ((song.sigMap[0] && song.sigMap[0].num) || 4);
  const player = getPlayer();
  if (player && player.song) player.seekTick((bar - 1) * bt);
  toast(t('已跳转到第 ') + bar + t(' 小节'), 'ok');
}

const cards = [
  ['key', t('调性'), t('智能估计')],
  ['bpm', t('速度'), t('BPM（起始）')],
  ['sig', t('拍号'), t('拍')],
  ['notes', t('音符总数'), t('全部音轨合计')],
  ['range', t('音域'), t('MIDI 音号')],
  ['poly', t('最大复音'), t('同时发声峰值')],
  ['density', t('音符密度'), t('音符 / 秒')],
  ['tracks', t('音轨数'), t('含鼓组')],
  ['dur', t('时长'), t('秒')],
];

function cardValue(a, k) {
  if (!a) return '—';
  switch (k) {
    case 'key': return a.key;
    case 'bpm': return String(currentSong.value.song.initialBpm);
    case 'sig': return (a.sig ? a.sig.num + '/' + a.sig.den : '4/4');
    case 'notes': return String(a.all);
    case 'range': return a.all ? noteName(a.lo) + ' – ' + noteName(a.hi) : '—';
    case 'poly': return String(a.maxP);
    case 'density': return a.avg.toFixed(1);
    case 'tracks': return String(currentSong.value.song.tracks.length) + (a.drums ? t('（含 ') + a.drums + t(' 鼓组）') : '');
    case 'dur': return fmtTime(currentSong.value.song.totalSec);
    default: return '—';
  }
}

watch([currentSong], () => { collect(); nextTick(draw); });
watch(densityZoom, () => { if (data.value) nextTick(draw); });

onMounted(() => {
  collect();
  nextTick(draw);
  resizeHandler = () => { if (data.value) draw(); };
  window.addEventListener('resize', resizeHandler);
});
onBeforeUnmount(() => {
  if (resizeHandler) window.removeEventListener('resize', resizeHandler);
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-ic"><Icon name="chart" :size="20" /></div>
      <div class="grow">
        <div class="page-title">{{ t('分析') }}</div>
        <div class="page-sub">{{ t('调性 · 音高 / 力度 / 时值分布 · 音符密度 · 错音检测') }}</div>
      </div>
    </div>

    <div v-if="!currentSong" class="empty card">
      <div class="empty-ic"><Icon name="chart" :size="34" /></div>
      <b>{{ t('还没有载入曲目') }}</b>
      <p>{{ t('导入 MIDI 文件后即可在此查看音符密度、音域、调性与各类分布统计。') }}</p>
    </div>

    <template v-else-if="data">
      <div class="az-summary card">{{ summaryText() }}</div>

      <div class="stat-grid">
        <div class="stat-card" v-for="([k, label, sub], i) in cards" :key="k">
          <div class="sc-label">{{ label }}</div>
          <div class="sc-value" :class="{ alt: i % 2 }">{{ cardValue(data, k) }}</div>
          <div class="sc-sub">{{ sub }}</div>
        </div>
      </div>

      <div class="az-card card">
        <h4><Icon name="music" :size="14" /> {{ t('最常用和弦（按小节统计）') }}</h4>
        <div class="chord-chips">
          <button class="chip" v-for="c in chordChips()" :key="c.name" :title="t('点击跳转到编辑视图') + c.first + t(' 小节')"
                  @click="jumpToBar(c.first)">
            {{ c.deg }} {{ c.name }} <b>{{ c.count }}</b>
            <span>{{ c.bars }}</span>
          </button>
          <span v-if="!chordChips().length" class="muted small">{{ t('未检测到明显和弦进行') }}</span>
        </div>
      </div>

      <div class="az-row">
        <div class="az-card card"><h4><Icon name="chart" :size="14" /> {{ t('音高分布（MIDI 音号）') }}</h4><div class="chart-wrap"><canvas id="azPitch"></canvas></div></div>
        <div class="az-card card"><h4><Icon name="chart" :size="14" /> {{ t('力度分布（Velocity）') }}</h4><div class="chart-wrap"><canvas id="azVel"></canvas></div></div>
      </div>
      <div class="az-row">
        <div class="az-card card"><h4><Icon name="chart" :size="14" /> {{ t('音符时值分布') }}</h4><div class="chart-wrap"><canvas id="azDur"></canvas></div></div>
        <div class="az-card card"><h4><Icon name="chart" :size="14" /> {{ t('音轨概览') }}</h4><div class="chart-wrap"><canvas id="azTracks"></canvas></div></div>
      </div>
      <div class="az-row">
        <div class="az-card card az-wide">
          <h4><Icon name="chart" :size="14" /> {{ t('时间线密度（音符 / 小节）') }}
            <span class="az-zoom">
              <button class="chip-btn" @click="densityZoom = Math.max(0.25, +(densityZoom / 2).toFixed(3))">−</button>
              <span class="az-zoom-txt">{{ Math.round(densityZoom * 100) }}%</span>
              <button class="chip-btn" @click="densityZoom = Math.min(8, +(densityZoom * 2).toFixed(3))">+</button>
            </span>
          </h4>
          <div class="chart-wrap" style="height:150px"><canvas id="azDensity"></canvas></div>
        </div>
      </div>
      <div class="az-row">
        <div class="az-card card az-wide"><h4><Icon name="chart" :size="14" /> {{ t('音频 / MIDI 对齐对比') }}</h4><div class="chart-wrap" style="height:150px"><canvas id="azCompare"></canvas></div></div>
      </div>
      <div class="az-row">
        <div class="az-card card">
          <h4><Icon name="chart" :size="14" /> {{ t('离调 / 错音检测') }}</h4>
          <div class="az-txt">
            <template v-if="data.off.length">{{ t('检测到 ') }}<b>{{ data.off.length }}</b>{{ t(' 个离调/错音，主要出现在第 ') }}{{ data.offBars.join('、') }}{{ t(' 小节附近（如 ') }}{{ data.offNames }}){{ t('）。建议重点检查这些片段的音高。') }}</template>
            <template v-else>{{ t('未检测到明显离调音符，整体音高较贴合调性。') }}</template>
          </div>
        </div>
        <div class="az-card card">
          <h4><Icon name="chart" :size="14" /> {{ t('节奏稳定性') }}</h4>
          <div class="az-txt">
            <template v-if="data.humanPct < 15">{{ t('节奏稳定性：整体接近量化网格（偏差 ') }}{{ data.humanPct }}%{{ t('），律动规整。') }}</template>
            <template v-else-if="data.humanPct < 30">{{ t('节奏稳定性：轻度人工化/摇摆（偏差 ') }}{{ data.humanPct }}%{{ t('），有一定表现力。') }}</template>
            <template v-else>{{ t('节奏稳定性：偏差较大（') }}{{ data.humanPct }}%{{ t('），可能存在明显抢拍/拖拍，建议重点检查。') }}</template>
          </div>
        </div>
      </div>
      <div class="az-row">
        <div class="az-card card az-wide"><h4><Icon name="chart" :size="14" /> {{ t('力度动态曲线') }}</h4><div class="chart-wrap" style="height:130px"><canvas id="azVelCurve"></canvas></div></div>
      </div>
    </template>
    <template v-else>
      <div class="empty card"><b>{{ t('正在分析…') }}</b><p>{{ t('正在读取当前曲目并计算统计。') }}</p></div>
    </template>
  </div>
</template>

<style scoped>
.stat-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 14px; }
@media (max-width: 1100px) { .stat-grid { grid-template-columns: repeat(3, 1fr); } }
.stat-card { border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 12px 14px; background: var(--surface); }
.stat-card .sc-label { font-size: 11px; color: var(--stone); margin-bottom: 4px; }
.stat-card .sc-value { font-size: 17px; font-weight: 700; color: var(--ink); letter-spacing: -0.3px; }
.stat-card .sc-value.alt { color: var(--brand-coral); }
.stat-card .sc-sub { font-size: 10.5px; color: var(--stone); margin-top: 3px; }
.az-summary { font-size: 12.5px; color: var(--slate); line-height: 1.7; margin-bottom: 14px; }
.az-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
@media (max-width: 900px) { .az-row { grid-template-columns: 1fr; } }
.az-card.az-wide { grid-column: 1 / -1; }
.az-card h4 { display: flex; align-items: center; gap: 6px; margin: 0 0 10px; font-size: 13px; font-weight: 600; color: var(--ink); }
.az-card h4 .az-zoom { margin-left: auto; display: flex; align-items: center; gap: 6px; font-weight: 500; }
.az-card h4 .az-zoom-txt { font-size: 11px; min-width: 40px; text-align: center; }
.chart-wrap { height: 140px; }
.chart-wrap canvas { width: 100%; height: 100%; display: block; }
.az-txt { font-size: 12.5px; color: var(--slate); line-height: 1.8; min-height: 40px; }
.chord-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chord-chips .chip { display: inline-flex; align-items: baseline; gap: 6px; padding: 5px 10px; border: 1px solid var(--border); border-radius: var(--radius-full); background: var(--surface); font-size: 12px; color: var(--ink); cursor: pointer; }
.chord-chips .chip:hover { border-color: var(--brand-coral); color: var(--brand-coral); }
.chord-chips .chip b { color: var(--brand-coral); font-weight: 600; }
.chord-chips .chip span { color: var(--stone); font-size: 10.5px; }
</style>
