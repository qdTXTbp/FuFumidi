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
# 引擎层：116 个用例（含 7 个新回归用例）
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
