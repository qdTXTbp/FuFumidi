// ============================================================
// FuFumidi 类型化 IPC 契约
// 前端 / preload / 主进程共享的请求响应类型
// ============================================================

export type EngineMode = 'universal' | 'piano' | 'separate';
export type PerfMode = 'quality' | 'balanced' | 'fast';
export type GpuKind = 'cuda' | 'rocm' | 'xpu';   // DirectML 增强包已下线（2026-10-17）

export interface ConvertRequest {
  /** MuScriptor 乐器组约束：'auto' 或不约束为空；否则是组名列表（如 'voice,drums'，硬约束） */
  muscriptor_instruments?: string;
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

/** 体检里的一条结论（level 决定图标与配色） */
export interface DiagVerdict { level: 'ok' | 'warn' | 'error' | 'info'; group: string; msg: string }
/** 全局体检报告 */
export interface DiagHealthReport {
  time: string;
  app_version?: string;
  verdicts: DiagVerdict[];
  system: Record<string, unknown>;
  gpu: Record<string, unknown>;
  compute_check: Record<string, unknown>;
  runtime: Record<string, unknown>;
  models: Record<string, unknown>;
  recent_errors: { file: string; line: string }[];
  /** 已脱敏、可直接粘贴进 issue 的纯文本报告 */
  report_text: string;
}
export interface DiagHealthResult {
  ok: boolean;
  report?: DiagHealthReport | null;
  error?: string | null;
  raw?: string;
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
  /** NVIDIA 驱动版本（nvidia-smi；GPU 增强包未装也可读） */
  driver_version?: string;
  /** 显存 MB（nvidia-smi / torch） */
  vram_total_mb?: number;
  vram_free_mb?: number;
  vram_used_mb?: number;
  /** 驱动是否支持共享显存回退（Windows + 驱动 ≥536.40） */
  sysmem_fallback_supported?: boolean;
  /** 是否可在控制面板按应用关闭（驱动 ≥546.01） */
  sysmem_fallback_controllable?: boolean;
  sysmem_fallback_note?: string;
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

/** CUDA 统一内存实验（cudaMallocManaged）结果 */
export interface UnifiedMemoryResult {
  ok: boolean;
  code?: string;
  method?: string;
  cudart?: string;
  size_mb?: number;
  alloc_ms?: number;
  host_touch_ms?: number;
  sync_ms?: number;
  note?: string;
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
  last_used?: string;
  /** 模型键 → 该模型的内置默认预设名（权威表在 engine/presets.py:MODEL_DEFAULT_PRESET）。 */
  model_defaults?: Record<string, string>;
  /** 模型键 → **用户指定**的预设名（空/缺 = 用内置默认）。这就是「记住用户的选择」。 */
  model_preset?: Record<string, string>;
  error?: string;
}

/** 用户元数据条目的 kind —— 必须与 main/usermeta.js 的 KINDS 白名单一致。 */
export type UserMetaKind = 'model' | 'utau' | 'ds' | 'sf' | 'voice';

/** 用户改过的一个条目。**空字段不会出现**（空 = 用原始名/原始值）。 */
export interface UserMetaItem {
  name?: string;
  author?: string;
  source?: string;
  tags?: string[];
  category?: string;
  order?: number;
  pinned?: boolean;
}

export interface UserMetaListResult {
  ok: boolean;
  items?: Record<string, UserMetaItem>;
  path?: string;
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
  /** 全局 UI 缩放（M9）：0.9 ~ 1.3，缺省 1 */
  ui_scale?: number;
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
  /** UTAU 引擎里的合成路线：'CLASSIC'（默认）| 'WORLDLINE-R' | 'WORLDLINE-R1.1' | 'WORLDLINE-R2' */
  utau_renderer?: string;
  /** P0-5：首次播放时后台加载随包内置的 GeneralUser GS（默认 true；关掉则始终用内置合成器） */
  default_gm?: boolean;
  /** P0-3b：MIDI 键盘录音的输入延迟补偿（ms） */
  midiInputOffsetMs?: number;
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
  /** 多说话人声库声明的说话人名（嵌入文件基名）；>1 时界面才显示选择 */
  speakers?: string[];
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
  /** ★ true = OpenUTAU 工程（.ust/.ustx）经引擎 export-project 转出的导入数据，
   *  需先过 `convertExternalProject()`（tick→拍）再 `parseProject()` */
  external?: boolean;
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

/** 翻唱工作流：可选音色 = 导入的 RVC 模型 */
export interface CoverSinger {
  kind: 'rvc';
  id: string;
  name: string;
  /** 模型目录（直接传给引擎） */
  dir: string;
  /** 权重是否齐（不齐的条目 UI 要挡住） */
  ready: boolean;
  /** 人话说明（引用式导入 / 缺什么 / DDSP 尚未支持） */
  note?: string;
  /** 架构串（RVC · v2 · 48k） */
  arch?: string;
  sr?: number;
  lang?: string;
  work?: string;
}

/** 翻唱工作流的本地环境（cover:env） */
export interface CoverEnv {
  ok: boolean;
  dataRoot: string;
  modelsRoot: string;
  /** 翻唱模型落点 <模型目录>/rvc */
  rvcRoot: string;
  singers: number;
}

/** 翻唱任务参数（cover:run） */
export interface CoverRunOptions {
  /** 源音频绝对路径 */
  audio: string;
  outdir: string;
  name?: string;
  singer: { kind: 'rvc'; id: string; path?: string };
  /** auto / cuda / cpu */
  device?: string;
  /** 吐字清晰度补偿（dB），0 = 关 */
  clarityDb?: number;
  /** 复用已分离好的人声轨（「音频处理」面板刚导出的结果） */
  vocals?: string;
  /** 复用已分离好的伴奏轨 */
  instrumental?: string;
  /** 不复用上次的中间结果 */
  noResume?: boolean;
  /* ---- RVC 参数（常用 + 高级，全部交给引擎，界面不自己实现 DSP）---- */
  /** 变调（半音） */
  transpose?: number;
  /** rmvpe / pm / harvest / crepe */
  f0Method?: string;
  /** faiss 特征检索混入比例 0~1 */
  indexRate?: number;
  /** 中值滤波半径（≥3 才启用 index 检索） */
  filterRadius?: number;
  /** 包络混入（1 = 完全用原唱包络） */
  rmsMixRate?: number;
  /** 清辅音保护 0~0.5 */
  protect?: number;
  /** 分块秒数 */
  chunkSec?: number;
  autoPredictF0?: boolean;
}

/* ---------------- 翻唱模型（RVC）注册表 ---------------- */
export interface RvcModel {
  id: string;
  name: string;
  engine: 'rvc' | 'ddsp' | string;
  version?: string;
  /** 模型采样率（32000/40000/48000）；0 = 未知，probe 后回写 */
  sr?: number;
  dir: string;
  files?: Record<string, string>;
  defaults?: Record<string, number | string | boolean>;
  source?: 'folder' | 'files' | 'zip';
  lang?: string;
  work?: string;
  size?: number;
  ready?: boolean;
  /** 缺失的文件（引用式导入的源目录可能被删） */
  missing?: string[];
  /** true = 源目录在应用目录之外（删除只注销条目，不动用户文件） */
  external?: boolean;
}

/** ModelScope 目录里的一条模型（只做索引，不含权重） */
export interface RvcCatalogModel {
  id: string;
  name: string;
  work: string;
  lang: string;
  sr: number;
  gen: string;
  engine: string;
  repo: string;
  pth: string;
  pthSize: number;
  index: string;
  indexSize: number;
  supported?: boolean;
}

export interface RvcCatalog {
  generated: string;
  note?: string;
  refreshed?: boolean;
  repos: { key: string; engine: string; name: string; site: string; license: string;
           commercial: boolean; credits: string[]; supported: boolean; count: number }[];
  langs: string[];
  works: string[];
  models: RvcCatalogModel[];
}

/** 翻唱进度（cover:progress 推送；`-1` 表示只带日志/文本） */
export interface CoverProgress {
  id: string;
  percent: number;
  text?: string;
  stage?: string;
  log?: string;
  done: boolean;
  ok?: boolean;
  aborted?: boolean;
  code?: number;
  error?: string;
  result?: any;
}

/** 一次问题反馈的输入（字段与反馈页一一对应；空的字段不进 md） */
export interface FeedbackPayload {
  fields: {
    kind: string; area: string; severity: string; title: string;
    symptom: string; steps?: string; expect?: string; freq?: string; contact?: string;
  };
  /** 是否附带诊断包（zip）。默认 false —— 里面有设置与日志，体积与隐私都更重 */
  includeDiagnostic?: boolean;
  /** Turnstile token（拿不到时留空，服务端按配置决定是否放行） */
  turnstile?: string;
  /** 是否顺手开一条 Issue（默认开） */
  createIssue?: boolean;
}

export interface FeedbackPreview {
  ok: boolean;
  id?: string;
  markdown?: string;
  path?: string;
  attachments?: { name: string; bytes: number }[];
  healthOk?: boolean;
  error?: string;
}

export interface AudioExportRequest {
  /** 文件名（不含扩展名），主进程会做 Windows 安全化 */
  name: string;
  /** 编码好的 WAV 字节 */
  bytes: Uint8Array | number[];
  ext?: string;
  format?: 'wav' | 'wav24' | 'float32' | string;
  bitDepth?: 16 | 24 | 32;
  sampleRate?: number;
  channels?: number;
  durationSec?: number;
  lufs?: number;
  peakDb?: number;
  targetLufs?: number | null;
  sourceName?: string;
  /** 仅测试/自动化用：直接写到该路径，不弹保存框 */
  targetPath?: string;
}
export interface AudioExportResult {
  ok: boolean;
  path?: string;
  manifestPath?: string;
  manifest?: any;
  canceled?: boolean;
  error?: string;
}

export interface StorageArea {
  id: string;
  label: string;
  path: string;
  kind: 'safe' | 'asset' | 'protected' | string;
  safe: boolean;
  protected: boolean;
  exists: boolean;
  bytes: number;
  files: number;
}
export interface StorageReport {
  areas: StorageArea[];
  totalBytes: number;
  updatedAt: number;
}

export interface TaskItem {
  id: string;
  kind: string;
  title: string;
  status: 'running' | 'done' | 'error' | 'canceled';
  progress: number;
  startedAt: number;
  endedAt: number | null;
  result?: any;
  error?: string;
  logs?: string[];
  cancelable?: boolean;
}

/** P2-1 VST3 离线渲染（宿主自备） */
export interface PluginInfo { name: string; path: string; format: string }
export interface PluginStatus { ok: boolean; hostPython: string; plugins: PluginInfo[]; dirs: string[]; error: string }
export interface PluginRenderResult {
  ok: boolean;
  mode?: string;
  plugin?: string;
  params?: string[];
  sampleRate?: number;
  seconds?: number;
  peak?: number;
  rms?: number;
  out?: string;
  elapsed?: number;
  error?: string;
  log?: string;
}

/** P0-4c 分轨打包导出 */
export interface StemZipFile {
  name: string;
  bytes: Uint8Array;
  ext?: string;
}
export interface StemZipResult {
  ok: boolean;
  canceled?: boolean;
  error?: string;
  path?: string;
  count?: number;
  bytes?: number;
}

/** P2-5 DAW 互通：DAWproject 包内文件（project.xml / metadata.xml） */
export interface DawprojectExportFile {
  name: string;
  data: string;
}
export interface DawprojectExportResult {
  ok: boolean;
  canceled?: boolean;
  error?: string;
  filePath?: string;
  bytes?: number;
  files?: string[];
}

/** P2-6 AI 生成（可选、默认关）：本地命令契约由 main/ai-generate.js 执行 */
export interface AiStatus {
  enabled: boolean;
  ready: boolean;
  code: 'disabled' | 'not-configured' | 'ready';
  reason: string;
  kinds: string[];
}
export interface AiRequest {
  kind: 'midi' | 'audio' | 'lyrics';
  prompt: string;
  title?: string;
  seed?: number;
}
export interface AiFile {
  name: string;
  path: string;
  kind: string;
  bytes: number;
}
export interface AiGenerateResult {
  ok: boolean;
  code?: string;
  error?: string;
  jobId?: string;
  outdir?: string;
  files?: AiFile[];
  meta?: { aiGenerated: true; provider: string; model: string; kind: string; createdAt: string; promptHash: string };
  log?: string;
}

export interface FuBridge {
  /** E2E 测试实例标记（scripts/e2e 启动时 FUFUMIDI_E2E=1）：true 时渲染进程会注册最小测试钩子 */
  e2e?: boolean;
  /** P2-1：VST3 离线渲染（宿主与插件自备） */
  plugin?: {
    status(): Promise<PluginStatus>;
    list(): Promise<{ ok: boolean; plugins?: PluginInfo[]; error?: string }>;
    pickDir(): Promise<{ ok: boolean; canceled?: boolean; dir?: string }>;
    pickFile(): Promise<{ ok: boolean; canceled?: boolean; file?: string }>;
    pickAudio(): Promise<{ ok: boolean; canceled?: boolean; file?: string }>;
    savePath(suggested?: string): Promise<{ ok: boolean; canceled?: boolean; file?: string }>;
    renderFile(payload: { plugin: string; input: string; output: string; params?: Record<string, number>; sampleRate?: number }): Promise<PluginRenderResult>;
  };
  /** P0-4c：分轨导出→单个 ZIP */
  exportStemsZip?(payload: { files: StemZipFile[]; suggestedName?: string; targetPath?: string }): Promise<StemZipResult>;
  /** P2-5 DAW 互通：导出 DAWproject */
  exportDawproject?(payload: { files: DawprojectExportFile[]; suggestedName?: string; filePath?: string }): Promise<DawprojectExportResult>;
  /** P2-6 AI 生成（可选、默认关）：生成文件一律带 AI 标注 */
  ai?: {
    status(): Promise<AiStatus>;
    generate(req: AiRequest): Promise<AiGenerateResult>;
  };
  /** P1-9 存储治理：分类占用与安全清理 */
  storage?: {
    report(): Promise<StorageReport>;
    cleanup(payload: { includeAssets?: boolean }): Promise<{ ok: boolean; freedBytes: number; removed: Array<{ id: string; bytes: number; files: number }>; errors: string[] }>;
  };
  /** C2 任务中心：长任务列表/取消/事件订阅（离开页面不丢） */
  tasks?: {
    list(): Promise<TaskItem[]>;
    cancel(id: string): Promise<{ ok: boolean; error?: string }>;
    /** 仅 E2E 实例可用：造一个演示任务验证进度/取消链路 */
    demo?(opts?: { intervalMs?: number }): Promise<{ id: string }>;
    onUpdate(cb: (ev: { type: string; tasks: TaskItem[] }) => void): () => void;
  };
  /** P0-4 音频导出：字节落盘 + manifest（主进程 main/export.js） */
  exportAudio(payload: AudioExportRequest): Promise<AudioExportResult>;
  onOpenFile(cb: (bytes: Uint8Array, name: string) => void): () => void;
  /** 沉浸模式：窗口真全屏（收掉原生标题栏）；返回实际状态 */
  setFullScreen(on: boolean): Promise<{ ok: boolean; fullScreen?: boolean; error?: string }>;

  // engine
  convert(cfg: ConvertRequest): Promise<ConvertResult>;
  cancel(id: string | number): Promise<GeneralResult>;
  /** 转录「暂停 / 继续」：正在转录的那一首当场停住，继续后从原处接着跑（只对分块引擎有效） */
  setTranscribePause(on: boolean): Promise<GeneralResult>;
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
  /** 音频时长（秒）。主进程用内置 ffmpeg 读头信息，不把整个文件读进渲染进程（长音频会卡死界面） */
  audioDuration(p: string): Promise<{ ok: boolean; seconds?: number; error?: string }>;
  pickAudio(): Promise<string | null>;
  pickAudioFiles(): Promise<string[] | null>;
  listAudioFiles(dir: string): Promise<string[]>;
  pickImage(): Promise<string | null>;
  /* 专辑封面（preload 的 sys:pickCover → main/system-ipc.js）。
     ★ 契约漂移实例：桥与主进程 2026 年就实现了它，类型表里一直没写，
       于是 app.ts 里两处调用报 TS2339 —— 类型漏一个成员 = 调用方永远"看不见"这个能力。 */
  pickCover(): Promise<{ ok?: boolean; canceled?: boolean; dataUrl?: string; error?: string }>;
  pickFile(opts: any): Promise<string | null>;
  pickDirectory(): Promise<string | null>;
  readSoundFont(p: string): Promise<Uint8Array | null>;
  soundfonts: { list(): Promise<SoundFontItem[]> };
  pickMusicXML(): Promise<string | null>;
  exportScorePdf(): Promise<GeneralResult>;
  /* 视频导出。opts.name = 曲名，主进程拿它当保存对话框的默认文件名（main/video.js 的 safeVideoBase
     会再洗一遍 Windows 非法字符）。旧调用方只传前两个参数仍然有效。 */
  transcodeVideo(data: any, audio: any, opts?: { name?: string; audioOffset?: number }): Promise<GeneralResult>;
  /* 流式导出（main/video.js 的 video:exportBegin/Write/Abort/End）。
     begin → 多次 write（data 为编码后的字节片段）→ end（封装 MP4，弹保存对话框）。
     container: 'h264'（WebCodecs 硬件编码，Annex B）| 'webm'（MediaRecorder 回退路径）。
     targetPath 仅供自动化冒烟跳过对话框，界面不传。 */
  videoExportBegin(opts: { container?: 'h264' | 'webm' }): Promise<{ ok: boolean; id?: string; container?: string; path?: string; error?: string }>;
  videoExportWrite(id: string, data: Uint8Array): Promise<{ ok: boolean; bytes?: number; error?: string }>;
  videoExportAbort(id: string): Promise<{ ok: boolean }>;
  videoExportEnd(opts: { id: string; fps?: number; duration?: number; audio?: any; audioOffset?: number; name?: string; targetPath?: string }): Promise<GeneralResult & { bytes?: number; copy?: boolean }>;
  modelList(): Promise<any[]>;
  depCheck(): Promise<GeneralResult>;
  diagExport(): Promise<GeneralResult>;
  /** 全局体检：主动检查各子系统并下结论（含显卡算力实跑校验，约几秒） */
  diagHealth(): Promise<DiagHealthResult>;
  /* 问题反馈上传（main/feedback.js + preload 的 feedback 组）。
     preview 只生成不落盘 —— 用户先看清「究竟会上传什么」再决定。 */
  feedback: {
    preview(payload: FeedbackPayload): Promise<FeedbackPreview>;
    saveLocal(payload: FeedbackPayload): Promise<GeneralResult & { bytes?: number; entries?: string[]; stripped?: string[] }>;
    submit(payload: FeedbackPayload): Promise<GeneralResult & { url?: string; issue?: { number?: number; url?: string } | null; savedLocal?: boolean; localPath?: string; markdown?: string }>;
    webFallback(payload: FeedbackPayload): Promise<GeneralResult & { url?: string; markdown?: string; path?: string }>;
  };
  exportScorePngZip(opts: any): Promise<GeneralResult>;
  listMidiFiles(dir: string): Promise<string[]>;
  readBinary(p: string): Promise<Uint8Array | null>;
  saveBinary(opts: { name: string; data: any }): Promise<GeneralResult>;
  openOutput(p: string): Promise<GeneralResult>;
  utauExportVoicebank(opts: { dir: string; files: { name: string; data: string }[] }): Promise<GeneralResult>;
  utauExportVoicebankZip(opts: { files: { name: string; data: string }[] }): Promise<GeneralResult & { canceled?: boolean; path?: string; count?: number }>;
  utauRenderTrack(cfg: { voicebank: string; notes: any[]; sampleNote: string; bpm?: number }): Promise<GeneralResult & { out?: string; bytes?: Uint8Array | number[]; duration_ms?: number; warnings?: string[]; engineVersion?: string }>;
  utauAliases(cfg: { voicebank: string; query?: string; limit?: number }): Promise<{ ok: boolean; aliases?: string[]; count?: number; total?: number; error?: string }>;
  /** M8 音域热力图：每个别名的录制音高（引擎分析采样得出） */
  utauAliasRange(cfg: { voicebank: string; query?: string; limit?: number }): Promise<{ ok: boolean; count?: number; items?: { alias: string; file: string; f0_hz?: number; note?: number | null; voiced?: number; ms?: number; offset?: number; error?: string }[]; error?: string }>;
  /** M8f：oto.ini 原始字节（解析/判编码在渲染进程，见 core/oto.js） */
  utauReadOto(cfg: { voicebank: string }): Promise<{ ok: boolean; path?: string; base64?: string; size?: number; mtimeMs?: number; error?: string }>;
  /** M8f：写回 oto.ini（字节由渲染进程按原编码编好；主进程先备份 oto.ini.bak） */
  utauSaveOto(cfg: { voicebank: string; base64: string }): Promise<{ ok: boolean; path?: string; backup?: string; bytes?: number; error?: string }>;
  utauFlags(): Promise<{ ok: boolean; engine_version?: string; supported?: { flag: string; default: number | null; min: number | null; max: number | null; desc: string }[]; unsupported?: { flag: string; desc: string }[]; example?: string; error?: string }>;
  utauListVoicebanks(): Promise<{ ok: boolean; list?: { name: string; dir: string }[]; error?: string }>;
  utauImportVoicebankZip(): Promise<{ ok: boolean; canceled?: boolean; name?: string; dir?: string; error?: string }>;
  /** 声库资源中心：可一键安装的开源/免费声库条目 */
  utauVoicebankRegistry(): Promise<{ ok: boolean; dir?: string; list?: VoicebankEntry[]; error?: string }>;
  utauDownloadVoicebank(id: string): Promise<{ ok: boolean; canceled?: boolean; existed?: boolean; name?: string; dir?: string; files?: number; size?: number; error?: string }>;
  utauCancelVoicebankDownload(id: string): Promise<GeneralResult>;
  onVoicebankProgress(cb: (p: VoicebankProgress) => void): () => void;

  // 翻唱工作流（一首歌 → 分离 → 变声 → 混音 → 成品）：引擎是 engine/engine_cover.py
  coverEnv(): Promise<CoverEnv>;
  coverSingers(): Promise<{ ok: boolean; rvc?: CoverSinger[]; error?: string }>;
  coverPickAudio(): Promise<{ ok?: boolean; canceled?: boolean; path?: string }>;
  coverPickDir(): Promise<{ ok?: boolean; canceled?: boolean; path?: string }>;
  coverRun(opts: CoverRunOptions): Promise<{ ok: boolean; id?: string; error?: string }>;
  coverCancel(): Promise<GeneralResult & { canceled?: boolean }>;
  coverOpen(p: string): Promise<GeneralResult>;
  // 翻唱模型（RVC）注册表：导入 / 列出 / 删除 / ModelScope 目录
  rvcList(): Promise<{ ok: boolean; models?: RvcModel[]; root?: string; error?: string }>;
  rvcCatalog(): Promise<{ ok: boolean; catalog?: RvcCatalog; error?: string }>;
  rvcRefreshCatalog(): Promise<{ ok: boolean; count?: number; generated?: string; error?: string }>;
  rvcPickFolder(): Promise<{ ok?: boolean; canceled?: boolean; dir?: string; detected?: any }>;
  rvcPickFiles(): Promise<{ ok?: boolean; canceled?: boolean; files?: string[] }>;
  rvcPickZip(): Promise<{ ok?: boolean; canceled?: boolean; path?: string }>;
  rvcImportFolder(dir: string, opts?: any): Promise<{ ok: boolean; model?: RvcModel; detected?: any; error?: string }>;
  rvcImportFiles(files: Record<string, string>, opts?: any): Promise<{ ok: boolean; model?: RvcModel; error?: string }>;
  rvcImportZip(p: string, opts?: any): Promise<{ ok: boolean; model?: RvcModel; error?: string }>;
  rvcRemove(id: string): Promise<{ ok: boolean; removedPhysical?: boolean; error?: string }>;
  rvcProbe(id: string): Promise<{ ok: boolean; model?: RvcModel; patched?: Record<string, any>; raw?: any; error?: string }>;
  rvcOpenCatalogPage(url: string): Promise<GeneralResult>;
  onCoverProgress(cb: (p: CoverProgress) => void): () => void;

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
  /** 通用声码器候选（数据根 vocoder/ 与通用组件位 Dependency/）。**不含**声库自带的 dsvocoder。 */
  diffsingerVocoders(): Promise<{ ok: boolean; items: { id: string; name: string; path: string }[]; dir?: string; error?: string }>;
  /** 已装声库声明的说话人并集（多说话人声库用；条目是嵌入文件基名） */
  diffsingerSpeakers(): Promise<{ ok: boolean; items: { dir: string; name: string; speakers: string[] }[]; speakers: string[] }>;
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
  /** P2 实验：验证 cudaMallocManaged 可用性与耗时；不改变转录用分配器 */
  gpuUnifiedMemoryExperiment(): Promise<UnifiedMemoryResult>;
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
    /** 把某个模型绑定到某个预设；name 传空 = 解绑、回到内置默认。 */
    setModelPreset(key: string, name: string): Promise<GeneralResult & { model_preset?: Record<string, string> }>;
  };

  /* 用户元数据（名字/作者/来源/标签/分类/排序/顶置）。
     ★ 独立表的原因：资源中心四页的数据每次刷新都会重算，用户改的东西写进那些结构里会丢。
     键是 "<kind>:<id>"；清空某字段（传空串/空数组）= 回到原始值。 */
  usermeta: {
    list(): Promise<UserMetaListResult>;
    set(kind: UserMetaKind, id: string, patch: UserMetaItem): Promise<GeneralResult & { item?: UserMetaItem }>;
    remove(kind: UserMetaKind, id: string): Promise<GeneralResult>;
    reorder(kind: UserMetaKind, ids: string[]): Promise<GeneralResult>;
    pin(kind: UserMetaKind, id: string, pinned: boolean): Promise<GeneralResult>;
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
    /** P0-2 自动保存草稿：写数据根 temp/autosave/，返回落盘路径与时间戳 */
    autosaveWrite(payload: { docId: string; model: any; meta?: any }): Promise<{ ok: boolean; path?: string; ts?: number; bytes?: number; error?: string }>;
    autosaveList(): Promise<Array<{ docId: string; id: string; ts: number; meta: any; bytes: number; path: string }>>;
    autosaveRead(docId: string): Promise<{ ok: boolean; docId?: string; ts?: number; meta?: any; data?: any; path?: string; error?: string }>;
    autosaveClear(docId: string): Promise<{ ok: boolean; removed?: boolean }>;
  };
}
