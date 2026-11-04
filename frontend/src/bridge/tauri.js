// ============================================================
// Tauri 桥接适配层：在 Tauri 环境注入 window.fuBridge，
// 把 Electron preload 的 IPC 方法映射到 Tauri invoke。
// 前端组件无需任何改动（api.ts 检测 window.fuBridge）。
// ============================================================
import { t } from '../core/i18n.js';

export function isTauri() {
  return typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__);
}

export function installTauriBridge() {
  if (window.fuBridge || !isTauri()) return;
  const invoke = window.__TAURI_INTERNALS__.invoke;
  if (!invoke) return;

  // 通用 helper：Electron channel "a:b" → Tauri 命令名 a_b（Rust 命令由 generate_handler 注册）
  const call = (cmd, args) => {
    try {
      return invoke(cmd, args || {});
    } catch (e) {
      return Promise.reject(e);
    }
  };

  // 事件订阅：Tauri 2 emit 事件（engine:log 等）通过 __TAURI_INTERNALS__.transformCallback 注册
  const listen = (eventName, cb) => {
    const t = window.__TAURI_INTERNALS__;
    if (t && t.listen) {
      return t.listen(eventName, null, cb).catch(() => () => {});
    }
    if (t && t.transformCallback) {
      const key = t.transformCallback((ev) => cb(ev.payload));
      const unlistenName = `_${eventName}_${key}`;
      t.postMessage({
        cmd: 'listen',
        event: eventName,
        callback: key,
        options: { once: false },
      });
      return () => {
        try {
          t.postMessage({ cmd: 'unlisten', event: eventName, callback: key });
        } catch (e) {}
      };
    }
    return () => {};
  };

  window.fuBridge = {
    // ---- 打开文件（Tauri 阶段：双击关联事件后续接入）----
    // ★ Tauri 构建下的功能缺口（审计已登记）：Electron 侧靠主进程 'open-file' 事件
  //   支持双击 .mid 打开；Tauri 侧没有对应实现，所以这里只能返回一个空取消函数 ——
  //   即**Tauri 构建下双击 .mid 仍然不生效**。要补齐得在 src-tauri 里接文件关联并 emit 同名事件。
  onOpenFile: () => () => {},

    // ---- 设置 ----
    getSettings: () => call('load_settings'),
    saveSettings: (s) => call('save_settings', { s }),
    fileAssoc: (enabled) => call('file_assoc', { enabled }),

    // ---- 完整性 ----
    checkIntegrity: () => call('check_integrity'),
    repairIntegrity: (ids) => call('repair_integrity', { ids }),

    // ---- 文件对话框 / 二进制 ----
    pickAudio: () => call('pick_audio'),
    pickAudioFiles: () => call('pick_audio_files'),
    listAudioFiles: (dir) => call('list_audio_files', { dir }),
    pickImage: () => call('pick_image'),
    pickFile: (opts) => call('pick_file', { opts }),
    pickDirectory: () => call('pick_directory'),
    pickMusicXML: () => call('pick_music_xml'),
    listMidiFiles: (dir) => call('list_midi_files', { dir }),
    checkMidi: (items) => call('check_midi', { items }),
    hasMidi: (p) => call('has_midi', { p }),
    midiStats: () => call('library_stats'),
    verifyMidi: () => call('verify_midi'),
    dupeMidi: () => call('dupe_midi'),
    deleteMidi: (p) => call('delete_midi', { p }),
    revealMidi: (p) => call('reveal_midi', { p }),
    readSidecarLyrics: (filePath) => call('read_sidecar_lyrics', { file_path: filePath }),
    audioDuration: (p) => call('audio_duration', { p }),
    exportAudio: (payload) => call('export_audio', { payload }),
    exportStemsZip: (payload) => call('export_stems_zip', { payload }),
    pickCover: () => call('pick_cover'),
    exportDawproject: (payload) => call('export_dawproject', { payload }),
    writeMidi: (opts) => call('write_midi', { opts }),
    usermeta: {
      list: () => call('usermeta_list'),
      set: (kind, id, patch) => call('usermeta_set', { kind, id, patch }),
      remove: (kind, id) => call('usermeta_remove', { kind, id }),
      reorder: (kind, ids) => call('usermeta_reorder', { kind, ids }),
      pin: (kind, id, pinned) => call('usermeta_pin', { kind, id, pinned: !!pinned }),
    },
    writeBinary: (p, data) => call('write_binary', { p, data: Array.from(data || []) }),
    autostartGet: () => call('autostart_get'),
    diagHealth: () => call('diag_health'),
    pickModelArchive: () => call('pick_model_archive'),
    modelImportLocal: (filePath) => call('model_import_local', { file_path: filePath }),
    clearUserData: (scopes) => call('clear_user_data', { scopes }),
    autostartSet: (open) => call('autostart_set', { open: !!open }),
    copyAsset: (payload) => call('copy_asset', { src: payload && payload.src, dest: payload && payload.dest }),
    openExternal: (url) => call('open_external', { url }),
    renameMidi: (p, newName) => call('rename_midi', { p, new_name: newName }),
    readBinary: (p) => call('read_binary', { p }),
    readSoundFont: (p) => call('read_soundfont', { p }),
    saveBinary: (opts) => call('save_binary', { opts }),
    soundfonts: { list: () => call('soundfont_list') },
    // 音色工坊：内置精选下载 / 自定义导入 / 删除 / 打开目录
    sfWorkshop: {
      list: () => call('sf_workshop_list'),
      download: (id) => call('sf_workshop_download', { id }),
      cancel: (id) => call('sf_workshop_cancel', { id }),
      import: () => call('sf_workshop_import'),
      remove: (id) => call('sf_workshop_delete', { id }),
      openDir: () => call('sf_workshop_open_dir'),
      onProgress: (cb) => listen('sf-workshop:progress', cb),
    },
    // ---- UTAU / 统一声库（只读；Electron 侧 utau:listVoicebanks / voicebank:unified）----
    // Tauri 端命令只扫数据目录，不 import / 不删除 / 不下载（那些动作仍未移植，见审计缺口）。
    utauListVoicebanks: () => call('utau_list_voicebanks'),
    utauExportVoicebankZip: (opts) => call('utau_export_voicebank_zip', { files: (opts && opts.files) || [] }),
    utauExportVoicebank: (opts) => call('utau_export_voicebank', { dir: opts && opts.dir, files: (opts && opts.files) || [] }),
    utauImportVoicebankZip: () => call('utau_import_voicebank_zip'),
    utauDeleteVoicebank: (dir) => call('utau_delete_voicebank', { voicebank: dir }),
    utauReadOto: (cfg) => call('utau_read_oto', { voicebank: cfg && cfg.voicebank }),
    utauSaveOto: (cfg) => call('utau_save_oto', { voicebank: cfg && cfg.voicebank, base64: cfg && cfg.base64 }),
    voicebankUnified: () => call('voicebank_unified'),
    pickZip: () =>
      call('pick_file', {
        opts: { filters: [{ name: t('GPU 增强包'), extensions: ['zip', 'part1', 'part2', 'part3', 'part4', 'part5'] }] },
      }).then((p) => (p ? [p] : null)),

    // ---- 转录引擎 ----
    convert: (cfg) => call('convert', { req: cfg }),
    cancel: (id) => call('cancel', { id }),
    setTranscribePause: (on) => call('set_transcribe_pause', { on: !!on }),
    probe: () => call('probe'),
    refine: (cfg) => call('refine', { req: cfg }),
    onEngineLog: (cb) => listen('engine:log', cb),
    onEngineProgress: (cb) => listen('engine:progress', cb),
    onRefineLog: (cb) => listen('engine:refine:log', cb),

    // ---- 模型（资源中心）----
    modelList: () => call('model_list'),
    modelDownload: (id, channel) => call('model_download', { req: { id, channel } }),
    modelCancel: (id) => call('model_cancel', { id }),
    modelPause: (id) => call('model_pause', { id }),
    modelDelete: (id) => call('model_delete', { id }),
    onModelProgress: (cb) => listen('model:progress', cb),

    // ---- 依赖 / 诊断 ----
    depCheck: () => call('dep_check'),
    depInstall: (group) => call('dep_install', { group }),
    diagExport: () => call('diag_export'),

    // ---- 乐谱 / 视频 ----
    exportScorePngZip: (opts) => call('export_score_png_zip', { opts }),
    exportScorePdf: () => call('export_score_pdf'),
    transcodeVideo: (data, audio) => call('transcode_video', { opts: { data, audio } }),

    // ---- 打开输出 / 编辑指南 / 事件 ----
    openOutput: (p) => call('open_output', { p }),
    openEditGuide: () => call('open_edit_guide'),
    notify: (ev, payload) => call('notify', { ev, payload }),

    // ---- 更新器 ----
    update: {
      list: () => call('update_list'),
      openExternal: (url) => call('open_external', { url }),
      launchUpdater: (channel) => call('launch_updater', { channel }),
    },
    // 主程序检查更新（对比 GitHub latest 与当前版本，有新版才拉起更新器）
    getVersion: () => call('app_version'),
    dataRoot: () => call('data_root'),
    storage: {
      report: () => call('storage_report'),
      cleanup: (payload) => call('storage_cleanup', { payload }),
    },
    project: {
      save: (payload) => call('project_save', { payload }),
      open: (filePath) => call('project_open', { file_path: filePath }),
      copyAsset: (payload) => call('copy_asset', { src: payload && payload.src, dest: payload && payload.dest }),
      autosaveWrite: (payload) => call('autosave_write', { payload }),
      autosaveList: () => call('autosave_list'),
      autosaveRead: (docId) => call('autosave_read', { doc_id: docId }),
      autosaveClear: (docId) => call('autosave_clear', { doc_id: docId }),
    },
    getZoomFactor: () => call('get_zoom_factor').then((r) => (r && r.factor) || 1),
    setZoomFactor: (f) => call('set_zoom_factor', { f: Number(f) || 1 }),
    setFullScreen: (on) => call('set_full_screen', { on: !!on }),
    openDataRoot: (sub) => call('open_data_root', { sub }),
    cleanTemp: () => call('clean_temp'),
    updateCheck: (channel) => call('check_update', { channel }),
    updateNotes: (tag) => call('update_notes', { tag }),
    updateDownload: (url, channel, name, size) => call('update_download', { url, channel, name, size }),
    updateOpen: (p) => call('update_open', { p }),
    onUpdateProgress: (cb) => listen('update:progress', cb),
    // 线路列表 / 会话内首选线路（本地命令：只读设置，不联网、不下载；偏好只提前不锁定）
    updateSources: (channel) => call('update_sources', { channel }),
    updateSetPreferredSource: (id) => call('update_set_preferred_source', { id }),

    // ---- 转录参数预设 ----
    presets: {
      list: () => call('presets_list'),
      save: (name, mode, params) => call('presets_save', { req: { name, mode, params } }),
      delete: (name) => call('presets_delete', { name }),
      lastUsed: (name) => call('presets_last_used', { name }),
      reorder: (name, delta) => call('presets_reorder', { name, delta }),
      reorderTo: (name, index) => call('presets_reorder_to', { name, index }),
      setModelPreset: (key, name) => call('presets_set_model', { key, name }),
      restore: () => call('presets_restore'),
    },

    // ---- GPU 增强包 ----
    gpuStatus: () => call('gpu_status'),
    gpuUninstall: (kind) => call('gpu_uninstall', { kind }),
    gpuListPackages: () => call('gpu_list_packages'),
    gpuPackageUrl: (kind) => call('gpu_package_url', { kind }),
    gpuDownloadPackage: (opts) => call('gpu_download_package', { opts }),
    gpuImportLocal: (p, kind) => call('gpu_import_local', { req: { paths: Array.isArray(p) ? p : [p], kind } }),
    gpuInstallAuto: () => call('gpu_install_auto'),
    onGpuProgress: (cb) => listen('gpu:progress', cb),

    // ---- 翻唱模型（本地）----
    rvcProbe: (id) => call('rvc_probe', { id }),
    rvcCatalog: () => call('rvc_catalog'),
    rvcOpenCatalogPage: (url) => call('rvc_open_catalog_page', { url }),
    rvcPickZip: () => call('rvc_pick_zip'),
    rvcImportZip: (p, opts) => call('rvc_import_zip', { path: p, opts: opts || {} }),
    rvcPickFolder: () => call('rvc_pick_folder'),
    rvcPickFiles: () => call('rvc_pick_files'),
    rvcImportFolder: (dir, opts) => call('rvc_import_folder', { dir, opts: opts || {} }),
    rvcImportFiles: (files, opts) => call('rvc_import_files', { files: files || {}, opts: opts || {} }),
    rvcList: () => call('rvc_list'),
    rvcRemove: (id) => call('rvc_remove', { id }),

    // ---- 插件 ----
    plugins: {
      list: () => call('plugins_list'),
      setEnabled: (id, enabled) => call('plugins_set_enabled', { id, enabled }),
      invoke: (id, cmd, payload) => call('plugins_invoke', { id, cmd, payload }),
      rescan: () => call('plugins_rescan'),
      openDocs: () => call('plugins_open_docs'),
      openDir: () => call('plugins_open_dir'),
      onUi: (cb) => listen('plugins:ui', cb),
      onLog: (cb) => listen('plugins:log', cb),
      onScript: (cb) => listen('plugins:script', cb),
    },

    // ---- 动态壁纸 ----
    wallpaper: {
      defaults: () => call('wallpaper_defaults'),
      list: () => call('wallpaper_list'),
      download: (url, name) => call('wallpaper_download', { url, name }),
      addLocal: (path) => call('wallpaper_add_local', { src_path: path }),
      removeLocal: (name) => call('wallpaper_remove_local', { name }),
      setDesktop: (path) => call('wallpaper_set_desktop', { path }),
      scanFolder: (dir) => call('wallpaper_scan_folder', { dir }),
      onAddLocalProgress: (cb) => listen('wallpaper:addLocalProgress', cb),
      onDownloadProgress: (cb) => listen('wallpaper:downloadProgress', cb),
    },

    // ---- 持久化（JSON 文件）----
    dbStatus: () => call('db_status'),
    dbKvGet: (key) => call('db_kv_get', { key }),
    dbKvSet: (key, value) => call('db_kv_set', { key, value }),
    dbSongsList: () => call('db_songs_list'),
    dbSongsPut: (item) => call('db_songs_put', { item }),
    dbSongsDelete: (id) => call('db_songs_delete', { id }),
    dbPlaylistsList: () => call('db_playlists_list'),
    dbPlaylistsPut: (item) => call('db_playlists_put', { item }),
    dbPlaylistsDelete: (id) => call('db_playlists_delete', { id }),

    // ---- 可选 Rust 核心：Tauri 原生即 Rust，无需外部二进制 ----
    rustStatus: () => Promise.resolve({ ok: true, available: false, binary: null, version: null }),
    rustInvoke: () => Promise.resolve({ ok: false, error: t('Tauri 原生模式无需外部 Rust 核心') }),

    // ---- 文件夹监听（Tauri 阶段暂不实现，返回空订阅）----
    setFolderWatch: () => Promise.resolve({ ok: true }),
    // ★ 同上：Tauri 构建未实现文件夹监听（审计已登记）
  onFolderWatch: () => () => {},
  };

  window.__fufumidi_isTauri = true;
  console.info('[bridge] Tauri 桥接已注入（分阶段迁移，模块已全部移植）');
}
