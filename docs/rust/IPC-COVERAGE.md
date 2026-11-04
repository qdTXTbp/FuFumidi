# Tauri IPC 覆盖（静态统计）

> 由 `node scripts/tauri/ipc-coverage.mjs --write` 生成；只统计桥方法名，不启动窗口。

| 指标 | 数值 |
|---|---:|
| preload 暴露方法 | 265 |
| Tauri 桥已映射方法 | 183 |
| 尚未映射 | **83** |
| preload IPC invoke 通道 | 250 |
| Tauri call 通道 | 174 |

## 缺口分类

| 分类 | 数量 |
|---|---:|
| diffsinger | 19 |
| 设置/杂项 | 17 |
| utau/voicebank | 10 |
| 导出/渲染 | 7 |
| gpu/运行时增强 | 7 |
| 模型/安装/平台 | 6 |
| 事件/窗口 | 6 |
| 更新/测速 | 4 |
| 文件/诊断 | 3 |
| 曲库/数据 | 2 |
| 其他 | 2 |

## 尚未映射的方法

```text
appUninstall
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
homrInstall
homrRemove
homrStatus
hotkeysApply
hotkeysGet
importUstx
install
inventory
langInstall
langRemove
langStatus
modelEnsureConfig
onDiffsingerMsProgress
onDiffsingerRenderProgress
onDiffsingerRuntimeProgress
onDiffsingerVoicebankProgress
onHotkeyAction
onHotkeysState
onScoreProgress
onSpeedtest
onTrayControl
onUpdateSpeedtest
onVoicebankProgress
openFolder
pathForFile
pickDir
preview
probeVoicebank
renderFile
rendererReady
saveLocal
savePath
scoreCancel
scoreToMidi
searchWallhaven
setPreferredSource
singToPinyin
sources
speedtest
srInstall
srRemove
srStatus
status
submit
updateSpeedtest
utauAliasRange
utauAliases
utauCancelVoicebankDownload
utauDownloadVoicebank
utauFlags
utauRenderTrack
utauVoicebankRegistry
view
webFallback
```

说明：统计是**方法名**级别，可能有少数同名嵌套/别名误差；以桥适配层实际调用为准。
