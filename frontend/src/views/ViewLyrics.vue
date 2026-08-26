<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Icon from '../components/Icon.vue';
import { currentSong, state, togglePlay, toast } from '../store.js';
import { getPlayer, ensureAudio } from '../audio.js';
import { t } from '../core/i18n.js';
import { esc } from '../core/util.js';

/* ---------------- 歌词数据 ---------------- */
function collectLyrics(song) {
  const items = [];
  for (const tr of song.tracks) for (const e of tr.events || []) {
    if (e.type === 'lyric' && e.text && e.text.trim()) items.push({ tick: e.tick, text: e.text.trim(), ev: e });
  }
  items.sort((a, b) => a.tick - b.tick);
  const out = [];
  const seen = new Set();
  // 仅去除「同时间码 + 同文本」的精确重复；副歌重复行（同文本不同时间）必须保留
  for (const it of items) {
    const key = it.tick + '|' + it.text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}
function fmtTickTime(tick, song) {
  const sec = song && song.baseSec ? song.baseSec(tick) : (tick / ((song && song.tpb) || 480)) * (60 / ((song && song.initialBpm) || 120));
  // 先取整到总毫秒再拆分，避免浮点误差（如 4.999995）导致秒/毫秒越界（显示 00:04.1000）
  const totalMs = Math.round(sec * 1000);
  const m = Math.floor(totalMs / 60000), ss = Math.floor((totalMs % 60000) / 1000), ms = totalMs % 1000;
  return String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0') + '.' + String(ms).padStart(3, '0');
}
function parseTimecodeToTick(str, song) {
  str = String(str || '').trim();
  if (!song) return NaN;
  let sec = NaN;
  const m = str.match(/^(?:(\d+):)?(\d{1,2})(?:[.:](\d{1,3}))?$/);
  if (m) {
    sec = (parseInt(m[1] || '0', 10) * 60 + parseInt(m[2], 10));
    if (m[3]) sec += parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) / 1000;
  } else sec = parseFloat(str);
  if (!isFinite(sec) || sec < 0) return NaN;
  return song.secToTick ? Math.round(song.secToTick(sec)) : Math.round(sec * (song.tpb || 480) * (song.initialBpm || 120) / 60);
}
const song = computed(() => (currentSong.value && currentSong.value.song) || null);
const lyrics = computed(() => (song.value ? collectLyrics(song.value) : []));
const fontSz = ref(18);
const karaoke = ref(true);
const newText = ref('');
const tlEl = ref(null);
const replaceOpen = ref(false);
const repFrom = ref('');
const repTo = ref('');

/* ---------------- 卡拉OK高亮 ---------------- */
const curIdx = ref(-1);
function updateHighlight() {
  if (!karaoke.value || !state.playing) return;
  const s = song.value;
  if (!s) return;
  const p = getPlayer();
  if (!p || !p.song) return;
  const tick = p.currentTick();
  const lyr = lyrics.value;
  let idx = -1;
  for (let i = 0; i < lyr.length; i++) if (lyr[i].tick <= tick) idx = i;
  curIdx.value = idx;
  // 自动滚动到当前歌词
  if (idx >= 0) {
    const sc = document.querySelector('.lyr-list');
    if (sc) {
      const row = sc.querySelector('.lyr-row[data-idx="' + idx + '"]');
      if (row) {
        const r = row.getBoundingClientRect(), sR = sc.getBoundingClientRect();
        if (r.top < sR.top || r.bottom > sR.bottom) row.scrollIntoView({ block: 'nearest' });
      }
    }
  }
}

/* ---------------- 编辑 ---------------- */
function saveLyric(i) {
  const s = song.value, lyr = lyrics.value;
  if (!s || !lyr[i]) return;
  const row = document.querySelector('.lyr-row[data-idx="' + i + '"]');
  const text = (row.querySelector('.ly-text').value || '').trim();
  const tick = parseTimecodeToTick(row.querySelector('.ly-time').value, s);
  if (!isFinite(tick)) { toast(t('时间码格式无效'), 'warn'); return; }
  const e = lyr[i].ev;
  if (e) { e.text = text; e.tick = tick; }
  toast(t('歌词已保存'), 'ok');
}
function delLyric(i) {
  const s = song.value, lyr = lyrics.value;
  if (!s || !lyr[i]) return;
  const ev = lyr[i].ev;
  for (const tr of s.tracks) if (tr.events) {
    const idx = tr.events.indexOf(ev);
    if (idx >= 0) { tr.events.splice(idx, 1); break; }
  }
  toast(t('歌词已删除'), 'ok');
}
function addLyric() {
  const s = song.value;
  if (!s) { toast(t('请先载入 MIDI 文件'), 'warn'); return; }
  const text = newText.value.trim();
  if (!text) { toast(t('请输入歌词'), 'warn'); return; }
  const p = getPlayer();
  const tick = (p && p.song) ? Math.round(p.currentTick()) : 0;
  let best = null;
  for (const tr of s.tracks) for (const n of tr.notes || []) {
    if (n.start <= tick && (!best || n.start > best.start)) best = n;
  }
  if (best) s.tracks[0].events.push({ tick: best.start, type: 'lyric', text });
  else s.tracks[0].events.push({ tick, type: 'lyric', text });
  newText.value = '';
  toast(t('已添加歌词'), 'ok');
}
function importText() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.txt,.lrc';
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const s = song.value;
      if (!s) return;
      const u8 = new Uint8Array(r.result);
      // 优先按 UTF-8 严格解码；失败（日文 LRC 常为 Shift-JIS 编码）则回退 Shift-JIS，
      // 避免 readAsText 按 UTF-8 强解导致日文显示乱码
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(u8); }
      catch (e) {
        try { text = new TextDecoder('shift_jis').decode(u8); }
        catch (e2) { text = new TextDecoder('utf-8').decode(u8); }
      }
      const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      let added = 0;
      // 兼容 [mm:ss.xx] 标签
      for (const line of lines) {
        const mm = line.match(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\](.*)/);
        if (mm) {
          const sec = parseInt(mm[1], 10) * 60 + parseInt(mm[2], 10) + (mm[3] ? parseInt(mm[3].padEnd(3, '0').slice(0, 3), 10) / 1000 : 0);
          const txt = (mm[4] || '').trim();
          if (txt) { s.tracks[0].events.push({ tick: Math.round(s.secToTick(sec)), type: 'lyric', text: txt }); added++; }
        }
      }
      toast(added ? t('已导入 ') + added + t(' 句歌词') : t('未找到可识别的歌词行'), added ? 'ok' : 'warn');
    };
    r.readAsArrayBuffer(f);
  };
  inp.click();
}
function exportLrc() {
  const s = song.value;
  if (!s || !lyrics.value.length) { toast(t('暂无歌词'), 'warn'); return; }
  const lines = lyrics.value.map(l => {
    const totalMs = Math.round(s.baseSec(l.tick) * 1000);
    const m = Math.floor(totalMs / 60000), ss = Math.floor((totalMs % 60000) / 1000), ms = totalMs % 1000;
    return '[' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0') + '.' + String(ms).padStart(3, '0').slice(0, 2) + ']' + l.text;
  });
  const blob = new Blob(['[ti:' + s.name + ']\n' + lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.download = s.name + '.lrc';
  a.href = URL.createObjectURL(blob);
  a.click();
  URL.revokeObjectURL(a.href);
  toast(t('已导出 LRC'), 'ok');
}

function exportSrt() {
  const s = song.value;
  if (!s || !lyrics.value.length) { toast(t('暂无歌词'), 'warn'); return; }
  const lines = lyrics.value.map((l, i) => {
    const t0 = Math.round(s.baseSec(l.tick) * 1000);
    const t1 = i + 1 < lyrics.value.length ? Math.round(s.baseSec(lyrics.value[i + 1].tick) * 1000) : Math.min(s.totalSec * 1000, t0 + 3000);
    const fmt = ms => {
      const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), ss = Math.floor((ms % 60000) / 1000), f = ms % 1000;
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0') + ',' + String(f).padStart(3, '0');
    };
    return (i + 1) + '\n' + fmt(t0) + ' --> ' + fmt(t1) + '\n' + l.text + '\n';
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.download = s.name + '.srt'; a.href = URL.createObjectURL(blob); a.click();
  URL.revokeObjectURL(a.href);
  toast(t('已导出 SRT'), 'ok');
}
function exportTxt() {
  const s = song.value;
  if (!s || !lyrics.value.length) { toast(t('暂无歌词'), 'warn'); return; }
  const lines = lyrics.value.map(l => l.text);
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.download = s.name + '.txt'; a.href = URL.createObjectURL(blob); a.click();
  URL.revokeObjectURL(a.href);
  toast(t('已导出 TXT'), 'ok');
}
function splitWords() {
  const s = song.value;
  if (!s || !lyrics.value.length) { toast(t('暂无歌词'), 'warn'); return; }
  let count = 0;
  for (const lyr of lyrics.value) {
    const ev = lyr.ev;
    if (!ev) continue;
    const parts = String(lyr.text).split('');
    if (parts.length <= 1) continue;
    const tickSize = Math.max(1, Math.round((s.tpb || 480) / 8));
    parts.forEach((ch, i) => {
      if (!ch.trim()) return;
      s.tracks[0].events.push({ tick: lyr.tick + i * tickSize, type: 'lyric', text: ch });
      count++;
    });
    const idx = s.tracks[0].events.indexOf(ev);
    if (idx >= 0) s.tracks[0].events.splice(idx, 1);
  }
  toast(t('已逐字拆分 ') + count + t(' 个字符'), count ? 'ok' : 'warn');
}

/* ---------------- 批量替换 ---------------- */
function openReplace() {
  repFrom.value = '';
  repTo.value = '';
  replaceOpen.value = true;
}
function doBatchReplace() {
  const from = repFrom.value;
  if (!from) { toast(t('请输入查找内容'), 'warn'); return; }
  const s = song.value;
  if (!s) return;
  const to = repTo.value || '';
  let count = 0;
  for (const tr of s.tracks) for (const e of tr.events || []) {
    if (e.type === 'lyric' && e.text) { const n = e.text.split(from).join(to); if (n !== e.text) { e.text = n; count++; } }
  }
  replaceOpen.value = false;
  toast(count ? t('已替换 ') + count + t(' 处') : t('未找到匹配内容'), count ? 'ok' : 'warn');
}
/* 「添加到所选音符」入口提示：歌词挂音符的操作在编辑视图内完成 */
function noteSelHint() {
  toast(t('请先在「编辑」视图选中音符，再用上方输入框在此处添加歌词'), 'info');
}

/* ---------------- 时间轴 ---------------- */
function drawTimeline() {
  const cv = tlEl.value, s = song.value;
  if (!cv || !s) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(10,10,10,0.03)'; ctx.fillRect(0, 0, w, h);
  const total = s.totalTicks || 1, tpb = s.tpb || 480;
  // 小节线
  ctx.strokeStyle = 'rgba(10,10,10,0.06)'; ctx.lineWidth = 1;
  for (let tk = 0; tk <= total; tk += tpb) {
    const x = Math.round(tk / total * w);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  // 音符密度（半透明蓝）
  const laneTop = 0, laneH = Math.round(h * 0.62);
  const notes = [];
  for (const tr of s.tracks) for (const n of tr.notes || []) notes.push(n);
  if (notes.length) {
    let mn = 127, mx = 0;
    for (const n of notes) { if (n.midi < mn) mn = n.midi; if (n.midi > mx) mx = n.midi; }
    const range = Math.max(1, mx - mn);
    ctx.fillStyle = 'rgba(20,86,240,0.22)';
    for (const n of notes) {
      const x1 = Math.round(n.start / total * w), x2 = Math.round(n.end / total * w);
      const y = laneTop + (1 - (n.midi - mn) / range) * (laneH - 8) + 4;
      if (x2 > x1) ctx.fillRect(x1, y, Math.max(1, x2 - x1), 2);
    }
  }
  // 歌词标记
  const lyr = lyrics.value;
  if (lyr.length) {
    ctx.fillStyle = '#ff5530';
    for (const l of lyr) {
      const x = Math.round(l.tick / total * w);
      if (x >= 0 && x <= w) ctx.fillRect(x, laneTop + laneH + 8, 2, h - laneH - 16);
    }
  }
  // 播放游标
  if (state.playing) {
    const p = getPlayer();
    if (p && p.song) {
      const x = Math.round(p.currentTick() / total * w);
      ctx.fillStyle = 'rgba(10,10,10,0.75)'; ctx.fillRect(x - 0.5, 0, 1.5, h);
    }
  }
  // 图例
  ctx.fillStyle = 'rgba(10,10,10,0.55)'; ctx.font = '10px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(t('蓝：音符 · 橙：歌词 · 竖线：播放位置'), 6, h - 16);
}

let raf = 0;
function loop() {
  updateHighlight();
  if (tlEl.value) drawTimeline();
  raf = requestAnimationFrame(loop);
}

watch(song, () => nextTick(() => drawTimeline()));
onMounted(() => { raf = requestAnimationFrame(loop); });
onBeforeUnmount(() => cancelAnimationFrame(raf));
</script>

<template>
  <div class="page lyrics-view">
    <div class="page-head">
      <span class="page-ic"><Icon name="music" :size="20" /></span>
      <div>
        <div class="page-title">{{ t('歌词') }}</div>
        <div class="page-sub">{{ t('边听 MIDI 边添加 / 编辑歌词 · 同步滚动') }}</div>
      </div>
    </div>

    <div class="lyr-toolbar">
      <button class="btn sm" :class="{ primary: state.playing }" @click="togglePlay">
        <Icon :name="state.playing ? 'pause' : 'play'" :size="14" />{{ state.playing ? t('暂停') : t('播放') }}
      </button>
      <button class="btn sm" @click="addLyric" :disabled="!song"><Icon name="plus" :size="14" />{{ t('添加歌词') }}</button>
      <button class="btn sm" @click="openReplace" :disabled="!lyrics.length"><Icon name="edit" :size="14" />{{ t('批量替换') }}</button>
      <button class="btn sm" @click="noteSelHint" :disabled="!song" title="在编辑视图中选中音符后可为其添加歌词"><Icon name="cursor" :size="14" />{{ t('添加到所选音符') }}</button>
      <button class="btn sm" @click="importText" :disabled="!song"><Icon name="import" :size="14" />{{ t('导入文本') }}</button>
      <button class="btn sm" @click="exportLrc" :disabled="!lyrics.length"><Icon name="save" :size="14" />{{ t('导出 LRC') }}</button>
      <button class="btn sm" @click="exportSrt" :disabled="!lyrics.length"><Icon name="save" :size="14" />{{ t('导出 SRT') }}</button>
      <button class="btn sm" @click="exportTxt" :disabled="!lyrics.length"><Icon name="save" :size="14" />{{ t('导出 TXT') }}</button>
      <button class="btn sm" @click="splitWords" :disabled="!lyrics.length" title="逐字拆分"><Icon name="edit" :size="14" />{{ t('逐字拆分') }}</button>
      <span class="sep"></span>
      <label class="lyr-ctl">{{ t('字号') }}<input type="number" min="12" max="40" v-model.number="fontSz" class="num-input" style="width:56px" /></label>
      <label class="lyr-ctl"><input type="checkbox" v-model="karaoke" /> {{ t('卡拉OK高亮') }}</label>
      <span style="flex:1"></span>
      <span class="lyr-status">{{ song ? (t('共 ') + lyrics.length + t(' 句')) : '' }}</span>
    </div>

    <div class="lyr-add">
      <input v-model="newText" class="text-input" :placeholder="t('输入歌词，回车在当前播放位置添加')" @keydown.enter="addLyric" :disabled="!song" />
      <button class="btn sm" @click="addLyric" :disabled="!song">{{ t('添加') }}</button>
    </div>

    <canvas ref="tlEl" class="lyr-timeline" :style="{ height: '150px' }"></canvas>

    <div class="lyr-list">
      <div v-if="!song" class="lyr-empty">{{ t('请先载入 MIDI 文件') }}</div>
      <div v-else-if="!lyrics.length" class="lyr-empty">{{ t('暂无歌词，点击上方按钮添加或导入') }}</div>
      <div v-else v-for="(l, i) in lyrics" :key="i" class="lyr-row" :class="{ cur: karaoke && state.playing && i === curIdx }" :data-idx="i">
        <input class="ly-time" :value="fmtTickTime(l.tick, song)" @keydown.enter="saveLyric(i)" />
        <input class="ly-text" :value="l.text" @keydown.enter="saveLyric(i)" />
        <button class="btn sm ghost" @click="saveLyric(i)">{{ t('保存') }}</button>
        <button class="btn sm ghost danger" @click="delLyric(i)">{{ t('删除') }}</button>
      </div>
    </div>

    <!-- 批量替换弹窗 -->
    <div v-if="replaceOpen" class="rep-overlay" @click.self="replaceOpen = false">
      <div class="rep-card">
        <div class="rep-head">
          <b>{{ t('批量替换歌词') }}</b>
          <button class="icon-btn" @click="replaceOpen = false" title="关闭"><Icon name="plus" :size="14" style="transform:rotate(45deg)" /></button>
        </div>
        <input v-model="repFrom" class="text-input" :placeholder="t('查找')" @keydown.enter="doBatchReplace" />
        <input v-model="repTo" class="text-input" :placeholder="t('替换为')" @keydown.enter="doBatchReplace" />
        <div class="rep-actions">
          <button class="btn sm ghost" @click="replaceOpen = false">{{ t('取消') }}</button>
          <button class="btn sm primary" @click="doBatchReplace">{{ t('替换') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lyrics-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; padding: 18px 26px 24px; max-width: 1100px; margin: 0 auto; }
.lyr-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.sep { width: 1px; height: 20px; background: var(--hairline); margin: 0 2px; }
.lyr-ctl { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--steel); }
.lyr-ctl input[type=checkbox] { accent-color: var(--ink); }
.lyr-status { font-size: 11px; color: var(--stone); }
.lyr-add { display: flex; gap: 8px; margin-bottom: 10px; }
.text-input { flex: 1; padding: 8px 12px; font-size: 12.5px; background: var(--canvas); border: 1px solid var(--hairline); border-radius: 10px; color: var(--ink); outline: none; }
.text-input:focus { border-color: var(--ink); }
.lyr-timeline { width: 100%; background: var(--canvas); border: 1px solid var(--hairline); border-radius: 12px; margin-bottom: 10px; display: block; cursor: pointer; }
.lyr-list { flex: 1; overflow-y: auto; border: 1px solid var(--hairline); border-radius: 12px; background: var(--canvas); }
.lyr-empty { color: var(--stone); font-size: 13px; padding: 24px 16px; text-align: center; }
.lyr-row { display: flex; gap: 8px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--hairline); transition: background 0.15s; }
.lyr-row.cur { background: var(--surface-soft); }
.lyr-row.cur .ly-text { font-weight: 700; color: var(--brand-coral); }
.ly-time { width: 92px; padding: 4px 6px; font-size: 11px; background: var(--canvas); border: 1px solid var(--hairline); border-radius: 6px; color: var(--ink); font-family: var(--mono); outline: none; }
.ly-text { flex: 1; min-width: 80px; padding: 4px 8px; font-size: 12.5px; background: var(--canvas); border: 1px solid var(--hairline); border-radius: 6px; color: var(--ink); outline: none; }
.ly-time:focus, .ly-text:focus { border-color: var(--ink); }

/* 批量替换弹窗 */
.rep-overlay {
  position: fixed; inset: 0; z-index: 90;
  background: rgba(10, 10, 10, 0.28);
  display: flex; align-items: center; justify-content: center;
}
.rep-card {
  width: 380px; max-width: calc(100vw - 40px);
  background: var(--canvas); border: 1px solid var(--hairline);
  border-radius: 16px; box-shadow: var(--shadow-lg);
  padding: 16px; display: flex; flex-direction: column; gap: 10px;
}
.rep-head { display: flex; align-items: center; justify-content: space-between; font-size: 14px; font-weight: 700; color: var(--ink); }
.rep-actions { display: flex; gap: 8px; justify-content: flex-end; }
</style>
