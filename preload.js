// Preload 桥接：主进程 ↔ 渲染进程（fuBridge）
const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');
// 拖拽文件 → 本地路径（UTAU 声库 zip 拖拽导入用）
function filePathFor(f) { try { return webUtils.getPathForFile(f); } catch (e) { return null; } }

contextBridge.exposeInMainWorld('fuBridge', {
  /* 全局 UI 缩放（M9）：走 Chromium 自己的缩放因子，而不是 CSS transform ——
     transform 只改画面不改排版（会重叠），而缩放因子会真的重排，
     并且 devicePixelRatio 跟着变，画布的 devicePixel 尺寸自动跟着走（不会糊）。
     范围与设置页一致：0.9 ~ 1.3。 */
  setZoomFactor: (f) => {
    try {
      const v = Math.min(1.3, Math.max(0.9, Number(f) || 1));
      webFrame.setZoomFactor(v);
      return webFrame.getZoomFactor();
    } catch (e) { return 1; }
  },
  getZoomFactor: () => { try { return webFrame.getZoomFactor(); } catch (e) { return 1; } },
  // 打开文件（双击 .mid 关联）
  onOpenFile: (cb) => {
    const w = (_e, bytes, name) => cb(new Uint8Array(bytes), name);
    ipcRenderer.on('open-file', w);
    return () => ipcRenderer.removeListener('open-file', w);
  },
  // 取「待打开的文件」：消除冷启动时主进程 send 早于渲染进程订阅的竞态
  takePendingOpenFile: () => ipcRenderer.invoke('open-file:take'),
  // 沉浸模式用：窗口真全屏（原生标题栏只此一法可收；退出时传 false 还原）
  setFullScreen: (on) => ipcRenderer.invoke('win:setFullScreen', !!on),
  // 翻唱工作流（一首歌 → 分离 → 扒谱 → 合成 → 混音 → 成品）
  coverEnv: () => ipcRenderer.invoke('cover:env'),
  coverSingers: () => ipcRenderer.invoke('cover:singers'),
  coverPickAudio: () => ipcRenderer.invoke('cover:pickAudio'),
  coverPickDir: () => ipcRenderer.invoke('cover:pickDir'),
  coverPickGsvRoot: () => ipcRenderer.invoke('cover:pickGsvRoot'),
  coverPickGsvPython: () => ipcRenderer.invoke('cover:pickGsvPython'),
  coverRun: (opts) => ipcRenderer.invoke('cover:run', opts),
  coverCancel: () => ipcRenderer.invoke('cover:cancel'),
  coverOpen: (p) => ipcRenderer.invoke('cover:open', p),
  onCoverProgress: (cb) => {
    const w = (_e, p) => cb(p);
    ipcRenderer.on('cover:progress', w);
    return () => ipcRenderer.removeListener('cover:progress', w);
  },
  // 转录引擎
  convert: (cfg) => ipcRenderer.invoke('engine:convert', cfg),
  cancel: (id) => ipcRenderer.invoke('engine:cancel', id),
  setTranscribePause: (on) => ipcRenderer.invoke('engine:set-pause', !!on),
  onEngineLog: (cb) => {
    const w = (_e, p) => cb(p);
    ipcRenderer.on('engine:log', w);
    return () => ipcRenderer.removeListener('engine:log', w);
  },
  probe: () => ipcRenderer.invoke('engine:probe'),
  // 智能修正引擎
  refine: (cfg) => ipcRenderer.invoke('engine:refine', cfg),
  onRefineLog: (cb) => {
    const w = (_e, p) => cb(p);
    ipcRenderer.on('engine:refine:log', w);
    return () => ipcRenderer.removeListener('engine:refine:log', w);
  },
  // 音频处理（MSST 分离）
  separateAudio: (cfg) => ipcRenderer.invoke('engine:separate', cfg),
  // 音频时长（主进程用内置 ffmpeg 读头信息，避免把大文件读进渲染进程）
  audioDuration: (p) => ipcRenderer.invoke('audio:duration', p),
  onSeparateLog: (cb) => {
    const w = (_e, p) => cb(p);
    ipcRenderer.on('engine:separate:log', w);
    return () => ipcRenderer.removeListener('engine:separate:log', w);
  },
  onSeparateProgress: (cb) => {
    const w = (_e, p) => cb(p);
    ipcRenderer.on('engine:separate:progress', w);
    return () => ipcRenderer.removeListener('engine:separate:progress', w);
  },
  // 设置
  getSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  // 完整性检验（误删检测 + 一键修复）
  checkIntegrity: () => ipcRenderer.invoke('integrity:check'),
  repairIntegrity: (ids) => ipcRenderer.invoke('integrity:repair', ids),
  // 原生对话框
  pickAudio: () => ipcRenderer.invoke('dialog:pickAudio'),
  pickAudioFiles: () => ipcRenderer.invoke('dialog:pickAudioFiles'),
  listAudioFiles: (dir) => ipcRenderer.invoke('dir:listAudioFiles', dir),
  pickImage: () => ipcRenderer.invoke('dialog:pickImage'),
  pickFile: (opts) => ipcRenderer.invoke('dialog:pickFile', opts),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  pickSoundFont: null,   // 已移除外部 SF2/SF3 加载：使用内置音源列表 soundfonts.list()
  readSoundFont: (p) => ipcRenderer.invoke('file:readSoundFont', p),
  soundfonts: { list: () => ipcRenderer.invoke('soundfont:list') },
  // 音色工坊：内置精选下载 / 自定义导入 / 删除 / 打开目录
  sfWorkshop: {
    list: () => ipcRenderer.invoke('sf-workshop:list'),
    download: (id) => ipcRenderer.invoke('sf-workshop:download', id),
    cancel: (id) => ipcRenderer.invoke('sf-workshop:cancel', id),
    import: () => ipcRenderer.invoke('sf-workshop:import'),
    remove: (id) => ipcRenderer.invoke('sf-workshop:delete', id),
    openDir: () => ipcRenderer.invoke('sf-workshop:openDir'),
    onProgress: (cb) => { const w = (_e, p) => cb(p); ipcRenderer.on('sf-workshop:progress', w); return () => ipcRenderer.removeListener('sf-workshop:progress', w); },
  },
  /* 用户元数据：按 "<kind>:<id>" 存用户改过的名字/作者/来源/标签/分类/排序/顶置。
     kind ∈ model | utau | ds | sf | voice。落盘在数据根（整包更新不会碰）。
     为什么是独立表：资源中心四页的数据每次刷新都会重算，用户改的东西写进那些结构里会丢。 */
  usermeta: {
    list: () => ipcRenderer.invoke('usermeta:list'),
    set: (kind, id, patch) => ipcRenderer.invoke('usermeta:set', kind, id, patch),
    remove: (kind, id) => ipcRenderer.invoke('usermeta:remove', kind, id),
    reorder: (kind, ids) => ipcRenderer.invoke('usermeta:reorder', kind, ids),
    pin: (kind, id, pinned) => ipcRenderer.invoke('usermeta:pin', kind, id, pinned),
  },
  pickMusicXML: () => ipcRenderer.invoke('dialog:pickMusicXML'),
  exportScorePdf: () => ipcRenderer.invoke('score:exportPdf'),
  transcodeVideo: (data, audio, opts) => ipcRenderer.invoke('video:transcode', { data, audio, ...(opts || {}) }),
  /* 流式导出：渲染进程用 WebCodecs 逐帧编码，边产边写临时文件，最后一次性封装成 MP4。
     为什么要流式：① 长片不再把整段视频堆在内存里（10 分钟 4K ≈ 1.2 GB）；② 编码产物是
     Annex B 裸 H.264，主进程用 -c:v copy 直接封装，不再跑一遍 libx264 重编码。
     begin → 多次 write → end（或 abort）。 */
  videoExportBegin: (opts) => ipcRenderer.invoke('video:exportBegin', opts || {}),
  videoExportWrite: (id, data) => ipcRenderer.invoke('video:exportWrite', { id, data }),
  videoExportAbort: (id) => ipcRenderer.invoke('video:exportAbort', { id }),
  videoExportEnd: (opts) => ipcRenderer.invoke('video:exportEnd', opts || {}),
  // 「变谱」：乐谱（MusicXML/MXL）→ MIDI（返回 base64 字节 + 统计信息）
  scoreToMidi: (cfg) => ipcRenderer.invoke('score:toMidi', cfg || {}),
  scoreCancel: () => ipcRenderer.invoke('score:cancel'),
  onScoreProgress: (cb) => { const w = (_e, p) => cb(p); ipcRenderer.on('score:progress', w); return () => ipcRenderer.removeListener('score:progress', w); },
  // 识谱增强引擎（Audiveris）安装 / 检测
  omrEngine: {
    status: () => ipcRenderer.invoke('omr:status'),
    install: () => ipcRenderer.invoke('omr:install'),
    remove: () => ipcRenderer.invoke('omr:remove'),
    openDir: () => ipcRenderer.invoke('omr:openDir'),
    // OCR 语言包（Tesseract traineddata）：没有它 Audiveris 的 TEXTS 步整段跳过，
    // 速度记号 / 乐器名 / 和弦名都读不出来。
    langStatus: () => ipcRenderer.invoke('omr:langStatus'),
    langInstall: (codes) => ipcRenderer.invoke('omr:langInstall', codes),
    langRemove: (code) => ipcRenderer.invoke('omr:langRemove', code),
    // homr（AI 识谱）：用户自行安装的第二个识别引擎，装在数据根下的**独立 venv** 里
    // （homr 要 numpy>=2.4，应用自带的运行时是 1.26 —— 不隔离就会把引擎拆了）。
    homrStatus: () => ipcRenderer.invoke('omr:homrStatus'),
    homrInstall: () => ipcRenderer.invoke('omr:homrInstall'),
    homrRemove: () => ipcRenderer.invoke('omr:homrRemove'),
    // 超分辨率（waifu2x-ncnn-vulkan）：M3-2，低清扫描件专用；同样是**用户自行安装**
    srStatus: () => ipcRenderer.invoke('omr:srStatus'),
    srInstall: () => ipcRenderer.invoke('omr:srInstall'),
    srRemove: () => ipcRenderer.invoke('omr:srRemove'),
    // 音频处理模型的配置自愈：配置是**下载模型时**从上游取的（不内置），老安装可用它补一次
    modelEnsureConfig: (id) => ipcRenderer.invoke('model:ensureConfig', id),
    onProgress: (cb) => { const w = (_e, p) => cb(p); ipcRenderer.on('omr:progress', w); return () => ipcRenderer.removeListener('omr:progress', w); },
  },
  modelList: () => ipcRenderer.invoke('model:list'),
  depCheck: () => ipcRenderer.invoke('dep:check'),
  diagExport: () => ipcRenderer.invoke('diag:export'),
  diagHealth: () => ipcRenderer.invoke('diag:health'),
  // 问题反馈上传：预览（看将要上传什么）/ 保存本地 / 上传到反馈仓库 / 网页兜底
  feedback: {
    preview: (payload) => ipcRenderer.invoke('feedback:preview', payload),
    saveLocal: (payload) => ipcRenderer.invoke('feedback:saveLocal', payload),
    submit: (payload) => ipcRenderer.invoke('feedback:submit', payload),
    webFallback: (payload) => ipcRenderer.invoke('feedback:webFallback', payload),
  },
  exportScorePngZip: (opts) => ipcRenderer.invoke('score:exportPngZip', opts),

  updateCheck: (channel) => ipcRenderer.invoke('update:check', channel),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  appUninstall: () => ipcRenderer.invoke('app:uninstall'),
  // 开机自启
  autostartGet: () => ipcRenderer.invoke('app:autostart:get'),
  autostartSet: (open) => ipcRenderer.invoke('app:autostart:set', open),
  // 清除用户数据（模型/音色/播放类数据）
  clearUserData: (scopes) => ipcRenderer.invoke('app:clearUserData', scopes),
  // 数据目录（依赖 / 环境 / 模型 / 缓存的统一落点）
  dataRoot: () => ipcRenderer.invoke('system:dataRoot'),
  openDataRoot: (sub) => ipcRenderer.invoke('system:openDataRoot', sub),
  cleanTemp: () => ipcRenderer.invoke('system:cleanTemp'),
  // 曲目封面选择（返回 data URL）
  pickCover: () => ipcRenderer.invoke('sys:pickCover'),
  // 曲库文件（每个 MIDI 曲目对应的真实 .mid 文件）
  writeMidi: (opts) => ipcRenderer.invoke('library:writeMidi', opts),
  hasMidi: (p) => ipcRenderer.invoke('library:hasMidi', p),
  checkMidi: (items) => ipcRenderer.invoke('library:checkMidi', items),
  deleteMidi: (p) => ipcRenderer.invoke('library:deleteMidi', p),
  renameMidi: (p, name) => ipcRenderer.invoke('library:renameMidi', p, name),
  revealMidi: (p) => ipcRenderer.invoke('library:reveal', p),
  midiStats: () => ipcRenderer.invoke('library:stats'),
  verifyMidi: () => ipcRenderer.invoke('library:verify'),
  dupeMidi: () => ipcRenderer.invoke('library:dupes'),
  // 托盘控制（播放/暂停、下一首）
  /* ---- 操作系统级全局热键（设置 → 快捷键 → 全局热键）：用户自己录制 ---- */
  hotkeysGet: () => ipcRenderer.invoke('hotkeys:get'),
  hotkeysApply: (map) => ipcRenderer.invoke('hotkeys:apply', map),
  onHotkeyAction: (cb) => { const w = (_e, act) => cb(act); ipcRenderer.on('hotkey:action', w); return () => ipcRenderer.removeListener('hotkey:action', w); },
  onHotkeysState: (cb) => { const w = (_e, st) => cb(st); ipcRenderer.on('hotkeys:state', w); return () => ipcRenderer.removeListener('hotkeys:state', w); },
  onTrayControl: (cb) => { const w = (_e, act) => cb(act); ipcRenderer.on('tray:control', w); return () => ipcRenderer.removeListener('tray:control', w); },
  // 读取与指定音频/ midi 文件同目录的同名 .lrc 歌词（base64 传输，渲染端自解码）
  readSidecarLyrics: (filePath) => ipcRenderer.invoke('sys:readSidecarLyrics', filePath),
  updateNotes: (tag) => ipcRenderer.invoke('update:notes', tag),
  updateDownload: (url) => ipcRenderer.invoke('update:download', url),
  updateOpen: (p) => ipcRenderer.invoke('update:open', p),
  onUpdateProgress: (cb) => { const w = (_e, p) => cb(p); ipcRenderer.on('update:progress', w); return () => ipcRenderer.removeListener('update:progress', w); },
  // 线路测速（列表 / 逐个结果流式回传 / 记下首选线路）
  updateSources: (channel) => ipcRenderer.invoke('update:sources', channel),
  updateSpeedtest: (channel) => ipcRenderer.invoke('update:speedtest', channel),
  updateSetPreferredSource: (id) => ipcRenderer.invoke('update:setPreferredSource', id),
  onUpdateSpeedtest: (cb) => { const w = (_e, row) => cb(row); ipcRenderer.on('update:speedtest:progress', w); return () => ipcRenderer.removeListener('update:speedtest:progress', w); },

  depInstall: (group) => ipcRenderer.invoke('dep:install', group),

  modelDownload: (id, channel) => ipcRenderer.invoke('model:download', id, channel),
  modelCancel: (id) => ipcRenderer.invoke('model:cancel', id),
  modelPause: (id) => ipcRenderer.invoke('model:pause', id),
  modelDelete: (id) => ipcRenderer.invoke('model:delete', id),
  modelImportLocal: (p) => ipcRenderer.invoke('model:importLocal', p),
  pickModelArchive: () => ipcRenderer.invoke('dialog:pickModelArchive'),
  setFolderWatch: (dir, enabled) => ipcRenderer.invoke('folder:setWatch', dir, enabled),
  onFolderWatch: (cb) => { const w = (_e, p) => cb(p); ipcRenderer.on('folder-watch:file', w); return () => ipcRenderer.removeListener('folder-watch:file', w); },
  onModelProgress: (cb) => { const w = (_e, p) => cb(p); ipcRenderer.on('model:progress', w); return () => ipcRenderer.removeListener('model:progress', w); },
  // 歌单“导入文件夹”：返回目录下所有 .mid/.midi/.kar/.rmi 文件路径
  listMidiFiles: (dir) => ipcRenderer.invoke('dir:listMidiFiles', dir),
  // 读取本地文件（转录结果回载）
  readBinary: (p) => ipcRenderer.invoke('file:readBinary', p),
  // 保存二进制（WAV / MIDI 导出）：原生保存对话框 → fs 写盘
  saveBinary: (opts) => ipcRenderer.invoke('file:saveBinary', opts),
  // 打开输出位置（资源管理器/访达定位文件或目录）
  openOutput: (p) => ipcRenderer.invoke('shell:openOutput', p),
  // 声库导出：把 {name, base64} 文件列表写入用户选择的目录
  utauExportVoicebank: (opts) => ipcRenderer.invoke('utau:exportVoicebank', opts),
  // 声库导出压缩包：把 {name, base64} 文件列表由主进程打包为 zip 并保存
  utauExportVoicebankZip: (opts) => ipcRenderer.invoke('utau:exportVoicebankZip', opts),
  // UTAU 工程渲染：渲染人声 WAV，返回字节供预览
  utauRenderTrack: (cfg) => ipcRenderer.invoke('utau:renderTrack', cfg),
  // UTAU 引擎支持的 flags 一览（默认值/范围/说明，供 UI 展示）
  utauFlags: () => ipcRenderer.invoke('utau:flags'),
  // 声库可用别名（P1-4 发音/别名替换）
  utauAliases: (cfg) => ipcRenderer.invoke('utau:aliases', cfg),
  // M8f：别名表可编辑 —— 读原始字节 / 写回（写回前主进程自动备份 oto.ini.bak）
  utauReadOto: (cfg) => ipcRenderer.invoke('utau:readOto', cfg),
  /** M8 音域热力图：每个别名的录制音高 */
  utauAliasRange: (cfg) => ipcRenderer.invoke('utau:aliasRange', cfg),
  utauSaveOto: (cfg) => ipcRenderer.invoke('utau:saveOto', cfg),
  // 汉字 → 拼音（调教页 · 中文 UTAU 声库）：token 数组进、音节数组出
  singToPinyin: (cfg) => ipcRenderer.invoke('sing:toPinyin', cfg),
  // 声库体检（调教页 · 声库面板）：目录/编码/别名/缺采样/歌词覆盖一次算清
  probeVoicebank: (cfg) => ipcRenderer.invoke('sing:probeVoicebank', cfg),
  // 已导入声库列表 / 导入现成声库 zip
  utauListVoicebanks: () => ipcRenderer.invoke('utau:listVoicebanks'),
  utauImportVoicebankZip: (directPath) => ipcRenderer.invoke('utau:importVoicebankZip', directPath),
  modelImportGsvVoice: (directPath) => ipcRenderer.invoke('model:importGsvVoice', directPath),
  // 声库资源中心：可一键安装的开源/免费声库清单、下载安装、取消
  utauVoicebankRegistry: () => ipcRenderer.invoke('utau:voicebankRegistry'),
  utauDownloadVoicebank: (id) => ipcRenderer.invoke('utau:downloadVoicebank', id),
  utauCancelVoicebankDownload: (id) => ipcRenderer.invoke('utau:cancelVoicebankDownload', id),
  onVoicebankProgress: (cb) => { const w = (_e, p) => cb(p); ipcRenderer.on('utau:voicebankProgress', w); return () => ipcRenderer.removeListener('utau:voicebankProgress', w); },
  // DiffSinger 模块化集成：启用开关 / 组件安装 / 声库管理 / 渲染（未启用时零下载）
  diffsingerStatus: (opts) => ipcRenderer.invoke('diffsinger:status', opts),
  diffsingerSetEnabled: (on) => ipcRenderer.invoke('diffsinger:setEnabled', on),
  diffsingerInstallRuntime: () => ipcRenderer.invoke('diffsinger:installRuntime'),
  diffsingerCancelRuntimeInstall: () => ipcRenderer.invoke('diffsinger:cancelRuntimeInstall'),
  diffsingerUninstallRuntime: (opts) => ipcRenderer.invoke('diffsinger:uninstallRuntime', opts),
  diffsingerListVoicebanks: () => ipcRenderer.invoke('diffsinger:listVoicebanks'),
  diffsingerImportVoicebankZip: (directPath) => ipcRenderer.invoke('diffsinger:importVoicebankZip', directPath),
  diffsingerDeleteVoicebank: (dir) => ipcRenderer.invoke('diffsinger:deleteVoicebank', dir),
  // 文件关联开关（主进程有 settings:fileAssoc，但这里一直漏了暴露 ——
  // 设置里的开关调用点还带 `if (bridge.fileAssoc)` 保护，于是**点了完全没反应、也不报错**。
  fileAssoc: (enabled) => ipcRenderer.invoke('settings:fileAssoc', enabled),
  // UTAU 声库删除（主进程有 utau:deleteVoicebank，同样漏了暴露）；
  // 这个调用点**没有** guard，所以点「删除声库」会直接抛 TypeError。
  utauDeleteVoicebank: (dir) => ipcRenderer.invoke('utau:deleteVoicebank', dir),
  // 顶层 openExternal 别名：有 5 处按顶层调用（SettingsPanel 的 GitHub 反馈/已知问题、
  // ViewModels、ViewSoundfonts），而它只挂在 update.openExternal 下 ——
  // 那些调用点都带 `if (bridge.openExternal)` 保护，于是**静默不打开浏览器**。
  openExternal: (url) => ipcRenderer.invoke('update:openExternal', url),
  diffsingerVoicebankRegistry: () => ipcRenderer.invoke('diffsinger:voicebankRegistry'),
  diffsingerDownloadVoicebank: (id) => ipcRenderer.invoke('diffsinger:downloadVoicebank', id),
  diffsingerCancelVoicebankDownload: (id) => ipcRenderer.invoke('diffsinger:cancelVoicebankDownload', id),
  diffsingerMsCatalog: () => ipcRenderer.invoke('diffsinger:msCatalog'),
  diffsingerMsDownload: (cfg) => ipcRenderer.invoke('diffsinger:msDownload', cfg),
  diffsingerMsCancelDownload: (name) => ipcRenderer.invoke('diffsinger:msCancelDownload', name),
  diffsingerInspectVoicebank: (cfg) => ipcRenderer.invoke('diffsinger:inspectVoicebank', cfg),
  diffsingerVocoders: () => ipcRenderer.invoke('diffsinger:vocoders'),
  diffsingerSpeakers: () => ipcRenderer.invoke('diffsinger:speakers'),
  diffsingerRender: (cfg) => ipcRenderer.invoke('diffsinger:render', cfg),
  // 统一声库清单（UTAU + DiffSinger 融合）：音频制作侧可切换两类声库
  voicebankUnified: () => ipcRenderer.invoke('voicebank:unified'),
  onDiffsingerRuntimeProgress: (cb) => { const w = (_e, p) => cb(p); ipcRenderer.on('diffsinger:runtimeProgress', w); return () => ipcRenderer.removeListener('diffsinger:runtimeProgress', w); },
  onDiffsingerVoicebankProgress: (cb) => { const w = (_e, p) => cb(p); ipcRenderer.on('diffsinger:voicebankProgress', w); return () => ipcRenderer.removeListener('diffsinger:voicebankProgress', w); },
  onDiffsingerMsProgress: (cb) => { const w = (_e, p) => cb(p); ipcRenderer.on('diffsinger:msProgress', w); return () => ipcRenderer.removeListener('diffsinger:msProgress', w); },
  onDiffsingerRenderProgress: (cb) => { const w = (_e, p) => cb(p); ipcRenderer.on('diffsinger:renderProgress', w); return () => ipcRenderer.removeListener('diffsinger:renderProgress', w); },
  pathForFile: (f) => filePathFor(f),
  openEditGuide: () => ipcRenderer.invoke('guide:openEdit'),
  // 转录参数预设
  presets: {
    list: () => ipcRenderer.invoke('presets:list'),
    save: (name, mode, params) => ipcRenderer.invoke('presets:save', name, mode, params),
    delete: (name) => ipcRenderer.invoke('presets:delete', name),
    lastUsed: (name) => ipcRenderer.invoke('presets:lastUsed', name),
    reorder: (name, delta) => ipcRenderer.invoke('presets:reorder', name, delta),
    reorderTo: (name, index) => ipcRenderer.invoke('presets:reorderTo', name, index),
    setModelPreset: (key, name) => ipcRenderer.invoke('presets:setModelPreset', key, name),
    restore: () => ipcRenderer.invoke('presets:restore'),
  },
  // 插件系统
  gpuInstallAuto: () => ipcRenderer.invoke('gpu:installAuto'),
  gpuPackageUrl: (kind) => ipcRenderer.invoke('gpu:packageUrl', kind),
  gpuListPackages: () => ipcRenderer.invoke('gpu:listPackages'),
  gpuImportLocal: (p, kind) => ipcRenderer.invoke('gpu:importLocal', p, kind),
  gpuStatus: () => ipcRenderer.invoke('gpu:status'),
  gpuUninstall: (kind) => ipcRenderer.invoke('gpu:uninstall', kind),
  gpuCancelInstall: () => ipcRenderer.invoke('gpu:cancelInstall'),
  pickZip: () => ipcRenderer.invoke('dialog:pickZip'),
  gpuDownloadPackage: (opts) => ipcRenderer.invoke('gpu:downloadPackage', opts),
  onGpuProgress: (cb) => { const w = (_e, p) => cb(p); ipcRenderer.on('gpu:progress', w); return () => ipcRenderer.removeListener('gpu:progress', w); },
  update: {
    list: () => ipcRenderer.invoke('update:list'),
    openExternal: (url) => ipcRenderer.invoke('update:openExternal', url),
    launchUpdater: (channel) => ipcRenderer.invoke('update:launchUpdater', channel),
    sources: (channel) => ipcRenderer.invoke('update:sources', channel),
    speedtest: (channel) => ipcRenderer.invoke('update:speedtest', channel),
    setPreferredSource: (id) => ipcRenderer.invoke('update:setPreferredSource', id),
    onSpeedtest: (cb) => { const w = (_e, row) => cb(row); ipcRenderer.on('update:speedtest:progress', w); return () => ipcRenderer.removeListener('update:speedtest:progress', w); },
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    setEnabled: (id, enabled) => ipcRenderer.invoke('plugins:setEnabled', id, enabled),
    invoke: (id, cmd, payload) => ipcRenderer.invoke('plugins:invoke', id, cmd, payload),
    rescan: () => ipcRenderer.invoke('plugins:rescan'),
    openDocs: () => ipcRenderer.invoke('plugins:openDocs'),
    // 插件网（第三方作者发布插件的地方）
    openPlatform: (rel) => ipcRenderer.invoke('plugins:openPlatform', rel),
    platformInfo: () => ipcRenderer.invoke('plugins:platformInfo'),
    openDir: () => ipcRenderer.invoke('plugins:openDir'),
    // 插件市场安装：两段式，download 只落缓存并返回包内清单，确认后才 install
    // 插件中心目录（主进程代取，避免渲染进程直连撞 CSP/CORS）
    catalog: (channel) => ipcRenderer.invoke('plugins:catalog', channel),
    installFromPlatform: (slug, version) => ipcRenderer.invoke('plugins:installFromPlatform', slug, version),
    confirmInstall: (token, overwrite) => ipcRenderer.invoke('plugins:confirmInstall', token, overwrite),
    cancelInstall: (token) => ipcRenderer.invoke('plugins:cancelInstall', token),
    installedList: () => ipcRenderer.invoke('plugins:installedList'),
    onUi: (cb) => { const w = (_e, p) => cb(p); ipcRenderer.on('plugins:ui', w); return () => ipcRenderer.removeListener('plugins:ui', w); },
    onLog: (cb) => { const w = (_e, p) => cb(p); ipcRenderer.on('plugins:log', w); return () => ipcRenderer.removeListener('plugins:log', w); },
    onScript: (cb) => { const w = (_e, p) => cb(p); ipcRenderer.on('plugins:script', w); return () => ipcRenderer.removeListener('plugins:script', w); },
  },
  // 动态壁纸
  wallpaper: {
    defaults: () => ipcRenderer.invoke('wallpaper:defaults'),
    list: () => ipcRenderer.invoke('wallpaper:list'),
    download: (url, name) => ipcRenderer.invoke('wallpaper:download', url, name),
    addLocal: (path) => ipcRenderer.invoke('wallpaper:addLocal', path),
    onAddLocalProgress: (cb) => {
      const listener = (_e, p) => cb(p);
      ipcRenderer.on('wallpaper:addLocalProgress', listener);
      return () => ipcRenderer.removeListener('wallpaper:addLocalProgress', listener);
    },
    onDownloadProgress: (cb) => {
      const listener = (_e, p) => cb(p);
      ipcRenderer.on('wallpaper:downloadProgress', listener);
      return () => ipcRenderer.removeListener('wallpaper:downloadProgress', listener);
    },
    removeLocal: (name) => ipcRenderer.invoke('wallpaper:removeLocal', name),
  },
  // 可选 Rust 核心
  rustStatus: () => ipcRenderer.invoke('rust:status'),
  rustInvoke: (cmd, args) => ipcRenderer.invoke('rust:invoke', cmd, args),
  // SQLite persistence service
  dbStatus: () => ipcRenderer.invoke('db:status'),
  dbKvGet: (key) => ipcRenderer.invoke('db:kv:get', key),
  dbKvSet: (key, value) => ipcRenderer.invoke('db:kv:set', key, value),
  dbSongsList: () => ipcRenderer.invoke('db:songs:list'),
  dbSongsPut: (item) => ipcRenderer.invoke('db:songs:put', item),
  dbSongsDelete: (id) => ipcRenderer.invoke('db:songs:delete', id),
  dbPlaylistsList: () => ipcRenderer.invoke('db:playlists:list'),
  dbPlaylistsPut: (item) => ipcRenderer.invoke('db:playlists:put', item),
  dbPlaylistsDelete: (id) => ipcRenderer.invoke('db:playlists:delete', id),
  // 云同步下发的曲目落盘到独立目录（与本地曲库分开）
  dbCloudSongPut: (name, bytes) => ipcRenderer.invoke('db:cloud-song:put', name, bytes),
  dbCloudSongDir: () => ipcRenderer.invoke('db:cloud-song:dir'),
  // 应用事件通知（song-loaded / view-changed 等 → 插件事件钩子）
  notify: (ev, payload) => ipcRenderer.send('app:event', ev, payload),
  // 歌声工程文件（.fufumidi 自包含包）：只传清单与源路径，音频字节由主进程读盘
  project: {
    save: (payload) => ipcRenderer.invoke('project:save', payload),
    open: () => ipcRenderer.invoke('project:open'),
    // OpenUtau .ustx 互转（转换在 Python 引擎，见 engine/engine_ustx.py）
    importUstx: () => ipcRenderer.invoke('project:importUstx'),
    exportUstx: (payload) => ipcRenderer.invoke('project:exportUstx', payload),
    // 分轨导出：伴奏源文件主进程直拷（字节不过 IPC）
    copyAsset: (payload) => ipcRenderer.invoke('project:copyAsset', payload),
    // P0-2 自动保存草稿：只写数据根 temp/autosave/，绝不覆盖用户工程文件
    autosaveWrite: (payload) => ipcRenderer.invoke('autosave:write', payload),
    autosaveList: () => ipcRenderer.invoke('autosave:list'),
    autosaveRead: (docId) => ipcRenderer.invoke('autosave:read', docId),
    autosaveClear: (docId) => ipcRenderer.invoke('autosave:clear', docId),
  },
  // ★ 顶层别名：上面这个 copyAsset 挂在 project.* 下，但 singer.ts:1490 是按
  //   `b.copyAsset(...)`（顶层）调的 —— 拿到 undefined，靠 typeof guard 静默降级成
  //   「当前版本不支持伴奏复制」。契约所有者是 preload，所以在这里补顶层入口。
  //   （与 openExternal 同一类：嵌套命名空间 vs 顶层访问的错配。）
  copyAsset: (payload) => ipcRenderer.invoke('project:copyAsset', payload),
  // 歌词建议：主进程有 diffsinger:suggestLyric，但一直没暴露 ——
  // ViewSing.vue 调 bridge.diffsingerSuggestLyric() 会直接拿 undefined。
  diffsingerSuggestLyric: (payload) => ipcRenderer.invoke('diffsinger:suggestLyric', payload),
});
