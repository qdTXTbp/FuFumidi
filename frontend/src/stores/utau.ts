// Pinia：UTAU 工作台共享状态
// 语义：一个 UTAU 工程 = 选定的声库 + 音符序列（音高/歌词/时长）+ 调声参数。
import { defineStore } from 'pinia';

export interface UtauNote {
  id: string;
  startBeat: number;   // 起点（拍，四分音符=1）
  durBeat: number;     // 时长（拍）
  pitch: number;       // MIDI 音高号（60=C4）
  lyric: string;       // 歌词/音节（对应声库 oto 别名）
  velocity: number;    // 子音速度 0-200
  volume: number;      // 音量 %
  vibrato: boolean;
  vibDepth: number;    // 颤音深度（音分）
  vibFreq: number;     // 颤音频率 Hz
  flags: string;       // 调声 flags（预留，引擎后续支持）
  params?: {           // P0-3 逐音符合成参数（音高偏差 / 性别 / 气声）；缺省即默认值
    pitch?: number;    // 音分偏移 -100..100
    gender?: number;   // 明亮度 0..100（50=不变）
    breath?: number;   // 气声 0..100
  };
  pitchCurve?: { pos: number; cents: number }[];  // P1-1 手绘音高曲线：pos 0-1（相对音符时长），cents 相对基频
}

// 新建音符的默认调声参数；「重置参数」也回到这里的取值
export const NOTE_DEFAULTS = { velocity: 100, volume: 100, vibrato: false, vibDepth: 25, vibFreq: 5.5, flags: '' };

/* ---------- P0-3 参数车道：参数元数据与读写 ---------- */
export type UtauParamKey = 'pitch' | 'vibDepth' | 'volume' | 'gender' | 'breath';

export const UTAU_PARAMS: { key: UtauParamKey; label: string; min: number; max: number; def: number; bipolar: boolean }[] = [
  { key: 'pitch', label: '音高偏差', min: -100, max: 100, def: 0, bipolar: true },
  { key: 'vibDepth', label: '颤音深度', min: 0, max: 100, def: 25, bipolar: false },
  { key: 'volume', label: '音量', min: 0, max: 200, def: 100, bipolar: false },
  { key: 'gender', label: '性别', min: 0, max: 100, def: 50, bipolar: false },
  { key: 'breath', label: '气声', min: 0, max: 100, def: 0, bipolar: false },
];

export function paramMeta(key: UtauParamKey) {
  return UTAU_PARAMS.find(p => p.key === key) || UTAU_PARAMS[0];
}
const clampParam = (key: UtauParamKey, v: number) => {
  const m = paramMeta(key);
  return Math.max(m.min, Math.min(m.max, Number(v) || 0));
};

/** 读取某参数当前值（volume / vibDepth 复用已有扁平字段，其余取 params） */
export function paramValue(n: UtauNote, key: UtauParamKey): number {
  if (key === 'volume') return n.volume;
  if (key === 'vibDepth') return n.vibDepth;
  const p = n.params || {};
  if (key === 'pitch') return p.pitch != null ? p.pitch : 0;
  if (key === 'gender') return p.gender != null ? p.gender : 50;
  if (key === 'breath') return p.breath != null ? p.breath : 0;
  return 0;
}

const LS_KEY = 'fufumidi_utau_project_v1';
let _nid = 1;
const nid = () => 'n' + (++_nid).toString(36) + Date.now().toString(36).slice(-4);

// 撤销快照：音符列表 + bpm + 选区
interface Snap { notes: UtauNote[]; bpm: number; selectedIds: string[] }
const MAX_HISTORY = 100;
const cloneNotes = (ns: UtauNote[]) => ns.map(n => ({ ...n }));

function readProject(): { bpm: number; sampleNote: string; notes: UtauNote[] } {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.notes)) {
        return { bpm: d.bpm || 120, sampleNote: d.sampleNote || 'C4', notes: d.notes };
      }
    }
  } catch (e) {}
  return { bpm: 120, sampleNote: 'C4', notes: [] };
}

export const useUtauStore = defineStore('utau', {
  state: () => ({
    bpm: 120,
    sampleNote: 'C4',
    notes: [] as UtauNote[],
    selectedId: null as string | null,      // 主选中（调声页绑定）
    selectedIds: [] as string[],            // 多选集合
    undoStack: [] as Snap[],
    redoStack: [] as Snap[],
    voicebankDir: '',   // 桌面版：声库目录；网页版可为空（用测试音源/仅编辑）
    voicebanks: [] as { name: string; dir: string }[],  // 已导入的声库列表
  }),
  getters: {
    selected(state): UtauNote | null {
      return state.notes.find(n => n.id === state.selectedId) || null;
    },
    selectedNotes(state): UtauNote[] {
      const ids = new Set(state.selectedIds);
      return state.notes.filter(n => ids.has(n.id));
    },
    sortedNotes(state): UtauNote[] {
      return state.notes.slice().sort((a, b) => a.startBeat - b.startBeat);
    },
    totalBeats(state): number {
      let m = 0;
      for (const n of state.notes) m = Math.max(m, n.startBeat + n.durBeat);
      return m;
    },
  },
  actions: {
    init() {
      const p = readProject();
      this.bpm = p.bpm; this.sampleNote = p.sampleNote; this.notes = p.notes;
      this.undoStack = []; this.redoStack = [];
    },
    persist() {
      try {
        // 不落盘撤销历史，避免 localStorage 无限膨胀
        const { undoStack, redoStack, ...rest } = this.$state as unknown as Record<string, unknown>;
        void undoStack; void redoStack;
        localStorage.setItem(LS_KEY, JSON.stringify(rest));
      } catch (e) {}
    },

    /* ---------- 历史（撤销/重做） ---------- */
    pushUndo() {
      this.undoStack.push({ notes: cloneNotes(this.notes), bpm: this.bpm, selectedIds: [...this.selectedIds] });
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
      this.redoStack = [];
    },
    undo() {
      const s = this.undoStack.pop();
      if (!s) return false;
      this.redoStack.push({ notes: cloneNotes(this.notes), bpm: this.bpm, selectedIds: [...this.selectedIds] });
      this._restore(s);
      return true;
    },
    redo() {
      const s = this.redoStack.pop();
      if (!s) return false;
      this.undoStack.push({ notes: cloneNotes(this.notes), bpm: this.bpm, selectedIds: [...this.selectedIds] });
      this._restore(s);
      return true;
    },
    _restore(s: Snap) {
      this.notes = s.notes;
      this.bpm = s.bpm;
      this.selectedIds = s.selectedIds.filter(id => this.notes.some(n => n.id === id));
      this.selectedId = this.selectedIds[this.selectedIds.length - 1] || null;
      this.persist();
    },

    /* ---------- 选区 ---------- */
    select(id: string | null) {
      this.selectedId = id;
      this.selectedIds = id ? [id] : [];
    },
    setSelection(ids: string[]) {
      this.selectedIds = ids;
      this.selectedId = ids.length ? (ids[ids.length - 1] ?? null) : null;
    },
    toggleSelect(id: string) {
      const i = this.selectedIds.indexOf(id);
      if (i >= 0) this.selectedIds.splice(i, 1);
      else { this.selectedIds.push(id); this.selectedId = id; }
      if (this.selectedId && !this.selectedIds.includes(this.selectedId)) {
        this.selectedId = this.selectedIds[this.selectedIds.length - 1] || null;
      }
    },
    selectAll() { this.setSelection(this.notes.map(n => n.id)); },

    /* ---------- 音符增删改 ---------- */
    addNote(startBeat: number, pitch: number): string {
      this.pushUndo();
      const note: UtauNote = {
        id: nid(), startBeat, durBeat: 1, pitch, lyric: 'あ',
        ...NOTE_DEFAULTS,
      };
      this.notes.push(note);
      this.selectedId = note.id;
      this.selectedIds = [note.id];
      this.persist();
      return note.id;
    },
    // 粘贴/批量插入：notes 为不带 id 的纯数据，返回新 id 列表
    _makeNote(it: Partial<UtauNote>): UtauNote {
      return {
        id: nid(), startBeat: Math.max(0, it.startBeat ?? 0),
        durBeat: Math.max(0.125, it.durBeat ?? 1),
        pitch: Math.max(0, Math.min(127, it.pitch ?? 60)),
        lyric: it.lyric ?? 'あ',
        velocity: it.velocity ?? NOTE_DEFAULTS.velocity, volume: it.volume ?? NOTE_DEFAULTS.volume,
        vibrato: it.vibrato ?? NOTE_DEFAULTS.vibrato, vibDepth: it.vibDepth ?? NOTE_DEFAULTS.vibDepth,
        vibFreq: it.vibFreq ?? NOTE_DEFAULTS.vibFreq, flags: it.flags ?? NOTE_DEFAULTS.flags,
      };
    },
    addNotes(items: Partial<UtauNote>[]): string[] {
      if (!items.length) return [];
      this.pushUndo();
      const ids: string[] = [];
      for (const it of items) {
        const note = this._makeNote(it);
        this.notes.push(note); ids.push(note.id);
      }
      this.selectedIds = ids;
      this.selectedId = ids[ids.length - 1] ?? null;
      this.persist();
      return ids;
    },
    // 导入基底旋律：一次撤销合并。replace=true 先清空现有音符
    importNotes(items: Partial<UtauNote>[], replace = false): string[] {
      if (!items.length) return [];
      this.pushUndo();
      if (replace) { this.notes = []; this.selectedId = null; this.selectedIds = []; }
      const ids: string[] = [];
      for (const it of items) {
        const note = this._makeNote(it);
        this.notes.push(note); ids.push(note.id);
      }
      this.selectedIds = ids;
      this.selectedId = ids[ids.length - 1] ?? null;
      this.persist();
      return ids;
    },
    // 原位克隆并整体右移 offset 拍（Ctrl+D / Alt 拖拽复制）
    duplicateNotes(ids: string[], offset: number): string[] {
      const src = this.notes.filter(n => ids.includes(n.id));
      if (!src.length) return [];
      return this.addNotes(src.map(n => ({ ...n, startBeat: Math.max(0, n.startBeat + offset) })));
    },
    removeNote(id: string) { this.removeNotes([id]); },
    removeNotes(ids: string[]) {
      const set = new Set(ids);
      const hit = this.notes.filter(n => set.has(n.id));
      if (!hit.length) return;
      this.pushUndo();
      this.notes = this.notes.filter(n => !set.has(n.id));
      this.selectedIds = this.selectedIds.filter(id => !set.has(id));
      this.selectedId = this.selectedIds.length
        ? (this.selectedIds[this.selectedIds.length - 1] ?? null)
        : (this.notes[0]?.id ?? null);
      if (this.selectedId && !this.selectedIds.includes(this.selectedId)) this.selectedIds = [this.selectedId];
      this.persist();
    },
    // 单音符属性更新：不自动入历史（供拖拽逐帧调用，手势开始时由调用方 pushUndo）
    updateNote(id: string, patch: Partial<UtauNote>) {
      const n = this.notes.find(x => x.id === id);
      if (!n) return;
      Object.assign(n, patch);
      this.persist();
    },
    // 批量更新：整体一次入历史
    updateNotes(ids: string[], patch: Partial<UtauNote> | ((n: UtauNote) => Partial<UtauNote>)) {
      if (!ids.length) return;
      this.pushUndo();
      for (const n of this.notes) {
        if (!ids.includes(n.id)) continue;
        Object.assign(n, typeof patch === 'function' ? patch(n) : patch);
      }
      this.persist();
    },
    clear() {
      if (!this.notes.length) return;
      this.pushUndo();
      this.notes = []; this.selectedId = null; this.selectedIds = [];
      this.persist();
    },
    /* ---------- P0-3 参数车道 ---------- */
    /** 批量写参数；history=false 供拖拽逐帧调用（手势开始时由调用方 pushUndo） */
    setParams(ids: string[], key: UtauParamKey, value: number, history = true) {
      const list = this.notes.filter(n => ids.includes(n.id));
      if (!list.length) return;
      const v = clampParam(key, value);
      if (history) this.pushUndo();
      for (const n of list) {
        if (key === 'volume') n.volume = v;
        else if (key === 'vibDepth') n.vibDepth = v;
        else n.params = { ...(n.params || {}), [key]: v };
      }
      this.persist();
    },
    setParam(id: string, key: UtauParamKey, value: number) { this.setParams([id], key, value); },
    setParamsForSelection(key: UtauParamKey, value: number) { this.setParams([...this.selectedIds], key, value); },

    /* ---------- P1-1 手绘音高曲线 ---------- */
    /** 写入某音符的音高曲线（points 需按 pos 升序）；history=false 供拖拽逐帧调用 */
    setPitchCurve(id: string, points: { pos: number; cents: number }[], history = true) {
      const n = this.notes.find(x => x.id === id);
      if (!n) return;
      const pts = (points || [])
        .map(p => ({ pos: Math.max(0, Math.min(1, Number(p.pos) || 0)), cents: Math.max(-2400, Math.min(2400, Math.round(Number(p.cents) || 0))) }))
        .sort((a, b) => a.pos - b.pos);
      if (history) this.pushUndo();
      if (pts.length) n.pitchCurve = pts; else delete n.pitchCurve;
      this.persist();
    },
    clearPitchCurve(ids: string[]) {
      const list = this.notes.filter(n => ids.includes(n.id) && n.pitchCurve && n.pitchCurve.length);
      if (!list.length) return;
      this.pushUndo();
      for (const n of list) delete n.pitchCurve;
      this.persist();
    },
    /** 按 pos 采样曲线（线性插值）；无曲线返回 null */
    samplePitchCurve(n: UtauNote, pos: number) {
      const c = n.pitchCurve; if (!c || !c.length) return null;
      if (pos <= c[0].pos) return c[0].cents;
      const last = c[c.length - 1];
      if (pos >= last.pos) return last.cents;
      for (let i = 1; i < c.length; i++) {
        if (pos <= c[i].pos) {
          const a = c[i - 1], b = c[i];
          const k = (pos - a.pos) / Math.max(1e-6, b.pos - a.pos);
          return a.cents + (b.cents - a.cents) * k;
        }
      }
      return last.cents;
    },

    /* ---------- 一键重置（P1-5：让编辑结果可预测） ---------- */
    /** 重置颤音（音高相关的调声编辑） */
    resetVibrato(ids: string[]) {
      this.updateNotes(ids, { vibrato: NOTE_DEFAULTS.vibrato, vibDepth: NOTE_DEFAULTS.vibDepth, vibFreq: NOTE_DEFAULTS.vibFreq });
    },
    /** 重置全部调声参数（子音速度/音量/颤音/flags + P0-3 参数 + P1-1 音高曲线） */
    resetParams(ids: string[]) {
      const list = this.notes.filter(n => ids.includes(n.id));
      if (!list.length) return;
      this.pushUndo();
      for (const n of list) { Object.assign(n, NOTE_DEFAULTS); delete n.params; delete n.pitchCurve; }
      this.persist();
    },

    setBpm(v: number) { this.bpm = Math.max(20, Math.min(400, v)); this.persist(); },
    setSampleNote(v: string) { this.sampleNote = v; this.persist(); },
    setVoicebank(dir: string) { this.voicebankDir = dir; this.persist(); },
    setVoicebanks(list: { name: string; dir: string }[]) {
      this.voicebanks = list || [];
      // 当前声库失联则回退到已导入第一项
      if (this.voicebankDir && !this.voicebanks.some(v => v.dir === this.voicebankDir)) {
        this.voicebankDir = this.voicebanks.length ? (this.voicebanks[0]?.dir ?? '') : '';
      }
      this.persist();
    },
  },
});