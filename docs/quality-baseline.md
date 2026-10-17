# 质量基准（P1-3）

> 目的：任何改动都不能悄悄降低「转录/导出」的质量。数字门禁跑在**确定性合成样本**上，
> 不依赖外部版权曲库或 GPU 模型；真实模型产出后用同一套指标补记基线。

## 怎么跑

```bash
# 1) 门禁（默认：6 个合成用例的自检基线，低于基线 -2% 直接失败）
npm run test:quality

# 2) 重新记录基线（只在确认指标口径变化时用）
node scripts/eval-quality.mjs --update-baseline

# 3) 真实转录模型产出评估：把每个用例的预测写成 caseN.mid 放同一目录
node scripts/eval-quality.mjs --pred-dir path/to/predicted-midi
#   → 结果写 docs/quality-last-run.json（不进基线；人工确认后再决定是否记录）
```

Python 侧需要 `mido` + `numpy`（内置运行时已带；也可用 `FUFUMIDI_PYTHON` 指定解释器）。

## 指标口径（与 v6 计划 P1-3 对齐）

| 指标 | 定义 | 容差 |
|---|---|---|
| note F1 | 音高一致 + 起点误差 ≤ 50ms，贪心一对一匹配 | onset ±50ms |
| onset F1 | 唯一化 onset 时间集合的匹配 | ±50ms |
| pedal F1 | CC64 踏板区间（>64 踩下）起止匹配 | 起点 ±50ms / 终点 ±100ms |

音频侧只做基本校验（时长/峰值/RMS）；音色/听感不进数字门禁。

## 6 个确定性用例

`engine/eval_quality.py` 用同一份参数化音符表**同时生成真值 MIDI 与测试 WAV**，因此真值精确、
无版权问题、任何机器上可复现（`engine/tests/quality/` 为生成物，已 gitignore）：

| 用例 | 内容 | 音符 | 踏板 |
|---|---|---|---|
| case1_melody | C 大调音阶单旋律 | 8 | — |
| case2_chords | C–F–G–C 三和弦 | 12 | — |
| case3_fast | 32 个 16 分音符快速音阶 | 32 | — |
| case4_pedal | 两小节和弦 + CC64 延音 | 6 | 1 段 |
| case5_wide | C2–C6 宽音域 | 10 | — |
| case6_dynamics | 强弱交替 + 休止 | 9 | — |

## 基线（`docs/quality-baseline.json`）

- **identity**（预测=真值）：note/onset/pedal F1 必须 = **1.0** —— 这是指标实现的硬约束；
- **perturbed**（固定 seed 的扰动：15% 漏检 / 15% 起点偏出容差 / 10% 升半音 / 10% 假阳性）：
  记录 note/onset F1 作为「指标真的在算东西」的体检值（例如 case3_fast noteF1 ≈ 0.58、onsetF1 ≈ 0.80）；
- 门禁：所有值不得低于基线 **−2%**；identity 天然必须 ≥0.98。

> 真实模型（MuScriptor 等）的 note F1 基线等有 GPU 的机器跑 `--pred-dir` 后再补一节，
> 并把那次结果作为新基线（默认基线保持合成样本，避免小机器无法复现）。
