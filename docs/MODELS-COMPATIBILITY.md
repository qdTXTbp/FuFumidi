# 现有模型兼容矩阵（硬约束 R-014）

> 背景：2026-11-04 用户决定**不执行**「Rust/ONNX 替换 Python 引擎」（[ADR-0001](../decisions/ADR-0001-cancel-python-engine-replacement.md)），
> 并要求「注意让现有的模型都能使用」。本文件把这句话落成可检查的约束。

## 1. 冻结规则（任何改动前先读）

1. **模型格式不改**：不把 `.pth/.ckpt/.safetensors/.th/.onnx` 换成别的格式；
2. **模型 ID / 路径不改**：`main/models.js` 的 id、安装目录布局、`resources/models` 结构保持；
3. **下载源不改**：模型下载仍走 `main/fast-download.js` 与现有 registry（HF/ModelScope/自有源）；
4. **Python 引擎随包保留**：`resources/python`、torch/onnxruntime 依赖不删除；
5. 任何触碰上述内容的改动必须：更新本文件 → 跑 `models-catalog` + 真实转录回归 → 装机冒烟。

## 2. 模型家族与运行时（全部保留）

| 家族 | 代表 ID | 文件格式 | 运行时 | 必须可用 |
|---|---|---|---|---|
| 通用转录 | basic_pitch | ONNX（`nmp.onnx` / int8） | onnxruntime | ✅ |
| 通用转录 | muscriptor_small/medium/large | safetensors | torch | ✅ |
| 通用转录 | yourmt3 | .ckpt | torch（自带 site） | ✅ |
| 通用转录 | miros | .ckpt + pretrained_msd.pt | torch（自带 site） | ✅ |
| 钢琴 | piano_transcription / aria / transkun / hft_transformer | .pth / safetensors / pip 权重 / .pkl | torch | ✅ |
| 节拍 | beat_this | .ckpt | torch | ✅ |
| 音色标签 | audio_tagger | ONNX int8 | onnxruntime | ✅ |
| 人声分离 | separation（29 项，含 htdemucs/6stems 等） | .th/.ckpt/.yaml | torch/pymss | ✅ |
| 歌声合成 | DiffSinger 声库（4×ONNX） | ONNX | onnxruntime | ✅ |
| 翻唱 | RVC 主体 + rmvpe（ONNX） | .pth + .onnx | torch + ort | ✅ |
| OMR | Audiveris（Java sidecar） | Java 运行时 + tessdata | Java | ✅ |

## 3. 自动检查

```bash
# 模型注册表完整性（不要求本地已下载，只要求条目/家族/字段都在）
node scripts/e2e/run.mjs models-catalog

# 真实推理回归（Basic Pitch，2 秒音频两首，走真实引擎进程）
node scripts/e2e/run.mjs transcribe-queue-chain transcribe-stem-ui

# 全量
node scripts/e2e/run.mjs
```

`models-catalog` 断言：条目数 ≥80、家族齐全（basic/piano/hft/miros/yourmt3/muscriptor/beat_this/audio_tagger/aria/separation）、
分离模型 ≥20、demucs ≥1、id 唯一、每条都有 id/kind/name。

## 4. 变更记录

| 日期 | 变更 | 验证 |
|---|---|---|
| 2026-11-04 | 建立兼容矩阵；确认取消 Python 引擎替换后模型注册表 91 条未动 | 全量 E2E 33/33；models-catalog 通过 |
