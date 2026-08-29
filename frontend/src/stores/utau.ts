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
}

const LS_KEY = 'fufumidi_utau_project_v1';
let _nid = 1;
const nid = () => 'n' + (++_nid).toString(36) + Date.now().toString(36).slice(-4);

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
    selectedId: null as string | null,
    voicebankDir: '',   // 桌面版：声库目录；网页版可为空（用测试音源/仅编辑）
  }),
  getters: {
    selected(state): UtauNote | null {
      return state.notes.find(n => n.id === state.selectedId) || null;
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
    },
    persist() {
      try { localStorage.setItem(LS_KEY, JSON.stringify(this.$state)); } catch (e) {}
    },
    addNote(startBeat: number, pitch: number): string {
      const note: UtauNote = {
        id: nid(), startBeat, durBeat: 1, pitch, lyric: 'あ',
        velocity: 100, volume: 100, vibrato: false, vibDepth: 25, vibFreq: 5.5, flags: '',
      };
      this.notes.push(note);
      this.selectedId = note.id;
      this.persist();
      return note.id;
    },
    removeNote(id: string) {
      this.notes = this.notes.filter(n => n.id !== id);
      if (this.selectedId === id) this.selectedId = this.notes.length ? this.notes[0].id : null;
      this.persist();
    },
    updateNote(id: string, patch: Partial<UtauNote>) {
      const n = this.notes.find(x => x.id === id);
      if (!n) return;
      Object.assign(n, patch);
      this.persist();
    },
    clear() { this.notes = []; this.selectedId = null; this.persist(); },
    select(id: string | null) { this.selectedId = id; },
    setBpm(v: number) { this.bpm = Math.max(20, Math.min(400, v)); this.persist(); },
    setSampleNote(v: string) { this.sampleNote = v; this.persist(); },
    setVoicebank(dir: string) { this.voicebankDir = dir; this.persist(); },
  },
});