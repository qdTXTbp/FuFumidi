# MuScriptor 预设 A/B（音色稳定 vs 最优）

> 2026-10-18 · 目的：为「前后音色变化」问题固化默认，符合用户要求「所有预设先跑 A/B（速度/峰值显存/边界重复音/音色切换次数/F1）再固化默认」。

## 对比对象

- `optimal` = `MuScriptor · 最优`：`muscriptor_instruments=none`、`segment_sec=5`、`prelude_forcing=true`、`timbre_stabilize=false`。
- `probe_only` = 仅预分析锁定乐器组：`muscriptor_instruments=probe`，其余同 optimal。
- `stable` = `MuScriptor · 音色稳定`：probe 锁定 + `timbre_stabilize=true` + 5s + 缝合。

## 素材与方法

- 素材 A（合成）：30s 立体的双音色素材（钢琴和弦 + 弦乐旋律 + 鼓脉冲同时发声），参考 MIDI 由合成器直接给出；用于**相对比较**。
- 素材 B（钢琴）：`engine/tests/quality/case1_melody.wav` + 其参考 MIDI（单音色，边界/速度对照）。
- 模型：MuScriptor **medium**；GPU：RTX 5070 Ti Laptop（CUDA 12.8 增强包）；每配置跑 **2 次取第 2 次**（消除首次模型加载偏差）。
- 指标：耗时、峰值显存（`torch.cuda.max_memory_allocated`）、边界 ±0.35s 同音高重复起音数、相邻同音高跨轨/重叠的换轨次数、音高+起点 F1（±50ms，`engine/eval_quality.py`）。

## 结果

### 素材 A：合成双音色（30s）

| 配置 | 音符数 | 轨数 | 耗时 s | 峰值显存 MB | 边界重复音 | 音色切换 | F1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| optimal（最优） | 112 | 3 | 2.23 | 3703 | 0 | **5** | 0.4914 |
| probe_only（仅锁定） | 101 | 1 | 3.41 | 3703 | 0 | **0** | **0.7692** |
| stable（音色稳定） | 101 | 1 | 3.29 | 3703 | 0 | **0** | **0.7692** |

### 素材 B：钢琴 fixture（单音色）

| 配置 | 音符数 | 轨数 | 耗时 s | 峰值显存 MB | 边界重复音 | 音色切换 | F1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| optimal（最优） | 7 | 1 | 0.96 | 2352 | 0 | 0 | 0.9333 |
| probe_only（仅锁定） | 7 | 1 | 1.35 | 2352 | 0 | 0 | 0.9333 |
| stable（音色稳定） | 7 | 1 | 1.21 | 2352 | 0 | 0 | 0.9333 |

## 结论与固化

- 双音色素材：音色稳定把**换音色证据 5 → 0**、**F1 0.4914 → 0.7692**，峰值显存不变；代价是约 +1s（预分析 + 稳定性后处理）——质量收益明显大于耗时。
- 钢琴素材：F1/显存持平，多约 0.2–0.4s 预分析；没有质量退化。
- 因此把 MuScriptor 三规格的**默认预设固化为「MuScriptor · 音色稳定」**（`MODEL_DEFAULT_PRESET` + 前端 WEB 兜底同步）。
- 用户仍可手动切回「MuScriptor · 最优」（不预分析、不硬约束、不后处理）；A/B 脚本可复跑：

```powershell
python engine/bench_presets.py --material synth --model-size medium --repeat 2 --md ab.md
python engine/bench_presets.py --material piano --model-size medium --repeat 2 --md ab.md
```

## 限制（必须知道）

- 合成素材的 F1 只用于相对比较，不能当公开数据集指标；真实多乐器素材仍建议用户自测。
- `probe` 是对**整曲代表段**的硬约束：若前 3 段探测漏了后面才出现的乐器，可能把长尾乐器关掉；「最优」预设保留模型自由判定。
- 音色稳定后处理只处理「短命孤立乐器轨」，不会强行把正常的多乐器编曲抹成单轨。
