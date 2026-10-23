# 空 MIDI 与自动探测慢：排查记录（2026-10-20）

## 现象

- `E:\Midi\midi\output\「薇斯纳：春之晨舞」_3.mid` / `_4.mid` 只有 **33 字节**：合法 MIDI 头 + 一条 tempo（123 BPM），**0 轨、0 音符**。
- 同一首歌的 `_1`（3376 音符/12 轨）、`_2`（3333 音符/4 轨）、`_5`（25502B，4 轨）都正常。

## 已确认的事实

1. **不是写盘/导入损坏**：33B 是 `events_to_midi_bytes([])` 的典型结果 —— 引擎正常结束、但模型产出 **0 个音符事件**。
2. **不是固定可复现 bug**：用同一首源 mp3（`C:\Users\...\「薇斯纳：春之晨舞」.mp3`）和当时队列快照参数（音色稳定/probe、auto BPM、beat grid、低阈值）直接跑引擎，得到 **3333 音符 / 25498B**，与 `_5` 一致。
3. **现场抓到慢的根因**：用 `py-spy dump` 观察正在跑的 worker（large 主模型 + probe），它卡在：
   `instrument_probe.probe() → model.transcribe() → _generate_token_stream()`，
   **在 3×20s 预分析里已经跑了约 9 分钟**；GPU 99%、9.5GB/12.2GB、80°C。
4. 原因：旧实现让**探测器复用主模型**。主模型是 `large`（1.4B）时，3 段 20s 预分析也要跑大模型 4 个 chunk ×3 段，代价灾难性；用户会以为翻译卡死/取消，随后看到各种不完整结果。

## A/B 测量（RTX 5070 Ti Laptop，191s 歌曲）

| 探测方式 | 探测耗时 | 检测到的组 |
|---|---:|---|
| 主模型 medium | 24.9s | acoustic_piano / distorted_electric_guitar / drums / electric_bass |
| 独立 small | 39.3s | drums / acoustic_piano（少 2 组） |
| 主模型 large | >9 分钟 | （卡在探测阶段） |

30s 片段上 large 主模型 + small 探测器：探测 3.9s、主转录 44.7s、250 音符，正常产出。

## 本轮修复

1. **探测模型 auto 选择**：
   - large 主模型 → 独立 **small** 探测器（避免数分钟预分析；加载约 0.3s）；
   - medium/small 主模型 → 直接用主模型探测（medium 探测反而比 small 快且组更全）；
   - `FUFUMIDI_PROBE_MODEL=small|main` 可强制覆盖做 A/B。
2. **0 音符保护**：写盘前在内存里数音符；为 0 且有乐器组限制时，**取消限制重试一次**；仍为 0 则抛错（不再写 33B 空 MIDI、不再入库空歌）。
3. 探测耗时/探测器名写进日志：`预分析锁定乐器组（音色稳定，探测器=…，Xs）：…`。

## 仍未解释

- `_3/_4` 那两次空结果的具体触发参数没有日志（引擎日志只在 UI，未落盘，队列历史也被覆盖）。当前证据不能 100% 断言它们是 large+probe 导致的；但已加入的保护会在下次 0 音符时直接报错并说明参数，而不是静默生成空文件。
- 若要给大编制做分段探测，见 `docs/plans/2026-10-18-transcribe-optimization-plan.md` 的分段方案（探测器独立小模型 + 全局/邻段并集）。
