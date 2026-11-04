# 前端 bridge.* 调用 vs Tauri 桥（静态审计）

> 由 `node scripts/tauri/bridge-call-audit.mjs --write` 生成；只解析源码，不启动窗口。
> 这是**启发式**审计：动态拼接、可选守卫和事件回调可能造成少量误报。

| 指标 | 数值 |
|---|---:|
| 前端调用的 bridge 方法（去重） | 212 |
| Tauri 顶层方法 | 95 |
| Tauri 嵌套方法 | 43 |
| **未找到实现** | **108** |

## 未找到实现的方法

- `appUninstall` — frontend/src/components/SettingsPanel.vue
- `coverCancel` — frontend/src/views/ViewCover.vue
- `coverOpen` — frontend/src/views/ViewCover.vue
- `coverPickAudio` — frontend/src/views/ViewCover.vue
- `coverPickDir` — frontend/src/views/ViewCover.vue
- `coverRun` — frontend/src/views/ViewCover.vue
- `coverSingers` — frontend/src/views/ViewCover.vue
- `diffsingerMsCancelDownload` — frontend/src/App.vue, frontend/src/views/DiffSingerCatalog.vue
- `diffsingerMsCatalog` — frontend/src/views/DiffSingerCatalog.vue, frontend/src/views/ViewModels.vue
- `diffsingerMsDownload` — frontend/src/views/DiffSingerCatalog.vue
- `e2e` — frontend/src/audio.js
- `gpuCancelInstall` — frontend/src/components/SettingsPanel.vue
- `gpuUnifiedMemoryExperiment` — frontend/src/views/ViewTranscribe.vue
- `omrEngine` — frontend/src/views/ViewResources.vue
- `omrEngine.homrInstall` — frontend/src/views/ViewResources.vue
- `omrEngine.homrRemove` — frontend/src/views/ViewResources.vue
- `omrEngine.homrStatus` — frontend/src/views/ViewResources.vue
- `omrEngine.install` — frontend/src/views/ViewResources.vue
- `omrEngine.langInstall` — frontend/src/views/ViewResources.vue
- `omrEngine.langRemove` — frontend/src/views/ViewResources.vue
- `omrEngine.langStatus` — frontend/src/views/ViewResources.vue
- `omrEngine.onProgress` — frontend/src/views/ViewResources.vue
- `omrEngine.openDir` — frontend/src/views/ViewResources.vue
- `omrEngine.remove` — frontend/src/views/ViewResources.vue
- `omrEngine.srInstall` — frontend/src/views/ViewResources.vue
- `omrEngine.srRemove` — frontend/src/views/ViewResources.vue
- `omrEngine.srStatus` — frontend/src/views/ViewResources.vue
- `omrEngine.status` — frontend/src/views/ViewResources.vue
- `onCoverProgress` — frontend/src/views/ViewCover.vue
- `onFolderWatch` — frontend/src/components/SettingsPanel.vue
- `onOpenFile` — frontend/src/App.vue
- `onSeparateLog` — frontend/src/views/ViewTranscribe.vue
- `onSeparateProgress` — frontend/src/views/ViewTranscribe.vue
- `onSpeedtest` — frontend/src/components/SettingsPanel.vue
- `onStemProgress` — frontend/src/views/ViewTranscribe.vue
- `onTrayControl` — frontend/src/App.vue
- `onVoicebankProgress` — frontend/src/components/utau/UtauVoicebankStore.vue
- `plugin` — frontend/src/views/ViewConvert.vue
- `plugin.pickAudio` — frontend/src/views/ViewConvert.vue
- `plugin.pickFile` — frontend/src/views/ViewConvert.vue
- `plugin.renderFile` — frontend/src/views/ViewConvert.vue
- `plugin.savePath` — frontend/src/views/ViewConvert.vue
- `plugins` — frontend/src/views/PluginCenter.vue
- `plugins.cancelInstall` — frontend/src/views/PluginCenter.vue
- `plugins.catalog` — frontend/src/views/PluginCenter.vue
- `plugins.confirmInstall` — frontend/src/views/PluginCenter.vue
- `plugins.installFromPlatform` — frontend/src/views/PluginCenter.vue
- `plugins.installedList` — frontend/src/views/PluginCenter.vue
- `plugins.openPlatform` — frontend/src/views/PluginCenter.vue
- `plugins.platformInfo` — frontend/src/views/PluginCenter.vue
- `presets` — frontend/src/views/ViewTranscribe.vue
- `probeVoicebank` — frontend/src/components/sing/VoicebankPanel.vue
- `project` — frontend/src/views/ViewEdit.vue
- `project.autosave` — frontend/src/core/session.js
- `rvcCatalog` — frontend/src/components/cover/RvcModelPanel.vue
- `rvcImportFiles` — frontend/src/components/cover/RvcModelPanel.vue, frontend/src/views/ViewCover.vue
- `rvcImportFolder` — frontend/src/components/cover/RvcModelPanel.vue, frontend/src/views/ViewCover.vue
- `rvcImportZip` — frontend/src/components/cover/RvcModelPanel.vue, frontend/src/views/ViewCover.vue
- `rvcList` — frontend/src/components/cover/RvcModelPanel.vue
- `rvcOpenCatalogPage` — frontend/src/components/cover/RvcModelPanel.vue
- `rvcPickFiles` — frontend/src/components/cover/RvcModelPanel.vue, frontend/src/views/ViewCover.vue
- `rvcPickFolder` — frontend/src/components/cover/RvcModelPanel.vue, frontend/src/views/ViewCover.vue
- `rvcPickZip` — frontend/src/components/cover/RvcModelPanel.vue, frontend/src/views/ViewCover.vue
- `rvcProbe` — frontend/src/components/cover/RvcModelPanel.vue
- `rvcRefreshCatalog` — frontend/src/components/cover/RvcModelPanel.vue
- `rvcRemove` — frontend/src/components/cover/RvcModelPanel.vue
- `separateAudio` — frontend/src/views/ViewTranscribe.vue
- `sfWorkshop` — frontend/src/views/ViewSoundfonts.vue
- `soundfonts` — frontend/src/audio.js
- `soundfonts.list` — frontend/src/audio.js
- `storage` — frontend/src/components/StoragePanel.vue
- `takePendingOpenFile` — frontend/src/App.vue
- `tasks` — frontend/src/App.vue
- `tasks.list` — frontend/src/App.vue
- `tasks.onUpdate` — frontend/src/App.vue
- `update` — frontend/src/App.vue, frontend/src/components/SettingsPanel.vue
- `updateSetPreferredSource` — frontend/src/components/SettingsPanel.vue
- `updateSources` — frontend/src/components/SettingsPanel.vue
- `updateSpeedtest` — frontend/src/components/SettingsPanel.vue
- `usermeta` — frontend/src/views/ViewSoundfonts.vue
- `usermeta.list` — frontend/src/views/ViewSoundfonts.vue
- `usermeta.remove` — frontend/src/views/ViewSoundfonts.vue
- `usermeta.set` — frontend/src/components/models/ItemMetaEditor.vue, frontend/src/views/ViewSoundfonts.vue
- `utauAliasRange` — frontend/src/components/sing/VoicebankPanel.vue
- `utauCancelVoicebankDownload` — frontend/src/components/utau/UtauVoicebankStore.vue
- `utauDeleteVoicebank` — frontend/src/components/utau/UtauVoicebankStore.vue
- `utauDownloadVoicebank` — frontend/src/components/utau/UtauVoicebankStore.vue
- `utauExportVoicebank` — frontend/src/views/ViewVoicebank.vue
- `utauExportVoicebankZip` — frontend/src/views/ViewVoicebank.vue
- `utauImportVoicebankZip` — frontend/src/components/utau/UtauVoicebankStore.vue
- `utauReadOto` — frontend/src/components/sing/VoicebankPanel.vue
- `utauRenderTrack` — frontend/src/components/sing/VoicebankPanel.vue
- `utauSaveOto` — frontend/src/components/sing/VoicebankPanel.vue
- `utauVoicebankRegistry` — frontend/src/components/utau/UtauVoicebankStore.vue
- `videoExportAbort` — frontend/src/views/ViewConvert.vue
- `videoExportBegin` — frontend/src/views/ViewConvert.vue
- `videoExportEnd` — frontend/src/views/ViewConvert.vue
- `videoExportWrite` — frontend/src/views/ViewConvert.vue
- `voicebankUnified` — frontend/src/components/utau/VoicebankPicker.vue
- `wallpaper` — frontend/src/components/WallpaperGallery.vue, frontend/src/components/WallpaperLibrary.vue
- `wallpaper.downloadUrl` — frontend/src/components/WallpaperLibrary.vue
- `wallpaper.scanFolder` — frontend/src/components/WallpaperLibrary.vue
- `wallpaper.searchWallhaven` — frontend/src/components/WallpaperLibrary.vue
- `wallpaperEngine` — frontend/src/App.vue, frontend/src/components/WallpaperEnginePanel.vue
- `wallpaperEngine.detect` — frontend/src/components/WallpaperEnginePanel.vue
- `wallpaperEngine.inventory` — frontend/src/components/WallpaperEnginePanel.vue
- `wallpaperEngine.openFolder` — frontend/src/components/WallpaperEnginePanel.vue
- `wallpaperEngine.view` — frontend/src/App.vue

## 说明

顶层别名（如 copyAsset/openExternal）是对 Electron preload 调用习惯的兼容层；嵌套调用（bridge.storage.report）按 parent.child 匹配。
