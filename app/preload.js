// Preload 桥接：主进程 ↔ 渲染进程（fuBridge）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fuBridge', {
  // 打开文件（双击 .mid 关联）
  onOpenFile: (cb) => {
    const w = (_e, bytes, name) => cb(new Uint8Array(bytes), name);
    ipcRenderer.on('open-file', w);
    return () => ipcRenderer.removeListener('open-file', w);
  },
  // 转录引擎
  convert: (cfg) => ipcRenderer.invoke('engine:convert', cfg),
  cancel: (id) => ipcRenderer.invoke('engine:cancel', id),
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
  pickMusicXML: () => ipcRenderer.invoke('dialog:pickMusicXML'),
  exportScorePdf: () => ipcRenderer.invoke('score:exportPdf'),
  // 歌单“导入文件夹”：返回目录下所有 .mid/.midi/.kar/.rmi 文件路径
  listMidiFiles: (dir) => ipcRenderer.invoke('dir:listMidiFiles', dir),
  // 读取本地文件（转录结果回载）
  readBinary: (p) => ipcRenderer.invoke('file:readBinary', p),
  // 保存二进制（WAV / MIDI 导出）：原生保存对话框 → fs 写盘
  saveBinary: (opts) => ipcRenderer.invoke('file:saveBinary', opts),
  // 打开输出位置（资源管理器/访达定位文件或目录）
  openOutput: (p) => ipcRenderer.invoke('shell:openOutput', p),
  // 转录参数预设
  presets: {
    list: () => ipcRenderer.invoke('presets:list'),
    save: (name, mode, params) => ipcRenderer.invoke('presets:save', name, mode, params),
    delete: (name) => ipcRenderer.invoke('presets:delete', name),
    lastUsed: (name) => ipcRenderer.invoke('presets:lastUsed', name),
    reorder: (name, delta) => ipcRenderer.invoke('presets:reorder', name, delta),
    reorderTo: (name, index) => ipcRenderer.invoke('presets:reorderTo', name, index),
    restore: () => ipcRenderer.invoke('presets:restore'),
  },
  // 插件系统
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    setEnabled: (id, enabled) => ipcRenderer.invoke('plugins:setEnabled', id, enabled),
    invoke: (id, cmd, payload) => ipcRenderer.invoke('plugins:invoke', id, cmd, payload),
    rescan: () => ipcRenderer.invoke('plugins:rescan'),
    openDocs: () => ipcRenderer.invoke('plugins:openDocs'),
    onUi: (cb) => { const w = (_e, p) => cb(p); ipcRenderer.on('plugins:ui', w); return () => ipcRenderer.removeListener('plugins:ui', w); },
    onLog: (cb) => { const w = (_e, p) => cb(p); ipcRenderer.on('plugins:log', w); return () => ipcRenderer.removeListener('plugins:log', w); },
    onScript: (cb) => { const w = (_e, p) => cb(p); ipcRenderer.on('plugins:script', w); return () => ipcRenderer.removeListener('plugins:script', w); },
  },
  // 应用事件通知（song-loaded / view-changed 等 → 插件事件钩子）
  notify: (ev, payload) => ipcRenderer.send('app:event', ev, payload),
});
