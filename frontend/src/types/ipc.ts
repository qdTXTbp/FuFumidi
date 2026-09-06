// ============================================================
// FuFumidi 类型化 IPC 契约
// 前端 / preload / 主进程共享的请求响应类型
// ============================================================

export type EngineMode = 'universal' | 'piano' | 'separate';
export type PerfMode = 'quality' | 'balanced' | 'fast';
export type GpuKind = 'cuda' | 'directml';

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
}

export interface GpuStatusResult {
  ok: boolean;
  directml?: boolean;
  cuda?: boolean;
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
  lang?: 'zh' | 'en';
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
  utauRenderTrack(cfg: { voicebank: string; notes: any[]; sampleNote: string; bpm?: number }): Promise<GeneralResult & { out?: string; bytes?: number[]; duration_ms?: number }>;
  utauListVoicebanks(): Promise<{ ok: boolean; list?: { name: string; dir: string }[]; error?: string }>;
  utauImportVoicebankZip(): Promise<{ ok: boolean; canceled?: boolean; name?: string; dir?: string; error?: string }>;
  pickZip(): Promise<string[] | null>;

  // gpu
  gpuInstallAuto(): Promise<GeneralResult>;
  gpuPackageUrl(kind: GpuKind): Promise<GeneralResult & { url?: string; name?: string; size?: number }>;
  gpuListPackages(): Promise<GeneralResult & { packages?: GpuPackage[] }>;
  gpuImportLocal(p: string | string[], kind: GpuKind): Promise<GeneralResult>;
  gpuStatus(): Promise<GpuStatusResult>;
  gpuUninstall(kind: GpuKind): Promise<GeneralResult>;
  gpuDownloadPackage(opts: GpuDownloadOptions): Promise<GeneralResult>;
  onGpuProgress(cb: (p: any) => void): () => void;

  // updates
  updateCheck(): Promise<any>;
  getVersion(): Promise<string>;
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

  // app events
  notify(ev: string, payload: any): void;
  openEditGuide(): Promise<GeneralResult>;
}
