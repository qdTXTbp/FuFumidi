# Tauri IPC 覆盖（静态统计）

> 由 `node scripts/tauri/ipc-coverage.mjs --write` 生成；只统计桥方法名，不启动窗口。

| 指标 | 数值 |
|---|---:|
| preload 暴露方法 | 265 |
| Tauri 桥已映射方法 | 144 |
| 尚未映射 | **122** |
| preload IPC invoke 通道 | 250 |
| Tauri call 通道 | 138 |

## 缺口分类

| 分类 | 数量 |
|---|---:|
| diffsinger | 19 |
| 设置/杂项 | 17 |
| 模型/安装/平台 | 13 |
| rvc | 12 |
| 资源/音频/扩展 | 11 |
| 导出/渲染 | 11 |
| utau/voicebank | 11 |
| gpu/运行时增强 | 8 |
| 事件/窗口 | 7 |
| 更新/测速 | 4 |
| 文件/诊断 | 4 |
| 其他 | 3 |
| 曲库/数据 | 2 |

## 尚未映射的方法

```text
appUninstall
cancelInstall
catalog
clearFinished
confirmInstall
coverCancel
coverOpen
coverPickAudio
coverPickDir
coverRun
coverSingers
dbCloudSongDir
dbCloudSongPut
demo
detect
diffsingerCancelRuntimeInstall
diffsingerCancelVoicebankDownload
diffsingerDeleteVoicebank
diffsingerDownloadVoicebank
diffsingerImportVoicebankZip
diffsingerInspectVoicebank
diffsingerInstallRuntime
diffsingerListVoicebanks
diffsingerMsCancelDownload
diffsingerMsCatalog
diffsingerMsDownload
diffsingerRender
diffsingerSetEnabled
diffsingerSpeakers
diffsingerStatus
diffsingerSuggestLyric
diffsingerUninstallRuntime
diffsingerVocoders
diffsingerVoicebankRegistry
downloadUrl
exportScorePdfPages
exportUstx
generate
gpuCancelInstall
gpuUnifiedMemoryExperiment
homrInstall
homrRemove
homrStatus
hotkeysApply
hotkeysGet
importUstx
install
installFromPlatform
installedList
inventory
langInstall
langRemove
langStatus
modelEnsureConfig
onCoverProgress
onDiffsingerMsProgress
onDiffsingerRenderProgress
onDiffsingerRuntimeProgress
onDiffsingerVoicebankProgress
onHotkeyAction
onHotkeysState
onScoreProgress
onSeparateLog
onSeparateProgress
onSpeedtest
onStemProgress
onTrayControl
onUpdate
onUpdateSpeedtest
onVoicebankProgress
openFolder
openPlatform
pathForFile
pickDir
platformInfo
preview
probeVoicebank
renderFile
rendererReady
rvcCatalog
rvcImportFiles
rvcImportFolder
rvcImportZip
rvcList
rvcOpenCatalogPage
rvcPickFiles
rvcPickFolder
rvcPickZip
rvcProbe
rvcRefreshCatalog
rvcRemove
saveLocal
savePath
scoreCancel
scoreToMidi
searchWallhaven
separateAudio
setPreferredSource
singToPinyin
sources
speedtest
srInstall
srRemove
srStatus
status
submit
takePendingOpenFile
updateSpeedtest
utauAliasRange
utauAliases
utauCancelVoicebankDownload
utauDownloadVoicebank
utauExportVoicebankZip
utauFlags
utauRenderTrack
utauVoicebankRegistry
videoExportAbort
videoExportBegin
videoExportEnd
videoExportWrite
view
webFallback
```

说明：统计是**方法名**级别，可能有少数同名嵌套/别名误差；以桥适配层实际调用为准。
