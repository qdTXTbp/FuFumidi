# FuFumidi 变谱（识谱）改进计划 · 2026-10-15

> **本文只做规划，未动任何代码。** 执行时在条目上打 `[x]` 并补一行实测结果。
> 制定依据：本会话对用户两套真实谱面的逐项实测 + Audiveris / homr / oemer 官方文档与源码仓库的联网核对。
> 前置阅读：`docs/known-issues.md` KI-7（本轮已修的四类问题）、`docs/plans/2026-10-14-*.md` 的计划体例。

---

## 执行进度（2026-10-15 第 2 轮）

| 条目 | 状态 | 实测结果 |
|---|---|---|
| **D1 引入 homr** | ✅ **已上线**（2026-10-15 第 3 轮） | 引擎后端 + 资源中心「用户自行安装」（**独立 venv**：homr 要 numpy≥2.4，应用运行时是 1.26）+ 3 个 ONNX 权重按镜像下载。安装版实测对比见 M3-1：**钢琴谱与 Audiveris 打平且快约 4 倍；总谱不适用**（会把 12 行谱表并成 1 轨） |
| **D2 补 OCR 语言** | ✅ **已上线** | 资源中心可装语言包（eng 22.4 MB，实测下载 27 s）；装上后**声部名从「声部 N」变成乐器名**：Flute 1,2 / Oboe 1,2 / Horn (F) 1,2 / Trumpet (Bb) 1,2 / Trombone 1,2,3 / Tuba / Timpani / Glockenspiel / Violin / Viola / ViolonCello / Double Bass；曲目信息也读出来了（Composed by Yang Lee (HOYO-MiX)） |
| **D3 做分带识别** | ✅ **已上线**（见 M2-1） | 切分判据 + 切带流水线都做了；当前作为**失败页的兜底**接入 |
| **M1-1 OCR 语言接线** | ✅ 已完成并验证 | 引擎侧给 TESSDATA_PREFIX + -constant …defaultSpecification；**必须用完整版 tessdata**（fast 版实测完全无效） |
| **M2-2 跨页声部对齐** | ✅ **已上线**（2026-10-15 第 2 轮） | 身份从「页内序号」改成 **(乐器, 声部编号)**。实测坑：Audiveris 按**系统**出 part，一页两个系统就把整份声部表重复一遍（第 5 页 23 个 part = 10+13，两次都从长笛开始）→ 按序号对齐时轨数从 21 涨到 **41**；改成身份对齐后回落。OCR 读成 Voice 的在相邻锚点之间按顺序填空槽 |
| **M2-3 乐器名 + 移调** | ✅ **已上线并 A/B 验证** | A/B（第 2+3 页，同图同参数）：`--sounding off` → Glockenspiel 61..73 / Double Bass 45..49；`--sounding on` → **73..85（+12）/ 33..37（−12）**；Horn in F −7、Clarinet/Trumpet in Bb −2。轨名带编号（Horn in F 1,2 / Horn in F 3,4 / Violin I / Violin II） |
| **M2-1 按系统切带识别** | ✅ **已上线**（失败页的兜底路径） | 切分判据 6/6 与 Audiveris 自己的 GRID 输出逐项吻合（含每页的谱表区间）；带只在「乐器组交界」切，不会劈开大谱表。第 2 页（29 行谱表）在 ×2.11 抛 OOM、退档又撞分辨率下限（×1.58 → "Sheet ignored"）—— 现在切成 **5 带按 ×3.0** 重跑救回 |
| **M1-2 拍号推断 + 统一小节网格** | ✅ **已上线** | Audiveris 不导出 `<time>`，且拍号不明时**按每小节认出来的内容定长** → 同一页不同声部小节长度都不一样（1217 个小节里 1440 tick 只占 43%）。现在先推拍号（众数 1440 = **6/8**，是第二名的 3.2 倍）再把每个声部按「小节号 × 小节长 + 小节内偏移」重排：第 1 页跨声部同刻发音率 **0.357 → 0.735**、全 6 页音符落在八分网格上 84.9% → **92.7%**；页长也改成按小节数算（末小节空着也不会让下一页提前） |
| **M1-3 内存策略** | ✅ 已完成并验证 | -swap 常驻 + 像素上限降到 1600 万：**第 1 页（24 行谱表）现在一次过**（scale 2.11 / 31 s / 234 音符 / 18 轨带乐器名），此前要跑两次约 70 s |
| **M1-4 失败原因结构化** | ✅ 已完成 | 归类 oom / timeout / lowres / no-staves / beam-guess / export → 界面给「下一步怎么做」 |
| **变谱页 UI 统一** | ✅ 已完成 | 页头换 .page-head（图标盒 + 标题 + 副题 + 状态标签）、卡片换 .card、拖放区与转录同构、右栏用 .tag / .fb-* / .select-input 同一套令牌；限宽 1040px、外边距走 var(--page-pad-*) |
| **6 页总谱回归（安装版实跑）** | ✅ | **6/6 页**（第 2 页靠分带救回）、**1713 音符**（比第 1 轮 1693 多）、抽出的原始音符 1813 个、**6/8 拍（推断）**、1510 个音符重排到统一小节网格、**7 个移调声部**被校正、耗时 **187 s**（含 OCR，比第 1 轮 228 s 还快） |
| **M2-4 逐页体检 + 一键重试该页** | ✅ **已上线**（第 4/5 轮） | 逐页列出 小节数/音符/声部/可疑项（空页、小节数不一致、负时值、超长音、同刻同音重复）；有问题的页琥珀色悬停看原因。失败/跳过的页给**可点胶囊「第 N 页重试」**：引擎按页缓存 + 只重跑那一页 + 整份重新合并（实测见测试报告 §9） |
| **M3-3 共用影像预处理层** | ✅ **已上线**（第 5 轮） | 去倾斜 + Sauvola + 去噪点，classical 与 audiveris 共用；歪 3° 带阴影的照片：旧路径两引擎全失败 → 现在 370 / 315 音符。干净谱逐像素不变。见 §3 M3-3 |
| **M3-2 超分辨率预处理** | ✅ **已上线**（第 5 轮） | waifu2x-ncnn-vulkan 作为资源中心可装组件；`auto` 只在谱表量不出来 / 行距 < 5px 时动手。实测：0.4× 总谱页 **0 → 253 音符**；0.25× 钢琴页 **F1 0.081 → 0.883**；用户自己的清晰总谱页**输出 MIDI 逐字节不变**。见 §3 M3-2 |
| 已知残留 | ⚠️ | 轨数 37（理想 ~22）：其中 14 条是 OCR 读成 Voice 的声部，只能按位置填空槽 —— 见 §2 G5 与 KI-7 ⑤ |

---

## 0. 请你先拍板的三个决策点

| # | 决策 | 选项 | 我的建议 |
|---|---|---|---|
| **D1** | 要不要引入第二个 AI 识谱引擎（homr） | ① 内置/自动下载 ② 仅"资源中心可自行安装" ③ 不做 | **②**。homr 是 AGPL-3.0，**权重还含非商用训练数据**（PrIMuS 的 HF 副本标注 CC BY-NC 4.0，见其 `LICENSE_FAQ.md`）；FuFumidi 若将来商用，权重分发的法律风险归我们。放"用户自行安装"与现在的 Audiveris 同一条路，风险最小 |
| **D2** | 要不要给 Audiveris 补 OCR 语言数据 | ① 装 ② 不装 | **① 已执行**（2026-10-15）。现在是**零语言**（实测安装目录里没有任何 `*.traineddata`，日志里 `*** No installed OCR languages ***`），TEXTS 步整段被跳过 —— 于是**速度记号、乐器名、和弦名一个都读不到**。装上完整版语言包（eng **23 MB**）后实测读出了乐器名与曲目信息。注意**必须用完整版 tessdata，不能用 tessdata_fast**（见 M1-1） |
| **D3** | 要不要做"按系统切带识别"（总谱专用） | ① 做 ② 先不做 | **① 但放在 M2**。总谱一页 24 行谱表、行距只有 6px，现在靠 2.3 倍放大硬顶（且撞 Audiveris 的 2000 万像素上限）；切带后每带可放大 3.5~4 倍。实现复杂度不低（切带边界、同系统多带的时间叠加），要配一套离线回归才敢上 |

---

## 1. 现状：本轮已经交付什么（全部为安装版实测）

两套真值集：`桌面\test`（6 页**管弦乐总谱**，1588×2246，一页 24 行谱表）、`桌面\gang`（3 页**钢琴独奏**，2977×4208）。

| 指标 | 改前 | 改后（现在） |
|---|---|---|
| 总谱：成功页 | 4/6（第 1、2 页**静默消失**） | **6/6** |
| 总谱：音符 | 1430 | **1693** |
| 总谱：声部轨 | **2**（Voice 879 + Piano 551） | **25** |
| 钢琴：声部轨 | **1** | **2**（左手 25–69 / 右手 51–95） |
| 失败页提示 | 无 | 逐页列出 Audiveris 真实原因 + 自动降档重试 |
| 参数 | 拍号/速度**没接线** | 7 个真接线参数（含量化/去重/最短音符/加粗/放大） |

**已修的四个真问题**（详见 KI-7）：① 默认 3×3 加粗把密集总谱整页判无效（同图同倍数：加粗 0 个音符 / 不加粗 235 个）；② 放大倍数写死，未按实测行距推；③ 按轨名合并 → 通用名（Voice/Piano）让整部总谱塌成 2 轨；④ 拍号/速度在增强引擎路径上根本没传给引擎。
**乐谱页同时新增总谱视图**（25 声部 × 76 小节 = 1900 行谱表刻版通过），见 5.1.0 更新日志。

---

## 2. 还差什么：实测到的 6 个缺口

| 编号 | 现象（实测） | 后果 |
|---|---|---|
| **G1** | Audiveris 不导出 `<time>`/`<sound tempo>`，解析器落回默认 → 结果里 `timeSig 4/4、bpm 120`；而原谱是 **6/8、♩.=60** | 总谱小节线、MIDI 时间轴、导出 PDF 排版全跟着错；用户不改手填值就永远错 |
| **G2** | 安装目录里 **0 个 `*.traineddata`** → TEXTS 步跳过 | 声部名只能是 `Part 1..25`；用户分不清是哪件乐器 |
| **G3** | 移调乐器按**记谱音高**写进 MIDI（无 `<transpose>` 处理，且 Audiveris 也没导出） | 该谱 25 声部里 8 个是移调乐器：Horn in F 差纯五度、Clarinet/Trumpet in Bb 差大二度 |
| **G4** | 单页 24 谱表、行距 6px；2.3 倍放大时第 1 页 JVM 堆溢出（`-Xmx8G` 也一样），靠降档到 1.72 倍才过 | 密集总谱始终在"分辨率够不够"的悬崖边；每页要跑两次 |
| **G5** | 跨页声部身份 = **页内序号** | 第 2 页上下两个系统的谱表数不同（上半 **22 行**：木管+铜管+打击+钢琴/竖琴+弦乐；下半 **8 行**：钢琴+独奏中提+弦乐），序号对齐会把下半的钢琴对到长号上 |
| **G6** | 扫描件/照片路径只有"灰度阈值 + 可选加粗" | 倾斜、阴影、噪点无处理；而 Audiveris 本身对这类输入就弱（官方 limitations 也承认） |

---

## 3. 改进条目

### M1 · 快赢（每项 ≤ 半天，风险低，先做）

- [x] **M1-1 Audiveris OCR 语言数据接线**（对应 G1/G2）—— 2026-10-15 已完成（引擎 + 资源中心 + 变谱页状态行）
  - ★ **实测结论：必须用完整版 tessdata，tessdata_fast 完全无效。** Audiveris 是用 Tesseract 的 **legacy 模式**初始化的，而 fast 版只有 LSTM 权重：装 fast 版会看到「Installed OCR languages: eng」紧跟着 `Could not initialize TessBaseAPI languages: eng in legacy mode`，导出的 MusicXML 与**完全不装**逐字节同内容（161573 B，无任何文字）。换成完整版（eng 23 466 654 B）后同一页立刻读出：
    `credit-words` = "Composed by Yang Lee (HOYO-MiX)" / "Transcribed by f. Kotone"；`part-name` 从清一色 Voice 变成 **Flute 1,2 / Oboe1,2 / Clarinet (135) 1,2 / Bassoon 1,2 / Ham (F) 1,2 / Horn (F) 3,4 / Trumpet (Bb) 1,2 / Trumpet (BB) 3 / Trombone 1.2,3 / Tubular Bells / Glockenspiel / Piano / SoloViola / Violin I I / Violin II / Viola / Violon Cello / Double Bum**（含 OCR 误识：Ham=Horn、Double Bum=Double Bass —— 后续乐器词典要容错）。
  - 因此：语言包从**完整版 tessdata** 取（eng ≈ 23 MB，含 legacy + LSTM）；引擎侧 `installed_ocr_langs()` 用 **5 MB 门槛**把 fast 版挡在外面（装了也不算数，界面会引导重装）。
  - 做法：spawn Audiveris 时给 `TESSDATA_PREFIX=<数据根>/omr/tessdata`（官方文档：优先读该环境变量，否则用 Audiveris 用户配置目录下的 `tessdata`）；资源中心"识谱引擎"卡增加"OCR 语言包"一项，从 `tesseract-ocr/tessdata_fast` 下 `eng.traineddata`（约 4 MB，可选 `chi_sim`/`jpn`），**走 `main/fast-download.js`**（`docs/DOWNLOADS.md` 的硬规则）；调 `-constant org.audiveris.omr.text.Language.defaultSpecification=eng` 指定语言。
  - 验收：日志不再出现 `No installed OCR languages`；6 页总谱的导出里出现非 120 的 `<sound tempo>`；声部名出现乐器文本（哪怕只认出 Flute/Oboe 一半）。
  - 依据：[Audiveris · OCR languages](https://audiveris.github.io/audiveris/_pages/guides/main/languages.md)、[Constants](https://audiveris.github.io/audiveris/_pages/guides/advanced/constants.md)

- [x] **M1-2 拍号推断（缺省不再写死 4/4）**（G1）—— 2026-10-15 第 2 轮完成（实现比原计划更彻底：不只改拍号，还把每个声部重排到统一小节网格）
  - ★ **实测：原来不只是"拍号写死"，而是「各声部小节长度都不一样」**。Audiveris 拍号不明时按
    「这一小节认出来的内容」定长（日志会写 `No target duration for measures …, please check time signatures`），
    1217 个小节里 1440 tick（3 个四分）只占 43%，其余是 720/960/1920/2280/2640…
  - 做法：① 取所有小节长度的**众数**（判据是「明显赢」：≥20% 且 ≥1.5× 第二名，不是「占多数」——
    实测分布很散，占多数的判据会直接放弃）；② 按 `小节号 × 小节长 + 小节内偏移` 重排每个声部；
    ③ 用户显式填了拍号就用用户的（`--beats` 非 auto）；④ 页长改成按小节数算。
  - 验收（安装版实测）：拍号 **6/8**（众数 1440，是第二名 3.2 倍）、1510 个音符重排、
    第 1 页跨声部同刻发音率 **0.357 → 0.735**、音符落在八分网格上 84.9% → **92.7%**
  - 做法：优先用 OCR 到的拍号（依赖 M1-1）；OCR 拿不到时，用识别出的**音符起点直方图 + 小节线位置**推每小节拍数（`engine/engine_omr.py` 已有 `pick_meter` 的思路可复用），只在置信度足够时采用，界面上标注"推断值"。
  - 验收：那 6 页在用户**不填**拍号时给出 6/8（或明确回落到 4/4 并给 warning），总谱页小节线随之对齐。
  - 依据：本轮实测 `times=[{beats:4,beatType:4}]` 是解析器默认值，不是识别结果

- [x] **M1-3 内存策略：`-swap` + 保守放大**（G4）—— 2026-10-15 已接线（`-swap` 常驻 + 像素上限 1900 万→1600 万）
  - 实测：`-swap` 单用**压不住**这个 OOM（6 页总谱第 1 页仍在 ×2.3 时溢出、仍需降档重试）；真正起作用的是**保守放大** —— 同一页 ×2.0（约 1430 万像素）一次就过。
  - 做法：Audiveris 命令行加 `-swap`（官方 CLI：每页处理完就换出）；auto 放大倍数在"预测像素 > 1600 万"时主动降一档，失败重试逻辑保留（已有）。
  - 验收：第 1 页在 auto 下**一次成功**（不再需要重试），单页耗时不超过现在的 1.2 倍。
  - 依据：[Audiveris · CLI](https://audiveris.github.io/audiveris/_pages/guides/advanced/cli.md)

- [x] **M1-4 失败原因结构化**（G4/G6）—— 2026-10-15 已接线（引擎归类 `fail` code + 界面翻成「下一步怎么做」）
  - 归类：`oom` / `timeout` / `lowres` / `no-staves` / `beam-guess` / `export` / `unknown`；界面按 code 给可执行建议（分辨率不足→调 4×、内存不足→降档、没找到五线谱→确认不是封面页…）。
  - 做法：把 Audiveris 日志里的关键行归类成可翻译 code：`lowres`（interline < 11）/ `no-staves` / `oom` / `timeout` / `scale-guess`（"No reliable beam height found"），界面按 code 给"下一步怎么做"。
  - 验收：人为把图缩到 1/3 复现失败时，界面显示"分辨率不足，建议放大 2 倍"，不是一串 Java 栈。

### M2 · 结构（每项 1~2 天，需要离线回归）

- [x] **M2-1 按系统切带识别（总谱专用）**（G4）—— 2026-10-15 第 2 轮上线（先作为**失败页的兜底**接入，不做默认路径）
  - 验收（安装版实测）：第 2 页（29 行谱表）整页 ×2.11 抛 OOM、退档 ×1.58 被 Audiveris 判
    "Sheet ignored"——现在切 **5 带按 ×3.0** 重跑，**6/6 页全部转出**、音符 1693 → **1713**
  - ★ **切分判据（实测 6/6 全中）**：把相邻两行谱表之间的空白带取出来，看有没有**任何一列**的墨迹覆盖率 ≥ 0.9
    （= 一条贯穿的竖线：左括号竖线或小节线）。**没有 → 系统交界**。行距阈值、小节线横向对齐都试过，都不行：
    第 2 页组内空白 129.5px 比系统交界 94.5px 还大；第 6 页整页小节线位置完全一致（空小节），重合度 1.00。
  - 判据 vs Audiveris GRID 日志（`PeakGraph.java:310 | Systems: #1[1..21] #2[22..29]`）**逐页逐区间吻合**：
    第 1 页 1 个系统[1..23]、第 2 页 2 个[1..21][22..29]、第 3 页 3 个[1..6][7..14][15..25]、
    第 4 页 3 个[1..11][12..24][25..32]、第 5 页 2 个[1..13][14..26]、第 6 页 1 个[1..12]。
    探针：`E:\Midi\_attic\omrfix\sys_rule.py`（图像侧）与 `omrfix\ocr5\work\**\prep-00N-*.log`（Audiveris 侧，两条独立证据）
  - 已知风险（切带前必须处理）：第 4 页有 3 个系统、第 3 页 3 个、第 2/5 页各 2 个 —— 这些页的 part 表是**按系统重复**的，
    切带后每个系统会各自出一份 part 表，合并必须走 M2-2 的身份对齐（已就绪），否则轨数会翻倍
  - 做法：`detect_staves` 找谱表 → 定"系统"边界 → 每带独立放大（受单边 6000px、总像素 1900 万约束，每带可到 3.5~4 倍）→ 逐带跑 Audiveris → **同一系统内多带按时间叠加（同时刻）、系统之间按时序拼接**。
  - ★ 关键坑（实测）：**不能只按"谱表间距阈值"切系统**。第 2 页相邻谱表的空白里有两处明显偏大：129.5px 与 94.5px；按谱面乐器顺序对照（前 10 行是木管+铜管、第 11 行起是打击乐）判断 129.5px 落在**同一个系统内部**的乐器组之间，94.5px 才是系统交界 —— 也就是说**组内空白可以大于组间空白**，纯阈值必切错。要用"小节线横向对齐 + 左侧括号竖线的纵向跨度"这类结构信号。
  - 验收：6 页总谱音符数 ≥ 1693 且 6/6 页成功；总耗时 ≤ 现在 2 倍；单带失败不影响其它带。

- [x] **M2-2 跨页声部对齐（不再只靠序号）**（G5）—— 2026-10-15 第 2 轮完成
  - 实测：`(页内序号, 谱表行)` 会错位 —— Audiveris 按**系统**出 part，一页 3 个系统就把声部表重复 3 遍；
    第一版「禁止一页内重复用同一槽位」的实现把轨数从 21 顶到 **43**。改成 **(乐器, 声部编号)** 对齐
    （编号含 OCR 变体 `ll`→`II`、`V1n`→`Violin`）后回到 **37**；余下 14 条是 OCR 读成 Voice 的声部，见 KI-7 ⑤
  - 做法：声部身份 = `(谱表序号, 谱号, 音域区间)` 三元匹配；不匹配时新建声部并给 `warning: part-mismatch`，界面列出。
  - 验收：第 2 页"22 行 + 8 行"两系统不再错位（人工核对每轨音域连续、无跨乐器跳变）。

- [ ] **M2-3 乐器名 → 声部名 + 移调表**（G2/G3）
  - 做法：OCR 文本 → 乐器词典（中/英/日 + 缩写如 `Hn.`、`Tpt.`、`Vln. I`）→ 每件乐器带 (显示名, 移调半音, 常用谱号)；写进 MIDI 轨名（ASCII 安全名 + 界面 label）；新增开关"按实际音高输出"（应用 `<transpose>` 等价的半音偏移）。
  - 验收：25 轨显示乐器名（识别不出时退回 `声部 N`）；开"实际音高"后 Horn 轨整体 −7 半音、Clarinet/Trumpet −2。

- [x] **M2-4 结果自检（"体检"式）** —— 2026-10-15 第 4 轮（逐页体检已上线）
  - 逐页报告：**小节数 / 声部数 / 音符数 / 问题项**，界面里每页一个胶囊，有问题的显示琥珀色 + 悬停看原因。
  - 体检项（引擎侧 `_page_checks`）：空页、各声部小节数不一致、非正时值、超长音（>8 小节）、同刻同音重复。
    实测 6 页：第 2 页两个系统分别 9 / 7 小节 ✓（与真值一致），三页都标出 same-pitch-dup（与后处理去重数对得上）。
  - [x] 「一键重试该页」—— **2026-10-15 第 5 轮已上线**（逐页体检本身第 4 轮就已上线）。
  * 引擎：每次整批跑完把**每页的解析结果**落在 `<workdir>/pages/pNNN[-sK].json`；`--retry-page N`
    时只把第 N 页喂给后端，其余页从缓存读回，再走**同一条合并流水线** —— 拍号推断 / 小节网格 /
    跨页声部对齐看到的仍是完整页集，所以是「只换一页、整份重算」。（不能把上次的 MIDI 拼起来：
    合并层必须看到全部页才能给出正确的拍号与声部。）
  * 应用：`main/score.js` 给每次整批跑一个稳定 workdir（`<缓存>/omr/run-*`，只留最近 8 个），
    结果里回传 `workdir`；失败 / 被跳过的页在结果区显示成琥珀色**可点胶囊「第 N 页重试」**，
    点了用**当前界面参数**只重跑那一页（所以可以「先打开超分 → 再重试该页」）。
  * 只支持栅格增强引擎（Audiveris / homr）：内置经典后端不返回逐页解析数据，会明确报
    `retry-needs-raster`，不假装成功。
  - 做法：逐页报告 小节数 / 拍号一致性 / 声部数 / 可疑项（超长音、同刻同音重复、负时值、空页），界面列出并可一键重试该页。
  - 验收：用户那 6 页的报告能一眼看出"第 3 页少 2 小节"这类结构错误。

### M3 · 多引擎与影像（每项 2~4 天，涉及下载体积与许可）

- [x] **M3-1 第三引擎：homr（AI）**（G6）—— 2026-10-15 第 3 轮上线（**用户自行安装**）
  - 实测对比（安装版，同一台机、同一套参数，--backend homr vs --backend audiveris）：

    | 用例 | homr | Audiveris | 结论 |
    |---|---|---|---|
    | 钢琴 3 页（gang/） | **1095 音符 / 2 轨 / 37 s** | 1128 音符 / 2 轨 / ~2–3 min | **打平且快约 4 倍**（左右手都分开） |
    | 总谱第 6 页（test/6.png） | 75 音符 / **1 轨** / 8 s | 110 音符 / **11 轨** | **不适用**：homr 把 12 行谱表并成一条轨，声部信息全丢 |

  - 因此**不进 auto 的默认路径**（auto 仍是 Audiveris 优先）；只有**没装 Audiveris** 时才用 homr 兜底 ——
    对「扫描件 / 拍照」这档它比内置经典识谱强，也不会把总谱那一档让出去。
  - 体积 / 许可（原计划的顾虑，实测落实）：pip 依赖约 200 MB（onnxruntime 占大头）+ 权重 3 个包
    共 **150 MB**（segnet 54.7 + encoder 50.4 + decoder 45.1），全部装在
    <数据根>/omr/homr/venv，**不随安装包分发**；卸载 = 删目录。
  - 权重通道实测：ghfast.top 只有 30 KB/s，gh-proxy.com 2.11 MB/s → 通道顺序按实测排。
  - 定位：**印刷谱/矢量 PDF 用 Audiveris，扫描件与拍照用 homr**（同行 SumisoraOMR 就是这么分的：`Auto 模式按文件类型选引擎`）。
  - 做法：在 `engine_omr_backends.py` 的后端位加一路（现在只有 classical / audiveris）；权重约 **290 MB**，首次使用自动下载，CPU/CUDA 两档；离线包与资源中心入口同 Audiveris。
  - 许可（D1）：代码与权重 AGPL-3.0，权重含 PrIMuS（CC BY-NC）→ **默认不打包进安装包**。
  - 验收：3 页钢琴谱 + 6 页总谱各跑一遍，给出"homr / Audiveris"对比表（音符数、声部数、结构、耗时）；只有整体不差于 Audiveris 才在"自动"里启用。
  - 依据：[homr README](https://github.com/liebharc/homr)、[homr LICENSE_FAQ](https://github.com/liebharc/homr/blob/main/LICENSE_FAQ.md)、[oemer README（作者推荐 homr）](https://github.com/BreezeWhite/oemer)、[SumisoraOMR](https://github.com/Tsukamotoshio/SumisoraOMR)

- [x] **M3-2 超分辨率预处理**（G6）—— **2026-10-15 第 5 轮已上线，安装版实测通过**
  - 做法：**waifu2x-ncnn-vulkan**（单 exe 5 MB + 3 组模型，解压 39.5 MB，MIT，走 Vulkan）作为
    **用户自行安装**的组件（资源中心 → 识谱引擎 → 超分辨率），引擎侧新增 `--sr off|auto|on` + `--sr-exe`。
    接入点在放大**之前**（`sr_prepare_inputs`）：把低清页换成神经放大后的新文件，之后的行距推导 /
    二值化 / 分带逻辑一行都不用改（`prep_image` 会自己量新图的行距）。Audiveris 栅格路径与内置经典
    路径共用；homr 不接（它的网络在原始扫描件上训练、自带归一化，再超分是双重处理）。
  - **门槛是量出来的，不是拍的**：`auto` 只在**谱表量不出来（interline = 0）或行距 < 5px** 时才动手。
  - 验收（原定「行距 < 6px 上**音符数**提升 ≥ 30%」）—— **这条指标本身不成立，实测数据如下**：

    | 用例 | 行距 | 不超分 | 超分（auto） |
    |---|---|---|---|
    | 管弦乐 0.40×（635×898，**谱表量不出来**） | — | **整页失败：0 音符**（2.3 s） | **253 音符 / ×3.0**（78 s，F1 0.11 —— 粗糙，但不再是空的） |
    | 钢琴 0.25×（744×1052） | 4.0px | 400 音符 · **F1 0.081** · 音高余弦 0.731 | 354 音符 · **F1 0.883** · 音高余弦 0.993 |
    | 钢琴 0.35×（1041×1472） | 5.75px | 351 音符 · F1 0.931 | 370 音符 · F1 0.999 |
    | **用户自己的总谱页**（1588×2246，清晰矢量 PDF） | 6.0px | 237 音符 · F1 1.00 · 24 s | **237 音符 · 输出 MIDI 逐字节相同**（门控跳过） |
    | 钢琴原页（2977×4208） | 16.25px | 370 音符 | 370 音符（跳过，`reason: interline-ok`） |

    两条结论（都进了 §5 的验收办法）：
    ① **音符数会骗人**：0.25× 那一档超分后音符数 400 → 354（**−11%**），但与「同一页全分辨率识别结果」
       的一致性 **F1 0.081 → 0.883（10.9 倍）**、音高分布余弦 0.731 → 0.993 —— 少掉的正是插值糊出来的假符头。
       所以这一项的验收**改按 F1 / 音高分布**，不按音符数。
    ② **给清晰页超分是有害的**：同一张清晰总谱页超分后 F1 从 **1.00 掉到 0.82** 且慢 40 s，
       所以门槛卡在「LANCZOS 已经救不回来」这条线上，清晰印刷谱与矢量 PDF 渲染的低清页一律不碰。
  - 界面：识别参数新增「超分辨率（关 / 自动 / 强制）」；资源中心新增「超分辨率（低清扫描）」卡
    （安装 / 卸载 / 体积 / 安装位置）。下载走 FastDL：35.5 MB，gh-proxy.com 实测 8 s（峰值 4 MB/s），
    `minSize` 20 MB 挡半截包（用例在 `scripts/test-fast-download.mjs`）。
  - 依据：[Audiveris · Improved Input](https://audiveris.github.io/audiveris/_pages/guides/advanced/improved_input.md)、[Audiveris issue #762](https://github.com/Audiveris/audiveris/issues/762)、
    [waifu2x-ncnn-vulkan](https://github.com/nihui/waifu2x-ncnn-vulkan)（MIT）

- [x] **M3-3 共用影像预处理层**（G6）—— **2026-10-15 第 5 轮已上线，安装版实测通过**
  - 做法：去倾斜（行投影方差最大化）、**局部自适应二值化（Sauvola, k=0.15）**、小噪点清除，
    原语落在 `engine_omr.py`（`looks_like_scan` / `sauvola` / `estimate_skew` / `deskew` / `despeckle` /
    `prep_gray`），**两条引擎路径共用**：栅格路径走 `engine_omr_backends.prep_image`（放大前摆正、放大后二值化），
    经典路径走 `engine_omr.prep_gray`。新增参数 `--prep off|auto|scan`（默认 **auto** = 逐页判断像不像扫描件）。
    homr 不接这一层：它的网络是在原始扫描件上训的、自带归一化，再二值化一遍等于双重处理。
  - 判据（`looks_like_scan`，命中一条即走扫描件路径）：背景不均（8×8 分块 90 分位的极差 > 0.22）/ 噪点多
    （<6px 小块占墨像素 > 2%）/ 倾斜 ≥ 0.25°。
  - 验收（原定「倾斜 3°、带阴影的照片能识别」）—— **达成，且给出双引擎 A/B**：

    | 引擎 | `prep=off`（旧路径） | `prep=auto`（本层） |
    |---|---|---|
    | 内置经典 | **识别失败**（0 谱表 → 「没有识别到音符」），0.8 s | **315 音符 / 14 谱表 / 20 小节**，12.2 s |
    | Audiveris | **失败**：`Sheet flagged as invalid` + `Sheet ignored`，3.5 s | **370 音符 / 2 轨**（后处理保留 359），17.0 s |

    干净印刷谱**不被劣化**：同一页 `prep=off` 与 `prep=auto` 输出**逐像素一致**（自动判为 clean → 走原路径），
    代价仅 0.4 s/页的倾斜估计；`scan` 强制档墨占比 0.0734 → 0.0739（几乎无差）。
  - 界面：识别参数新增「影像预处理（关 / 自动 / 强制）」，概览条在有别于默认时显示；「扫描件 · 手机拍照」预设
    改为 `prep:auto`（原预设的"加粗"实测会把密集总谱整页判无效，一并去掉）。

---

## 4. "更多模型 / 更多参数"的最终矩阵（对应用户提的界面要求）

| 模型（后端） | 状态 | 体积 | 许可 | 适用 |
|---|---|---|---|---|
| 自动（有增强就用增强） | ✅ 已上线 | — | — | 默认 |
| Audiveris 5.11（增强） | ✅ 已上线（可选装） | ~158 MB | AGPL-3.0 | 印刷谱、矢量 PDF |
| 内置经典 · 通用 | ✅ 已上线 | 内置 | 本项目 | 离线兜底 |
| 内置经典 · 钢琴谱 / 单旋律 | ✅ 已上线 | 内置 | 本项目 | 单乐器 / 单声部 |
| **Audiveris · 分带精读**（M2-1） | ⬜ 计划 | — | — | 一页 ≥ 12 行谱表的总谱 |
| **homr（AI）**（M3-1） | ⬜ 计划 | ~290 MB | AGPL + NC 权重 | 扫描件、手机拍照 |
| **Audiveris · 超分**（M3-2） | ⬜ 计划 | 待实测（按引擎估算 20~40 MB） | 视所选引擎 | 低清扫描 |
| oemer（备选） | ⬜ 备选 | 未实测（checkpoint 由官方脚本自动下载） | 代码 MIT（权重条款另计） | 作者本人推荐改用 homr，效果差一档 |

参数侧：已上线 7 个真接线参数（拍号/速度/放大/加粗/量化/最短音符/去重）；M1-1 后新增"OCR 语言"，M2-1 后新增"分带识别"，M2-3 后新增"按实际音高输出"。**每个新控件都必须在下面写一行小字说明"开了会怎样、代价是什么"**（沿用 `2026-10-14` 计划里的硬约束）。

---

## 5. 验收与回归（不许只看"跑通了"）

1. **固定真值集**：`桌面\test`（6 页总谱）+ `桌面\gang`（3 页钢琴），每次改动用同一套参数跑一遍，把 每页音符数 / 声部数 / 耗时 / 失败原因 写进 `docs/test-reports/`（体例见 `docs/test-reports/2026-10-13-v5.1.0-vm.md`）。
2. **引擎回归**：`engine/tests/test_omr_backends.py` 增用例（切带几何、移调映射、拍号推断、OCR 语言接线），前端 `frontend/tests/musicxml-fullscore.test.js` 已覆盖总谱生成器。
3. **端到端**：复用 `E:\Midi\_attic\omrfix\probe-*.cjs`（走 `window.fuBridge.scoreToMidi` 真链路 + CDP 截图），新功能一律补探针。
4. **门禁**：`typecheck` / `build:ui` / `test:ui` / `audit` 全绿 + `deploy-installed.cjs` 部署冒烟，**并且把 6 页总谱 + 3 页钢琴在安装版上真跑一遍**（构建绿 ≠ 能用）。

---

## 6. 明确不做（及理由）

- **不做手写谱识别**：Audiveris 与 homr 都不支持，oemer README 明确只做印刷体。
- **不引入商业 OMR**（PhotoScore / SmartScore 之类）：与"离线 + 不登录"的产品前提冲突。
- **不把 AGPL/NC 权重打进安装包**：只走"用户在应用内自行下载安装"。
- **不在 M1/M2 阶段做自动分谱导出**（25 个独立文件）：等 M2-3 的乐器识别落地后再评估，否则分出来的文件名还是 `Part 7`。

---

## 7. 工作量与顺序建议

| 条目 | 价值 | 风险 | 估算 | 依赖 |
|---|---|---|---|---|
| M1-1 OCR 语言 | 高（速度/乐器名/和弦名一起解决） | 低 | 0.5 天 | — |
| M1-2 拍号推断 | 高 | 中（误判会写错拍号） | 0.5~1 天 | M1-1 更佳 |
| M1-3 `-swap` + 保守放大 | 中 | 低 | 0.5 天 | — |
| M1-4 失败原因结构化 | 中 | 低 | 0.5 天 | — |
| M2-1 分带识别 | **最高**（总谱质量天花板） | 中高 | 2 天 | M1-4 的失败分类有用 |
| M2-2 跨页声部对齐 | 高 | 中 | 1 天 | — |
| M2-3 乐器名 + 移调 | 高 | 中 | 1.5 天 | M1-1（OCR）|
| M2-4 结果自检 | 中 | 低 | 1 天 | — |
| M3-1 homr 引擎 | 高（扫描件） | 中高（体积/许可/首次下载） | 3 天 | D1 决策 |
| M3-2 超分预处理 | 中高 | 中 | 2 天 | 体积评估 |
| M3-3 影像预处理层 | 中 | 低 | 1~2 天 | — |

**建议顺序**：M1 全部 → M2-1 → M2-3 → M2-2/M2-4 → （视 D1）M3-1 → M3-2/M3-3。

---

## 8. 参考（联网核对，2026-10-15）

- Audiveris 官方文档：[CLI](https://audiveris.github.io/audiveris/_pages/guides/advanced/cli.md) · [Constants（800+ 可调常量，含 `-constant KEY=VALUE`）](https://audiveris.github.io/audiveris/_pages/guides/advanced/constants.md) · [OCR languages（5.5 起默认不装语言，TEXTS 步会被跳过）](https://audiveris.github.io/audiveris/_pages/guides/main/languages.md) · [Improved Input（低分辨率放大 / 去噪配方）](https://audiveris.github.io/audiveris/_pages/guides/advanced/improved_input.md) · [Sheet scale（SCALE 步与谱线/符杠厚度直方图）](https://audiveris.github.io/audiveris/_pages/guides/main/sheet_scale.md) · [Limitations](https://audiveris.github.io/audiveris/_pages/reference/limitations.md)
- [Audiveris issue #762「Audiveris option tweaks for orchestral scores」](https://github.com/Audiveris/audiveris/issues/762)：总谱行距 8px 被判无效、作者建议提高分辨率、以及低分辨率下的 beams 崩溃 —— 与本项目实测的第 1、2 页失败同源
- [homr](https://github.com/liebharc/homr)：README / [LICENSE_FAQ（AGPL + PrIMuS 非商用数据）](https://github.com/liebharc/homr/blob/main/LICENSE_FAQ.md) / [Benchmark（OMR-NED 评测方法）](https://github.com/liebharc/homr/blob/main/Benchmark.md)
- [oemer](https://github.com/BreezeWhite/oemer)：MIT 代码，README 里明确推荐改用 homr
- [Sheet Music Transformer++：End-to-End Full-Page OMR for Pianoform Sheet Music](https://ar5iv.labs.arxiv.org/html/2405.12105)：多谱表整页识别的学术现状
- [SumisoraOMR](https://github.com/Tsukamotoshio/SumisoraOMR)：同行的双引擎（PDF→Audiveris / 图片→homr，权重 ~290 MB）+ Real-ESRGAN / waifu2x 超分预处理

---

*制定：2026-10-15 · 分支 `release/5.0.0`（版本 5.1.0）· 本文尚未改动任何代码*
