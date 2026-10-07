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

import { ref } from 'vue';
import { defineStore } from 'pinia';
import { bridge, isDesktop } from '../api';
import {
  missingAssets, parseProject, resolveAssetPaths, serializeProject,
} from '../core/song_project.js';
import { makeFx, normalizeFx } from '../core/track_fx.js';
import { createHistory } from '../core/song_history.js';
import { stemFileName, stemSafeName } from '../core/util.js';
import { normalizeSampleNote } from '../core/utau_tools.js';
import {
  splitPhrases, phraseSignature, phraseWindows, parseWav, sliceSegment, composeSegments,
  PHRASE_GAP_BEATS,
} from '../core/phrase_render.js';
import {
  curveOf, normalizeCurve, normalizeCurves, targetsFor, valueForNote,
} from '../core/track_automation.js';

/* ------------------------------------------------------------------ 类型 */

export type Engine = 'utau' | 'diffsinger';

/* ---- §4.6 乐句级增量渲染的缓存结构 ---- */

/** 一个乐句在时间轴上的切片（bytes 是**已按窗口裁好**的 WAV，拼接时按 startMs 放回去） */
export interface PhraseSeg {
  /** 这句实际下发的 payload + 上下文串的指纹；一样就说明音频没变 */
  hash: string;
  startMs: number;
  endMs: number;
  bytes: Uint8Array;
}

/** 一条轨的乐句缓存 */
export interface TrackPhraseCache {
  /** 上下文串（歌手/BPM/采样基准音/引擎参数…）；变了整份缓存作废 */
  key: string;
  /** 尾音时长（引擎总时长 - 最后一个音符结束），用来推整轨时长 */
  tailMs: number;
  sr: number;
  totalMs: number;
  phrases: PhraseSeg[];
}

/** 上一次渲染的统计（给界面显示"复用了几句、新渲了几句"） */
export interface PhraseRenderStats {
  trackId: string;
  phrases: number;
  reused: number;
  rendered: number;
  calls: number;
  ms: number;
}

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

/**
 * 音素覆写（对应上游 `UPhonemeOverride`）—— 音素级时间微调。
 * 时间量单位 **ms**（引擎边界转换：offset→tick、delta 直传 ms 域）。
 * `index` 是音符内音素下标（0 起，应用侧按派生分段计数）。
 */
export interface PhonemeOverride {
  index: number;
  /** 音素起点偏移 ms（正值后移） */
  offset?: number;
  /** 前起音增量 ms */
  preutterDelta?: number;
  /** 重叠增量 ms */
  overlapDelta?: number;
}

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
  vibFade: number;       // 0..100（旧字段：等于 in/out 取 max，新代码请用 vibIn/vibOut）

  /* ---- 颤音扩展参（对应上游 UVibrato，均可选；缺省时按上游默认值兜底）---- */
  vibIn?: number;        // 0..100 起音占比
  vibOut?: number;       // 0..100 收音占比（引擎侧 out ≤ 100 − in 互约束）
  vibShift?: number;     // -100..100 相位偏移
  vibDrift?: number;     // -100..100 漂移（音高随机波动）
  vibVolLink?: number;   // -100..100 音量联动

  /* ---- 音素覆写（音素级时间微调，泳道/条带上拖拽产生）---- */
  phonemeOverrides?: PhonemeOverride[];

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
  /**
   * 轨道配色（`#rrggbb`）。
   *
   * ★ 存在轨道上而不是「按索引现算」：多轨叠置时颜色是用户认轨的唯一线索，
   *   按索引算的话删一条轨/换一下顺序，所有颜色就全串了。
   *   老工程没有这个字段 → 由 `trackColorOf()` 按索引补一个（不写回文件，除非用户改过）。
   */
  color?: string;
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
   * 片段起点（拍，升序）：轨承载多片段（对齐 OpenUtau/传统 DAW——轨是混音通道，
   * 片段是时间线上的内容块）。音符/曲线仍是轨级绝对拍；导出 ustx 时按区间
   * `[s_i, s_{i+1})` 切回 UVoicePart。缺省视为单段（position 0）。
   */
  partStarts?: number[];
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

/**
 * 给外部（复制轨、导入等）用的唯一音符 id 生成器。
 *
 * ★ 音符 id 必须**全局唯一**，不能只在一条轨里唯一：
 *   多轨叠置时点了 A 轨的音符却要落到 B 轨上，`updateNote` 又是「按 id 找第一个匹配」，
 *   两条轨撞 id 就会改错人（实测踩过：同一毫秒给两条轨填词，id 一模一样）。
 */
export function newNoteId(): string { return nid(); }

/**
 * 轨道配色板。
 *
 * 八个色相拉开距离、明度都在中间调：浅色主题与深色主题下都能与底色分开，
 * 半透明画成「幽灵音符」时也还能认出是哪条轨（参考 FL Studio 的 ghost notes 用法）。
 */
export const TRACK_PALETTE = ['#3d8bfd', '#ff7a45', '#36b37e', '#b37feb',
  '#f2b705', '#22b8cf', '#f06595', '#7f8c8d'];

/**
 * 色盲友好配色板（M9c）：**Okabe–Ito** 八色。
 *
 * ★ 为什么是这一套：它是色觉障碍研究里最通用的一套定性配色（蓝/朱红/青绿/橙/紫红/天蓝/黄/黑），
 *   对红绿色盲（最常见）也保持可分辨，而且明度拉开、投影仪/打印都不塌。
 *   原来那套里 #36b37e（绿）与 #ff7a45（橙红）、#f06595（粉）与 #b37feb（紫）在红绿色盲下会糊在一起。
 */
export const TRACK_PALETTE_CB = ['#0072B2', '#D55E00', '#009E73', '#CC79A7',
  '#E69F00', '#56B4E9', '#F0E442', '#000000'];

const CB_KEY = 'fufumidi_cb_palette';
/* ★ 必须是 **ref** 而不是普通变量：trackColorOf() 被模板与 computed 调用，
   普通变量不参与响应式 —— 实测过"开关写进 localStorage 了、但轨道色块纹丝不动、按钮高亮也不变"。 */
const _cbMode = ref(false);
try { _cbMode.value = localStorage.getItem(CB_KEY) === '1'; } catch (e) {}
/** 当前生效的配色板（色盲友好开关会整体换板） */
export function activePalette(): string[] { return _cbMode.value ? TRACK_PALETTE_CB : TRACK_PALETTE; }
export function colorblindMode(): boolean { return _cbMode.value; }
export function setColorblindMode(on: boolean): boolean {
  _cbMode.value = !!on;
  try { localStorage.setItem(CB_KEY, _cbMode.value ? '1' : '0'); } catch (e) {}
  return _cbMode.value;
}

/** 轨道颜色：轨道自带优先，否则按索引取板上的颜色 */
export function trackColorOf(track: { color?: string } | null | undefined, index = 0): string {
  const own = track && track.color;
  if (typeof own === 'string' && /^#[0-9a-f]{3,8}$/i.test(own)) return own;
  const pal = activePalette();
  const n = pal.length;
  const fallback = '#8b83f0';
  if (!n) return fallback;                        // 调色板为空（理论上不会）：给个确定值，别返回 undefined
  return pal[(((index | 0) % n) + n) % n] ?? pal[0] ?? fallback;
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
    /* ★ volume 默认必须是 100（引擎的"不改变"值），不能是 0：
       0 会被引擎当成"音量乘 0" → **整轨静音**。
       实测：导入 275 个音符、渲染成功（ok:true）却得到 244 秒纯静音，
       根因就是这里默认 0 + 下发时把 0 一起发给了引擎。 */
    base.volume = 100;
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
    /** UTAU 侧的采样**基准音**（音名，如 C4）：引擎拿它算变调比。★ 不是别名 */
    sampleNote: 'C4' as string,
    /** 渲染产物的可播放 URL（两个引擎共用） */
    renderUrl: '' as string,
    /* ---- 工程文件（.fufumidi 自包含包）---- */
    /** 当前工程路径；空 = 还没保存过（此时"保存"会走另存为对话框） */
    projectPath: '' as string,
    /** 编辑历史栈（song_history 实例；非序列化字段，不进工程文件） */
    _hist: null as any,
    createdAt: '' as string,
    /**
     * 工程级参数（P2-3）。除了标题，还带拍号与"对齐偏移"的**当前值**：
     *   拍号    —— 只影响卷帘的小节线与编号（4/4、3/4…），不改音符
     *   对齐偏移 —— 上一次整体平移的毫秒数（记录用，真正的平移写在音符上）
     * 两样都随工程文件走，所以类型上放宽成可选，老工程没有也能打开。
     */
    /** 和声组（M8a）：组只是"一组轨 + 组级覆盖"，成员轨本身不变 —— 于是导出/渲染链路都不用动。 */
  meta: { title: '', comment: '', artist: '', timeSig: '4/4', alignMs: 0, groups: [] as { id: string; name: string; trackIds: string[] }[] } as
      { title: string; comment: string; artist: string; timeSig?: string; alignMs?: number;
        /** 和声组（M8a）。类型以前漏了这个字段 —— 运行时有、类型里没有，
         *  于是所有读 meta.groups 的地方都报 TS2339（9 处），是"类型债"不是逻辑债。 */
        groups?: { id: string; name: string; trackIds: string[] }[] },
    /**
     * 多点变速（拍单位，首点 beat=0）。`bpm` 标量仍是首点真源 ——
     * 序列化时 `song_project.js` 会把标量回填进 tempoMap[0]。
     */
    tempoMap: [] as { beat: number; bpm: number }[],
    /** 多点拍号（首点 beat=0），对应 ustx 的 timeSignatures */
    sigMap: [] as { beat: number; num: number; den: number }[],
    /** 调号（-7..7），对应 ustx 的 key */
    keySf: 0,
    /** 打开工程后没落到本地的伴奏（包里缺文件 / 解包失败） */
    missingAudio: [] as { trackId: string; fileName: string; asset: string }[],
    /**
     * ★ **按轨道**存放渲染结果 —— 多条声部轨要能同时发声，就不能像以前那样
     *   只留"最后一次渲染"的一份字节（那等于"渲一条就顶掉上一条"）。
     *   键是轨道 id；删轨 / 新建 / 打开工程时清空对应项。
     */
    renderByTrack: {} as Record<string, Uint8Array>,
    /**
     * ★ §4.6 乐句级增量渲染缓存：trackId → 每句的字节 + 指纹。
     *   只活在内存里（渲染结果本身就是内存态），不进工程文件。
     */
    _phraseCache: {} as Record<string, TrackPhraseCache>,
    /** 最近一次渲染的"复用/新渲"统计（界面上给一句实话，别让人以为每次都在重算） */
    _phraseStats: null as PhraseRenderStats | null,
    /** A/B 对比里的 A = **上一版渲染结果**（按轨存） */
    renderPrevByTrack: {} as Record<string, Uint8Array>,
    /** A/B 两条 Blob URL（切换播放靠换 renderUrl，传输器监听它） */
    renderUrlA: '' as string,
    renderUrlB: '' as string,
    /** 当前在听哪一版 */
    abWhich: 'B' as 'A' | 'B',
    renderWarnings: [] as string[],
    lastDurationMs: 0 as number,
    lastPipeline: '' as string,

    /* ---- 撤销栈（页面级，覆盖音符 / 轨 / 效果 / 自动化 / 轨名 / 语言 / 模板）----
       ★ 为什么不放在 PianoRoll 里：卷帘只能看见音符。改音量、效果链、自动化、轨名、
         歌词、渲染设置同样会写坏工程，却一直没有撤销入口。这里做成**整页共用**的一栈。 */
    /** 撤销栈版本号：_hist 本身不是响应式对象，靠它让按钮禁用态重算 */
    histRev: 0 as number,
    /** 「渲染全部轨」的停止请求标记（见 cancelRender）；不进工程文件 */
    _cancelled: false as boolean,
    /** 独奏时被顺带静音的轨 id（退出独奏要按这份名单还原，见 toggleSolo） */
    _soloMuted: [] as string[],
    /**
     * 卷帘里**临时隐藏**的轨 id（多轨叠置时按需只看几条）。
     * 只是显示开关：不影响发声、不写进工程文件。
     */
    rollHidden: [] as string[],
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
    canUndo(state): boolean { void state.histRev; return !!(state._hist && state._hist.canUndo); },
    canRedo(state): boolean { void state.histRev; return !!(state._hist && state._hist.canRedo); },
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
    /**
     * 选中的音符（多选，**跨轨道**）。
     *
     * ★ M8d（跨轨选区第一步）：以前这里只筛 `activeTrack`，于是"在别的轨上点一个音符"永远进不了选区，
     *   批量工具（渐强/渐弱/移调/量化…）也就只能作用在当前轨。现在按 id 跨轨收集 ——
     *   这让"和声组内统一编辑"有了数据基础，也让卷帘里点幽灵音符可以直接加进选区。
     *   顺序按轨道顺序返回，保证批量操作的结果可预期。
     */
    selectedNotes(): SingNote[] {
      const ids = new Set(this.selectedIds);
      if (this.selectedId) ids.add(this.selectedId);
      if (!ids.size) return [];
      const out: SingNote[] = [];
      for (const tr of this.tracks) for (const n of tr.notes) if (ids.has(n.id)) out.push(n);
      return out;
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

    addTrack(engine: Engine = 'utau'): string {
      this.pushUndo();
      const t = makeTrack(engine);
      t.color = TRACK_PALETTE[this.tracks.length % TRACK_PALETTE.length];
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
      delete this._phraseCache[id];       // 乐句缓存同理（换 id 重建轨不会误命中）
      delete this.renderPrevByTrack[id];
    },
    /** 多轨叠置：切换某条轨在卷帘里是否显示（纯显示，不影响发声/渲染） */
    toggleRollHidden(id: string) {
      const i = this.rollHidden.indexOf(id);
      if (i >= 0) this.rollHidden.splice(i, 1);
      else this.rollHidden.push(id);
    },
    /** 点轨道色块：在调色板上轮换一个颜色（写进工程文件） */
    cycleTrackColor(id: string) {
      const i = this.tracks.findIndex(t => t.id === id);
      if (i < 0) return;
      const tr0 = this.tracks[i];
      if (!tr0) return;
      const pal = activePalette();
      const cur = trackColorOf(tr0, i);
      const k = pal.indexOf(cur);
      this.pushUndo();
      const next = pal.length ? pal[(k + 1) % pal.length] : undefined;
      tr0.color = next ?? cur;                    // 取不到就保持不变，别把颜色写成 undefined
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

    /* ---------------- 和声组（M8a，计划书 §4.5） ----------------
       组是**视图层概念**：只记「哪几条轨属于一组 + 组名」，成员轨的数据一个字段都不改 ——
       这样渲染、导出、撤销栈全都不用跟着动，风险最低。组级参数覆盖留给下一步。 */
    addGroup(trackIds?: string[], name?: string) {
      const ids = (trackIds && trackIds.length ? trackIds : (this.activeTrackId ? [this.activeTrackId] : []))
        .filter((id) => this.tracks.some((t) => t.id === id));
      if (!ids.length) return null;
      const g = { id: 'grp' + Math.random().toString(36).slice(2, 9), name: (name || '').trim() || ('组 ' + ((this.meta.groups || []).length + 1)), trackIds: ids };
      this.meta = Object.assign({}, this.meta, { groups: [...(this.meta.groups || []), g] });
      return g.id;
    },
    renameGroup(id: string, name: string) {
      const groups = (this.meta.groups || []).map((g) => (g.id === id ? { ...g, name: String(name || '').slice(0, 60) } : g));
      this.meta = Object.assign({}, this.meta, { groups });
    },
    setGroupMembers(id: string, trackIds: string[]) {
      const ids = (trackIds || []).filter((x) => this.tracks.some((t) => t.id === x));
      const groups = (this.meta.groups || []).map((g) => (g.id === id ? { ...g, trackIds: ids } : g));
      this.meta = Object.assign({}, this.meta, { groups });
    },
    removeGroup(id: string) {
      this.meta = Object.assign({}, this.meta, { groups: (this.meta.groups || []).filter((g) => g.id !== id) });
    },
    /**
     * 组内统一编辑 v1（M8c）：对**所有成员轨的全部音符**做一次批量移调。
     *
     * ★ 为什么先做这个而不是"多轨选区"：调教页卷帘是单轨编辑（`selectedNotes` 只认活动轨），
     *   要支持跨轨选区得动 PianoRoll 的核心模型；而"组内统一移调/八度"是编和声时最常用的批量动作，
     *   用一次 pushUndo 包住即可撤销，风险小、收益直接。跨轨选区留给后续（复用音乐编辑器的 editTracks）。
     */
    transposeGroup(id: string, semitones: number): number {
      const g = (this.meta.groups || []).find((x) => x.id === id);
      if (!g || !semitones) return 0;
      const members = new Set(g.trackIds);
      const targets = this.tracks.filter((t) => members.has(t.id));
      if (!targets.length) return 0;
      this.pushUndo();
      let n = 0;
      for (const t of targets) {
        for (const note of t.notes) {
          note.pitch = Math.max(0, Math.min(127, (Number(note.pitch) || 0) + semitones));
          n += 1;
        }
      }
      return n;
    },
    /**
     * 组内统一量化（M8c 续）：把成员轨所有音符的起点吸附到 grid 拍网格上（一次撤销点）。
     * 与 transposeGroup 同一套路数 —— 批量写回、单撤销点，用户能立刻在每个成员轨上看到结果。
     */
    quantizeGroup(id: string, grid: number): number {
      const g = (this.meta.groups || []).find((x) => x.id === id);
      const step = Number(grid);
      if (!g || !(step > 0)) return 0;
      const members = new Set(g.trackIds);
      const targets = this.tracks.filter((t) => members.has(t.id));
      if (!targets.length) return 0;
      this.pushUndo();
      let n = 0;
      for (const t of targets) {
        for (const note of t.notes) {
          const q = Math.round((Number(note.startBeat) || 0) / step) * step;
          if (Math.abs(q - (Number(note.startBeat) || 0)) > 1e-6) { note.startBeat = Math.max(0, Math.round(q * 1e4) / 1e4); n += 1; }
        }
        t.notes.sort((a, b) => a.startBeat - b.startBeat);
      }
      return n;
    },
    /**
     * 组级参数覆盖（M8b，计划书 §4.5）：**批量写回成员轨**，而不是在混音时叠加。
     *
     * ★ 为什么选批量写回：混音链路上再插一层"组增益"要动播放/导出两处，而批量写回
     *   走的就是既有的 patchTrack 语义（渲染、导出、撤销栈都不用改），行为也更好解释：
     *   「点了组的 M，成员轨就都静音了」——用户能在每条轨上直接看到结果。
     *   muted = 成员静音；solo = 只留成员（其余全部静音）。
     */
    applyGroup(id: string, patch: { muted?: boolean; solo?: boolean; gainDb?: number }): number {
      const g = (this.meta.groups || []).find((x) => x.id === id);
      if (!g) return 0;
      const members = new Set(g.trackIds);
      let n = 0;
      for (const t of this.tracks) {
        if (t.kind === 'audio') continue;
        const isMember = members.has(t.id);
        if (patch.muted !== undefined && isMember) { t.muted = !!patch.muted; n++; }
        else if (patch.solo !== undefined) { t.muted = patch.solo ? !isMember : false; n++; }
        // 组内统一音量：把组的增益一次性写到每条成员轨（-24 ~ +24 dB）
        if (patch.gainDb !== undefined && isMember) { t.gainDb = Math.max(-24, Math.min(24, Number(patch.gainDb) || 0)); n++; }
      }
      const groups = (this.meta.groups || []).map((x) => (x.id === id ? { ...x, ...patch } : x));
      this.meta = Object.assign({}, this.meta, { groups });
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
    /**
     * 用一批音符整体替换某条轨的音符（会改变音符**个数**）。
     *
     * 用途：批量填词的「切开长音符」模式 —— 字比音符多时把长音符对半切开，
     * 让每个字都有自己的音符。老实现只能逐条 updateNote，改不了个数。
     * 传进来的项可以带 id（原有音符）或不带（新切出来的片段，这里分配）。
     */
    replaceNotes(trackId: string, items: any[]): number {
      const tr = this.tracks.find((x) => x.id === trackId);
      if (!tr) return 0;
      this.pushUndo();
      const base = makeNote(tr, 0, 60);
      /* ★ id 全局唯一：以前是 `'sn' + Date.now() + i` —— 同一毫秒给两条轨各填一次词，
         两条轨就会拿到一模一样的 id（实测：多轨叠置下点 A 轨的音符、改的却是 B 轨）。
         传进来的 id 只在本轨内没重复过时保留（原有音符要保 id，切分出的新片段不带 id）。 */
      const used = new Set<string>();
      tr.notes = (items || []).map((it, i) => {
        const want = it && typeof it.id === 'string' ? it.id : '';
        const keepId = want && !used.has(want) ? want : nid();
        used.add(keepId);
        const n: SingNote = {
          ...base,
          ...it,
          id: keepId,
          startBeat: Math.max(0, Number(it && it.startBeat) || 0),
          durBeat: Math.max(0.02, Number(it && it.durBeat) || 0.25),
          pitch: Math.round(Number(it && it.pitch) || 60),
          lyric: String((it && it.lyric) != null ? it.lyric : ''),
        };
        return n;
      });
      tr.notes.sort((a, b) => a.startBeat - b.startBeat);
      tr.renderSig = '';            // 音符变了 → 之前的渲染标为过期
      this.selectedIds = [];
      this.selectedId = '';
      return tr.notes.length;
    },
    updateNote(id: string, patch: Partial<SingNote>) {
      // 先在**当前轨**里找：多轨叠置时编辑的一定是当前轨的音符
      // （万一旧工程里有撞 id 的音符，这个顺序也保证改的是看得见的那条）
      const first = this.activeTrack;
      const order = first ? [first, ...this.tracks.filter(t => t.id !== first.id)] : this.tracks;
      for (const tr of order) {
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

    /* ---------------- 撤销 / 重做（音符级编辑快照） ----------------
     * 快照 = 各轨的 notes / curves / pitchCurve（JSON 序列化去响应式）。
     * PianoRoll 的画布编辑（拖拽/删除/泳道/音素）都会先 pushUndo ——
     * 之前 rollApi 没提供这些方法、全部判空跳过，等于**没有撤销**。 */
    _snapshotNotes(): string {
      return JSON.stringify((this.tracks || []).map((t: any) => ({
        id: t.id, notes: t.notes, curves: t.curves || [], pitchCurve: t.pitchCurve || [],
      })));
    },
    _restoreNotes(s: string) {
      const byId = new Map<string, any>((JSON.parse(s) as any[]).map(r => [r.id, r]));
      for (const t of this.tracks as any[]) {
        const r = byId.get(t.id);
        if (!r) continue;
        t.notes = r.notes;
        t.curves = r.curves;
        t.pitchCurve = r.pitchCurve;
      }
    },
    pushUndo() {
      this.histRev++;
      if (!this._hist) {
        this._hist = createHistory({
          snapshot: () => this._snapshotNotes(),
          restore: (s: string) => this._restoreNotes(s),
        });
      }
      this._hist.push();
    },
    /** 交互被取消时丢掉刚入栈的那一步（卷帘长按转右键），撤销栈里不留空步 */
    dropUndo() {
      try { if (this._hist) this._hist.drop(); } catch (e) { /* 忽略 */ }
      this.histRev++;
    },
    undo() { if (this._hist) this._hist.undo(); this.histRev++; },
    redo() { if (this._hist) this._hist.redo(); this.histRev++; },
    /** 注：canUndo / canRedo 是上面的 getters（UI 直接读 store.canUndo 当布尔用），这里不再重复定义同名方法 */
    /** 载入新工程 / 导入时清栈（不能 undo 到别的工程去） */
    clearHistory() { if (this._hist) this._hist.clear(); this.histRev++; },

    selectAll() {
      const t = this.activeTrack;
      if (t && t.notes.length) this.selectMany(t.notes.map((n: any) => n.id));
    },
    /** 批量移动（键盘方向键）：dBeat 水平、dPitch 半音 */
    moveNotes(ids: string[], dBeat: number, dPitch: number) {
      const set = new Set(ids);
      if (!set.size) return;
      for (const tr of this.tracks as any[]) {
        let changed = false;
        for (const n of tr.notes) {
          if (!set.has(n.id)) continue;
          n.startBeat = Math.max(0, n.startBeat + dBeat);
          n.pitch = Math.min(127, Math.max(0, n.pitch + Math.round(dPitch)));
          changed = true;
        }
        if (changed) tr.notes.sort((a: any, b: any) => a.startBeat - b.startBeat);
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
    /**
     * 选中一个音符。`additive` = 加选（M8d：卷帘里点幽灵音符就是这条路径）。
     *
     * ★ 以前 additive 只做到"不清空 selectedIds"，**没把原来那个 selectedId 收进集合** ——
     *   于是 `select(a)` 再 `select(b, true)`，选中的仍然只有 b（a 丢了）。
     *   加选要真的累加，就得先把旧的那个并入集合。
     */
    select(id: string | null, additive = false) {
      if (additive && this.selectedId && this.selectedId !== id && !this.selectedIds.includes(this.selectedId)) {
        this.selectedIds = [...this.selectedIds, this.selectedId];
      }
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
      this._phraseCache = {};
      this.renderPrevByTrack = {};
      // 整盘换掉 = 新起点：历史里留着上一批快照，Ctrl+Z 会把旧曲目"复活"
      this.clearHistory();
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
      this.meta = { title: '', comment: '', artist: '', timeSig: '4/4', alignMs: 0, groups: [] };
      this.tempoMap = [];
      this.sigMap = [];
      this.keySf = 0;
      this.missingAudio = [];
      // 空工程 = 新会话：历史里留着上一个工程的快照只会让 Ctrl+Z 变味
      this.clearHistory();
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
        tempoMap: this.tempoMap,
        sigMap: this.sigMap,
        keySf: this.keySf,
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
      this._phraseCache = {};          // 乐句缓存同理（新工程的音符与旧缓存毫无关系）
      this.renderPrevByTrack = {};
      this.renderUrlA = '';
      this.renderUrlB = '';
      this.abWhich = 'B';
      this.tracks = tracks;
      this.bpm = proj.bpm;
      this.tempoMap = proj.tempoMap || [];
      this.sigMap = proj.sigMap || [];
      this.keySf = proj.keySf || 0;
      this.device = proj.device;
      this.sampleNote = proj.sampleNote;
      this.activeTrackId = proj.activeTrackId || (tracks[0]?.id || '');
      this.meta = Object.assign({ title: '', comment: '', artist: '', timeSig: '4/4', alignMs: 0, groups: [] }, proj.meta || {});
      this.createdAt = proj.createdAt || '';
      this.projectPath = r.filePath || '';
      this.selectedId = null;
      this.selectedIds = [];
      this.missingAudio = missingAssets(tracks);
      this.clearHistory();

      const n = this.missingAudio.length;
      return n ? '工程已打开，但有 ' + n + ' 个伴奏文件缺失（包里没有或解包失败）' : '';
    },

    /* ---------------- OpenUtau .ustx 互转 ---------------- */
    /**
     * 导入 OpenUtau `.ustx`：选文件 → Python 引擎转换（版本迁移/编码都在引擎层）
     * → parseProject 校验 → 声库名匹配本地声库 → 灌进 store。
     *
     * 有损项（音素级参数、曲线等）由引擎以 warnings 返回，拼进提示串给用户。
     */
    async importUstx(): Promise<string> {
      if (!isDesktop || !bridge) return '桌面版才能导入 .ustx';
      const b = bridge as any;
      if (!b.project || typeof b.project.importUstx !== 'function') return '当前版本不支持 .ustx 导入';
      let r: any;
      try {
        r = await b.project.importUstx();
      } catch (e) {
        return String((e as any)?.message || e);
      }
      if (!r || !r.ok) return (r && r.cancelled) ? '' : ((r && r.error) || '导入失败');

      const p = parseProject(r.json) as any;
      if (!p.ok) return p.error || '.ustx 解析失败';
      const proj = p.project as any;
      const tracks = resolveAssetPaths(proj.tracks, r.resolved || {}) as any as SingTrack[];

      // ---- 声库名 → 本地目录匹配（ustx 里记的是声库名，不是本机路径）
      await this.loadBanks();
      const norm = (s: unknown) => String(s || '').trim().toLowerCase();
      const unmatched = new Set<string>();
      for (const t of tracks) {
        if (t.kind !== 'voice') continue;
        const want = norm((t as any).singerName || '');
        const hit = this.banks.find(bk => norm(bk.name) === want)
          || this.banks.find(bk => norm(bk.dir.split(/[\\/]/).pop()) === want);
        if (hit) {
          t.singer = hit.dir;
          t.singerName = hit.name;
          t.engine = hit.engine;      // 以声库实际类型为准（ustx 的 renderer 提示只作兜底）
        } else if (want) {
          unmatched.add((t as any).singerName || '');
        }
      }

      this.renderByTrack = {};
      this.tracks = tracks;
      this.bpm = proj.bpm;
      this.tempoMap = proj.tempoMap || [];
      this.sigMap = proj.sigMap || [];
      this.keySf = proj.keySf || 0;
      this.device = proj.device;
      this.sampleNote = proj.sampleNote;
      this.activeTrackId = proj.activeTrackId || (tracks[0]?.id || '');
      this.meta = proj.meta;
      this.createdAt = proj.createdAt || '';
      // ★ 导入的 .ustx 不是 .fufumidi —— projectPath 置空，"保存"会走另存为
      this.projectPath = '';
      this.selectedId = null;
      this.selectedIds = [];
      this.missingAudio = missingAssets(tracks);
      this.clearHistory();

      const parts: string[] = [];
      const miss = this.missingAudio.length;
      if (miss) parts.push(miss + ' 个伴奏文件没找到');
      if (unmatched.size) parts.push('声库未找到：' + [...unmatched].join('、'));
      for (const w of (r.warnings || [])) parts.push(w);
      return parts.length ? '已导入 .ustx（' + parts.join('；') + '）' : '已导入 .ustx';
    },

    /**
     * 导出为 OpenUtau `.ustx`：serializeProject（含 tempoMap/sigMap）→
     * 引擎转 ustx 并写盘；伴奏由主进程拷到 `<名字>_assets/` 旁目录。
     */
    async exportUstx(): Promise<string> {
      if (!isDesktop || !bridge) return '桌面版才能导出 .ustx';
      const b = bridge as any;
      if (!b.project || typeof b.project.exportUstx !== 'function') return '当前版本不支持 .ustx 导出';
      const { json, assets } = serializeProject({
        tracks: this.tracks as any,
        bpm: this.bpm,
        tempoMap: this.tempoMap,
        sigMap: this.sigMap,
        keySf: this.keySf,
        device: this.device,
        sampleNote: this.sampleNote,
        activeTrackId: this.activeTrackId,
        meta: this.meta,
        createdAt: this.createdAt,
      });
      const plain = JSON.parse(JSON.stringify(json));   // 断开响应式 Proxy（结构化克隆不收）
      try {
        const r = await b.project.exportUstx({
          json: plain,
          audioFiles: assets.map((a: any) => ({ id: a.id, srcPath: a.srcPath, fileName: a.fileName })),
          suggestName: this.meta.title || 'song',
        });
        if (!r || !r.ok) return (r && r.cancelled) ? '' : ((r && r.error) || '导出失败');
        const w: string[] = r.warnings || [];
        return w.length ? '已导出 .ustx（' + w.join('；') + '）' : '已导出 ' + (r.filePath || '');
      } catch (e) {
        return String((e as any)?.message || e);
      }
    },

    /**
     * 逐轨导出（stems，对应上游 `RenderToFiles`）：每条轨各写一份 WAV 到所选目录。
     *
     * 声部轨走**直写渲染**（引擎产物由主进程直接落盘，字节不过 IPC）；
     * 伴奏轨由主进程直拷源文件。文件名 `曲名 - 轨名.wav`，重名自动加序号。
     */
    async exportStems(): Promise<string> {
      if (!isDesktop || !bridge) return '桌面版才能导出分轨';
      const b = bridge as any;
      if (typeof b.pickDirectory !== 'function') return '当前版本不支持分轨导出';
      const dir = await b.pickDirectory();
      if (!dir) return '';
      const base = stemSafeName(this.meta.title || 'song');
      const dirClean = String(dir).replace(/[\\/]+$/, '');
      const used = new Set<string>();
      const fails: string[] = [];
      let okN = 0;
      const total = this.tracks.length;
      this.busy = true;
      this.progress = 0;
      try {
        let doneN = 0;
        for (const t of this.tracks) {
          const out = dirClean + '/' + stemFileName(
            base,
            t.kind === 'audio' ? (t.audio?.fileName || 'audio') : (t.name || 'track'),
            used,
          );
          try {
            if (t.kind === 'voice') {
              const err = t.engine === 'diffsinger'
                ? await this._renderDiffSinger(t, out)
                : await this._renderUtau(t, out);
              if (err) fails.push((t.name || '未命名轨') + '：' + err);
              else okN += 1;
            } else if (t.kind === 'audio' && t.audio?.path) {
              const r = await (typeof b.copyAsset === 'function'
                ? b.copyAsset({ src: t.audio.path, dest: out })
                : { ok: false, error: '当前版本不支持伴奏复制' });
              if (r && r.ok) okN += 1;
              else fails.push((t.name || '伴奏') + '：' + ((r && r.error) || '复制失败'));
            } else {
              fails.push((t.name || '未命名轨') + '：伴奏文件缺失');
            }
          } catch (e) {
            fails.push((t.name || '未命名轨') + '：' + String((e as any)?.message || e));
          }
          this.progress = Math.round((++doneN) / Math.max(1, total) * 100);
        }
      } finally {
        this.busy = false;
        this.progress = 0;
      }
      if (!okN && fails.length) return '分轨导出失败：' + fails.join('；');
      return fails.length
        ? `已导出 ${okN}/${total} 条分轨（失败：${fails.join('；')}）`
        : `已导出 ${okN} 条分轨到 ${dir}`;
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
    /**
     * 订阅引擎的渲染进度。
     *
     * ★ 引擎侧**一直在发**：`engine_diffsinger.py` 会打 `###PROG {"percent","text"}`，
     *   `main/diffsinger.js` 收下来转成 `diffsinger:renderProgress`，preload 也早暴露了
     *   `onDiffsingerRenderProgress` —— 但渲染进程里**没有任何地方订阅它**，
     *   所以 4 分钟的歌进度条从头到尾停在 0（用户实测反馈）。
     *
     * @param base 本段进度在总进度里的起点（渲染全部轨时按轨分摊）
     * @param span 本段占的百分比宽度
     */
    _watchRenderProgress(base = 0, span = 100): () => void {
      const b = window.fuBridge as any;
      if (!b || typeof b.onDiffsingerRenderProgress !== 'function') return () => {};
      const off = b.onDiffsingerRenderProgress((p: any) => {
        if (!p) return;
        const pct = Number(p.percent);
        if (Number.isFinite(pct)) {
          this.progress = Math.max(0, Math.min(100, Math.round(base + (pct / 100) * span)));
        }
        if (p.text) this.msg = String(p.text);
      });
      return () => { try { off(); } catch (e) { /* 已卸载 */ } };
    },

    /**
     * 渲染一条轨。
     *
     * @param trackId 目标轨（不传 = 当前轨）
     * @param opts.full 整轨重渲：丢掉乐句缓存，**所有**乐句都重新下发引擎。
     *   默认走 §4.6 增量（只重渲改动过的乐句）。需要"和整轨重渲逐位一致"时用 full ——
     *   乐句单独渲染时引擎的起音/过渡与整轨渲染有细微差别（实测平均 0.22%，见计划书附录 W）。
     */
    async renderTrack(trackId?: string, opts?: { full?: boolean }): Promise<string> {
      const tr = trackId ? this.tracks.find(t => t.id === trackId) : this.activeTrack;
      if (!tr) return '没有可渲染的轨道';
      if (tr.kind === 'audio') return '音频轨不参与渲染（它在导出时混入）';
      if (!tr.singer) return '该轨道还没有选歌手';
      if (!tr.notes.length) return '该轨道没有音符';
      if (opts && opts.full) delete this._phraseCache[tr.id];
      this.busy = true;
      this.progress = 0;
      this.msg = '';
      const offProg = tr.engine === 'diffsinger' ? this._watchRenderProgress(0, 100) : () => {};
      try {
        return await this._renderOne(tr);
      } finally {
        offProg();
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
          const offProg = t.engine === 'diffsinger'
            ? this._watchRenderProgress((i - 1) / todo.length * 100, 100 / todo.length)
            : () => {};
          let err = '';
          try {
            err = await this._renderOne(t);
          } finally {
            offProg();
          }
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

    /**
     * 跨轨移动音符（M8h 跨轨拖动）：一条 `moves` 里可以混着**不同轨**的音符，
     * 每条按自己的轨写回 —— 于是"跨轨选中之后一起拖"是**一个撤销点**（撤销点由调用方负责）。
     * @returns 实际改动的条数
     */
    applyNoteMoves(moves: { trackId: string; noteId: string; startBeat?: number; pitch?: number; durBeat?: number }[]) {
      const seen = new Set<string>();
      let n = 0;
      for (const mv of moves || []) {
        if (!mv || !mv.trackId || !mv.noteId) continue;
        const key = mv.trackId + '|' + mv.noteId;
        if (seen.has(key)) continue;
        seen.add(key);
        const tr = this.tracks.find((t) => t.id === mv.trackId);
        const note = tr && tr.notes.find((x) => x.id === mv.noteId);
        if (!note) continue;
        if (mv.startBeat != null && Number.isFinite(mv.startBeat)) note.startBeat = Math.max(0, mv.startBeat);
        if (mv.durBeat != null && Number.isFinite(mv.durBeat)) note.durBeat = Math.max(0.0625, mv.durBeat);
        if (mv.pitch != null && Number.isFinite(mv.pitch)) note.pitch = Math.max(0, Math.min(127, Math.round(mv.pitch)));
        n += 1;
      }
      return n;
    },

    /**
     * 按**增量**移动若干音符，id 可以属于任意轨（键盘方向键 / 批量微调走这条）。
     * 与 applyNoteMoves 的分工：拖拽知道自己每条音符的原位（绝对写回），键盘只知道"往右一格"。
     */
    nudgeNotes(ids: string[], dBeat: number, dPitch: number) {
      let n = 0;
      for (const id of ids || []) {
        for (const tr of this.tracks) {
          const note = tr.notes.find((x) => x.id === id);
          if (!note) continue;
          note.startBeat = Math.max(0, note.startBeat + dBeat);
          note.pitch = Math.max(0, Math.min(127, Math.round(note.pitch + dPitch)));
          n += 1;
          break;
        }
      }
      return n;
    },

    /** 丢掉渲染结果（不传则全部清空）；乐句缓存与 A/B 的 A 也一起丢 */
    clearRender(trackId?: string) {
      if (trackId) {
        delete this.renderByTrack[trackId];
        delete this._phraseCache[trackId];
        delete this.renderPrevByTrack[trackId];
        return;
      }
      this.renderByTrack = {};
      this._phraseCache = {};
      this.renderPrevByTrack = {};
      for (const u of [this.renderUrlA, this.renderUrlB]) {
        if (u) { try { URL.revokeObjectURL(u); } catch (_) { /* 已失效 */ } }
      }
      this.renderUrlA = '';
      this.renderUrlB = '';
      this.abWhich = 'B';
    },

    /**
     * A/B 对比（§4.6）：在「上一版（A）」和「最新一版（B）」之间切声源。
     * 传输器监听 `renderUrl`，所以换 URL = 换声源，播放头不动，直接听差别。
     */
    toggleAB(which?: 'A' | 'B') {
      const want = which || (this.abWhich === 'A' ? 'B' : 'A');
      if (want === 'A' && !this.renderUrlA) return;
      if (want === 'B' && !this.renderUrlB) return;
      this.abWhich = want;
      this.renderUrl = want === 'A' ? this.renderUrlA : this.renderUrlB;
    },

    /**
     * 采纳 A：把上一版拿回来当当前结果（"还是上一版好听"时的退路）。
     * 乐句缓存随之作废 —— 它对应的是被换下去的那一版，不能再拿来复用。
     */
    adoptA(trackId?: string) {
      const id = trackId || this.activeTrackId;
      const prev = id ? this.renderPrevByTrack[id] : null;
      if (!id || !prev || !prev.length) return;
      const cur = this.renderByTrack[id];
      this.renderByTrack[id] = prev;
      if (cur && cur.length) this.renderPrevByTrack[id] = cur;
      else delete this.renderPrevByTrack[id];
      const ua = this.renderUrlA;
      this.renderUrlA = this.renderUrlB;
      this.renderUrlB = ua;
      this.renderUrl = this.abWhich === 'A' ? this.renderUrlA : this.renderUrlB;
      delete this._phraseCache[id];
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
          const prev = this.renderByTrack[trackId];
          this.renderByTrack[trackId] = bytes;
          // 记下"这一版是拿什么音符渲出来的"，之后改音符就能提示"渲染已过期"
          const t0 = this.tracks.find((x) => x.id === trackId);
          if (t0) t0.renderSig = noteSignature(t0.notes);
          /* ★ A/B 对比（§4.6）：把**上一版**留成 A。新开一条 URL 给 A ——
             紧接着 revoke 掉的是旧的 renderUrl（它指向的正是这一版旧音频），不会误伤。 */
          if (prev && prev.length) {
            this.renderPrevByTrack[trackId] = prev;
            if (this.renderUrlA) { try { URL.revokeObjectURL(this.renderUrlA); } catch (_) { /* 已失效 */ } }
            this.renderUrlA = URL.createObjectURL(new Blob([prev as any], { type: 'audio/wav' }));
          }
        }
        if (this.renderUrl) { try { URL.revokeObjectURL(this.renderUrl); } catch (_) { /* 已失效 */ } }
        this.renderUrl = URL.createObjectURL(
          new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/wav' }));
        this.renderUrlB = this.renderUrl;
        this.abWhich = 'B';
      }
      this.renderWarnings = r.warnings || [];
      this.lastDurationMs = r.duration_ms || 0;
      this.lastPipeline = r.pipeline || pipeline;
      return '';
    },

    /** 渲染一条 DiffSinger 轨。`outPath` 给了走直写模式（产物落盘、不回传字节） */
    async _renderDiffSinger(tr: SingTrack, outPath?: string): Promise<string> {
      if (!isDesktop || !bridge) return '网页端暂不支持 DiffSinger 渲染';
      // ★ 必须摊平成**普通对象**：notes / pitchCurve 来自 Pinia state，是响应式
      //   Proxy，结构化克隆对 Proxy 一律拒绝（抛 "An object could not be cloned"），
      //   请求根本到不了主进程。空数组也一样会抛。
      const notes = tr.notes.map(n => ({
        startBeat: n.startBeat, durBeat: n.durBeat, pitch: n.pitch,
        lyric: n.lyric, vibrato: !!n.vibrato, vibDepth: n.vibDepth,
        vibFreq: n.vibFreq, vibFade: n.vibFade || 0,
        vibIn: n.vibIn, vibOut: n.vibOut, vibShift: n.vibShift,
        vibDrift: n.vibDrift, vibVolLink: n.vibVolLink,
        phonemeOverrides: (n.phonemeOverrides || []).map(o => ({ ...o })),
        pitchOffset: n.pitchOffset || 0,
      }));
      const pitchCurve = (tr.pitchCurve || []).map(p => ({ beat: p.beat, cents: p.cents }));
      const r = await (bridge as any).diffsingerRender({
        voicebank: tr.singer,
        notes,
        bpm: this.bpm,
        // 多点变速（拍单位）：导入的 ustx 变速段在这里进渲染管线
        tempoMap: this.tempoMap.map(p => ({ beat: p.beat, bpm: p.bpm })),
        device: this.device || 'auto',
        pitchCurve,
        params: { language: tr.language, depth: tr.depth, steps: tr.steps },
        ...(outPath ? { outPath } : {}),
      });
      return this._acceptResult(r, 'DiffSinger', outPath ? undefined : tr.id);
    },

    /**
     * UTAU 的每音符 payload。**顺序与 `tr.notes` 一一对应** —— 乐句切分靠这个下标对齐
     * （splitPhrases 返回的 idx 就是这里的下标）。
     */
    _utauPayload(tr: SingTrack): any[] {
      // ★ 有子轨时由子轨说话：取音符**中点**的值，没有子轨才沿用音符自身参数。
      //   （只 UTAU 有 DYN/BRE/GEN —— DiffSinger 引擎没有对应的每音符输入，
      //    别假装生效，那只会变成"调了没反应"的坑。）
      const dyn = curveOf(tr, 'DYN');
      const bre = curveOf(tr, 'BRE');
      const gen = curveOf(tr, 'GEN');
      const vol = curveOf(tr, 'VOL');
      return tr.notes.map(n => {
        /* ★★ 两个引擎的默认值口径不同，所以**没设过的参数一律不发**，
              让引擎用它自己的原生默认值（legacy: velocity/volume=100、gender=50、breath=0；
              openutau: vol/vel/atk/dec 描述符默认 100、shft 0）。
           旧实现无条件发 `volume: n.volume ?? 0`、`gender: n.gender ?? 0` —— 那是把
           「界面里的 0」当成「用户要 0」，legacy 引擎会按 volume=0 直乘 → **整轨静音**，
           GENC=0 又会被按"最男声"渲染（它 0..100、50 才是不变）。 */
        const expressions: Record<string, number> = {};
        const raw: Record<string, any> = {
          startBeat: n.startBeat, durBeat: n.durBeat, pitch: n.pitch,
          // UTAU 的 wavtool 需要一个 alias；空歌词会让引擎取不到采样。
          // ★ 这里**不能**退回 sampleNote：那是音名（C4），不是别名。
          lyric: n.lyric || 'a',
          vibrato: !!n.vibrato, vibDepth: n.vibDepth, vibFreq: n.vibFreq,
          vibFade: n.vibFade || 0,
          // 颤音扩展参（上游 UVibrato 的 in/out/shift/drift/volLink）——引擎两侧都按这些键消费
          vibIn: n.vibIn, vibOut: n.vibOut, vibShift: n.vibShift,
          vibDrift: n.vibDrift, vibVolLink: n.vibVolLink,
          // 音素级时间微调（P2-2）：ms → 引擎按 tick 应用
          phonemeOverrides: (n.phonemeOverrides || []).map((o: any) => ({ ...o })),
        };

        /* 力度 / 音量 / 性别 / 气声：
           - 有对应自动化子轨（DYN/VOL/GEN/BRE）→ 按音符中点取值（自动化优先级最高）
           - 否则只在音符上**真设过**时才发；没设过就整个键不发 */
        const velocity = dyn ? valueForNote(dyn.points, n.startBeat, n.durBeat, 'DYN') : n.velocity;
        if (typeof velocity === 'number') { raw.velocity = velocity; expressions.vel = velocity; }
        const volume = vol ? valueForNote(vol.points, n.startBeat, n.durBeat, 'VOL') : n.volume;
        /* ★ volume=0 一律当成"没设"：0 是"乘 0"（静音），而界面里 0 只是"没调过"的占位。
           老工程里存着 volume:0 的音符因此也能正常出声。 */
        if (typeof volume === 'number' && volume > 0) { raw.volume = volume; expressions.vol = volume; }
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
    },

    /** 渲染上下文串：这些设置一变，所有乐句缓存作废（换歌手/换引擎/改 BPM 都不能复用旧音频） */
    _renderCtxKey(tr: SingTrack): string {
      return [
        'utau', tr.singer || '', String(this.bpm),
        normalizeSampleNote(this.sampleNote), tr.language || '',
        tr.resampler || '', tr.wavtool || '',
      ].join('|');
    },

    /**
     * UTAU 渲染 —— §4.6 **乐句级增量**。
     *
     * 只有指纹变了的乐句会重新下发（合成**一次**引擎调用），没变的直接用缓存拼回去；
     * 什么都没改时**一次引擎调用都不发**（引擎启动 ~0.6s 是这里的大头）。
     */
    async _renderUtau(tr: SingTrack, outPath?: string): Promise<string> {
      if (!isDesktop || !bridge) return '网页端暂不支持 UTAU 渲染';
      const t0 = performance.now();
      const notes = this._utauPayload(tr);
      const ctxKey = this._renderCtxKey(tr);
      const phrases = splitPhrases(tr.notes, PHRASE_GAP_BEATS);
      if (!phrases.length) return '该轨道没有音符';
      let entry = this._phraseCache[tr.id];
      if (!entry || entry.key !== ctxKey) {
        entry = { key: ctxKey, tailMs: 0, sr: 44100, totalMs: 0, phrases: [] };
        this._phraseCache[tr.id] = entry;
      }
      const cache: TrackPhraseCache = entry;
      const beatMs = 60000 / Math.max(1, this.bpm);
      const lastEndMs = phrases.reduce((mx, p) => Math.max(mx, p.endBeat * beatMs), 0);
      const sigs = phrases.map((p) => phraseSignature(p.idx.map((i) => notes[i]), ctxKey));
      const hits = phrases.map((p, i) => !!cache.phrases[i] && cache.phrases[i].hash === sigs[i]);
      const missIdx = phrases.map((p, i) => i).filter((i) => !hits[i]);
      let calls = 0, rendered = 0, warnings: string[] = this.renderWarnings;
      if (missIdx.length) {
        // 只下发**变了的**乐句。payload 带绝对拍位 → 返回的音频仍与整轨时间轴对齐，
        // 于是可以按各自的窗口切出来（窗口切点在静音中点，切了听不出来）。
        // 索引越界时宁可少送一个音符，也不要把 undefined 塞进 payload（引擎会解析失败）
        const missNotes = missIdx.flatMap((i) => (phrases[i]?.idx || []).map((k) => notes[k]).filter(Boolean));
        const r = await (bridge as any).utauRenderTrack({
          voicebank: tr.singer,
          notes: outPath ? notes : missNotes,
          ...(outPath ? { outPath } : {}),
          // 老工程里可能存着 'a'（当年当成别名用）→ 渲染前归一化成音名，否则整轨渲染直接报"无法解析音名"
          sampleNote: normalizeSampleNote(this.sampleNote),
          bpm: this.bpm,
          // 多点变速（拍单位）：导入的 ustx 变速段在这里进渲染管线
          tempoMap: this.tempoMap.map((p: any) => ({ beat: p.beat, bpm: p.bpm })),
          // 自动化子轨（连续曲线值进渲染）：只送 render 模式的曲线（DYN/BRE/GEN）；
          // 音高曲线（音分，相对音符音高的偏差）镜像成 PIT —— render_phrase 会对
          // 渲染音高做 pitches[i] += pitd.sample(...) 偏差应用。
          curves: (tr.curves || [])
            .filter((c: any) => ['DYN', 'BRE', 'GEN'].includes(c.abbr) && c.points.length)
            .map((c: any) => ({ abbr: c.abbr, points: c.points.map((p: any) => ({ beat: p.beat, value: p.value })) }))
            .concat((tr.pitchCurve || []).length
              ? [{ abbr: 'PIT', points: tr.pitchCurve.map((p: any) => ({ beat: p.beat, value: p.cents })) }]
              : []),
        });
        calls = 1;
        if (!r || !r.ok) return (r && r.error) || '渲染失败';
        if (outPath) return this._acceptResult(r, 'UTAU', undefined);
        warnings = r.warnings || [];
        const bytes = r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes || []);
        const wav = parseWav(bytes);
        cache.sr = wav.sr || 44100;
        if (missIdx.length === phrases.length) {
          // 整轨都在这一次里 → 顺便重新量"尾音"（引擎给的时长 - 最后一个音符结束）
          const dur = Number(r.duration_ms) || (wav.frames / wav.sr) * 1000;
          cache.tailMs = Math.max(0, dur - lastEndMs);
        }
        cache.totalMs = Math.max(1, lastEndMs + cache.tailMs + 120);
        const wins = phraseWindows(phrases, this.bpm, cache.totalMs);
        for (const i of missIdx) {
          const win = wins[i];
          const sig = sigs[i];
          if (!win || !sig) continue;             // 窗口/签名算不出来（乐句表与索引不同步）→ 跳过这一句
          const w = sliceSegment(wav, win.startMs, win.endMs);
          cache.phrases[i] = { hash: sig, startMs: w.startMs, endMs: w.endMs, bytes: w.bytes };
          rendered += 1;
        }
        // 命中的句子：字节可复用，窗口照新的写（窗口只有在邻居变了时才会动，那时邻居也在 miss 里）
        for (let i = 0; i < phrases.length; i++) {
          const cp = cache.phrases[i];
          const win = wins[i];
          if (hits[i] && cp && win) {
            cp.startMs = win.startMs;
            cp.endMs = win.endMs;
          }
        }
      }
      const totalMs = cache.totalMs || Math.max(1, lastEndMs + cache.tailMs + 120);
      const mixed = composeSegments(cache.phrases, totalMs, cache.sr);
      this._phraseStats = {
        trackId: tr.id, phrases: phrases.length,
        reused: phrases.length - missIdx.length, rendered, calls,
        ms: Math.round(performance.now() - t0),
      };
      return this._acceptResult(
        { ok: true, bytes: mixed, duration_ms: totalMs, pipeline: 'UTAU', warnings },
        'UTAU', tr.id,
      );
    },
  },
});
