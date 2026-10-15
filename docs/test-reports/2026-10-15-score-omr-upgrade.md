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
- [ ] 未做：结果自检（M2-4）、homr（M3-1）、影像预处理（M3-3）

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
