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

  /**
   * 音素级表达式覆盖（P2-2）：下标 → { abbr: 数值 }。
   *
   * ★ 与上面那批音符级字段的关系：音符级值落在**该音符的每个音素**上；
   *   这里按下标单独覆盖。引擎在 build_part 里让音素级优先
   *   （被覆盖的 (下标, abbr) 不再从音符级扩散），所以「辅音轻、元音亮」能各自成立。
   * 下标从 0 起，顺序与卷帘音素条带一致；越界下标引擎会忽略（不会炸）。
   * 用字符串做键是因为 JSON 对象键只能是字符串 —— 取值时 Number(k) 转回来。
   */
  phExpressions?: Record<string, Record<string, number>>;

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
  /** 渲染这一版时的音符指纹（用于"渲染已过期"提示，见 staleRenderIds getter） */
  renderSig?: string;

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

/** 撤销栈深度上限：50 步足够覆盖一次编辑会话，也不会让快照吃内存（纯 JSON 字符串）。 */
const HISTORY_MAX = 50;

/**
 * 音符指纹 —— 判断"渲染结果是否已过期"。
 * 只看**会影响声音**的字段（起止/音高/歌词/颤音/表情），改轨名、静音这类不算。
 * 不追求密码学强度：它只用来提示"要不要重渲"，不是校验和。
 */
function noteSignature(notes: any[]): string {
  let h = 0;
  for (const n of notes || []) {
    /* 音素级覆盖（P2-2）也要进指纹：否则「改了辅音的音量」不会提示渲染已过期，
       用户会以为改动没生效 —— 至少要把下标与取值都算进去。 */
    const pe = n.phExpressions
      ? Object.keys(n.phExpressions).sort()
        .map((k) => k + ':' + Object.keys(n.phExpressions[k] || {}).sort()
          .map((a) => a + '=' + n.phExpressions[k][a]).join(','))
        .join(';')
      : '';
    const s = [n.startBeat, n.durBeat, n.pitch, n.lyric || '', n.velocity ?? '', n.volume ?? '',
      n.gender ?? '', n.breath ?? '', n.dyn ?? '', n.atk ?? '', n.dec ?? '', n.shft ?? '', n.clr ?? '',
      n.vibrato ? 1 : 0, n.vibDepth ?? '', n.vibFreq ?? '', pe].join('|');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return notes.length + ':' + (h >>> 0);
}

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
    /**
     * 工程级参数（P2-3）。除了标题，还带拍号与"对齐偏移"的**当前值**：
     *   拍号    —— 只影响卷帘的小节线与编号（4/4、3/4…），不改音符
     *   对齐偏移 —— 上一次整体平移的毫秒数（记录用，真正的平移写在音符上）
     * 两样都随工程文件走，所以类型上放宽成可选，老工程没有也能打开。
     */
    meta: { title: '', comment: '', artist: '', timeSig: '4/4', alignMs: 0 } as
      { title: string; comment: string; artist: string; timeSig?: string; alignMs?: number },
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

    /* ---- 撤销栈（页面级，覆盖音符 / 轨 / 效果 / 自动化 / 轨名 / 语言 / 模板）----
       ★ 为什么不放在 PianoRoll 里：卷帘只能看见音符。改音量、效果链、自动化、轨名、
         歌词、渲染设置同样会写坏工程，却一直没有撤销入口。这里做成**整页共用**的一栈。 */
    history: [] as string[],
    future: [] as string[],
    /** 「渲染全部轨」的停止请求标记（见 cancelRender）；不进工程文件 */
    _cancelled: false as boolean,
    /** 独奏时被顺带静音的轨 id（退出独奏要按这份名单还原，见 toggleSolo） */
    _soloMuted: [] as string[],
  }),

  getters: {
    /**
     * 渲染结果是否**已过期**（音符/歌词在渲染之后被改过）。
     *
     * 以前没有任何标记：改了音符再播放，听到的还是上一次渲染的音频，
     * 用户只会觉得"调了没反应"。这里按"渲染当时的音符指纹"比对。
     */
    staleRenderIds(state): string[] {
      const out: string[] = [];
      for (const t0 of state.tracks) {
        if (!state.renderByTrack[t0.id]) continue;
        if (t0.renderSig && t0.renderSig !== noteSignature(t0.notes)) out.push(t0.id);
      }
      return out;
    },

    /** 是否可撤销 / 可重做（工具条按钮的禁用态用） */
    canUndo(state): boolean { return state.history.length > 0; },
    canRedo(state): boolean { return state.future.length > 0; },
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
    /* ---------------- 撤销栈 ---------------- */

    /** 快照：只存**会写进工程文件**的东西（渲染字节、banks 之类是缓存，不进历史）。
     *  跟节流无关 —— 拖拽是「交互开始推一次」，所以这里不需要合并逻辑。 */
    _snapshot() {
      return JSON.stringify({
        tracks: this.tracks,
        bpm: this.bpm,
        meta: this.meta,
        sampleNote: this.sampleNote,
        device: this.device,
        activeTrackId: this.activeTrackId,
      });
    },
    /** 在**做修改之前**调用；清空重做栈（与浏览器/编辑器的通用语义一致） */
    pushUndo() {
      try {
        this.history.push(this._snapshot());
        if (this.history.length > HISTORY_MAX) this.history.shift();
        this.future = [];
      } catch (e) { /* 快照失败不该挡住编辑 */ }
    },
    _applySnapshot(json: string): boolean {
      try {
        const s = JSON.parse(json);
        if (!s || !Array.isArray(s.tracks)) return false;
        this.tracks = s.tracks;
        this.bpm = s.bpm ?? this.bpm;
        this.meta = s.meta ?? this.meta;
        this.sampleNote = s.sampleNote ?? this.sampleNote;
        this.device = s.device ?? this.device;
        this.activeTrackId = s.activeTrackId ?? (this.tracks[0] ? this.tracks[0].id : null);
        // 音符被整体替换过，旧的选中 id 可能已经不存在
        const ids = new Set<string>();
        for (const t0 of this.tracks) for (const nn of t0.notes) ids.add(nn.id);
        if (this.selectedId && !ids.has(this.selectedId)) this.selectedId = null;
        this.selectedIds = this.selectedIds.filter((i) => ids.has(i));
        return true;
      } catch (e) { return false; }
    },
    undo(): boolean {
      if (!this.history.length) return false;
      const cur = this._snapshot();
      const prev = this.history.pop() as string;
      if (!this._applySnapshot(prev)) return false;
      this.future.push(cur);
      return true;
    },
    redo(): boolean {
      if (!this.future.length) return false;
      const cur = this._snapshot();
      const next = this.future.pop() as string;
      if (!this._applySnapshot(next)) return false;
      this.history.push(cur);
      return true;
    },

    addTrack(engine: Engine = 'utau'): string {
      this.pushUndo();
      const t = makeTrack(engine);
      this.tracks.push(t);
      this.activeTrackId = t.id;
      return t.id;
    },
    removeTrack(id: string) {
      this.pushUndo();
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
      this.pushUndo();
      const t = makeAudioTrack(path, fileName, durationMs);
      this.tracks.unshift(t);            // 伴奏通常放最上，对齐时好看
      this.activeTrackId = t.id;
      return t.id;
    },
    patchAudio(id: string, patch: Partial<AudioClip>) {
      this.pushUndo();
      const t = this.tracks.find(x => x.id === id);
      if (t && t.audio) Object.assign(t.audio, patch);
    },

    /**
     * 写一个音素级表达式（P2-2）。value 传 null/undefined = 清掉这一项。
     * 清到该下标没有任何覆盖时，把整个下标也删掉 —— 免得 payload 里留一堆空对象。
     */
    setPhonemeExpression(noteId: string, index: number, abbr: string, value: number | null) {
      const idx = Math.max(0, Math.floor(Number(index) || 0));
      for (const t0 of this.tracks) {
        const n = t0.notes.find((x) => x.id === noteId);
        if (!n) continue;
        const all: Record<string, Record<string, number>> = Object.assign({}, n.phExpressions || {});
        const cur: Record<string, number> = Object.assign({}, all[String(idx)] || {});
        if (value == null) delete cur[abbr];
        else cur[abbr] = Number(value);
        if (Object.keys(cur).length) all[String(idx)] = cur;
        else delete all[String(idx)];
        if (Object.keys(all).length) n.phExpressions = all;
        else delete n.phExpressions;
        return;
      }
    },

    /** 清空某个音素（下标）的全部覆盖；不传 index 则清空该音符所有音素覆盖 */
    clearPhonemeExpressions(noteId: string, index?: number) {
      for (const t0 of this.tracks) {
        const n = t0.notes.find((x) => x.id === noteId);
        if (!n) continue;
        if (index == null) { delete n.phExpressions; return; }
        const all: Record<string, Record<string, number>> = Object.assign({}, n.phExpressions || {});
        delete all[String(Math.max(0, Math.floor(Number(index) || 0)))];
        if (Object.keys(all).length) n.phExpressions = all;
        else delete n.phExpressions;
        return;
      }
    },

    /**
     * 工程级对齐偏移（P2-3）：把音符整体平移 n 毫秒。
     *
     * ★ 为什么要它：歌词听感整体"抢"或"拖"时（换气点、伴奏前奏长度不同），
     *   一个个音符挪是折磨。这里按当前 BPM 换算成拍，一次挪完，并可撤销。
     * 负数 = 提前，正数 = 延后；只挪声部轨的音符，伴奏轨不动（伴奏是音频，挪了就对不上）。
     */
    shiftNotesByMs(ms: number, trackId?: string) {
      const dBeat = (Number(ms) || 0) / 1000 * (this.bpm / 60);
      if (!dBeat) return 0;
      const targets = this.tracks.filter((t) => t.kind === 'voice' && (!trackId || t.id === trackId));
      if (!targets.length) return 0;
      this.pushUndo();
      let n = 0;
      for (const t0 of targets) {
        for (const note of t0.notes) {
          note.startBeat = Math.max(0, Math.round((note.startBeat + dBeat) * 32) / 32);
          n += 1;
        }
        t0.notes.sort((a, b) => a.startBeat - b.startBeat);   // 与 updateNote 的约定一致
      }
      // meta 与 notes 都是响应式 state，直接写即可（卷帘的 rev 指纹会自己变）
      this.meta = Object.assign({}, this.meta, { alignMs: Math.round(Number(ms) || 0) });
      return n;
    },

    /** 拖拽排序：把 fromId 移到 toId 的位置（toId 之后或之前均可，保持其余顺序） */
    moveTrack(fromId: string, toId: string) {
      const from = this.tracks.findIndex((t) => t.id === fromId);
      const to = this.tracks.findIndex((t) => t.id === toId);
      if (from < 0 || to < 0 || from === to) return;
      this.pushUndo();
      const [t0] = this.tracks.splice(from, 1);
      if (!t0) return;                       // 理论上取不到；取不到就原样放回（不丢轨）
      this.tracks.splice(to, 0, t0);
    },

    /**
     * 独奏：开启时把**其它轨全部静音**（并记住原本就没静音的那些），
     * 关闭时只恢复"被独奏顺带静音"的轨 —— 不覆盖用户自己的静音设置。
     */
    toggleSolo(id: string) {
      const t0 = this.tracks.find((x) => x.id === id);
      if (!t0) return;
      this.pushUndo();
      if (!this._soloMuted.length) {
        this._soloMuted = this.tracks.filter((x) => x.id !== id && !x.muted).map((x) => x.id);
        for (const x of this.tracks) x.muted = x.id !== id;
      } else {
        const back = new Set(this._soloMuted);
        for (const x of this.tracks) if (back.has(x.id)) x.muted = false;
        this._soloMuted = [];
      }
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
      this.pushUndo();
      const t = this.tracks.find(x => x.id === id);
      if (!t) return;
      const f = makeFx(type);
      if (!f) return;
      t.fx = [...(t.fx || []), f];
    },
    removeFx(id: string, fxId: string) {
      this.pushUndo();
      const t = this.tracks.find(x => x.id === id);
      if (t) t.fx = (t.fx || []).filter(f => f.id !== fxId);
    },
    /** 上移（-1）/ 下移（+1）：越界不动（按钮会在 UI 上置灰） */
    moveFx(id: string, fxId: string, delta: number) {
      this.pushUndo();
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
      this.pushUndo();
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
      this.pushUndo();
      const t = this.tracks.find(x => x.id === id);
      if (!t) return;
      t.curves = (t.curves || []).filter(c => c.abbr !== abbr);
      if (abbr === 'PIT') t.pitchCurve = [];
    },

    /* ---------------- 音符 ---------------- */
    addNote(startBeat: number, pitch: number): string | null {
      this.pushUndo();
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
      this.pushUndo();
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
      this.pushUndo();
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
      this.pushUndo();
      const tr = this.activeTrack;
      if (!tr) return;
      const sorted = pts.slice().sort((a, b) => a.beat - b.beat);
      tr.pitchCurve = sorted;
      this.setCurve(tr.id, 'PIT', sorted.map(p => ({ beat: p.beat, value: p.cents })));
    },
    clearPitchCurve() {
      this.pushUndo();
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
      this.pushUndo();
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
      // 整盘换掉 = 新起点：历史里留着上一批快照，Ctrl+Z 会把旧曲目"复活"
      this.history = [];
      this.future = [];
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
      this.meta = { title: '', comment: '', artist: '', timeSig: '4/4', alignMs: 0 };
      this.missingAudio = [];
      // 空工程 = 新会话：历史里留着上一个工程的快照只会让 Ctrl+Z 变味
      this.history = [];
      this.future = [];
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
      this.meta = Object.assign({ title: '', comment: '', artist: '', timeSig: '4/4', alignMs: 0 }, proj.meta || {});
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
    /** 请求停止「渲染全部轨」的后续排队。
     *  ★ 不谎报能力：已经在跑的那一条**不会**被打断（引擎进程里没做可中断渲染），
     *    它跑完即停，剩下的条数不再开始。按钮文案也照这个如实写。 */
    cancelRender() {
      if (!this.busy) return;
      this._cancelled = true;
      this.msg = '已停止：正在渲染的这一条跑完就结束';
    },

    async renderAll(): Promise<string> {
      const todo = this.tracks.filter(t =>
        t.kind === 'voice' && !!t.singer && t.notes.length > 0);
      if (!todo.length) return '没有可渲染的声部轨（每条都要选了歌手且有音符）';
      this.busy = true;
      this.progress = 0;
      this.msg = '';
      this._cancelled = false;
      const failed: string[] = [];
      let stopped = false;
      /* ★ i 必须声明在 try 外：下面"已停止"分支要用它算成功条数，
         写在 try 里会在中断路径上直接 ReferenceError。 */
      let i = 0;
      try {
        // ★ 用 for-of 而不是下标：`noUncheckedIndexedAccess` 下 `todo[i]` 是
        //   `SingTrack | undefined`，下标写法要到处加判空
        for (const t of todo) {
          if (this._cancelled) { stopped = true; break; }
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
      if (stopped) {
        const okN = Math.max(0, i - 1 - failed.length);
        return '已停止（渲染 ' + okN + '/' + n + ' 轨）'
          + (failed.length ? '；失败的：' + failed.join('；') : '');
      }
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
        if (trackId) {
          this.renderByTrack[trackId] = bytes;
          // 记下"这一版是拿什么音符渲出来的"，之后改音符就能提示"渲染已过期"
          const t0 = this.tracks.find((x) => x.id === trackId);
          if (t0) t0.renderSig = noteSignature(t0.notes);
        }
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
      const vol = curveOf(tr, 'VOL');
      const notes = tr.notes.map(n => {
        /* ★★ 两个引擎的默认值口径不同，所以**没设过的参数一律不发**，
              让引擎用它自己的原生默认值（legacy: velocity/volume=100、gender=50、breath=0；
              openutau: vol/vel/atk/dec 描述符默认 100、shft 0）。
           旧实现无条件发 `volume: n.volume ?? 0`、`gender: n.gender ?? 0` —— 那是把
           「界面里的 0」当成「用户要 0」，legacy 引擎会按 volume=0 直乘 → **整轨静音**，
           GENC=0 又会被按"最男声"渲染（它 0..100、50 才是不变）。 */
        const expressions: Record<string, number> = {};
        const raw: Record<string, any> = {
          startBeat: n.startBeat, durBeat: n.durBeat, pitch: n.pitch,
          // UTAU 的 wavtool 需要一个 alias；空歌词会让引擎取不到采样
          lyric: n.lyric || this.sampleNote || 'a',
          vibrato: !!n.vibrato, vibDepth: n.vibDepth, vibFreq: n.vibFreq,
          vibFade: n.vibFade || 0,
        };

        /* 力度 / 音量 / 性别 / 气声：
           - 有对应自动化子轨（DYN/VOL/GEN/BRE）→ 按音符中点取值（自动化优先级最高）
           - 否则只在音符上**真设过**时才发；没设过就整个键不发 */
        const velocity = dyn ? valueForNote(dyn.points, n.startBeat, n.durBeat, 'DYN') : n.velocity;
        if (typeof velocity === 'number') { raw.velocity = velocity; expressions.vel = velocity; }
        const volume = vol ? valueForNote(vol.points, n.startBeat, n.durBeat, 'VOL') : n.volume;
        if (typeof volume === 'number') { raw.volume = volume; expressions.vol = volume; }
        const breath = bre ? valueForNote(bre.points, n.startBeat, n.durBeat, 'BRE') : n.breath;
        if (typeof breath === 'number') { raw.breath = breath; expressions.bre = breath; }
        const genderUi = gen ? valueForNote(gen.points, n.startBeat, n.durBeat, 'GEN') : n.gender;
        if (typeof genderUi === 'number') {
          /* 界面 GENC 是 -100..100（0 = 不变），legacy 引擎要 0..100（50 = 不变）：
             这里做显式映射，负值压到 0（legacy 没有"更暗"的区间，夹住而不是乱翻）。 */
          const mapped = Math.max(0, Math.min(100, 50 + genderUi / 2));
          raw.gender = mapped;
          expressions.gen = mapped;
        }

        // OpenUTAU 表达式（每音符；未设不发 → 用描述符默认值）
        if (typeof n.dyn === 'number') expressions.dyn = n.dyn;
        if (typeof n.atk === 'number') expressions.atk = n.atk;
        if (typeof n.dec === 'number') expressions.dec = n.dec;
        if (typeof n.shft === 'number') expressions.shft = n.shft;
        if (typeof n.clr === 'number') expressions.clr = n.clr;

        if (Object.keys(expressions).length) raw.expressions = expressions;

        /* 音素级覆盖（P2-2）→ 引擎的 phoneme_expressions: [{index, expressions}]。
           ★ 只下发非空项；下标要能转成非负整数，脏键直接跳过
             （引擎侧会再挡一次，两边都不因为脏数据让整轨渲染失败）。 */
        const pe = n.phExpressions;
        if (pe && typeof pe === 'object') {
          const items: { index: number; expressions: Record<string, number> }[] = [];
          for (const k of Object.keys(pe)) {
            const idx = Number(k);
            const vals = pe[k];
            if (!Number.isInteger(idx) || idx < 0 || !vals || typeof vals !== 'object') continue;
            const clean: Record<string, number> = {};
            for (const abbr of Object.keys(vals)) {
              const v = Number(vals[abbr]);
              if (Number.isFinite(v)) clean[abbr] = v;
            }
            if (Object.keys(clean).length) items.push({ index: idx, expressions: clean });
          }
          if (items.length) raw.phoneme_expressions = items;
        }
        return raw;
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
