# MuScriptor 跨块延音（prelude_forcing）回退为默认开（2026-10-31，基于 6.3.1）

> 用户报障原文：「转录部分 muscriptor 问题还是很大，音色不统一和音符丢失问题依旧严重，
> 上一个稳定版 4.3.1 没问题的」。
> 本文件第 1~4 节在 6.2.6 上写成，第 5 节是同步到 **6.3.1** 后的落地差异。

## 1. 结论先说

`prelude_forcing` 从「一律关掉」改回**默认开**（= v4.3.x 的行为）。僵尸长音仍由
**音频证据式收尾**兜底。

## 2. 归因链（每一步都有仓库内的实证）

| 时间 | 改动 | 后果 |
|---|---|---|
| v4.3.x | 单遍推理，`transcribe()` 用上游默认 `prelude_forcing=True` | 跨块延音由模型续接：音色一致、音符密度正常 —— **用户认定的稳定版** |
| 5.0.0-beta.4 | changelog 记下"真正原因"：关掉 prelude 后**换乐器组 1 → 16 次、音符少 22%、非鼓轨 5 → 9 条** | 说明 prelude 就是"按原乐器续进下一块"的机制 |
| 2026-10-18b | 为杀"僵尸长音"把 `prelude_forcing` **一律传 False**，改用解码后 `_stitch_chunk_boundaries` 补连续性 | 缝合只能接"同轨同音高"的延音，管不了**换乐器** ⇒ 把 beta.4 的回归又做了一遍 |
| 2026-10-24 | 恢复 `probe` + `timbre_stabilize` 当默认 | 把"音色不稳定"压下去一部分，代价见下 |

两条症状对应的机制：

- **音色不统一**：prelude 关掉后，每个 5 秒块的边界都把延音**重新判定一次乐器**。
- **音符丢失**：① 同上（同一首歌音符少 22%）；② `probe` 系列是**整曲硬约束** ——
  探测没听到的乐器，整首歌都不会输出（长尾乐器整条消失）。

## 3. 改了什么（引擎与前端）

- `engine/engine_muscriptor.py`
  - `prelude_forcing` 重新交给模型：默认 `True`，显式 `False` 才关（顺带修了字符串
    `"false"` 被 `bool()` 当真的坑）。
  - 缝合只在 `prelude_forcing=False` 时启用（两条路径互斥，不再叠加）。
  - 证据钩子不可用时日志说清后果（未打补丁的 muscriptor 0.3.0 没有
    `set_sustain_evidence`，此时僵尸音没有任何兜底）。
- 界面开关改名「跨块延音缝合」→「跨块延音（模型续接）」（zh/en/ja 同步）：
  它现在控制的是**模型侧**续接，不只是解码后的缝合。
- 测试：`test_muscriptor_stitch.py` 改为正向断言（默认→模型收到 True 且不缝合；
  显式 False→缝合）。

## 4. 没做到的验证（必须知道）

- **没有跑真实 A/B**：本机没有 MuScriptor 权重（`resources/models` 只有 audio-tagger /
  basic_pitch / piano_transcription），Medium 需要 HF 授权或 1.2 GB 分卷下载。
  所以这次是**按已知数据回退到 4.3.x 配置**，不是新测出来的最优。
- 有权重后应当补跑：

```powershell
python engine/bench_presets.py --material synth --model-size medium --repeat 2 --md ab.md
```

  建议新增一档 `prelude_on`（`muscriptor_instruments=none` + `prelude_forcing=true`）
  与现有三档同表比较：重点看**换乐器组次数**与**音符数**。

- 僵尸长音的回潮风险：prelude 开 + 证据钩子在，理论上被兜住；但本机 muscriptor 是
  **未打补丁的 0.3.0**，`test_muscriptor_sustain_evidence.py` 连导入都失败，
  等于这条兜底在本机无法验证。装修复版 wheel（`0.3.0+fufumidi.1`，见 `engine/deps.py`）
  后再看长音频。

## 5. 同步到上游后的落地差异

> **2026-10-31 二次同步**：HEAD 已跟到 `cnb/master` = `51ca26d`（cnb 上 `v6.3.1` 与 `v6.4.2`
> 两个 annotated tag 指向同一提交，`package.json` 写 6.3.1）。下面几条仍然成立。

- 「MuScriptor · 最优」预设是 `muscriptor_instruments: probe_segments`
  （6.2.1 的分段自动探测：按 60s 切段各探一次，取**并集**作全局硬约束）+ `auto_bpm: true`，
  并且上游已经把 `timbre_stabilize` 整个移除了（预设/引擎/界面都没有这个键）。
  **本次不动这块**：只把 prelude 这项回退，避免一次改两个变量导致归因不清。
- 若装完仍觉得"音符少了"，下一个可调旋钮是「乐器组 → 不限定」（`none`）：
  硬约束会关掉探测没听到的长尾乐器。
- `_segmented_events()`（逐段推理）存在于引擎里，但 `_seg_plan` 从未被赋值，
  等价于死代码 —— 实际走的仍是整曲一次推理，本次没动它。
- 上游在 6.3.1 的界面侧加了两个**事后**工具：转录结构体检（音符/轨数/长音/最大同时发声）
  与「长音修复」（>15s 一键截断并写回）。它们治的是僵尸长音的**结果**，不是成因；
  prelude 恢复后长音应当显著变少，这个按钮继续留作兜底。
- tag 谱系要认 **cnb**：cnb 的 `v6.3.1` / `v6.4.2` 都指向 `51ca26d`；而 GitHub 侧
  （`origin` = qdTXTbp）的 `v6.4.2` 指向 `103f00f`，是**另一条不含 6.3.1 引擎改动的线**。
  用 `git ls-remote --tags cnb` 核对，别用本地旧 tag 判断版本。

## 6. 回退开关

- 界面：高级参数 →「跨块延音（模型续接）」取消勾选 = 旧的 `prelude_forcing=False` + 缝合。
- 参数：`prelude_forcing: false`；想回到"硬约束乐器组"就设 `muscriptor_instruments: probe`
  / `probe_segments`。

## 7. 与「最初加入 MuScriptor 支持」那版的逐项对比

首版是 `4d82a82`（2026-08-27，v3.1.1，98 行），核心只有一行推理调用：

```python
data = model.transcribe_to_midi(audio_path)   # 上游默认：单遍推理、prelude_forcing=True
```

| 版本（日期） | 引擎行数 | 默认推理路径 | 预处理 | 后处理 |
|---|---:|---|---|---|
| v3.1.1（08-28） | 98 | `transcribe_to_midi(原始音频)`，prelude **开** | 无 | 无 |
| v4.0.0 / **v4.3.0**（09-12/09-18） | 285 | 解码成 16k wav → `transcribe(wav)`（`muscriptor_batch=0` → prelude **开**） | 无 | 无（仅节拍网格可选） |
| v5.0.0-beta.4（10-07） | 363 | 同上 + `instruments=constrain`（默认「不限定」= 无约束） | 无 | 无 |
| v6.0.0（10-18） | 1355 | **prelude 硬编码 False** + 跨块缝合 | audio_chain（电平归一） | 证据收尾 + 缝合 |
| v6.2.6（10-24） | 1585 | 同上 | 同上 | + `probe` 硬约束 + `timbre_stabilize` |
| v6.3.1（10-30） | 1755 | 同上 | 同上 | `probe_segments` 并集硬约束，`timbre_stabilize` 移除 |

三处关键差异（按影响排序）：

1. **prelude_forcing：开 → 关**。首版和 4.3.0 都让它保持上游默认（开）。唯一"必须关"的场景是
   `batch_size>1` 的批量推理，而批量推理在 `bca0a55`（2026-10-12，`refactor(muscriptor):
   取消「批量推理」功能 —— 实测是纯损失`）就已经删掉了 —— 6 天后 `c7f6fc9`（5.2.4）却仍然把
   prelude 硬编码成 False。**关掉它的理由已经不存在，代价（换乐器组 1→16、音符 -22%）还在。**
2. **乐器组硬约束：无 → 有（probe / probe_segments）**。首版和 4.3.0 完全不限乐器组。
   5.0.0-beta.4 起加了 `instruments=` 通道但默认「不限定」；6.2.6 / 6.3.1 把它变成默认
   （整曲探测 / 60s 分段探测取并集），探测没听到的乐器整首都不会出现。
3. **预处理与后处理全是"补丁"**。audio_chain（电平归一；降噪默认关）、证据收尾、跨块缝合、
   timbre_stabilize 都不能让解码更准，只是修修补补：缝合是专为 prelude 关掉补连续性，
   timbre_stabilize 是专为"每 5 秒换音色"搬音符。首版一个都没有，照样是用户认定的稳定版。

结论：**回到 4.3.x 的解码行为（prelude 开、不硬约束乐器组），比堆后处理更接近"首版的效果"**。
本次只回退了 prelude（第 1 项）；第 2 项（乐器组默认）建议在有 MuScriptor 权重时跑一次
A/B 再定 —— 6.3.1 上游刚把它改回 `probe_segments`，不宜同时改。

