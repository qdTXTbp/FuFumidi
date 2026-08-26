# 与原仓库的改动对比说明

本文档记录 `monologue82/FuFumidi`（fork 分支）相对原仓库 `qdTXTbp/FuFumidi` 的改动。核心目标：**前端现代化重构（Vue 3）+ 稳定性修复 + 转录引擎可靠性保障**，保留全部离线能力。

---

## 1. 前端整体重构（Vue 3 + Vite，渐进式）

原仓库为单文件 `renderer/FuFumidi.html`（约 800KB 内联 JS/CSS），维护成本高。现采用**渐进式重构**：核心音频/MIDI 逻辑保留模块化，UI 层拆分为 Vue 3 组件，构建产物输出到 `renderer/dist`；`main.js` 加载新版 Vue 界面。旧版单文件界面已彻底移除（删除 `renderer/FuFumidi.html` 与 `edit-guide.html`），构建前需先执行 `cd frontend && npm run build` 生成界面。

### 新增前端目录结构
```
frontend/
├── src/
│   ├── main.js / App.vue / styles.css      # 应用壳 + MiniMax 设计系统样式
│   ├── store.js                             # 全局响应式状态（歌单/播放/混音/视图）
│   ├── audio.js                             # Web Audio 单例（Synth + Player）
│   ├── core/                                # 从原仓库抽取的模块化核心
│   │   ├── midi.js                          # MIDI 解析 / 编码 / 歌曲模型
│   │   ├── synth.js                         # Web Audio 合成引擎（多音色）
│   │   ├── player.js                        # 基于 tick 的精确调度播放器
│   │   ├── util.js / analysis.js / score.js / i18n.js
│   ├── components/                          # Icon / TopBar / SideBar / PlayerBar / PianoRoll / EditorCanvas
│   └── views/                               # 各功能视图
│       ├── ViewHome / ViewPlay / ViewLyrics / ViewAnalyze
│       ├── ViewViz / ViewScore / ViewConvert / ViewTranscribe / ViewEdit
│       └── ViewPlaceholder                  # 未迁移视图占位
```

### 视图迁移状态（9 个视图全部完成）
| 视图 | 状态 |
|---|---|
| 首页 / 演奏 / 歌词 / 分析 / 可视化 / 乐谱 / 转换 | ✅ 已迁移 |
| 转录（音频→MIDI） | ✅ 已迁移（三种引擎全部实测跑通） |
| 编辑（钢琴卷帘） | ✅ 已迁移 + 增强 |

---

## 2. 编辑器增强（EditorCanvas / ViewEdit）

钢琴卷帘编辑器完整迁移并新增多项原仓库核心编辑能力：

- **三种工具**：选择（V）/ 画笔（B）/ 橡皮（E）；吸附网格（关~1/32 拍）；轨道切换
- **撤销/重做栈**：深拷贝快照（含音符 + CC 数据）
- **操作**：删除、量化、移调（±1/±8 半音）、复制/粘贴到播放头/克隆、力度渐强/渐弱、同音高批量选择
- **音符边缘拉伸**：右/左边缘拖拽改长度，吸附对齐
- **力度曲线编辑器**：弹窗绘制力度包络应用到选区，连续插值画线
- **列表编辑器**：选中音符表格化精确编辑（起点/终点/音高/力度），支持大选区（实测 4869 行）
- **CC 泳道**：独立泳道绘制 CC 自动化曲线（CC1/7/10/11/64 可选），拖拽绘制控制点
- **踏板快捷添加/删除**：选区/整轨起止添加 CC64 延音
- **鼓组编辑器**：打击乐网格（29 鼓件 × 8 小节），点击添加/删除鼓点、轨道切换、清除
- **迷你图导航 + 缩放控制**、属性检查器、快捷键（Ctrl+Z/Y/A/C/V、Del、B/V/E 切工具、Ctrl+S 导出）
- **导出 MIDI**：桌面端 `saveBinary` 原生对话框 / 浏览器下载

---

## 3. Bug 修复

### 3.1 歌词视图（ViewLyrics）
- **编辑误改其他行**：`collectLyrics` 携带事件引用 `ev`，保存直接操作原事件
- **副歌重复行被去重**：改为 `(tick, text)` 组合键精确去重
- **时间码浮点溢出**：先取整总毫秒再拆分（修复 `00:04.1000` 异常）
- **日文 LRC 乱码**：`readAsArrayBuffer` + 编码自动检测（先严格 UTF-8，失败回退 Shift-JIS）

### 3.2 全局交互
- **进度条无法拖动**：`PlayerBar` 引入拖动状态，避免 rAF 循环覆盖用户拖动值
- **页面跳转/刷新丢失**：视图切换同步 URL hash（`#/view`）+ `hashchange` 监听 + 启动恢复
- **上传 MIDI 刷新消失**：IndexedDB 持久化原始 MIDI 字节，启动 `restoreSongs()` 恢复歌单，选中时懒加载解析
- **音频渲染卡 70%**：`ViewConvert` 重构为分桶离线渲染（每 10 秒一桶 OfflineAudioContext + overlap-add 合成），并修复音量双重增益

### 3.3 编辑器显示
- **音域显示错误**：`computeRange()` 按曲目内容自动定位音域（原先固定 midi 60 导致高音音符不可编辑）
- **`pxPerTick` 误用**：修正 `song.value` → `song()`（非 480 tpb 曲目坐标错乱）
- **轨道下拉音符数不刷新**：改绑 `state.tracks[i].noteCount`（编辑后实时刷新）
- **网格线显示异常**：垂直网格改为按「拍」绘制（与吸附粒度解耦）+ 小节线过密跳过 + 新增水平音高轨道线

---

## 4. 转录引擎修复（三种模式全部验证跑通）

在 Python 3.13 / RTX 5060（Blackwell）环境实测，修复两个关键引擎 bug：

### 4.1 钢琴专用模式全 0 音符（engine_pt.py）
- **现象**：`--mode piano` 转录完成但输出 0 音符
- **根因**：GPU 推理使用 `torch.autocast(cuda)` 混合精度，在 RTX 50 系（Blackwell）上输出全 0
- **修复**：移除 autocast，GPU 推理直接用 fp32（`inference_mode` 保留）
- **结果**：真实歌曲转录 130 音符

### 4.2 人声分离模式崩溃（engine_separate.py）
- **现象**：demucs 分离报 `_PassThrough has no attribute 'format_interval'`
- **根因**：`_neutralize_tqdm` 补丁类缺少 `format_interval/format_sizeof/update/close` 等旧 tqdm API；demucs 4.1.0 优先从 HuggingFace 下载模型
- **修复**：补全 `_PassThrough` 兼容方法 + 设置 `HF_HUB_OFFLINE=1` 强制使用本地 `demucs/remote/` 权重
- **结果**：真实歌曲分离后转录 186 音符

### 4.3 引擎测试
- universal（basic-pitch）：真实歌曲 141 音符 ✅
- piano（piano-transcription + GPU）：130 音符 ✅
- separate（demucs htdemucs + GPU）：186 音符 ✅

---

## 5. 构建与配置

- **`electron-builder.yml` / `electron-builder.base.yml`**：`win.icon` 改为 `build/icon.png`（electron-builder 自动转 ICO）
- **`build/icon.png` / `frontend/src/assets/logo.png`**：替换为新的项目 Logo（460×460）
- **`.gitignore`**：新增 `resources/`（Python 运行时）、`models/`（转录模型）、`engine/__pycache__/`、`renderer/dist/`——大体积构建资源不入库，构建前按 README 准备
- **CI**：`build-installers.yml` 同步更新
- 前端构建：`cd frontend && npm install && npm run build`，产物输出到 `renderer/dist`

---

## 6. 依赖说明（转录引擎）

- **全局 Python 3.13**：`basic-pitch`（需 `--no-deps` 安装，Python 3.13 下旧 numpy 构建失败）+ `pretty_midi` + `mir_eval` + `resampy<0.4.3` + `scikit-learn`（librosa/onnxruntime/torch 已具备）
- **钢琴模型** `note_F1=0.9677_pedal_F1=0.9186.pth`（约 160MB）→ 放 `models/piano_transcription/`
- **demucs 权重** `955717e8-8726e21a.th`（约 80MB）→ 放 Python 环境 `site-packages/demucs/remote/`
- separate 模式建议使用**打包 Python 3.11 运行时**（依赖完整、无版本冲突）

---

## 7. 使用方法

```bash
# 前端构建
cd frontend && npm install && npm run build

# 桌面端运行（开发）
npm install
npm start

# 打包 Windows 安装包（需先准备 resources/：python 运行时、models、elevate.exe）
npm run dist:win
```

---

## 8. 与原仓库功能对齐（缺失功能全部补齐）

对原仓库 `FuFumidi.html` 逐功能盘点后，将新版尚未覆盖的功能全部补齐（后端 IPC 在 preload.js / main.js 中已预先就绪，本次完成前端 UI 接入）：

### 8.1 编辑器高级功能（ViewEdit / EditorCanvas）
- **智能伴奏**：按小节和弦分析自动生成「智能贝斯 + 智能分解和弦 + 智能铺底」3 轨（全量快照可撤销）
- **智能量化 + Groove**：网格（1/4~1/32）+ Funk/Jazz/Rock/Latin/自定义 Groove 模板 + 强度调节 +「提取选中为 Groove」
- **逻辑编辑器**：目标（全部/选中/当前轨）× 条件（力度/时值/音高）× 操作（力度±/固定/量化/移调/删除）批量规则
- **宏系统**：内置宏（清理工程/批量移调/力度标准化）+ 自定义命令宏（transpose/quantize/normalize/vel_*，localStorage 持久化）
- **Key Switch 映射**：C-2~C0（MIDI 0-24）技法命名 + Spitfire/VSL/EastWest 预设，卷帘橙色高亮显示
- **音频对齐工具**：载入原音频 → 卷帘底部波形绘制；选区/整轨「吸附起音」（±80ms 波形起音检测）；「试听」同步播放原音频
- **音色工具**：GM 音色下拉切换、应用到全部非鼓轨、按音域/名称智能选音色
- **批量操作**：和弦批量选择、删除短音（<80ms）、响度 ±10%
- **BPM 修改应用**：改写 tempo 事件（不影响音符 tick），重算时间映射
- **CC 进阶**：双 CC 泳道、手绘/直线/曲线三种绘制模式、CC 事件列表查看/删除
- **其他**：音阶吸附（新音符吸附调式）、撤销历史面板、编辑器内歌词添加（到选中音符）、全屏编辑、编辑功能说明弹窗、视频轨道嵌入（影视配乐对齐，右上角同步播放）
- **撤销快照升级**：`pushStateForTrack(-1)` 全量快照，智能伴奏/逻辑编辑器/宏等跨轨道操作可完整撤销

### 8.2 转换视图视频导出（ViewConvert）
- **视频 / 可视化导出**：canvas.captureStream + MediaRecorder 后台录制 → `video:transcode`（内置 ffmpeg）合成 MP4 + 音频
- 参数：画面比例（横屏/竖屏/字幕留白）、分辨率（720P~4K）、帧率（24/30/60）、质量/自定义码率、时长（15/30/60/整首）、自定义区间、背景色/背景图片、水印+透明度、歌词字幕、进度条/时间码开关
- 可视化内容：Synthesia 风格音符瀑布 + 频谱瀑布 + 波形示波器 + 实时和弦识别
- 音频渲染重构：提取 `renderAudioBuffer()` 供音频导出与视频导出复用

### 8.3 乐谱视图（ViewScore）
- **MusicXML 导入**：新增 `core/musicxml.js` 解析器（多 part/节拍/调号/装饰音）→ 编码为 MIDI 载入
- **PDF 导出**：`score:exportPdf`（printToPDF）；**分页预览**：SVG 栅格化 PNG 逐页展示
- **点击定位**：点击乐谱音符定位播放头并高亮对应钢琴卷帘音符

### 8.4 播放器（PlayerBar）
- **MIDI 硬件输出**：`navigator.requestMIDIAccess` 选首个输出设备，播放时同步发送 NoteOn/NoteOff（新增 `core/midiout.js`，`player.onNote/onStop` 旁听回调），停止时 All Notes Off 防卡音
- **BPM 输入**：与速度倍率双向联动（BPM = 原速 × tempo）
- **混音台弹窗**：轨道音量/声像/独奏/静音（复用 `state.tracks` + store 方法）

### 8.5 歌词视图（ViewLyrics）
- **批量替换**：查找/替换遍历全部 lyric 事件
- **编辑器内添加歌词**：编辑视图「添加歌词」为选中音符写入 lyric 事件（本视图提供入口提示）

### 8.6 全局系统（App / TopBar / 新组件）
- **设置面板**（`SettingsPanel.vue`）：外观（主题/强调色/字号/密度/语言）、引擎（Python 路径/默认模式/模型清单/依赖检查补全/诊断导出）、功能（输出目录/命名规则/监视文件夹/引导重置/MIDI 文件关联）、快捷键、插件（启用开关/重扫描/日志）
- **完整性检验**：启动后台检查 + 设置面板警告条 + 一键修复（`integrity:check/repair`）
- **主题库**（`ThemeLibrary.vue`）：10 个内置主题 + 图片提取主色生成自定义主题，即时换肤持久化（`core/theme.js`）
- **命令面板**（`CommandPalette.vue`）：Ctrl+K 搜索执行视图/导入/设置等命令
- **新手引导**（`GuideOverlay.vue`）：首次启动弹 3 场景实操引导（转录/编辑/乐谱），可跳过/重置
- **i18n 响应式**：语言切换即时刷新外壳文案

---

## 9. 2026-08-26 功能修复与补齐（v2.0.1 对齐项）

### 9.1 主题系统修复
- **根因**：--accent/--brand-blue 变量定义后几乎未被消费，切换主题界面无感知。
- 按钮（btn.primary）、顶栏 Tab 激活态、侧边栏导航激活指示条、页面图标、歌曲激活行、渲染进度条全部改用主题色变量；Logo 渐变改用主题深色。
- 新增 accentRgb()（canvas 用 r,g,b 三元组），分析视图柱状图/波形/力度曲线跟随主题色。

### 9.2 分析视图图表错位修复
- 根因：.chart-wrap 内 canvas 缺 width/height 样式，默认 300×150 内联尺寸与容器错位。
- 新增 .chart-wrap canvas { display:block; width:100%; height:100% }；并修复 data 未就绪时渲染崩溃（v-else-if 空态保护）。

### 9.3 视频导出预览
- 录制完成后生成本地 WebM 预览，面板内置视频播放器（回放/下载 WebM/转 MP4 提示）；VE 改为 shallowReactive 使模板 v-if 响应。

### 9.4 参数预设批量管理
- 预设管理器：↑↓ 排序（presets:reorder）、删除内置=隐藏、一键恢复全部内置（presets:restore）、选中即应用、内置/自定义标记。

### 9.5 歌单批量管理与新歌单
- 多歌单：新建/重命名/删除（localStorage 持久化）、收藏歌单、全部曲目视图。
- 每首歌：收藏 ♥ / 添加到歌单（输入歌单名自动创建）/ 移除。
- 批量管理：勾选模式 → 全选 / 删除 / 移到歌单；删除歌曲时自动清理所有歌单引用。
- 新增 i18n 词条 40+（歌单/批量/预设/预览）。

### 9.6 角色图背景装饰
- 桌面提供 1024×1024 角色图（frontend/src/assets/character.jpg）作为全局背景装饰。
- 位置：右下角（right -60px / bottom 86px 避开播放条），尺寸上限 320px（min(320px, 28vw)）。
- 融入方式：opacity 0.6 + 径向 mask 边缘羽化（42% 清晰 → 82% 渐隐）+ 内容层 z-index 提升保证不遮挡交互。

### 9.7 毛玻璃系统（玻璃拟态）
- 取消角色图背景装饰（app-deco 与 character.jpg 移除）。
- body 改为浅色渐变占位背景（未来可替换为全屏背景图）；.app-main 背景透明化。
- 新增 CSS 变量 --glass-bg/-strong/-soft/--glass-dark/--glass-blur。
- 全组件毛玻璃：侧边栏/顶栏（白玻璃）、播放条（深色玻璃）、卡片/面板/弹窗/列表项/表单控件统一 backdrop-filter blur + 半透明底；激活态用 color-mix 主题色半透明玻璃。
- hover 态保持玻璃，不还原为不透明。
- 编辑器/乐谱画布等需清晰白底的区域保持不透明。

### 9.8 内置动态壁纸（背景视频）
- 桌面两个视频（芙宁娜.mp4 / studio_video_1716732543213.mp4）复制到 frontend/public/wallpapers/ 作为项目内置资源（不入 git，超 GitHub 100MB）。
- 全屏背景视频层（.app-wallpaper）：静音循环、object-fit cover，毛玻璃组件透出其画面；main.js 开启 allowFileAccessFromFileUrls。
- 切换：顶栏壁纸按钮循环 关→视频1→视频2→关；设置面板外观区可启用/播放/更换源（存 localStorage）。
- electron-builder asarUnpack 排除 renderer/dist/wallpapers 避免 asar 内播放问题。

### 9.9 GitHub 壁纸库（缩略图选择下载）
- 壁纸上传至独立仓库 monologue82/Media（wallpapers/，视频走 Git LFS + 同名 jpg 缩略图）。
- 新增 WallpaperGallery.vue：从 GitHub API 拉取壁纸列表，仅显示缩略图（不显示名称），点击即下载并应用（流式下载到 userData/wallpapers）。
- 首次启动询问：只弹一次「是否从 GitHub 下载一张壁纸」，入口在顶栏/设置面板壁纸库。
- main.js 新增 wallpaper:list / wallpaper:download IPC（net.fetch，支持代理）；后续需要更多壁纸可再次进入壁纸库或自行导入。
