# vendor：RVC 推理代码（上游原样搬运，MIT）

- **来源**：<https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI>
- **取的版本**：`main` @ `81eed5e8f68b6bed1789f682fe78cdd324495afc`（2026-08-04）
- **许可**：MIT（见同目录 `LICENSE.upstream`，Copyright (c) 2023 liujing04）
- **搬运目的**：翻唱的「变声」这一步要用 RVC 模型推理；**照搬上游**而不是自研，
  同一个权重在别处能唱、在这里也能唱（版本判定、`config[-3]` 回填、fp16 开关这些
  细节一旦自己写就会出现「同样的模型出电音」）。

## ★ 一行都没有改

下面是上游文件的**原样副本**，结构保持 `infer/` 与 `tools/` 两个包，
因为它们之间的 import 是绝对路径（`from infer.module import …`、`from tools.cuda_graph import …`）——
保持目录结构就是保持代码原样的前提。

| 文件 | 作用 |
|---|---|
| `infer/module/models.py` | 合成器（Ms256 / Ms768 及其 nono 版） |
| `infer/module/modules.py`、`commons.py`、`attentions.py`、`transforms.py` | 模型构件 |
| `infer/vc/pipeline.py` | **推理主链路**：f0 → HuBERT 特征 → faiss 检索 → 合成 → RMS 配平 |
| `infer/vc/utils.py` | 索引文件查找 / HuBERT 加载 |
| `infer/hubert.py` | HuBERT/ContentVec（**transformers 版**，不依赖 fairseq） |
| `infer/rmvpe.py` | rmvpe f0 提取器 |
| `tools/cuda_graph.py` | CUDA graph 包装（pipeline 与 hubert 都调它） |

## 没搬的，以及为什么

| 上游文件 | 不搬的原因 |
|---|---|
| `infer/audio.py` | 依赖 `ffmpeg` + `av`(PyAV)；我们用 `soundfile` 做 IO（引擎里已有） |
| `infer/vc/modules.py` | 和 WebUI（gradio / i18n / 说话人下拉）耦合；它的**加载逻辑**由 `svc/rvc.py` 逐行照搬 |
| `infer/fcpe.py`、`rtrvc.py`、`cli.py` | 额外依赖（torchfcpe）/ 实时链路 / CLI，翻唱用不到 |
| `configs/config.py` | 与 WebUI 参数耦合；其中**推理真正用到的字段**在 `svc/rvc.py::Config` 里按同样取值复刻 |

## 依赖（装在 `kind=svc` 加速包里，不进本体）

`torch`、`transformers`（HuBERT）、`faiss`（index 检索）、`librosa`、`scipy`、
`soundfile`、`numpy`；选 `pm` 做 f0 时还要 `parselmouth`。

## 权重（不是代码，不入库）

- `assets/hubert_base/` —— HuBERT/ContentVec（公共编码器，随加速包装）；
  上游把它写死在 `<vendor>/assets/hubert_base`，装到别处时用环境变量
  `FUFUMIDI_SVC_HUBERT` 指向（**只改指向，不改上游代码**）。
- `rmvpe.pt` —— 上游 `Pipeline.get_f0` 读环境变量 `rmvpe_root`；
  我们在调用前把它指到 `FUFUMIDI_SVC_RMVPE`（或包内 `assets/`）。
- 角色权重（`.pth` + `.index`）由**用户导入**，不在这里。

> 改这里任何一行前先想清楚：漂移一次，用户手里的模型就可能从「能唱」变成「电音」。
> 要跟上游同步时，重新取 `main` 的 tarball，替换对应文件，并更新本文件顶部的 commit sha
> 与 `docs/VENDOR.md`。
