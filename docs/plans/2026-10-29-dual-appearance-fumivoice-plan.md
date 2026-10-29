# 双端升级方案（审阅稿）

日期：2026-10-29
状态：**已按确认决策执行完成，等待审阅发布**

## 0. 一页结论

### A. FuFumidi 桌面端

1. 许可证免责声明：不讨论法律定性，只在“关于与许可”页加三句明确文案：本体开源免费、第三方模型/音色/插件由用户自行选择下载、版权归作者、按现状提供、不授予商业使用权。
2. 外观材质：现有“主题 / 壁纸 / 显示”三页抽屉新增“界面材质”，提供原生、玻璃、亚克力、云母、磨砂、天鹅绒六档；大块表面统一走材质层。
3. 首页 FuMiVoice 下载入口：首页新增“FuMiVoice 手机版”卡片，直达 GitHub Releases；文案、图标、蓝色强调与现有首页一致。

建议版本：6.3.0。

### B. FuMiVoice Android

现状 1.0.10，56 个 Kotlin 文件、约 16.3k 行。功能面强，但三个发布级问题：

1. Gradle 9.3.0 与 AGP 8.5.0 超出官方支持矩阵，构建不可复现；
2. 主线程解析整首 MIDI，大曲目卡顿/ANR；
3. 完全没有 BackHandler，二级页按返回直接退出应用。

外观目标：六材质 × 7 内置代码壁纸 + 压暗 + 缓慢漂移，与 FuFumidi 深靛/玻璃语言同构；图标取 FuFumidi logo 的图形与配色做抽象版；签名沿用现有 keystore.properties。

建议版本：1.1.0（versionCode 13）。

### 当前阻塞

- FuMiVoice 签名 keystore 已提供：C:/Users/qdTXTbp/Desktop/work/密钥库口令/fumivoice-release.jks（4.5 KB，未读取口令）。仍需在正式构建时验证它与 1.0.10 的证书 SHA-256 一致，才能覆盖安装。
- Android 构建环境：本机原本没有 Android SDK/NDK；本轮只准备到 JDK17/SDK 前置，未执行完整 release 构建。批准后再完成。
- FuMiVoice 源码不是 git clone：当前是 GitHub raw 源码快照（无 .git），完成后需落正式仓库/分支。

## 1. FuFumidi 方案

### 1.1 免责声明

位置：关于与许可页顶部独立卡片；资源中心模型下载区可选加一行入口。

建议文案：

> FuFumidi 本体开源免费。模型、音色库、插件等第三方资源由用户自行选择下载，其版权与许可归各自作者所有。
>
> 本软件不授予任何第三方模型的商业使用权。下载或使用即表示你同意遵守对应资源的许可证及当地法律。
>
> 第三方资源按“现状”提供，不附带任何担保；模型效果、兼容性与可用性由原作者决定。

实现：新组件 LicenseDisclaimer.vue；文案走 i18n 四语言；不增加启动弹窗；不改模型下载逻辑。

### 1.2 外观材质

六档：原生（默认）、玻璃、亚克力、云母、磨砂、天鹅绒。

位置：外观抽屉 → 主题页 → 强调色下方；六格缩略块，点击立即应用并保存。

持久化：settings.ui_material，默认 default；随 settings 同步；未知值归一化。

视觉：

- 玻璃：半透明 + 背景模糊 + 白边 + 顶部高光。
- 亚克力：更高不透明度 + 细颗粒 + 强边缘。
- 云母：低对比渐变 + 发丝边 + 轻模糊。
- 磨砂：低饱和 + 中等模糊 + 均匀灰面。
- 天鹅绒：哑光深色 + 顶部暖色内发光 + 软阴影。

CSS 只覆盖大块表面：card、topbar、sidebar、playerbar、外观抽屉、任务面板、弹窗、首页 hero/快捷卡、可视化卡。默认档零额外开销；backdrop-filter 不逐卡片叠加。

验收：六档在浅/深色、100%/130% 缩放下可读，正文对比度 ≥4.5:1；重启保持；外观抽屉/首页/编辑器/播放页截图；切换后 p95 帧时间增量 ≤1ms。

### 1.3 首页 FuMiVoice 入口

位置：首页快捷三卡之后、最近项目之前，横向卡片。

内容：左侧音乐图标；标题“FuMiVoice 手机版”；副标题“Android 播放器 · SoundFont · 瀑布钢琴卷帘 · 音频导出”；右侧“下载 Android 版”主按钮。

行为：打开 GitHub FuMiVoice Releases 最新页；优先 bridge.openExternal，浏览器回退 window.open；不内嵌下载、不静默下载 APK、不统计点击。

验收：中/英/日文案完整；980px 窗口按钮不溢出；点击确实打开系统浏览器。

### 1.4 版本与发布

6.3.0；changelog 增加“界面材质 / 免责声明 / FuMiVoice 入口”；同步 package、锁文件、version.js、README 当前版本；跑 typecheck、test:ui、check:i18n、check:version、licenses；发布前截图走查。

## 2. FuMiVoice 方案

详细审计见 docs/plans/2026-10-29-fumivoice-audit.md（598 行，含 file:line）。

### 2.1 现状评价

优势：BASS 官方绑定、变速/变调绕开 MIDI_SPEED、文件头嗅探、节拍器不累计漂移；瀑布卷帘布局正确；四格式导出、10 段 EQ、16 通道混音、小组件、PIP、云同步；中英文案 341 条成对；颜色/字号/间距/动效已 token 化。

P0：

1. Gradle wrapper 9.3.0 + AGP 8.5.0 不兼容 → 固定 Gradle 8.9，或升级 AGP 到兼容版本，二选一。
2. 主线程解析 MIDI（MidiPlayerManager.loadPath）→ Dispatchers.Default，加载中状态。
3. 无 BackHandler → 设置、歌单详情、艺术家详情、编辑弹窗返回上一级；补预测性返回。

P1：30ms 全量状态广播导致整树重组；updateActiveNotes O(n) 全扫；瀑布每帧新建 Brush/文本测量；prepareNotes 在组合线程排序；无音频焦点；云 token 明文 + allowBackup；首启 30MB 音色解压无进度；导出随弹层取消；设置入口藏在云同步页；通知/小组件硬编码中文；0 测试；包体 30MB（27MB 内置音色）；未开 R8。

P2：ViewModel/NavHost、上帝文件拆分、collectAsStateWithLifecycle、@Preview、主题图标 monochrome、大屏适配、更新包签名校验等。

### 2.2 外观系统

材质：统一为六档（原生/玻璃/亚克力/云母/磨砂/天鹅绒），与 FuFumidi 同一命名。当前原型只有 4 档，实施时补原生/磨砂。

壁纸：7 张纯代码 Canvas 壁纸（无/极光/星空/深海/星云/渐变网格/暮色），不打包位图；可调压暗 0–100%、缓慢漂移开关（默认关，省电）。

范围：根背景壁纸 + 舞台 + 压暗铺所有页；卡片走 appSurface()；顶栏/底栏跟随；设置 → 外观含材质网格、壁纸网格、压暗滑杆、漂移开关、实时预览。

默认：玻璃 + 极光（已确认）。

Compose 限制：没有 CSS backdrop-filter，玻璃只能半透明+高光+亮边模拟；API31+ 真模糊低版本退化，统一不用。验收按视觉与可读性，不承诺真模糊。

### 2.3 图标

方向：取 FuFumidi logo 的**图形与配色做抽象版**，不直接使用角色立绘。

源图：FuFumidi-Source/frontend/src/assets/logo.png。

生成：mipmap 48–192px、圆角版、自适应前景 432px（66/108 安全区）、背景深靛径向渐变；补 mipmap-anydpi-v26/ic_launcher.xml / _round.xml；Android 13 主题图标 monochrome 层；Manifest 补 roundIcon。预览落 _attic/FuMiVoice-icon-preview。

### 2.4 签名

已提供 keystore：`C:/Users/qdTXTbp/Desktop/work/密钥库口令/fumivoice-release.jks`（4.5 KB）。口令/别名参考同目录 `密钥.txt`，证书指纹参考 `证书.txt`。

实施步骤：

1. 写入本地 `keystore.properties`（不提交、不打印口令），storeFile 指向该 .jks。
2. assembleRelease 后用 apksigner verify --print-certs 对比 `证书.txt` 的 SHA-256，确认与 1.0.10 同一签名，才能覆盖安装。
3. 若指纹不一致，停止发布并说明，不允许静默换签名。

### 2.5 音色库同步

统一 FuMiVoice 与 FuFumidi 的音色库规则：

- 默认音色同为 GeneralUser GS；音色命名、GM 节目映射、SoundFont 元数据一致。
- 支持同样的 .sf2/.sf3 导入、在线下载、校验、删除/替换；FuFumidi 使用的 SoundFont 文件可直接导入 FuMiVoice。
- 内置 30MB GeneralUser 是否改为首启下载，作为独立“包体策略”决策；本轮先保持内置，确保离线可用。
- 不承诺跨设备自动同步二进制文件；只保证格式/目录/命名规则兼容，避免两端音色对不上。

### 2.6 构建与发布

版本目标：**FuMiVoice 1.1.0 / versionCode 13**。

JDK17（本机已下载 Corretto17）+ SDK platform 36/build-tools 36（已准备）+ Gradle 8.9。

不依赖 NDK：LAME 使用现有 APK 的 libmp3lame_jni.so，移除 CMake 编译；或安装 NDK 后恢复原生构建（二选一）。

产物：app-release.apk + app-release.aab；版本 1.1.0 / versionCode 13；更新 version.json 与 Release 资产；签名指纹、包名、versionCode、安装覆盖测试；README 写构建/签名（不含口令）。

## 3. 并行执行计划（批准后）

阶段 1（1–2 天）：FuFumidi 免责声明、材质默认档、首页入口；FuMiVoice 修 Gradle 8.9、主线程解析、BackHandler；确认 keystore。产出两端可编译。

阶段 2（2–3 天）：FuFumidi 六档材质 + 外观 UI + 截图走查；FuMiVoice 六档材质 + 7 壁纸 + 设置入口 + 图标 + 主题色。产出两端同风格截图对比、偏好持久化。

阶段 3（2–3 天）：FuFumidi 6.3.0 构建/安装/截图/发布；FuMiVoice 1.1.0 签名 APK、覆盖安装、更新提示。产出安装包、截图、变更清单、回滚点。

> 实际状态（2026-10-30）：已构建 FuFumidi 6.3.0、部署本机并冒烟；已构建 FuMiVoice 1.1.0 签名 APK/AAB；尚未上传 Release。详见 docs/plans/2026-10-30-execution-report.md。

阶段 4（后续）：FuMiVoice P1 性能/音频焦点/导出/测试；FuFumidi 审计中的编辑器 P0 另行排期。

## 4. 已确认的产品决策（2026-10-29）

1. **免责声明**：使用第 1.1 节三句；资源中心不加次入口，主入口仍在关于页。
2. **材质**：FuFumidi 与 FuMiVoice 统一为六档，原生为默认。
3. **FuMiVoice 默认外观**：玻璃 + 极光。
4. **FuMiVoice 图标**：取 FuFumidi logo 的图形与配色做**抽象版**，不使用角色立绘。
5. **签名**：使用 `C:/Users/qdTXTbp/Desktop/work/密钥库口令/fumivoice-release.jks`；先验证证书 SHA-256 与 1.0.10 一致。
6. **音色库**：FuMiVoice 与 FuFumidi 使用同一套音色库规则（GeneralUser 默认、支持导入/下载 .sf2/.sf3、同一套音色命名），并支持把 FuFumidi 使用的 SoundFont 直接导入 FuMiVoice。
7. **版本**：FuFumidi **6.3.0**；FuMiVoice **1.1.0（versionCode 13）**。

**执行状态**：已按上述决策完成 FuFumidi 6.3.0 与 FuMiVoice 1.1.0；构建、签名与安装版冒烟见执行报告。**尚未上传 Release / 打 tag**，等审阅后再发布。

## 5. 已改但未发布的原型清单（请审阅是否保留）

### FuFumidi

- 新增 frontend/src/core/material.js、frontend/src/components/LicenseDisclaimer.vue
- 修改 App.vue、AppearancePanel.vue、styles.css、ViewAbout.vue、ViewHome.vue、i18n 两表、types/ipc.ts、main/settings.js
- 已本地构建并截图：材质面板、首页 FuMiVoice 卡片；未发布、未改版本号
- 本地已临时部署原型，默认材质被测试改为玻璃；正式发布前恢复 default 并重新走查

### FuMiVoice

- 源码快照在 E:/Midi/_attic/FuMiVoice-Source
- 新增/修改 Appearance.kt、AppSurface.kt、WallpaperArt.kt、AppearanceScreen.kt、SettingsScreen.kt、Common.kt、FuMiVoiceApp.kt、MainActivity.kt、图标资源、strings、themes、README 等
- 已做 Kotlin PSI 语法核验 + 手工 classpath 语义编译：全项目 0 类型错误；Gradle 未出包、未签名、未发布
- 原始备份在 _attic/FuMiVoice-Source-backup-20261029

## 6. 验收总表

| 项 | 验收 |
|---|---|
| FuFumidi 免责声明 | 关于页三句完整；四语言；无控制台错误 |
| FuFumidi 材质 | 六档可切、重启保持、浅/深/缩放可读、对比度≥4.5:1 |
| FuFumidi 首页入口 | 卡片 980/1280/1585 不溢出；点击打开 FuMiVoice Releases |
| FuFumidi 版本 | 6.3.0 四源一致；门禁全绿；安装包可覆盖安装 |
| FuMiVoice 构建 | Gradle 8.9 + JDK17 + SDK36 可复现；release 签名验证通过 |
| FuMiVoice 外观 | 六材质 × 7 壁纸 × 压暗；重启保持；可回纯色 |
| FuMiVoice 图标 | 自适应/圆形/主题单色；桌面图标与 FuFumidi 同一视觉 |
| FuMiVoice 核心 | 冷启动/导入/播放/瀑布/混音/导出/切外观/杀进程恢复 |
| 签名 | 与 1.0.10 证书 SHA-256 一致；覆盖安装成功 |
