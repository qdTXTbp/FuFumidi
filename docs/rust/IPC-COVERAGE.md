# Tauri IPC 覆盖（静态统计）

> 由 `node scripts/tauri/ipc-coverage.mjs --write` 生成；只统计桥方法名，不启动窗口。

| 指标 | 数值 |
|---|---:|
| preload 暴露方法 | 265 |
| Tauri 桥已映射方法 | 104 |
| 尚未映射 | **161** |
| preload IPC invoke 通道 | 250 |
| Tauri call 通道 | 95 |

## 缺口分类

| 分类 | 数量 |
|---|---:|
| 设置/杂项 | 28 |
| diffsinger | 19 |
| utau/voicebank | 18 |
| 模型/安装/平台 | 14 |
| 导出/渲染 | 14 |
| 资源/音频/扩展 | 13 |
| rvc | 12 |
| 事件/窗口 | 10 |
| 文件/诊断 | 9 |
| gpu/运行时增强 | 8 |
| 曲库/数据 | 6 |
| 更新/测速 | 6 |
| 其他 | 4 |

## 尚未映射的方法

```text
appUninstall
audioDuration
autosaveClear
autosaveList
autosaveRead
autosaveWrite
autostartGet
autostartSet
cancelInstall
catalog
cleanup
clearFinished
clearUserData
confirmInstall
copyAsset
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
diagHealth
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
exportAudio
exportDawproject
exportScorePdfPages
exportStemsZip
exportUstx
generate
getZoomFactor
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
modelImportLocal
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
open
openFolder
openPlatform
pathForFile
pickCover
pickDir
pickModelArchive
pin
platformInfo
preview
probeVoicebank
readSidecarLyrics
renderFile
rendererReady
report
revealMidi
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
scanFolder
scoreCancel
scoreToMidi
searchWallhaven
separateAudio
set
setDesktop
setFullScreen
setPreferredSource
setZoomFactor
singToPinyin
sources
speedtest
srInstall
srRemove
srStatus
status
submit
takePendingOpenFile
updateSetPreferredSource
updateSources
updateSpeedtest
utauAliasRange
utauAliases
utauCancelVoicebankDownload
utauDeleteVoicebank
utauDownloadVoicebank
utauExportVoicebank
utauExportVoicebankZip
utauFlags
utauImportVoicebankZip
utauListVoicebanks
utauReadOto
utauRenderTrack
utauSaveOto
utauVoicebankRegistry
videoExportAbort
videoExportBegin
videoExportEnd
videoExportWrite
view
voicebankUnified
webFallback
writeBinary
writeMidi
```

说明：统计是**方法名**级别，可能有少数同名嵌套/别名误差；以桥适配层实际调用为准。
