// ============================================================
// FuFumidi 类型化 IPC 契约
// 前端 / preload / 主进程共享的请求响应类型
// ============================================================

export type EngineMode = 'universal' | 'piano' | 'separate';
export type PerfMode = 'quality' | 'balanced' | 'fast';
export type GpuKind = 'cuda' | 'directml' | 'rocm';

export interface ConvertRequest {
  audio: string;
  out?: string | null;
  id?: string | number;
  mode?: EngineMode;
  perf?: PerfMode;
  onset_threshold?: number;
  frame_threshold?: number;
  min_note_length?: number;
  min_note_ms?: number;
  merge_gap_ms?: number;
  no_pedal?: boolean;
  include_pedal?: boolean;
  with_drums?: boolean;
  export_stems?: boolean;
  stem_format?: 'wav' | 'flac' | 'm4a';
  denoise?: boolean;
  normalize?: boolean;
  auto_bpm?: boolean;
}

export interface ConvertResult {
  ok: boolean;
  out?: string;
  note_count?: number;
  error?: string;
  code?: number | string;
  canceled?: boolean;
}

export interface RefineRequest {
  id?: string | number;
  audio: string;
  midi: string;
  mode?: 'auto' | 'piano' | 'vocal';
  stemBalance?: boolean;
}

export interface RefineStats {
  onset_moved?: number;
  offset_moved?: number;
  pitch_fixed?: number;
  micro_removed?: number;
  lead_track?: string;
  vel_balanced?: number;
  notes_out?: number;
  elapsed_s?: number;
}

export interface RefineResult {
  ok: boolean;
  out?: string;
  stats?: RefineStats;
  error?: string;
}

export interface GpuInfo {
  available?: boolean;
  backend?: string;
  name?: string;
  vendor?: 'nvidia' | 'amd' | 'intel' | 'unknown';
  cuda?: boolean;
  mps?: boolean;
  directml?: boolean;
  torch_directml?: boolean;
  /** AMD ROCm 加速已启用（torch.version.hip 非空） */
  rocm?: boolean;
  /** ROCm HIP 版本，如 '7.2.26024-f6f897bd3d' */
  hip_version?: string | null;
  note?: string;
}

export interface EngineProbeResult {
  ok?: boolean;
  version?: string;
  python?: string;
  python_path?: string;
  engines?: Record<string, boolean>;
  libs?: Record<string, boolean>;
  gpu?: GpuInfo;
  perf?: { recommended?: PerfMode };
  error?: string;
  raw?: string;
}

export interface GpuPackageFile {
  name: string;
  url: string;
  size?: number;
}

export interface GpuPackage {
  tag: string;
  name: string;
  url: string;
  size?: number;
  kind: GpuKind;
  split?: boolean;
  files?: GpuPackageFile[];
  /** 该包要求的 CPython 次版本（'3.11' / '3.12'），ROCm 为 '3.12' */
  requiresPython?: string | null;
}

export interface GpuStatusResult {
  ok: boolean;
  directml?: boolean;
  cuda?: boolean;
  rocm?: boolean;
  /** 对应 kind 是否与当前解释器 ABI 匹配（装了但不匹配 = 已安装未启用） */
  cudaActive?: boolean;
  directmlActive?: boolean;
  rocmActive?: boolean;
  /** 装了 rocm 但当前不是 3.12（需切换到 3.12 运行时才生效） */
  needsPython312?: boolean;
  /** 是否存在就绪的 Python 3.12 引擎运行时 */
  canPython312?: boolean;
  currentPython?: string;
  kinds?: GpuKind[];
  isolated?: boolean;
  paths?: string[];
  error?: string;
}

export interface GpuDownloadOptions {
  url?: string;
  name?: string;
  kind?: GpuKind;
  size?: number;
  files?: GpuPackageFile[];
}

export interface GeneralResult {
  ok: boolean;
  error?: string;
  path?: string;
  canceled?: boolean;
  kind?: GpuKind;
  split?: boolean;
  removed?: boolean;
  restored?: boolean;
  /** 该增强包要求的 CPython 次版本 */
  requiresPython?: string | null;
  /** 安装后是否已生效（版本不匹配时为 false = 已安装未启用） */
  active?: boolean;
}

export interface PresetItem {
  name: string;
  mode?: EngineMode;
  params?: Record<string, any>;
}

export interface PresetListResult {
  ok: boolean;
  presets?: Record<string, PresetItem>;
  builtins?: string[];
  error?: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  version?: string;
  description?: string;
  enabled: boolean;
}

export interface UpdateAsset {
  name: string;
  url: string;
  size: number;
}

export interface UpdateRelease {
  tag: string;
  name?: string;
  assets: UpdateAsset[];
  body?: string;
}

export interface Settings {
  theme?: string;
  accent?: string;
  ui_mode?: 'light' | 'dark';
  font_size?: string;
  density?: string;
  perf_mode?: PerfMode;
  engine_path?: string;
  engine_mode?: EngineMode;
  output_dir?: string;
  guide_done?: boolean;
  advanced_mode?: boolean;
  custom_wallpaper?: string;
  wallpaper_enabled?: boolean;
  watch_dir?: string;
  watch_enabled?: boolean;
  file_assoc?: boolean;
  lang?: 'zh' | 'zh-Hant' | 'en' | '';
  [key: string]: any;
}

export interface IntegrityResult {
  ok: boolean;
  issues?: any[];
  error?: string;
}

export interface SoundFontItem {
  name?: string;
  path?: string;
  size?: number;
}

export interface WallpaperItem {
  name: string;
  video: string;
  thumb?: string;
  local?: boolean;
}

export interface WallpaperListResult {
  ok: boolean;
  list?: WallpaperItem[];
  error?: string;
}

export interface WallpaperDownloadResult {
  ok: boolean;
  path?: string;
  name?: string;
  error?: string;
}

export interface RustStatusResult {
  ok?: boolean;
  available: boolean;
  binary?: string | null;
  version?: string;
}

/** 数据目录中的单个功能区（模型 / GPU 增强包 / 音色库 / 声库 / 曲库文件 / 缓存 / 中间产物） */
export interface DataRootEntry {
  key: string;
  label: string;
  dir: string;
  exists: boolean;
  /** 旧版落点（迁移尚未完成时非空） */
  legacyDir?: string | null;
  /** true = 旧位置仍有数据、尚未迁移到数据根目录 */
  pending?: boolean;
  /** true = 数据目录里已有同名内容，为避免覆盖已跳过迁移（当前沿用旧位置） */
  conflict?: boolean;
  /** true = 体积统计超出预算（只统计了一部分） */
  sizePartial?: boolean;
  size: number;
}

/** 声库资源中心条目（utau:voicebankRegistry） */
export interface VoicebankEntry {
  id: string;
  name: string;
  author: string;
  /** 语言与录音方式（単独音 / 擴張整音 等） */
  lang: string;
  desc: string;
  /** 使用条款摘要（原样展示，由使用者自行遵守） */
  license: string;
  /** 上游仓库 / 官方页 */
  repo: string;
  officialUrl: string;
  installed: boolean;
  /** 安装目标目录 */
  dir: string;
  /** 已安装时的实际占用字节数 */
  size: number;
}

/** 声库下载/解包进度（utau:voicebankProgress） */
export interface VoicebankProgress {
  id: string;
  phase?: 'download' | 'extract' | 'done' | 'error';
  received?: number;
  total?: number;
  percent: number;
  done: boolean;
  error?: string;
}

/* ---------------- DiffSinger 模块化集成 ---------------- */

/** DiffSinger 推理后端（GPU）信息（diffsinger:status.gpu） */
export interface DiffsingerGpuInfo {
  /** 请求的设备：auto / cpu / cuda / dml */
  device: string;
  /** onnxruntime 当前可用的全部 provider */
  providers: string[];
  /** 实际生效的 provider（如 CUDAExecutionProvider） */
  active: string;
  onnxruntime?: string;
  /** GPU 增强包被禁用（未安装或 FUFUMIDI_DISABLE_GPU=1） */
  disabled?: boolean;
  note?: string;
}

/** DiffSinger 组件安装状态（diffsinger:status） */
export interface DiffsingerStatus {
  ok: boolean;
  enabled: boolean;
  deps: {
    installed: string[];
    missing: string[];
    ok: boolean;
    error?: string;
    /** 模块未启用时的占位标记 */
    skipped?: boolean;
  };
  /** 推理后端信息（GPU 加速状态） */
  gpu?: DiffsingerGpuInfo | null;
  vocoder: {
    installed: boolean;
    dir: string;
    runtime?: Record<string, any>;
  };
  voicebankDir: string;
  voicebankCount: number;
  /** 启用 + 依赖 + 声码器 三者齐备，可渲染 */
  ready: boolean;
  error?: string;
}

/** DiffSinger 公开声库条目（diffsinger:voicebankRegistry） */
export interface DiffsingerVoicebankEntry {
  id: string;
  name: string;
  author: string;
  lang: string;
  desc: string;
  license: string;
  officialUrl: string;
  installed: boolean;
  dir: string;
  size: number;
}

/** 组件安装进度（diffsinger:runtimeProgress） */
export interface DiffsingerRuntimeProgress {
  phase?: 'deps' | 'vocoder' | 'error';
  percent: number;
  text?: string;
  received?: number;
  total?: number;
  done?: boolean;
}

/** 声库下载进度（diffsinger:voicebankProgress） */
export interface DiffsingerVoicebankProgress {
  id: string;
  phase?: 'download' | 'extract' | 'done' | 'error';
  received?: number;
  total?: number;
  percent: number;
  done: boolean;
  error?: string;
}

/** ModelScope 声库目录条目（diffsinger:msCatalog） */
export interface DiffsingerMsModel {
  name: string;
  work: string;
  workId: string;
  category: string;
  desc: string;
  /** 上游仓库内相对路径，同时作为唯一定位键 */
  path: string;
  size: number;
  /** true = 上游仅占位文件，尚无真实权重 */
  placeholder: boolean;
  /** 直连 ModelScope 官方地址（全球同源） */
  url: string;
  installed: boolean;
}

export interface DiffsingerMsCategory {
  source: string;
  label: string;
  desc: string;
  models: DiffsingerMsModel[];
}

export interface DiffsingerMsWork {
  id: string;
  label: string;
  source: string;
  categories: DiffsingerMsCategory[];
}

/** ModelScope 声库目录概览（diffsinger:msCatalog） */
export interface DiffsingerMsCatalog {
  ok: boolean;
  repo?: { owner: string; name: string; revision: string };
  repoUrl?: string;
  author?: string;
  license?: string;
  stats?: {
    total: number;
    available: number;
    placeholder: number;
    works: { id: string; label: string; source: string; models: number; categories: number }[];
  };
  works?: DiffsingerMsWork[];
  dir?: string;
  error?: string;
}

/** ModelScope 声库下载进度（diffsinger:msProgress） */
export interface DiffsingerMsProgress {
  id: string;
  phase?: 'download' | 'extract' | 'done' | 'error';
  received?: number;
  total?: number;
  percent: number;
  done: boolean;
  error?: string;
  host?: string;
}

/** 歌词输入建议的一条候选（diffsinger:suggestLyric） */
export interface DiffsingerLyricSuggestion {
  /** 候选文本（音素 / 音节 / 声母 / 韵母），点选后直接写进歌词 */
  text: string;
  /** 候选类型，供 UI 分组与着色 */
  kind: 'phoneme' | 'syllable' | 'initial' | 'final' | 'term' | 'alias';
  /** 排序分数（越大越靠前） */
  score: number;
  /** 人类可读的来源说明 */
  note?: string;
}

/** 歌词输入建议结果（diffsinger:suggestLyric） */
export interface DiffsingerSuggestResult {
  ok: boolean;
  text?: string;
  /** ★ 轨道级语言（zh/ja/ko/en），不从歌词自动判断 */
  language?: string;
  items?: DiffsingerLyricSuggestion[];
  error?: string;
}

/** 声库 inspect 结果（diffsinger:inspectVoicebank） */
export interface DiffsingerVoicebankInfo {
  ok: boolean;
  name?: string;
  version?: string;
  languages?: string[];
  phonemeCount?: number;
  phonemes?: string[];
  hasAcoustic?: boolean;
  hasVariance?: boolean;
  /** 声码器 onnx 文件名 */
  vocoder?: string;
  /** 声库自带 dsvocoder/（否则用通用组件位） */
  builtinVocoder?: boolean;
  /** 实际加载的那份词典的词条数（dsdict-<lang>.yaml 的 entries 条数） */
  dictionaryWords?: number;
  /** 实际加载的词典文件名，如 `dsdict-zh.yaml` */
  dictionaryFile?: string;
  sampleRate?: number;
  hopSize?: number;
  /** 声库是否自带 dsdur/（缺了就不是可用的 DiffSinger 声库） */
  hasDur?: boolean;
  /** 是否有 dspitch/（仅编辑功能用，渲染不需要） */
  hasPitchPredictor?: boolean;
  error?: string;
}

/** 调教音符（DiffSinger）：与 UTAU 同款拍制坐标 */
export interface DiffsingerNote {
  startBeat: number;
  durBeat: number;
  pitch: number;
  lyric: string;
  vibrato?: boolean;
  vibDepth?: number;
  vibFreq?: number;
  vibFade?: number;
  pitchOffset?: number;
}

/** 渲染选区（diffsinger:render.range） */
export interface DiffsingerRenderRange {
  /** 选区起点（秒，绝对时间） */
  startSec: number;
  /** 选区终点（秒，绝对时间） */
  endSec: number;
  /** 实际推理起点（含前置上下文，秒） */
  originSec: number;
  /** 前置上下文时长（秒） */
  contextBefore?: number;
  /** 后置上下文时长（秒） */
  contextAfter?: number;
  /** 选区内命中的音符数 */
  selectedNoteCount?: number;
}

/** 渲染请求的选区参数 */
export interface DiffsingerRenderSelection {
  /** true 或省略起止拍位时渲染整曲 */
  full?: boolean;
  /** 选区起始拍 */
  startBeat?: number;
  /** 选区结束拍 */
  endBeat?: number;
  /** 选区前后保留的上下文秒数（默认 0.5，0 表示不留） */
  contextSec?: number;
}

/** DiffSinger 渲染结果（diffsinger:render） */
export interface DiffsingerRenderResult {
  ok: boolean;
  out?: string;
  bytes?: Uint8Array;
  duration_ms?: number;
  warnings?: string[];
  engineVersion?: string;
  /**
   * 实际使用的推理链路：
   * - `upstream` —— 与上游 OpenUtau 对齐（dsdur 时长模型在音素化阶段，
   *   渲染只用 acoustic + vocoder；`dspitch` 不参与渲染）
   * - `classic` —— 旧的自造五段式/简化链路，已废弃
   */
  pipeline?: string;
  /** 实际生效的推理后端 */
  device?: { provider: string; requested: string } | null;
  /** 范围渲染时的选区元信息（整曲渲染为 null） */
  range?: DiffsingerRenderRange | null;
  error?: string;
}

/** 数据目录概览（system:dataRoot） */
export interface DataRootOverview {
  ok: boolean;
  root?: string;
  reason?: string;
  installRoot?: string;
  legacyBase?: string;
  configured?: string;
  entries?: DataRootEntry[];
  migration?: { moved: string[]; failed: { name: string; error: string }[]; at: string } | null;
  error?: string;
}

export interface DbStatusResult {
  ok?: boolean;
  mode: 'none' | 'json' | 'sqlite' | string;
  dbPath?: string;
  jsonPath?: string;
}

export interface DbSongItem {
  id: string;
  name?: string;
  [key: string]: any;
}

export interface RustInvokeResult {
  ok: boolean;
  version?: string;
  service?: string;
  error?: string;
  raw?: string;
  stderr?: string;
}

/**
 * 由 preload 注入到 renderer 的完整桥接口。
 * 后续 preload 端应严格按此类型实现。
 */
/** 待打包进 `files/` 的资产（主进程按 `srcPath` 自己读盘，字节不过 IPC） */
export interface ProjectAssetSource {
  id: string;
  srcPath: string;
  fileName: string;
}

export interface ProjectSaveRequest {
  /** `serializeProject()` 产出的清单 */
  json: any;
  assets?: ProjectAssetSource[];
  /** 给了就直接覆盖写（"保存"），不给就弹"另存为"对话框 */
  filePath?: string;
  suggestName?: string;
}

export interface ProjectSaveResult {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  filePath?: string;
  /** 源文件读不到的资产名 —— 保存仍然成功，但伴奏不会被打包进去 */
  missing?: string[];
}

export interface ProjectOpenResult {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  filePath?: string;
  /** 包里的 `project.json`（由前端 `parseProject()` 校验后再用） */
  json?: any;
  /** assetId → 解包后的本地路径 */
  resolved?: Record<string, string>;
  cacheDir?: string;
}

/** `.ustx` 导入结果（engine/engine_ustx.py 的 import 方向） */
export interface UstxImportResult {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  /** 源 .ustx 路径（仅提示用；导入后 projectPath 置空，保存走另存为） */
  filePath?: string;
  /** 交换 JSON（project.json 形态，含 tempoMap/sigMap/keySf） */
  json?: any;
  /** assetId → 伴奏源文件的本地路径（运行时回填，不进工程包） */
  resolved?: Record<string, string>;
  /** 引擎侧的有损转换提示（音素级参数未转、多片段已合并等） */
  warnings?: string[];
}

/** `.ustx` 导出请求 */
export interface UstxExportRequest {
  /** `serializeProject()` 产出的清单（含 tempoMap/sigMap/keySf） */
  json: any;
  /** 音频轨源文件（主进程自己读盘拷到 `<名>_assets/`，字节不过 IPC） */
  audioFiles?: ProjectAssetSource[];
  suggestName?: string;
}

export interface UstxExportResult {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  filePath?: string;
  /** 引擎侧提示（伴奏缺失/复制失败等） */
  warnings?: string[];
}

export interface FuBridge {
  onOpenFile(cb: (bytes: Uint8Array, name: string) => void): () => void;

  // engine
  convert(cfg: ConvertRequest): Promise<ConvertResult>;
  cancel(id: string | number): Promise<GeneralResult>;
  onEngineLog(cb: (p: any) => void): () => void;
  probe(): Promise<EngineProbeResult>;
  refine(cfg: RefineRequest): Promise<RefineResult>;
  onRefineLog(cb: (p: any) => void): () => void;

  // settings
  getSettings(): Promise<Settings>;
  saveSettings(s: Partial<Settings>): Promise<GeneralResult>;
  fileAssoc(enabled: boolean): Promise<GeneralResult>;

  // integrity
  checkIntegrity(): Promise<IntegrityResult>;
  repairIntegrity(ids: string[]): Promise<GeneralResult>;

  // dialogs / files
  pickAudio(): Promise<string | null>;
  pickAudioFiles(): Promise<string[] | null>;
  listAudioFiles(dir: string): Promise<string[]>;
  pickImage(): Promise<string | null>;
  pickFile(opts: any): Promise<string | null>;
  pickDirectory(): Promise<string | null>;
  readSoundFont(p: string): Promise<Uint8Array | null>;
  soundfonts: { list(): Promise<SoundFontItem[]> };
  pickMusicXML(): Promise<string | null>;
  exportScorePdf(): Promise<GeneralResult>;
  transcodeVideo(data: any, audio: any): Promise<GeneralResult>;
  modelList(): Promise<any[]>;
  depCheck(): Promise<GeneralResult>;
  diagExport(): Promise<GeneralResult>;
  exportScorePngZip(opts: any): Promise<GeneralResult>;
  listMidiFiles(dir: string): Promise<string[]>;
  readBinary(p: string): Promise<Uint8Array | null>;
  saveBinary(opts: { name: string; data: any }): Promise<GeneralResult>;
  openOutput(p: string): Promise<GeneralResult>;
  utauExportVoicebank(opts: { dir: string; files: { name: string; data: string }[] }): Promise<GeneralResult>;
  utauExportVoicebankZip(opts: { files: { name: string; data: string }[] }): Promise<GeneralResult & { canceled?: boolean; path?: string; count?: number }>;
  utauRenderTrack(cfg: { voicebank: string; notes: any[]; sampleNote: string; bpm?: number }): Promise<GeneralResult & { out?: string; bytes?: Uint8Array | number[]; duration_ms?: number; warnings?: string[]; engineVersion?: string }>;
  utauAliases(cfg: { voicebank: string; query?: string; limit?: number }): Promise<{ ok: boolean; aliases?: string[]; count?: number; total?: number; error?: string }>;
  utauFlags(): Promise<{ ok: boolean; engine_version?: string; supported?: { flag: string; default: number | null; min: number | null; max: number | null; desc: string }[]; unsupported?: { flag: string; desc: string }[]; example?: string; error?: string }>;
  utauListVoicebanks(): Promise<{ ok: boolean; list?: { name: string; dir: string }[]; error?: string }>;
  utauImportVoicebankZip(): Promise<{ ok: boolean; canceled?: boolean; name?: string; dir?: string; error?: string }>;
  /** 声库资源中心：可一键安装的开源/免费声库条目 */
  utauVoicebankRegistry(): Promise<{ ok: boolean; dir?: string; list?: VoicebankEntry[]; error?: string }>;
  utauDownloadVoicebank(id: string): Promise<{ ok: boolean; canceled?: boolean; existed?: boolean; name?: string; dir?: string; files?: number; size?: number; error?: string }>;
  utauCancelVoicebankDownload(id: string): Promise<GeneralResult>;
  onVoicebankProgress(cb: (p: VoicebankProgress) => void): () => void;

  // DiffSinger 模块化集成（未启用模块时 status 返回 enabled=false，组件零下载）
  // opts.force：跳过主进程 30s 依赖缓存强制重探（GPU 增强包安装/卸载后调用）
  diffsingerStatus(opts?: { force?: boolean }): Promise<DiffsingerStatus>;
  diffsingerSetEnabled(on: boolean): Promise<GeneralResult & { enabled?: boolean }>;
  diffsingerInstallRuntime(): Promise<GeneralResult>;
  diffsingerCancelRuntimeInstall(): Promise<GeneralResult>;
  diffsingerUninstallRuntime(opts?: { alsoVoicebanks?: boolean }): Promise<GeneralResult>;
  diffsingerListVoicebanks(): Promise<{ ok: boolean; list?: { name: string; dir: string; size?: number }[]; error?: string }>;
  diffsingerImportVoicebankZip(directPath?: string): Promise<GeneralResult & { canceled?: boolean; kind?: 'voicebank' | 'vocoder'; name?: string; dir?: string; size?: number }>;
  diffsingerDeleteVoicebank(dir: string): Promise<GeneralResult>;
  diffsingerVoicebankRegistry(): Promise<{ ok: boolean; dir?: string; list?: DiffsingerVoicebankEntry[]; error?: string }>;
  diffsingerDownloadVoicebank(id: string): Promise<GeneralResult & { canceled?: boolean; existed?: boolean; name?: string; dir?: string; size?: number }>;
  diffsingerCancelVoicebankDownload(id: string): Promise<GeneralResult>;
  diffsingerMsCatalog(): Promise<DiffsingerMsCatalog>;
  diffsingerMsDownload(cfg: { name: string; path: string }): Promise<GeneralResult & { canceled?: boolean; name?: string; dir?: string; size?: number; source?: string }>;
  diffsingerMsCancelDownload(name: string): Promise<GeneralResult>;
  diffsingerInspectVoicebank(cfg: { voicebank: string }): Promise<DiffsingerVoicebankInfo>;
  /** 歌词输入建议。`language` 为**轨道级**语言设置，不从歌词自动判断。 */
  diffsingerSuggestLyric(cfg: { text: string; language?: string; voicebank?: string; limit?: number }): Promise<DiffsingerSuggestResult>;
  diffsingerRender(cfg: {
    voicebank: string;
    notes: DiffsingerNote[];
    bpm?: number;
    /** 选区渲染参数；省略或 full=true 时渲染整曲 */
    range?: DiffsingerRenderSelection | null;
    /** 推理后端：auto（默认，GPU 优先）/ cpu / cuda / dml */
    device?: string;
    /**
     * ★ 轨道级渲染参数。
     * - `language`：**歌手语言**（zh/ja/ko/en），决定用哪套词典与音素表
     *   （照搬上游 `USingerTrack.Language`，**不从歌词自动判断**）
     * - `depth` / `steps`：DiffSinger 采样参数，进缓存文件名故不进 hash
     */
    params?: { language?: string; depth?: number; steps?: number };
    /**
     * P3 音高曲线：[{beat, cents}]，beat 为绝对拍位，cents 为音分偏移。
     * 必须传**纯对象数组**：store 里的响应式数组是 Proxy，
     * 结构化克隆无法处理，会抛 "An object could not be cloned"。
     */
    pitchCurve?: { beat: number; cents: number }[];
  }): Promise<DiffsingerRenderResult>;
  onDiffsingerRuntimeProgress(cb: (p: DiffsingerRuntimeProgress) => void): () => void;
  onDiffsingerVoicebankProgress(cb: (p: DiffsingerVoicebankProgress) => void): () => void;
  onDiffsingerMsProgress(cb: (p: DiffsingerMsProgress) => void): () => void;
  onDiffsingerRenderProgress(cb: (p: { percent?: number; text?: string }) => void): () => void;
  pickZip(): Promise<string[] | null>;

  // gpu
  gpuInstallAuto(): Promise<GeneralResult>;
  gpuPackageUrl(kind: GpuKind): Promise<GeneralResult & { url?: string; name?: string; size?: number }>;
  gpuListPackages(): Promise<GeneralResult & { packages?: GpuPackage[] }>;
  gpuImportLocal(p: string | string[], kind: GpuKind): Promise<GeneralResult>;
  gpuStatus(): Promise<GpuStatusResult>;
  gpuUninstall(kind: GpuKind): Promise<GeneralResult>;
  gpuCancelInstall(): Promise<GeneralResult>;
  gpuDownloadPackage(opts: GpuDownloadOptions): Promise<GeneralResult>;
  onGpuProgress(cb: (p: any) => void): () => void;

  // updates
  updateCheck(): Promise<any>;
  getVersion(): Promise<string>;
  appUninstall(): Promise<GeneralResult>;
  autostartGet(): Promise<{ ok: boolean; openAtLogin: boolean; error?: string }>;
  autostartSet(open: boolean): Promise<{ ok: boolean; openAtLogin: boolean; error?: string }>;
  clearUserData(scopes: string[]): Promise<{ ok: boolean; done?: string[]; needRestart?: boolean; error?: string }>;
  /** 数据目录概览：依赖 / 环境 / 模型 / 缓存的统一落点 */
  dataRoot(): Promise<DataRootOverview>;
  openDataRoot(sub?: string): Promise<{ ok: boolean; dir?: string; error?: string }>;
  cleanTemp(): Promise<{ ok: boolean; freed?: number; dir?: string; error?: string }>;
  /** 曲库文件：每个 MIDI 曲目对应的真实 .mid 文件 */
  writeMidi(opts: { name: string; bytes: Uint8Array | number[]; path?: string }): Promise<{ ok: boolean; path?: string; existed?: boolean; error?: string }>;
  hasMidi(p: string): Promise<{ ok: boolean; exists: boolean; size?: number }>;
  checkMidi(items: { id: string; name: string; path?: string }[]): Promise<{ ok: boolean; missing: { id: string; name: string }[]; root?: string }>;
  deleteMidi(p: string): Promise<{ ok: boolean; deleted?: boolean; error?: string }>;
  revealMidi(p: string): Promise<{ ok: boolean; path?: string; fellBackToDir?: boolean; error?: string }>;
  midiStats(): Promise<{ ok: boolean; dir?: string; count: number; bytes: number; error?: string }>;
  /** 曲库文件体检（Rust 核心 batch-stats，回退 JS） */
  verifyMidi(): Promise<{
    ok: boolean; engine: 'rust' | 'js'; dir?: string; count: number; badCount: number;
    totalNotes: number; totalBytes: number;
    files: { file: string; ok: boolean; error?: string; tracks?: number; notes?: number; bpm?: number; size?: number }[];
    bad: { file: string; ok: boolean; error?: string }[];
    error?: string;
  }>;
  /** 重复曲库文件检测（Rust 核心 hash-batch，回退 JS） */
  dupeMidi(): Promise<{
    ok: boolean; engine: 'rust' | 'js'; dir?: string; count: number;
    dupeGroups: number; dupeFiles: number;
    groups: { file: string; size: number }[][];
    error?: string;
  }>;
  onTrayControl(cb: (act: string) => void): () => void;
  readSidecarLyrics(filePath: string): Promise<{ ok: boolean; path?: string; b64?: string; bytes?: number; error?: string }>;
  updateDownload(url: string): Promise<any>;
  updateOpen(p: string): Promise<any>;
  onUpdateProgress(cb: (p: any) => void): () => void;
  update: {
    list(): Promise<UpdateRelease[]>;
    openExternal(url: string): Promise<GeneralResult>;
    launchUpdater(version?: string): Promise<GeneralResult>;
  };

  // models / deps / folders
  depInstall(group: string): Promise<GeneralResult>;
  modelDownload(id: string): Promise<GeneralResult>;
  modelCancel(id: string): Promise<GeneralResult>;
  modelPause(id: string): Promise<GeneralResult>;
  modelDelete(id: string): Promise<GeneralResult>;
  setFolderWatch(dir: string, enabled: boolean): Promise<GeneralResult>;
  onFolderWatch(cb: (p: any) => void): () => void;
  onModelProgress(cb: (p: any) => void): () => void;

  // presets
  presets: {
    list(): Promise<PresetListResult>;
    save(name: string, mode: EngineMode, params: any): Promise<GeneralResult>;
    delete(name: string): Promise<GeneralResult>;
    lastUsed(name: string): Promise<GeneralResult>;
    reorder(name: string, delta: number): Promise<GeneralResult>;
    reorderTo(name: string, index: number): Promise<GeneralResult>;
    restore(): Promise<GeneralResult>;
  };

  // plugins
  plugins: {
    list(): Promise<PluginInfo[]>;
    setEnabled(id: string, enabled: boolean): Promise<GeneralResult>;
    invoke(id: string, cmd: string, payload: any): Promise<any>;
    rescan(): Promise<PluginInfo[]>;
    openDocs(): Promise<void>;
    openDir(): Promise<void>;
    onUi(cb: (p: any) => void): () => void;
    onLog(cb: (p: any) => void): () => void;
    onScript(cb: (p: any) => void): () => void;
  };

  // dynamic wallpaper
  wallpaper: {
    defaults(): Promise<{ ok: boolean; files: string[] }>;
    list(): Promise<WallpaperListResult>;
    download(url: string, name: string): Promise<WallpaperDownloadResult>;
    addLocal(path: string): Promise<WallpaperDownloadResult>;
    onAddLocalProgress(cb: (p: { progress: number; path?: string }) => void): () => void;
    removeLocal(name: string): Promise<{ ok: boolean; error?: string }>;
  };

  // optional rust core
  rustStatus(): Promise<RustStatusResult>;
  rustInvoke(cmd: string, args?: string[]): Promise<RustInvokeResult>;

  // sqlite persistence service
  dbStatus(): Promise<DbStatusResult>;
  dbKvGet(key: string): Promise<any>;
  dbKvSet(key: string, value: any): Promise<boolean>;
  dbSongsList(): Promise<DbSongItem[]>;
  dbSongsPut(item: DbSongItem): Promise<boolean>;
  dbSongsDelete(id: string): Promise<boolean>;
  dbPlaylistsList(): Promise<any[]>;
  dbPlaylistsPut(item: any): Promise<boolean>;
  dbPlaylistsDelete(id: string): Promise<boolean>;
  /** 云同步：把下发的曲目落盘到独立目录（<userData>/fufumidi/cloud-songs） */
  dbCloudSongPut(name: string, bytes: number[] | Uint8Array): Promise<boolean>;
  dbCloudSongDir(): Promise<string>;

  // app events
  notify(ev: string, payload: any): void;
  openEditGuide(): Promise<GeneralResult>;

  /** 歌声工程文件（`.fufumidi` 自包含包） */
  project: {
    save(payload: ProjectSaveRequest): Promise<ProjectSaveResult>;
    open(): Promise<ProjectOpenResult>;
    /** 导入 OpenUtau `.ustx`（引擎转换为 project.json 形态） */
    importUstx(): Promise<UstxImportResult>;
    /** 导出 OpenUtau `.ustx`（伴奏由主进程读盘拷贝，字节不过 IPC） */
    exportUstx(payload: UstxExportRequest): Promise<UstxExportResult>;
    /** 分轨导出：伴奏源文件主进程直拷（字节不过 IPC） */
    copyAsset(payload: { src: string; dest: string }): Promise<{ ok: boolean; savedTo?: string; error?: string }>;
  };
}
