# FuMiVoice 只读审计与演进方案

> 审计对象：`E:\Midi\_attic\FuMiVoice-Source`（1.0.10，versionCode 11；本轮升级到 1.0.11）
> 审计方式：**只读**静态审计（未修改任何被审计逻辑）+ Kotlin PSI 全量语法核验
> 参考：电脑端 FuFumidi（同一套设计语言）、Android 官方指南、市面钢琴卷帘类应用
> 日期：2026-10-29
> 说明：本机**没有 Android SDK / NDK**，未做编译与真机验证；所有"会崩/会卡"的判断都来自代码路径与 API 语义，不是实测帧率。阻塞项见 §14。

---

## 0. 结论摘要

**完成度**：56 个 Kotlin 文件、16,345 行（含 BASS 官方 Java 绑定），功能面已经超过同体量开源 MIDI 播放器——四格式导出、通道混音台、10 段均衡器、节拍器、画中画、桌面小组件、云同步、在线音色库下载，而且**文案全部走资源、中英 341 条成对**（`values/strings.xml` 与 `values-en/strings.xml` 键集完全一致）。

**三个真正的风险**：

1. **构建链不可复现**：`gradle/wrapper/gradle-wrapper.properties:3` 指向 Gradle **9.3.0**，而 `build.gradle.kts:3` 用的是 AGP **8.5.0**（官方支持 Gradle 8.7）。这两个版本组合超出官方支持矩阵，换台机器 clone 下来大概率直接构建失败。这是**发布阻塞级**问题，且与业务代码无关。
2. **主线程上做重活**：`MidiPlayerManager.loadPath()` 在调用线程里解析整首 MIDI（`MidiPlayerManager.kt:702`），而调用链来自 Compose 的点击回调（播放页/曲库点歌）。几千音符的曲子在中端机上就是一次可见卡顿，上万音符接近 ANR。同一文件里 `updateActiveNotes()` 每 30ms 从第 0 个音符线性扫到当前时刻（`MidiPlayerManager.kt:1156`），复杂度 O(n) 且随曲目长度增长。
3. **零自动化测试**：`app/src/` 下只有 `main`，没有 `test` / `androidTest`。而项目里有四套自写编码器（WAV 头、FLAC 容器、LAME JNI、Markdown 无关）、一套自写 M3U 解析、一套自写 MIDI 解析——这些恰恰是最适合单测的部分，现在全靠手点。

**设计层**：颜色 / 字号 / 间距 / 圆角 / 动效已经 token 化（`Theme.kt`、`Type.kt`、`Dimens.kt`、`Motion.kt`），这在 Android 项目里是少见的自觉。缺的是**表面材质与背景**这一层：卡片一律 `CharcoalCard` 实色、根节点一律 `background(Charcoal)`，所以既做不出电脑端那种玻璃层叠，也无法换壁纸。1.0.11 补的就是这一层（§13）。

**安全/合规**：云同步 token 明文存 SharedPreferences（`CloudSyncManager.kt:423`）且 `allowBackup="true"`（`AndroidManifest.xml:26`）；应用内更新走第三方 GitHub 代理、只校验包名与 versionCode（`AppUpdater.kt:248-260`）。

---

## 1. 审计范围与方法

| 范围 | 内容 | 深度 |
|---|---|---|
| 播放内核 | `player/MidiPlayerManager.kt`（1,209 行）、`PlaybackService.kt`（301） | 全文 |
| 渲染 | `ui/PianoWaterfall.kt`（708） | 全文 |
| 界面 | `ui/FuMiVoiceApp.kt`（1,055）、5 个主页面 + 4 个弹层（约 5,600 行） | 全文/重点段 |
| 数据 | `library/*`（6 个文件）、`midi/MidiParser.kt` | 抽查 + 调用点 |
| 音频处理 | `audio/Equalizer.kt`、`export/*`（4 个文件） | 重点段 |
| 网络 | `cloud/*`、`soundfont/DownloadEngine.kt`、`update/*` | 重点段 |
| 构建/资源 | gradle 三件套、Manifest、`res/`、`assets/`、`jniLibs/` | 全文 |

**方法**

- **Kotlin PSI 全量解析**：用 Gradle 缓存里的 `kotlin-compiler-embeddable 1.9.24` 对 56 个 `.kt` 做语法树解析，`PsiErrorElement` 计数为 **0**（脚本见附录 A）。这一层能挡住括号/字符串/声明结构错误，但**挡不住类型错误**——本机没有 `android.jar` 与 Compose 依赖，无法做语义分析。
- **规则化 grep**：主线程 IO、`collectAsState`、`contentDescription` 覆盖、`Build.VERSION` 分支、硬编码中文、`TODO`、`Thread.sleep`、`BackHandler` 等（附录 A）。
- **未做**：编译、Lint、单元测试、真机/模拟器、帧率与内存实测。凡涉及"卡不卡"的结论均标注为推断。

---

## 2. 竞品与平台参照

| 维度 | FuMiVoice 现状 | 竞品 / 平台做法 | 判断 |
|---|---|---|---|
| 瀑布（piano roll） | 白键均分、黑键居中、按时长算高度、按小节换算速度（`PianoWaterfall.kt:219-316`） | **Synthesia** 同构；**PianoVision/Flowkey** 增加"等待模式"与跟练判定 | 视觉已达标；缺**跟练/循环某段**（练习场景的核心） |
| 曲库 | 文件名推断艺术家 + 手动修正 + 6 种排序 + 多选批量（`LibraryScreen.kt`） | **MuseScore** 用元数据标签；**Poweramp** 用文件夹树 | 中文场景下"歌手 - 歌名"推断是聪明的折中，保留 |
| 混音 | 16 通道 音量/声像/静音/独奏 + 音色替换（`MidiPlayerManager.kt:317-393`） | **FL Studio Mobile** 的通道机架 | 功能对齐，UI 还差"推子"手感（现在是滑杆） |
| 导出 | WAV/AAC/FLAC/MP3，FLAC 自写容器（`AudioExporter.kt`） | 多数同类只能导出 WAV 或录音 | **明显领先**，但零测试 |
| 音色库 | 内置 + 导入 + 在线下载（含分卷、镜像、文件头校验） | **MuseScore** 也是 sf2/sf3；**FluidSynth** 生态 | 下载链路完成度高；30MB 内置库是包体主因 |
| 外观 | 1.0.11 起：4 材质 × 7 背景 + 压暗 + 漂移 | **FuFumidi** 的 AppearancePanel（主题/壁纸/显示三页）；**Material 3** 的 dynamic color | 现在两端终于同构；差异见 §13 备注 |
| 架构 | 单 Activity + 条件渲染子页（无 NavHost） | **Now in Android** 用 NavHost + ViewModel + Repository；官方推荐单 Activity + Navigation | 现状能跑，但返回栈要自己造（§11 P0-3） |
| 图标 | 1.0.11 起自适应图标 + 圆形图标 | Android 8+ 强制自适应；Android 13 主题图标（monochrome） | 已补自适应；**未做 monochrome**，主题图标会退回彩色 |
| 返回手势 | **完全没有 BackHandler** | Android 13+ 预测性返回；官方要求 app 接入 | 见 P0-3 |
| 语言 | 自写 `AppLanguage`（`updateConfiguration`） | Android 13 起官方 `LocaleManager` / `localeConfig`；AppCompat 的 `setApplicationLocales` | 现状能用但已过时（`AppLanguage.kt:64-65` 用的是 deprecated API） |

---

## 3. 功能审计

### 3.1 播放内核（BASS）

**做得好的地方**

- 用**官方 Java 绑定**而不是自写 JNI（`MidiPlayerManager.kt:95-104` 有说明），避免签名漂移。
- 变速/变调绕开 `BASS_ATTRIB_MIDI_SPEED` 的语义坑，改走 `BASS_FX_TempoCreate` 解码流（`MidiPlayerManager.kt:523-557`），并在失败时回退直放——这是踩过坑才写得出的代码。
- 换曲时用**文件头**而不是扩展名判类型（`MidiPlayerManager.kt:643-656`），解决了 SAF 拿到的 URI 没有扩展名的问题。
- 节拍器不用 `BASS_SYNC_POS`，改为每拍向 BASS 重新取位置再算等待（`MidiPlayerManager.kt:940-973`），漂移不累积。

**问题**

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| F1 | **装载时在调用线程解析整首 MIDI** | `MidiPlayerManager.kt:699-721`（`loadPath` 内 `MidiParser.parse(File(path).inputStream())`），入口 `setPlaylist`/`playAt` ← `FuMiVoiceApp.kt:451-463` 的点击回调 | 大文件卡顿/ANR |
| F2 | **30ms 一次的 O(n) 音符扫描** | `MidiPlayerManager.kt:1156-1180`：`for (note in notes) { if (start > nowMs) break ... }` 从 0 开始 | 10k 音符 → 每秒 33 万次比较 + 每个 tick 组一个 `LinkedHashMap` 与 signature 字符串 |
| F3 | **每次状态变化都重建整个 `PlayerUiState` 并广播** | `MidiPlayerManager.kt:240-258`；循环 `startPositionUpdater` 每 30ms 调一次（`:1111`） | 整棵外壳每 33Hz 重组；通知栏同频重建 MediaMetadata（`PlaybackService.kt:154-168`） |
| F4 | **没有音频焦点管理** | 全项目 grep `AudioFocus` / `requestAudioFocus` / `setAudioAttributes` → 0 命中 | 来电/别的播放器起播时不停、不 duck；锁屏暂停与其他 App 抢输出 |
| F5 | `release()` 从未被调用 | `MidiPlayerManager.kt:1191-1208` 定义了 `BASS_Free`，全项目无调用点 | 进程存活期间 BASS 资源不释放（进程死亡时系统回收，实际危害有限，但属于死代码） |
| F6 | `scope` 永不取消 | `MidiPlayerManager.kt:234` | 与 F5 同源，属于"没有生命周期归属"的架构欠账 |
| F7 | 播放结束靠"位置 ≥ 时长"判断 | `MidiPlayerManager.kt:1112-1115` | 某些 MIDI 的 `BASS_ChannelGetLength` 返回 0（流式/异常文件），此时永不触发下一首 |

### 3.2 音符瀑布

- 布局与"音符高度 = 时长 × 每秒像素"这条原则是对的（`PianoWaterfall.kt:49-57` 注释写得很清楚），这是它不像"所有音符挤在顶部"的关键。
- **同音高重叠合并**（`:181-217`）解决长音压短音的闪烁，是对的。
- **帧时钟插值**（`:150-172`）解决 30ms 位置更新的阶梯感，思路正确。

问题见 §6 性能（P1-2/P1-3/P1-4），以及：

| # | 问题 | 证据 |
|---|---|---|
| U1 | 空状态只画一块底色，没有提示 | `PianoWaterfall.kt:368-370`（`drawEmptyHint` 只有 `drawRect`），而外层 `NowPlayingScreen.kt:213-227` 的 EmptyState 是另一套；两者在"有曲目但解析不出音符"时会同时出现 |
| U2 | 自绘键盘/瀑布没有任何无障碍语义 | 全文件无 `semantics`/`contentDescription`；TalkBack 读不出"第 60 键" |

### 3.3 曲库 / 歌单

- 曲库扫描 + 元数据修正 + 悬空历史清理的闭环是完整的（`FuMiVoiceApp.kt:206-223`）。
- M3U 导入按**文件名**匹配而不是绝对路径（`FuMiVoiceApp.kt:385-437`），跨设备可用，思路正确。
- 排序偏好落到 `LibraryPrefs`（`TrackSort.kt:50`）。

问题：

| # | 问题 | 证据 |
|---|---|---|
| L1 | `soundFonts.list()` 在**主线程**目录遍历 | `FuMiVoiceApp.kt:225-227`（`reloadSounds` 直接赋值），对比 `reloadLibrary` 用了 `Dispatchers.IO` |
| L2 | 子页（歌单详情/艺术家详情）没有返回栈 | 见 P0-3 |
| L3 | 批量删除是 `forEach { library.delete(it) }` 串行 + 每次全量重扫 | `FuMiVoiceApp.kt:756-765` → `reloadLibrary()` 再扫一遍目录 |

### 3.4 混音 / 均衡 / 节拍器

- 静音/独奏用"音量置 0"实现（`MidiPlayerManager.kt:375-386`），没有额外通道状态要同步，简洁。
- 均衡器是自写 10 段 peaking DSP（`audio/Equalizer.kt:37-49`），在 BASS 的 DSP 回调里跑，复用缓冲区（`:105`）。
- 节拍器音源是代码合成的 WAV 落盘再建流（`MidiPlayerManager.kt:1025-1084`），避免手写未公开签名——判断正确。

| # | 问题 | 证据 |
|---|---|---|
| A1 | 均衡器增益/频段没有下限保护，10 段全 +12dB 会削波 | `Equalizer.kt` 未见 clamp 到总增益；只能靠听感 |
| A2 | 混音台"改音色"会写进正在播放的流，但对**导出**无效（导出另建流） | `AudioExporter.createDecoder`（`AudioExporter.kt:183-217`）不读通道状态 |

### 3.5 导出

四种格式共用一条解码流（`AudioExporter.kt:102-175`），FLAC 自写容器（`:153-158`），MP3 走 LAME JNI（`Mp3Encoder.kt`）。

| # | 问题 | 证据 |
|---|---|---|
| E1 | `AudioExporter` 是 `object`，但持有可变 `fontHandle` | `AudioExporter.kt:177`；两次导出并发会互相释放字体句柄 |
| E2 | 导出协程绑定在弹层的作用域上，**关掉弹层就取消**，留下半截文件 | `ExportSheet.kt:96` `rememberCoroutineScope()` → 弹层离开组合即 cancel；`AudioExporter` 的 `finally` 只释放句柄，不删文件 |
| E3 | 导出判格式只看扩展名，不看文件头（与播放器不一致） | `AudioExporter.kt:184-216`；播放器有 `sniffKind`（`MidiPlayerManager.kt:643`） |
| E4 | 导出目录在应用私有外部目录，卸载即丢 | `strings.xml` 里 `export_save_hint` 已坦白告知；建议加"保存到下载目录"（MediaStore） |

### 3.6 音色库

- 内置 29.8MB 的 `GeneralUser.sf2`，首启解压到 `filesDir/soundfonts`（`SoundFontManager.kt:83-95`）。
- 导入/下载都做 RIFF+`sfbk` 文件头校验（`:190-201`），能挡住"改名的 HTML 错误页"。
- 下载支持分段并发 + 分卷合并 + 多镜像（`DownloadEngine.kt:52-58`）。

| # | 问题 | 证据 |
|---|---|---|
| S1 | 首启解压 30MB **没有进度/占位提示**，界面上表现为"音色为空"，600ms 后才刷新 | `App.kt:24-42`（后台线程解压）+ `FuMiVoiceApp.kt:352-354`（`delay(600)` 再刷一次） |
| S2 | 30MB 在 APK 里压缩率只有 90.5%（实测），等于包体硬成本 27MB | 见 §7 |
| S3 | 内置音色**删不掉也换不掉位置**，且与用户库混在同一目录 | `SoundFontManager.kt:161-168`（`isBundled` 拒绝删除）——设计上可接受，但"内置"与"导入"应分区 |

### 3.7 云同步

- 两条后端（主域名 + Workers 兜底），`CloudApi.kt:18-19`；断线时自动换。
- 同步有冲突检测与"保留哪一份"的选择（`CloudSyncScreen.kt` 的 `conflict` 流），比"最后写入者胜"友好。
- Turnstile 人机验证用 WebView 加载托管页（`CloudSyncScreen.kt:370-410`）。

| # | 问题 | 证据 |
|---|---|---|
| C1 | **token 明文存 SharedPreferences** | `CloudSyncManager.kt:50, 423`；未用 `EncryptedSharedPreferences`/Keystore |
| C2 | `allowBackup=true` 会把 token、曲库、歌单一起备份到云端/换机迁移 | `AndroidManifest.xml:26`；与 C1 叠加后，token 会离开设备 |
| C3 | Turnstile WebView 开了 JS 与 DOM Storage，但只校验页面加载、未限制可跳转域名 | `CloudSyncScreen.kt:392-409`；恶意重定向可把 WebView 带去任意站点 |
| C4 | 密码以明文放进 JSON body（依赖 HTTPS） | `CloudSyncManager.kt:94-101`；TLS 下可接受，但服务端日志若记录 body 就泄露 |

### 3.8 应用内更新

- 下载到 `filesDir/updates`（不会被系统清缓存），`.part` 转正，命中缓存直接安装（`AppUpdater.kt:111-169`）——细节考虑得比多数项目好。
- 校验包名 + versionCode（`:248-260`），能挡住"镜像返回旧包/错误页"。

| # | 问题 | 证据 |
|---|---|---|
| N1 | 更新包经第三方 GitHub 代理下载，**没有签名/哈希校验** | `AppUpdater.kt:128`（`UpdateSource.releaseUrls`）+ `:233-240`（未 pin 证书）；系统安装器会挡签名不符，但用户只会看到"安装失败" |
| N2 | `version.json` 无任何签名，代理可伪造"新版本"提示 | `:76-90` |
| N3 | `REQUEST_INSTALL_PACKAGES` 在国内商店需要额外说明，Play 上属于敏感权限 | `AndroidManifest.xml:22` |

### 3.9 小组件 / 画中画

- 小组件用 RemoteViews + 位图（`WidgetWaterfall.kt:57`），播放时 250ms 推一次图（`PlaybackService.kt:52, 214-221`）。
- 画中画两套：Android 12+ 用 `setAutoEnterEnabled`（`MainActivity.kt:124-132`），12 以下用 `onUserLeaveHint`（`:89-94`）。

| # | 问题 | 证据 |
|---|---|---|
| W1 | 注释写"间隔取 1s"，常量是 250ms | `PlaybackService.kt:206-213` 注释 vs `:52`；文档与代码漂移 |
| W2 | 大尺寸小组件生成 ARGB_8888 位图走 Binder，可能超 RemoteViews 事务上限 | `WidgetWaterfall.kt:57-58`；4fps 下每秒 4 次跨进程大图 |
| W3 | 画中画比例固定 16:9，竖屏手机上是"上下黑边" | `MainActivity.kt:112-116` |

### 3.10 多语言与文件关联

- 341 条文案中英成对，**0 缺失**（脚本比对键集）。
- 但 `PlaybackService` 里有 4 处硬编码中文：通知渠道名（`:38`）、标题兜底（`:164, 229`）、三个动作名（`:239, 249, 255`）。切英文后通知栏仍是中文。
- 文件关联同时挂 `content`/`file` + 多个 MIME + `.m3u` pathPattern（`AndroidManifest.xml:40-66`），覆盖了各家文件管理器的怪癖。

---

## 4. UI/UX 审计

**优点**

- 动效集中管理且克制：120–380ms，统一缓动（`Motion.kt:28-113`）；列表入场错峰封顶 8 档（`Common.kt:424-445`）。
- "发丝线分隔、不用阴影"的规则贯穿顶栏/底栏/卡片（`Common.kt:220-229`），和电脑端一致。
- 页面转场用 `pageEntrance` 给"条件渲染"补过渡（`Common.kt:465-487`）——在没有 NavHost 的前提下是合理的补丁。
- `SegmentedTabs`、`PillTag`、`EmptyState`、`LoadingState`、`ErrorState` 都有统一实现（`Common.kt`），不是各页各写。

**问题**

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| U3 | 返回键/返回手势直接退出应用，而不是回上一级 | 全项目无 `BackHandler`（grep 0 命中）；设置页、歌单详情、艺术家详情都是"条件渲染 + 提前 return" | **每次按返回都像被踢出应用**，是当前最刺眼的交互缺陷 |
| U4 | 设置页入口藏在云同步页 | `FuMiVoiceApp.kt:814-817`（`onOpenSettings` 只传给 `CloudSyncScreen`） | "设置"与"账号"无关，用户不会去云同步里找设置 |
| U5 | 冷启动先闪白 | 原 `themes.xml` 用 `Theme.Material.Light.NoActionBar` 且无 `windowBackground`（1.0.11 已修） | 深色应用启动像"开了个白页" |
| U6 | 浅色系统模式下状态栏图标是深色，压在深靛顶栏上看不见 | 原 `enableEdgeToEdge()` 无参调用 + Light 主题（1.0.11 已修） | 部分用户状态栏"消失" |
| U7 | 播放页控制区直接贴在背景上，没有卡片 | `NowPlayingScreen.kt:289-515`（`panel` 是裸 Column） | 换壁纸后文字对比度不稳；1.0.11 用"舞台压暗"缓解，但没有面板承载 |
| U8 | 空状态与错误态混用 | 瀑布空态只画底色（U1），曲库空态有完整 EmptyState | 同一产品两套表达 |
| U9 | 通知栏/小组件文案未国际化 | 见 §3.10 | 英文用户看到中文 |
| U10 | 触控目标偏小 | `NowPlayingScreen.kt:245-283` 沉浸/横屏按钮 36dp（低于 48dp 建议） | 单手误触 |
| U11 | 无障碍覆盖不均 | 37 处 `contentDescription`，15 处为 `null`；自绘瀑布/键盘 0 语义 | TalkBack 无法描述核心画面 |

---

## 5. Compose 结构审计

| 维度 | 现状 | 评价 |
|---|---|---|
| 状态归属 | 全部状态堆在 `FuMiVoiceApp`（`FuMiVoiceApp.kt:175-240`，约 15 个 `mutableStateOf`） | **最大结构问题**：外壳同时管曲库、更新、设置、导出、沉浸、PIP，任何一处改动都要改这个 1,055 行的文件 |
| ViewModel | 只有 `lifecycle-viewmodel-compose` 依赖，**0 个 ViewModel** | 旋转/进程重建时唯一存活的是 `App` 里的 player，界面状态全丢 |
| 导航 | 无 NavHost；子页靠 `if (showX) { Screen(); return }` | 直接导致 U3（无返回栈） |
| 文件体量 | `LibraryScreen.kt` 1,535 行 / 12 个 composable；`FuMiVoiceApp.kt` 1,055；`SoundFontScreen.kt` 792 | 单文件超过 500 行后，改一处要读整屏 |
| 状态订阅 | 5 处 `collectAsState()`，**0 处** `collectAsStateWithLifecycle`（`FuMiVoiceApp.kt:175` 等） | 后台仍在收集 30ms 状态流 |
| 派生状态 | 0 处 `derivedStateOf` | `playerState` 每 33Hz 变化 → 整棵 shell 重组，没有做"只关心某几个字段"的裁剪 |
| 列表 | `items*` 调用 14 处，13 处带 `key` | 好 |
| 稳定性 | `PlayerUiState` 是 data class（稳定），但 `track: MidiTrack?` 内含 `List`? 否 | 基本稳定；建议加 `@Immutable` 注解消除编译器猜测 |
| 自绘 | `Canvas` + `withFrameNanos`（`PianoWaterfall.kt`） | 合理；但绘制里做测量/分配（§6） |
| 主题 | `MaterialTheme` + `Shapes` + `Typography` 已接入（`Theme.kt:94-102`） | 好；1.0.11 起材质也进主题层 |
| 预览 | 有 `ui-tooling-preview` 依赖，但**没有任何 `@Preview`** | 加预览能显著降低改 UI 的成本 |

---

## 6. 性能审计

### 6.1 热点排序（按影响）

| 排名 | 热点 | 位置 | 量级 | 级别 |
|---|---|---|---|---|
| 1 | 主线程解析 MIDI | `MidiPlayerManager.kt:702` | 一首 5k 音符约 20–80ms（推断），20k 则数百 ms | P0 |
| 2 | 30ms 全量 `notifyState` → 整树重组 | `MidiPlayerManager.kt:1111` + `FuMiVoiceApp.kt:175` | 33 次/秒，每次新 `PlayerUiState` + StateFlow 派发 | P1 |
| 3 | `updateActiveNotes` O(n) 全扫 | `MidiPlayerManager.kt:1156-1180` | 33 × n 次比较/秒 + 每 tick 一个 Map + 一条签名串 | P1 |
| 4 | 瀑布每帧重建渐变 Brush / 文本测量 | `PianoWaterfall.kt:465-469, 493`（每条音符一个 `Brush.verticalGradient`）、`:568, 678`（`textMeasurer.measure` 每帧每标签） | 200 可见音符 × 60fps ≈ 12k 分配/秒；TextMeasurer 缓存只有 8 条，标签一多就击穿 | P1 |
| 5 | `prepareNotes` 在组合线程做排序+合并 | `PianoWaterfall.kt:80`（`remember(notes) { prepareNotes(notes) }`） | 首次进入播放页对全曲排序（n log n），大曲目首次卡顿 | P1 |
| 6 | `rememberFrameClock` 每 30ms 重启协程 | `PianoWaterfall.kt:96, 150-172` | 33 次/秒 `LaunchedEffect` 取消+重启 | P2 |
| 7 | 通知栏 MediaMetadata/PlaybackState 每 30ms 重建 | `PlaybackService.kt:154-168` | 33 次/秒 Binder 调用（系统侧可能合并） | P2 |
| 8 | 小组件 250ms 推大位图 | `PlaybackService.kt:52` + `WidgetWaterfall.kt:57` | 4 次/秒跨进程 ARGB_8888 | P2 |
| 9 | 粒子碰撞检测 `particles.any` 双重循环 | `PianoWaterfall.kt:594` | 上限 160，可忽略 | P2 |
| 10 | 音色库列表在主线程遍历目录 | `FuMiVoiceApp.kt:225-227` | 每次切到音色页 | P2 |

### 6.2 建议做法

1. **解析移出主线程**：`loadInternal` 改 `suspend` + `withContext(Dispatchers.Default)`；界面侧显示 200ms 的"装载中"遮罩（大于 200ms 才出现，避免闪烁）。
2. **位置流与 UI 状态分离**：`PlayerUiState` 拆成 `PlayerStaticState`（曲目/时长/模式，换曲才变）+ `positionFlow`（高频）。外壳只订阅前者，播放页订阅后者，并把进度条包在 `derivedStateOf` 里。
3. **`updateActiveNotes` 改二分 + 区间扫描**：复用 `lowerBoundByStart`（`PianoWaterfall.kt:530-538`）的思路，从"最长音符起点"开始扫。
4. **瀑布绘制缓存**：把 `Brush` 按通道/音区预建为 `remember` 的列表（16 色 + 3 音区色最多 19 个），音符只取引用；小节号/C 音名用 `remember` 的 `TextLayoutResult` 表（字符串数量有限）。
5. **`Modifier.drawWithCache`**：把不变的部分（键盘、八度线、小节线模板）缓存成 `Picture`（API 23+ `android.graphics.Picture` + `drawIntoCanvas`）。
6. **Baseline Profile**：接入 `androidx.benchmark:macro`，为主路径生成 baseline profile（启动 + 首次播放 + 滚动曲库），冷启动与首帧会有可见收益。

---

## 7. 包体与分发

| 组成 | 大小 | 说明 |
|---|---|---|
| `assets/soundfonts/GeneralUser.sf2` | **29.8 MB**（压缩后 27.0 MB，实测 90.5%） | 占成品的 ~90% |
| `jniLibs/arm64-v8a/*.so` | 772 KB | 已 strip，6 个库 |
| `res/font/*.ttf` | 116 KB | 3 个字体（Boogalo/Chicle/KodeMono） |
| 代码 + 资源 | 约 2–3 MB | 未开混淆 |
| **预计 APK** | **约 30 MB** | 与 `AppUpdater.kt:100` 注释里"40MB 的包"一致 |

**问题**

- `isMinifyEnabled = false`（`app/build.gradle.kts:62`）。注释说明理由很充分：BASS 的官方绑定靠 JNI `FindClass` 反射，R8 改名会在运行时炸。**但这不是不做混淆的理由**——正确做法是 `-keep class com.un4seen.bass.** { *; }` + `-keepclasseswithmembernames class * { native <methods>; }`，其余代码照常 shrink。
- 若开启 R8，Compose + Kotlin 代码通常能省 20–30%，即 **6–9 MB**。
- `GeneralUser.sf2` 是零成本的 27MB：可考虑**首启按需下载**（已有下载器），APK 降到 ~4MB；代价是首次播放前需联网。折中：保留内置但用 `zip` 分卷 + 解压（压缩率仍只有 90%，收益不大）→ **真正有效的只有"改成可选下载"**。
- 未配置 `abiFilters` 之外的 32 位；只有 arm64 是可接受的取舍（README 已声明）。
- 未产出 `baseline-prof.txt`、未配置 `android:extractNativeLibs`（AGP 默认已是最优）。

---

## 8. 代码质量

**优点**

- 注释密度高且**写"为什么"而不是"是什么"**，例如 `MidiPlayerManager.kt:523-535`（为什么不用 `MIDI_SPEED`）、`Common.kt:451-464`（为什么需要 pageEntrance 补丁）。这在个人项目里罕见。
- 命名一致，包结构清晰（audio/export/library/midi/player/soundfont/ui/widget）。
- 错误处理普遍 `runCatching` + 用户可见提示，而不是静默吞掉（例如 `FuMiVoiceApp.kt:458-462` 明确提示"无法播放"）。

**问题**

| # | 问题 | 证据 |
|---|---|---|
| Q1 | 15,125 行的项目 **0 测试、0 CI 配置**（无 `.github/`） | `app/src/` 只有 `main` |
| Q2 | `FuMiVoiceApp` 是上帝对象（1,055 行 / 15 个状态 / 12 个回调族） | `FuMiVoiceApp.kt:137-240` |
| Q3 | `LibraryScreen` 1,535 行，含 4 个分区的 UI 与 3 个弹窗 | `LibraryScreen.kt` |
| Q4 | 死代码：`release()`、`setOnStateChanged`（被 StateFlow 取代）、`MediaCodecListCompat` 可能只为一处 | `MidiPlayerManager.kt:237, 1191` |
| Q5 | 注释与常量漂移（1s vs 250ms） | `PlaybackService.kt:52, 206-213` |
| Q6 | 文案双份维护：`AppLanguage.options` 里写死"跟随系统 / System" | `AppLanguage.kt:38-42` |
| Q7 | `AudioExporter` 单例持有可变状态（E1） | `AudioExporter.kt:177` |
| Q8 | `@Suppress("DEPRECATION")` 掩盖的是"该换 API"而不是"兼容旧版" | `AppLanguage.kt:64-65` |
| Q9 | 依赖没有版本目录（`libs.versions.toml`），版本散在 build.gradle | `app/build.gradle.kts:112-128` |

---

## 9. Android 兼容性

| 项 | 现状 | 风险 |
|---|---|---|
| minSdk 24 / targetSdk 36 | `app/build.gradle.kts:22-23` | targetSdk 36 意味着必须处理：预测性返回（**未做**）、前台服务类型（已声明 mediaPlayback，`:73`）、通知权限（已申请，`MainActivity.kt:139-144`）、边到边强制（已 `enableEdgeToEdge`） |
| 前台服务 | 只有 `FOREGROUND_SERVICE` + `MEDIA_PLAYBACK` | Android 14 起启动 FGS 需要类型（已满足）；但**未处理 `onTimeout`**（数据同步类型才有，这里不适用） |
| 画中画 | 12+ 自动进入，8–11 手动 | API 26 以下直接 return（`MainActivity.kt:111`），符合预期 |
| 通知 | channel LOW + MediaStyle | 未设置 `setColorized`/`setLargeIcon`，观感一般；无 `MediaSession.setFlags` |
| 预测性返回 | **未接入** | Android 13+ 手势返回时无系统动画；且因为没有 BackHandler，返回直接退出（U3） |
| 每应用语言 | 自写 `updateConfiguration`（已废弃） | Android 13 的"应用语言"系统设置里看不到本应用；建议迁 `AppCompatDelegate.setApplicationLocales` 或 `LocaleManager` |
| 主题图标（Android 13） | 未提供 `<monochrome>` | 主题图标下显示彩色图标 |
| 大屏/折叠 | 无 `WindowSizeClass` 适配；横屏靠 `LocalConfiguration.orientation` 分支 | 平板/折叠展开时布局仍按竖屏堆叠 |
| 深色模式 | 固定深色，不跟随系统 | 设计选择，可接受；但需在 README 写明 |
| 存储 | 全部走应用私有目录 + SAF | 无 `MANAGE_EXTERNAL_STORAGE`，合规 |
| 电池 | 无 WakeLock（好）；但有 30ms 定时器与 250ms 小组件刷新 | 后台播放时 CPU 唤醒偏多 |

---

## 10. 测试、签名与供应链

### 10.1 测试

- **单元测试 0**。最该补的四处：
  1. `MidiParser`：变长 quantity、running status、tempo map、SMPTE 时间码；
  2. `M3uCodec`：UTF-8 BOM、CRLF、相对路径、注释行；
  3. `AudioExporter.wavHeader / flacSink`：字节级 golden file；
  4. `TrackSort` / `PlaylistManager`：排序与去重。
- **UI 测试 0**。至少给"导入 → 播放 → 导出"一条 Compose UI 测试（`createAndroidComposeRule`）。
- **回归手段**：目前只有"手点"。建议加一个 `debug` 专属的"自检页"，跑解析/导出/编码的冒烟用例。

### 10.2 签名

- `keystore.properties` 读取逻辑正确（`app/build.gradle.kts:10-14`）；缺失时降级为未签名包，不会崩构建。
- V1+V2+V3 全开（`:49-52`），注释里"V1 实际没进产物"的观察是真实的：AGP 在 minSdk≥24 时通常不再写 JAR 签名，但保留 `enableV1Signing` 无害。
- **风险**：注释明确写了"1.0.6 起换过密钥"，而 README 里只有一句警告。建议在 release notes 与关于页里也标注"签名指纹"，方便用户核对（`apksigner verify --print-certs`）。
- **本轮已补**：`keystore.properties.example` 模板 + README 的签名章节（不伪造证书、不写密钥）。

### 10.3 供应链

- BASS 系列是**闭源商业库**，随仓库分发 `.so`；README 有许可声明，但没有版本号与来源哈希。建议记录每个 `.so` 的版本与 SHA-256。
- LAME 源码随仓库（`cpp/lame/`，909KB），LGPL 合规需要"提供源码"——已满足。
- 第三方代理镜像（`ghfast.top` / `gh-proxy.com` / `ghproxy.net`）用于**音色库与更新包**下载；更新包只校验包名+版本号（N1）。建议：更新包校验 **APK 签名证书指纹**（`PackageManager.getPackageArchiveInfo` + `GET_SIGNING_CERTIFICATES` 对比自身），实现只多 20 行，但能挡住"代理换包"。

---

## 11. 问题清单（P0 / P1 / P2）

> P0 = 阻断发布或造成数据/信任损失；P1 = 明显影响体验或可维护性；P2 = 打磨项。
> "状态"列：🔴 待修 / 🟡 部分缓解 / 🟢 1.0.11 已修

### P0

| ID | 问题 | 位置 | 建议 | 状态 |
|---|---|---|---|---|
| P0-1 | Gradle wrapper 9.3.0 与 AGP 8.5.0 不兼容，构建不可复现 | `gradle/wrapper/gradle-wrapper.properties:3`、`build.gradle.kts:3` | 固定 `gradle-8.9-bin.zip`；或升级 AGP 到 8.7+ 并同步 Gradle | 🔴 |
| P0-2 | 主线程解析 MIDI，大文件卡顿/ANR | `MidiPlayerManager.kt:702`（调用链 `FuMiVoiceApp.kt:451-463`） | 移到 `Dispatchers.Default`，装载中给状态 | 🔴 |
| P0-3 | 无 BackHandler，二级页按返回直接退出应用 | 全项目 0 命中；`FuMiVoiceApp.kt:572-590`（设置页）、`LibraryScreen.kt`（歌单/艺术家详情） | 给每个"条件渲染子页"加 `BackHandler { onBack() }`，并补预测性返回 | 🔴 |

### P1

| ID | 问题 | 位置 | 建议 | 状态 |
|---|---|---|---|---|
| P1-1 | 30ms 全量状态广播 → 整树重组 | `MidiPlayerManager.kt:1111`、`FuMiVoiceApp.kt:175` | 拆分静态状态与位置流；`collectAsStateWithLifecycle` | 🔴 |
| P1-2 | `updateActiveNotes` O(n) 全扫 | `MidiPlayerManager.kt:1156` | 二分 + 区间扫描 | 🔴 |
| P1-3 | 瀑布逐帧分配 Brush / 测量文本 | `PianoWaterfall.kt:465, 493, 568, 678` | 预建 Brush 表 + TextLayoutResult 缓存 | 🔴 |
| P1-4 | `prepareNotes` 在组合线程排序合并 | `PianoWaterfall.kt:80` | 移到 `produceState` + Default 调度器 | 🔴 |
| P1-5 | 无音频焦点管理 | 全项目 0 命中 | `AudioFocusRequest`，失去焦点暂停/duck，来电恢复 | 🔴 |
| P1-6 | 云 token 明文 + allowBackup | `CloudSyncManager.kt:423`、`AndroidManifest.xml:26` | 加密存储（Keystore）；`dataExtractionRules` 排除 token | 🔴 |
| P1-7 | 首启解压 30MB 无进度提示 | `App.kt:24-42`、`FuMiVoiceApp.kt:352-354` | 暴露解压进度状态，音色页显示"准备内置音色…" | 🔴 |
| P1-8 | 导出随弹层关闭被取消，留半截文件 | `ExportSheet.kt:96` | 用 `viewModelScope`/前台服务承载导出；取消时删 `.part` | 🔴 |
| P1-9 | 设置入口藏在云同步页 | `FuMiVoiceApp.kt:814-817` | 顶栏加齿轮入口（1.0.11 已在设置页内扩展外观，入口问题仍在） | 🔴 |
| P1-10 | 冷启动白闪 + 系统栏图标不可见 | 原 `themes.xml`、`MainActivity.kt:42` | 深色窗口背景 + `SystemBarStyle.dark` | 🟢 |
| P1-11 | 无自适应图标 / 圆形图标 | `res/mipmap-*` | 生成 foreground + anydpi-v26 | 🟢 |
| P1-12 | 通知/小组件文案硬编码中文 | `PlaybackService.kt:38, 164, 229, 239, 249, 255` | 走资源 | 🔴 |
| P1-13 | 0 测试 | `app/src/` | 先补 Parser/Codec/Exporter 单测 | 🔴 |
| P1-14 | 包体 30MB，27MB 是内置音色 | `assets/soundfonts/` | 改可选下载或提供 lite 变体 | 🔴 |
| P1-15 | 未开 R8，注释把"不能混淆"当成结论 | `app/build.gradle.kts:62` | keep BASS 包 + native 方法，其余照常 shrink | 🔴 |

### P2

| ID | 问题 | 位置 |
|---|---|---|
| P2-1 | 无 ViewModel，旋转丢界面状态 | `FuMiVoiceApp.kt:137-240` |
| P2-2 | 无 NavHost，返回栈靠手写 | 同上 |
| P2-3 | 上帝文件（1,055 / 1,535 / 792 行） | `FuMiVoiceApp.kt`、`LibraryScreen.kt`、`SoundFontScreen.kt` |
| P2-4 | `collectAsState` 未换 `collectAsStateWithLifecycle` | 5 处 |
| P2-5 | `rememberFrameClock` 每 30ms 重启协程 | `PianoWaterfall.kt:96` |
| P2-6 | 每 tick 重建 MediaMetadata | `PlaybackService.kt:154-168` |
| P2-7 | 小组件 250ms 推 ARGB_8888 | `PlaybackService.kt:52`、`WidgetWaterfall.kt:57` |
| P2-8 | `AudioExporter` 单例可变状态 | `AudioExporter.kt:177` |
| P2-9 | 导出只按扩展名判类型 | `AudioExporter.kt:184-216` |
| P2-10 | 无 `@Preview` | `ui/` |
| P2-11 | 无 `libs.versions.toml` | 根目录 |
| P2-12 | 死代码 `release()` / `setOnStateChanged` | `MidiPlayerManager.kt:237, 1191` |
| P2-13 | 注释与常量漂移（1s vs 250ms） | `PlaybackService.kt:52, 206-213` |
| P2-14 | 触摸目标 36dp | `NowPlayingScreen.kt:245-283` |
| P2-15 | 瀑布/键盘无无障碍语义 | `PianoWaterfall.kt` |
| P2-16 | 未提供主题图标 monochrome | `mipmap-anydpi-v26/` |
| P2-17 | 语言用 deprecated `updateConfiguration` | `AppLanguage.kt:64-65` |
| P2-18 | 无大屏/折叠适配 | `NowPlayingScreen.kt:156` |
| P2-19 | Turnstile WebView 未限制域名 | `CloudSyncScreen.kt:392-409` |
| P2-20 | 更新包无签名校验 | `AppUpdater.kt:248-260` |
| P2-21 | 混音台改动不影响导出 | `AudioExporter.kt:183-217` |
| P2-22 | 均衡器无总增益保护 | `audio/Equalizer.kt` |
| P2-23 | 批量删除串行 + 全量重扫 | `FuMiVoiceApp.kt:756-765` |
| P2-24 | `soundFonts.list()` 主线程 | `FuMiVoiceApp.kt:225-227` |
| P2-25 | 画中画固定 16:9 | `MainActivity.kt:112-116` |

---

## 12. 分阶段方案

### Phase 0（1–2 天，发布阻塞项）

1. **修构建**：`gradle-wrapper.properties` 改 8.9；跑一次 `assembleRelease` 产出可安装包（本机无 SDK 时改由父会话执行，见 §14）。
2. **解析下主线程**（P0-2）+ 装载中状态。
3. **补 BackHandler**（P0-3）：设置页、歌单详情、艺术家详情、编辑曲目弹窗前。
4. **验收**：从设置页/歌单详情按返回回到上一级；打开 20k 音符 MIDI 无 ANR（可用 `adb shell am start` + 手动构造大文件验证）。

### Phase 1（3–5 天，性能与稳定性）

5. 拆分 `PlayerUiState`，位置流独立（P1-1）。
6. `updateActiveNotes` 二分（P1-2）。
7. 瀑布绘制缓存（P1-3）+ `prepareNotes` 异步（P1-4）。
8. 音频焦点（P1-5）。
9. 导出改 ViewModel/前台承载，取消即清理（P1-8）。
10. **验收**：中端机播放 10k 音符曲目，帧率不低于 55fps（`adb shell dumpsys gfxinfo`）；接电话后自动暂停。

### Phase 2（3–4 天，外观与信息架构）— **本轮已先落一半**

11. 外观系统（材质/壁纸/持久化/设置入口）✅ 1.0.11 完成。
12. 图标（自适应 + 圆形）✅ 1.0.11 完成。
13. 设置入口从云同步页搬到顶栏齿轮（P1-9）。
14. 播放页控制区加材质面板（U7），对齐新外观。
15. **验收**：四材质 × 七背景任意组合下，正文对比度 ≥ 4.5:1（可用取色器抽查主/次文字）。

### Phase 3（1 周，质量基建）

16. 单测：`MidiParser`、`M3uCodec`、`AudioExporter`（WAV/FLAC）、`TrackSort`。
17. UI 测试一条主链路。
18. GitHub Actions：`assembleDebug` + `test` + `lint`（把 `checkReleaseBuilds` 改回 true）。
19. Baseline Profile。

### Phase 4（可选，产品力）

20. 练习模式：A-B 循环、等待模式、慢速跟练（竞品核心差异点）。
21. lite 变体：音色库改首启下载，APK 30MB → ~4MB。
22. 大屏/折叠布局（`WindowSizeClass`）。
23. 每应用语言迁官方 API + `localeConfig`。

### 验收口径（每阶段都要） 

- 手点：冷启动 → 导入 → 播放 → 混音 → 导出 → 分享 → 云同步 → 切语言 → 切外观 → 杀进程重进（偏好仍在）。
- 数据：`adb shell dumpsys meminfo` 峰值、`gfxinfo` 掉帧率、APK 体积。
- 回归：所有改动都要能回滚（本轮已在 `E:\Midi\_attic\FuMiVoice-Source-backup-20261029` 留了原件）。

---

## 13. 1.0.11 本轮已实施（源码，可回滚）

| 文件 | 性质 | 说明 |
|---|---|---|
| `ui/theme/Appearance.kt` | 新增 | `SurfaceMaterial`（玻璃/亚克力/云母/天鹅绒）、`WallpaperKind`（7 项）、`Appearance`、SharedPreferences 存储、进程级 `AppearanceHub`、`LocalAppearance` |
| `ui/theme/AppSurface.kt` | 新增 | `Modifier.appSurface()`：底色 + 发丝边 + 内发光 + 玻璃高光 + 亚克力/天鹅绒颗粒；`appBarColor()` |
| `ui/wallpaper/WallpaperArt.kt` | 新增 | 六张 Canvas 壁纸（极光/星空/深海/星云/渐变网格/暮色）+ `AppWallpaperBackdrop`（舞台 + 压暗 + 底部渐隐）；20fps 限帧漂移 |
| `ui/screens/AppearanceScreen.kt` | 新增 | 外观页：大图预览、材质格（各自叠当前壁纸）、壁纸格、压暗滑杆、漂移开关；改动即时生效 |
| `ui/screens/SettingsScreen.kt` | 修改 | 新增「外观」分区与入口（显示当前"材质 · 壁纸"）；四个分区卡改用 `appSurface()`；根节点透明 |
| `ui/components/Common.kt` | 修改 | `AppCard` 改走 `appSurface()`，全应用卡片随材质变 |
| `ui/FuMiVoiceApp.kt` | 修改 | 根节点透明；顶栏/底栏底色跟随材质 |
| `MainActivity.kt` | 修改 | `AppearanceHub.ensureLoaded` + `CompositionLocalProvider(LocalAppearance)` + `AppWallpaperBackdrop`；`enableEdgeToEdge` 固定浅色图标 |
| `res/values/themes.xml` | 重写 | 深色窗口背景（去白闪） |
| `res/values/colors.xml` | 新增 | 启动窗口 / 图标底色 |
| `res/mipmap-*/ic_launcher.png` | 替换 | 由 `FuFumidi-Source/frontend/src/assets/logo.png` 生成（48–192px，圆角） |
| `res/mipmap-*/ic_launcher_round.png` | 新增 | 圆形版 |
| `res/mipmap-*/ic_launcher_foreground.png` | 新增 | 自适应图标前景（108dp 画布，主体在 66/108 安全区） |
| `res/mipmap-anydpi-v26/ic_launcher(.xml/_round.xml)` | 新增 | 自适应图标 |
| `res/drawable/ic_launcher_background.xml` | 新增 | 深靛径向渐变背景层 |
| `res/values/strings.xml` / `values-en/strings.xml` | 修改 | 各 +29 条（材质/壁纸/外观页），键集仍 341:341 对齐 |
| `app/build.gradle.kts` | 修改 | versionCode 12 / versionName 1.0.11 |
| `AndroidManifest.xml` | 修改 | 增加 `roundIcon` |
| `keystore.properties.example` | 新增 | 签名模板（不含任何密钥） |
| `README.md` | 重写 | 功能/版本/构建/签名/图标/外观系统说明 + 两个构建坑 |

**没做的事（有意）**：未改播放/导出/云同步/小组件逻辑；未删除任何现有功能；未写入任何证书或口令；未改动 `values/strings.xml` 既有条目（只追加）。

**与原设计的取舍**（需要用户知情）：

- 默认外观改为"玻璃 + 极光 + 42% 压暗"。若不喜欢，设置 → 外观 → 壁纸选「无（纯色）」即可回到 1.0.10 的纯色底。
- Compose 没有 `backdrop-filter`，所谓"玻璃"是**半透明 + 高光 + 亮边**的模拟，不是真模糊。真模糊在 API 31+ 可用 `RenderEffect`，但低版本会退化成硬边，故统一不用。
- 壁纸默认**不漂移**（省电）；开关在同一个页面。

---

## 14. 构建与阻塞

### 14.1 本机环境实测

| 项 | 结果 |
|---|---|
| JDK | Temurin **25.0.4**（另有 `temurin17-jdk`）——AGP 8.5 需要 JDK 17，用 25 会报 "Unsupported class file major version" |
| Android SDK | **未安装**（`ANDROID_HOME`/`ANDROID_SDK_ROOT` 为空；常见路径均无 `platforms/android-36`） |
| NDK / CMake | 未找到（`scoop` 里有 cmake，但没有 NDK） |
| Gradle 缓存 | 有（androidx、Compose、Kotlin 1.9.24 都在），说明**曾经在别的机器/环境构建过** |
| 结论 | **无法编译**，只能做静态核验；已用 Kotlin PSI 完成 56 文件的语法级验证（0 错误） |

### 14.2 阻塞项

1. **无 Android SDK/NDK** → 不能 `assembleDebug`，也无法产出 APK/AAB。需父会话在有 SDK 的环境执行，或安装 `platforms;android-36` + `build-tools` + NDK。
2. **Gradle wrapper 版本**（P0-1）→ 即使有 SDK，当前 wrapper 9.3.0 与 AGP 8.5.0 也会失败；改 8.9 后再构建。
3. **JDK 版本** → 必须用 JDK 17 跑 Gradle（`JAVA_HOME` 指向 `temurin17-jdk`）。
4. **签名** → 仓库内无 keystore；`keystore.properties` 缺失时只能出未签名包。父会话提供 `.jks` 后按 README 填写四项即可。
5. **类型级编译未验证**：新代码的 Compose API 用法按 1.6.8 / Material3 1.2.1 编写（BOM 2024.06），若实际依赖有差异，最可能需要微调的是 `Modifier.appSurface` 里的 `onDrawBehind` 与 `Icons.Default.Palette`。

### 14.3 建议的首次构建命令（有 SDK 的机器）

```bash
export JAVA_HOME=<temurin-17>
# 1) 先把 wrapper 改回 8.9（或升级 AGP，二选一）
sed -i 's#gradle-9.3.0-bin.zip#gradle-8.9-bin.zip#' gradle/wrapper/gradle-wrapper.properties
# 2) 调试包
./gradlew :app:assembleDebug
# 3) 签名 release（需 keystore.properties）
./gradlew :app:assembleRelease
apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
```

---

## 附录 A：可复现的检查命令

```bash
# 语法：用 Gradle 缓存里的 kotlin-compiler-embeddable 做 PSI 解析（本轮 56 文件 0 错误）
#   见 E:\Midi\_attic\tools\ParseCheck.java + brace_check.py

# 中英文案键集是否成对（应输出两行相同数字）
grep -c '<string ' app/src/main/res/values/strings.xml app/src/main/res/values-en/strings.xml

# 硬编码中文（只应剩 PlaybackService 的四处）
grep -rn 'Text("' --include='*.kt' app/src/main/java | head

# 是否接了返回键（当前 0 命中 → P0-3）
grep -rn 'BackHandler' --include='*.kt' app/src/main/java

# 是否处理音频焦点（当前 0 命中 → P1-5）
grep -rn 'requestAudioFocus\|AudioFocusRequest' --include='*.kt' app/src/main/java

# 包体构成
du -sh app/src/main/assets app/src/main/jniLibs app/src/main/res
```

## 附录 B：本轮新建的辅助脚本（不在仓库内）

| 路径 | 用途 |
|---|---|
| `E:\Midi\_attic\tools\ParseCheck.java` | Kotlin PSI 语法核验 |
| `E:\Midi\_attic\tools\brace_check.py` | 括号/引号平衡粗检 |
| `E:\Midi\_attic\tools\make_icons.py` | 由 `logo.png` 生成全部图标（改尺寸/留白只改这一个脚本） |
| `E:\Midi\_attic\FuMiVoice-icon-preview\` | 图标预览（512 / 自适应 432 / 48dp 放大） |
| `E:\Midi\_attic\FuMiVoice-Source-backup-20261029\` | 本轮改动前的原件备份（回滚用） |
