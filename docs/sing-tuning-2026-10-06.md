# 「烦恼歌」调教实测：修掉的 8 个 bug 与验证记录

> 2026-10-06 ｜ 输入：`烦恼歌.mid`（9 轨 / 480 tpq / 96 BPM，voice 轨 713 音符）+ 歌词 `烦恼歌.txt`
> 目标：在工具内完成调教，并分别用 **UTAU 中文声库**（ChenZhe_Voice）与 **DiffSinger 中文声库**（花火）渲染。

## 0. 结论

两个引擎现在都能把这首歌渲成有声的 WAV（数据见 §3）。过程中撞到并修掉的问题：

| # | 现象 | 根因 | 修在哪 |
|---|---|---|---|
| 1 | UTAU 渲染报 `engine_utau.py: error: unrecognized arguments: --bpm 96` | 主进程无条件给回落引擎传 --bpm，而 legacy 子命令没有这个参数 | `engine/engine_utau.py`（补 --bpm）+ `main/utau.js` |
| 2 | 回落引擎即使去掉 --bpm 也报 `KeyError: note` | 前端发**拍系**音符（pitch/durBeat），legacy 只认**音名/毫秒** | `engine_utau.py:normalize_track_notes()` |
| 3 | 没有 character.txt 的中文声库（HowHow_CV）整个用不了：`AttributeError: NoneType object has no attribute name` | 无 character.txt → text_file_encoding=None → decode(None)；且 bank.file 为空让 ClassicSinger.reload() 读不存在的路径 | `voicebank_loader.py` + `engine_openutau.py:load_singer` |
| 4 | 同一个声库接着报 `NoneType object has no attribute encode` | 缺 character.txt 时 voicebank.id 保持 None，resampler_item 用它拼缓存文件名 | `voicebank_loader.py`（补 id/name 兜底） |
| 5 | 界面警告「本轨有 713 个歌词不在声库别名表里」，而引擎明明能唱 | oto.ini 空别名回退成带扩展名的文件名（a.wav），与歌词 a 对不上 | `engine_utau.py:OtoEntry.__init__`（去掉扩展名） |
| 6 | 渲染「成功」但产出 **244 秒纯静音** | makeNote() 给 UTAU 音符默认 volume=0，下发时把 0 一起发给引擎 → 音量乘 0 | `stores/singer.ts`（默认 100；下发时 0 视为未设） |
| 7 | DS 渲染报「音素化没有产出任何音素（歌词是否为空？）」 | DS 中文词典 dsdict-zh.yaml 的 grapheme 是**拼音**，render / sing-render 两条路径都没接汉字→拼音 | `diffsinger/g2p.py:get_symbols()` |
| 8 | 多语声库永远按 zh 音素化、采样深度/步数调不动 | 前端一直发 params:{language,depth,steps}，main/diffsinger.js 整包丢掉；render 子命令也不认 --language | `main/diffsinger.js` + `engine_diffsinger.py` + `diffsinger/pipeline.py` |

另外顺手修的：**一次 Ctrl+Z 走两步历史**（卷帘与页面各监听一次 window.keydown）——
实测「导入 713 音符 → 批量填词 → Ctrl+Z」直接变 0 音符。现在按焦点分工：焦点在卷帘里归卷帘，其余归页面。

## 1. 这次新加的能力（实测中缺了就没法干活的）

| 能力 | 位置 | 说明 |
|---|---|---|
| 导入 MIDI 时**只取最高音（单音化）** | 导入弹窗复选框 | voice 轨是柱式和弦（713 音符 / 438 处同时发声），原样导入会每个 tick 叠 3~4 个音节；勾上后 713 → **275**。弹窗里同时标出每条轨的「复音 N」。 |
| 批量填词对话框：**中文逐字分词** + 填充模式 + 预览 | 调教页 · 批量填词 | 旧实现只按空白分词：整段中文粘进去 = **1 个词**，每个音符都被填上整段歌词。现在默认中日韩逐字、拉丁按词，并预览「识别到 N 个词 → M 个音符」；填充模式有顺序 / 循环 / 只填到用完。 |
| **汉字 → 拼音** | 同一对话框 | UTAU 中文声库的别名就是拼音，工具里必须有这一步。新增 `engine/engine_pinyin.py` + IPC `sing:toPinyin`。 |
| **发音表** | 轨道行按钮（UTAU 轨） | 列出该声库全部别名（可搜索、点击即填给当前音符）。修掉 #5 之后这张表才和引擎一致。 |
| **导入歌词文件**（.txt / .lrc） | 批量填词对话框 | txt 走分词填入；lrc 按 [mm:ss.xx] 时间戳把每行分给该时间窗内的音符（自动对轴）。 |
| **适应窗口 ⤢** | 卷帘工具栏 | 4 分钟的歌画出来 13597 px、视口只有 625 px —— 这就是用户看到的「音符显示不全」。现在导入后自动全曲入画，缩放下限放到 1.2 px/拍。 |

## 2. 验证方式（可复现）

```powershell
# 引擎层：148 个用例全绿（含本轮新增的 23 个算力守卫用例）
$env:PYTHONUTF8=1; python -m pytest engine/tests -q

# 端到端：走应用自身的 IPC（CDP 驱动）
#   1) 新建 UTAU 轨 → 导入 MIDI（勾「只取最高音」）→ 275 音符 + 卷帘自动全曲入画
#   2) 选 ChenZhe_Voice → 批量填词（粘歌词原文）→ 汉字→拼音 → 填入
#   3) 渲染本轨 → <数据目录>/temp/fufumidi/utau_render_*.wav
#   4) 新建 DS 轨 → 同样导入 → 选 花火 → 填汉字歌词 → 渲染
```

## 3. 产物数据（本机实测）

| 产物 | 时长 | 峰值 | 有声窗口（10 s 窗） | 备注 |
|---|---|---|---|---|
| utau_render_*.wav（ChenZhe_Voice + 拼音） | 244.0 s | 0.662 | 16 / 24 | 修复前**全零**（peak 0.0 / rms 0.0） |
| diffsinger_render_*.wav（花火 + 汉字） | 194.7 s | 0.408 | 17 / 19 | 修复前直接失败（0 音素） |

两次渲染都是「voice 轨最高音单音化后的 275 个音符」，旋律里的空档（原曲前奏 79 秒）对应静音窗口。

## 4. 已知未做 / 仍不理想

1. ~~歌词与音符数不匹配~~ → **已修（第二轮 §6.1）**：新增「整首按比例 / 按乐句」两种对齐，441 字铺满 275 音符（跳过 166 字但首尾对齐）；另有 LRC 时间轴对轴。
2. **voice 轨不是人声旋律**：它是钢琴化的柱式和弦，最高音未必等于原唱主旋律。工具侧只能单音化；要真正的主旋律得走「转录 / 人声分离」那条链。
3. ~~调教页只能从系统文件对话框导入 MIDI~~ → **已修（第二轮 §6.2）**：「从曲库选」直接读库里 115 首的 `meta.path`。
4. ~~声库体检没有接到界面~~ → **已修（第二轮 §6.3）**：`engine/engine_vbcheck.py` + 声库面板「体检」按钮。
5. 中文 UTAU 路径没有音素化器（引擎警告「按别名直查 oto」），因此没有 CVVC/VC 过渡与跨音节连读 —— 这属于引擎能力，不是本次修的 bug。

---

## 6. 第二轮（2026-10-06 晚）：把「还是不理想」的那几条也修了

### 6.1 歌词对齐：字数 ≠ 音符数不再烂尾

新增 `frontend/src/core/sing_align.js`（纯函数，自带 `selfCheck()`，可用 node 直接跑）。填词对话框多了「对齐」下拉：

| 模式 | 行为 | 适合 |
|---|---|---|
| 顺序 | 一个字一个音符（老行为，可循环/截断） | 字数与音符数一致 |
| 整首按比例 | 第 1 个字落在第 1 个音符、最后一个字落在最后一个音符，中间按比例取字 | **字数 ≫ 音符数**（本次：441 字 / 275 音符） |
| 按乐句 | 先用休止把旋律切句（默认 >1 拍），音节流按音符数比例切成同样段数，段内再铺 | 一句一句唱的歌 |

实测（烦恼歌 · 275 音符）：`按乐句对齐：20 个乐句441 个字 → 275 个音符（字数多，跳过 166 个字）`。
选「顺序」且字数与音符数差得多时，界面会提示改用比例/乐句。

### 6.2 从曲库直选 MIDI

调教页新增「从曲库选」：列出曲库 115 首（可搜索），点一下直接读 `<数据目录>/midi/<曲名>.mid` 的字节，
走同一条解析/选轨流程，不再需要系统文件对话框。实测：`已从曲库载入「烦恼歌」` → 直接弹轨道选择（7 轨）。

### 6.3 声库体检（`engine/engine_vbcheck.py`）

声库面板每个库后面多了「体检」按钮，一次算清：目录结构、oto.ini 编码与可解析行数、别名数量（含文件名兜底数）、
oto 引用但缺失的 wav、character.txt 有无、以及**当前工程歌词的别名覆盖率**；UTAU / DiffSinger 各有对应检查。

实测输出（ChenZhe_Voice，带当前 275 个歌词）：

```
✓ oto.ini 解析出 429 行原音设定（编码 utf-8-sig）
✓ 可用别名 427 个（其中 416 个来自文件名兜底）
✓ oto 里引用的采样文件都存在
✓ 有 character.txt（显示名/作者等信息齐全）
! 当前歌词里有 1 个不在别名表（例：yi）→ 中文声库要先「汉字→拼音」
统计：{oto_lines:429, alias_count:427, missing_wav:0, lyrics_checked:275, lyrics_missing:1}
```

> 第一轮踩的两个坑（`AttributeError` 整库不可用、「713 条歌词不合法」误报）现在在选库阶段就能看见，不必等渲染失败。

### 6.4 多语言文案补齐（第一轮的欠账）

第一轮新增的 93 条中文文案漏了 en/ja 翻译（本仓库硬规则：新文案必须同时补 `I18N_MAP` 与 `I18N_JA`）。
现已补齐，并用脚本按 `t('…')` 抽取 + 反查两张表审计：**缺 EN 0 条 / 缺 JA 0 条**。

### 6.5 本轮验证

| 项 | 结果 |
|---|---|
| 引擎测试 | `engine/tests` 全绿；`test_sing_regression_fixes.py` 增至 9 个用例（+声库体检、+对齐 JS 自检） |
| 曲库导入 | 应用内实测：115 首 → 搜索「烦恼歌」→ 轨道选择（7 轨）→ 单音化 275 音符 |
| 按乐句对齐 | 应用内实测：20 个乐句 / 441 字 → 275 音符 |
| 声库体检 | 应用内实测：5 条检查 + 统计（歌词缺 1 = 「yi」） |
| UTAU 渲染回归 | 244.0 s / 峰值 0.660 / 16 个有声窗口（共 24） |
| DS 渲染回归 | 194.7 s / 峰值 0.440 / 15 个有声窗口（共 19） |
| i18n 审计 | 缺 EN 0 / 缺 JA 0 |

### 6.6 仍不做的（换了理由）

- **voice 轨不是人声旋律**：它是钢琴化的柱式和弦，单音化只能取到最高声部；要真正的主旋律得走「转录 / 人声分离」那条链，属于产品路线选择。
- **中文 UTAU 没有音素化器**：CV 声库按别名逐字查表本来就是正确行为（CVVC 声库才有 phonemizer），保留为引擎能力说明。

## 5. 相关文件

- 引擎：`engine/engine_utau.py`、`engine/engine_openutau.py`、`engine/engine_diffsinger.py`、`engine/engine_pinyin.py`(新)、
  `engine/singing/openutau/classic/voicebank_loader.py`、`engine/diffsinger/g2p.py`、`engine/diffsinger/pipeline.py`
- 主进程：`main/utau.js`、`main/diffsinger.js`、`preload.js`
- 前端：`frontend/src/views/ViewSing.vue`、`frontend/src/components/pianoroll/PianoRoll.vue`、`frontend/src/stores/singer.ts`
- 测试：`engine/tests/test_sing_regression_fixes.py`(新，7 个用例)

## 7. 第三轮：修 GitHub issue #20（转录一直失败：CUDA「no kernel image」）

> 原始 issue（`qdTXTbp/FuFumidi#20`，Windows 10 / v4.4.1）：「使用转译-转录功能时总是提示失败」，
> 日志里是一句 `CUDA error: no kernel image is available for execution on the device`。
> 复查当前源码：**问题仍在** —— 全仓库没有一处比对过「显卡算力」与「CUDA 包里编进去的算力」。

### 7.1 根因

torch 的 CUDA 轮子是**编译期把算力焊死的**。本机装的 cu128 实测：

```
torch 2.9.1+cu128   torch.cuda.get_arch_list() = [sm_70, sm_75, sm_80, sm_86, sm_90, sm_100, sm_120]
```

比这个范围更老的卡（Kepler / Maxwell / **Pascal，即 GTX 10 系及更早**）：

1. 驱动层照样认卡 → `torch.cuda.is_available()` 是 **True**（安装后的自检、界面状态全部“正常”）；
2. 一到真正跑 kernel 才炸，而且是**异步**抛在推理中途 → 用户只看到一句英文 CUDA 报错，整次转录失败；
3. 原来的兜底只认 OOM（显存不足自动降 batch），算力不匹配这条路径完全没接。

### 7.2 修在哪（6 处）

| # | 位置 | 改动 |
|---|---|---|
| 1 | `engine/engine_gpu.py` | 新增算力判定：`_parse_arch` / `arch_supported` / `min_supported_arch` / `cuda_error_kind` / `cuda_error_hint`。`_probe()` 现在读 `torch.cuda.get_arch_list()` 与设备算力比对，不匹配就**显式** `device=cpu` + `cuda_usable=False` + `arch_reason`（一句能读的中文），并让 onnxruntime 退回 `CPUExecutionProvider`。 |
| 2 | `engine/engine_muscriptor.py` | 选设备时消费上面的结论：算力不匹配就**显式传 cpu**（传 None 会让 muscriptor 自己按“有 CUDA”挑回 GPU）。推理循环新增兜底：任何 CUDA 运行期错误（no kernel image / 设备断言 / 非法访存 …）**自动改用 CPU 重跑一次**并写日志说明原因。 |
| 3 | `engine/engine_msst.py` | pymss 的 `device="auto"` 只看 `torch.cuda.is_available()`（不匹配时仍为 True）→ 改为跟随 `engine_gpu.torch_device()`；`separate()` 失败时附一句可操作的话。 |
| 4 | `engine/engine_aria.py` | 设备默认不再硬写 `"cuda"`；判成 CPU 时给子进程 `CUDA_VISIBLE_DEVICES=""`（aria-amt 的 CLI 没有设备开关）。 |
| 5 | `main/gpu-ipc.js` | 安装后的自检从「`is_available()` 通过就算成功」升级为「再比一次算力」；不支持时返回 `archUnsupported`，文案明确说「增强包已装好，但这张卡用不上，会自动走 CPU」，不再误导用户去重装/换镜像。 |
| 6 | `frontend/src/views/ViewResources.vue`、`frontend/src/components/SettingsPanel.vue` | 新增「显卡算力支持」一行（+ 设置页警示条）；「推理加速」在算力不匹配时不再显示“已启用”，改为「未启用 / 用 CPU」。 |

### 7.3 验证

| 项 | 结果 |
|---|---|
| 单元测试 | 新增 `engine/tests/test_gpu_arch_guard.py`，**23 个用例**：算力兼容规则 16 例（sm_61/sm_52/sm_37 → 不支持；sm_70/75/80/86/89/120 → 支持；compute_90 PTX → 支持；空列表 → 不下结论）、错误分类、`_probe()` 在伪装 sm_61 时降级到 cpu、真实机器**不被误降级**、MuScriptor 的 CUDA 报错自动改用 CPU（假模型注入）、OOM 仍走减半老路径。 |
| 真实转录回归 | 本机（RTX 5070 Ti / sm_120）用 medium 权重跑 8 秒音频：`device=cuda, arch_supported=true` → 日志「使用 GPU（CUDA）推理」→ 15.8 s 出 14 个音符。**没有把好机器一起降级。** |
| 自检代码 | 直接跑 `main/gpu-ipc.js` 生成的那段 Python：本机返回 `ok:true, arch_supported:true`；把算力伪装成 6.1 时返回 `ok:false, arch_unsupported:true` + 中文原因。 |
| 界面（伪装 sm_61 实测） | 资源管理 → GPU 加速：「显卡算力不受支持，已自动改用 CPU 转录」+ 新增行「显卡算力 sm_61 不在当前 CUDA 推理包支持范围内（该包最低支持 sm_70），将自动改用 CPU 转录（功能不受影响，只是更慢）」+ 标签「用 CPU」；设置 → GPU：警示条同文案。 |
| 引擎测试 | `engine/tests` 全绿：**148 项 / 0 失败 / 0 错误 / 2 项按设计跳过**（含本轮新增 23 项）。 |
| 前端构建 | `npm run build` 通过。 |

> 没法验证的一环：本机只有 sm_120 的卡，**没有真实的 Pascal/Maxwell 硬件**。上表的 sm_61 全部是
> 伪装算力（monkeypatch / 临时环境钩子，验证后已删除）跑出来的 —— 逻辑与界面都对，但“真机上那句报错
> 不再出现”只能等有 GTX 10 系的用户回报。

### 7.4 顺手修掉的三件事

1. **设置面板打不开指定页签**：调用方（转录页「GPU 加速」按钮）先写 `state.ui.settingsTab='gpu'` 再 `settingsOpen=true`，
   而面板是「打开时才挂载」且 watcher 没有 `immediate` → 永远停在「外观」。现加 `immediate: true`（应用内实测已落在 GPU 页）。
2. **引擎测试与生产环境的编码口径不一致**：`main.js` 调引擎一定会带 `PYTHONIOENCODING=utf-8`，
   测试却是裸 `subprocess.run(..., encoding='utf-8')` —— Windows 下子进程 stdout 走 GBK，管道按 UTF-8 解码抛
   `UnicodeDecodeError`，`p.stdout` 变 `None`，14 个用例假失败。现测试统一带上与生产相同的 env。
3. **12 条漏翻文案**（「详情」「AI 声库」「未选择」等）补齐 en/ja；审计脚本同时修了两处自身缺陷
   （词表单引号/双引号混用、键里的转义换行没认），现在 **缺 EN 0 / 缺 JA 0**（2453 条中文 `t()` 全量反查）。

### 7.5 本轮文件

- 引擎：`engine/engine_gpu.py`、`engine/engine_muscriptor.py`、`engine/engine_msst.py`、`engine/engine_aria.py`
- 主进程：`main/gpu-ipc.js`
- 前端：`frontend/src/views/ViewResources.vue`、`frontend/src/components/SettingsPanel.vue`、`frontend/src/core/i18n.js`、`frontend/src/core/i18n_ja.js`
- 测试：`engine/tests/test_gpu_arch_guard.py`(新，23 个用例)、`engine/tests/test_utau_engine.py`(环境变量对齐生产)

## 8. 第四轮：调教页按钮图标 + 全流程调教《烦恼歌》

### 8.1 按钮图标（用户要求「补全调教页的按钮图标」）

`ViewSing.vue` 78 个按钮里 38 个没有图标。按「动作按钮补图标、紧凑字形按钮保留」处理：

- **补了 30 个**：轨右键菜单（重命名/复制/清空/删除）、对齐偏移「应用」、停止后续渲染、定位第一个、
  三个属性页签（参数/效果链/自动化）、效果链「应用」、自动化「清空」、选轨「用这条」、
  汉字→拼音、读歌词文件、填入、关闭、清除本音素覆盖、音高曲线「清空」；
  同页的 `PianoRoll.vue` 右键菜单（编辑歌词/复制/剪切/粘贴/重复/切分/合并/删除）与
  `VoicebankPanel.vue`（体检/删除/关闭/打开制作工具/启用停用/安装）。
- **新增 4 个图标**：`check` / `cut` / `split` / `merge`（`Icon.vue`，与既有 66 个同风格：24×24、stroke 1.8）。
- **刻意不动的**：`×`、`↑`、`↓`、`A`/`B` 循环点、时间码显示、以及各种 chip —— 它们本身就是图形，加图标只会更挤。
- CSS：`.tk-menu button` 与 `.tprops .tab` 补 `display:flex/inline-flex; gap`，否则图标与文字会挤在一起。

### 8.2 全流程调教（应用内实测，产物在 `E:\Midi\`）

| 步骤 | 实测 |
|---|---|
| 从曲库选 → 只取最高音 | 713 音符 → **275 音符**（voice 轨 438 处复音） |
| 批量填词（按乐句） | 441 字 → 275 音符（见 8.4 的不足） |
| 选歌手 | DiffSinger · 花火（zh） |
| 渲染本轨 | **244.1 s**（修好 BPM 后；修之前只有 194.7 s） |
| 导出 | 人声 WAV 21.5 MB + 工程 `烦恼歌_调教工程.fufumidi` |
| 伴奏 | 用 mido 去掉 voice 轨 → 应用「转译 → 转换」页离线渲染（SF2，244.8 s） |
| 混音 | ffmpeg：人声 ×2.4 + 限幅、伴奏 ×0.42 → `烦恼歌_调教版.wav` / `.mp3`（320k） |

客观指标：成品 244.84 s / 峰值 0.994 / **削顶样本 0** / RMS 0.150，每 30 s 的 RMS 在 0.115~0.192 之间（无空洞段）；
人声与谱面（音符发声区间做成的包络）互相关：零时移 **0.778**，最佳时移 +80 ms —— 已经在音乐容差内。

### 8.3 本轮新发现并修掉的 4 个 bug（都不报错，但一听就露馅）

| # | 现象 | 根因 | 修在哪 |
|---|---|---|---|
| 1 | **DS 渲染整体快 25%**：96 BPM 的 4 分 04 秒歌唱成 3 分 15 秒，叠上伴奏全曲抢拍 | `_make_axis` 只设了 `p.bpm`，而 `TimeAxis.build_segments()` 读的是 `p.tempos`（默认 120）→ 拍→秒换算用了 120 | `diffsinger/pipeline.py`：同步 `p.tempos` |
| 2 | **人声整体提前 0.82 s**（= 第一个音素的位置），与伴奏错开 | 渲染器只产出「这一句」的样点，句首在歌里的位置要由调用方补静音 | `diffsinger/pipeline.py`：新增 `_pad_leading_silence()` |
| 3 | **「导出 WAV」点了毫无反应**（也没有报错提示） | ① `store.exportBytes` 是 Pinia 的 **getter**，代码写成 `exportBytes()` → `TypeError`；② 桌面版不该走 `<a download>`（Electron 33 下载子系统失效，项目里其他导出早就改走 `file:saveBinary`） | `ViewSing.vue`：改用 `bridge.saveBinary` |
| 4 | 渲染结果里报出的「时长」比实际大 70 s | `phrase.duration_ms` 把**毫秒**当 tick 喂给 `ms_between_tick_pos` | `diffsinger/pipeline.py`：按 `end_ms - tick_pos_to_ms_pos(first)` 计算 |

回归用例：新增 `engine/tests/test_diffsinger_timing.py`（6 个：96/120/60 BPM 的拍→秒、缺省 120、句首静音补齐、补齐失败不抛错）；
引擎测试全绿 **154 项**（+6）/ 0 失败 / 2 项按设计跳过。

### 8.4 仍然存在的不足（本轮实测出来的，按影响排序）

1. **歌词对齐会丢字，且丢在句中**：441 字对 275 个音符，「按乐句」对齐丢 166 个字。实测第一句
   把 `啊啊啊啊啊啊啊啊 / 哒哒哒 / 不爱的不断打扰` 合成一个乐句后，落到音符上变成
   `啊×5 哒×2 不 的 断 打 你` —— **爱、不、扰 被跳过**，听感直接错词。
   缺的是「按行/按词对齐」和「长音符切开以容纳全部字」这两类策略（现在只有顺序 / 按比例 / 按乐句）。
2. **源 MIDI 的旋律有 30 秒空洞**：voice 轨在 **60–90 s 一个音符都没有**（原曲那一段本来就没旋律，或转录丢了），
   所以成品里那 30 秒只有伴奏。这是素材问题，不是工具问题，但用户会以为是工具没调好。
3. **导出只有单轨，不能出成品**：调教页「导出 WAV」导出的是**当前声部轨**（或多轨里当前这条），
   拿不到「伴奏 + 全部已渲染声部」的混合文件 —— 本轮成品是拿 ffmpeg 在外面混的。
   传声器里明明已经在混着放了（采样级同步），导出却只给一条轨，是明显的缺口。
4. **渲染/导出没有真实进度**：DS 渲染 4 分钟的歌要 4~5 分钟，进度条一直停在 0（只有 UTAU 侧有进度透传）；
   转换页离线渲染同样无进度。
5. `--vocoder` 覆盖未实现：每次渲染都会带一条「暂不支持」warning。
6. **多音字没人管**：转拼音后「不/了/着/得」这类要靠用户自己改（对话框里有提示，但没有候选列表）。
7. 本轮只回归了 DS 链路；UTAU 侧的上轮结论（244.0 s，与歌长一致）未受本轮改动影响（改动都在 `diffsinger/`）。

## 9. 第五轮：图标全量审计、声库制作入口、下载体验、音符瀑布背景、成品混音导出

### 9.1 图标：把「静默变空白」这一类问题一次清掉

`<Icon name="X">` 里 X 不存在时，组件渲染成**空白**且不报错 —— 用户只看到「这个按钮没有图标」。
全量审计（71 个图标名 × 全部 .vue/.js/.ts，含动态取值与数据表 `ic:` 字段）查出 **10 处**：

| 位置 | 写错的名字 | 处理 |
|---|---|---|
| 调教页 传输栏「停止」 | `square` | → `stop` |
| 调教页 空态「导入 MIDI」/「导入歌词」 | `upload`（×3） | → `import` |
| 调教页 轨道头 | `layers` | **新增图标** |
| 调教页「轨道属性」 | `sliders` | **新增图标** |
| 编辑页「列表」/「CC 列表」 | `list`（×2） | **新增图标** |
| 资源中心「模型下载设置」 | `settings` | → `gear` |
| 设置页「云同步」页签 | `cloud` | **新增图标** |
| 引导「数据分析」章 | `analyze` | → `chart` |

并给 `Icon.vue` 加了开发期告警：名字没定义就 `console.warn` —— 这类 bug 不该再靠肉眼看出来。

### 9.2 UTAU 声库渲染实测

| 声库 | 结果 |
|---|---|
| ChenZhe_Voice（中文拼音） | ok，1.70s / 峰值 0.925 / RMS 0.245 |
| HowHow_CV（无 character.txt） | ok，1.69s / 峰值 0.854 / RMS 0.201（第一轮修过的那个库） |
| Iona_Beta（日文） | ok，1.69s / 峰值 0.441 / RMS 0.123 |

应用内也跑了一次 UTAU 轨（8 音符，ChenZhe_Voice + 拼音）：渲染成功并进入传输栏。

### 9.3 「UTAU 声库制作」不是没做，是**没有入口**

`views/ViewVoicebank.vue`（上传音频切分 / 录音 / oto 标注 / 导出声库）一直都在，
但合并板块后**没有任何路由指向它**，而调教页「UTAU 声库制作」的按钮错接到了「下载声库」的列表上 ——
于是功能看起来完全不存在。现在：新增路由 `/voicebank`，按钮改为打开制作工具。

实测（应用内）：上传 3.35s 测试音频 → 自动切出 **5 个片段** → 自动标注（offset/overlap/preutterance/consonant/blank）
→ 导出到目录，得到 `oto.ini` + `001..005.wav`。

### 9.4 声库下载：进度不再「抽搐」，进度条不再凭空消失

根因两处（都在实测里能复现）：

1. 主进程**每失败一轮就把 percent 打回 0**（`send({percent: 0, error: "第 N 轮失败，自动换源…"})`）——
   多源轮换时进度条就会 0 → 涨 → 0 地跳。
2. 前端进度条只在 `busyId === it.id` 时渲染 —— 列表刷新 / KeepAlive 切页 / 一次换源就让整条进度凭空消失。

修法：主进程保留**高水位**并单独发 `phase: "retry"`；前端 percent 单调、按 `active` 渲染、换源时显示「换源重试中…」。

### 9.5 音符瀑布：背景可换（主题 / 纯色 / 图片 / 透明）

`drawVizWaterfall` 原来写死一层主题渐变。现在 `opts.bg = { mode, color, image, blur, dim }`：

- `theme` 主题渐变（默认）／`solid` 纯色 ／`image` 自定义图片（cover 填充 + **模糊** + **暗化**）／
  `transparent` **真透明**（`clearRect`，配合导出可当 OBS 叠加层；透明档不再叠能量光晕，避免脏色）。
- 可视化页新增「背景」条：四个档位 + 模糊 0~40 + 暗化 0~80%，选择存 localStorage。

实测（CDP 取画布像素）：透明档下画布背景像素 `[0,0,0,0]`（全透明），只有琴键/音符不透明。

### 9.6 成品混音导出（上轮遗留）

调教页「导出 WAV」以前只给**当前这一条轨**。现在 `SingTransport.renderOffline()` 把
伴奏 + **每一条**已渲染声部轨按播放时同一套增益 / 音量自动化 / 声像 / 效果链离线混成一个 AudioBuffer，
再编码成 WAV 导出（文件名 `<工程名>_mix.wav`）；只有单轨时仍直接给引擎原始字节。

实测：伴奏 + 一条 UTAU 人声 → 导出 245.14s / 48kHz / 立体声成品（峰值 1.000，RMS 0.264 —— 与伴奏一致，人声 8 音符太小看不出增益）。

### 9.7 还没做的（诚实清单）

1. **歌词丢字仍未修**（§8.4 第 1 条）：441 字对 275 音符，按乐句对齐会丢 166 字且丢在句中。
   正解是「把长音符切开以容纳全部字」，改动涉及音符模型，本轮没动。
2. 渲染进度条仍然是 0（DS 侧）—— 只做了下载侧的进度修复。
3. `--vocoder` 覆盖未实现（每次渲染一条 warning）。
4. 多音字没有候选列表。
5. 源 MIDI 在 60–90s 没有旋律（素材问题，不是工具问题）。

## 10. 第六轮：多语声库（Ria）能唱了；视频导出与「可视化」页共用一套背景

### 10.1 多语声库：`use_lang_id` 的 `languages` 输入（四处，全部照搬上游）

Ria 是多语言声库（`dsconfig.yaml` 里 `use_lang_id: true` + `languages: ria-multi-dict.languages.json`），
此前渲染到 A 层就**直接抛**「多语声库暂时渲不了」。上游 OpenUTAU 在**四个阶段**都喂一个与 `tokens`
等长的 `languages` 张量，逐个对齐实现：

| 阶段 | 上游位置 | 取值 | 语言表 |
|---|---|---|---|
| dsdur linguistic | `DiffSingerBasePhonemizer.cs:417-425` | 逐音素 `p.Language()`（符号前缀 `zh/aa`→`zh`） | `dsdur/dsconfig.yaml` |
| acoustic | `DiffSingerRenderer.cs:312-321` | `PaddedLanguageIds`（head/tail/间隙 SP 记 0） | **根** `dsconfig.yaml`（`DiffSingerSinger.cs:130-137`） |
| dsvariance linguistic | `DiffSingerVariance.cs:161-169` | 同上 | `dsvariance/dsconfig.yaml` |
| dspitch linguistic | `DiffSingerPitch.cs:150-158` | 同上 | `dspitch/dsconfig.yaml` |

改动：`voicebank.py`（`load_language_ids` 兼容四种配置风格 + `stage_language_ids` + `DsSinger.acoustic_language_ids`）、
`phonemizer.py`、`renderer.py`、`variance.py`、`pitch_edit.py`。只在 `use_lang_id` 为真时才加这个输入
（`Onnx.VerifyInputNames` 双向严格：单语声库多给一个 `languages` 会直接抛「多余」）。

**旁证**：Ria 的 `fs2.lang_embed.weight` 是 `[4, 256]` —— 合法语言 id 只有 0..3，正好对上
`ria-multi-dict.languages.json` 的 `ja=1 / yue=2 / zh=3`，0 留给无前缀音素（SP/AP/CL）与填充段。

新增 `engine/tests/test_diffsinger_multilang.py`（32 条判据）：语言表读取两种风格、`stage_language_ids`
的取舍、linguistic 的 languages 形状/取值/长度校验、真实声库的对照（Ria 有表、花火两张表都空），
以及一次**真实渲染**里用 `run_session` 探针抓下三个阶段实际收到的 `languages`（值域 `{0,3}` ✔、与 tokens 等长 ✔、
vocoder 不喂 ✔）。

实测（安装版，走应用自己的 `diffsinger:render` IPC）：Ria 中文 3 音符 → `ok` / 1.799s / 7 音素，
而改动前是 `ok:false`「多语声库尚未实现」。

### 10.2 顺带挖出的真问题：显卡增强包里的 onnxruntime **建会话就段错误**

装上 Ria 后第一次在安装版里渲染，得到的是 `引擎退出码 3221225477`（= `0xC0000005` 访问冲突）。
逐模型二分（同一解释器、只换 PYTHONPATH）后定位：

| 模型 | 增强包 `onnxruntime-gpu 1.20.2` | 随包 `onnxruntime 1.30.0` |
|---|---|---|
| Ria `ria-multi-dict.onnx` | **崩溃** | 正常 |
| Ria `dsvariance/vari.variance.onnx` | **崩溃** | 正常 |
| Ria dsdur / vari.linguistic / 花火全部 | 正常 | 正常 |

那是**进程级崩溃**，`try/except` 抓不到，上层只看到一句「引擎退出码 3221225477」。
新增 `engine/ort_compat.py` 做自愈：只在 `FUFUMIDI_GPU_KINDS` 非空（引擎正用增强包）时，
对声库里的每个 `.onnx` 起**子进程**建一次会话（子进程崩了父进程毫发无损），结论按
「解释器 + ORT 版本 + 模型路径/大小/时间戳」缓存到 `$FUFUMIDI_CACHE_DIR/ort-compat.json`；
有任何一个加载不了，就用「解释器自带 site-packages 优先」的 PYTHONPATH **起子进程重跑自己**
（实测 `os.execve` 在 Windows 上会让新进程一启动就 0xC0000005，所以走子进程 + 转发 stdio + 透传退出码），
并把中文警告写进渲染结果的 `warnings`。

实测（安装版）：首次 81.3s（含一轮 5 个模型的子进程探测）→ 第二次 24.0s（命中缓存），
两次都 `ok` 并带警告「显卡增强包里的 onnxruntime 加载不了这个声库的模型（进程级崩溃），已自动改用应用自带的 CPU 版 onnxruntime」。
新增 `engine/tests/test_ort_fallback.py`（25 条判据，探针用注入的 runner，不需要真崩溃）。

### 10.3 视频导出与「可视化」页**共用一套背景**（本轮第二项）

以前导出页自带 `VE.bgColor` / `VE.bgImage`，跟可视化页的背景设置毫无关系 —— 用户在瀑布流里挑的图片、
透明档、模糊/暗化，导出的成片一概不认。现在：

- 新增 `frontend/src/stores/vizbg.ts`（Pinia）：档位（主题/纯色/图片/透明）、颜色、模糊、暗化、图片**路径**
  与解码后的图片都住在这里，两页读写同一份 + 同一个 localStorage 键 `fufumidi.viz.bg`。
- `core/viz.js` 抽出 `paintVizBg(ctx, w, h, bgOpt)`（主题/纯色/图片/透明 + 新增 `keep` 档 = 不动背景），
  `drawVizWaterfall` 与视频导出的 `drawVideoFrame` **调同一个函数**，逐像素同源。
- 导出页的「背景色 / 背景图片」两行换成与可视化页同款的四档 chip + 颜色 + 模糊/暗化，并标注
  「与『可视化』页共用同一套设置」；透明档额外提示 MP4 没有透明通道。

实测（安装版，CDP 取像素 + 真导出成片）：可视化页设 `#ff00ff` → 导出页预览角像素 `[255,0,255,255]`；
在导出页改成 `#00ff00` → 预览立刻 `[0,255,0,255]`，切回可视化页也是绿色（双向同步）；
导出的 MP4 抽帧（ffmpeg）角像素 `(250,0,253)`、含 1.7 万种颜色（音符都画上了）。

### 10.4 顺带修掉的三个「视频时间」问题（都靠成片数字定位）

1. **录制画布被移出视口**（`left:-100000px`）→ 合成器按不可见图层对待，`requestFrame` 大量丢帧：
   实测「3 秒 @30fps」请求 90 帧、只有 75 帧进流，而成片时长 = 进流帧数/fps → **导出 2 秒得 1.28 秒**、
   3 秒得 2.42 秒，且与音频整体错位。改为放在视口右下角 **2×2 CSS 像素、`opacity:0.01`**
   （`captureStream` 抓的是画布像素缓冲 W×H，不是这 2px 的显示尺寸）。
2. **录制器 `start()` 后有约 0.6 秒还没开始收帧**的冷启动窗口，这段画的帧根本不进流，
   而内容时钟从 `start()` 起算 → 成片比目标短、且音频（从 0 起）整体领先画面。
   改为等第一个 `dataavailable`（或 800ms 兜底）再起钟、再画第 0 帧。
3. **`stop()` 之前还会丢最后约 0.3 秒的帧**：加 0.6 秒「尾部保护」，多跑一段让 `-shortest`
   按音频长度（= 目标时长）截断。

| 导出目标 | 修前成片 | 修后成片 | 帧数 |
|---|---|---|---|
| 2 秒 | 1.28s | — | 41 |
| 3 秒 | 2.42s | **3.13s** | 97（帧间隔 23–54ms，无空洞） |

### 10.5 本轮验证与遗留

- 引擎测试：**154 passed / 2 skipped**（新增 `test_diffsinger_multilang.py`、`test_ort_fallback.py`）；
  前端 `npm --prefix frontend run build` 通过；i18n 审计「新串 EN 缺 0 / JA 缺 0」。
- 全部改动都已 `node scripts/deploy-installed.cjs` 覆盖到安装版（asar 83.6 MB），并在**安装版里**实测。
- 遗留：
  1. 视频导出的**头 0.6 秒冷启动**期间不画内容（现在是空等），长片可忽略、短片按比例偏慢一点；
  2. 若增强包里的 onnxruntime 将来修好，`ort-compat.json` 缓存会因 ORT 版本变化自动失效（无需手工清）；
  3. 多语声库仍按**轨道语言**选词典（与上游一致）：一条轨唱不了两种语言，同一首歌要换语言得换轨。
