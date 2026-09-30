// Pinia：DiffSinger 调教工作台共享状态
// 语义：一个 DiffSinger 工程 = 选定的声库 + 音符序列（音高/歌词/时长，拍制坐标）
//       + BPM + 调教参数（颤音/音分偏移）。模块未启用时本 store 只保留只读状态。
import { defineStore } from 'pinia';
import { bridge, isDesktop } from '../api';
import { parseMidi, buildSong } from '../core/midi.js';

export interface DsNote {
  id: string;
  startBeat: number;   // 起点（拍，四分音符=1）
  durBeat: number;     // 时长（拍）
  pitch: number;       // MIDI 音高号（60=C4）
  lyric: string;       // 歌词（查声库词典 / 音素）
  vibrato: boolean;
  vibDepth: number;    // 颤音深度（音分）
  vibFreq: number;     // 颤音频率 Hz
  vibFade: number;     // 颤音渐入（ms）
  pitchOffset: number; // 音分偏移 -100..100
}

export const DS_NOTE_DEFAULTS = { vibrato: false, vibDepth: 25, vibFreq: 5.5, vibFade: 0, pitchOffset: 0 };

const LS_KEY = 'fufumidi_diffsinger_project_v1';
let _nid = 1;
const nid = () => 'd' + (++_nid).toString(36) + Date.now().toString(36).slice(-4);

function readProject(): { bpm: number; voicebankDir: string; notes: DsNote[] } {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.notes)) {
        return { bpm: d.bpm || 120, voicebankDir: d.voicebankDir || '', notes: d.notes };
      }
    }
  } catch (e) {}
  return { bpm: 120, voicebankDir: '', notes: [] };
}

/* 从曲库曲目读取 MIDI 字节：内存缓存 → IndexedDB → 磁盘镜像 */
async function readSongBytes(song: any): Promise<Uint8Array | null> {
  if (!song) return null;
  if (song.__bytes) return song.__bytes;
  try {
    const req = indexedDB.open('fufumidi-db', 1);
    const db: any = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    const row: any = await new Promise((res) => {
      try {
        const rq = db.transaction('songs', 'readonly').objectStore('songs').get(song.id);
        rq.onsuccess = () => res(rq.result || null);
        rq.onerror = () => res(null);
      } catch (e) { res(null); }
    });
    if (row && row.bytes) return new Uint8Array(row.bytes);
  } catch (e) {}
  if (isDesktop && bridge && typeof bridge.readBinary === 'function' && song.meta && song.meta.path) {
    try {
      const r = await bridge.readBinary(song.meta.path);
      if (r && r.ok && r.bytes) return new Uint8Array(r.bytes as any);
    } catch (e) {}
  }
  return null;
}

/* IndexedDB 打开（与 app store 同库同表结构） */

// 最近一次渲染的 WAV 字节（不进响应式状态，供「导出 WAV」使用）
let _lastWavBytes: Uint8Array | null = null;
export function getLastWavBytes(): Uint8Array | null { return _lastWavBytes; }

export const useDiffsingerStore = defineStore('diffsinger', {
  state: () => ({
    /* 模块状态（主进程为准） */
    enabled: false,
    ready: false,
    depsOk: false,
    depsMissing: [] as string[],
    depsError: '',
    depsSkipped: false,
    vocoderInstalled: false,
    vocoderDir: '',
    checking: false,

    /* 组件安装 */
    runtimeInstalling: false,
    runtimePct: 0,
    runtimeText: '',
    runtimeError: '',

    /* 声库 */
    voicebanks: [] as { name: string; dir: string; size?: number }[],
    registry: [] as any[],
    vbProgress: {} as Record<string, { percent: number; phase?: string; done?: boolean; error?: string }>,
    voicebankInfo: null as any,
    inspecting: false,

    /* 工程 */
    bpm: 120,
    notes: [] as DsNote[],
    selectedId: null as string | null,
    voicebankDir: '',
    sourceName: '',   // 从曲库导入的 MIDI 曲目名
    sourceId: '',

    /* 渲染 */
    rendering: false,
    renderPct: 0,
    renderText: '',
    renderUrl: '',
    renderWarnings: [] as string[],
    lastDurationMs: 0,

    /* 范围渲染预览 —— 只合成选区内音符（可带前后文） */
    rangeEnabled: false,
    rangeStartBeat: 0,
    rangeEndBeat: 4,
    rangeContextSec: 0.5,
    /** 上次范围渲染返回的选区元信息（秒） */
    lastRange: null as any,
    /** 上次渲染使用的推理链路与后端 */
    lastPipeline: '',
    lastDevice: null as { provider: string; requested: string } | null,
    /** 推理后端偏好：auto / cpu / cuda / dml */
    device: 'auto' as string,
    /** 推理后端信息（来自 status.gpu） */
    gpu: null as any,
  }),
  getters: {
    selected(state): DsNote | null {
      return state.notes.find(n => n.id === state.selectedId) || null;
    },
    sortedNotes(state): DsNote[] {
      return state.notes.slice().sort((a, b) => a.startBeat - b.startBeat);
    },
    totalBeats(state): number {
      let m = 0;
      for (const n of state.notes) m = Math.max(m, n.startBeat + n.durBeat);
      return m;
    },
    hasBridge(): boolean {
      return isDesktop && !!bridge && typeof (bridge as any).diffsingerStatus === 'function';
    },
  },
  actions: {
    persist() {
      try {
        const { notes, bpm, voicebankDir } = this.$state as any;
        localStorage.setItem(LS_KEY, JSON.stringify({ notes, bpm, voicebankDir }));
      } catch (e) {}
    },
    init() {
      const p = readProject();
      this.bpm = p.bpm; this.voicebankDir = p.voicebankDir; this.notes = p.notes;
    },

    /* ---------------- 模块状态 ---------------- */
    async loadStatus() {
      if (!this.hasBridge) return;
      this.checking = true;
      try {
        const s = await (bridge as any).diffsingerStatus();
        if (s && s.ok) {
          this.enabled = !!s.enabled;
          this.ready = !!s.ready;
          this.depsOk = !!(s.deps && s.deps.ok);
          this.depsMissing = (s.deps && s.deps.missing) || [];
          this.depsError = (s.deps && s.deps.error) || '';
          this.depsSkipped = !!(s.deps && s.deps.skipped);
          this.vocoderInstalled = !!(s.vocoder && s.vocoder.installed);
          this.vocoderDir = (s.vocoder && s.vocoder.dir) || '';
          this.gpu = s.gpu || null;
        }
      } catch (e) {}
      this.checking = false;
    },
    async setEnabled(on: boolean): Promise<string> {
      if (!this.hasBridge) return '桌面版不可用';
      const r = await (bridge as any).diffsingerSetEnabled(!!on);
      if (r && r.ok) {
        this.enabled = !!r.enabled;
        await this.loadStatus();
        return '';
      }
      return (r && r.error) || '操作失败';
    },

    /* ---------------- 组件安装（启用后才允许） ---------------- */
    async installRuntime(): Promise<string> {
      if (!this.hasBridge) return '桌面版不可用';
      if (!this.enabled) return '请先启用 DiffSinger 模块';
      if (this.runtimeInstalling) return '组件安装已在进行中';
      this.runtimeInstalling = true;
      this.runtimePct = 0;
      this.runtimeText = '';
      this.runtimeError = '';
      let off = () => {};
      try {
        off = (bridge as any).onDiffsingerRuntimeProgress((p: any) => {
          if (!p) return;
          if (typeof p.percent === 'number' && p.percent >= 0) this.runtimePct = p.percent;
          if (p.text) this.runtimeText = String(p.text);
          if (p.phase === 'error') this.runtimeError = p.text || '安装失败';
        });
        const r = await (bridge as any).diffsingerInstallRuntime();
        if (r && r.ok) {
          await this.loadStatus();
          return '';
        }
        return (r && r.error) || '安装失败';
      } catch (e) {
        return String((e as any) && (e as any).message || e);
      } finally {
        off();
        this.runtimeInstalling = false;
      }
    },
    async cancelRuntimeInstall() {
      if (this.hasBridge) { try { await (bridge as any).diffsingerCancelRuntimeInstall(); } catch (e) {} }
      this.runtimeInstalling = false;
    },
    async uninstallRuntime(alsoVoicebanks: boolean): Promise<string> {
      if (!this.hasBridge) return '桌面版不可用';
      const r = await (bridge as any).diffsingerUninstallRuntime({ alsoVoicebanks });
      if (r && r.ok) { await this.loadStatus(); await this.refreshVoicebanks(); return ''; }
      return (r && r.error) || '清理失败';
    },

    /* ---------------- 声库管理 ---------------- */
    async refreshVoicebanks() {
      if (!this.hasBridge) return;
      try {
        const r = await (bridge as any).diffsingerListVoicebanks();
        this.voicebanks = (r && r.list) || [];
        if (this.voicebankDir && !this.voicebanks.some(v => v.dir === this.voicebankDir)) {
          this.voicebankDir = this.voicebanks.length ? (this.voicebanks[0].dir || '') : '';
          this.persist();
        }
        if (!this.voicebankDir && this.voicebanks.length) this.voicebankDir = this.voicebanks[0].dir || '';
      } catch (e) {}
    },
    async refreshRegistry() {
      if (!this.hasBridge) return;
      try {
        const r = await (bridge as any).diffsingerVoicebankRegistry();
        this.registry = (r && r.list) || [];
      } catch (e) {}
    },
    async importZip(): Promise<string> {
      if (!this.hasBridge) return '桌面版不可用';
      const r = await (bridge as any).diffsingerImportVoicebankZip();
      if (r && r.ok) { await this.loadStatus(); await this.refreshVoicebanks(); return ''; }
      if (r && r.canceled) return '';
      return (r && r.error) || '导入失败';
    },
    async importZipFromPath(p: string): Promise<string> {
      if (!this.hasBridge) return '桌面版不可用';
      const r = await (bridge as any).diffsingerImportVoicebankZip(p);
      if (r && r.ok) { await this.loadStatus(); await this.refreshVoicebanks(); return ''; }
      return (r && r.error) || '导入失败';
    },
    async deleteVoicebank(dir: string): Promise<string> {
      if (!this.hasBridge) return '桌面版不可用';
      const r = await (bridge as any).diffsingerDeleteVoicebank(dir);
      if (r && r.ok) { await this.refreshVoicebanks(); return ''; }
      return (r && r.error) || '删除失败';
    },
    async downloadVoicebank(id: string): Promise<string> {
      if (!this.hasBridge) return '桌面版不可用';
      if (!this.enabled) return '请先启用 DiffSinger 模块';
      let off = () => {};
      this.vbProgress = { ...this.vbProgress, [id]: { percent: 0, phase: 'download' } };
      try {
        off = (bridge as any).onDiffsingerVoicebankProgress((p: any) => {
          if (!p || p.id !== id) return;
          this.vbProgress = { ...this.vbProgress, [id]: { percent: p.percent || 0, phase: p.phase, done: p.done, error: p.error || '' } };
        });
        const r = await (bridge as any).diffsingerDownloadVoicebank(id);
        if (r && r.ok) { await this.refreshVoicebanks(); return ''; }
        return (r && r.error) || '下载失败';
      } catch (e) {
        return String((e as any) && (e as any).message || e);
      } finally {
        off();
      }
    },
    async cancelVoicebankDownload(id: string) {
      if (this.hasBridge) { try { await (bridge as any).diffsingerCancelVoicebankDownload(id); } catch (e) {} }
      this.vbProgress = { ...this.vbProgress, [id]: { percent: 0, phase: 'done', done: true } };
    },
    async inspect(): Promise<string> {
      if (!this.hasBridge || !this.voicebankDir) { this.voicebankInfo = null; return ''; }
      this.inspecting = true;
      try {
        const r = await (bridge as any).diffsingerInspectVoicebank({ voicebank: this.voicebankDir });
        this.voicebankInfo = r && r.ok ? r : null;
        return (r && r.ok) ? '' : ((r && r.error) || '声库解析失败');
      } catch (e) {
        this.voicebankInfo = null;
        return String((e as any) && (e as any).message || e);
      } finally {
        this.inspecting = false;
      }
    },
    setVoicebank(dir: string) {
      this.voicebankDir = dir || '';
      this.voicebankInfo = null;
      this.persist();
      void this.inspect();
    },
    setBpm(v: number) { this.bpm = Math.max(20, Math.min(400, Number(v) || 120)); this.persist(); },

    /* ---------------- 音符编辑 ---------------- */
    addNote(startBeat: number, pitch: number): string {
      const note: DsNote = {
        id: nid(), startBeat: Math.max(0, startBeat), durBeat: 1, pitch,
        lyric: '啊', ...DS_NOTE_DEFAULTS,
      };
      this.notes.push(note);
      this.selectedId = note.id;
      this.persist();
      return note.id;
    },
    _makeNote(it: Partial<DsNote>): DsNote {
      return {
        id: nid(), startBeat: Math.max(0, it.startBeat ?? 0),
        durBeat: Math.max(0.125, it.durBeat ?? 1),
        pitch: Math.max(0, Math.min(127, it.pitch ?? 60)),
        lyric: it.lyric ?? '啊',
        vibrato: it.vibrato ?? DS_NOTE_DEFAULTS.vibrato,
        vibDepth: it.vibDepth ?? DS_NOTE_DEFAULTS.vibDepth,
        vibFreq: it.vibFreq ?? DS_NOTE_DEFAULTS.vibFreq,
        vibFade: it.vibFade ?? DS_NOTE_DEFAULTS.vibFade,
        pitchOffset: it.pitchOffset ?? DS_NOTE_DEFAULTS.pitchOffset,
      };
    },
    /** 导入基底旋律（从曲库 MIDI）：replace=true 先清空现有音符 */
    importNotes(items: Partial<DsNote>[], replace = false, sourceName = '', sourceId = ''): number {
      if (!items.length) return 0;
      if (replace) this.notes = [];
      for (const it of items) this.notes.push(this._makeNote(it));
      this.selectedId = this.notes.length ? this.notes[this.notes.length - 1].id : null;
      this.sourceName = sourceName;
      this.sourceId = sourceId;
      this.persist();
      return items.length;
    },
    updateNote(id: string, patch: Partial<DsNote>) {
      const n = this.notes.find(x => x.id === id);
      if (!n) return;
      Object.assign(n, patch);
      this.persist();
    },
    removeNote(id: string) {
      this.notes = this.notes.filter(n => n.id !== id);
      if (this.selectedId === id) this.selectedId = this.notes.length ? this.notes[this.notes.length - 1].id : null;
      this.persist();
    },
    clear() {
      this.notes = [];
      this.selectedId = null;
      this.sourceName = '';
      this.sourceId = '';
      this.persist();
    },

    /**
     * 从曲库曲目导入 MIDI：解析全部轨道，返回轨道摘要供 UI 选择；
     * 选定后由 applyMidiTrack 落音符。失败返回错误字符串。
     */
    async loadSongTracks(song: any): Promise<{ error: string; tracks?: any[]; bpm?: number; tpb?: number }> {
      const bytes = await readSongBytes(song);
      if (!bytes || !bytes.length) return { error: '无法读取曲目字节（曲目文件可能缺失）' };
      try {
        const mid = parseMidi(bytes);
        const song2 = buildSong(mid, {});
        const tracks = (song2.tracks || [])
          .filter((t: any) => !t.isDrum && t.notes && t.notes.length)
          .map((t: any) => ({
            index: t.index,
            name: t.name || ('Track ' + (t.index + 1)),
            noteCount: t.notes.length,
            minPitch: Math.min(...t.notes.map((n: any) => n.midi)),
            maxPitch: Math.max(...t.notes.map((n: any) => n.midi)),
            notes: t.notes,
          }));
        if (!tracks.length) return { error: '该 MIDI 没有可用的旋律轨道（非鼓轨且含音符）' };
        tracks.sort((a: any, b: any) => b.noteCount - a.noteCount);
        return { error: '', tracks, bpm: song2.initialBpm || 120, tpb: song2.tpb || 480 };
      } catch (e) {
        return { error: 'MIDI 解析失败：' + String((e as any) && (e as any).message || e) };
      }
    },
    /** 把选中轨道的音符落进工程（tick → 拍） */
    applyMidiTrack(track: any, bpm: number, songName: string, songId: string, tpb: number, replace = true): number {
      const spq = tpb || 480; // ticks per quarter note
      const items = (track.notes || []).map((n: any) => ({
        startBeat: n.start / spq,
        durBeat: Math.max(0.125, (n.end - n.start) / spq),
        pitch: n.midi,
        lyric: '啊',
      }));
      this.bpm = Math.max(20, Math.min(400, bpm || 120));
      return this.importNotes(items, replace, songName, songId);
    },

    /* ---------------- 渲染 ---------------- */
    async render(): Promise<string> {
      if (!this.hasBridge) return '桌面版不可用';
      if (!this.enabled) return '请先启用 DiffSinger 模块';
      if (!this.ready) return '组件未就绪：请先在「模块与声库」安装推理组件';
      if (!this.voicebankDir) return '请先选择声库';
      if (!this.notes.length) return '没有音符可渲染';
      // 范围渲染：只在开启且选区合法时生效
      let range: any = null;
      if (this.rangeEnabled) {
        const s = Number(this.rangeStartBeat), e = Number(this.rangeEndBeat);
        if (!(e > s)) return '选区无效：结束拍必须大于起始拍';
        const hit = this.notes.filter(n => n.startBeat < e && n.startBeat + n.durBeat > s);
        if (!hit.length) return '选区内没有音符：请把选区对准音符所在的拍位';
        range = { startBeat: s, endBeat: e, contextSec: Number(this.rangeContextSec) || 0 };
      }
      this.rendering = true;
      this.renderPct = 0;
      this.renderText = '';
      let off = () => {};
      try {
        off = (bridge as any).onDiffsingerRenderProgress((p: any) => {
          if (!p) return;
          if (typeof p.percent === 'number') this.renderPct = p.percent;
          if (p.text) this.renderText = String(p.text);
        });
        const notes = this.sortedNotes.map(n => ({
          startBeat: n.startBeat, durBeat: n.durBeat, pitch: n.pitch, lyric: n.lyric,
          vibrato: n.vibrato, vibDepth: n.vibDepth, vibFreq: n.vibFreq, vibFade: n.vibFade,
          pitchOffset: n.pitchOffset,
        }));
        const r = await (bridge as any).diffsingerRender({
          voicebank: this.voicebankDir, notes, bpm: this.bpm,
          range, device: this.device || 'auto',
        });
        if (r && r.ok && r.bytes) {
          const bytes = r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes as any);
          _lastWavBytes = bytes;
          if (this.renderUrl) { try { URL.revokeObjectURL(this.renderUrl); } catch (e) {} }
          const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/wav' });
          this.renderUrl = URL.createObjectURL(blob);
          this.renderWarnings = r.warnings || [];
          this.lastDurationMs = r.duration_ms || 0;
          this.lastRange = r.range || null;
          this.lastPipeline = r.pipeline || '';
          this.lastDevice = r.device || null;
          return '';
        }
        return (r && r.error) || '渲染失败';
      } catch (e) {
        return String((e as any) && (e as any).message || e);
      } finally {
        off();
        this.rendering = false;
      }
    },
    /** 把选区设为「某个音符」或「全部音符」的便捷入口 */
    setRangeToNote(id: string) {
      const n = this.notes.find(x => x.id === id);
      if (!n) return;
      this.rangeEnabled = true;
      this.rangeStartBeat = n.startBeat;
      this.rangeEndBeat = n.startBeat + n.durBeat;
    },
    setRangeFull() {
      this.rangeEnabled = false;
      this.rangeStartBeat = 0;
      this.rangeEndBeat = this.totalBeats || 4;
    },
    clearRender() {
      if (this.renderUrl) { try { URL.revokeObjectURL(this.renderUrl); } catch (e) {} }
      this.renderUrl = '';
      this.renderWarnings = [];
      this.lastDurationMs = 0;
      this.lastRange = null;
      this.lastPipeline = '';
      this.lastDevice = null;
      _lastWavBytes = null;
    },
  },
});
