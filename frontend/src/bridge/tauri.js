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

  // ============================================================
  // ★ 桥接映射规则（2026-11-06 S7 审计 → S6 命令合入后复核）
  //
  // 只映射 shells/tauri/src/main.rs 里真实注册过的 #[tauri::command]。
  // 给不存在的命令写 invoke 不会编译报错，只会在用户点下去时得到
  // "command not found"（rvc_catalog / model_delete 都踩过）。
  //
  // 已注册、但 resource_extras 仍是占位实现的命令（桥接照常 call()，
  // 后端返回 {ok:false,error:"…尚未在 Tauri 侧实现"}，界面走既有错误分支；
  // 等 resource_extras 落地后**不需要再改前端**）：
  //   dep_install / gpu_list_packages|package_url|download_package|import_local|
  //   install_auto|cancel_install / sf_workshop_download|cancel / plugins_invoke /
  //   update_download|open / wallpaper_download / export_score_pdf|png_zip /
  //   omr_engine_install|lang_install|homr_install|sr_install|omr_cancel_install /
  //   utau_voicebank_registry|download_voicebank|cancel_voicebank_download
  //
  // 仍无 Rust 命令、只能降级的能力（调用处有 typeof / 存在性守卫）：
  //   · utau_render_track（本文件用 notPorted 兜底，避免 TypeError）
  //   · utau_alias_range / probe_voicebank（守卫给出「当前环境不支持」提示）
  //   · app_uninstall / update_speedtest / onSpeedtest / onTrayControl
  //   · wallpaper.downloadUrl / searchWallhaven
  //   · transcode_video：命令已注册但 resource_extras 返回 todo，故意先不映射，
  //     保留 ViewConvert 的 WebM 回退；真正实现后在这里补 call('transcode_video').
  //   · 事件通道：sf-workshop:progress / utau:voicebankProgress / gpu:progress /
  //     omr:progress 已按 rust-extras 的「started+done」契约接好（见下方 taskCall）；
  //     open-file / 文件夹监听事件仍无 emit（订阅已就绪）
  // ============================================================
  const notPorted = (cmd) => () => Promise.resolve({
    ok: false,
    notPorted: true,
    error: t('该功能尚未在 Tauri 桌面版移植：') + cmd,
  });

  // ============================================================
  // ★ S6 后台任务（rust-extras 契约）：命令**立即返回** {ok:true, started:true, id}，
  //   真正的完成/失败在进度事件的 done 终态里（p.done===true 时带 ok/path/size/error/canceled）。
  //   原因：main.rs 的同步薄包装在 Tauri 主线程执行，阻塞式下载会让取消/进度进不来。
  //
  //   桥接在这里把 started 结果「挂起」到对应事件的 done 再 resolve，既有
  //   await 调用点（ViewSoundfonts / UtauVoicebankStore / ViewResources / SettingsPanel）
  //   无需区分两种语义；若后端改回同步返回（结果里没有 started），这里原样透传。
  // ============================================================
  const TASK_TIMEOUT_MS = 2 * 60 * 60 * 1000;   // 2h 兜底：大增强包/声库下载上限，事件丢失时不至于永远挂起
  const taskWaiters = new Map();                // eventName -> [{ id, resolve, timer }]
  const TASK_EVENTS = ['sf-workshop:progress', 'utau:voicebankProgress', 'gpu:progress', 'omr:progress'];
  const normalizeDone = (p) => {
    if (!p || !p.done) return p;
    // 老 UI 用 r.ok 判断成败；done 事件未显式给 ok 时按 error/canceled 推导
    if (p.ok === undefined) return { ...p, ok: p.canceled ? false : !p.error };
    return p;
  };
  const settleTask = (eventName, p) => {
    if (!p || !p.done) return;
    const done = normalizeDone(p);
    const arr = taskWaiters.get(eventName) || [];
    if (!arr.length) return;
    // 带 id 的事件按 id 配对；无 id 的按 FIFO（UI 侧同一通道通常也只跑一个任务）
    let i = arr.findIndex((w) => w.id && p.id && w.id === p.id);
    if (i < 0) i = arr.findIndex((w) => !w.id || !p.id);
    if (i < 0) return;
    const w = arr.splice(i, 1)[0];
    clearTimeout(w.timer);
    w.resolve(done);
  };
  for (const ev of TASK_EVENTS) listen(ev, (p) => settleTask(ev, p));

  /** 注册「等 done」槽位。**必须在 invoke 之前注册**：后台线程可能在 invoke 返回前就 emit done。 */
  function taskSlot(eventName) {
    let entry = null;
    const promise = new Promise((resolve) => {
      entry = { id: null, resolve, timer: null };
      entry.timer = setTimeout(() => {
        const arr = taskWaiters.get(eventName) || [];
        const i = arr.indexOf(entry);
        if (i >= 0) arr.splice(i, 1);
        resolve({ ok: false, error: t('等待后台任务完成超时（可稍后刷新查看结果）') });
      }, TASK_TIMEOUT_MS);
      const arr = taskWaiters.get(eventName) || [];
      arr.push(entry);
      taskWaiters.set(eventName, arr);
    });
    return { promise, entry };
  }
  /** 撤销槽位（invoke 失败 / 不是 started 时，别把过期槽位留在表里） */
  function dropTaskSlot(eventName, entry) {
    const arr = taskWaiters.get(eventName) || [];
    const i = arr.indexOf(entry);
    if (i >= 0) arr.splice(i, 1);
    clearTimeout(entry.timer);
  }
  /** call() 的后台任务版：started:true → 等 done 事件；否则原样返回 */
  async function taskCall(cmd, args, eventName) {
    const { promise, entry } = taskSlot(eventName);
    let r;
    try {
      r = await call(cmd, args);
    } catch (e) {
      dropTaskSlot(eventName, entry);
      throw e;
    }
    if (!r || r.started !== true) {
      dropTaskSlot(eventName, entry);
      return r;
    }
    entry.id = r.id || null;
    const done = await promise;
    return { ...r, ...done };
  }

  window.fuBridge = {
    // ---- 打开文件（Tauri 阶段：双击关联事件后续接入）----
    // ★ Tauri 构建下的功能缺口（审计已登记）：Electron 侧靠主进程 'open-file' 事件
  //   支持双击 .mid 打开；Tauri 侧没有对应实现，所以这里只能返回一个空取消函数 ——
  //   即**Tauri 构建下双击 .mid 仍然不生效**。要补齐得在 src-tauri 里接文件关联并 emit 同名事件。
    onOpenFile: (cb) => listen('open-file', (p) => cb && cb(new Uint8Array((p && p.bytes) || []), (p && p.name) || 'opened.mid')),
    takePendingOpenFile: () => call('take_pending_open_file'),

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
    readSidecarLyrics: (filePath) => call('read_sidecar_lyrics', { filePath }),
    audioDuration: (p) => call('audio_duration', { p }),
    exportAudio: (payload) => call('export_audio', { payload }),
    videoExportBegin: (opts) => call('video_export_begin', { opts: opts || {} }),
    videoExportWrite: (id, data) => call('video_export_write', { id, data: Array.from(data || []) }),
    videoExportAbort: (id) => call('video_export_abort', { id }),
    videoExportEnd: (opts) => call('video_export_end', { opts: opts || {} }),
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
    modelImportLocal: (filePath) => call('model_import_local', { filePath }),
    clearUserData: (scopes) => call('clear_user_data', { scopes }),
    autostartSet: (open) => call('autostart_set', { open: !!open }),
    copyAsset: (payload) => call('copy_asset', { src: payload && payload.src, dest: payload && payload.dest }),
    openExternal: (url) => call('open_external', { url }),
    renameMidi: (p, newName) => call('rename_midi', { p, newName }),
    readBinary: (p) => call('read_binary', { p }),
    readSoundFont: (p) => call('read_soundfont', { p }),
    saveBinary: (opts) => call('save_binary', { opts }),
    soundfonts: { list: () => call('soundfont_list') },
    // 音色工坊：内置精选下载 / 自定义导入 / 删除 / 打开目录
    sfWorkshop: {
      list: () => call('sf_workshop_list'),
      // 后台任务：started 后等 sf-workshop:progress 的 done 再 resolve
      download: (id) => taskCall('sf_workshop_download', { id }, 'sf-workshop:progress'),
      cancel: (id) => call('sf_workshop_cancel', { id }),
      import: () => call('sf_workshop_import'),
      remove: (id) => call('sf_workshop_delete', { id }),
      openDir: () => call('sf_workshop_open_dir'),
      onProgress: (cb) => listen('sf-workshop:progress', cb),
    },
    // ---- UTAU / 统一声库 ----
    // 只读命令（列表/导入/导出/删除/oto）在 main.rs；下载/注册表走 resource_extras 占位实现。
    // TODO(未实现)：utau_render_track / utau_alias_range / probe_voicebank，均无 Rust 命令。
    utauVoicebankRegistry: () => call('utau_voicebank_registry'),
    // 后台任务：started 后等 utau:voicebankProgress 的 done 再 resolve
    utauDownloadVoicebank: (id) => taskCall('utau_download_voicebank', { id }, 'utau:voicebankProgress'),
    utauCancelVoicebankDownload: (id) => call('utau_cancel_voicebank_download', { id }),
    utauRenderTrack: (cfg) => notPorted('utau_render_track')(cfg),
    onVoicebankProgress: (cb) => listen('utau:voicebankProgress', cb),
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
    onStemProgress: (cb) => listen('engine:stem-progress', cb),
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
    // 视频导出走 video_export_* 流式通道；transcode_video 没有 Rust 命令，
    // 故意不映射 —— ViewConvert 检测不到该方法时会走 WebM 回退下载。
    // TODO(未移植)：transcode_video（Electron 的 webm→mp4 兜底）

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
    rendererReady: () => call('renderer_ready'),
    getVersion: () => call('app_version'),
    dataRoot: () => call('data_root'),
    storage: {
      report: () => call('storage_report'),
      cleanup: (payload) => call('storage_cleanup', { payload }),
    },
    project: {
      save: (payload) => call('project_save', { payload }),
      open: (filePath) => call('project_open', { filePath }),
      copyAsset: (payload) => call('copy_asset', { src: payload && payload.src, dest: payload && payload.dest }),
      autosaveWrite: (payload) => call('autosave_write', { payload }),
      autosaveList: () => call('autosave_list'),
      autosaveRead: (docId) => call('autosave_read', { docId }),
      autosaveClear: (docId) => call('autosave_clear', { docId }),
    },
    getZoomFactor: () => call('get_zoom_factor').then((r) => (r && r.factor) || 1),
    setZoomFactor: (f) => call('set_zoom_factor', { f: Number(f) || 1 }),
    setFullScreen: (on) => call('set_full_screen', { on: !!on }),
    openDataRoot: (sub) => call('open_data_root', { sub }),
    cleanTemp: () => call('clean_temp'),
    wallpaperEngine: {
      detect: () => call('wallpaper_engine_detect'),
      inventory: (force) => call('wallpaper_engine_inventory', { force: !!force }),
      openFolder: () => call('wallpaper_engine_open_folder'),
      view: (id) => call('wallpaper_engine_view', { id }),
    },
    diffsingerMsCatalog: () => call('diffsinger_ms_catalog'),
    diffsingerMsDownload: (req) => call('diffsinger_ms_download', { req: req || {} }),
    diffsingerMsCancelDownload: (name) => call('diffsinger_ms_cancel_download', { name }),
    diffsingerStatus: (opts) => call('diffsinger_status', { opts: opts || {} }),
    diffsingerSetEnabled: (on) => call('diffsinger_set_enabled', { on: !!on }),
    diffsingerInstallRuntime: () => call('diffsinger_install_runtime'),
    diffsingerCancelRuntimeInstall: () => call('diffsinger_cancel_runtime_install'),
    diffsingerUninstallRuntime: (opts) => call('diffsinger_uninstall_runtime', { opts: opts || {} }),
    diffsingerListVoicebanks: () => call('diffsinger_list_voicebanks'),
    diffsingerImportVoicebankZip: (directPath) => call('diffsinger_import_voicebank_zip', { directPath: directPath || '' }),
    diffsingerDeleteVoicebank: (dir) => call('diffsinger_delete_voicebank', { dir }),
    diffsingerVoicebankRegistry: () => call('diffsinger_voicebank_registry'),
    diffsingerDownloadVoicebank: (id) => call('diffsinger_download_voicebank', { id }),
    diffsingerCancelVoicebankDownload: (id) => call('diffsinger_cancel_voicebank_download', { id }),
    onDiffsingerRuntimeProgress: (cb) => listen('diffsinger:runtimeProgress', cb),
    onDiffsingerVoicebankProgress: (cb) => listen('diffsinger:voicebankProgress', cb),
    onDiffsingerMsProgress: (cb) => listen('diffsinger:msProgress', cb),
    updateCheck: (channel) => call('update_check', { channel }),   // Rust 命令名是 update_check（原 check_update 是命名不一致）
    updateNotes: (tag) => call('update_notes', { tag }),
    updateDownload: (url, channel, name, size) => call('update_download', { url, channel, name, size }),
    updateOpen: (p) => call('update_open', { path: p }),
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
    gpuUnifiedMemoryExperiment: () => call('gpu_unified_memory_experiment'),
    gpuStatus: () => call('gpu_status'),
    gpuUninstall: (kind) => call('gpu_uninstall', { kind }),
    gpuListPackages: () => call('gpu_list_packages'),
    gpuPackageUrl: (kind) => call('gpu_package_url', { kind }),
    // 后台任务：started 后等 gpu:progress 的 done 再 resolve
    gpuDownloadPackage: (opts) => taskCall('gpu_download_package', { opts }, 'gpu:progress'),
    gpuImportLocal: (p, kind) => call('gpu_import_local', { req: { paths: Array.isArray(p) ? p : [p], kind } }),
    gpuInstallAuto: () => taskCall('gpu_install_auto', undefined, 'gpu:progress'),
    gpuCancelInstall: () => call('gpu_cancel_install'),
    onGpuProgress: (cb) => listen('gpu:progress', cb),

    // ---- 翻唱模型（本地）----
    rvcProbe: (id) => call('rvc_probe', { id }),
    rvcRefreshCatalog: () => call('rvc_refresh_catalog'),
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
    omrEngine: {
      status: () => call('omr_engine_status'),
      openDir: () => call('omr_engine_open_dir'),
      remove: () => call('omr_engine_remove'),
      langStatus: () => call('omr_lang_status'),
      langRemove: (code) => call('omr_lang_remove', { code }),
      homrStatus: () => call('omr_homr_status'),
      homrRemove: () => call('omr_homr_remove'),
      srStatus: () => call('omr_sr_status'),
      srRemove: () => call('omr_sr_remove'),
      // 后台任务：started 后等 omr:progress 的 done 再 resolve
      install: () => taskCall('omr_engine_install', undefined, 'omr:progress'),
      langInstall: (codes) => taskCall('omr_lang_install', { codes }, 'omr:progress'),
      homrInstall: () => taskCall('omr_homr_install', undefined, 'omr:progress'),
      srInstall: () => taskCall('omr_sr_install', undefined, 'omr:progress'),
      onProgress: (cb) => listen('omr:progress', cb),
    },
    plugin: {
      pickFile: () => call('plugin_pick_file'),
      pickAudio: () => call('plugin_pick_audio'),
      savePath: (name) => call('plugin_save_path', { name: name || '' }),
      renderFile: (req) => call('plugin_render_file', { req: req || {} }),
    },
    plugins: {
      list: () => call('plugins_list'),
      setEnabled: (id, enabled) => call('plugins_set_enabled', { id, enabled }),
      // 插件命令由前端 JS 宿主执行（Tauri 无 Node/QuickJS）；宿主未就绪时回退到 Rust 的明确报错。
      invoke: (id, cmd, payload) => (typeof window.__fufumidi_plugin_invoke === 'function'
        ? window.__fufumidi_plugin_invoke(id, cmd, payload)
        : call('plugins_invoke', { id, cmd, payload })),
      bundle: (id) => call('plugins_bundle', { id }),
      engineRun: (args, opts) => call('plugin_engine_run', { args: args || [], script: opts && opts.script, timeoutMs: opts && opts.timeoutMs, pluginDir: opts && opts.pluginDir, pluginId: opts && opts.pluginId }),
      rescan: () => call('plugins_rescan'),
      installedList: () => call('plugins_installed_list'),
      platformInfo: () => call('plugins_platform_info'),
      installFromPlatform: (slug, version) => call('plugins_install_from_platform', { slug, version: version || '' }),
      confirmInstall: (token, overwrite) => call('plugins_confirm_install', { token, overwrite: !!overwrite }),
      cancelInstall: (token) => call('plugins_cancel_install', { token }),
      catalog: (channel) => call('plugins_catalog', { channel: channel || 'stable' }),
      openPlatform: (rel) => call('plugins_open_platform', { rel: rel || '' }),
      openDocs: () => call('plugins_open_docs'),
      openDir: () => call('plugins_open_dir'),
      onUi: (cb) => listen('plugins:ui', cb),
      onLog: (cb) => listen('plugins:log', cb),
      onScript: (cb) => listen('plugins:script', cb),
    },

    separateAudio: (cfg) => call('separate_audio', { opts: cfg || {} }),
    onSeparateLog: (cb) => listen('engine:separate:log', cb),
    onSeparateProgress: (cb) => listen('engine:separate:progress', cb),

    // ---- 动态壁纸 ----
    coverSingers: () => call('cover_singers'),
    coverPickAudio: () => call('cover_pick_audio'),
    coverPickDir: () => call('cover_pick_dir'),
    coverOpen: (p) => call('cover_open', { path: p }),
    coverCancel: () => call('cover_cancel'),
    coverRun: (opts) => call('cover_run', { opts: opts || {} }),
    onCoverProgress: (cb) => listen('cover:progress', cb),

    wallpaper: {
      defaults: () => call('wallpaper_defaults'),
      list: () => call('wallpaper_list'),
      download: (url, name) => call('wallpaper_download', { url, name }),
      // TODO(未移植)：downloadUrl / searchWallhaven 在 Rust 端还没有命令
      //   （调用处有存在性守卫；未定义时保持「当前版本不支持」的旧提示）
      addLocal: (path) => call('wallpaper_add_local', { srcPath: path }),
      removeLocal: (name) => call('wallpaper_remove_local', { name }),
      setDesktop: (path) => call('wallpaper_set_desktop', { path }),
      scanFolder: (dir) => call('wallpaper_scan_folder', { dir }),
      onAddLocalProgress: (cb) => listen('wallpaper:addLocalProgress', cb),
      onDownloadProgress: (cb) => listen('wallpaper:downloadProgress', cb),
    },

    tasks: {
      list: () => call('tasks_list'),
      clearFinished: () => call('tasks_clear_finished'),
      cancel: (id) => call('tasks_cancel', { id }),
      onUpdate: (cb) => listen('tasks:update', cb),
    },

    // ---- 持久化（JSON 文件）----
    dbStatus: () => call('db_status'),
    dbKvGet: (key) => call('db_kv_get', { key }),
    dbKvSet: (key, value) => call('db_kv_set', { key, value }),
    dbSongsList: () => call('db_songs_list'),
    dbSongGet: (id) => call('db_song_get', { id }),
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
