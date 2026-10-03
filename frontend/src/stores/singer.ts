// -*- coding: utf-8 -*-
/**
 * 歌声合成的**统一数据模型**。
 *
 * ## 为什么需要这个 store
 *
 * 之前 UTAU 与 DiffSinger 各有一套 store（`utau.ts` / `diffsinger.ts`）和各自的
 * 音符编辑器，代价是：
 *   * 顶部要做「二选一」的引擎切换，一次只能进一个引擎
 *   * 同一个工程里**不能混排** UTAU 轨与 DiffSinger 轨
 *   * 音符字段有两份近似但不同的定义，改一处要改两处
 *
 * 上游 OpenUtau 的做法是：**引擎是轨道级属性**，不是应用级模式 ——
 * `UTrack` 带 `singer` 与 `renderer_settings.renderer`，一个工程里两种轨混排。
 * 本 store 就是把这件事落到前端。
 *
 * ## 音符模型 = 两边的并集
 *
 * 共有：`id / startBeat / durBeat / pitch / lyric / vibrato / vibDepth / vibFreq / vibFade`
 * UTAU 独有：`velocity / volume / flags / params / gender / breath`
 * DiffSinger 独有：`pitchOffset`
 *
 * 引擎读不到自己用不到的字段（各自只取所需），所以不需要拆表。
 */

import { defineStore } from 'pinia';
import { bridge, isDesktop } from '../api';
import {
  missingAssets, parseProject, resolveAssetPaths, serializeProject,
} from '../core/song_project.js';
import { makeFx, normalizeFx } from '../core/track_fx.js';
import {
  curveOf, normalizeCurve, normalizeCurves, targetsFor, valueForNote,
} from '../core/track_automation.js';

/* ------------------------------------------------------------------ 类型 */

export type Engine = 'utau' | 'diffsinger';

/**
 * 轨道类型。
 *
 * ★ 对应上游 `UTrack` 下挂 `UVoicePart` 还是 `UWavePart`：
 *   声部轨唱歌（UTAU / DiffSinger），音频轨是**伴奏**（offvocal）。
 *   两者在同一个工程里并列 —— 编辑时听着伴奏对齐歌词，导出时混进去。
 */
export type TrackKind = 'voice' | 'audio';

/** 音频轨（对应上游 `UWavePart`：`relative_path` / `file_duration_ms` / `skip` / `trim` / `fadein` / `fadeout`） */
export interface AudioClip {
  /** 当前可读的本地路径（运行时用；打开工程时指向从包里解出来的缓存文件） */
  path: string;
  /**
   * 工程包内 `files/` 的资产 id —— **有它才是"自包含"**。
   *
   * 存盘时只写 `asset`、绝不写 `path`：path 是本机绝对路径，写进包就失去了
   * 可移植性（换台机器打开必然断链）。见 `core/song_project.js`。
   */
  asset?: string;
  fileName: string;
  durationMs: number;
  /** 跳过开头多少 ms（上游 `skip`） */
  skip: number;
  /** 结束裁掉多少 ms（上游 `trim`） */
  trim: number;
  /** 淡入 / 淡出 ms */
  fadeIn: number;
  fadeOut: number;
  /** 播放增益 dB（0 = 原样） */
  gainDb: number;
  muted: boolean;
}

/** 引擎在轨道上的可选项（决定渲染时走哪条管线） */
export const ENGINES: { id: Engine; label: string; ic: string }[] = [
  { id: 'utau', label: 'UTAU', ic: 'mic' },
  { id: 'diffsinger', label: 'DiffSinger', ic: 'spark' },
];

/** 歌手语言（**轨道级**，照搬上游 `USingerTrack.Language`，不从歌词自动判断） */
export const LANGUAGES = [
  { code: 'zh', label: '中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'en', label: 'English' },
];

export interface SingNote {
  id: string;
  startBeat: number;     // 起点（拍，四分音符 = 1）
  durBeat: number;       // 时长（拍）
  pitch: number;         // MIDI 音高
  lyric: string;         // 歌词 / 音素

  /* ---- 颤音（两边共用）---- */
  vibrato: boolean;
  vibDepth: number;      // 0..100
  vibFreq: number;       // Hz
  vibFade: number;       // 0..100

  /* ---- UTAU 侧 ---- */
  velocity?: number;     // 0..100
  volume?: number;       // 0..100
  flags?: string;
  params?: Record<string, number>;
  gender?: number;       // -100..100（GENC）
  breath?: number;       // 0..100

  /* ---- OpenUTAU 表达式（每音符，作用于该音符首个音素）----
     取值口径与 OpenUTAU 的表达式表一致（engine_openutau.py 的 _EXPRESSION_SPECS）：
       dyn  -240..120（音量曲线，默认 0）
       atk  0..100（起音，默认 100）
       dec  0..100（衰减，默认 100）
       shft 0..100（音高偏移，默认 0）
       clr  语音色选项下标，默认 0
     不设 = 沿用轨道默认值，所以老工程不会被改味。 */
  dyn?: number;
  atk?: number;
  dec?: number;
  shft?: number;
  clr?: number;

  /* ---- DiffSinger 侧 ---- */
  pitchOffset?: number;  // 音分偏移
}

/** 音高曲线（`[{beat, cents}]`）—— 两边都用它承载 PITD/音分偏移 */
export interface PitchPoint {
  beat: number;
  cents: number;
}

/**
 * 效果链上的一个节点（**本轨独享**）。
 * `type` 取 `core/track_fx.js` 的 `FX_TYPES`；参数范围由那里统一校验。
 */
export interface FxNode {
  id: string;
  type: string;
  enabled: boolean;
  params: Record<string, number | string>;
}

/**
 * 一条自动化子轨（从属轨）。
 * `abbr` 取 `core/track_automation.js` 的 `CURVE_TARGETS`。
 */
export interface AutomationCurve {
  abbr: string;
  points: { beat: number; value: number }[];
}

export interface SingTrack {
  id: string;
  name: string;
  /** 声部轨 / 音频轨（伴奏） */
  kind: TrackKind;
  /** ★ 引擎是**轨道级**属性 —— 这是与上游一致的关键。音频轨此字段无意义 */
  engine: Engine;
  /** 歌手目录（UTAU 声库路径 / DiffSinger 声库路径） */
  singer: string;
  /** 歌手显示名（列表里显示用） */
  singerName?: string;
  /** ★ 歌手语言（轨道级） */
  language: string;

  notes: SingNote[];
  /**
   * 音高曲线。
   *
   * ★ 它是 `curves` 里 `PIT` 那条子轨的**镜像** —— 渲染链路（两个引擎）和旧工程
   *   格式都还读这个字段，所以 `setCurve('PIT', ...)` 会同时更新它。
   *   新代码请走 `curves`，别再直接写这里。
   */
  pitchCurve: PitchPoint[];
  /** 自动化子轨（PIT / VOL / PAN / DYN / BRE / GEN，按引擎可用性过滤） */
  curves?: AutomationCurve[];
  /** 本轨独享的效果链（顺序即信号流顺序） */
  fx?: FxNode[];

  /* ---- 混音（多轨同时播放时按轨生效；音频轨的同类字段在 `audio` 上）---- */
  /** 静音（仍保留渲染结果，只是不发声） */
  muted?: boolean;
  /** 增益 dB（0 = 原样） */
  gainDb?: number;

  /* ---- UTAU 渲染参数 ---- */
  resampler?: string;
  wavtool?: string;

  /* ---- DiffSinger 渲染参数 ---- */
  depth?: number;
  steps?: number;
  /* ---- 音频轨（`kind === 'audio'` 时才有）---- */
  /** 对应上游 `UWavePart` 的 `relative_path` / `file_duration_ms` / `skip` / `trim` / `fadein` / `fadeout` */
  audio?: AudioClip;
}

let _seq = 0;
function nid(): string {
  _seq += 1;
  return 'n' + Date.now().toString(36) + _seq.toString(36);
}

/** 新建一个空声部轨 */
export function makeTrack(engine: Engine = 'utau'): SingTrack {
  return {
    id: 'tr' + Date.now().toString(36) + (_seq += 1).toString(36),
    name: '',
    kind: 'voice',
    engine,
    singer: '',
    language: 'zh',
    notes: [],
    pitchCurve: [],
  };
}

/** 新建一条音频轨（伴奏）—— 对应上游工程里的 `UWavePart` */
export function makeAudioTrack(path: string, fileName: string,
                               durationMs: number): SingTrack {
  return {
    id: 'tr' + Date.now().toString(36) + (_seq += 1).toString(36),
    name: fileName,
    kind: 'audio',
    engine: 'utau',          // 占位：音频轨不参与渲染，引擎字段无意义
    singer: '',
    language: 'zh',
    notes: [],
    pitchCurve: [],
    audio: {
      path, fileName, durationMs,
      skip: 0, trim: 0, fadeIn: 0, fadeOut: 0, gainDb: 0, muted: false,
    },
  };
}

/** 新建一个音符（默认带 UTAU 习惯的默认歌词 'あ'） */
export function makeNote(track: SingTrack, startBeat: number, pitch: number): SingNote {
  const base: SingNote = {
    id: nid(),
    startBeat: Math.max(0, startBeat),
    durBeat: 1,
    pitch,
    lyric: track.engine === 'utau' ? 'あ' : '',
    vibrato: false,
    vibDepth: 35,
    vibFreq: 5.5,
    vibFade: 0,
  };
  if (track.engine === 'utau') {
    base.velocity = 100;
    base.volume = 0;
    base.params = {};
  } else {
    base.pitchOffset = 0;
  }
  return base;
}

/* ------------------------------------------------------------------ 产物 */

let _lastBytes: Uint8Array | null = null;

/** 取最近一次渲染的 wav 字节（导出用）。 */
export function getLastWavBytes(): Uint8Array | null { return _lastBytes; }

/* ------------------------------------------------------------------ store */

export const useSingerStore = defineStore('singer', {
  state: () => ({
    tracks: [makeTrack('diffsinger')] as SingTrack[],
    activeTrackId: '' as string,
    selectedId: null as string | null,
    selectedIds: [] as string[],
    bpm: 120,
    busy: false,
    msg: '',
    /** 渲染进度 0..100 */
    progress: 0,
    /**
     * ★ **一份混排声库列表**（UTAU ∪ DiffSinger），每条带 `engine` 标签。
     * 这是全应用**唯一**的声库列表来源 —— 编辑器与声库视图都读它，
     * 不再各自维护一份。
     */
    banks: [] as { name: string; dir: string; engine: Engine; size?: number }[],
    banksLoading: false,
    /** 推理后端偏好：auto / cpu / cuda / dml */
    device: 'auto' as 'auto' | 'cpu' | 'cuda' | 'dml',
    /** UTAU 侧要一个采样音（wavtool 的 reference note） */
    sampleNote: 'a' as string,
    /** 渲染产物的可播放 URL（两个引擎共用） */
    renderUrl: '' as string,
    /* ---- 工程文件（.fufumidi 自包含包）---- */
    /** 当前工程路径；空 = 还没保存过（此时"保存"会走另存为对话框） */
    projectPath: '' as string,
    createdAt: '' as string,
    meta: { title: '', comment: '', artist: '' } as
      { title: string; comment: string; artist: string },
    /** 打开工程后没落到本地的伴奏（包里缺文件 / 解包失败） */
    missingAudio: [] as { trackId: string; fileName: string; asset: string }[],
    /**
     * ★ **按轨道**存放渲染结果 —— 多条声部轨要能同时发声，就不能像以前那样
     *   只留"最后一次渲染"的一份字节（那等于"渲一条就顶掉上一条"）。
     *   键是轨道 id；删轨 / 新建 / 打开工程时清空对应项。
     */
    renderByTrack: {} as Record<string, Uint8Array>,
    renderWarnings: [] as string[],
    lastDurationMs: 0 as number,
    lastPipeline: '' as string,
  }),

  getters: {
    activeTrack(state): SingTrack | null {
      return state.tracks.find(t => t.id === state.activeTrackId) || null;
    },
    /** 当前选中的音符（跨轨道） */
    activeNote(state): SingNote | null {
      for (const tr of state.tracks) {
        const n = tr.notes.find(x => x.id === state.selectedId);
        if (n) return n;
      }
      return null;
    },
    /** 当前轨道里选中的音符（可能多选） */
    selectedNotes(): SingNote[] {
      const tr = this.activeTrack;
      if (!tr) return [];
      const ids = new Set(this.selectedIds);
      if (this.selectedId) ids.add(this.selectedId);
      return tr.notes.filter(n => ids.has(n.id));
    },
    totalNotes(state): number {
      return state.tracks.reduce((a, t) => a + t.notes.length, 0);
    },
    /** 已有渲染结果的轨 id（按轨道顺序）—— 这些轨会一起发声 */
    renderedTrackIds(state): string[] {
      return state.tracks.filter(t => !!state.renderByTrack[t.id]).map(t => t.id);
    },
    /**
     * 「导出 WAV」用哪一份字节。
     *
     * 多轨之后"最后一次渲染的结果"不再是唯一答案 —— 优先给**当前轨**的，
     * 没有再退回最后一份。
     */
    exportBytes(): Uint8Array | null {
      const mine = this.activeTrackId ? this.renderByTrack[this.activeTrackId] : null;
      return mine || _lastBytes;
    },
  },

  actions: {
    /* ---------------- 轨道 ---------------- */
    addTrack(engine: Engine = 'utau'): string {
      const t = makeTrack(engine);
      this.tracks.push(t);
      this.activeTrackId = t.id;
      return t.id;
    },
    removeTrack(id: string) {
      if (this.tracks.length <= 1) return;         // 至少留一条
      const i = this.tracks.findIndex(t => t.id === id);
      if (i < 0) return;
      this.tracks.splice(i, 1);
      if (this.activeTrackId === id) {
        // 删掉的可能就是当前轨 → 落到相邻的一条（越界时取最后一条）
        const next = this.tracks[Math.min(i, this.tracks.length - 1)];
        this.activeTrackId = next ? next.id : '';
      }
      delete this.renderByTrack[id];      // 轨没了，它的渲染结果也没人认领
    },
    /** 加一条音频轨（伴奏）。`durationMs` 由调用方用 <audio> 探到。 */
    addAudioTrack(path: string, fileName: string, durationMs: number): string {
      const t = makeAudioTrack(path, fileName, durationMs);
      this.tracks.unshift(t);            // 伴奏通常放最上，对齐时好看
      this.activeTrackId = t.id;
      return t.id;
    },
    patchAudio(id: string, patch: Partial<AudioClip>) {
      const t = this.tracks.find(x => x.id === id);
      if (t && t.audio) Object.assign(t.audio, patch);
    },

    selectTrack(id: string) {
      this.activeTrackId = id;
      this.selectedId = null;
      this.selectedIds = [];
    },
    patchTrack(id: string, patch: Partial<SingTrack>) {
      const t = this.tracks.find(x => x.id === id);
      if (!t) return;
      Object.assign(t, patch);
      // ★ 换引擎时清掉另一侧的歌手，避免「UTAU 轨指向 DiffSinger 声库」这类脏数据
      if (patch.engine && patch.engine !== t.engine) {
        t.singer = '';
        t.singerName = '';
        // 新引擎用不到的自动化目标一并清掉（DiffSinger 没有 DYN/BRE/GEN，
        // 留着就是"文件里有数据、界面上永远看不见"）
        t.curves = normalizeCurves(t.curves || [], patch.engine, t.kind);
      }
    },
    /** 轨道按引擎分组（渲染时用） */
    tracksByEngine(engine: Engine): SingTrack[] {
      return this.tracks.filter(t => t.engine === engine);
    },

    /* ---------------- 效果链（本轨独享） ---------------- */
    /**
     * 加一个效果。★ 追加到**末尾** —— 数组顺序就是信号流顺序，
     * 「先压限再混响」和「先混响再压限」听感完全不同。
     */
    addFx(id: string, type: string) {
      const t = this.tracks.find(x => x.id === id);
      if (!t) return;
      const f = makeFx(type);
      if (!f) return;
      t.fx = [...(t.fx || []), f];
    },
    removeFx(id: string, fxId: string) {
      const t = this.tracks.find(x => x.id === id);
      if (t) t.fx = (t.fx || []).filter(f => f.id !== fxId);
    },
    /** 上移（-1）/ 下移（+1）：越界不动（按钮会在 UI 上置灰） */
    moveFx(id: string, fxId: string, delta: number) {
      const t = this.tracks.find(x => x.id === id);
      if (!t || !t.fx) return;
      const i = t.fx.findIndex(f => f.id === fxId);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= t.fx.length) return;
      const arr = t.fx.slice();
      const a = arr[i];
      const b = arr[j];
      if (!a || !b) return;
      arr[i] = b;
      arr[j] = a;
      t.fx = arr;
    },
    /** 改参数 / 开关。参数一律过 `normalizeFx` 钳制，防止脏值进节点。 */
    patchFx(id: string, fxId: string, patch: Partial<FxNode>) {
      const t = this.tracks.find(x => x.id === id);
      if (!t || !t.fx) return;
      const i = t.fx.findIndex(f => f.id === fxId);
      const f = t.fx[i];
      if (!f) return;
      const merged = {
        ...f,
        ...patch,
        params: { ...f.params, ...(patch.params || {}) },
      };
      const arr = t.fx.slice();
      const one = normalizeFx([merged])[0];
      if (one) arr[i] = one;
      t.fx = arr;
    },

    /* ---------------- 自动化子轨 ---------------- */
    /** 这条轨能挂哪些自动化 —— DiffSinger 没有 DYN/BRE/GEN，别让用户看见调不动的旋钮 */
    curveTargets(id: string): string[] {
      const t = this.tracks.find(x => x.id === id);
      if (!t) return [];
      return targetsFor(t.engine, t.kind);
    },
    /**
     * 写入一条子轨（整组替换该目标的点）。
     *
     * ★ `PIT` 会**同步镜像到 `pitchCurve`** —— 渲染链路读的是 `pitchCurve`，
     *   不镜像就会出现"子轨画了线、渲出来没变化"这种最难查的错位。
     */
    setCurve(id: string, abbr: string, points: { beat: number; value: number }[]) {
      const t = this.tracks.find(x => x.id === id);
      if (!t) return;
      const norm = normalizeCurve({ abbr, points });
      if (!norm) return;
      const list = (t.curves || []).filter(c => c.abbr !== norm.abbr);
      list.push(norm);
      t.curves = normalizeCurves(list, t.engine, t.kind);
      if (norm.abbr === 'PIT') {
        t.pitchCurve = norm.points.map(p => ({ beat: p.beat, cents: p.value }));
      }
    },
    clearCurve(id: string, abbr: string) {
      const t = this.tracks.find(x => x.id === id);
      if (!t) return;
      t.curves = (t.curves || []).filter(c => c.abbr !== abbr);
      if (abbr === 'PIT') t.pitchCurve = [];
    },

    /* ---------------- 音符 ---------------- */
    addNote(startBeat: number, pitch: number): string | null {
      const tr = this.activeTrack;
      if (!tr) return null;
      const n = makeNote(tr, startBeat, pitch);
      tr.notes.push(n);
      tr.notes.sort((a, b) => a.startBeat - b.startBeat);
      this.select(n.id);
      return n.id;
    },
    updateNote(id: string, patch: Partial<SingNote>) {
      for (const tr of this.tracks) {
        const n = tr.notes.find(x => x.id === id);
        if (n) {
          Object.assign(n, patch);
          if (patch.startBeat !== undefined) {
            tr.notes.sort((a, b) => a.startBeat - b.startBeat);
          }
          return;
        }
      }
    },
    removeNote(id: string) {
      for (const tr of this.tracks) {
        const i = tr.notes.findIndex(x => x.id === id);
        if (i >= 0) {
          tr.notes.splice(i, 1);
          break;
        }
      }
      if (this.selectedId === id) { this.selectedId = null; this.selectedIds = []; }
    },
    clearTrack(id: string) {
      const tr = this.tracks.find(x => x.id === id);
      if (tr) { tr.notes = []; tr.pitchCurve = []; }
      this.selectedId = null;
      this.selectedIds = [];
    },
    select(id: string | null, additive = false) {
      this.selectedId = id;
      if (!additive) this.selectedIds = [];
    },
    selectMany(ids: string[]) {
      this.selectedIds = ids;
      this.selectedId = ids[ids.length - 1] || null;
    },

    /* ---------------- 音高曲线 ---------------- */
    /**
     * ★ `pitchCurve` 是 `PIT` 自动化子轨的**镜像**，两边必须同写。
     *   只改一边会出现"钢琴卷帘里拉了曲线、存出来的工程没有"这种错位。
     */
    setPitchCurve(pts: PitchPoint[]) {
      const tr = this.activeTrack;
      if (!tr) return;
      const sorted = pts.slice().sort((a, b) => a.beat - b.beat);
      tr.pitchCurve = sorted;
      this.setCurve(tr.id, 'PIT', sorted.map(p => ({ beat: p.beat, value: p.cents })));
    },
    clearPitchCurve() {
      const tr = this.activeTrack;
      if (!tr) return;
      tr.pitchCurve = [];
      this.clearCurve(tr.id, 'PIT');
    },

    /* ---------------- MIDI 导入 ---------------- */
    /**
     * 解析 MIDI 字节，返回**可选轨道**（供 UI 让用户挑）。
     *
     * 只留「非鼓轨且含音符」的轨，并按音符数降序 —— 旋律轨通常音符最多，
     * 排在第一个。返回的 `bpm` / `tpb` 由调用方在落轨时带上。
     */
    parseMidiTracks(bytes: Uint8Array, buildSong: any, parseMidi: any):
        { error: string; tracks?: any[]; bpm?: number; tpb?: number } {
      if (!bytes || !bytes.length) return { error: '文件为空' };
      try {
        const mid = parseMidi(bytes);
        const song = buildSong(mid, {});
        const tracks = (song.tracks || [])
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
        return { error: '', tracks, bpm: song.initialBpm || 120, tpb: song.tpb || 480 };
      } catch (e) {
        return { error: 'MIDI 解析失败：' + String((e as any)?.message || e) };
      }
    },

    /**
     * 把一条 MIDI 轨落进**指定声部轨**（tick → 拍）。
     * `replace=true` 清空原有音符（导入通常是"换一首"）。
     */
    applyMidiTrack(trackId: string, midiTrack: any, tpb: number,
                   bpm?: number, replace = true): number {
      const tr = this.tracks.find(t => t.id === trackId);
      if (!tr) return 0;
      const spq = tpb || 480;                       // ticks per quarter note
      const items = (midiTrack.notes || []).map((n: any) => ({
        startBeat: n.start / spq,
        durBeat: Math.max(0.125, (n.end - n.start) / spq),
        pitch: n.midi,
        lyric: '',                                   // 留空让用户填词（候选会提示）
        vibrato: false, vibDepth: 35, vibFreq: 5.5, vibFade: 0,
        pitchOffset: 0,
      }));
      if (bpm) this.bpm = Math.max(20, Math.min(400, bpm));
      if (replace) tr.notes = [];
      // 保持 tick→拍的精度，同时复用 makeNote 的默认值语义
      tr.notes.push(...items.map((it: any) => ({ ...makeNote(tr, 0, 60), ...it })));
      tr.notes.sort((a, b) => a.startBeat - b.startBeat);
      this.selectedId = null;
      this.selectedIds = [];
      return items.length;
    },

    /* ---------------- 导入 ---------------- */
    /** 从别处（UTAU / DiffSinger 旧 store 或曲库 MIDI）灌入一条轨 */
    loadTrack(track: SingTrack) {
      const i = this.tracks.findIndex(t => t.id === track.id);
      if (i >= 0) this.tracks.splice(i, 1, track);
      else this.tracks.push(track);
      this.activeTrackId = track.id;
    },
    clearAll() {
      const t0 = makeTrack('diffsinger');
      this.tracks = [t0];
      this.activeTrackId = t0.id;
      this.selectedId = null;
      this.selectedIds = [];
      this.renderByTrack = {};
    },

    /* ---------------- 工程文件（.fufumidi 自包含包） ---------------- */
    /**
     * 另起一个空工程。
     *
     * 注意：**不重置** `projectPath` 之外的渲染状态 —— 那属于"当前会话产物"，
     * 与工程数据无关，清掉反而让用户刚渲染好的音频没了。
     */
    newProject() {
      this.clearAll();
      this.projectPath = '';
      this.createdAt = '';
      this.meta = { title: '', comment: '', artist: '' };
      this.missingAudio = [];
    },

    /**
     * 保存工程。`saveAs=true` 或还没保存过时弹"另存为"对话框。
     *
     * ★ 两处必须摊平成普通对象：
     *   1. `json` 来自 `serializeProject()`，但它内部引用了 state 里的 track
     *      —— 走一次 JSON 往返彻底断开响应式 Proxy；
     *   2. `assets` 同理。结构化克隆对 Proxy 一律拒绝（渲染那边已踩过一次）。
     *
     * @returns 空串 = 成功；非空 = 要显示给用户的提示/错误
     */
    async saveProject(saveAs = false): Promise<string> {
      if (!isDesktop || !bridge) return '桌面版才能保存工程';
      const b = bridge as any;
      if (!b.project || typeof b.project.save !== 'function') return '当前版本不支持工程文件';
      const { json, assets } = serializeProject({
        tracks: this.tracks as any,
        bpm: this.bpm,
        device: this.device,
        sampleNote: this.sampleNote,
        activeTrackId: this.activeTrackId,
        meta: this.meta,
        createdAt: this.createdAt,
      });
      const plain = JSON.parse(JSON.stringify(json));
      try {
        const r = await b.project.save({
          json: plain,
          assets: assets.map((a: any) => ({ id: a.id, srcPath: a.srcPath, fileName: a.fileName })),
          filePath: saveAs ? '' : this.projectPath,
          suggestName: this.meta.title || 'song',
        });
        if (!r || !r.ok) return (r && r.cancelled) ? '' : ((r && r.error) || '保存失败');
        this.projectPath = r.filePath || this.projectPath;
        this.createdAt = plain.createdAt;
        const miss = (r.missing || []) as string[];
        if (miss.length) {
          return '已保存，但有 ' + miss.length + ' 个伴奏文件没读到、未打进包：' + miss.join('、');
        }
        return '';
      } catch (e) {
        return String((e as any)?.message || e);
      }
    },

    /**
     * 打开工程：弹窗选 `.fufumidi` → 校验 → 解包伴奏 → 灌进 store。
     *
     * 返回的提示串分两类，UI 都要显示：
     *   * 失败（非空且 `projectPath` 没变）：工程没打开
     *   * 成功但有缺失（以「工程已打开」开头）：能继续用，只是伴奏听不了
     */
    async openProject(): Promise<string> {
      if (!isDesktop || !bridge) return '桌面版才能打开工程';
      const b = bridge as any;
      if (!b.project || typeof b.project.open !== 'function') return '当前版本不支持工程文件';
      let r: any;
      try {
        r = await b.project.open();
      } catch (e) {
        return String((e as any)?.message || e);
      }
      if (!r || !r.ok) return (r && r.cancelled) ? '' : ((r && r.error) || '打开失败');

      const p = parseProject(r.json) as any;
      if (!p.ok) return p.error || '工程解析失败';
      const proj = p.project as any;
      const tracks = resolveAssetPaths(proj.tracks, r.resolved || {}) as any as SingTrack[];

      // 渲染结果属于"上一份工程"，不能跟着新工程一起带过来
      this.renderByTrack = {};
      this.tracks = tracks;
      this.bpm = proj.bpm;
      this.device = proj.device;
      this.sampleNote = proj.sampleNote;
      this.activeTrackId = proj.activeTrackId || (tracks[0]?.id || '');
      this.meta = proj.meta;
      this.createdAt = proj.createdAt || '';
      this.projectPath = r.filePath || '';
      this.selectedId = null;
      this.selectedIds = [];
      this.missingAudio = missingAssets(tracks);

      const n = this.missingAudio.length;
      return n ? '工程已打开，但有 ' + n + ' 个伴奏文件缺失（包里没有或解包失败）' : '';
    },

    /* ---------------- 声库（混排） ---------------- */
    /**
     * 从主进程拉两类声库，合并成一份列表。
     * 任一引擎的接口不存在时跳过（网页端 / 模块未启用）。
     */
    async loadBanks(): Promise<string> {
      if (!isDesktop || !bridge) return '';
      this.banksLoading = true;
      try {
        const out: { name: string; dir: string; engine: Engine; size?: number }[] = [];
        const b = bridge as any;
        if (typeof b.utauListVoicebanks === 'function') {
          const r = await b.utauListVoicebanks();
          for (const v of (r && r.list) || []) {
            out.push({ name: v.name, dir: v.dir, engine: 'utau' });
          }
        }
        if (typeof b.diffsingerListVoicebanks === 'function') {
          const r = await b.diffsingerListVoicebanks();
          for (const v of (r && r.list) || []) {
            out.push({ name: v.name, dir: v.dir, engine: 'diffsinger', size: v.size });
          }
        }
        this.banks = out;
        return '';
      } catch (e) {
        return String((e as any)?.message || e);
      } finally {
        this.banksLoading = false;
      }
    },
    /** 该目录是否正被某条轨道使用（删声库前要拦） */
    bankInUse(dir: string): boolean {
      return this.tracks.some(t => t.singer === dir);
    },

    /* ---------------- 渲染（按轨道引擎分派） ---------------- */
    /**
     * 渲染选中的轨道（缺省当前轨）。
     *
     * ★ **一个入口，按 `track.engine` 分派** —— 这是「统一」的核心：
     *   用户不需要先切引擎，点渲染即可。
     */
    async renderTrack(trackId?: string): Promise<string> {
      const tr = trackId ? this.tracks.find(t => t.id === trackId) : this.activeTrack;
      if (!tr) return '没有可渲染的轨道';
      if (tr.kind === 'audio') return '音频轨不参与渲染（它在导出时混入）';
      if (!tr.singer) return '该轨道还没有选歌手';
      if (!tr.notes.length) return '该轨道没有音符';
      this.busy = true;
      this.progress = 0;
      this.msg = '';
      try {
        return await this._renderOne(tr);
      } finally {
        this.busy = false;
        this.progress = 100;
      }
    },

    /**
     * 渲染**所有**声部轨 —— **多轨同时播放的前提**。
     *
     * 以前只有一份"最后一次渲染"的字节，渲第二条就把第一条顶掉了，
     * 于是听感上永远只有一条人声。现在结果按轨道存（`renderByTrack`），
     * 传输器一次把全部已渲染的轨装进去，它们才是真的同时响。
     *
     * 逐条串行而不是并行：两条 DiffSinger 同时跑会把显存/内存打满，
     * 而引擎侧有 phrase 级缓存，第二次渲染同一条轨会明显更快。
     */
    async renderAll(): Promise<string> {
      const todo = this.tracks.filter(t =>
        t.kind === 'voice' && !!t.singer && t.notes.length > 0);
      if (!todo.length) return '没有可渲染的声部轨（每条都要选了歌手且有音符）';
      this.busy = true;
      this.progress = 0;
      this.msg = '';
      const failed: string[] = [];
      try {
        let i = 0;
        // ★ 用 for-of 而不是下标：`noUncheckedIndexedAccess` 下 `todo[i]` 是
        //   `SingTrack | undefined`，下标写法要到处加判空
        for (const t of todo) {
          i += 1;
          const who = t.name || t.singerName || (t.engine === 'utau' ? 'UTAU' : 'DiffSinger');
          this.msg = '正在渲染 ' + i + '/' + todo.length + '：' + who;
          this.progress = Math.round((i - 1) / todo.length * 100);
          const err = await this._renderOne(t);
          if (err) failed.push(who + '（' + err + '）');
        }
      } finally {
        this.busy = false;
        this.progress = 100;
      }
      const n = todo.length;
      if (!failed.length) return '';
      if (failed.length >= n) return failed.join('；');
      return '已渲染 ' + (n - failed.length) + '/' + n + ' 轨，失败的：' + failed.join('；');
    },

    /** 单条轨的实际分派（不含 busy 管理，供 renderTrack / renderAll 复用） */
    async _renderOne(tr: SingTrack): Promise<string> {
      if (tr.engine === 'diffsinger') return await this._renderDiffSinger(tr);
      return await this._renderUtau(tr);
    },

    /** 丢掉渲染结果（不传则全部清空） */
    clearRender(trackId?: string) {
      if (trackId) delete this.renderByTrack[trackId];
      else this.renderByTrack = {};
    },

    /**
     * 渲染产物 → Blob URL。
     *
     * ★ `ipcRenderer.invoke` 走结构化克隆，返回的 `bytes` 可能是
     *   `Uint8Array` 也可能是普通数组（跨进程序列化差异），两种都要处理。
     */
    _acceptResult(r: any, pipeline: string, trackId?: string): string {
      if (!r || !r.ok) return (r && r.error) || '渲染失败';
      if (r.bytes) {
        const bytes = r.bytes instanceof Uint8Array
          ? r.bytes : new Uint8Array(r.bytes as any);
        _lastBytes = bytes;
        // ★ 按轨道留一份 —— 多轨同时播放就靠这里（只留"最后一份"等于渲一条顶一条）
        if (trackId) this.renderByTrack[trackId] = bytes;
        if (this.renderUrl) { try { URL.revokeObjectURL(this.renderUrl); } catch (_) { /* 已失效 */ } }
        this.renderUrl = URL.createObjectURL(
          new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/wav' }));
      }
      this.renderWarnings = r.warnings || [];
      this.lastDurationMs = r.duration_ms || 0;
      this.lastPipeline = r.pipeline || pipeline;
      return '';
    },

    async _renderDiffSinger(tr: SingTrack): Promise<string> {
      if (!isDesktop || !bridge) return '网页端暂不支持 DiffSinger 渲染';
      // ★ 必须摊平成**普通对象**：notes / pitchCurve 来自 Pinia state，是响应式
      //   Proxy，结构化克隆对 Proxy 一律拒绝（抛 "An object could not be cloned"），
      //   请求根本到不了主进程。空数组也一样会抛。
      const notes = tr.notes.map(n => ({
        startBeat: n.startBeat, durBeat: n.durBeat, pitch: n.pitch,
        lyric: n.lyric, vibrato: !!n.vibrato, vibDepth: n.vibDepth,
        vibFreq: n.vibFreq, vibFade: n.vibFade || 0,
        pitchOffset: n.pitchOffset || 0,
      }));
      const pitchCurve = (tr.pitchCurve || []).map(p => ({ beat: p.beat, cents: p.cents }));
      const r = await (bridge as any).diffsingerRender({
        voicebank: tr.singer,
        notes,
        bpm: this.bpm,
        device: this.device || 'auto',
        pitchCurve,
        params: { language: tr.language, depth: tr.depth, steps: tr.steps },
      });
      return this._acceptResult(r, 'DiffSinger', tr.id);
    },

    async _renderUtau(tr: SingTrack): Promise<string> {
      if (!isDesktop || !bridge) return '网页端暂不支持 UTAU 渲染';
      // ★ 有子轨时由子轨说话：取音符**中点**的值，没有子轨才沿用音符自身参数。
      //   （只 UTAU 有 DYN/BRE/GEN —— DiffSinger 引擎没有对应的每音符输入，
      //    别假装生效，那只会变成"调了没反应"的坑。）
      const dyn = curveOf(tr, 'DYN');
      const bre = curveOf(tr, 'BRE');
      const gen = curveOf(tr, 'GEN');
      const notes = tr.notes.map(n => {
        // ★ 每音符表达式：OpenUTAU 走「表达式体系」（vol/vel/dyn/atk/dec/shft/clr），
        //   不解析旧引擎的 flags 字符串。只把**用户真正设过**的键发下去，
        //   没设的留空 —— 引擎那边查不到就回落轨道默认值，老工程行为不变。
        const expressions: Record<string, number> = {};
        if (typeof n.velocity === 'number') expressions.vel = n.velocity;
        if (typeof n.volume === 'number') expressions.vol = n.volume;
        if (typeof n.dyn === 'number') expressions.dyn = n.dyn;
        if (typeof n.atk === 'number') expressions.atk = n.atk;
        if (typeof n.dec === 'number') expressions.dec = n.dec;
        if (typeof n.shft === 'number') expressions.shft = n.shft;
        if (typeof n.clr === 'number') expressions.clr = n.clr;
        return {
          startBeat: n.startBeat, durBeat: n.durBeat, pitch: n.pitch,
          // UTAU 的 wavtool 需要一个 alias；空歌词会让引擎取不到采样
          lyric: n.lyric || this.sampleNote || 'a',
          vibrato: !!n.vibrato, vibDepth: n.vibDepth, vibFreq: n.vibFreq,
          vibFade: n.vibFade || 0,
          velocity: dyn ? valueForNote(dyn.points, n.startBeat, n.durBeat, 'DYN') : (n.velocity ?? 100),
          volume: n.volume ?? 0,
          gender: gen ? valueForNote(gen.points, n.startBeat, n.durBeat, 'GEN') : (n.gender ?? 0),
          breath: bre ? valueForNote(bre.points, n.startBeat, n.durBeat, 'BRE') : (n.breath ?? 0),
          ...(Object.keys(expressions).length ? { expressions } : {}),
        };
      });
      const r = await (bridge as any).utauRenderTrack({
        voicebank: tr.singer,
        notes,
        sampleNote: this.sampleNote || 'a',
        bpm: this.bpm,
      });
      return this._acceptResult(r, 'UTAU', tr.id);
    },
  },
});
