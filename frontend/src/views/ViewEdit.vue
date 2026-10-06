<script setup>
// 编辑视图：钢琴卷帘工作台（走带工具栏 + 左侧检查器 + 多车道舞台 + 状态栏）
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, onActivated, onDeactivated, nextTick } from 'vue';
import Icon from '../components/Icon.vue';
import EditorCanvas from '../components/EditorCanvas.vue';
import { useAppStore } from '../stores/app';
import { useWorkspace } from '../stores/workspace';
import EditorMenuBar from '../components/editor/EditorMenuBar.vue';
import MidiToolPanel from '../components/editor/MidiToolPanel.vue';
import CommandPalette from '../components/editor/CommandPalette.vue';
import { MIDI_TOOLS } from '../core/midi-tools.js';
import { ensureAudio } from '../audio.js';

const app = useAppStore();
const state = app;
/* ---------------- 工作台骨架（M1）：工作区布局 / 菜单条 / 检查器分页 / 状态栏 ----------------
   布局以前散在几份 localStorage 里各写各的，现在统一走 stores/workspace.ts（键名沿用，老设置不丢）。 */
const ws = useWorkspace();
const inspTab = ref('note');
const shortcutsOpen = ref(false);

/* 检查器分页（M1）：三块面板原先竖着堆在 260~320px 宽的栏里，窄屏要滚三屏才找得到
   「网格与显示」。分页后一屏一类信息，带 0.22s 进入动画。 */
const INSP_TABS = [['note', '音符', 'cursor'], ['track', '轨道', 'music'], ['view', '视图', 'quantize']];

/* 快捷键一览（M1）：以前只写在按钮 title 里，等于没有。只列**代码里真实存在**的手势。 */
const SHORTCUT_GROUPS = [
  { name: '工具与绘制', rows: [['V', '选择工具'], ['B', '画笔工具'], ['E', '橡皮工具'], ['拖拽音符', '移动（上下改音高、左右改位置）'], ['拖音符边缘', '拉伸时值'], ['空白处点击', '画笔工具下插入音符'], ['悬停音符', '就地工具条：力度 / 时值 / 静音 / 删除 / 参数工具'], ['步进输入', '点一下落一个音并自动前进（← → 走指针，Esc 退出）']] },
  { name: '修饰键（画布）', rows: [['← / →', '步进模式下走指针（一步 = 当前步长）'], ['Alt+拖拽', '改力度（2px ≈ 1 级）'], ['Shift+拖拽', '锁定音高，只改时间位置'], ['Ctrl / Shift + 点击', '加选 / 减选'], ['Ctrl+滚轮', '缩放'], ['Shift+滚轮', '横向平移']] },
  { name: '选择', rows: [['拖拽空白', '框选音符'], ['右键音符', '上下文菜单（含参数工具直达）']] },
  { name: '编辑', rows: [['Ctrl+Shift+P', '命令面板（搜索所有命令）'], ['Ctrl+Z', '撤销'], ['Ctrl+Y', '重做'], ['Ctrl+C', '复制选中'], ['Ctrl+V', '粘贴到播放头'], ['Ctrl+A', '全选'], ['Delete', '删除选中'], ['Ctrl+S', '导出 MIDI']] },
  { name: '视图与走带', rows: [['滚轮', '上下滚动音高'], ['Ctrl+滚轮', '缩放'], ['Shift+滚轮', '横向平移'], ['状态栏右下', '工作区预设：编曲 / 调教 / 校对 / 混音']] },
];
const currentSong = computed(() => app.currentSong);
const toast = (m, t) => app.toast(m, t);
const importFiles = (items) => app.importFiles(items);
const setView = (v) => app.setView(v);
import { encodeMidi } from '../core/midi.js';
import { noteName, clamp, KEY_NAME, removeNotes } from '../core/util.js';
import { MACRO_DOC, macroToCmd, applyMacroScript, parseMacroScript } from '../core/macro.js';
import { SCALE_TYPES, parseCustomDegrees, scalePitchClasses } from '../core/scale.js';
import { detectKeySpec, detectChordTrack, chordPcsByName } from '../core/analysis.js';
import { listArticulations, applyArticulation, upsertUserArticulation, removeUserArticulation } from '../core/articulations.js';
import { t } from '../core/i18n.js';

const bridge = window.fuBridge;

function cssVar(name, fb) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fb;
  } catch (e) { return fb; }
}

const tool = ref('pencil');
const snapRatio = ref(0.0625);
const trackIndex = ref(0);
const timbre = ref(0);
const zoomPct = ref(100);
const editor = ref(null);
const miniEl = ref(null);
const miniWrap = ref(null);
const advOpen = ref(false);
// 三视图切换：钢琴卷帘 / 鼓组网格（乐谱为独立页面，见 setEditorView）
const viewMode = ref('piano');

// 力度曲线弹窗
const vcOpen = ref(false);
const vcCanvas = ref(null);
const vcVals = ref([]);
const vcPainting = ref(false);

// 列表编辑器弹窗
const listOpen = ref(false);
const listDraft = ref([]);

// CC 泳道
const ccEnabled = ref(false);
const ccNumber = ref(11);
const CC_OPTIONS = [[1, t('CC1 颤音')], [7, t('CC7 音量')], [10, t('CC10 声像')], [11, t('CC11 表情')], [64, t('CC64 延音')]];

const sel = reactive({ count: 0, midi: null, name: '', vel: null, start: null, len: null });

const SNAPS = [
  [0, t('关')], [1, t('1 拍')], [0.75, t('附点8分')], [0.6666666667, t('三连2分')], [0.5, '1/2'],
  [0.3333333333, t('三连音')], [0.25, '1/4'], [0.125, '1/8'], [0.0625, '1/16'], [0.03125, '1/32'],
];

const song = computed(() => (currentSong.value && currentSong.value.song) || null);

const smpteText = computed(() => {
  const sec = Math.max(0, state.curSec || 0);
  const fps = 25;
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = Math.floor(sec % 60);
  const ff = Math.floor((sec % 1) * fps);
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0') + ':' + String(ff).padStart(2, '0');
});
// 状态栏：小节:拍 位置 + 速度 + 当前轨道，给出与 DAW 一致的时间参照
const posText = computed(() => {
  const s = song.value; if (!s) return '1:1';
  const tpb = s.tpb || 480;
  const sig = (s.sigMap && s.sigMap[0]) ? s.sigMap[0].num : 4;
  const tick = Math.max(0, Math.round(s.secToTick(state.curSec / (state.tempo || 1))));
  const per = tpb * sig;
  return (Math.floor(tick / per) + 1) + ':' + (Math.floor((tick % per) / tpb) + 1);
});
// 速度取自曲目本身（state.tempo 是播放倍速，不是 BPM）
const bpmText = computed(() => {
  const s = song.value;
  return Math.round((s && s.initialBpm) || 120);
});
const curTrackInfo = computed(() => {
  const s = song.value; if (!s) return null;
  return s.tracks[trackIndex.value] || null;
});
const selMutedNow = computed(() => (editor.value && sel.count ? editor.value.selMuted() : false));

/* ---------------- 速度轨（M5，借 Cubase 的 tempo track） ----------------
   tempoMap 的每一项是 { tick, us, sec }，其中 sec 是**到该点的累计秒数**（播放换算用它）。
   所以任何一次改动后都必须整表重算 sec，而且要**原地改那个数组** ——
   core/midi.js 的 secToTick/baseSec 是闭包捕获了它的，换引用等于没改。 */
const tempoLane = ref(false);
const tempoPoints = computed(() => (((song.value && song.value.tempoMap) || [])).map((p) => ({ tick: p.tick, bpm: Math.round(60000000 / p.us * 10) / 10 })));
function rebuildTempoMap(s) {
  const tm = s.tempoMap;
  if (!tm || !tm.length) return;
  tm.sort((a, b) => a.tick - b.tick);
  if (tm[0].tick !== 0) tm.unshift({ tick: 0, us: tm[0].us, sec: 0 });
  let sec = 0;
  for (let i = 0; i < tm.length; i++) {
    if (i > 0) sec = tm[i - 1].sec + (tm[i].tick - tm[i - 1].tick) * tm[i - 1].us / 1e6 / (s.tpb || 480);
    tm[i].sec = sec;
  }
  s.initialBpm = Math.round(60000000 / tm[0].us);
}
/** 速度改动统一入口：快照 → 原地改 tempoMap → 重算 sec → 刷新播放器 */
function commitTempo(mutate) {
  const s = song.value; if (!s || !s.tempoMap) return;
  editor.value?.pushStateForTrack(-1);
  mutate(s.tempoMap);
  rebuildTempoMap(s);
  editor.value?.notifyExternalEdit();
}
function setTempoPoint(i, e) {
  const bpm = Math.max(20, Math.min(400, Number(e && e.target ? e.target.value : e) || 120));
  commitTempo((tm) => { if (tm[i]) tm[i].us = Math.round(60000000 / bpm); });
  toast(t('速度已改为 ') + bpm + ' BPM', 'ok');
}
function addTempoPoint() {
  const s = song.value; if (!s) return;
  const tick = Math.max(0, Math.round(s.secToTick(state.curSec / (state.tempo || 1))));
  const cur = tempoPoints.value.find((p) => p.tick === tick);
  if (cur) { toast(t('该位置已经有速度点'), 'warn'); return; }
  commitTempo((tm) => {
    let us = tm[0] ? tm[0].us : 500000;
    for (const p of tm) if (p.tick <= tick) us = p.us;
    tm.push({ tick, us, sec: 0 });
  });
  toast(t('已在播放头加入速度点'), 'ok');
}
function delTempoPoint(i) {
  if (tempoPoints.value.length < 2) { toast(t('至少要保留一个速度点'), 'warn'); return; }
  commitTempo((tm) => { tm.splice(i, 1); });
}
function resetTempo() {
  const s = song.value; if (!s) return;
  const us = s.tempoMap && s.tempoMap[0] ? s.tempoMap[0].us : 500000;
  commitTempo((tm) => { tm.length = 0; tm.push({ tick: 0, us, sec: 0 }); });
  toast(t('已清空速度点，回到单一速度'), 'ok');
}

/* ---------------- 技法条（M5，借 Cubase 的 articulation lane） ----------------
   演奏法在 MIDI 里就是**低音区的一个 Key Switch 音符**（midi 0..24，具体键位由 ksMap 决定）。
   技法条把它读成「从这次切换开始、到下一次切换为止」的一段，于是：
     · 一眼看出这一段在用什么技法（以前只能去钢琴卷帘最底下那几个小格子里找）；
     · 直接在条上换技法（改那个 KS 音符的音高）；
     · 选区起点一键插技法。
   演奏法本身**不是**音符字段（换音源不需要重做数据），这是刻意的。 */
const artLane = ref(false);
const newArtMidi = ref(1);
const KS_KEYS = Array.from({ length: 25 }, (_, i) => i);
const ksName = (m) => ksMap.value[m] || ('KS ' + m);
/** 只有**映射表里有的键**才算技法切换。否则一首钢琴曲低音区的 C1（midi 24）会被误读成技法。 */
const ksMappedKeys = computed(() => KS_KEYS.filter((k) => ksMap.value[k]));
const ksEmpty = computed(() => ksMappedKeys.value.length === 0);
function useDefaultKsMap() {
  const next = applyArticulation(ksMap.value, 'spitfire');
  ksMap.value = next;
  saveKS(next);
  reloadArticulations();
  toast(t('已套用 Spitfire 技法映射（可在「映射表」里改）'), 'ok');
}
const ksSegments = computed(() => {
  const s = song.value, tr = curTrackInfo.value;
  if (!s || !tr) return [];
  const ks = tr.notes.filter((n) => n.midi <= 24 && ksMap.value[n.midi]).sort((a, b) => a.start - b.start);
  const total = s.totalTicks || 0;
  return ks.map((n, i) => ({
    note: n, start: n.start, midi: n.midi, name: ksName(n.midi),
    end: i + 1 < ks.length ? ks[i + 1].start : total,
  }));
});
/** 某个 tick 处生效的技法名（悬停条/状态栏用） */
function artAt(tick) {
  let hit = null;
  for (const seg of ksSegments.value) { if (seg.start <= tick) hit = seg; else break; }
  return hit ? hit.name : '';
}
function setSegArticulation(seg, e) {
  const m = Number(e && e.target ? e.target.value : e);
  if (!Number.isFinite(m) || m === seg.midi) return;
  editor.value?.editNote(seg.note, { midi: Math.max(0, Math.min(24, Math.round(m))) });
  refreshSel(); onModified();
}
function delKsSeg(seg) {
  editor.value?.deleteNoteExternal(seg.note);
  refreshSel(); onModified();
}
function addArticulationHere() {
  const s = song.value;
  if (!s) { toast(t('请先载入 MIDI'), 'warn'); return; }
  // 下拉在某些状态下会给出空值（v-model.number → NaN），这里兜一下，别插出音高是 NaN 的音符
  const raw = Number(newArtMidi.value);
  const m = Number.isFinite(raw) ? Math.max(0, Math.min(24, Math.round(raw))) : 0;
  const sel = editor.value?.selRef();
  const tick = (sel && sel.length) ? Math.min(...sel.map((n) => n.start))
    : Math.max(0, Math.round(s.secToTick(state.curSec / (state.tempo || 1))));
  editor.value?.insertKeySwitch(m, tick, Math.round(s.tpb / 2));
  artLane.value = true;
  refreshSel(); onModified();
  toast(t('已在选区起插入技法：') + ksName(newArtMidi.value), 'ok');
}
function tickBar(tick) {
  const s = song.value; if (!s) return '1';
  const per = (s.tpb || 480) * ((s.sigMap && s.sigMap[0]) ? s.sigMap[0].num : 4);
  return String(Math.floor((tick || 0) / per) + 1);
}

/* ---------------- 步进输入（M4） ----------------
   开启后画笔落在「步进指针」上并自动前进；← → 手动走，工具条显示指针所在的小节:拍。 */
const stepOn = ref(false);
const stepBeats = ref(0.25);
const stepCursorTick = ref(0);
const STEP_OPTS = [[0.125, '1/32'], [0.25, '1/16'], [1 / 3, '1/8T'], [0.5, '1/8'], [1, '1/4']];
const stepTicks = computed(() => Math.max(30, Math.round(stepBeats.value * ((song.value && song.value.tpb) || 480))));
const stepCursorText = computed(() => {
  const s = song.value; if (!s) return '1:1';
  const tpb = s.tpb || 480;
  const per = tpb * ((s.sigMap && s.sigMap[0]) ? s.sigMap[0].num : 4);
  const tk = stepCursorTick.value;
  return (Math.floor(tk / per) + 1) + ':' + (Math.floor((tk % per) / tpb) + 1);
});
function onStep(tick) { stepCursorTick.value = tick || 0; }
function toggleStep() {
  stepOn.value = !stepOn.value;
  if (stepOn.value) {
    if (tool.value !== 'pencil') tool.value = 'pencil';
    const s = song.value;
    // 打开时把指针放到播放头，用户一进来就知道「下一个音落在哪」
    if (s) editor.value?.setStepCursor(Math.max(0, Math.round(s.secToTick(state.curSec / (state.tempo || 1)))));
    toast(t('步进输入：点击音符区按步长依次落音（← → 走指针，Esc 退出）'), 'ok');
  }
}
function stepToPlayhead() {
  const s = song.value; if (!s) return;
  editor.value?.setStepCursor(Math.max(0, Math.round(s.secToTick(state.curSec / (state.tempo || 1)))));
}

/* ---------------- 参数化 MIDI 工具（M2） ----------------
   面板本身与具体工具解耦：工具表在 core/midi-tools.js，预览在 EditorCanvas 里，
   这里只负责「传上下文 + 开关 + 结果提示」。 */
const midiToolOpen = ref(false);
const midiToolPreset = ref('');   // 从命令面板/右键菜单直达某条工具
/* ---- 悬停工具条（M3）：鼠标压到音符上就地弹一条，移开或进拖拽就收 ---- */
const hoverInfo = ref(null);
let hoverTimer = 0;
function cancelHoverHide() { if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; } }
function scheduleHoverHide() { cancelHoverHide(); hoverTimer = window.setTimeout(() => { hoverInfo.value = null; hoverTimer = 0; }, 200); }
function onHover(e) {
  cancelHoverHide();
  if (!e) { scheduleHoverHide(); return; }
  hoverInfo.value = { ...e };   // 技法名由模板里的 artAt(hoverInfo.tick) 现算：改完技法不用再晃一下鼠标才更新
}
const hoverBarStyle = computed(() => {
  const h = hoverInfo.value; if (!h) return {};
  const w = 330;
  const left = Math.min(Math.max(8, h.x + 14), Math.max(8, window.innerWidth - w - 8));
  const top = Math.max(8, h.y - 42);
  return { left: left + 'px', top: top + 'px' };
});
function hoverAct(kind) {
  const n = editor.value?.hoverAction(kind) || 0;
  if (n) { hoverInfo.value = null; refreshSel(); onModified(); toast(t('已处理 ') + n + t(' 个音符'), 'ok'); }
}
function hoverMore() {
  if (!editor.value?.selectHover()) return;
  hoverInfo.value = null;
  refreshSel();
  openMidiTools('');
}
/* ---- 命令面板（M3，Ctrl+Shift+P）：动作表就是菜单条那一份 ---- */
const palOpen = ref(false);
const commands = computed(() => {
  const out = [];
  for (const g of menuGroups.value) {
    for (const it of g.items) {
      if (it.sep) continue;
      out.push({ group: g.label, label: it.label, hint: it.hint || '', disabled: !!it.disabled, run: it.run });
    }
  }
  for (const tool of MIDI_TOOLS) {
    out.push({ group: t('参数工具'), label: t(tool.name), hint: t(tool.group), disabled: !sel.count, run: () => openMidiTools(tool.id) });
  }
  for (const p of ws.presets) out.push({ group: t('工作区'), label: t('工作区：') + t(p.label), hint: '', run: () => applyPreset(p.id) });
  return out;
});
const toolCtx = computed(() => {
  const s = song.value;
  let spec = scaleSpec.value;
  if (!spec && s) {
    // 没显式设调时按曲目自动判断（与画布 autoScale 同一套：detectKeySpec）
    try {
      const all = [];
      for (const tr of s.tracks) for (const n of tr.notes) all.push(n);
      const k = all.length ? detectKeySpec(all) : null;
      if (k && k.root != null) spec = { root: k.root, type: k.mode || 'major', custom: [] };
    } catch (e) { /* 判断失败就不约束 */ }
  }
  let pcs = [];
  try { pcs = spec ? scalePitchClasses(spec) : []; } catch (e) { pcs = []; }
  return { tpb: (s && s.tpb) || 480, scalePcs: pcs, track: curTrackInfo.value };
});
function openMidiTools(toolId) {
  if (!song.value) { toast(t('请先载入 MIDI'), 'warn'); return; }
  if (!sel.count) { toast(t('请先选中要处理的音符'), 'warn'); return; }
  midiToolPreset.value = toolId || '';
  midiToolOpen.value = true;
}
function onToolPanelClose(e) {
  midiToolOpen.value = false;
  if (e && e.applied) {
    toast(t('已应用「') + (e.tool || '') + t('」：') + e.changed + t(' 个音符'), 'ok');
    onModified();
  }
  refreshSel();
}

/* 工作区预设：一键换布局（M1）。以前「卷帘太小 / 检查器太窄」只能手动拖，拖完还不记得。 */
const VIEW_NAMES = { piano: '钢琴卷帘', drum: '鼓组网格', score: '乐谱' };
const viewLabel = computed(() => t(VIEW_NAMES[viewMode.value] || '钢琴卷帘'));
const snapLabel = computed(() => {
  const hit = SNAPS.find((s) => Math.abs(Number(s[0]) - Number(snapRatio.value)) < 1e-6);
  return hit ? hit[1] : t('关');
});
function applyPreset(id) {
  ws.applyPreset(id);
  const p = ws.presets.find((x) => x.id === id);
  const vm = ws.layout.viewMode === 'drum' ? 'piano' : ws.layout.viewMode;
  if (vm !== viewMode.value) { viewMode.value = vm; flashView(); }
  toast(t('工作区已切换：') + t(p ? p.label : ''), 'ok');
}

/* ---------------- 菜单条（M1）：DAW 式的稳定位置 ----------------
   低频动作原先全塞在工具条的「更多 ▾」浮层里（两屏高的面板），找一次成本极高。
   这里把它们按「文件 / 编辑 / 视图 / 工具 / 帮助」重新归类，工具条只留高频动作。
   只挂**已经存在**的函数，不新增未实现的动作。 */
const menuGroups = computed(() => {
  const hasSong = !!song.value;
  const hasSel = sel.count > 0;
  return [
    { label: t('文件'), items: [
      { label: t('新建曲目'), run: newMidi },
      { label: t('导入 MIDI / 转谱…'), run: () => setView('import') },
      { sep: true },
      { label: t('载入参考音频…'), run: loadAudio },
      { label: t('载入视频轨道…'), run: loadVideo },
      { label: t('移除视频轨道'), disabled: !videoUrl.value, run: removeVideo },
      { sep: true },
      { label: t('导出 MIDI'), hint: 'Ctrl+S', run: exportMidi },
    ] },
    { label: t('编辑'), items: [
      { label: t('撤销'), hint: 'Ctrl+Z', run: undo },
      { label: t('重做'), hint: 'Ctrl+Y', run: redo },
      { sep: true },
      { label: t('复制'), hint: 'Ctrl+C', disabled: !hasSel, run: copy },
      { label: t('粘贴到播放头'), hint: 'Ctrl+V', disabled: !hasSong, run: paste },
      { label: t('克隆选区到其后'), disabled: !hasSel, run: dup },
      { sep: true },
      { label: t('全选'), hint: 'Ctrl+A', disabled: !hasSong, run: selectAll },
      { label: t('取消选择'), disabled: !hasSel, run: () => { editor.value?.selectNone(); refreshSel(); } },
      { label: t('同音高批量选择'), disabled: !hasSel, run: samePitch },
      { sep: true },
      { label: t('删除选中'), hint: 'Del', disabled: !hasSel, run: del },
    ] },
    { label: t('视图'), items: [
      { label: t('钢琴卷帘'), disabled: !hasSong, run: () => setEditorView('piano') },
      { label: t('鼓组网格'), disabled: !hasSong, run: () => setEditorView('drum') },
      { label: t('乐谱编辑'), disabled: !hasSong, run: () => setEditorView('score') },
      { sep: true },
      { label: ws.layout.inspOpen ? t('收起检查器') : t('显示检查器'), run: () => { inspOpen.value = !inspOpen.value; } },
      { label: artLane.value ? t('隐藏技法条') : t('显示技法条'), hint: t('演奏法'), run: () => { artLane.value = !artLane.value; } },
      { label: tempoLane.value ? t('隐藏速度轨') : t('显示速度轨'), hint: t('速度自动化'), run: () => { tempoLane.value = !tempoLane.value; } },
      { label: fullscreenOn.value ? t('退出全屏') : t('全屏编辑'), run: toggleFullscreen },
      { sep: true },
      ...ws.presets.map((p) => ({ label: t('工作区：') + t(p.label), hint: ws.preset === p.id ? '✓' : '', run: () => applyPreset(p.id) })),
    ] },
    { label: t('工具'), items: [
      { label: t('量化到吸附网格'), disabled: !hasSel, run: quantize },
      { label: t('参数化工具（拖动即预览）'), hint: t('需先选中'), disabled: !hasSel, run: openMidiTools },
      { label: stepOn ? t('退出步进输入') : t('步进输入'), hint: stepOn ? t('当前已开启') : t('← → 走指针'), run: toggleStep },
      { label: t('智能量化（网格 + Groove）'), disabled: !hasSong, run: openSmartQuantize },
      { label: t('力度曲线（绘制包络）'), disabled: !hasSel, run: openVelCurve },
      { label: t('列表编辑器（精确数值）'), disabled: !hasSel, run: openList },
      { sep: true },
      { label: t('逻辑编辑器（批量规则）'), disabled: !hasSong, run: openLogicEditor },
      { label: t('宏面板'), disabled: !hasSong, run: openMacroPanel },
      { label: t('Key Switch 映射'), disabled: !hasSong, run: openKSMap },
      { label: t('撤销历史'), disabled: !hasSong, run: openHistory },
      { sep: true },
      { label: t('分析逐小节和弦'), disabled: !hasSong, run: analyzeChordTrack },
      { label: t('智能伴奏'), disabled: !hasSong, run: addAccompaniment },
      { label: t('CC 事件列表'), disabled: !hasSong, run: openCCList },
      { label: t('添加延音踏板（CC64）'), disabled: !hasSong, run: addPedal },
      { sep: true },
      { label: t('删除过短音符（<80ms）'), disabled: !hasSong, run: deleteShortNotes },
      { label: t('整轨响度 -10%'), disabled: !hasSong, run: () => loudScale(0.9) },
      { label: t('整轨响度 +10%'), disabled: !hasSong, run: () => loudScale(1.1) },
    ] },
    { label: t('帮助'), items: [
      { label: t('快捷键一览'), hint: '?', run: () => { shortcutsOpen.value = true; } },
      { label: t('编辑功能介绍'), run: () => { helpOpen.value = true; } },
      { sep: true },
      { label: t('转到转谱页'), run: () => setView('score') },
      { label: t('转到调教页'), run: () => setView('sing') },
    ] },
  ];
});

function refreshSel() {
  const info = editor.value ? editor.value.selInfo() : null;
  sel.count = info ? info.count : 0;
  sel.midi = info && info.midi != null ? info.midi : null;
  sel.name = info && info.name ? info.name : '';
  sel.vel = info && info.vel != null ? info.vel : null;
  sel.start = info && info.start != null ? info.start : null;
  sel.len = info && info.len != null ? info.len : null;
}
function onZoom(z) { zoomPct.value = Math.round(z * 100); }

/* ---------------- 工具栏操作 ---------------- */
function undo() { editor.value?.undo(); refreshSel(); }
function redo() { editor.value?.redo(); refreshSel(); }
function del() { editor.value?.deleteSelected(); refreshSel(); }
function quantize() { recordCmd('quantize 8'); editor.value?.quantizeSelected(); refreshSel(); }
function trUp() { recordCmd('transpose 1'); editor.value?.transposeSelected(1); refreshSel(); }
function trDown() { recordCmd('transpose -1'); editor.value?.transposeSelected(-1); refreshSel(); }
function octUp() { recordCmd('transpose 12'); editor.value?.transposeSelected(12); refreshSel(); }
function octDown() { recordCmd('transpose -12'); editor.value?.transposeSelected(-12); refreshSel(); }
function copy() { const n = editor.value?.copySelected() || 0; toast(t('已复制 ') + n + t(' 个音符'), 'ok'); }
function paste() {
  const s = song.value; if (!s) return;
  const playTick = Math.round(s.secToTick(state.curSec / state.tempo));
  const n = editor.value?.pasteAt(playTick) || 0;
  if (n) toast(t('已粘贴 ') + n + t(' 个音符'), 'ok');
}
function dup() { const n = editor.value?.duplicateSelected() || 0; if (n) toast(t('已克隆 ') + n + t(' 个音符'), 'ok'); }
function velUp() { recordCmd('vel_inc 3'); editor.value?.velRampSelected(3); refreshSel(); }
function velDown() { recordCmd('vel_dec 3'); editor.value?.velRampSelected(-3); refreshSel(); }
function samePitch() { editor.value?.selectSamePitch(); refreshSel(); }
function selectAll() { editor.value?.selectAll(); refreshSel(); }

/* ---------------- 钢琴卷帘右键菜单 ---------------- */
const ctxMenu = ref(null);   // { x, y, hit, tick, midi }
const ctxSub = ref('');      // '' | 'quantize' | 'transpose' | 'velocity'
const CTX_W = 182, CTX_H = 402, CTX_SUB_W = 158;
function openCtxMenu(p) {
  if (!p) return;
  closeCtxMenu();
  ctxMenu.value = p;
  // 打开菜单本身不改选中，但要把检查器同步到最新选择（右键命中音符时画布已改选）
  nextTick(refreshSel);
}
function closeCtxMenu() { ctxMenu.value = null; ctxSub.value = ''; }
/* M3：右键菜单里直达某条参数工具 / 命令面板 */
function ctxRunTool(id) { closeCtxMenu(); openMidiTools(id); }
function openPalette() { closeCtxMenu(); palOpen.value = true; }
function ctxMenuStyle() {
  const m = ctxMenu.value;
  if (!m) return {};
  return {
    left: Math.max(4, Math.min(m.x, window.innerWidth - CTX_W - 8)) + 'px',
    top: Math.max(4, Math.min(m.y, window.innerHeight - CTX_H - 8)) + 'px',
  };
}
/** 子菜单是否向左弹出（贴近视口右缘时） */
const ctxSubFlip = computed(() => {
  const m = ctxMenu.value;
  if (!m) return false;
  const left = Math.max(4, Math.min(m.x, window.innerWidth - CTX_W - 8));
  return left + CTX_W + CTX_SUB_W > window.innerWidth;
});
/** 菜单项依赖选区，无选区时给出提示而不是静默失败 */
function needSel() {
  if (!editor.value || !editor.value.selCount()) {
    toast(t('请先在钢琴卷帘中选择音符'), 'warn');
    closeCtxMenu();
    return false;
  }
  return true;
}
function ctxCut() {
  if (!needSel()) return;
  const n = editor.value.copySelected() || 0;
  if (n) { editor.value.deleteSelected(); toast(t('已剪切 ') + n + t(' 个音符'), 'ok'); }
  refreshSel(); closeCtxMenu();
}
function ctxCopy() { copy(); closeCtxMenu(); }
function ctxPaste() {
  const tick = ctxMenu.value ? ctxMenu.value.tick : 0;
  const n = editor.value?.pasteAt(tick) || 0;
  if (n) toast(t('已粘贴 ') + n + t(' 个音符'), 'ok');
  refreshSel(); closeCtxMenu();
}
function ctxDup() { dup(); closeCtxMenu(); }
function ctxDelete() { del(); closeCtxMenu(); }
/** ratio 为「拍的比例」（EditorCanvas.quantize 用），N 为宏命令里的分音符数（4/ratio） */
function ctxQuantize(ratio) {
  if (!needSel()) return;
  recordCmd('quantize ' + Math.round(4 / ratio));
  editor.value.quantizeSelected(ratio);
  refreshSel(); closeCtxMenu();
}
function ctxTranspose(d) {
  if (!needSel()) return;
  recordCmd('transpose ' + d);
  editor.value.transposeSelected(d);
  refreshSel(); closeCtxMenu();
}
function ctxVel(d) {
  if (!needSel()) return;
  recordCmd('vel_' + (d > 0 ? 'inc' : 'dec') + ' ' + Math.abs(d));
  editor.value.velRampSelected(d);
  refreshSel(); closeCtxMenu();
}
function ctxVelReset() {
  if (!needSel()) return;
  editor.value.setSelVel(80);
  toast(t('已重置力度为默认值 80'), 'ok');
  refreshSel(); closeCtxMenu();
}
function ctxSamePitch() { if (!needSel()) return; samePitch(); closeCtxMenu(); }
/** 静音/取消静音选中音符（只影响发声，删除与导出不受影响） */
function ctxMute(on) {
  if (!needSel()) return;
  editor.value.setSelMuted(on);
  toast(on ? t('已静音选中音符') : t('已取消静音'), 'ok');
  refreshSel(); closeCtxMenu();
}
function ctxSelectAll() { selectAll(); closeCtxMenu(); }
function ctxSelectNone() { editor.value?.selectNone(); refreshSel(); closeCtxMenu(); }
function ctxToggleScaleSnap() { scaleSnap.value = !scaleSnap.value; closeCtxMenu(); }
/** 量化选项：label + 拍比例 */
const CTX_QUANTIZE = [
  [t('1/4 音符'), 1],
  [t('1/8 音符'), 0.5],
  [t('1/16 音符'), 0.25],
  [t('1/32 音符'), 0.125],
  [t('1/8 三连音'), 1 / 3],
];

/* ---------------- 力度曲线 ---------------- */
function openVelCurve() {
  if (!editor.value?.selCount()) { toast(t('请先在钢琴卷帘中选择音符'), 'warn'); return; }
  const n = editor.value.selCount();
  const v = editor.value.selInfo();
  // 初始：线性渐变（首音符力度 → 末音符力度）
  const from = (v && v.vel != null) ? v.vel : 80;
  const to = 100;
  vcVals.value = Array.from({ length: n }, (_, i) => n > 1 ? Math.round(from + (to - from) * i / (n - 1)) : from);
  vcOpen.value = true;
  nextTick(drawVelCurve);
}
function drawVelCurve() {
  const cv = vcCanvas.value;
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 480, H = cv.clientHeight || 160;
  if (cv.width !== Math.floor(W * dpr) || cv.height !== Math.floor(H * dpr)) { cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.fillStyle = cssVar('--surface-soft', 'rgba(10,10,10,0.04)'); g.fillRect(0, 0, W, H);
  // 力度参考网格
  g.strokeStyle = cssVar('--hairline', 'rgba(10,10,10,0.08)'); g.lineWidth = 1;
  for (let v = 0; v <= 127; v += 32) {
    const y = H - v / 127 * (H - 10) - 5;
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
  }
  g.fillStyle = cssVar('--stone', 'rgba(10,10,10,0.45)'); g.font = '9px monospace';
  g.fillText('127', 3, 10); g.fillText('1', 3, H - 5);
  // 曲线
  const n = vcVals.value.length;
  if (!n) return;
  const x0 = 26, xw = W - x0 - 8;
  g.strokeStyle = '#1456f0'; g.lineWidth = 1.6; g.beginPath();
  vcVals.value.forEach((v, i) => {
    const x = x0 + (n > 1 ? i / (n - 1) * xw : 0);
    const y = H - 5 - (v / 127) * (H - 10);
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  });
  g.stroke();
  // 音符落点
  g.fillStyle = '#ff5530';
  vcVals.value.forEach((v, i) => {
    const x = x0 + (n > 1 ? i / (n - 1) * xw : 0);
    const y = H - 5 - (v / 127) * (H - 10);
    g.beginPath(); g.arc(x, y, 2.5, 0, Math.PI * 2); g.fill();
  });
}
function vcDown(e) { vcPainting.value = true; vcLast = null; vcPaint(e); }
function vcMove(e) { if (vcPainting.value) vcPaint(e); }
function vcUp() { vcPainting.value = false; vcLast = null; }
let vcLast = null;
function vcPaint(e) {
  const cv = vcCanvas.value; if (!cv) return;
  const rect = cv.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const W = rect.width, H = rect.height;
  const n = vcVals.value.length;
  if (!n) return;
  const x0 = 26, xw = W - x0 - 8;
  const idx = clamp(Math.round((x - x0) / Math.max(1, xw) * (n - 1)), 0, n - 1);
  const v = clamp(Math.round((H - 5 - y) / (H - 10) * 127), 1, 127);
  if (vcLast != null && vcLast.idx !== idx) {
    // 从上次位置到当前位置线性插值填充，保证拖拽画线连续覆盖
    const from = vcLast.idx, toIdx = idx, vFrom = vcLast.v;
    const step = Math.sign(toIdx - from);
    const span = Math.max(1, Math.abs(toIdx - from));
    for (let i = from; i !== toIdx + step; i += step) {
      const t = Math.abs(i - from) / span;
      const iv = Math.round(vFrom + (v - vFrom) * t);
      if (i >= 0 && i < n) vcVals.value[i] = iv;
    }
  } else {
    vcVals.value[idx] = v;
  }
  vcLast = { idx, v };
  drawVelCurve();
}
function applyVelCurve() {
  editor.value?.applyVelCurve([...vcVals.value]);
  vcOpen.value = false;
  refreshSel();
  toast(t('力度曲线已应用'), 'ok');
}

/* ---------------- 列表编辑器 ---------------- */
function openList() {
  const refs = editor.value?.selRef();          // 实时引用，按 start 排序
  if (!refs || !refs.length) { toast(t('请先在钢琴卷帘中选择音符'), 'warn'); return; }
  if (!editor.value.beginPreview(refs)) { toast(t('请先在钢琴卷帘中选择音符'), 'warn'); return; }
  listDraft.value = refs.map(n => ({ start: n.start, end: n.end, midi: n.midi, vel: n.vel }));
  listOpen.value = true;
}
/* 列表编辑器改成**即时生效**（M4）：打开时进预览态，改哪一格画布上立刻变，
   确定才落成一个撤销点，取消/Esc 一次还原。
   顺序很关键：草稿按 start 排序生成，预览基线也用同一份 selRef()（同样按 start 排序）——
   于是「下标 ↔ 音符」是稳定映射，用户把某个音拖到别的位置时表格不会跳行。 */
function applyListDraft() {
  const arr = listDraft.value;
  editor.value?.applyPreviewNow((notes) => {
    notes.forEach((n, i) => {
      const d = arr[i]; if (!d) return;
      n.start = Math.max(0, Math.round(d.start));
      n.end = Math.max(n.start + 1, Math.round(d.end));
      n.midi = clamp(Math.round(d.midi), 0, 127);
      n.vel = clamp(Math.round(d.vel), 1, 127);
    });
    return notes.length;
  });
}
function applyList() {
  const n = editor.value?.commitPreview() || 0;
  listOpen.value = false;
  toast(t('已应用 ') + n + t(' 个音符的修改'), 'ok');
  refreshSel(); onModified();
}
function cancelList() {
  editor.value?.cancelPreview();
  listOpen.value = false;
  refreshSel();
}
function saveList() {
  editor.value?.applyDraft(listDraft.value);
  listOpen.value = false;
  refreshSel();
  toast(t('列表修改已应用'), 'ok');
}
function addPedal() {
  const n = editor.value?.addPedal() || 0;
  if (n) toast(t('已添加踏板（CC64 起止）'), 'ok');
  else toast(t('请先选择音符或载入曲目'), 'warn');
}
function delPedal() {
  const n = editor.value?.delPedal() || 0;
  if (n) toast(t('已删除 ') + n + t(' 个踏板事件'), 'ok');
  else toast(t('区间内没有踏板事件'), 'warn');
}
function setLoopFromSel() {
  const sel = editor.value?.selRef();
  if (!sel || !sel.length) { toast(t('请先选择音符，再设置为选区循环'), 'warn'); return; }
  let a = Infinity, b = 0;
  for (const n of sel) { a = Math.min(a, n.start); b = Math.max(b, n.end); }
  const { player } = ensureAudio();
  player.setLoop(true, a, b);
  state.loop = true;
  toast(t('已设置选区循环（') + a + ' - ' + b + t('）'), 'ok');
}
function clearLoopSel() {
  const s = song.value;
  if (!s) return;
  const { player } = ensureAudio();
  player.setLoop(false, 0, s.totalTicks);
  state.loop = false;
  toast(t('已清除循环'), 'ok');
}

// 鼓组网格视图（原独立弹窗 → 收编为编辑器内的第二视图）
const drumTrack = ref(0);
const drumCv = ref(null);
const DRUM_PITCHES = [35,36,38,40,41,43,45,47,48,50,51,53,55,57,59,60,61,63,65,66,67,69,71,72,73,75,76,77,79,81];
const DRUM_NAMES = {35:'Acoustic Bass Drum',36:'Bass Drum 1',38:'Acoustic Snare',40:'Electric Snare',41:'Floor Tom 2',43:'Floor Tom 1',45:'Low Tom',47:'Low-Mid Tom',48:'Hi-Mid Tom',50:'High Tom',51:'Ride Cymbal 1',53:'Ride Bell',55:'Splash Cymbal',57:'Crash Cymbal 2',59:'Ride Cymbal 2',60:'Hi Bongo',61:'Low Bongo',63:'High Conga',65:'Low Conga',66:'High Timbale',67:'Low Timbale',69:'Cowbell',71:'High Agogo',72:'Low Agogo',73:'Maracas',75:'Claves',76:'Hi Wood Block',77:'Low Wood Block',79:'Open Cuica',81:'Open Hi-Hat'};
const drumTracks = computed(() => song.value ? song.value.tracks.map((t, i) => ({ i, t })) : []);
/* 鼓组命名（M4，借 REAPER 的 note name map）：GM 名字只是默认值，
   用户自己的鼓机/音源映射经常不一样（36 是 Kick 还是别的），所以允许逐音改名并持久化。 */
const DRUM_NAME_KEY = 'fufumidi_drum_names';
const drumNames = ref((() => { try { return JSON.parse(localStorage.getItem(DRUM_NAME_KEY) || '{}') || {}; } catch (e) { return {}; } })());
const drumNameOpen = ref(false);
const drumNameDraft = ref({});
function drumName(midi) { return drumNames.value[midi] || DRUM_NAMES[midi] || String(midi); }
function openDrumNames() {
  drumNameDraft.value = {};
  for (const p of DRUM_PITCHES) drumNameDraft.value[p] = drumNames.value[p] || '';
  drumNameOpen.value = true;
}
function saveDrumNames() {
  const out = {};
  for (const p of DRUM_PITCHES) { const v = String(drumNameDraft.value[p] || '').trim(); if (v) out[p] = v; }
  drumNames.value = out;
  try { localStorage.setItem(DRUM_NAME_KEY, JSON.stringify(out)); } catch (e) {}
  drumNameOpen.value = false;
  nextTick(drawDrum);
  toast(t('鼓组命名已保存'), 'ok');
}
function resetDrumNames() { drumNameDraft.value = {}; }

/**
 * 三视图切换：钢琴卷帘 / 鼓组网格 / **五线谱（就地编辑）**。
 *
 * ★ 乐谱以前是「跳转到乐谱页」——那是只读的刻版视图（abcjs/Verovio），看完还得跳回来改。
 *   现在乐谱是**同一份数据的另一种编辑器视图**：选中/撤销/吸附/播放头与卷帘共用，
 *   在谱面上直接点选、拖动改音高、画笔插音符、改时值，改的就是 MIDI。
 *   只读的精排谱（带排版/导出 PDF/PNG）仍然在「乐谱」页。
 */
/* 视图切换的过渡：画布用 v-show 保活（不能重建，否则丢撤销历史与视图位置），
   所以这里只做一次「淡入 + 轻微上浮」的闪动，提示画面内容换了。 */
const viewFlash = ref(false);
let viewFlashTimer = 0;
function flashView() {
  viewFlash.value = false;
  clearTimeout(viewFlashTimer);
  nextTick(() => {
    viewFlash.value = true;
    viewFlashTimer = window.setTimeout(() => { viewFlash.value = false; }, 300);
  });
}

function setEditorView(v) {
  if (v === 'drum') { openDrumEditor(); flashView(); return; }
  if (!song.value) { toast(t('请先载入 MIDI'), 'warn'); return; }
  const next = (v === 'score') ? 'score' : 'piano';
  if (next !== viewMode.value) flashView();
  viewMode.value = next;
  if (v === 'score') nextTick(() => editor.value?.focusSelection());
}

/* ---------------- 乐谱视图工具（时值/附点/谱号） ---------------- */
const scoreDot = ref(false);
const scoreClefUi = ref('auto');
const SCORE_DURS = [
  { q: 4, label: '全' }, { q: 2, label: '二分' }, { q: 1, label: '四分' },
  { q: 0.5, label: '八分' }, { q: 0.25, label: '十六分' },
];
/** 点一下时值：既设为「画笔插入的时值」，也改当前选中的音符 */
function pickScoreDur(q) {
  const tpb = (song.value && song.value.tpb) || 480;
  const tks = Math.round(q * tpb * (scoreDot.value ? 1.5 : 1));
  editor.value?.setInsert(tks, scoreDot.value);
  if (editor.value && editor.value.selCount() > 0) { editor.value.setSelLen(tks); refreshSel(); }
}
function toggleScoreDot() {
  scoreDot.value = !scoreDot.value;
  editor.value?.setInsert(null, scoreDot.value);
}
function pickClef(c) {
  scoreClefUi.value = c;
  if (editor.value && editor.value.scoreClef) { editor.value.scoreClef.value = c; editor.value.draw(); }
}
function openDrumEditor() {
  if (!song.value) { toast(t('请先载入 MIDI'), 'warn'); return; }
  const drums = drumTracks.value.filter(x => x.t.isDrum || x.t.ch === 9);
  const list = drums.length ? drums : drumTracks.value;
  drumTrack.value = list.length ? list[0].i : 0;
  viewMode.value = 'drum';
  nextTick(drawDrum);
}
function drawDrum() {
  const cv = drumCv.value, s = song.value;
  if (!cv || !s) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 700, h = cv.clientHeight || 420;
  if (cv.width !== Math.floor(w * dpr) || cv.height !== Math.floor(h * dpr)) { cv.width = Math.floor(w * dpr); cv.height = Math.floor(h * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = cssVar('--canvas', '#ffffff'); g.fillRect(0, 0, w, h);
  const rows = DRUM_PITCHES.length;
  const tr = s.tracks[drumTrack.value]; if (!tr) return;
  const tpb = s.tpb || 480, bars = Math.min(8, s.bars || 4), beats = bars * 4;
  const rowH = h / rows, colW = w / beats;
  const hair = cssVar('--hairline', 'rgba(10,10,10,0.07)');
  const border2 = cssVar('--border-strong', 'rgba(10,10,10,0.16)');
  const slate = cssVar('--steel', 'rgba(10,10,10,0.5)');
  for (let i = 0; i < rows; i++) {
    const y = i * rowH;
    if (i % 2) { g.fillStyle = cssVar('--row-alt', 'rgba(10,10,10,0.03)'); g.fillRect(0, y, w, rowH); }
    g.strokeStyle = hair; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    g.fillStyle = slate; g.font = '9px monospace'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText(String(drumName(DRUM_PITCHES[i])).slice(0, 14), 4, y + rowH / 2);
  }
  for (let b = 0; b < beats; b++) {
    const x = b * colW;
    g.strokeStyle = b % 4 === 0 ? border2 : hair;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
  }
  g.fillStyle = cssVar('--note-fill', '#8b83f0');
  // 只画可见的 8 小节：notes 按 start 升序，二分定位右界后截断遍历
  // （大 MIDI 单轨 9 万+ 音符时，全量遍历 + indexOf 会直接卡死主线程）
  const maxTick = beats * tpb;
  let end = tr.notes.length, lo = 0, hi = end;
  while (lo < hi) { const m = (lo + hi) >> 1; if (tr.notes[m].start < maxTick) lo = m + 1; else hi = m; }
  for (let i = 0; i < lo; i++) {
    const n = tr.notes[i];
    const ri = DRUM_PITCHES.indexOf(n.midi); if (ri < 0) continue;
    const x = n.start / (tpb * 4) * colW;
    g.fillRect(x + 1, ri * rowH + 2, Math.max(4, (n.end - n.start) / (tpb * 4) * colW - 2), rowH - 4);
  }
}
function drumClick(e) {
  const cv = drumCv.value, s = song.value;
  if (!cv || !s) return;
  const rect = cv.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const rows = DRUM_PITCHES.length;
  const tr = s.tracks[drumTrack.value]; if (!tr) return;
  const tpb = s.tpb || 480, bars = Math.min(8, s.bars || 4), beats = bars * 4;
  const rowH = rect.height / rows, colW = rect.width / beats;
  const ri = Math.floor(y / rowH), bi = Math.floor(x / colW);
  if (ri < 0 || ri >= rows || bi < 0 || bi >= beats) return;
  const midi = DRUM_PITCHES[ri], tick = Math.round(bi * tpb);
  editor.value?.pushStateForTrack(drumTrack.value);
  const hit = tr.notes.find(n => n.midi === midi && Math.abs(n.start - tick) < tpb / 8);
  if (hit) { const i = tr.notes.indexOf(hit); if (i >= 0) tr.notes.splice(i, 1); }
  else tr.notes.push({ start: tick, end: tick + Math.round(tpb / 2), midi, vel: 100 });
  tr.notes.sort((a, b) => a.start - b.start);
  editor.value?.notifyExternalEdit();
  drawDrum();
}
function drumClear() {
  const s = song.value; if (!s) return;
  const tr = s.tracks[drumTrack.value]; if (!tr) return;
  const hits = tr.notes.filter(n => DRUM_PITCHES.includes(n.midi));
  if (hits.length) {
    editor.value?.pushStateForTrack(drumTrack.value);
    removeNotes([tr], new Set(hits));
    editor.value?.notifyExternalEdit();
    drawDrum();
    toast(t('已清除 ') + hits.length + t(' 个鼓点'), 'ok');
  }
}
watch(drumTrack, () => nextTick(drawDrum));

/* ============ 高级编辑功能（对齐原仓库） ============ */
/* P0-1 调内编辑：音阶配置（本地持久化）+ 关闭/高亮/约束三态 */
const SCALE_KEY = 'fufumidi_scale';
const scaleCfg = (() => { try { return JSON.parse(localStorage.getItem(SCALE_KEY) || '{}') || {}; } catch (e) { return {}; } })();
const scaleMode = ref(['off', 'highlight', 'constrain'].includes(scaleCfg.mode) ? scaleCfg.mode : 'off');
const scaleRoot = ref(Number.isFinite(Number(scaleCfg.root)) ? Number(scaleCfg.root) : -1);  // -1 = 自动
const scaleType = ref(scaleCfg.type || 'major');
const customDegText = ref(scaleCfg.customText || '0,2,4,7,9');
const ROOT_OPTIONS = KEY_NAME.map((n, i) => [i, n]);
const SCALE_MODE_OPTIONS = [['off', t('关闭')], ['highlight', t('高亮调内音')], ['constrain', t('约束到音阶')]];
/** 传给画布的显式音阶；主音选「自动」时返回 null，由画布按曲目判断 */
const scaleSpec = computed(() => (scaleRoot.value < 0
  ? null
  : { root: scaleRoot.value, type: scaleType.value, custom: scaleType.value === 'custom' ? parseCustomDegrees(customDegText.value) : [] }));
/** 「音阶吸附」开关：等效于在 约束 / 关闭 之间切换（保持旧入口可用） */
const scaleSnap = computed({
  get: () => scaleMode.value === 'constrain',
  set: (v) => { scaleMode.value = v ? 'constrain' : 'off'; },
});
watch([scaleMode, scaleRoot, scaleType, customDegText], () => {
  try {
    localStorage.setItem(SCALE_KEY, JSON.stringify({
      mode: scaleMode.value, root: scaleRoot.value, type: scaleType.value, customText: customDegText.value,
    }));
  } catch (e) {}
});
/* P1-2 和弦轨：逐小节和弦（自动识别 + 手动覆盖），约束模式下与音阶一起决定调内音 */
const chordOpen = ref(false);
const chordBars = ref([]);       // [{ bar, tick, endTick, name, pcs, manual }]
const chordManual = ref({});     // bar → 手改和弦名
/** 传给画布的约束数据（只在显示和弦轨时参与约束/高亮） */
const chordSpec = computed(() => (chordOpen.value
  ? chordBars.value.map(b => ({ tick: b.tick, endTick: b.endTick, pcs: b.pcs }))
  : []));
function rebuildChordBars(list) {
  const manual = chordManual.value;
  chordBars.value = list.map(b => {
    const nm = manual[b.bar];
    if (!nm) return { ...b, manual: false };
    const pcs = chordPcsByName(nm);
    return { ...b, name: nm, pcs: pcs || b.pcs, manual: true };
  });
}
function analyzeChordTrack() {
  const s = song.value; if (!s) return;
  const list = detectChordTrack(s);
  if (!list.length) { toast(t('没有识别到和弦（曲目可能没有音符）'), 'warn'); return; }
  rebuildChordBars(list);
  chordOpen.value = true;
  toast(t('已生成和弦轨：') + list.length + t(' 个小节'), 'ok');
}
function editChordBar(b) {
  app.promptDialog({
    title: t('编辑小节和弦'),
    msg: t('第 ') + b.bar + t(' 小节：输入和弦名（如 C / Am7 / G7/B），留空恢复自动识别'),
    value: b.name,
  }).then(v => {
    if (v == null) return;
    const nm = String(v).trim();
    if (!nm) delete chordManual.value[b.bar]; else chordManual.value[b.bar] = nm;
    const s = song.value; if (s) rebuildChordBars(detectChordTrack(s));
  });
}
function clearChordBars() { chordBars.value = []; chordManual.value = {}; chordOpen.value = false; }

/** 按曲目分析结果设调（复用 analysis 的调性判定） */
function scaleFromAnalysis() {
  const s = song.value; if (!s) return;
  const all = [];
  for (const tr of s.tracks) for (const n of tr.notes) all.push(n);
  if (!all.length) { toast(t('当前曲目没有音符'), 'warn'); return; }
  const k = detectKeySpec(all);
  scaleRoot.value = k.root;
  scaleType.value = k.mode === 'minor' ? 'minor' : 'major';
  if (scaleMode.value === 'off') scaleMode.value = 'highlight';
  toast(t('已按分析结果设为 ') + KEY_NAME[k.root] + t(k.mode === 'minor' ? ' 小调' : ' 大调'), 'ok');
}
const cc2Enabled = ref(false);
const cc2Number = ref(1);
const ccMode = ref('free');
/* P0-2 编辑器偏好：新音符默认力度 + 音符着色方案（本地持久化） */
const editPrefs = (() => { try { return JSON.parse(localStorage.getItem('fufumidi_edit_prefs') || '{}') || {}; } catch (e) { return {}; } })();
const defaultVelocity = ref(typeof editPrefs.defaultVelocity === 'number' ? editPrefs.defaultVelocity : 80);
const colorMode = ref(editPrefs.colorMode || 'track');
const COLOR_MODES = [['track', t('按轨道')], ['pitch', t('按音高')], ['velocity', t('按力度')], ['selection', t('按选中')], ['scale', t('按音阶')]];
watch([defaultVelocity, colorMode], () => {
  try { localStorage.setItem('fufumidi_edit_prefs', JSON.stringify({ defaultVelocity: defaultVelocity.value, colorMode: colorMode.value })); } catch (e) {}
});
const bpmInput = ref(song.value ? song.value.initialBpm : 120);
const fullscreenOn = ref(false);

// Key Switch 映射（localStorage 持久化）
function loadKS() { try { return JSON.parse(localStorage.getItem('fufumidi_ksmap') || '{}') || {}; } catch (e) { return {}; } }
function saveKS(m) { localStorage.setItem('fufumidi_ksmap', JSON.stringify(m)); }
const ksMap = ref(loadKS());
/* P1-3 演奏法库：内置 + 用户自定义（core/articulations.js），可另存/删除并绑定到轨道 */
const articulations = ref(listArticulations());
function reloadArticulations() { articulations.value = listArticulations(); }
const ksPreset = ref('');
const ksLibName = ref('');
const ksOpen = ref(false);
const ksDraft = ref({});

// 音频对齐（载入原音频 → 波形/吸附起音/试听）
const audioData = ref(null);
const audioSyncOn = ref(false);
let audioEl = null;

// 智能量化弹窗
const sqOpen = ref(false);
const sqGrid = ref(8);
const sqGroove = ref('none');
const sqStrength = ref(60);

// 逻辑编辑器弹窗
const logicOpen = ref(false);
const logicTarget = ref('sel');
const logicCond = ref('vel_lt');
const logicCondVal = ref(40);
const logicAction = ref('vel_inc');
const logicActVal = ref(20);

// 宏面板弹窗
const macroOpen = ref(false);
const customMacros = ref([]);
const macroName = ref('');
const macroCmd = ref('');
const recording = ref(false);
const recordLines = ref([]);

// CC 事件列表 / 撤销历史 / 歌词编辑 / 帮助
const ccListOpen = ref(false);
const historyOpen = ref(false);
const lyricOpen = ref(false);
const lyricText = ref('');
const helpOpen = ref(false);

// 撤销历史快照
function openHistory() { historyOpen.value = true; }
const historyList = computed(() => (editor.value ? editor.value.historySnapshots() : []).slice().reverse());

/* ---- 批量操作 ---- */
function selectChordBatch() {
  const tr = song.value?.tracks[trackIndex.value];
  if (!tr || !editor.value?.selCount()) { toast(t('请先选中一个音符'), 'warn'); return; }
  const arr = editor.value.selRef();
  const ref0 = arr[0];
  const eps = Math.max(0.005, (ref0.end - ref0.start) * 0.5);
  const hits = tr.notes.filter(n => Math.abs(n.start - ref0.start) <= eps || Math.abs(n.end - ref0.end) <= eps);
  editor.value.selectNotes(hits);
  refreshSel();
  toast(t('已选择 ') + hits.length + t(' 个和弦音符'), 'ok');
}
function deleteShortNotes() {
  const s = song.value, tr = s?.tracks[trackIndex.value];
  if (!tr || !tr.notes.length) return;
  const sec = 0.08, bpm = s.initialBpm || 120;
  const short = tr.notes.filter(n => (n.end - n.start) / s.tpb * (60 / bpm) < sec);
  if (!short.length) { toast(t('当前轨道没有短于 80ms 的音符'), 'ok'); return; }
  editor.value.pushStateForTrack(trackIndex.value);
  removeNotes([tr], new Set(short));
  editor.value.notifyExternalEdit();
  toast(t('已删除 ') + short.length + t(' 个短音'), 'ok');
}
function loudScale(f) {
  const tr = song.value?.tracks[trackIndex.value];
  if (!tr) return;
  const arr = editor.value?.selCount() ? editor.value.selRef() : tr.notes;
  if (!arr.length) { toast(t('没有可处理的音符'), 'warn'); return; }
  editor.value.pushStateForTrack(trackIndex.value);
  // 选区可能是整轨（一屏几万个音符），此时直接对全轨生效，省掉 Set 与逐音符成员判断
  const sel = arr === tr.notes ? null : new Set(arr);
  for (const n of tr.notes) if (!sel || sel.has(n)) n.vel = clamp(Math.round(n.vel * f), 1, 127);
  editor.value.notifyExternalEdit();
  toast(t('已调整响度 ') + (f > 1 ? '+' : '') + Math.round((f - 1) * 100) + '%', 'ok');
}
function applyBpm() {
  const s = song.value;
  if (!s) { toast(t('请先载入 MIDI'), 'warn'); return; }
  const bpm = clamp(bpmInput.value || 120, 20, 400);
  const us = Math.round(60e6 / bpm);
  const map = s.tempoMap;
  for (const e of map) e.us = us;
  // 重算时间映射
  for (let i = 1; i < map.length; i++) map[i].sec = map[i - 1].sec + (map[i].tick - map[i - 1].tick) * map[i - 1].us / 1e6 / s.tpb;
  s.baseSec = (function (m, tpb, orig) {
    return function (tick) {
      let seg = m[0];
      for (let i = m.length - 1; i >= 0; i--) if (m[i].tick <= tick) { seg = m[i]; break; }
      return seg.sec + (tick - seg.tick) * seg.us / 1e6 / tpb;
    };
  })(map, s.tpb);
  s.totalSec = s.baseSec(s.totalTicks);
  s.initialBpm = bpm;
  const { player } = ensureAudio();
  player.load(s);
  player.setScale(state.tempo);
  toast(t('BPM 已应用到歌曲：') + bpm, 'ok');
}

/* ---- 智能伴奏 ---- */
function analyzeBarsForChords(s) {
  const tpb = s.tpb, bars = Math.max(1, s.bars);
  const chordBars = [];
  for (let b = 0; b < bars; b++) {
    const t0 = b * tpb * 4, t1 = t0 + tpb * 4;
    const hist = new Array(12).fill(0);
    for (const tr of s.tracks) {
      if (tr.isDrum) continue;
      for (const n of tr.notes) if (n.end > t0 && n.start < t1) hist[((n.midi % 12) + 12) % 12]++;
    }
    let root = 0, max = 0;
    for (let i = 0; i < 12; i++) if (hist[i] > max) { max = hist[i]; root = i; }
    const minor = hist[(root + 3) % 12] >= hist[(root + 4) % 12];
    chordBars.push({ root, minor, strong: max > 0 });
  }
  return chordBars;
}
function addAccompaniment() {
  const s = song.value;
  if (!s) { toast(t('请先载入 MIDI'), 'warn'); return; }
  const tpb = s.tpb, bars = Math.max(1, s.bars);
  const chords = analyzeBarsForChords(s);
  const bass = [], arp = [], pad = [];
  for (let b = 0; b < bars; b++) {
    const c = chords[b];
    const barT = b * tpb * 4;
    const third = c.minor ? 3 : 4;
    const tones = [c.root, c.root + third, c.root + 7];
    const rootMidi = clamp(36 + c.root, 28, 55);
    for (let q = 0; q < 4; q++) {
      const t = barT + q * tpb;
      bass.push({ start: t, end: t + tpb * 0.9, midi: rootMidi, vel: c.strong ? 92 : 70 });
    }
    for (let e = 0; e < 8; e++) {
      const t = barT + e * tpb / 2;
      const deg = [0, 1, 2, 1][e % 4];
      const m = clamp(48 + c.root + (tones[deg % 3] - c.root) + (deg >= 2 ? 12 : 0), 48, 88);
      arp.push({ start: t, end: t + tpb * 0.45, midi: m, vel: c.strong ? 72 : 58 });
    }
    for (let i = 0; i < 3; i++) {
      const m = clamp(52 + tones[i], 40, 84);
      pad.push({ start: barT, end: barT + tpb * 4, midi: m, vel: 55 });
    }
  }
  const nextIdx = s.tracks.length;
  editor.value.pushStateForTrack(-1); // 全量快照，撤销可还原新增轨道
  s.tracks.push({ index: nextIdx, name: t('智能贝斯'), ch: 2, program: 33, isDrum: false, notes: bass, events: [], ccs: [] });
  s.tracks.push({ index: nextIdx + 1, name: t('智能分解和弦'), ch: 1, program: 26, isDrum: false, notes: arp, events: [], ccs: [] });
  s.tracks.push({ index: nextIdx + 2, name: t('智能铺底'), ch: 3, program: 49, isDrum: false, notes: pad, events: [], ccs: [] });
  editor.value.notifyExternalEdit();
  toast(t('已生成智能伴奏：贝斯 / 分解和弦 / 铺底 3 轨（Ctrl+Z 可撤销）'), 'ok');
}

/* ---- 智能量化 + Groove ---- */
function openSmartQuantize() { if (song.value) sqOpen.value = true; else toast(t('请先载入 MIDI'), 'warn'); }
function extractGroove() {
  const notes = editor.value?.selNotes();
  if (!notes || !notes.length) { toast(t('请先选中要提取 Groove 的音符'), 'err'); return; }
  const gridTicks = (song.value.tpb || 480) * 4 / (sqGrid.value || 8);
  const offsets = notes.map(n => { const ideal = Math.round(n.start / gridTicks) * gridTicks; return (n.start - ideal) / gridTicks; });
  localStorage.setItem('fufumidi_custom_groove', JSON.stringify(offsets));
  toast(t('已提取自定义 Groove：') + offsets.length + t(' 个偏移'), 'ok');
}
function applySmartQuantize() {
  const s = song.value; if (!s) return;
  const tpb = s.tpb, gridTicks = tpb * 4 / (sqGrid.value || 8);
  const strength = (sqStrength.value || 0) / 100;
  const notes = editor.value?.selCount() ? editor.value.selRef() : s.tracks.reduce((a, t) => a.concat(t.notes), []);
  if (!notes.length) { toast(t('没有可处理的音符'), 'warn'); return; }
  editor.value.pushStateForTrack(editor.value?.selCount() ? trackIndex.value : -1);
  let count = 0;
  for (const n of notes) {
    const ideal = Math.round(n.start / gridTicks) * gridTicks;
    let offset = 0;
    if (sqGroove.value !== 'none') {
      const step = Math.round(n.start / gridTicks);
      const alt = step % 2;
      const g = sqGroove.value;
      if (g === 'funk') offset = alt ? gridTicks * 0.18 : 0;
      else if (g === 'jazz') offset = alt ? gridTicks * 0.24 : 0;
      else if (g === 'rock') offset = alt ? gridTicks * 0.12 : 0;
      else if (g === 'latin') offset = alt ? -gridTicks * 0.12 : gridTicks * 0.06;
      else if (g === 'custom') { try { const arr = JSON.parse(localStorage.getItem('fufumidi_custom_groove') || '[]'); if (arr.length) offset = (arr[step % arr.length] || 0) * gridTicks; } catch (e) {} }
    }
    const target = Math.max(0, Math.round(ideal + offset * strength));
    n.end = n.end - n.start + target;
    n.start = target;
    count++;
  }
  editor.value.notifyExternalEdit();
  sqOpen.value = false;
  toast(t('已量化 ') + count + t(' 个音符'), 'ok');
}
/* ---- 逻辑编辑器 ---- */
function openLogicEditor() { if (song.value) logicOpen.value = true; else toast(t('请先载入 MIDI'), 'warn'); }
function applyLogic() {
  const s = song.value; if (!s) return;
  const tpb = s.tpb;
  let notes = [];
  if (logicTarget.value === 'sel') notes = editor.value?.selRef() || [];
  else if (logicTarget.value === 'track') notes = s.tracks[trackIndex.value]?.notes.slice() || [];
  else for (const tr of s.tracks) notes = notes.concat(tr.notes);
  if (!notes.length) { toast(t('目标区间没有音符'), 'warn'); return; }
  const condVal = parseFloat(logicCondVal.value) || 0;
  const actVal = parseFloat(logicActVal.value) || 0;
  const cond = logicCond.value, action = logicAction.value;
  let changed = 0;
  if (action === 'delete') {
    // 删除目标内满足条件的音符。此前对每个音符做 tracks.find(t => t.notes.includes(n)) +
    // indexOf + splice：全曲 2 万音符时是数亿次比较，且每次 splice 还要搬移尾部。
    // 先把命中的音符收成一个集合，再让每条轨道各走一趟。
    const doomed = new Set();
    for (const n of notes) {
      let ok = false;
      if (cond === 'vel_lt') ok = n.vel < condVal;
      else if (cond === 'vel_gt') ok = n.vel > condVal;
      else if (cond === 'dur_lt') ok = (n.end - n.start) < condVal;
      else if (cond === 'pitch_eq') ok = n.midi === condVal;
      else ok = true;
      if (ok) doomed.add(n);
    }
    changed = removeNotes(s.tracks, doomed);
  } else {
    for (const n of notes) {
      let ok = false;
      if (cond === 'vel_lt') ok = n.vel < condVal;
      else if (cond === 'vel_gt') ok = n.vel > condVal;
      else if (cond === 'dur_lt') ok = (n.end - n.start) < condVal;
      else if (cond === 'pitch_eq') ok = n.midi === condVal;
      else ok = true;
      if (!ok) continue;
      if (action === 'vel_inc') n.vel = clamp(n.vel + actVal, 1, 127);
      else if (action === 'vel_dec') n.vel = clamp(n.vel - actVal, 1, 127);
      else if (action === 'vel_fix') n.vel = clamp(actVal, 1, 127);
      else if (action === 'quantize') { const st = Math.round(n.start / tpb) * tpb; n.end = n.end - n.start + st; n.start = st; }
      else if (action === 'transpose') n.midi = clamp(n.midi + actVal, 0, 127);
      changed++;
    }
  }
  editor.value.pushStateForTrack(logicTarget.value === 'all' ? -1 : trackIndex.value);
  editor.value.notifyExternalEdit();
  logicOpen.value = false;
  toast(t('已处理 ') + changed + t(' 个音符'), changed ? 'ok' : 'err');
}

/* ---- 宏系统 ---- */
function recordCmd(cmd) {
  if (recording.value && cmd) recordLines.value.push(cmd);
}
function toggleRecording() {
  recording.value = !recording.value;
  if (!recording.value && recordLines.value.length) {
    macroCmd.value = recordLines.value.join('\n');
    toast(t('已停止录制，共捕获 ') + recordLines.value.length + t(' 条操作'), 'ok');
  } else if (recording.value) {
    recordLines.value = [];
    toast(t('开始录制宏操作'), 'ok');
  }
}
function clearRecorded() { recordLines.value = []; }
function loadCustomMacros() { try { return JSON.parse(localStorage.getItem('fufumidi_custom_macros') || '[]') || []; } catch (e) { return []; } }
function saveCustomMacros(arr) { localStorage.setItem('fufumidi_custom_macros', JSON.stringify(arr)); }
function openMacroPanel() { customMacros.value = loadCustomMacros(); macroOpen.value = true; }
function runMacro(name) {
  const s = song.value; if (!s) return;
  const selection = name === 'normalize_vel' && editor.value?.selCount() ? editor.value.selRef() : null;
  const script = macroToCmd(name);
  const result = applyMacroScript(s, script, { selection });
  if (name === 'normalize_vel' && !result.changed) {
    toast(t('没有可处理的音符'), 'err');
    return;
  }
  recordCmd(script);
  editor.value.pushStateForTrack(name === 'normalize_vel' && editor.value?.selCount() ? trackIndex.value : -1);
  editor.value.notifyExternalEdit();
  macroOpen.value = false;
  toast(t('宏已执行，处理 ') + result.changed + t(' 个音符'), 'ok');
}
function addCustomMacro() {
  const name = macroName.value.trim(), cmd = macroCmd.value.trim();
  if (!name || !cmd) { toast(t('请填写宏名称和命令'), 'err'); return; }
  const arr = loadCustomMacros(); arr.push({ name, cmd }); saveCustomMacros(arr);
  customMacros.value = arr; macroName.value = ''; macroCmd.value = '';
  toast(t('自定义宏已保存'), 'ok');
}
function runCustomMacro(cmd) {
  const s = song.value; if (!s) return;
  const lines = parseMacroScript(cmd);
  if (recording.value) for (const line of lines) recordCmd(line);
  const selection = editor.value?.selCount() ? editor.value.selRef() : null;
  const result = applyMacroScript(s, lines, { selection });
  editor.value.pushStateForTrack(-1);
  editor.value.notifyExternalEdit();
  macroOpen.value = false;
  toast(t('自定义宏已执行，处理 ') + result.changed + t(' 个音符'), 'ok');
}
function delCustomMacro(i) {
  const arr = loadCustomMacros(); arr.splice(i, 1); saveCustomMacros(arr); customMacros.value = arr;
}

/* ---- Key Switch ---- */
function openKSMap() { reloadArticulations(); ksDraft.value = { ...ksMap.value }; ksPreset.value = ''; ksLibName.value = ''; ksOpen.value = true; }
/** 应用某个库（内置或用户）到草稿 */
function applyKSPreset() {
  if (!ksPreset.value) return;
  ksDraft.value = applyArticulation(ksDraft.value, ksPreset.value);
}
/** 把当前草稿另存为用户库 */
function saveArticulationLib() {
  const item = upsertUserArticulation(ksLibName.value, ksDraft.value);
  if (!item) { toast(t('请先填写库名称'), 'warn'); return; }
  reloadArticulations();
  ksPreset.value = item.id;
  ksLibName.value = '';
  toast(t('已保存演奏法库「') + item.name + '」', 'ok');
}
function delArticulationLib(id) {
  const lib = articulations.value.find(a => a.id === id);
  if (!lib || lib.builtin) return;
  removeUserArticulation(id);
  reloadArticulations();
  if (ksPreset.value === id) ksPreset.value = '';
  toast(t('已删除演奏法库'), 'ok');
}
/** 把当前映射绑定到编辑中的轨道；切换轨道时自动套用 */
function bindArticulationToTrack() {
  const s = song.value, tr = s && s.tracks[trackIndex.value];
  if (!tr) return;
  if (!ksPreset.value) { toast(t('请先选择一个演奏法库'), 'warn'); return; }
  tr.artSet = ksPreset.value;
  toast(t('已绑定到轨道「') + (tr.name || '') + t('」'), 'ok');
}
function saveKSMap() {
  const map = {};
  for (const m of Object.keys(ksDraft.value)) if (ksDraft.value[m] && +m <= 24) map[+m] = ksDraft.value[m];
  ksMap.value = map; saveKS(map);
  ksOpen.value = false;
  toast(t('Key Switch 映射已保存'), 'ok');
}
// 切换轨道：若该轨绑定了演奏法库，自动套用（不覆盖手动映射时用户可再手动保存）
watch(trackIndex, () => {
  const s = song.value, tr = s && s.tracks[trackIndex.value];
  if (!tr || !tr.artSet) return;
  const next = applyArticulation(ksMap.value, tr.artSet);
  if (JSON.stringify(next) !== JSON.stringify(ksMap.value)) { ksMap.value = next; saveKS(next); }
});

/* ---- CC 事件列表 ---- */
const ccListItems = computed(() => {
  const tr = song.value?.tracks[trackIndex.value];
  return (tr && (tr.ccs || []).slice().sort((a, b) => a.tick - b.tick)) || [];
});
function openCCList() { ccListOpen.value = true; }
function delCCItem(i) {
  const tr = song.value?.tracks[trackIndex.value]; if (!tr) return;
  editor.value.pushStateForTrack(trackIndex.value);
  tr.ccs.splice(i, 1);
  editor.value.notifyExternalEdit();
}

/* ---- 歌词编辑（添加到选中音符） ---- */
function openLyricEditor() {
  const n = editor.value?.selCount();
  if (!n) { toast(t('请先在钢琴卷帘中选择音符'), 'warn'); return; }
  lyricText.value = '';
  lyricOpen.value = true;
}
function addLyricToSel() {
  const s = song.value, text = lyricText.value.trim();
  if (!s || !text) { toast(t('请输入歌词'), 'warn'); return; }
  const notes = editor.value?.selNotes();
  if (!notes || !notes.length) return;
  const tr = s.tracks[trackIndex.value];
  editor.value.pushStateForTrack(trackIndex.value);
  for (const n of notes) tr.events.push({ tick: n.start, type: 'lyric', text });
  tr.events.sort((a, b) => a.tick - b.tick);
  editor.value.notifyExternalEdit();
  lyricOpen.value = false;
  toast(t('已为 ') + notes.length + t(' 个音符添加歌词'), 'ok');
}

/* ---- 音频对齐 ---- */
async function loadAudio() {
  if (!bridge || !bridge.pickAudio) { toast(t('请使用桌面版选择音频'), 'warn'); return; }
  const p = await bridge.pickAudio();
  if (!p) return;
  try {
    const buf = await bridge.readBinary(p);
    if (!buf) { toast(t('无法读取音频文件'), 'err'); return; }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const audioBuf = await ctx.decodeAudioData(ab);
    audioData.value = { data: audioBuf.getChannelData(0), rate: audioBuf.sampleRate };
    audioCtx = ctx;
    toast(t('音频已载入，可在卷帘底部查看波形'), 'ok');
  } catch (e) { toast(t('音频解码失败：') + (e.message || e), 'err'); }
}
function snapAudio() {
  if (!audioData.value) { toast(t('请先载入原音频'), 'warn'); return; }
  const n = editor.value?.snapSelToAudio() || 0;
  toast(n ? t('已吸附 ') + n + t(' 个音符到波形起音') : t('没有可吸附的音符（需载入音频）'), n ? 'ok' : 'warn');
}
async function toggleAudioSync() {
  const s = song.value; if (!s) return;
  if (audioSyncOn.value) { if (audioEl) { audioEl.pause(); audioEl = null; } audioSyncOn.value = false; toast(t('已停止试听'), 'ok'); return; }
  if (!audioData.value) { toast(t('请先载入原音频'), 'warn'); return; }
  try {
    const p = await bridge.pickAudio();
    if (!p) return;
    const buf = await bridge.readBinary(p);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const blob = new Blob([ab], { type: 'audio/wav' });
    if (!audioEl) audioEl = new Audio(URL.createObjectURL(blob));
    else audioEl.src = URL.createObjectURL(blob);
    audioEl.play();
    audioSyncOn.value = true;
    toast(t('试听中（播放 MIDI 同时播放原音频）'), 'ok');
  } catch (e) { toast(t('音频试听失败：') + (e.message || e), 'err'); }
}

/* ---- 音色 ---- */
const GM_NAMES = {
  0:'Acoustic Grand Piano',1:'Bright Piano',4:'Electric Piano',5:'Honky-tonk',6:'Electric Piano 2',7:'Harpsichord',8:'Clavinet',11:'Music Box',
  12:'Marimba',13:'Xylophone',14:'Tubular Bells',15:'Dulcimer',16:'Drawbar Organ',17:'Percussive Organ',19:'Church Organ',20:'Reed Organ',
  24:'Acoustic Guitar Nylon',25:'Acoustic Guitar Steel',26:'Electric Guitar Jazz',27:'Electric Guitar Clean',28:'Electric Guitar Muted',29:'Overdriven Guitar',30:'Distortion Guitar',31:'Guitar Harmonics',
  32:'Acoustic Bass',33:'Electric Bass Finger',34:'Electric Bass Pick',35:'Fretless Bass',36:'Slap Bass 1',38:'Synth Bass 1',39:'Synth Bass 2',
  40:'Violin',41:'Viola',42:'Cello',43:'Contrabass',44:'Tremolo Strings',45:'Pizzicato Strings',46:'Orchestral Harp',47:'Timpani',48:'String Ensemble 1',49:'String Ensemble 2',50:'Synth Strings 1',
  52:'Choir Aahs',53:'Voice Oohs',54:'Synth Voice',55:'Orchestra Hit',
  56:'Trumpet',57:'Trombone',58:'Tuba',59:'Muted Trumpet',60:'French Horn',61:'Brass Section',62:'Synth Brass 1',63:'Synth Brass 2',
  64:'Soprano Sax',65:'Alto Sax',66:'Tenor Sax',67:'Baritone Sax',68:'Oboe',69:'English Horn',70:'Bassoon',71:'Clarinet',72:'Piccolo',73:'Flute',74:'Recorder',75:'Pan Flute',76:'Blown Bottle',77:'Shakuhachi',78:'Whistle',79:'Ocarina',
  80:'Lead 1 Square',81:'Lead 2 Sawtooth',82:'Lead 3 Calliope',88:'Pad 1 New Age',89:'Pad 2 Warm',91:'Pad 4 Choir',95:'Pad 7 Halo',
  103:'FX 7 Echoes',104:'Sitar',105:'Banjo',106:'Shamisen',107:'Koto',108:'Kalimba',109:'Bagpipe',110:'Fiddle',111:'Shanai',
  112:'Tinkle Bell',113:'Agogo',114:'Steel Drums',115:'Woodblock',116:'Taiko Drum',117:'Melodic Tom',118:'Synth Drum',119:'Reverse Cymbal',
};
function loadTimbreFavs() {
  try { return new Set(JSON.parse(localStorage.getItem('fufumidi_timbre_favs') || '[]')); } catch (e) { return new Set(); }
}
const timbreFavs = ref(loadTimbreFavs());
function toggleTimbreFav() {
  const p = Number(timbre.value);
  const s = new Set(timbreFavs.value);
  if (s.has(p)) s.delete(p); else s.add(p);
  timbreFavs.value = s;
  try { localStorage.setItem('fufumidi_timbre_favs', JSON.stringify([...s])); } catch (e) {}
  toast(s.has(p) ? t('已收藏音色：') + (GM_NAMES[p] || p) : t('已取消收藏音色'), 'ok');
}
function timbreChange() {
  const tr = song.value?.tracks[trackIndex.value]; if (!tr) return;
  tr.program = timbre.value;
  const { player } = ensureAudio();
  player.load(song.value); player.setScale(state.tempo);
  toast(t('音色已切换：') + (GM_NAMES[timbre.value] || (t('音色 ') + timbre.value)), 'ok');
}
function timbreAll() {
  const s = song.value; if (!s) return;
  for (const tr of s.tracks) if (!tr.isDrum) tr.program = timbre.value;
  const { player } = ensureAudio();
  player.load(s); player.setScale(state.tempo);
  toast(t('已把当前音色应用到全部非鼓轨'), 'ok');
}
function smartTimbre() {
  const tr = song.value?.tracks[trackIndex.value]; if (!tr) return;
  // 按音域/密度/名称智能选择
  const notes = tr.notes;
  if (!notes.length) { toast(t('当前轨道没有音符'), 'warn'); return; }
  const lo = Math.min(...notes.map(n => n.midi)), hi = Math.max(...notes.map(n => n.midi));
  const name = (tr.name || '').toLowerCase();
  let p = 0;
  if (/bass|贝斯|低音/.test(name) || lo < 40) p = 33;
  else if (/drum|鼓|打击/.test(name) || tr.isDrum) p = 0;
  else if (/violin|小提琴/.test(name)) p = 40;
  else if (/cello|大提琴/.test(name)) p = 42;
  else if (/guitar|吉他/.test(name)) p = 24;
  else if (/flute|长笛|笛/.test(name)) p = 73;
  else if (/trumpet|小号/.test(name)) p = 56;
  else if (/string|弦乐/.test(name) || (hi - lo > 48)) p = 48;
  else if (/organ|风琴/.test(name)) p = 19;
  else if (/piano|钢琴/.test(name)) p = 0;
  else p = hi > 72 ? 80 : hi > 60 ? 0 : 40;
  timbre.value = p;
  tr.program = p;
  const { player } = ensureAudio();
  player.load(song.value); player.setScale(state.tempo);
  toast(t('智能音色：') + (GM_NAMES[p] || p), 'ok');
}

/* ------------------------------------------------------------ 检查器宽度 / 折叠
 * ★ 右侧检查器固定 232px，占的是音符视图的宽度 —— 用户反馈「音符视图面积太小」。
 *   这里给两个自由度：可以拖分隔条改宽窄，也可以整块收起来（收起后舞台独享全宽）。 */
// 检查器开关/宽度现在由工作区统一持有（stores/workspace.ts），旧键在它内部做过迁移
const inspOpen = computed({
  get: () => ws.layout.inspOpen,
  set: (v) => { ws.layout.inspOpen = !!v; },
});
const inspW = computed({
  get: () => ws.layout.inspW,
  set: (v) => { ws.layout.inspW = Math.max(0, Math.round(v || 0)); },
});
const mainStyle = computed(() => (inspW.value >= 140 ? { '--inspector-w': inspW.value + 'px' } : {}));
// ★ 这个 SFC 是**普通 JS**（没有 lang="ts"），别写类型标注 —— 会直接编译失败
function startInspResize(e) {
  const aside = document.querySelector('.ed-insp');
  if (!aside) return;
  const startX = e.clientX;
  const startW = aside.getBoundingClientRect().width;
  const move = (ev) => {
    inspW.value = Math.round(Math.max(150, Math.min(window.innerWidth - 420, startW - (ev.clientX - startX))));
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    ws.save();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/* ---- 全屏编辑 ---- */
function toggleFullscreen() {
  fullscreenOn.value = !fullscreenOn.value;
  const el = document.querySelector('.edit-view');
  if (el) el.classList.toggle('ed-fullscreen', fullscreenOn.value);
}

/* ---- 视频轨道嵌入（影视配乐对齐） ---- */
const videoUrl = ref('');
async function loadVideo() {
  if (!bridge || !bridge.pickFile) { toast(t('请使用桌面版选择视频'), 'warn'); return; }
  const p = await bridge.pickFile({ title: t('选择视频文件'), filters: [{ name: t('视频'), extensions: ['mp4', 'webm', 'mkv', 'mov', 'avi'] }] });
  if (!p) return;
  videoUrl.value = 'file://' + p.replace(/\\/g, '/');
  toast(t('视频已嵌入编辑区，播放 MIDI 时自动同步'), 'ok');
}
function removeVideo() { videoUrl.value = ''; toast(t('已移除视频轨道'), 'ok'); }

function newMidi() {
  const mid = { ticksPerBeat: 480, format: 1, tracks: [{ name: t('音轨 1'), ch: 0, program: 0, events: [], notes: [], ccs: [] }] };
  const bytes = encodeMidi(mid.tracks, { division: 480 });
  importFiles([{ name: t('未命名.mid'), bytes }]);
  toast(t('已新建空白 MIDI'), 'ok');
}
async function exportMidi() {
  const s = song.value;
  if (!s) { toast(t('请先载入 MIDI'), 'warn'); return; }
  try {
    const bytes = encodeMidi(s.tracks, { division: s.tpb, tempoMap: s.tempoMap, sigMap: s.sigMap });
    if (bridge && bridge.saveBinary) {
      const r = await bridge.saveBinary({ name: s.name + '.mid', data: Array.from(bytes) });
      if (r && r.ok) toast(t('已导出 MIDI'), 'ok');
      else if (!(r && r.canceled)) toast(t('导出失败：') + ((r && r.error) || ''), 'warn');
    } else {
      const blob = new Blob([bytes], { type: 'audio/midi' });
      const a = document.createElement('a');
      a.download = s.name + '.mid'; a.href = URL.createObjectURL(blob); a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast(t('已导出 MIDI'), 'ok');
    }
  } catch (e) { toast(t('导出失败：') + (e.message || e), 'warn'); }
}

/* ---------------- 迷你图 ---------------- */
// 迷你图是「静态缩略图」：把小节块预渲染到离屏画布并缓存，之后每次只贴一次图。
// 原实现被无条件放进 rAF 循环，每帧遍历全曲所有音符（大 MIDI 9 万+ 次 fillRect/帧），
// 且组件被 KeepAlive 保活后离开编辑页仍在跑 —— 这是「整个界面卡」的主因。
const MINI_C = ['#ff5530', '#ea5ec1', '#1456f0', '#a855f7', '#3daeff', '#1ba673', '#3b82f6', '#f59e0b', '#d45656', '#17437d'];
let miniRev = 0;                       // 内容版本：只在真正改动曲目时 +1
let _miniCache = { key: '', cv: null };
function drawMini() {
  const cv = miniEl.value, s = song.value;
  if (!cv || !s) return;
  const W = cv.clientWidth || 600, H = 34;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.floor(W * dpr) || cv.height !== Math.floor(H * dpr)) { cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  let count = 0;
  for (const tr of s.tracks) count += tr.notes.length;
  const key = W + '|' + dpr + '|' + s.totalTicks + '|' + count + '|' + miniRev;
  if (!_miniCache.cv || _miniCache.key !== key) {
    const off = document.createElement('canvas');
    off.width = Math.floor(W * dpr); off.height = Math.floor(H * dpr);
    const og = off.getContext('2d');
    og.setTransform(dpr, 0, 0, dpr, 0, 0);
    const scale = W / s.totalTicks;
    for (const tr of s.tracks) {
      og.fillStyle = MINI_C[tr.index % MINI_C.length];
      for (const n of tr.notes) {
        const x = n.start * scale, w2 = Math.max(1, (n.end - n.start) * scale);
        og.fillRect(x, 12 + (tr.index % 2) * 8, w2, 4);
      }
    }
    _miniCache = { key, cv: off };
  }
  g.clearRect(0, 0, W, H);
  g.fillStyle = cssVar('--surface-soft', 'rgba(10,10,10,0.04)'); g.fillRect(0, 0, W, H);
  g.drawImage(_miniCache.cv, 0, 0, W, H);
  g.fillStyle = 'rgba(255,85,48,0.5)'; g.fillRect(0, 0, 2, H);
}
function miniClick(e) {
  const cv = miniEl.value, s = song.value;
  if (!cv || !s) return;
  const rect = cv.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const tick = x / rect.width * s.totalTicks;
  editor.value?.setViewTick(Math.max(0, tick - s.totalTicks * 0.15));
}

/* ---------------- 快捷键 ---------------- */
function onKey(e) {
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'z') { e.preventDefault(); undo(); return; }
  if (mod && e.key === 'y') { e.preventDefault(); redo(); return; }
  if (mod && e.key === 'a') { e.preventDefault(); selectAll(); return; }
  if (mod && e.key === 'c') { e.preventDefault(); copy(); return; }
  if (mod && e.key === 'v') { e.preventDefault(); paste(); return; }
  if (mod && e.key === 's') { e.preventDefault(); exportMidi(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { del(); return; }
  if (stepOn.value && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); editor.value?.stepBy(e.key === 'ArrowRight' ? 1 : -1); return; }
  if (stepOn.value && e.key === 'Escape') { stepOn.value = false; return; }
  if (e.key === '?' || e.key === 'F1') { e.preventDefault(); shortcutsOpen.value = !shortcutsOpen.value; return; }
  if (mod && e.shiftKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); palOpen.value = true; return; }
  const k = e.key.toLowerCase();
  if (k === 'v') tool.value = 'select';
  else if (k === 'b') tool.value = 'pencil';
  else if (k === 'e') tool.value = 'erase';
}

let raf = 0;
let stageActive = true;
let miniRo = null;
function drawStage() {
  if (viewMode.value === 'drum') drawDrum(); else drawMini();
}
// 迷你图 / 鼓组网格都是「静态图」，不需要每帧重绘：改为按需调度（内容或尺寸变化时）。
// 原实现是无条件 rAF 循环，被 KeepAlive 保活后离开编辑页仍在遍历全曲音符 → 整个应用卡顿。
function scheduleDraw() {
  if (raf || !stageActive) return;
  raf = requestAnimationFrame(() => { raf = 0; drawStage(); });
}
// 真正改动曲目：迷你图缓存失效 + 重绘（选区变化不重建缩略图）
function onModified() { miniRev++; refreshSel(); scheduleDraw(); }

watch(currentSong, () => {
  const tracks = song.value?.tracks || [];
  const nonEmpty = tracks.findIndex(t => t.notes && t.notes.length);
  trackIndex.value = nonEmpty >= 0 ? nonEmpty : Math.min(trackIndex.value, Math.max(0, tracks.length - 1));
  viewMode.value = 'piano';
  refreshSel();
  const tr = song.value?.tracks[trackIndex.value];
  if (tr) { timbre.value = tr.program != null ? tr.program : 0; }
  if (song.value) bpmInput.value = song.value.initialBpm || 120;
  miniRev++;
  _miniCache = { key: '', cv: null };
  nextTick(scheduleDraw);
}, { immediate: true });
watch(trackIndex, () => {
  trackIndex.value = Math.min(trackIndex.value, Math.max(0, (song.value?.tracks.length || 1) - 1));
  refreshSel();
  const tr = song.value?.tracks[trackIndex.value];
  if (tr) { timbre.value = tr.program != null ? tr.program : 0; }
  scheduleDraw();
});

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  /* 调试桥（M3 起）：本项目的验收方式是「装好的应用 + CDP 驱动」，而生产包里拿不到
     组件实例（__vueParentComponent 只在 dev 有）。所以留一个显式开关：
     localStorage.fufumidi_debug = '1'（或 hash 里带 debug=1）时把画布 API 挂到 window。
     正常用户永远不会命中这条分支。 */
  try {
    if (localStorage.getItem('fufumidi_debug') === '1' || /[?&]debug=1/.test(location.hash)) {
      window.__fufumidiDebug = { editor: () => editor.value, app, ws, hoverInfo, midiToolOpen, palOpen, drumNames, stepOn, stepCursorTick, listOpen, listDraft, viewMode, sel };
    }
  } catch (e) {}
  await nextTick();
  // 布局尺寸变化（侧栏/播放栏开合、窗口缩放、检查器收窄）时重画舞台缩略图
  if (typeof ResizeObserver !== 'undefined' && miniWrap.value) {
    miniRo = new ResizeObserver(() => scheduleDraw());
    miniRo.observe(miniWrap.value);
  }
  refreshSel();
  scheduleDraw();
});
onActivated(() => { stageActive = true; scheduleDraw(); });
onDeactivated(() => { stageActive = false; if (raf) { cancelAnimationFrame(raf); raf = 0; } });
onBeforeUnmount(() => {
  stageActive = false;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  if (miniRo) { miniRo.disconnect(); miniRo = null; }
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="page edit-view">
    <div class="page-head">
      <div class="page-ic"><Icon name="edit" :size="20" /></div>
      <div class="grow">
        <div class="page-title">{{ t('编辑器') }}</div>
        <div class="page-sub">{{ t('钢琴卷帘 · 画笔点击添加 · 拖拽移动 · 边缘拉伸') }}</div>
      </div>
      <button class="btn sm primary" @click="exportMidi"><Icon name="save" :size="13" />{{ t('导出 MIDI') }}</button>
    </div>

    <div v-if="!currentSong" class="empty card">
      <div class="empty-ic"><Icon name="edit" :size="34" /></div>
      <b>{{ t('还没有载入曲目') }}</b>
      <p>{{ t('导入 MIDI 文件后即可在钢琴卷帘中逐音符精修：添加、移动、拉伸、量化、移调。') }}</p>
    </div>

    <template v-else>
      <!-- 工具栏 + 「更多」面板：面板改为浮层（绝对定位在工具栏下方），
           不再挤压下方钢琴卷帘的高度 —— 展开后卷帘高度保持不变 -->
      <!-- 菜单条（M1）：把「更多」里那些低频动作搬到稳定的菜单位置。
           工作区预设放在同一行的右端（Ableton 的 Views 位置）：不占舞台高度，也不挤 page-head -->
      <div class="card ed-menubar-card">
        <EditorMenuBar :groups="menuGroups" />
        <span class="mb-grow"></span>
        <div class="ed-presets" :title="t('工作区预设：一键切换面板布局（也能在「视图」菜单里切）')">
          <button v-for="p in ws.presets" :key="p.id" class="ps-chip" :class="{ on: ws.preset === p.id }"
                  :title="t(p.hint)" @click="applyPreset(p.id)">{{ t(p.label) }}</button>
        </div>
        <button class="st-btn" :title="t('快捷键一览（?）')" @click="shortcutsOpen = true"><Icon name="info" :size="12" />{{ t('快捷键') }}</button>
      </div>

      <div class="ed-toolbar-wrap">
      <div class="card ed-toolbar">
        <div class="et-group">
          <button class="et-btn" :class="{ active: tool === 'select' }" :title="t('选择 V')" @click="tool = 'select'"><Icon name="cursor" :size="14" />{{ t('选择') }}</button>
          <button class="et-btn" :class="{ active: tool === 'pencil' }" :title="t('画笔 B')" @click="tool = 'pencil'"><Icon name="pencil" :size="14" />{{ t('画笔') }}</button>
          <button class="et-btn" :class="{ active: tool === 'erase' }" :title="t('橡皮 E')" @click="tool = 'erase'"><Icon name="erase" :size="14" />{{ t('橡皮') }}</button>
          <button class="et-btn" :class="{ active: tool === 'mute' }" :title="t('静音：点击音符切换发声/静音（不删除、不改力度）')" @click="tool = 'mute'"><Icon name="minus" :size="14" />{{ t('静音') }}</button>
        </div>
        <span class="et-sep"></span>
        <!-- 步进输入（M4）：Cubase/Logic 的 Step Input —— 落音由指针决定并自动前进 -->
        <div class="et-group ed-step-group">
          <button class="et-btn" :class="{ active: stepOn }" data-guide="edit-step"
                  :title="t('步进输入：点击音符区按步长依次落音（← → 走指针，Esc 退出）')" @click="toggleStep">
            <Icon name="quantize" :size="14" />{{ t('步进') }}
          </button>
          <template v-if="stepOn">
            <select v-model.number="stepBeats" class="select-input" style="width:auto" :title="t('步长')">
              <option v-for="s in STEP_OPTS" :key="s[1]" :value="s[0]">{{ s[1] }}</option>
            </select>
            <span class="et-label ed-step-pos" :title="t('步进指针所在位置')">{{ stepCursorText }}</span>
            <button class="et-btn" :title="t('指针回到播放头')" @click="stepToPlayhead"><Icon name="target" :size="13" /></button>
            <button class="et-btn" :title="t('后退一步（←）')" @click="editor?.stepBy(-1)">←</button>
            <button class="et-btn" :title="t('前进一步（→）')" @click="editor?.stepBy(1)">→</button>
          </template>
        </div>
        <span class="et-sep"></span>
        <div class="et-group ed-view-switch">
          <button class="et-btn" :class="{ active: viewMode === 'piano' }" :title="t('钢琴卷帘视图')" @click="setEditorView('piano')"><Icon name="music" :size="14" />{{ t('钢琴') }}</button>
          <button class="et-btn" :class="{ active: viewMode === 'drum' }" :title="t('鼓组网格视图')" @click="setEditorView('drum')"><Icon name="drum" :size="14" />{{ t('鼓组') }}</button>
          <button class="et-btn" :class="{ active: viewMode === 'score' }" :title="t('乐谱编辑（可改 MIDI）：在五线谱上点选/拖动/插音符')" @click="setEditorView('score')"><Icon name="score" :size="14" />{{ t('乐谱') }}</button>
        </div>
        <span class="et-sep"></span>
        <button class="et-btn" :title="t('撤销 Ctrl+Z')" @click="undo"><Icon name="undo" :size="14" />{{ t('撤销') }}</button>
        <button class="et-btn" :title="t('重做 Ctrl+Y')" @click="redo"><Icon name="redo" :size="14" />{{ t('重做') }}</button>
        <button class="et-btn danger" :title="t('删除 Del')" @click="del"><Icon name="trash" :size="14" />{{ t('删除') }}</button>
        <span class="et-sep"></span>
        <button class="et-btn" :title="t('量化到吸附网格')" @click="quantize"><Icon name="quantize" :size="14" />{{ t('量化') }}</button>
        <!-- M2：参数化工具（拖动即预览）——放在量化旁边，因为它就是「量化」的泛化 -->
        <button class="et-btn" data-guide="edit-miditools" :title="t('参数化工具：移调/力度/时值/节奏/生成，拖动即预览，回车应用')"
                @click="openMidiTools"><Icon name="sliders" :size="14" />{{ t('参数工具') }}</button>
        <span class="et-sep"></span>
        <!-- 视图开关放主工具条：以前「全屏」藏在「更多」里，谁也没发现；
             这两个是「把音符区变大」的直接开关，必须一眼可见 -->
        <button class="et-btn" :class="{ active: !inspOpen }" :title="t('收起右侧检查器，把宽度让给音符视图')"
                @click="inspOpen = !inspOpen"><Icon name="panel" :size="14" />{{ inspOpen ? t('收起检查器') : t('检查器') }}</button>
        <button class="et-btn" :class="{ active: fullscreenOn }" :title="t('全屏编辑，最大化钢琴卷帘')" @click="toggleFullscreen"><Icon name="expand" :size="14" />{{ t('全屏') }}</button>
        <span class="et-sep"></span>
        <button class="et-btn et-more" data-guide="edit-more" :class="{ active: advOpen }" @click="advOpen = !advOpen">
          <Icon name="chevron" :size="13" :style="{ transform: advOpen ? 'rotate(180deg)' : '' }" /> {{ t('更多') }}
        </button>
      </div>

      <!-- 高级工具区（折叠，按用途分组） -->
      <div v-if="advOpen" class="card ed-adv">
        <div class="adv-row">
          <span class="et-label">{{ t('剪贴板') }}</span>
          <button class="et-btn" :title="t('复制 Ctrl+C')" @click="copy"><Icon name="copy" :size="14" />{{ t('复制') }}</button>
          <button class="et-btn" :title="t('粘贴到播放头 Ctrl+V')" @click="paste"><Icon name="paste" :size="14" />{{ t('粘贴') }}</button>
          <button class="et-btn" :title="t('克隆选区到其后')" @click="dup"><Icon name="plus" :size="14" />{{ t('克隆') }}</button>
          <button class="et-btn" :title="t('全选 Ctrl+A')" @click="selectAll"><Icon name="target" :size="14" />{{ t('全选') }}</button>
          <button class="et-btn" :title="t('同音高批量选择')" @click="samePitch"><Icon name="target" :size="14" />{{ t('同音高') }}</button>
          <button class="et-btn" :title="t('列表编辑器：精确修改音符数值')" @click="openList"><Icon name="list" :size="14" />{{ t('列表') }}</button>
        </div>
        <div class="adv-row">
          <span class="et-label">{{ t('力度') }}</span>
          <button class="et-btn" :title="t('选区力度渐强')" @click="velUp"><Icon name="cresc" :size="14" />{{ t('渐强') }}</button>
          <button class="et-btn" :title="t('选区力度渐弱')" @click="velDown"><Icon name="dim" :size="14" />{{ t('渐弱') }}</button>
          <button class="et-btn" :title="t('力度曲线：绘制力度包络并应用到选区')" @click="openVelCurve"><Icon name="chart" :size="14" />{{ t('力度曲线') }}</button>
          <button class="et-btn" :title="t('删除当前轨道短于 80ms 的音符')" @click="deleteShortNotes"><Icon name="trash" :size="14" />{{ t('删短音') }}</button>
          <button class="et-btn" :title="t('选区/整轨响度降低 10%')" @click="loudScale(0.9)"><Icon name="minus" :size="14" />-10%</button>
          <button class="et-btn" :title="t('选区/整轨响度提高 10%')" @click="loudScale(1.1)"><Icon name="plus" :size="14" />+10%</button>
        </div>
        <div class="adv-row">
          <span class="et-label">{{ t('移调') }}</span>
          <button class="et-btn" :title="t('降半音')" @click="trDown"><Icon name="minus" :size="14" />{{ t('半音') }} -1</button>
          <button class="et-btn" :title="t('升半音')" @click="trUp"><Icon name="plus" :size="14" />{{ t('半音') }} +1</button>
          <button class="et-btn" :title="t('降八度')" @click="octDown"><Icon name="minus" :size="14" />{{ t('八度') }} -8</button>
          <button class="et-btn" :title="t('升八度')" @click="octUp"><Icon name="plus" :size="14" />{{ t('八度') }} +8</button>
        </div>
        <div class="adv-row">
          <span class="et-label">{{ t('音阶') }}</span>
          <select class="select-input" :value="scaleRoot" style="width:auto" :title="t('主音（自动 = 按曲目判断）')" @change="e => scaleRoot = Number(e.target.value)">
            <option :value="-1">{{ t('自动') }}</option>
            <option v-for="r in ROOT_OPTIONS" :key="r[0]" :value="r[0]">{{ r[1] }}</option>
          </select>
          <select class="select-input" v-model="scaleType" style="width:auto" :title="t('音阶类型')">
            <option v-for="sc in SCALE_TYPES" :key="sc[0]" :value="sc[0]">{{ t(sc[1]) }}</option>
          </select>
          <input v-if="scaleType === 'custom'" v-model="customDegText" class="text-input" style="width:110px"
                 :placeholder="t('音级 0,2,4,7,9')" :title="t('自定义音级（相对主音的半音，逗号分隔）')" />
          <select class="select-input" v-model="scaleMode" style="width:auto" :title="t('调内编辑模式：高亮调内音 / 拖拽与新建只落在调内音')">
            <option v-for="m in SCALE_MODE_OPTIONS" :key="m[0]" :value="m[0]">{{ m[1] }}</option>
          </select>
          <button class="et-btn" :title="t('按曲目分析结果自动设调')" @click="scaleFromAnalysis"><Icon name="zap" :size="14" />{{ t('按分析设调') }}</button>
        </div>
        <div class="adv-row">
          <span class="et-label">{{ t('和弦') }}</span>
          <button class="et-btn" data-guide="edit-chord-analyze" :title="t('分析逐小节和弦并显示和弦轨（约束模式下与音阶一起决定调内音）')" @click="analyzeChordTrack"><Icon name="music" :size="14" />{{ t('分析和弦') }}</button>
          <button class="et-btn" :title="t('选中与当前音符同时发声的音符')" @click="selectChordBatch"><Icon name="music" :size="14" />{{ t('和弦批量') }}</button>
          <span class="et-sep"></span>
          <span class="et-label">BPM</span>
          <input v-model.number="bpmInput" class="num-input" type="number" min="20" max="400" step="1" style="width:62px" />
          <button class="et-btn" :title="t('应用为歌曲速度（改写 tempo 事件）')" @click="applyBpm"><Icon name="zap" :size="14" />{{ t('应用') }}</button>
        </div>
        <div class="adv-row">
          <span class="et-label">{{ t('生成') }}</span>
          <button class="et-btn" :title="t('基于当前旋律/和弦自动生成 贝斯+分解和弦+铺底')" @click="addAccompaniment"><Icon name="spark" :size="14" />{{ t('智能伴奏') }}</button>
          <button class="et-btn" :title="t('智能量化：网格 + Groove 模板')" @click="openSmartQuantize"><Icon name="quantize" :size="14" />{{ t('智能量化') }}</button>
        </div>
        <div class="adv-row">
          <span class="et-label">{{ t('批处理') }}</span>
          <button class="et-btn" :title="t('逻辑编辑器：批量规则处理音符')" @click="openLogicEditor"><Icon name="edit" :size="14" />{{ t('逻辑') }}</button>
          <button class="et-btn" :title="t('宏面板：一键执行常用批量处理')" @click="openMacroPanel"><Icon name="zap" :size="14" />{{ t('宏') }}</button>
          <button class="et-btn" :title="t('Key Switch 映射配置')" @click="openKSMap"><Icon name="kbd" :size="14" />{{ t('键位') }}</button>
          <button class="et-btn" :title="t('撤销历史')" @click="openHistory"><Icon name="clock" :size="14" />{{ t('历史') }}</button>
        </div>
        <div class="adv-row">
          <span class="et-label">{{ t('CC 泳道') }}</span>
          <select class="select-input" v-model="ccNumber" style="width:auto;max-width:130px">
            <option v-for="c in CC_OPTIONS" :key="c[0]" :value="c[0]">{{ c[1] }}</option>
          </select>
          <button class="et-btn" :class="{ active: ccEnabled }" :title="t('切换 CC 自动化泳道')" @click="ccEnabled = !ccEnabled"><Icon name="cclane" :size="14" />{{ ccEnabled ? t('关闭泳道') : t('显示泳道') }}</button>
          <select v-model="ccMode" class="select-input" style="width:auto" :title="t('CC 绘制方式')">
            <option value="free">{{ t('手绘') }}</option><option value="line">{{ t('直线') }}</option><option value="curve">{{ t('曲线') }}</option>
          </select>
          <button class="et-btn" :title="t('查看当前轨道 CC 控制器事件')" @click="openCCList"><Icon name="list" :size="14" />{{ t('CC 列表') }}</button>
          <button class="et-btn" :class="{ active: cc2Enabled }" :title="t('切换第二条 CC 泳道')" @click="cc2Enabled = !cc2Enabled"><Icon name="cclane" :size="14" />CC2</button>
          <select v-model="cc2Number" class="select-input" style="width:auto">
            <option v-for="c in CC_OPTIONS" :key="c[0]" :value="c[0]">{{ c[1] }}</option>
          </select>
        </div>
        <div class="adv-row">
          <span class="et-label">{{ t('踏板与循环') }}</span>
          <button class="et-btn" :title="t('在选区/整轨起止处添加延音踏板（CC64）')" @click="addPedal"><Icon name="cclane" :size="14" />+ {{ t('踏板') }}</button>
          <button class="et-btn" :title="t('删除选区/整轨内的踏板事件')" @click="delPedal"><Icon name="cclane" :size="14" />- {{ t('踏板') }}</button>
          <button class="et-btn" :class="{ active: state.loop }" :title="t('将选区设为循环')" @click="setLoopFromSel"><Icon name="loop" :size="14" />{{ t('选区循环') }}</button>
          <button class="et-btn" :title="t('清除循环')" @click="clearLoopSel"><Icon name="minus" :size="14" />{{ t('清循环') }}</button>
        </div>
        <div class="adv-row">
          <span class="et-label">{{ t('歌词与音频') }}</span>
          <button class="et-btn" :title="t('为选中的音符添加歌词')" @click="openLyricEditor"><Icon name="music" :size="14" />{{ t('添加歌词') }}</button>
          <button class="et-btn" :title="t('载入原音频，在卷帘底部显示波形与起音')" @click="loadAudio"><Icon name="import" :size="14" />{{ t('载入') }}</button>
          <button class="et-btn" :title="t('选区/整轨音符吸附到最近的波形起音（±80ms）')" @click="snapAudio"><Icon name="target" :size="14" />{{ t('吸附起音') }}</button>
          <button class="et-btn" :class="{ active: audioSyncOn }" :title="t('播放 MIDI 时同步试听原音频')" @click="toggleAudioSync"><Icon name="play" :size="14" />{{ t('试听') }}</button>
          <button class="et-btn" :title="t('嵌入视频轨道（影视配乐对齐）')" @click="loadVideo"><Icon name="play2" :size="14" />{{ t('视频') }}</button>
          <button v-if="videoUrl" class="et-btn" :title="t('移除视频轨道')" @click="removeVideo"><Icon name="trash" :size="14" />{{ t('移除视频') }}</button>
        </div>
        <div class="adv-row">
          <span class="et-label">{{ t('速度轨') }}</span>
          <button class="et-btn" :class="{ active: tempoLane }" :title="t('速度轨：逐点设置速度，播放与导出都按它走')" @click="tempoLane = !tempoLane"><Icon name="clock" :size="14" />{{ tempoLane ? t('隐藏速度轨') : t('显示速度轨') }}</button>
          <button class="et-btn" :title="t('在播放头处插入速度点')" @click="addTempoPoint"><Icon name="plus" :size="14" />{{ t('加点') }}</button>
        </div>
        <div class="adv-row">
          <span class="et-label">{{ t('演奏法') }}</span>
          <button class="et-btn" :class="{ active: artLane }" :title="t('技法条：按小节显示/切换演奏法（Key Switch）')" @click="artLane = !artLane"><Icon name="kbd" :size="14" />{{ artLane ? t('隐藏技法条') : t('技法条') }}</button>
          <button class="et-btn" :title="t('演奏法映射表（Key Switch 键位 ↔ 技法名）')" @click="openKSMap"><Icon name="list" :size="14" />{{ t('映射表') }}</button>
          <button class="et-btn" :title="t('在选区起点（没有选区则用播放头）插入技法切换')" @click="addArticulationHere"><Icon name="plus" :size="14" />{{ t('插入技法') }}</button>
        </div>
        <div class="adv-row">
          <span class="et-label">{{ t('帮助') }}</span>
          <button class="et-btn" :title="t('编辑功能介绍')" @click="helpOpen = true"><Icon name="info" :size="14" />{{ t('说明') }}</button>
        </div>
      </div>
      </div>

      <!-- 上下文任务条（M1）：选中音符后就地出现高频操作。
           以前这些散在「更多」面板的两屏高度里，选中后还要去展开面板才能改力度。 -->
      <div class="card ed-taskbar">
        <template v-if="sel.count">
          <span class="tb-badge">{{ t('已选 ') }}{{ sel.count }}</span>
          <span class="et-label">{{ t('移调') }}</span>
          <button class="et-btn" :title="t('降半音')" @click="trDown">-1</button>
          <button class="et-btn" :title="t('升半音')" @click="trUp">+1</button>
          <button class="et-btn" :title="t('降八度')" @click="octDown">-12</button>
          <button class="et-btn" :title="t('升八度')" @click="octUp">+12</button>
          <span class="et-sep"></span>
          <span class="et-label">{{ t('力度') }}</span>
          <button class="et-btn" :title="t('选区力度渐弱')" @click="velDown">-3</button>
          <button class="et-btn" :title="t('选区力度渐强')" @click="velUp">+3</button>
          <button class="et-btn" :title="t('选区力度 -20')" @click="ctxVel(-20)">-20</button>
          <span class="et-sep"></span>
          <button class="et-btn" :title="t('量化到吸附网格')" @click="quantize"><Icon name="quantize" :size="13" />{{ t('量化') }}</button>
          <button class="et-btn" :title="t('参数化工具：拖动即预览，回车应用')" @click="openMidiTools"><Icon name="sliders" :size="13" />{{ t('参数工具') }}</button>
          <button class="et-btn" :title="t('列表编辑器：精确修改数值')" @click="openList"><Icon name="list" :size="13" />{{ t('列表') }}</button>
          <button class="et-btn" :title="t('复制')" @click="copy"><Icon name="copy" :size="13" />{{ t('复制') }}</button>
          <button class="et-btn" :title="t('克隆选区到其后')" @click="dup"><Icon name="plus" :size="13" />{{ t('克隆') }}</button>
          <button class="et-btn" :class="{ active: selMutedNow === true }" :title="t('静音选中的音符')" @click="editor?.setSelMuted(true)"><Icon name="minus" :size="13" />{{ t('静音') }}</button>
          <button class="et-btn danger" :title="t('删除 Del')" @click="del"><Icon name="trash" :size="13" />{{ t('删除') }}</button>
          <span class="st-grow"></span>
          <button class="et-btn" :title="t('取消选择')" @click="editor?.selectNone(); refreshSel()">{{ t('取消选择') }}</button>
        </template>
        <template v-else>
          <span class="tb-hint">{{ t('未选中音符 · 拖拽框选或点击音符，这里会出现就地操作（移调 / 力度 / 量化 / 列表 / 复制 / 删除）') }}</span>
          <span class="st-grow"></span>
          <span class="tb-hint" v-if="recording">{{ t('宏录制中 · 已捕获 ') }}{{ recordLines.length }}{{ t(' 条') }}</span>
        </template>
      </div>

      <!-- ② 工作区：左侧检查器 + 右侧多车道舞台 -->
      <div class="ed-main" :style="mainStyle" :class="{ 'insp-off': !inspOpen }">
        <aside class="ed-insp" v-show="inspOpen" :class="{ 'ed-insp-in': inspOpen }">
          <!-- 分页（M1）：三块面板原先竖着堆，窄屏要滚三屏才找到「网格与显示」 -->
          <div class="insp-tabs">
            <button v-for="tb in INSP_TABS" :key="tb[0]" class="insp-tab" :class="{ on: inspTab === tb[0] }"
                    :title="t(tb[1])" @click="inspTab = tb[0]"><Icon :name="tb[2]" :size="12" />{{ t(tb[1]) }}</button>
          </div>
          <div v-if="inspTab === 'note'" class="insp-pane">
          <div class="insp-sec">
            <div class="insp-h"><Icon name="cursor" :size="12" />{{ t('音符检查器') }}</div>
            <div class="insp-row"><span>{{ t('选中') }}</span><b>{{ sel.count }}</b></div>
            <div class="insp-row"><span>{{ t('音名') }}</span><b>{{ sel.name || '—' }}</b></div>
            <div class="insp-row"><span>{{ t('音高') }}</span><b>{{ sel.midi ?? '—' }}</b></div>
            <div class="insp-row"><span>{{ t('力度') }}</span><b>{{ sel.vel ?? '—' }}</b></div>
            <input class="insp-range" type="range" min="1" max="127" :value="sel.vel ?? 80" data-guide="velocity-slider" :disabled="!sel.vel"
                   @input="e => editor?.setSelVel(+e.target.value)" />
            <div class="insp-row"><span>{{ t('起点') }}</span>
              <input type="number" class="num-input" :value="sel.start ?? 0" step="1" min="0" :disabled="!sel.start"
                     @change="e => editor?.setSelStart(+e.target.value)" /></div>
            <div class="insp-row"><span>{{ t('长度') }}</span>
              <input type="number" class="num-input" :value="sel.len ?? 0" step="1" min="1" :disabled="!sel.len"
                     @change="e => editor?.setSelLen(+e.target.value)" /></div>
            <div class="insp-btns">
              <button class="btn sm" :class="{ primary: selMutedNow === true }" :disabled="!sel.count" @click="editor?.setSelMuted(true)">{{ t('静音') }}</button>
              <button class="btn sm" :class="{ primary: selMutedNow === false }" :disabled="!sel.count" @click="editor?.setSelMuted(false)">{{ t('取消静音') }}</button>
            </div>
          </div>
          </div>

          <div v-if="inspTab === 'track'" class="insp-pane">
          <div class="insp-sec">
            <div class="insp-h"><Icon name="music" :size="12" />{{ t('轨道') }}</div>
            <select class="select-input" v-model="trackIndex" style="width:100%">
              <option v-for="(tr, i) in song.tracks" :key="i" :value="i">{{ tr.name }}{{ t('（') }}{{ state.tracks[i]?.noteCount ?? tr.notes.length }}{{ t('）') }}</option>
            </select>
            <div class="insp-row"><span>{{ t('通道') }}</span><b>{{ (curTrackInfo?.ch ?? 0) + 1 }}</b></div>
            <div class="insp-row"><span>{{ t('音色') }}</span><b>{{ String(timbre).padStart(3, '0') }}</b></div>
            <select v-model.number="timbre" class="select-input" style="width:100%" @change="timbreChange">
              <option v-for="(nm, p) in GM_NAMES" :key="p" :value="Number(p)">{{ p }} {{ nm }}</option>
            </select>
            <div class="insp-btns">
              <button class="btn sm" :class="{ primary: timbreFavs.has(Number(timbre)) }" :title="t('收藏/取消收藏当前音色')" @click="toggleTimbreFav">♡ {{ t('收藏') }}</button>
              <button class="btn sm" :title="t('把当前音色应用到全部非鼓轨')" @click="timbreAll">{{ t('全部') }}</button>
              <button class="btn sm" :title="t('按轨道音域/密度/名称智能选择音色')" @click="smartTimbre">{{ t('智能') }}</button>
            </div>
          </div>
          </div>

          <div v-if="inspTab === 'view'" class="insp-pane">
          <div class="insp-sec">
            <div class="insp-h"><Icon name="quantize" :size="12" />{{ t('网格与显示') }}</div>
            <div class="insp-row"><span>{{ t('吸附') }}</span>
              <select class="select-input" v-model="snapRatio">
                <option v-for="s in SNAPS" :key="s[0]" :value="s[0]">{{ s[1] }}</option>
              </select></div>
            <div class="insp-row"><span>{{ t('着色') }}</span>
              <select class="select-input" v-model="colorMode" :title="t('音符着色方案')">
                <option v-for="c in COLOR_MODES" :key="c[0]" :value="c[0]">{{ c[1] }}</option>
              </select></div>
            <div class="insp-row"><span>{{ t('默认力度') }}</span>
              <input class="num-input" type="number" min="1" max="127" step="1" v-model.number="defaultVelocity" :title="t('画笔新建音符时使用的力度')" /></div>
          </div>
          </div>
        </aside>

        <div v-show="inspOpen" class="ed-split" :title="t('拖动调整检查器宽度')" @pointerdown.prevent="startInspResize"></div>

        <section class="ed-stage">
        <!-- 乐谱工具条：独一条横排（放在主工具条里会把工具栏撑到 256px 高，音符区只剩 187px）。
             时值按钮既改选中音符、也决定画笔插入的长度。 -->
        <Transition name="ed-pop">
        <div v-if="viewMode === 'score'" class="card ed-scorebar">
          <span class="et-label">{{ t('时值') }}</span>
          <button v-for="d in SCORE_DURS" :key="d.q" class="et-btn" :title="t('设为这个时值（改选中音符，也决定画笔插入的长度）')"
                  @click="pickScoreDur(d.q)">{{ t(d.label) }}</button>
          <button class="et-btn" :class="{ active: scoreDot }" :title="t('附点（时值 ×1.5）')" @click="toggleScoreDot">·</button>
          <span class="et-sep"></span>
          <span class="et-label">{{ t('谱号') }}</span>
          <button v-for="c in [['auto','自动'],['treble','高音'],['bass','低音']]" :key="c[0]" class="et-btn"
                  :class="{ active: scoreClefUi === c[0] }" @click="pickClef(c[0])">{{ t(c[1]) }}</button>
          <span class="et-sep"></span>
          <span class="muted small">{{ t('拖动音符改音高/位置；画笔工具在空白处点一下插音符') }}</span>
        </div>
        </Transition>
      <!-- 迷你图 + 缩放 -->
      <div class="ed-nav" ref="miniWrap">
        <canvas ref="miniEl" class="ed-mini" style="height:34px" @click="miniClick"></canvas>
        <div class="ed-zoom">
          <button class="icon-btn" :title="t('缩小')" @click="editor?.zoomBy(0.85)"><Icon name="minus" :size="13" /></button>
          <span class="ez-pct">{{ zoomPct }}%</span>
          <button class="icon-btn" :title="t('放大')" @click="editor?.zoomBy(1.18)"><Icon name="plus" :size="13" /></button>
          <button class="btn sm ghost" @click="editor?.fit()"><Icon name="expand" :size="13" />{{ t('适应') }}</button>
        </div>
      </div>

      <!-- P1-2 和弦轨：逐小节和弦，点击可手改 -->
      <div v-if="chordOpen && chordBars.length" class="chord-lane">
        <span class="chord-lane-label">{{ t('和弦') }}</span>
        <div class="chord-cells">
          <button v-for="b in chordBars.slice(0, 128)" :key="b.bar" class="chord-cell" :class="{ manual: b.manual }"
                  :title="t('第 ') + b.bar + t(' 小节 · 点击修改和弦')" @click="editChordBar(b)">
            <em>{{ b.bar }}</em><b>{{ b.name }}</b>
          </button>
        </div>
        <span v-if="chordBars.length > 128" class="muted small">{{ t('仅显示前 128 小节') }}</span>
        <button class="btn sm ghost" @click="clearChordBars">{{ t('隐藏') }}</button>
      </div>

      <!-- 技法条（M5）：把低音区的 Key Switch 读成「技法段」，一眼看出每段在用什么演奏法 -->
      <div v-if="artLane" class="card art-lane">
        <span class="art-lane-label">{{ t('技法') }}</span>
        <div class="art-cells">
          <div v-for="(seg, i) in ksSegments" :key="i" class="art-cell">
            <em>{{ t('第 ') }}{{ tickBar(seg.start) }}{{ t(' 小节') }}</em>
            <select class="select-input" :value="seg.midi" :title="t('这一段用的演奏法（改的是 Key Switch 音符的音高）')"
                    @change="setSegArticulation(seg, $event)">
              <option v-for="k in (ksEmpty ? KS_KEYS : ksMappedKeys)" :key="k" :value="k">{{ ksName(k) }}</option>
            </select>
            <button class="icon-btn" :title="t('删除这次技法切换')" @click="delKsSeg(seg)"><Icon name="minus" :size="12" /></button>
          </div>
          <template v-if="!ksSegments.length">
            <span class="muted small">
              {{ ksEmpty
                ? t('演奏法映射表还是空的：先套用一套键位（Spitfire / VSL / EastWest），或到「映射表」里自定义。')
                : t('这一轨还没有技法切换：在下面选一个演奏法，点「插入技法」会在选区起点（或播放头）放一个 Key Switch 音符。') }}
            </span>
            <button v-if="ksEmpty" class="btn sm" @click="useDefaultKsMap"><Icon name="spark" :size="12" />{{ t('套用 Spitfire 映射') }}</button>
          </template>
        </div>
        <select v-model.number="newArtMidi" class="select-input" style="width:auto;flex:none" :title="t('要插入的演奏法')">
          <option v-for="k in (ksEmpty ? KS_KEYS : ksMappedKeys)" :key="k" :value="k">{{ ksName(k) }}</option>
        </select>
        <button class="btn sm" :title="t('在选区起点（没有选区则用播放头）插入技法切换')" @click="addArticulationHere">
          <Icon name="plus" :size="12" />{{ t('插入技法') }}</button>
        <button class="btn sm ghost" :title="t('演奏法映射表（Key Switch 键位 ↔ 技法名）')" @click="openKSMap"><Icon name="kbd" :size="12" />{{ t('映射表') }}</button>
        <button class="btn sm ghost" @click="artLane = false">{{ t('隐藏') }}</button>
      </div>

      <!-- 速度轨（M5）：逐点速度，播放与导出都按 tempoMap 走 -->
      <div v-if="tempoLane" class="card art-lane">
        <span class="art-lane-label">{{ t('速度') }}</span>
        <div class="art-cells">
          <div v-for="(p, i) in tempoPoints" :key="i" class="art-cell">
            <em>{{ t('第 ') }}{{ tickBar(p.tick) }}{{ t(' 小节') }}</em>
            <input class="num-input" type="number" min="20" max="400" step="1" :value="p.bpm"
                   style="width:62px" :title="t('这一段的速度（BPM）')" @change="setTempoPoint(i, $event)" />
            <button class="icon-btn" :title="t('删除这个速度点')" @click="delTempoPoint(i)"><Icon name="minus" :size="12" /></button>
          </div>
        </div>
        <button class="btn sm" :title="t('在播放头处插入速度点（沿用当前速度）')" @click="addTempoPoint"><Icon name="plus" :size="12" />{{ t('在播放头加点') }}</button>
        <button class="btn sm ghost" :title="t('清空所有速度点，回到单一速度')" @click="resetTempo">{{ t('清空') }}</button>
        <button class="btn sm ghost" @click="tempoLane = false">{{ t('隐藏') }}</button>
      </div>

      <!-- 钢琴卷帘（用 v-show 保活：切到鼓组再切回不会丢撤销历史与视图位置） -->
      <div v-show="viewMode !== 'drum'" class="ed-wrap-rel" :class="{ 'ed-flash': viewFlash }">
        <EditorCanvas ref="editor" :tool="tool" :snap-ratio="snapRatio" :track-index="trackIndex"
                      :view="viewMode === 'score' ? 'score' : 'piano'"
                      :cc-enabled="ccEnabled && viewMode === 'piano'" :cc-number="ccNumber"
                      :scale-spec="scaleSpec" :scale-mode="scaleMode" :chord-track="chordSpec" :ks-map="ksMap" :audio="audioData"
                      :cc2-enabled="cc2Enabled" :cc2-number="cc2Number" :cc-mode="ccMode"
                      :default-velocity="defaultVelocity" :color-mode="colorMode"
                      @select="refreshSel" @modify="onModified" @zoom="onZoom" @ctxmenu="openCtxMenu" @hover="onHover" @step="onStep"
                      :step-on="stepOn" :step-ticks="stepTicks" />
        <video v-if="videoUrl" :src="videoUrl" controls playsinline class="ed-video-overlay"></video>
        <!-- 悬停工具条（M3）：压到音符上就地出现，鼠标移到条上不消失 -->
        <div v-if="hoverInfo && !midiToolOpen" class="hv-bar" :style="hoverBarStyle"
             @pointerenter="cancelHoverHide" @pointerleave="scheduleHoverHide">
          <span class="hv-name">{{ hoverInfo.name }}</span>
          <span v-if="artLane && hoverInfo.tick != null && artAt(hoverInfo.tick)" class="hv-art" :title="t('这一段的演奏法')">{{ artAt(hoverInfo.tick) }}</span>
          <span class="hv-vel" :title="t('力度')">v{{ hoverInfo.vel }}</span>
          <button class="hv-btn" :title="t('力度 -5')" @click="hoverAct('velDown')">−</button>
          <button class="hv-btn" :title="t('力度 +5')" @click="hoverAct('velUp')">+</button>
          <span class="hv-sep"></span>
          <button class="hv-btn" :title="t('时值减半')" @click="hoverAct('half')">½</button>
          <button class="hv-btn" :title="t('时值加倍')" @click="hoverAct('double')">×2</button>
          <span class="hv-sep"></span>
          <button class="hv-btn" :class="{ on: hoverInfo.muted }" :title="t('静音 / 取消静音')" @click="hoverAct('mute')">{{ t('静音') }}</button>
          <button class="hv-btn" :title="t('更多参数工具')" @click="hoverMore"><Icon name="sliders" :size="12" /></button>
          <button class="hv-btn danger" :title="t('删除 Del')" @click="hoverAct('del')"><Icon name="trash" :size="12" /></button>
          <span v-if="hoverInfo.count > 1" class="hv-multi">{{ t('作用于 ') }}{{ hoverInfo.count }}{{ t(' 个选中音符') }}</span>
        </div>
      </div>

      <!-- 鼓组网格（打击乐专用视图） -->
      <div v-show="viewMode === 'drum'" class="ed-wrap-rel ed-drum" :class="{ 'ed-flash': viewFlash }">
        <div class="ed-drum-bar">
          <select class="select-input" v-model="drumTrack">
            <option v-for="d in drumTracks" :key="d.i" :value="d.i">{{ d.t.name }}{{ t('（') }}{{ d.t.notes.length }}{{ t('）') }}</option>
          </select>
          <span class="et-label">{{ t('点击格子添加 / 删除鼓点') }}</span>
          <button class="btn sm" :title="t('逐音改名：GM 名字只是默认值，鼓机映射不一样时改这里（本地保存）')" @click="openDrumNames">
            <Icon name="edit" :size="12" />{{ t('鼓组命名') }}</button>
          <button class="btn sm danger" style="margin-left:auto" @click="drumClear">{{ t('清除当前轨道鼓点') }}</button>
        </div>
        <canvas ref="drumCv" class="drum-canvas" @click="drumClick"></canvas>
      </div>

        </section>
      </div>

      <!-- ③ 状态栏：位置 / 时间 / 速度 / 轨道 / 选中 / 缩放 -->
      <div class="ed-status">
        <span class="st-i">{{ t('位置') }} <b>{{ posText }}</b></span>
        <span class="st-i">SMPTE <b>{{ smpteText }}</b></span>
        <span class="st-i">BPM <b>{{ bpmText }}</b></span>
        <span class="st-i">{{ t('轨道') }} <b>{{ curTrackInfo?.name || '—' }}</b></span>
        <span class="st-i">{{ t('选中') }} <b>{{ sel.count }}</b></span>
        <span class="st-grow"></span>
        <span class="st-i">{{ t('视图') }} <b>{{ viewLabel }}</b></span>
        <span class="st-i">{{ t('吸附') }} <b>{{ snapLabel }}</b></span>
        <span class="st-i">{{ t('缩放') }} <b>{{ zoomPct }}%</b></span>
        <button class="st-btn" :class="{ on: inspOpen }" :title="t('显示 / 收起右侧检查器')" @click="inspOpen = !inspOpen"><Icon name="panel" :size="12" />{{ t('检查器') }}</button>
        <button class="st-btn" :title="t('快捷键一览（?）')" @click="shortcutsOpen = true">?</button>
        <span class="st-i st-tip">{{ t('Ctrl+滚轮 缩放 · Shift+滚轮 平移 · ? 看全部快捷键') }}</span>
      </div>
    </template>

    <!-- 参数化 MIDI 工具（M2）：拖动即预览 / Esc 还原 / 回车应用 -->
    <MidiToolPanel :open="midiToolOpen" :editor="editor" :ctx="toolCtx" :sel-count="sel.count"
                   :initial-tool="midiToolPreset" @close="onToolPanelClose" />

    <!-- 命令面板（M3，Ctrl+Shift+P） -->
    <CommandPalette :open="palOpen" :commands="commands" @close="palOpen = false" />

    <!-- 快捷键一览（M1）：以前只藏在按钮 title 里，等于没有 -->
    <Transition name="ov">
    <div v-if="shortcutsOpen" class="ed-modal-mask" @click.self="shortcutsOpen = false">
      <div class="ed-modal ed-keys">
        <div class="ed-modal-head">
          <b>{{ t('快捷键一览') }}</b><span class="muted small">{{ t('编辑工作台 · 按 ? 或 F1 开关 · Esc 关闭') }}</span>
          <button class="icon-btn" style="margin-left:auto" @click="shortcutsOpen = false"><Icon name="minus" :size="14" /></button>
        </div>
        <div class="keys-grid">
          <div v-for="g in SHORTCUT_GROUPS" :key="g.name" class="keys-sec">
            <div class="keys-h">{{ t(g.name) }}</div>
            <div v-for="k in g.rows" :key="k[0]" class="keys-row"><kbd>{{ k[0] }}</kbd><span>{{ t(k[1]) }}</span></div>
          </div>
        </div>
        <div class="ed-modal-foot">
          <span class="muted small" style="margin-right:auto">{{ t('工作区预设与检查器分页在状态栏右下角') }}</span>
          <button class="btn sm primary" @click="shortcutsOpen = false">{{ t('知道了') }}</button>
        </div>
      </div>
    </div>
    </Transition>

    <!-- 力度曲线弹窗 -->
    <Transition name="ov">
    <div v-if="vcOpen" class="ed-modal-mask" @click.self="vcOpen = false">
      <div class="ed-modal">
        <div class="ed-modal-head">
          <b>{{ t('力度曲线') }}</b><span class="muted small">{{ t('在画布上拖拽绘制力度包络，应用到选区 ') }}{{ vcVals.length }}{{ t(' 个音符') }}</span>
          <button class="icon-btn" style="margin-left:auto" @click="vcOpen = false"><Icon name="minus" :size="14" /></button>
        </div>
        <canvas ref="vcCanvas" class="vc-canvas" style="height:160px"
                @pointerdown="vcDown" @pointermove="vcMove" @pointerup="vcUp" @pointerleave="vcUp"></canvas>
        <div class="ed-modal-foot">
          <button class="btn sm" @click="vcOpen = false">{{ t('取消') }}</button>
          <button class="btn sm primary" @click="applyVelCurve">{{ t('应用曲线') }}</button>
        </div>
      </div>
    </div>
    </Transition>

    <!-- 鼓组命名（M4）：GM 名字只是默认值 -->
    <Transition name="ov">
    <div v-if="drumNameOpen" class="ed-modal-mask" @click.self="drumNameOpen = false">
      <div class="ed-modal">
        <div class="ed-modal-head">
          <b>{{ t('鼓组命名') }}</b><span class="muted small">{{ t('留空则用 GM 默认名；只保存在本机') }}</span>
          <button class="icon-btn" style="margin-left:auto" @click="drumNameOpen = false"><Icon name="minus" :size="14" /></button>
        </div>
        <div class="drum-name-grid">
          <label v-for="p in DRUM_PITCHES" :key="p" class="drum-name-row">
            <span class="drum-name-p">{{ p }}</span>
            <input class="text-input" v-model="drumNameDraft[p]" :placeholder="DRUM_NAMES[p] || String(p)" />
          </label>
        </div>
        <div class="ed-modal-foot">
          <button class="btn sm" @click="resetDrumNames">{{ t('恢复默认') }}</button>
          <button class="btn sm" @click="drumNameOpen = false">{{ t('取消') }}</button>
          <button class="btn sm primary" @click="saveDrumNames">{{ t('保存') }}</button>
        </div>
      </div>
    </div>
    </Transition>

    <!-- 列表编辑器弹窗 -->
    <Transition name="ov">
    <div v-if="listOpen" class="ed-modal-mask" @click.self="cancelList">
      <div class="ed-modal" @keydown.esc.stop="cancelList" @keydown.enter.stop="applyList">
        <div class="ed-modal-head">
          <b>{{ t('列表编辑器') }}</b><span class="muted small">{{ t('精确修改选中 ') }}{{ listDraft.length }}{{ t(' 个音符（单位：tick）· 改动即时生效，回车应用，Esc 还原') }}</span>
          <button class="icon-btn" style="margin-left:auto" :title="t('取消并还原')" @click="cancelList"><Icon name="minus" :size="14" /></button>
        </div>
        <div class="ed-list-scroll">
          <table class="ed-list-table">
            <thead><tr><th>#</th><th>{{ t('起点') }}</th><th>{{ t('终点') }}</th><th>{{ t('音高') }}</th><th>{{ t('力度') }}</th><th>{{ t('时长') }}</th></tr></thead>
            <tbody>
              <tr v-for="(r, i) in listDraft" :key="i">
                <td>{{ i + 1 }}</td>
                <td><input type="number" class="num-input" v-model.number="r.start" step="1" min="0" @input="applyListDraft" /></td>
                <td><input type="number" class="num-input" v-model.number="r.end" step="1" min="1" @input="applyListDraft" /></td>
                <td><input type="number" class="num-input" v-model.number="r.midi" step="1" min="0" max="127" @input="applyListDraft" /></td>
                <td><input type="number" class="num-input" v-model.number="r.vel" step="1" min="1" max="127" @input="applyListDraft" /></td>
                <td class="muted small">{{ r.end - r.start }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="ed-modal-foot">
          <button class="btn sm" @click="cancelList">{{ t('取消并还原') }}</button>
          <button class="btn sm primary" @click="applyList">{{ t('应用（回车）') }}</button>
        </div>
      </div>
    </div>
    </Transition>
    <!-- 智能量化弹窗 -->
    <Transition name="ov">
    <div v-if="sqOpen" class="ed-modal-mask" @click.self="sqOpen = false">
      <div class="ed-modal">
        <div class="ed-modal-head"><b>{{ t('智能量化') }}</b><span class="muted small">{{ t('网格 + Groove 模板') }}</span><button class="icon-btn" style="margin-left:auto" @click="sqOpen = false"><Icon name="minus" :size="14" /></button></div>
        <div class="adv-form-grid">
          <label>{{ t('网格') }}
            <select v-model="sqGrid" class="select-input" style="width:100%">
              <option :value="4">1/4</option><option :value="8">1/8</option><option :value="16">1/16</option><option :value="32">1/32</option>
            </select>
          </label>
          <label>Groove
            <select v-model="sqGroove" class="select-input" style="width:100%">
              <option value="none">{{ t('无') }}</option><option value="funk">Funk</option><option value="jazz">Jazz</option><option value="rock">Rock</option><option value="latin">Latin</option><option value="custom">{{ t('自定义 Groove') }}</option>
            </select>
          </label>
          <label class="span2">{{ t('强度') }}<input type="range" min="0" max="100" v-model.number="sqStrength" style="width:100%" /> <span class="muted small">{{ sqStrength }}%</span></label>
        </div>
        <div class="ed-modal-foot">
          <button class="btn sm" @click="extractGroove">{{ t('提取选中为 Groove') }}</button>
          <button class="btn sm" @click="sqOpen = false">{{ t('取消') }}</button>
          <button class="btn sm primary" @click="applySmartQuantize">{{ t('应用量化') }}</button>
        </div>
      </div>
    </div>
    </Transition>

    <!-- 逻辑编辑器弹窗 -->
    <Transition name="ov">
    <div v-if="logicOpen" class="ed-modal-mask" @click.self="logicOpen = false">
      <div class="ed-modal">
        <div class="ed-modal-head"><b>{{ t('逻辑编辑器') }}</b><span class="muted small">{{ t('批量规则处理音符') }}</span><button class="icon-btn" style="margin-left:auto" @click="logicOpen = false"><Icon name="minus" :size="14" /></button></div>
        <div class="adv-form-grid">
          <label>{{ t('目标') }}
            <select v-model="logicTarget" class="select-input" style="width:100%">
              <option value="all">{{ t('所有音符') }}</option><option value="sel">{{ t('选中音符') }}</option><option value="track">{{ t('当前轨道') }}</option>
            </select>
          </label>
          <label>{{ t('条件') }}
            <select v-model="logicCond" class="select-input" style="width:100%">
              <option value="vel_lt">{{ t('力度 <') }}</option><option value="vel_gt">{{ t('力度 >') }}</option><option value="dur_lt">{{ t('时值 <') }}</option><option value="pitch_eq">{{ t('音高 =') }}</option>
            </select>
          </label>
          <label>{{ t('条件值 ') }}<input v-model.number="logicCondVal" class="num-input" type="number" style="width:100%" /></label>
          <label>{{ t('操作') }}
            <select v-model="logicAction" class="select-input" style="width:100%">
              <option value="vel_inc">{{ t('力度 +') }}</option><option value="vel_dec">{{ t('力度 -') }}</option><option value="vel_fix">{{ t('固定力度') }}</option><option value="quantize">{{ t('量化') }}</option><option value="transpose">{{ t('移调') }}</option><option value="delete">{{ t('删除') }}</option>
            </select>
          </label>
          <label>{{ t('操作值 ') }}<input v-model.number="logicActVal" class="num-input" type="number" style="width:100%" /></label>
        </div>
        <div class="ed-modal-foot">
          <button class="btn sm" @click="logicOpen = false">{{ t('取消') }}</button>
          <button class="btn sm primary" @click="applyLogic">{{ t('应用规则') }}</button>
        </div>
      </div>
    </div>
    </Transition>

    <!-- 宏面板弹窗 -->
    <Transition name="ov">
    <div v-if="macroOpen" class="ed-modal-mask" @click.self="macroOpen = false">
      <div class="ed-modal">
        <div class="ed-modal-head"><b>{{ t('宏面板') }}</b><span class="muted small">{{ t('一键执行常用批量处理，操作进入撤销历史') }}</span><button class="icon-btn" style="margin-left:auto" @click="macroOpen = false"><Icon name="minus" :size="14" /></button></div>
        <div class="macro-list">
          <button class="btn sm" style="justify-content:flex-start" @click="runMacro('clean')">{{ t('清理工程') }}<span class="muted small">{{ t('删除力度为 0 的音符 + 量化所有音符') }}</span></button>
          <button class="btn sm" style="justify-content:flex-start" @click="runMacro('transpose_up')">{{ t('批量移调') }}<span class="muted small">{{ t('所有音符升高一个八度') }}</span></button>
          <button class="btn sm" style="justify-content:flex-start" @click="runMacro('normalize_vel')">{{ t('力度标准化') }}<span class="muted small">{{ t('选中/全部音符力度归一化到 80-127') }}</span></button>
        </div>
        <div class="macro-record-row">
          <button :class="['btn sm', recording ? 'danger' : '']" @click="toggleRecording">
            {{ recording ? t('停止并生成命令') : t('开始录制操作') }}
          </button>
          <span v-if="recording" class="muted small">{{ t('正在录制 ') }}{{ recordLines.length }}{{ t(' 条') }}</span>
          <button v-if="recordLines.length" class="btn sm ghost" @click="clearRecorded">{{ t('清空录制') }}</button>
        </div>
        <div v-if="recordLines.length" class="macro-record-list">
          <div v-for="(r, i) in recordLines" :key="i" class="macro-record-line"><code>{{ r }}</code></div>
        </div>
        <div class="adv-form-sec">
          <div class="adv-form-sec-title">{{ t('自定义宏') }}</div>
          <div v-for="(m, i) in customMacros" :key="i" class="macro-item">
            <span class="macro-name">{{ m.name }}</span>
            <code class="macro-cmd">{{ m.cmd }}</code>
            <button class="btn sm" @click="runCustomMacro(m.cmd)">{{ t('运行') }}</button>
            <button class="btn sm danger" @click="delCustomMacro(i)">{{ t('删除') }}</button>
          </div>
          <div v-if="!customMacros.length" class="muted small">{{ t('暂无自定义宏') }}</div>
          <div class="macro-add">
            <input v-model="macroName" class="num-input" :placeholder="t('宏名称')" style="flex:1" />
            <input v-model="macroCmd" class="num-input" :placeholder="t('命令：transpose 12 / quantize 8 / normalize')" style="flex:2" />
            <button class="btn sm primary" @click="addCustomMacro">{{ t('添加') }}</button>
          </div>
          <div class="adv-form-sec-title">{{ t('宏指令说明') }}</div>
          <div class="macro-doc">
            <div v-for="d in MACRO_DOC" :key="d.cmd" class="macro-doc-row">
              <code>{{ d.cmd }}</code>
              <span>{{ t(d.desc) }}</span>
            </div>
          </div>
          <div class="muted small" style="margin-top:4px">{{ t('操作录制：打开录制后点击内置宏或工具栏移调/量化/力度按钮，会自动生成命令；停止后填入名称即可保存为自定义宏。') }}</div>
        </div>
      </div>
    </div>
    </Transition>

    <!-- Key Switch 映射弹窗 -->
    <Transition name="ov">
    <div v-if="ksOpen" class="ed-modal-mask" @click.self="ksOpen = false">
      <div class="ed-modal" style="width:min(560px,92vw)">
        <div class="ed-modal-head"><b>{{ t('演奏法库 / Key Switch 映射') }}</b><span class="muted small">{{ t('为 C-2 ~ C0（MIDI 0-24）命名技法') }}</span><button class="icon-btn" style="margin-left:auto" @click="ksOpen = false"><Icon name="minus" :size="14" /></button></div>
        <div class="row" style="gap:8px">
          <select v-model="ksPreset" class="select-input" style="min-width:170px">
            <option value="">{{ t('选择演奏法库') }}</option>
            <option v-for="a in articulations" :key="a.id" :value="a.id">{{ a.name }}{{ a.builtin ? '' : t('（自定义）') }}</option>
          </select>
          <button class="btn sm" @click="applyKSPreset">{{ t('载入库') }}</button>
          <button class="btn sm ghost" @click="bindArticulationToTrack">{{ t('绑定到当前轨道') }}</button>
          <button v-if="ksPreset && !(articulations.find(a => a.id === ksPreset) || {}).builtin" class="btn sm danger" @click="delArticulationLib(ksPreset)">{{ t('删除库') }}</button>
        </div>
        <div class="row" style="gap:8px">
          <input v-model="ksLibName" class="num-input" :placeholder="t('库名称（另存当前映射）')" style="flex:1" />
          <button class="btn sm primary" @click="saveArticulationLib">{{ t('另存为库') }}</button>
        </div>
        <div class="ks-list">
          <div v-for="m in 25" :key="m - 1" class="ks-row">
            <span class="ks-label">MIDI {{ m - 1 }}</span>
            <input v-model="ksDraft[m - 1]" class="num-input" :placeholder="t('技法名（如 Legato）')" style="flex:1" />
          </div>
        </div>
        <div class="ed-modal-foot"><button class="btn sm primary" @click="saveKSMap">{{ t('保存') }}</button></div>
      </div>
    </div>
    </Transition>

    <!-- CC 事件列表弹窗 -->
    <Transition name="ov">
    <div v-if="ccListOpen" class="ed-modal-mask" @click.self="ccListOpen = false">
      <div class="ed-modal">
        <div class="ed-modal-head"><b>{{ t('CC 控制器事件') }}</b><span class="muted small">{{ t('当前轨道 ') }}{{ ccListItems.length }}{{ t(' 条') }}</span><button class="icon-btn" style="margin-left:auto" @click="ccListOpen = false"><Icon name="minus" :size="14" /></button></div>
        <div class="ed-list-scroll" style="max-height:50vh">
          <table class="ed-list-table">
            <thead><tr><th>#</th><th>Tick</th><th>CC</th><th>{{ t('值') }}</th><th></th></tr></thead>
            <tbody>
              <tr v-for="(c, i) in ccListItems" :key="i">
                <td>{{ i + 1 }}</td><td>{{ c.tick }}</td><td>CC{{ c.cc }}</td><td>{{ c.cv }}</td>
                <td><button class="btn sm danger" @click="delCCItem(i)">{{ t('删除') }}</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    </Transition>

    <!-- 撤销历史弹窗 -->
    <Transition name="ov">
    <div v-if="historyOpen" class="ed-modal-mask" @click.self="historyOpen = false">
      <div class="ed-modal">
        <div class="ed-modal-head"><b>{{ t('撤销历史') }}</b><span class="muted small">{{ t('点击条目回退到该状态') }}</span><button class="icon-btn" style="margin-left:auto" @click="historyOpen = false"><Icon name="minus" :size="14" /></button></div>
        <div class="ks-list">
          <div v-for="(h, i) in historyList" :key="i" class="ks-row">
            <span class="ks-label">#{{ historyList.length - i }}</span>
            <span class="muted small">{{ t('轨道 ') }}{{ h.ti + 1 }} · {{ h.notes }}{{ t(' 个音符 · ') }}{{ new Date(h.at).toLocaleTimeString() }}</span>
            <button class="btn sm" @click="historyOpen = false">{{ t('撤销') }}</button>
          </div>
          <div v-if="!historyList.length" class="muted small">{{ t('暂无撤销记录') }}</div>
        </div>
      </div>
    </div>
    </Transition>

    <!-- 歌词编辑弹窗 -->
    <Transition name="ov">
    <div v-if="lyricOpen" class="ed-modal-mask" @click.self="lyricOpen = false">
      <div class="ed-modal">
        <div class="ed-modal-head"><b>{{ t('添加歌词') }}</b><span class="muted small">{{ t('为选中的 ') }}{{ editor?.selCount() || 0 }}{{ t(' 个音符添加歌词') }}</span><button class="icon-btn" style="margin-left:auto" @click="lyricOpen = false"><Icon name="minus" :size="14" /></button></div>
        <input v-model="lyricText" class="num-input" :placeholder="t('输入歌词（如：爱）')" @keyup.enter="addLyricToSel" style="width:100%;padding:8px" />
        <div class="ed-modal-foot">
          <button class="btn sm" @click="lyricOpen = false">{{ t('取消') }}</button>
          <button class="btn sm primary" @click="addLyricToSel">{{ t('添加') }}</button>
        </div>
      </div>
    </div>
    </Transition>

    <!-- 编辑说明弹窗 -->
    <Transition name="ov">
    <div v-if="helpOpen" class="ed-modal-mask" @click.self="helpOpen = false">
      <div class="ed-modal" style="width:min(680px,92vw)">
        <div class="ed-modal-head"><b>{{ t('编辑功能说明') }}</b><button class="icon-btn" style="margin-left:auto" @click="helpOpen = false"><Icon name="minus" :size="14" /></button></div>
        <div class="help-scroll">
          <div class="help-sec"><b>{{ t('钢琴卷帘') }}</b><span>{{ t('选择/画笔/橡皮/静音四种工具；拖拽移动音符、边缘拉伸改时值、Alt 拖拽调力度；支持吸附、音阶吸附、撤销/重做；可设置新音符默认力度与着色方案（轨道/音高/力度/选中）。') }}</span></div>
          <div class="help-sec"><b>{{ t('CC 自动化') }}</b><span>{{ t('展开 CC 泳道后选择 CC1/7/10/11/64；支持手绘、直线、曲线三种绘制；点击/拖动直接写 CC 数据。') }}</span></div>
          <div class="help-sec"><b>Key Switch</b><span>{{ t('C-2~C0 区域橙色高亮；技法名来自演奏法库（内置 Spitfire/VSL/EastWest，可另存为自定义库并绑定到轨道）。') }}</span></div>
          <div class="help-sec"><b>{{ t('逻辑编辑器') }}</b><span>{{ t('按“目标→条件→操作”批量修改音符：力度、时值、音高、删除、量化、移调。') }}</span></div>
          <div class="help-sec"><b>{{ t('列表编辑器') }}</b><span>{{ t('以表格精确编辑每个音符的起点/终点/音高/力度；支持添加、删除、排序。') }}</span></div>
          <div class="help-sec"><b>{{ t('宏系统') }}</b><span>{{ t('内置清理/移调/力度标准化宏；支持自定义命令宏。') }}</span></div>
          <div class="help-sec"><b>{{ t('智能量化') }}</b><span>{{ t('按 1/4、1/8、1/16、1/32 量化；支持 Funk/Jazz/Rock/Latin/自定义 Groove；可提取选中音符的 Groove。') }}</span></div>
          <div class="help-sec"><b>{{ t('鼓组编辑器') }}</b><span>{{ t('打击乐专用网格视图，点击添加/删除鼓点，支持鼓轨切换与清除。') }}</span></div>
          <div class="help-sec"><b>{{ t('智能伴奏') }}</b><span>{{ t('基于当前旋律/和弦自动生成 贝斯 + 分解和弦 + 铺底 3 轨（可撤销）。') }}</span></div>
          <div class="help-sec"><b>{{ t('音频对齐') }}</b><span>{{ t('载入原音频后在卷帘底部显示波形；「吸附起音」把音符吸附到最近的波形起音（±80ms）；「试听」同步播放原音频检查对齐效果。') }}</span></div>
          <div class="help-sec"><b>{{ t('影视配乐') }}</b><span>{{ t('载入视频轨道嵌入编辑区右上角，播放 MIDI 时自动同步，用于影视配乐对齐。') }}</span></div>
        </div>
      </div>
    </div>
    </Transition>

    <!-- 钢琴卷帘右键菜单 -->
    <Transition name="ov">
      <div v-if="ctxMenu" class="ctx-mask" @click.self="closeCtxMenu" @contextmenu.prevent="closeCtxMenu">
        <div class="ctx-menu" :style="ctxMenuStyle()" @mouseleave="ctxSub = ''">
          <button class="ctx-item" @click="ctxCut"><span>{{ t('剪切') }}</span></button>
          <button class="ctx-item" @click="ctxCopy"><span>{{ t('复制') }}</span><span class="ctx-k">Ctrl+C</span></button>
          <button class="ctx-item" @click="ctxPaste"><span>{{ t('粘贴到指针处') }}</span><span class="ctx-k">Ctrl+V</span></button>
          <button class="ctx-item" @click="ctxDup"><span>{{ t('重复') }}</span></button>
          <div class="ctx-sep"></div>

          <!-- M3：右键直达参数工具（不用先开面板再找工具） -->
          <button class="ctx-item" @click="ctxRunTool('transpose')"><span>{{ t('参数工具：移调') }}</span><span class="ctx-k">{{ t('拖动即预览') }}</span></button>
          <button class="ctx-item" @click="ctxRunTool('quantize')"><span>{{ t('参数工具：量化') }}</span></button>
          <button class="ctx-item" @click="ctxRunTool('velHumanize')"><span>{{ t('参数工具：力度人性化') }}</span></button>
          <button class="ctx-item" @click="ctxRunTool('swing')"><span>{{ t('参数工具：摇摆') }}</span></button>
          <button class="ctx-item" @click="ctxRunTool('thin')"><span>{{ t('参数工具：稀疏化') }}</span></button>
          <button class="ctx-item" @click="openPalette"><span>{{ t('全部命令…') }}</span><span class="ctx-k">Ctrl+Shift+P</span></button>
          <div class="ctx-sep"></div>

          <div class="ctx-sub-wrap" @mouseenter="ctxSub = 'quantize'">
            <button class="ctx-item" :class="{ on: ctxSub === 'quantize' }"><span>{{ t('量化') }}</span><span class="ctx-arrow">▸</span></button>
            <div v-if="ctxSub === 'quantize'" class="ctx-menu ctx-sub" :class="{ flip: ctxSubFlip }">
              <button class="ctx-item" v-for="q in CTX_QUANTIZE" :key="q[1]" @click="ctxQuantize(q[1])"><span>{{ q[0] }}</span></button>
              <div class="ctx-sep"></div>
              <button class="ctx-item" @click="ctxQuantize(snapRatio)"><span>{{ t('按当前吸附网格') }}</span><span class="ctx-k">{{ snapRatio ? snapRatio : '—' }}</span></button>
            </div>
          </div>

          <div class="ctx-sub-wrap" @mouseenter="ctxSub = 'transpose'">
            <button class="ctx-item" :class="{ on: ctxSub === 'transpose' }"><span>{{ t('移调') }}</span><span class="ctx-arrow">▸</span></button>
            <div v-if="ctxSub === 'transpose'" class="ctx-menu ctx-sub" :class="{ flip: ctxSubFlip }">
              <button class="ctx-item" @click="ctxTranspose(1)"><span>{{ t('升 1 个半音') }}</span></button>
              <button class="ctx-item" @click="ctxTranspose(-1)"><span>{{ t('降 1 个半音') }}</span></button>
              <button class="ctx-item" @click="ctxTranspose(12)"><span>{{ t('升 1 个八度') }}</span></button>
              <button class="ctx-item" @click="ctxTranspose(-12)"><span>{{ t('降 1 个八度') }}</span></button>
            </div>
          </div>

          <div class="ctx-sub-wrap" @mouseenter="ctxSub = 'velocity'">
            <button class="ctx-item" :class="{ on: ctxSub === 'velocity' }"><span>{{ t('力度') }}</span><span class="ctx-arrow">▸</span></button>
            <div v-if="ctxSub === 'velocity'" class="ctx-menu ctx-sub" :class="{ flip: ctxSubFlip }">
              <button class="ctx-item" @click="ctxVel(5)"><span>{{ t('力度 +5') }}</span></button>
              <button class="ctx-item" @click="ctxVel(-5)"><span>{{ t('力度 −5') }}</span></button>
              <div class="ctx-sep"></div>
              <button class="ctx-item" @click="ctxVelReset"><span>{{ t('重置为默认力度') }}</span><span class="ctx-k">80</span></button>
            </div>
          </div>
          <div class="ctx-sep"></div>

          <button class="ctx-item" @click="ctxSamePitch"><span>{{ t('选中同音高') }}</span></button>
          <button class="ctx-item" @click="ctxMute(true)"><span>{{ t('静音选中') }}</span></button>
          <button class="ctx-item" @click="ctxMute(false)"><span>{{ t('取消静音') }}</span></button>
          <button class="ctx-item" @click="ctxSelectAll"><span>{{ t('全选') }}</span><span class="ctx-k">Ctrl+A</span></button>
          <button class="ctx-item" @click="ctxSelectNone"><span>{{ t('取消选择') }}</span></button>
          <div class="ctx-sep"></div>

          <button class="ctx-item" :title="t('拖拽与新建音符只落在当前音阶的调内音')" @click="ctxToggleScaleSnap">
            <span>{{ t('音阶吸附') }}</span><span v-if="scaleSnap" class="ctx-check">✓</span>
          </button>
          <button class="ctx-item danger" @click="ctxDelete"><span>{{ t('删除') }}</span><span class="ctx-k">Del</span></button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* min-width:0 是必须的：本页是一个 flex 项，自动最小尺寸 = 内容的 min-content，
   而钢琴卷帘 canvas 的固有宽度会把 min-content 顶到 1200+，整页于是溢出到视口外被
   .app-main 的 overflow-x:hidden 裁掉（工具条右侧的「更多」、状态栏右侧、右上角小地图
   全都在视口外——「看不到」的根因就在这里）。 */
/* 另外三行是同一个坑的另一半：全局 .page 用 margin:0 auto + max-width 居中，
   而**交叉轴上的 auto 外边距会让 stretch 失效**，于是本页按 max-content 撑到 1233px、
   被外层裁掉；width:100% + margin:0 才是工作台页该有的行为（要铺满，不居中）。 */
.edit-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; min-width: 0; width: 100%; max-width: none; margin: 0; padding: 12px var(--page-pad-x) 0; }
.ed-toolbar-wrap { position: relative; flex: none; }
.ed-toolbar { padding: 5px 10px; display: flex; align-items: center; gap: 3px; flex-wrap: nowrap; overflow-x: auto; flex: none; margin-bottom: 8px; border-radius: 12px; }
.ed-view-switch { background: var(--surface-soft); border-radius: 9px; padding: 2px; gap: 2px; }
/* 分段控件内按钮压到 22px，加上 2px 内边距后整组正好 26px，与同排按钮同高同基线 */
.ed-view-switch .et-btn { height: 22px; min-height: 22px; padding: 0 10px; }
.ed-main { display: flex; gap: 10px; flex: 1; min-height: 0; }
.ed-insp { width: var(--inspector-w); flex: none; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
/* 检查器与舞台之间的拖拽分隔条 */
.ed-split { flex: none; width: 7px; margin: 0 -4px; cursor: ew-resize; position: relative; touch-action: none; }
.ed-split::after { content: ''; position: absolute; inset: 0 3px; border-radius: 3px; background: transparent; transition: background .15s; }
.ed-split:hover::after { background: var(--brand); }
/* 窄窗口：逐级收窄检查器，把宽度让给卷帘（默认窗口下保持 232px 不动） */
@media (max-width: 1120px) { .edit-view { --inspector-w: 200px; } }
@media (max-width: 1000px) { .edit-view { --inspector-w: 176px; } }
.insp-sec { background: var(--surface); border: 1px solid var(--hairline); border-radius: 12px; padding: 9px 10px; display: flex; flex-direction: column; gap: 6px; }
.insp-h { display: flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700; color: var(--stone); }
.insp-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 12px; color: var(--slate); }
.insp-row > span { flex: none; }
.insp-row b { color: var(--ink); font-weight: 600; font-size: 11.5px; font-family: var(--mono); font-variant-numeric: tabular-nums; }
.insp-row .select-input, .insp-row .num-input { width: 100px; }
.insp-range { width: 100%; }
.insp-btns { display: flex; gap: 5px; flex-wrap: wrap; }
.insp-btns .btn { flex: 1; min-width: 0; padding: 3px 6px; font-size: 11px; justify-content: center; }
.ed-stage { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ed-status { display: flex; align-items: center; gap: 14px; height: var(--statusbar-h); padding: 0 6px; margin-top: 6px; border-top: 1px solid var(--hairline); font-size: 11px; color: var(--stone); min-width: 0; overflow: hidden; flex: none; overflow: hidden; }
.st-i { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; flex: none; }
.st-i b { color: var(--ink); font-family: var(--mono); font-weight: 600; font-variant-numeric: tabular-nums; }
.st-grow { flex: 1; }
.st-tip { color: var(--muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ed-drum { display: flex; flex-direction: column; gap: 6px; }
.ed-drum-bar { display: flex; align-items: center; gap: 8px; flex: none; }
.ed-drum-bar .select-input { min-width: 170px; }
.ed-drum .drum-canvas { flex: 1; min-height: 0; width: 100%; display: block; background: var(--canvas); border: 1px solid var(--hairline); border-radius: 10px; cursor: crosshair; }
.et-group { display: flex; align-items: center; gap: 4px; }
/* 统一 26px 基准高度：原先分段控件（padding 2px + 26px 按钮 = 30px）比同排按钮高 2px，
   是「功能栏错位」的直接原因 */
.et-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 26px; min-height: 26px; padding: 0 9px; border: 1px solid transparent; border-radius: 8px; background: transparent; font-size: 12px; line-height: 1; white-space: nowrap; color: var(--slate); cursor: pointer; transition: background .13s, color .13s, border-color .13s; }
.et-btn:hover { background: var(--surface-soft); color: var(--ink); }
.et-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
.et-btn.danger { color: var(--error); }
/* 不再用 margin-left:auto 把「更多」顶到最右（会留下大段空隙）。
   工具栏在极窄窗口下靠横向滚动兜底，sticky 让「更多」始终钉在右边缘可见。 */
.et-btn.et-more {
  margin-left: 0;
  position: sticky;
  right: 0;
  background: var(--canvas);
}
.et-btn.et-more.active { background: var(--surface-soft); color: var(--ink); }
.et-sep { width: 1px; height: 18px; background: var(--hairline); margin: 0 4px; flex: none; }
.et-label { font-size: 11px; color: var(--stone); }
.ed-nav { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.ed-mini { flex: 1; background: var(--canvas); border: 1px solid var(--hairline); border-radius: 8px; display: block; cursor: pointer; }
.ed-zoom { display: flex; align-items: center; gap: 5px; flex: none; }
.ez-pct { font-size: 11px; color: var(--steel); min-width: 42px; text-align: center; font-variant-numeric: tabular-nums; }
.insp-range { accent-color: var(--accent); }
.num-input { width: 60px; padding: 3px 5px; font-size: 11px; background: var(--canvas); border: 1px solid var(--hairline); border-radius: 6px; color: var(--ink); font-family: var(--mono); outline: none; }
.num-input:focus { border-color: var(--ink); }
.et-tip { margin-left: auto; color: var(--stone); font-size: 10.5px; }
.ed-modal-mask { position: fixed; inset: 0; background: rgba(10,10,10,0.35); display: flex; align-items: center; justify-content: center; z-index: var(--z-modal); }
.ed-modal { width: min(560px, 92vw); background: var(--canvas); border-radius: 14px; box-shadow: 0 24px 64px rgba(16,24,40,0.2); padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.ed-modal-head { display: flex; align-items: center; gap: 10px; font-size: 14px; color: var(--ink); }
.ed-modal-head b { font-size: 15px; }
.vc-canvas { width: 100%; display: block; background: var(--canvas); border: 1px solid var(--hairline); border-radius: 10px; cursor: crosshair; touch-action: none; }
.ed-modal-foot { display: flex; justify-content: flex-end; gap: 8px; }
.ed-list-scroll { max-height: 40vh; overflow: auto; border: 1px solid var(--hairline); border-radius: 10px; }
.ed-list-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.ed-list-table th { position: sticky; top: 0; background: var(--surface); text-align: left; padding: 6px 8px; font-weight: 600; color: var(--slate); border-bottom: 1px solid var(--hairline); font-size: 11px; }
.ed-list-table td { padding: 3px 6px; border-bottom: 1px solid var(--hairline-soft); color: var(--ink); }
.ed-list-table td .num-input { width: 70px; }
.drum-canvas { width: 100%; display: block; background: var(--canvas); border: 1px solid var(--hairline); border-radius: 10px; cursor: crosshair; touch-action: none; }
/* 「更多」高级工具面板：悬浮分栏卡片（贴在工具栏正下方）。
   历史问题有两个：
     ① 原先是「在文档流里」的块，展开就把钢琴卷帘压矮（卷帘过小）；
     ② 改成 auto-fit 网格后每个分组仍是裸 flex 行，各格内容行数差异大、控件高度
        22/26/20 混杂 → 视觉上「排列不整齐且错位」。
   现在：绝对定位浮层（不占舞台高度）+ 分组卡片（标题独占一行、控件统一 22px 高、
   组内左对齐成列），宽度自适应分栏，整体限高内滚。 */
.ed-adv {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: var(--z-overlay);
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(232px, 1fr));
  align-items: start;
  gap: 8px 10px;
  padding: 10px;
  max-height: min(54vh, 400px);
  overflow-y: auto;
  background: var(--surface);
  box-shadow: 0 18px 48px rgba(16, 24, 40, .18);
}
/* 分组卡片：标题一行、控件区一行起，组内按钮与输入框按同一基准线排列 */
.ed-adv .adv-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  align-content: flex-start;
  gap: 4px 6px;
  min-width: 0;
  min-height: 62px;
  padding: 6px 8px;
  background: var(--surface-soft);
  border: 1px solid var(--hairline);
  border-radius: 10px;
}
/* 首个标签作为分组标题：独占整行，其余（BPM 等行内小标题）保持内联 */
.ed-adv .adv-row > .et-label:first-child {
  flex: 0 0 100%;
  margin-bottom: 1px;
  color: var(--stone);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: .02em;
}
.ed-adv .adv-row .et-label { flex: none; color: var(--stone); font-size: 11px; font-weight: 600; }
.ed-adv .adv-row .et-sep { display: none; }
/* 面板内控件统一到 22px 高：按钮与下拉/数字/文本输入同高，消除错位 */
.ed-adv .et-btn { height: 22px; min-height: 22px; padding: 0 8px; font-size: 11.5px; }
.ed-adv .select-input { height: 22px; padding: 0 24px 0 8px; font-size: 11.5px; background-position: right 7px center; }
.ed-adv .num-input, .ed-adv .text-input { height: 22px; padding: 0 7px; font-size: 11.5px; }
.adv-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.adv-form-grid label { font-size: 12px; color: var(--slate); display: flex; flex-direction: column; gap: 5px; }
.adv-form-grid .span2 { grid-column: 1 / -1; }
.adv-form-sec { border-top: 1px dashed var(--hairline); padding-top: 10px; margin-top: 6px; display: flex; flex-direction: column; gap: 6px; }
.adv-form-sec-title { font-size: 12px; font-weight: 700; color: var(--ink); }
.macro-list { display: flex; flex-direction: column; gap: 6px; }
.macro-list .btn { width: 100%; flex-direction: column; align-items: flex-start; gap: 2px; }
.macro-item { display: flex; align-items: center; gap: 8px; background: var(--surface); border: 1px solid var(--hairline); border-radius: 8px; padding: 4px 8px; }
.macro-name { flex: 0 0 auto; font-size: 12px; font-weight: 600; }
.macro-cmd { font-family: var(--mono); font-size: 10.5px; color: var(--stone); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.macro-add { display: flex; gap: 6px; }
.macro-record-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.macro-record-list { display: flex; flex-wrap: wrap; gap: 4px; border: 1px dashed var(--hairline); border-radius: 8px; padding: 6px; background: var(--surface-soft); }
.macro-record-line code { font-family: var(--mono); font-size: 11px; color: var(--accent); }
.macro-doc { display: flex; flex-direction: column; gap: 4px; }
.macro-doc-row { display: flex; align-items: baseline; gap: 10px; font-size: 11.5px; color: var(--slate); }
.macro-doc-row code { font-family: var(--mono); color: var(--accent); flex: 0 0 96px; }
.ks-list { max-height: 50vh; overflow: auto; display: flex; flex-direction: column; gap: 4px; border: 1px solid var(--hairline); border-radius: 10px; padding: 6px; }
.ks-row { display: flex; align-items: center; gap: 8px; padding: 2px 6px; border-radius: 6px; }
.ks-row:nth-child(odd) { background: var(--surface-soft); }
.ks-label { width: 64px; font-size: 11px; color: var(--stone); flex: none; }
.help-scroll { max-height: 60vh; overflow: auto; display: flex; flex-direction: column; gap: 8px; font-size: 12px; color: var(--slate); line-height: 1.7; }
.help-sec b { display: block; color: var(--ink); }
.ed-fullscreen .page-head { display: none; }
.ed-fullscreen .ed-wrap-rel { flex: 1; }
.ed-fullscreen .ed-status { display: flex; }
/* 全屏时收起左侧检查器，把宽度全部让给卷帘 */
.ed-fullscreen .ed-insp { display: none; }
/* 全屏就是「把一切都让给卷帘」：连 34px 的迷你总览也收掉（需要时按 Esc 退出） */
.ed-fullscreen .ed-nav { display: none; }
.ed-fullscreen .chord-lane { display: none; }
.ed-fullscreen .ed-toolbar { display: flex; }
/* 全屏模式屏幕更高：每栏放宽，展示高度也放宽（仍是悬浮卡片网格） */
.ed-fullscreen .ed-adv {
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  max-height: min(62vh, 520px);
}
.ed-wrap-rel { position: relative; flex: 1; min-height: 0; }
/* 视图切换闪动：只动透明度与极小位移，不碰画布尺寸（画布是活的，重排会抖） */
.ed-wrap-rel.ed-flash { animation: edFlash 0.3s cubic-bezier(0.22, 0.7, 0.24, 1); }
@keyframes edFlash { from { opacity: 0.35; transform: translateY(3px); } to { opacity: 1; transform: none; } }
.ed-insp.ed-insp-in { animation: edInspIn 0.26s cubic-bezier(0.22, 0.7, 0.24, 1); }
@keyframes edInspIn { from { opacity: 0; transform: translateX(10px); } to { opacity: 1; transform: none; } }
.ed-pop-enter-active { transition: opacity 0.22s ease, transform 0.22s cubic-bezier(0.22, 0.7, 0.24, 1); }
.ed-pop-leave-active { transition: opacity 0.16s ease, transform 0.16s ease; }
.ed-pop-enter-from { opacity: 0; transform: translateY(-6px); }
.ed-pop-leave-to { opacity: 0; transform: translateY(-4px); }
/* 乐谱工具条：一条横排、可横向滚动，不换行（换行会吃掉音符区高度） */
.ed-scorebar { display: flex; align-items: center; gap: 4px; flex-wrap: nowrap; overflow-x: auto;
  flex: none; padding: 4px 8px; margin-bottom: 6px; border-radius: 10px; }
.ed-scorebar .et-label { flex: none; font-size: 11.5px; color: var(--stone); margin: 0 2px; }
.ed-scorebar .muted { flex: none; white-space: nowrap; }
.ed-video-overlay { position: absolute; top: 4px; right: 4px; width: 300px; max-width: 34%; border-radius: 8px; z-index: 20; background: #000; box-shadow: 0 6px 20px rgba(0,0,0,.25); }

/* ---------------- M1 骨架：菜单条 / 工作区预设 / 任务条 / 检查器分页 / 快捷键表 ---------------- */
/* position+z-index 是必须的：.card 带 backdrop-filter（自成层叠上下文），
   兄弟卡片按 DOM 顺序绘制 → 菜单弹层会被下面的工具条盖住。抬高菜单条这一层即可。 */
.ed-menubar-card { display: flex; align-items: center; gap: 8px; padding: 3px 8px; margin-bottom: 6px; flex: none; min-width: 0; position: relative; z-index: 40; }
.mb-grow { flex: 1; min-width: 0; }
.ed-presets { display: flex; gap: 2px; padding: 2px; background: var(--surface-soft); border: 1px solid var(--hairline); border-radius: 9px; }
.ps-chip { font-size: 11.5px; line-height: 1; padding: 5px 10px; border: 0; border-radius: 7px; background: transparent; color: var(--slate); cursor: pointer; transition: background .16s ease, color .16s ease; }
.ps-chip:hover { color: var(--ink); background: var(--canvas); }
.ps-chip.on { background: var(--accent); color: #fff; }
/* 上下文任务条：选中后原地出现高频操作。高度固定 32px，不随选择状态抖动 */
.ed-taskbar { display: flex; align-items: center; gap: 5px; flex-wrap: nowrap; overflow-x: auto; flex: none; padding: 4px 8px; margin-bottom: 6px; min-height: 34px; }
.ed-taskbar .et-btn { height: 24px; min-height: 24px; padding: 0 8px; font-size: 11.5px; }
.ed-step-group .select-input { height: 24px; padding: 0 22px 0 7px; font-size: 11.5px; }
.ed-step-pos { font-family: var(--mono); font-size: 11px; color: var(--ink); min-width: 34px; text-align: center; }
/* 鼓组命名表：两列、行高压到 24px，一屏看全 30 个音 */
.drum-name-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 12px; max-height: 52vh; overflow-y: auto; }
.drum-name-row { display: flex; align-items: center; gap: 8px; }
.drum-name-p { flex: none; width: 26px; text-align: right; font-family: var(--mono); font-size: 11px; color: var(--stone); }
.drum-name-row .text-input { flex: 1; min-width: 0; height: 24px; padding: 0 7px; font-size: 11.5px; }
/* 标签在窄条里被压成两行（「移调」竖着断成两截），必须 nowrap + 不参与收缩 */
.ed-taskbar .et-label { flex: none; white-space: nowrap; }
.tb-badge { font-size: 11.5px; font-weight: 700; color: #fff; background: var(--accent); border-radius: 7px; padding: 3px 8px; flex: none; font-variant-numeric: tabular-nums; }
.tb-hint { font-size: 11.5px; color: var(--stone); white-space: nowrap; }
/* 检查器分页 */
.insp-tabs { display: flex; gap: 2px; padding: 2px; background: var(--surface-soft); border: 1px solid var(--hairline); border-radius: 9px; flex: none; }
.insp-tab { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 24px; border: 0; border-radius: 7px; background: transparent; color: var(--slate); font-size: 11.5px; cursor: pointer; transition: background .16s ease, color .16s ease, box-shadow .16s ease; }
.insp-tab:hover { color: var(--ink); }
.insp-tab.on { background: var(--canvas); color: var(--ink); box-shadow: 0 1px 3px rgba(16,24,40,.10); }
.insp-pane { display: flex; flex-direction: column; gap: 8px; animation: inspPaneIn .22s cubic-bezier(.2,.7,.3,1); }
@keyframes inspPaneIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
/* 技法条（M5）：横向可滚的一排「技法段」 */
.art-lane { display: flex; align-items: center; gap: 6px; flex: none; padding: 4px 8px; margin-bottom: 6px; border-radius: 10px; }
.art-lane-label { font-size: 11px; color: var(--stone); flex: none; }
.art-cells { display: flex; align-items: center; gap: 4px; overflow-x: auto; flex: 1; min-width: 0; padding-bottom: 2px; }
.art-cell { display: inline-flex; align-items: center; gap: 3px; flex: none; padding: 2px 4px; border: 1px solid var(--hairline); border-radius: 8px; background: var(--canvas); }
.art-cell em { font-style: normal; font-size: 9.5px; color: var(--stone); white-space: nowrap; }
.art-cell .select-input { height: 22px; padding: 0 20px 0 6px; font-size: 11px; width: auto; max-width: 132px; }
.hv-art { font-size: 10px; color: var(--accent); border: 1px solid var(--hairline); border-radius: 5px; padding: 0 4px; }

/* 悬停工具条（M3）：fixed 定位，不参与舞台布局（卷帘高度不会因为它抖动） */
.hv-bar { position: fixed; z-index: var(--z-overlay); display: flex; align-items: center; gap: 3px; padding: 3px 5px;
  background: var(--canvas); border: 1px solid var(--hairline); border-radius: 10px; box-shadow: var(--shadow-lg);
  animation: hvIn .16s cubic-bezier(.2,.7,.3,1); }
@keyframes hvIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.hv-name { font-size: 11px; font-weight: 700; color: var(--ink); font-family: var(--mono); padding: 0 2px; }
.hv-vel { font-size: 10.5px; color: var(--stone); font-family: var(--mono); }
.hv-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; padding: 0 5px;
  border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--slate); font-size: 11px; cursor: pointer;
  transition: background .13s ease, color .13s ease; }
.hv-btn:hover { background: var(--surface-soft); color: var(--ink); }
.hv-btn.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.hv-btn.danger { color: var(--error); }
.hv-sep { width: 1px; height: 15px; background: var(--hairline); margin: 0 2px; }
.hv-multi { font-size: 10px; color: var(--stone); padding-left: 4px; }

/* 状态栏右侧的小按钮 */
.st-btn { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 7px; border: 1px solid var(--hairline); border-radius: 6px; background: var(--canvas); color: var(--slate); font-size: 10.5px; cursor: pointer; transition: background .14s ease, color .14s ease; }
.st-btn:hover { color: var(--ink); background: var(--surface-soft); }
.st-btn.on { color: var(--ink); border-color: var(--accent); }
/* 快捷键一览 */
/* 两列（不 auto-fit）：四组正好 2×2，不会出现「第三列空着、第四组掉到第二行」 */
.ed-keys { width: min(700px, 94vw); }
.keys-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 22px; max-height: 62vh; overflow-y: auto; }
.keys-h { font-size: 11px; font-weight: 700; color: var(--stone); letter-spacing: .02em; margin-bottom: 4px; }
.keys-row { display: flex; align-items: baseline; gap: 8px; font-size: 12px; color: var(--slate); padding: 2px 0; }
.keys-row kbd { flex: none; min-width: 96px; text-align: center; font-family: var(--mono); font-size: 10.5px; color: var(--ink); background: var(--surface-soft); border: 1px solid var(--hairline); border-bottom-width: 2px; border-radius: 5px; padding: 1px 6px; }

/* P1-2 和弦轨 */
.chord-lane { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.chord-lane-label { font-size: 11px; color: var(--stone); flex: none; }
.chord-cells { display: flex; gap: 2px; overflow-x: auto; flex: 1; min-width: 0; padding-bottom: 2px; }
.chord-cell { display: inline-flex; flex-direction: column; align-items: center; gap: 1px; min-width: 46px; padding: 2px 6px; border: 1px solid var(--hairline); border-radius: 6px; background: var(--canvas); cursor: pointer; flex: none; }
.chord-cell:hover { background: var(--surface-soft); }
.chord-cell em { font-style: normal; font-size: 9px; color: var(--stone); line-height: 1.1; }
.chord-cell b { font-size: 11px; color: var(--ink); line-height: 1.2; }
.chord-cell.manual { border-color: var(--accent); }

/* 钢琴卷帘右键菜单 */
.ctx-mask { position: fixed; inset: 0; z-index: var(--z-ctx); }
.ctx-menu { position: fixed; min-width: 182px; background: var(--canvas); border: 1px solid var(--hairline); border-radius: 10px; box-shadow: var(--shadow-lg); padding: 4px; display: flex; flex-direction: column; gap: 2px; }
.ctx-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; text-align: left; border: none; background: transparent; color: var(--ink); padding: 7px 10px; border-radius: 6px; font-size: 12.5px; cursor: pointer; }
.ctx-item:hover, .ctx-item.on { background: var(--surface-soft); }
.ctx-item.danger { color: var(--error); }
.ctx-k { color: var(--stone); font-size: 10.5px; font-family: var(--mono); flex: none; }
.ctx-arrow { color: var(--stone); font-size: 11px; line-height: 1; }
.ctx-check { color: var(--accent); font-size: 12px; }
.ctx-sub-wrap { position: relative; }
.ctx-menu.ctx-sub { position: absolute; left: 100%; top: -4px; min-width: 158px; max-height: 46vh; overflow-y: auto; }
.ctx-menu.ctx-sub.flip { left: auto; right: 100%; }
.ctx-sep { height: 1px; background: var(--hairline); margin: 3px 6px; }
</style>
