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
