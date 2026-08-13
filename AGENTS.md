# AGENTS.md —— FuFumidi 项目宪法

> 本文件是给 AI（与人类）的项目背景文档。动手改代码前请先读它。
> 未列出的文件约定，以代码中的既有注释与实际实现为准，不要臆造。

## 一、项目一句话定位

**FuFumidi = 音频 → MIDI 转录 + 播放 / 编辑 / 可视化 一条龙桌面应用。**

- Electron 壳：`app/main.js`（主进程）+ `app/preload.js`（`fuBridge` 桥）+ `app/renderer/FuFumidi.html`（单文件渲染界面）。
- Python 子进程引擎：`app/engine/`（音乐转 MIDI 转录引擎，源自 AudioMuse 工具内核）。
- 架构基调：**纯离线本地应用**。不依赖网络服务，音频不上传，模型本地加载。

---

## 二、架构决策与理由

以下决策均从代码事实中归纳，改动前请先核对对应源码。

### 1. 转录用 Python 子进程，Electron 只做壳

- 转录引擎是 Python：`basic-pitch`（ONNX，通用/人声分离）/ `piano-transcription-inference`（torch，钢琴专用）/ `demucs`（torch，人声/乐器分离）。
- Electron 主进程通过 `child_process.spawn` 调用 `music2midi.py` 的 **convert / refine / probe** 命令行（`app/main.js` 的 `spawnEngine()`）。
- 智能修正是独立脚本 `smart_midi.py` 的 `refine` 子命令（spawnEngine 的 `script` 参数可换脚本）。
- **进度协议**：引擎把结果输出为一行 `###RESULT {json}`，主进程按行解析；其余 stdout 逐行转发为进度日志（`engine:log` / `engine:refine:log`），stderr 独立缓冲，防止串入 RESULT 行。
- **编码约定**：spawn 时注入 `PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1`，避免 Windows 默认 GBK 乱码污染 JSON 解析、保证中文路径无乱码。
- 子进程优先级：Windows 下提到「高于标准」（`os.setPriority(pid, -1)`），避免转录拖慢 UI。

### 2. GPU 自动检测与性能档位

- `app/engine/engine_gpu.py`：**懒加载**探测（首次调用才 import torch/onnxruntime），带超时与异常保护，任何探测失败只影响加速、绝不阻断转录。
  - NVIDIA → CUDA（`torch.cuda` / onnxruntime `CUDAExecutionProvider`）
  - AMD / Intel → DirectML（`torch-directml` / onnxruntime `DmlExecutionProvider`）
  - 其余 → CPU 兜底（行为与纯 CPU 一致）
- `app/engine/engine_perf.py`：三档性能 `quality / balanced / fast`，分别映射不限线程 / ≤4 核 / ≤2 核。
  - 通过 `OMP_NUM_THREADS` 等环境变量 + `torch.set_num_threads()` + onnxruntime `SessionOptions` 限制线程。
  - `detect_recommended()` 按 CPU 核数 / 内存 / GPU 自动**推荐**档位，随 probe 返回给 UI 默认选中。

### 3. 设计语言：深色扁平 + teal 强调色

- 主题基底为深色扁平风，强调色 **teal `#00C9B1`**，渲染器里统一定义为 CSS 变量 `--accent`（`--accent2:#2ee6cd`、`--accent-dim:rgba(0,201,177,.14)`）。
- 窗口底色 `#0a0f18`（`main.js` 的 `BrowserWindow.backgroundColor`）。
- 与旧「MIDI播放器.html」界面同源（Synthesia 式瀑布可视化等），属同一设计语言家族。

### 4. 内置 Python 运行时：开箱即用

- `app/scripts/bundle-python.js` + `app/engine/requirements-bundle.txt`：
  - 下载 **python-build-standalone** 自包含 CPython（免安装、含 pip）→ 解压到 `app/python/` → 用内置 pip 装 `requirements-bundle.txt`。
  - torch 按 `--torch` 参数选择：`cpu`（默认，最小体积）/ `cuda`（PyTorch cu121 索引）/ `directml`。
  - 完成后清理测试套件与 `__pycache__` 瘦身，并跑 `probe` 自检。
- 运行时发现顺序（`main.js` `resolvePython()`）：用户显式 `engine_path` → 内置 `app/python` → `FUFUMIDI_PYTHON` 环境变量 → 开发机已知路径 → `python`/`python3`。
- 注意：bundle 脚本注释声明打包时随 `files:"python/**/*"` 分发，动手改 `package.json` 的 `build.files` 前请核对这一条。

### 5. 设置持久化与 i18n

- 设置持久化：`userData/fufumidi/settings.json`（`main.js` 的 `readSettings` / `writeSettings`，原子写入：临时文件 + rename）。
- 插件用户目录：`userData/fufumidi/plugins`。
- i18n：渲染器内 `LANG`（'zh'/'en'，来自设置）+ `I18N_MAP`（中文为源文案）。静态 DOM 用 `applyLang()` 整体替换（长串优先），动态字符串用 `t('中文')` 即时翻译，反向 en→zh 用整词匹配避免误翻。
- 默认设置 `perf_mode: 'quality'`、`lang: 'zh'`、`theme: 'deep'`。

### 6. 渲染器功能面

七个视图（`FuFumidi.html` 顶栏 tab）：**演奏 / 编辑 / 可视化 / 分析 / 乐谱 / 转录 / 转换**。
- 转录视图内嵌「智能修正」（转录 MIDI + 原音频 → 精修 MIDI）为一条龙第二步。
- 播放/编辑/可视化完全离线；渲染器 JS 零依赖单文件。

---

## 三、编码规范

- **Python**：文件首行 `# -*- coding: utf-8 -*-` + 模块级 docstring（说明用途与依赖）。见 `app/engine/*.py`。
- **渲染器 / 主进程 JS**：注释用中文；主题一律走 CSS 变量（不要硬编码颜色）；`main.js` / `preload.js` 文件头有 banner 注释。
- 行宽与命名沿用各文件既有风格（PEP 8 风格 Python、camelCase JS），不做强制格式化工具约定。

---

## 四、已否决方案（重要：避免反复提出）

1. **不用 PySide6 / Qt 界面**。原 AudioMuse 有 PySide6 GUI，但 Electron 已是主界面；`engine/requirements-bundle.txt` 已刻意排除 gui 依赖（只注释提及 PySide6），Electron 只走 `convert / refine / probe` CLI，永不调用 `run_gui()`。
2. **不把 ~700MB torch 运行时直接打进安装包本体**。用 python-build-standalone 瘦身内置（`app/python/`），且 torch 默认 CPU 版最小体积。
3. **性能档位"推荐但不锁定"**。`detect_recommended()` 只推荐不强制；低配置用户也可手动挑战最高质量（quality 档）。
4. **主题不照搬 AudioMuse 浅色底**。统一深色基底 + teal accent 传达精神，不复刻浅色皮肤。
5. **打包门禁**：最终一键安装包必须在用户测试工具可用并回复「可以」之后才进行；不要把未经用户验证的包发出去。

---

## 五、工作流

**一条龙：转录 → 修正 → 编辑 → 播放。**
用户导入音频 → `convert` 转录为 MIDI →（可选）`refine` 智能修正（对齐起音 / 还原力度 / 声部平衡 / 清理杂音）→ 载入编辑器精修 → 演奏 / 可视化 / 乐谱 / 分析。全部离线本地完成。

---

## 六、目录速览

```
F:\NEW\工具测试\Fu\
├── AGENTS.md                      # 本文件
├── .gitignore
└── app\
    ├── main.js                    # Electron 主进程（引擎 spawn、设置、插件宿主、IPC）
    ├── preload.js                 # fuBridge 上下文桥
    ├── plugin-host.js             # 插件系统宿主
    ├── package.json               # electron-builder 打包配置
    ├── build\                     # 图标 / NSIS 安装器素材
    ├── engine\                    # Python 转录引擎
    │   ├── music2midi.py          # CLI 入口：convert / batch / probe / gui
    │   ├── smart_midi.py          # refine 修正 CLI
    │   ├── engine.py / engine_basic.py / engine_pt.py / engine_separate.py
    │   ├── engine_gpu.py          # GPU 自动检测
    │   ├── engine_perf.py         # 性能档位
    │   ├── requirements.txt       # 原 AudioMuse（含 PySide6）依赖
    │   ├── requirements-bundle.txt# 内置运行时依赖（无 GUI）
    │   └── tests\data\            # 引擎测试样例（_test_melody.wav / _test_out.mid）
    ├── renderer\FuFumidi.html     # 单文件渲染界面（播放/编辑/可视化/分析/乐谱/转录/转换）
    ├── scripts\bundle-python.js   # 内置 Python 运行时捆绑
    ├── plugins\                   # 内置插件示例 + 开发文档
    └── python\                    # （构建期生成）内置运行时，不入库
```
