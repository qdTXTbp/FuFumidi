# 变谱（识谱）改进 · 第 2 轮实测报告

- 日期：2026-10-15　测试人：自动化（引擎直达安装版）+ 人工核对谱面真值
- 被测算例：`C:\Users\qdTXTbp\Desktop\test`（6 页管弦乐总谱，1588×2246，6/8、♩.=60，25 声部、8 件移调乐器）
- 跑的是**安装版里的引擎**：`E:\Midi\FuFumidi\resources\app.asar.unpacked\engine\engine_omr_backends.py`
  （部署后与源码逐字节同哈希，已核对 sha256）
- 环境：Audiveris 5.11（`-Xmx8G`）+ 完整版 tessdata（eng）+ 内置 python 3.12

## 结论

- [x] **6/6 页全部转出**（上一轮 6/6 但第 2 页是"侥幸"；这一轮第 2 页靠**分带**救回）
- [x] 音符 **1713**（第 1 轮 1693，原始识别 1813，去重掉 100）
- [x] 拍号从写死的 **4/4 变成推断出的 6/8**（与原谱一致），1510 个音符重排到统一小节网格
- [x] 耗时 **187 s**（第 1 轮 228 s）
- [x] 结果自检（M2-4）、homr（M3-1）、影像预处理（M3-3）—— 均已上线，见 §6–§8
- [ ] 未做：M2-4 的「一键重试该页」、M3-2 超分辨率预处理

## 1. 六页逐页结果

| 页 | 系统数 | 音符 | 放大 | 说明 |
|---|---:|---:|---:|---|
| 1 | 1 | 237 | ×2.11 | 23 行谱表，单系统 |
| 2 | **2** | 220 + 83 | ×3.0（分带） | 29 行谱表：整页 ×2.11 时 JVM 堆溢出，退档 ×1.58 被 Audiveris 判 "Sheet ignored"（分辨率下限）→ **切 5 带按 ×3.0 重跑** |
| 3 | 3 | 389 | ×2.11 | 6 + 8 + 11 行谱表 |
| 4 | 3 | 428 | ×2.11 | 11 + 13 + 8 行谱表 |
| 5 | 2 | 346 | ×2.11 | 13 + 13 行谱表 |
| 6 | 1 | 110 | ×2.11 | 12 行谱表（其余乐器 tacet，MuseScore 隐藏空谱表） |

"系统数"取自 Audiveris 自己的 GRID 日志（`Systems: #1[1..21] #2[22..29]`），
与切带判据（扫描线空白带里有没有"贯穿竖线"）**逐页逐区间吻合**。

## 2. 拍号与时间网格（M1-2）

Audiveris 不导出 `<time>`；更麻烦的是**拍号不明时它按"这一小节认出来的内容"给小节定长**
（日志：`No target duration for measures …, please check time signatures`）。
实测 1217 个小节里，1440 tick（3 个四分）只占 43%，其余是 720/960/1920/2280/2640…
—— 同一页不同声部的小节长度都不一样，合到一条时间轴上各走各的拍。

| 指标 | 修前 | 修后 |
|---|---:|---:|
| 推定拍号 | 4/4（解析器默认值，不是识别结果） | **6/8**（众数 1440 tick，是第二名的 3.2 倍） |
| 第 1 页跨声部「同刻发音」率 | 0.357 | **0.735** |
| 全 6 页音符落在八分网格上 | 84.9% | **92.7%** |
| 页长口径 | 最后一个音落在哪 | **这一页有多少小节**（末小节空着也不会让下一页提前） |

## 3. 声部身份与乐器（M2-2 / M2-3）

- 身份 = **(乐器, 声部编号)**。Audiveris **按系统出 part**：一页 3 个系统就把整张声部表重复 3 遍
  （第 4/5 页 23 个 part），按"页内序号"对齐时轨数会从 21 涨到 **41**（实测）；改成身份对齐后回落。
- 轨名带编号：`Flute 1,2` / `Horn in F 1,2` / `Horn in F 3,4` / `Violin I` / `Violin II` / `Solo Viola`
- 移调：`--sounding on`（默认）把 7 条移调声部换成实际音高 —— A/B 实测 Glockenspiel **+12**、
  Double Bass **−12**、Horn in F **−7**、Clarinet/Trumpet in Bb **−2**；关掉则逐音不变。
- **残留（未解决）**：OCR 读成 `Voice` 的声部只能按位置填空槽，所以 37 条轨里仍有 14 条是
  `声部 N` / `Solona.` / `VanI` 这类未识别声部（理想约 22 条）。见 KI-7 ⑤。

## 4. 复现命令

```powershell
$env:FUFUMIDI_DATA_ROOT='E:\Midi\FuFumidi\FuFumidiData'
& 'E:\Midi\FuFumidi\resources\python\python.exe' `
  'E:\Midi\FuFumidi\resources\app.asar.unpacked\engine\engine_omr_backends.py' to-midi `
  --in 1.png --in 2.png --in 3.png --in 4.png --in 5.png --in 6.png `
  --out orch.mid --overlay ov --beats auto --beat-type 4 --tempo auto `
  --upscale auto --thicken off --quantize off --min-note-ms 0 --dedupe on --sounding on `
  --backend auto --mode auto --audiveris "<数据根>\omr\audiveris\Audiveris\Audiveris.exe" `
  --workdir work --report r.json
```

## 5. 门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | 0 |
| `npm run build:ui` | 0（新前端产物已部署） |
| `npm run test:ui` | **217 pass / 0 fail** |
| `npm run audit` | 0 个死角（28 个界面参数三跳齐全） |
| 引擎 `pytest engine/tests` | 新增 21 条用例全绿；**既有的 11 条失败**（diffsinger_cli + openutau 音素化）与本次改动无关，数量未变 |
| `deploy-installed.cjs` | EXIT 0，冒烟：首屏 370 字符 / fuBridge 就绪 / 未捕获异常 0 |
| 部署一致性 | `engine_omr_backends.py` / `score_instruments.py` / `engine_score2midi.py` 与源码 **sha256 相同** |

## 6. 第 3 轮追加：homr（AI 识谱）与音频模型配置

### 6.1 homr vs Audiveris（安装版，同一台机、同一套参数）

| 用例 | homr | Audiveris |
|---|---|---|
| 钢琴 3 页（gang/） | 1095 音符 / 2 轨 / **37 s** | 1128 音符 / 2 轨 / ~2–3 min |
| 总谱第 6 页（test/6.png） | 75 音符 / **1 轨** / 8 s | 110 音符 / **11 轨** |

- **钢琴谱：打平**（音符 −3%，左右手都分开），**快约 4 倍** —— 扫描件 / 拍照这档它值得存在。
- **总谱：不适用** —— homr 把 12 行谱表并成一条轨，声部信息全丢。所以它**不进 auto 的默认路径**，
  只有当 Audiveris 没装时才兜底（对照片仍强于内置经典识谱）。
- 安装方式：资源中心「用户自行安装」，装在 <数据根>/omr/homr/venv（**独立 venv**：homr 要
  numpy≥2.4，应用运行时是 1.26）；pip 依赖约 200 MB + 权重 150 MB，**不随安装包分发**。
- 权重通道实测：ghfast.top 30 KB/s（与 GitHub 直链被限速同源），gh-proxy.com 2.11 MB/s。

### 6.2 音频处理模型的配置：下载时获取（不内置）

按要求改成「下载模型时把配置也下载并配置好」，实测：

| 项 | 结果 |
|---|---|
| 应用内置的 28 个 yaml | **已从工具里移除**（只留 index.json 元数据；解包后文件数 344 → 316） |
| 上游 configs/ 整目录拉取 | **42/42 全部落地，0 失败**（<数据根>/models/_configs/） |
| 模型目录里的 yaml 优先 | big_beta5e 走「现场生成」→ 拷进模型目录并解析成功 |
| 分离前自愈 | engine:separate 在构造请求前 await 一次 ensureSepConfig |
| 已知缺口 | BS-Roformer_LargeV1.ckpt：权重结构与标签不一致（带 mask_estimators），
|  | 上游也没有它的 yaml（Sucial/MSST-WebUI 全仓 0 个 yaml）→ 界面如实显示「缺配置」；
|  | 用户/我们可把一个 yaml 放进模型目录，解析会优先用它（不算内置）。 |

复现：`node scripts/api-push.mjs` 之外，配置获取可用资源中心卡片或
`ipc model:ensureConfig`（preload 暴露为 omrEngine.modelEnsureConfig）。
## 7. 第 4 轮：速度记号来源 / 模型仓库配置 / 逐页体检 / 变谱页 UI

### 7.1 速度（播放）—— 找到了一个新来源，同时确认了它的边界

Audiveris 不导出 <sound tempo>，<words> 也是 0（实测第 1 页 MXL：sound 只有力度、没有 metronome 元素）。
但它**认过**那个记号：.omr 书文件里 sheet#1/sheet#1.xml 有
<metronome role="Metronome"><bounds .../></metronome> 加紧跟其后的兄弟节点 <word value="…">。

| 项 | 实测 |
|---|---|
| 谱面真值 | 四分附点 = 60（裁图确认） |
| Audiveris OCR | 读成 =12（记号方框在原图只有约 17x7 px） |
| 处理 | 只接受 20~320 的合理值 → 不采用，bpmSource=metronome-unreadable，界面提示手填 |
| 读得准的谱 | 会直接用（引擎用例覆盖 =120 → 120） |

### 7.2 第 1 项：把模型配置放进模型仓库，下载时同步取

- BS-Roformer_LargeV1.ckpt（vocal/bs_roformer_large，上游 0 个 yaml，权重结构与标签不一致）的那份配置
  已放进**模型仓库** monologue82/Models/vocal/bs_roformer_large/config_bsrofoL.yaml（3210 B，回读逐字节一致）。
- 查找顺序新增一环：模型目录 → 数据根共享缓存 → **模型仓库里的同名配置** → 上游 configs/ → 现场生成。
  安装版实测：modelEnsureConfig("BS-Roformer_LargeV1") → ok:true / from:"model-repo"，且**真加载 + 前向校验通过**。
- 这一类 KB 级 yaml 统一走 net.fetch（FastDL 在小文件上会截断，见 DOWNLOADS.md 例外二）。

### 7.3 第 5 项：本地已下载模型的配置全部备齐

| 模型 | 配置来源 |
|---|---|
| big_beta5e.ckpt | 现场生成（前向校验通过） |
| denoise_mel_band_roformer_aufr33_aggr_sdr_27.9768 | 现场生成 |
| denoise_mel_band_roformer_aufr33_sdr_27.9959 | 现场生成 |
| melband_roformer_instvox_duality_v2 | 现场生成 |
| BS-Roformer_LargeV1 | 模型仓库取回 |

**ok=5 / fail=0**。生成用的模板也从数据根缓存取（支持上游名模糊匹配 + 同族候选 + 家族双试）。

### 7.4 第 2 项：M2-4 逐页体检（已开工并上线）

实测 3 页：第1页 9 小节 237 音 21 声部 / 第2页(系统0) 9 小节 220 音 / 第2页(系统1) 7 小节 83 音 / 第3页 23 小节 389 音，
问题项标出 same-pitch-dup（与后处理去重数一致）。界面每页一个胶囊，有问题的琥珀色 + 悬停看原因。
**未做**：一键重试该页；M3-2 超分、M3-3 影像预处理仍未开工。

### 7.5 第 6 项：变谱页布局与空态

- 空态从四条文字改成**三张可点的谱面类型预设卡**（点了就把模型与参数设好）+ 三步提示；
- 卡片底色在壁纸下从 78% 提到 92%（玻璃感保留、压亮部不再发花）；
- 结果面板新增每页「N 小节」与速度来源标注。

---

## 8. 第 5 轮：M3-3 共用影像预处理层（去倾斜 + Sauvola + 去噪点）

跑的是**安装版里的引擎**（`E:\Midi\FuFumidi\resources\app.asar.unpacked\engine\`，部署后 sha256 与源码逐字节一致：
engine_omr.py `F837FEF32A3A…` / engine_omr_backends.py `D3E2A7A1F093…`）。
被测算例：把用户的真页（`Desktop\gang\1.png` 2977×4208 钢琴谱、`Desktop\test\1.png` 总谱）
**人工劣化**成"手机拍照"：旋转 +3°、左亮右暗渐变（×0.45）、σ=6 高斯噪声。
劣化脚本与全部原始输出留在 `E:\Midi\_attic\omrfix\probe_prep2.py` / `probe_prep_e2e.py` / `prep2\*.json`。

### 8.1 各原语单独实测（合成页，可复现）

| 项 | 输入 | 结果 |
|---|---|---|
| 去倾斜 | 真页旋转 +3.0° | 估出 **−3.00°**（符号是"要转回去的角度"，与 PIL 相反），校正后残差 ≤0.4°；正着的页 **0.0° 且不重采样** |
| Sauvola 抗阴影 | 左亮右暗的合成谱 | 亮半边墨占比 0.0338 / 暗半边 0.0463；**对照组全局阈值把暗半边判成 1.0000**（整片黑） |
| 去噪点 | 注入 300 个 2×2 灰点 | 去掉 **300 个块**；干净图上 removed=0（不动笔画） |
| 干净谱不劣化 | 真页 `prep=off` vs `prep=auto` | **逐像素一致**（自动判为 clean）；`scan` 强制档墨占比 0.0734 → 0.0739，去 20 个灰点 |
| 判据 | 合成页 | 干净页 → false；带阴影页 → true（uneven-background）；给定 3° → true（skew） |

### 8.2 端到端 A/B（同一张劣化页，双引擎）

| 引擎 | `prep=off` | `prep=auto` |
|---|---|---|
| 内置经典 | **失败**：0 谱表 → 「没有识别到音符。可能是扫描质量过低…」（0.8 s） | **ok**：**315 音符 / 14 谱表 / 20 小节**（12.2 s），prepInfo：scan / skew −3.0 / 去噪点 8496 块 |
| Audiveris 5.11 | **失败**：`Sheet prep-001 flagged as invalid` + `StepException: Sheet ignored`（3.5 s） | **ok**：**370 音符**（后处理保留 359）/ 2 轨（17.0 s），prepInfo：scan / skew −3.0 |

**安装版经界面同一条桥（`window.fuBridge.scoreToMidi`）复核**：
`prep='off'` → `{ok:false, error:"没有识别到音符…"}`；
`prep='auto'` → `{ok:true, backend:"audiveris", notes:370, tracks:2, prep:"auto", prepInfo:[{prep:"scan",skew:-3,despeckled:8496}], bytes:3692}`。

### 8.3 顺手修掉的两个真 bug（本轮 A/B 撞出来的）

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | **找不到谱表时引擎抛栈**：用户看到「引擎没有返回结果（退出码 1）」，而不是"没识别到音符" | `pick_meter` 在 `scored` 为空时返回 `opts.beats`（此时是字符串 `"auto"`），主流程 `float("auto")` → ValueError | `pick_meter` 无候选时返回 4；主流程再加一道 `isinstance` 兜底 |
| 2 | `prep=off` 在报告里被写成 `"clean"`，与 `auto` 判定结果无法区分 | `prep_image` 的返回值只分 scan/clean | 三态如实回报 off / clean / scan |

### 8.4 界面（安装版截图核对）

- 「识别参数」新增 **影像预处理（关 / 自动 / 强制）**，概览条显示「影像预处理 自动」；三档都真接到 `--prep`。
- 空态的**三张谱面类型预设卡加上了看得见的方框**（1.5px `--border-strong` 实边 + 纯白底 + 浅投影）：
  之前用发丝线压在这页 92% 白玻璃上等于没有框，用户看不出这里有三个可选项（原话：「要有方框框起来方便用户看到有这三个选项」）。
- 右栏重复的「谱面类型」整块删除（用户：「这两处功能重复了，保留这个」）——预设只留空态那一组，
  实测 DOM 里 `.sc-scene` 为 0、`.sc-preset` 为 3，右栏只剩「识别模型 / 识别参数」。
- 「扫描件 · 手机拍照」预设描述与参数改为「歪的 / 有阴影 / 有灰点：先摆正再二值化」+ `prep:auto`、**去掉"加粗"**
  （加粗会把密集总谱整页判无效，KI-7 ①）。

### 8.5 门禁（本轮）

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | 0 |
| `npm run build:ui` | 0 |
| `npm run test:ui` | **217 / 217** |
| `npm run audit` | 0 个死选项（新控件已被主进程读取） |
| engine pytest | 新增 `tests/test_omr_prep.py` **13 项全过**（连 `test_omr_backends.py` 共 43 项，0 失败）；全套仅剩 11 项**既有**失败（diffsinger_cli 1 + openutau phonemizer 10），与上一轮完全一致 |
| 部署 | `deploy-installed.cjs` 冒烟通过（首屏 370 字符 / fuBridge object / 0 未捕获异常） |
---

## 9. 第 5 轮（下半）：M3-2 超分辨率预处理 + M2-4「一键重试该页」

跑的都是**安装版**（E:/Midi/FuFumidi/resources/app.asar.unpacked/engine/，部署后 sha256 与源码一致）。
原始数据：E:/Midi/_attic/omrfix/sr3/*.json（引擎级 A/B）、sr4/final.json、sr5/（清晰页对照）、
sr3/ui/*.json + 03-pill-before.png / 04-after-retry.png（安装版界面）。

### 9.1 M3-2 做法与门槛（门槛是量出来的，不是拍的）

| 项 | 值 |
|---|---|
| 组件 | **waifu2x-ncnn-vulkan**（单 exe 5 MB + 3 组模型；解压 **39.5 MB**；MIT；走 Vulkan） |
| 装在哪 | **用户自行安装** → 数据根 /omr/waifu2x/（资源中心「识谱引擎 → 超分辨率（低清扫描）」） |
| 下载 | FastDL：35.5 MB，gh-proxy.com 实测 **8 s**（峰值 4 MB/s）→ ghfast → ghproxy.net → 直链；minSize 20 MB |
| 引擎 | --sr off/auto/on + --sr-exe；sr_prepare_inputs 在**放大之前**换图；Audiveris 栅格路径与内置经典路径共用；homr 不接（它的网络自带归一化） |
| auto 门槛 | **谱表量不出来（interline = 0）或行距 < 5px** 才动手；清晰印刷谱与矢量 PDF 渲染的低清页一律不碰 |

### 9.2 质量对照（★ 结论：**音符数会骗人**）

参照 = **同一页全分辨率**的识别结果；指标 = (音高, 起拍) 集合的 F1 与音高分布余弦。

| 用例 | 行距 | 不超分 | 超分（auto） |
|---|---|---|---|
| 管弦乐 0.40×（635×898，**谱表量不出来**） | — | **整页失败：0 音符**（2.3 s） | **253 音符 / ×3.0**（78 s；F1 0.11 —— 粗糙，但不再是空的） |
| 钢琴 0.25×（744×1052） | 4.0px | 400 音符 · **F1 0.081** · 余弦 0.731 | 354 音符 · **F1 0.883** · 余弦 0.993 |
| 钢琴 0.35×（1041×1472） | 5.75px | 351 音符 · F1 0.931 | 370 音符 · F1 0.999 |
| **用户自己的总谱页**（1588×2246，清晰矢量 PDF） | 6.0px | 237 音符 · F1 1.00 · 24 s | **237 音符 · 输出 MIDI 逐字节相同**（sha256 17A71E4F…，门控跳过） |
| 钢琴原页（2977×4208） | 16.25px | 370 音符 | 370 音符（跳过，reason: interline-ok） |

- **原计划的验收写法（「行距 < 6px 上音符数提升 ≥ 30%」）不成立**：0.25× 那一档超分后音符数
  400 → 354（**−11%**），但与全分辨率结果的一致性 **F1 0.081 → 0.883（10.9 倍）**。
  少掉的正是插值糊出来的假符头 —— 所以这项验收**改按 F1 / 音高分布**，不按音符数。
- **给清晰页超分是有害的**：同一张清晰总谱页超分后 F1 从 **1.00 掉到 0.82** 且慢 40 s。
  门槛因此卡在「LANCZOS 已经救不回来」这条线上。

### 9.3 门控里被抓出来的第三个真 bug

端到端 A/B 第一版里，**最该超分的那一档反而不触发**：0.4× 的总谱页一行谱表都量不出来
（measure_interline 回 0），而旧门控写的是 0 < sp < 11 —— sp == 0 直接落空，
结果 sr=auto 与 sr=off 一样失败（0 音符 → 0 音符），srInfo 里连一条记录都没有。
改成 sp < SR_MIN_INTERLINE 后同一张图 **0 → 253 音符**。
（另外 0.25×/0.20× 的管弦乐页把行距**量错**成 18.7/15.2px 而绕过门控 —— 这类「量不准」的页
同样救不回来，留档在下面的未做项里。）

### 9.4 M2-4「一键重试该页」

| 层 | 做法 |
|---|---|
| 引擎 | 每次整批跑完把**每页解析结果**落在 workdir/pages/pNNN[-sK].json（失败页没有缓存，正是要重跑的那页）；--retry-page N 只把第 N 页喂给后端，其余页从缓存读回，**再走同一条合并流水线** —— 拍号推断 / 小节网格 / 跨页声部对齐看到的仍是完整页集。 |
| 应用 | main/score.js 给每次整批跑一个稳定 workdir（缓存 /omr/run-*，只留最近 8 个），结果回传 workdir；--retry-page 透传。 |
| 界面 | 失败 / 被跳过的页显示成琥珀色**可点胶囊「第 N 页重试」**（普通胶囊只读，这个有 cursor:pointer + 悬停变色）；点了用**当前界面参数**只重跑那一页 —— 所以可以「先打开超分 → 再重试该页」。 |
| 边界 | 只支持栅格增强引擎；内置经典后端报 retry-needs-raster，不假装成功。单页输入不给按钮（没有「其余页沿用上次」的意义）。 |

判据抽成纯函数 frontend/src/core/score-pages.js（retryablePages / pagesSummary），
新增 **8 项单测**（三页缺中间页、全齐、首尾都缺、单页、无 pageTotal、分带页重复页号、字符串页号、页数摘要）。

### 9.5 安装版实测（桥层 + 界面层）

**① 组件安装走应用自己的入口**（window.fuBridge.omrEngine.srInstall()）：
installed:false → true，**41,185,952 B / v20250915**，用时 **47 s**（下载 35.5 MB + 解压），
落地 E:/Midi/FuFumidi/FuFumidiData/omr/waifu2x。

**② 桥层**（3 页拖入，第 2 页被劣化到 0.2×）：

| 步骤 | 结果 |
|---|---|
| 整批跑（sr:off） | ok:true, notes:587, pages:2, pageTotal:3, warnings:[page-failed, page-partial]，回传 workdir |
| retryPage:2 + sr:on | ok:true, notes:821, pages:**3**, pageTotal:3, retryPage:2, warnings:[]；srInfo **只有一条**（= 这次真的只跑了第 2 页） |

**③ 界面层**（CDP 伪造带真实路径的拖放，走完整界面流程）：

| 时刻 | 逐页胶囊 | 统计 |
|---|---|---|
| 拖入后 | 第1页·9 小节·237 音·2.11× / 第3页·23 小节·389 音·2.11× / **[⟳ 第 2 页重试]** / 去重 39 | 32 声部 · **587 音符** · 48.0s · 拍号 6/8（推断）· **2 页 / 3** |
| 点「第 2 页重试」后 | 第1页 237 音 / **第2页·9 小节·237 音·1×** / 第3页 389 音 / 去重 42，**重试胶囊消失** | 32 声部 · **821 音符** · 57.6s · **3 页** |

截图：E:/Midi/_attic/omrfix/sr3/ui/03-pill-before.png / 04-after-retry.png。

### 9.6 门禁（第 5 轮下半）

| 门禁 | 结果 |
|---|---|
| npm run typecheck | 0 |
| npm run build:ui | 0 |
| npm run test:ui | **225 / 225**（217 + 8 项新增的「重试该页」判据） |
| npm run audit | 0 个死选项 |
| npm run test:download | **17 / 17**（新增 2 项：超分组件的 minSize 挡半截包 / 够大时字节一致） |
| engine pytest | 新增 tests/test_omr_sr.py **12 项全过**；连 prep/backends 共 **58 项，0 失败** |
| 部署 | deploy-installed.cjs 冒烟通过 |