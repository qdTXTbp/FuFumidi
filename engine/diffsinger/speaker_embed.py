# -*- coding: utf-8 -*-
"""多说话人嵌入 —— 照搬上游 `DiffSingerSpeakerEmbedManager.cs`（143 行）。

## 为什么是"嵌入文件"而不是"说话人序号"

上游（`DiffSingerBasePhonemizer.cs:463`）喂给 ONNX 的输入名是 **`spk_embed`**，是
**浮点嵌入张量**，不是说话人 id。所以多说话人支持 = 读一堆 `.emb` 文件 + 按音素/帧
组装嵌入矩阵。三个事实（全部来自上游源码，不是推断）：

| 事实 | 证据 |
|---|---|
| `speakers:` 是**嵌入文件基名**（不含 `.emb`，可带子目录） | `DiffSingerConfig.cs:29` |
| `.emb` = 裸 float32 × `hiddenSize`，**无文件头** | `DiffSingerSpeakerEmbedManager.cs:26-30` |
| 张量形状 `[1, T, hiddenSize]`，逐音素或逐帧 | 同上 `:96-98` / `:137-139` |

`hiddenSize` 在 `dsconfig.yaml` 里，上游默认 **256**（`DiffSingerConfig.cs:32`）。

## 两个构造器

* `embeds_by_phone(names)` —— 每个音素一个说话人 → one-hot 曲线 × 嵌入。duration 模型用。
* `embeds_by_frame(...)` —— 逐帧；默认说话人来自音素段，声部颜色曲线（`vc1`/`vc2`）
  按 `× 0.01` 采进对应列，再逐帧归一化（和 > 1 就除以和，否则把差额补给默认说话人）。
  variance / pitch / acoustic 用。

★ 段切分与曲线采样不在这里做 —— 它们在我们的管线里已有实现（`PaddedSegments` /
  `SampleCurve` 的等价物），这里只做上游那两个构造器**真正独有**的部分：曲线矩阵与嵌入相乘。
"""

from typing import Dict, List, Sequence

import numpy as np

DEFAULT_HIDDEN_SIZE = 256   # 上游 DiffSingerConfig.cs:32


class SpeakerEmbedError(Exception):
    pass


def load_speaker_embed(root: str, name: str, hidden_size: int) -> np.ndarray:
    """读一个 `.emb`：裸 float32 × hidden_size，无文件头（上游 :26-30）。"""
    import os
    path = os.path.join(root, name + ".emb")
    if not os.path.isfile(path):
        raise SpeakerEmbedError("缺少说话人嵌入文件：%s" % path)
    with open(path, "rb") as f:
        buf = f.read()
    want = int(hidden_size) * 4
    if len(buf) < want:
        raise SpeakerEmbedError(
            "说话人嵌入 %s 长度不足：需要 %d 字节（hiddenSize=%d），实际 %d"
            % (path, want, hidden_size, len(buf)))
    return np.frombuffer(buf[:want], dtype="<f4").astype(np.float32)


def speakers_matrix(root: str, speakers: Sequence[str], hidden_size: int) -> np.ndarray:
    """所有说话人的嵌入矩阵，形状 `[hiddenSize, nSpeakers]`（上游 :36-49 的列布局）。"""
    cols = [load_speaker_embed(root, s, hidden_size) for s in speakers]
    return np.stack(cols, axis=1).astype(np.float32)


def speaker_index_by_suffix(speakers: Sequence[str], suffix: str) -> int:
    """名字 → 下标（上游 :61-83）。

    先精确匹配；再按**路径段后缀**匹配（`a/b/c` 能被 `c` 命中）；
    最后回退到第一个说话人（上游只记一条 warning，不抛）。
    """
    if not speakers:
        raise SpeakerEmbedError("声库声明了 spk_embed 但 dsconfig.yaml 的 speakers 为空")
    if suffix in speakers:
        return list(speakers).index(suffix)
    sf = [p for p in str(suffix).replace("\\", "/").split("/") if p]
    for i, s in enumerate(speakers):
        sp = [p for p in str(s).replace("\\", "/").split("/") if p]
        if sf and len(sf) <= len(sp) and sp[len(sp) - len(sf):] == sf:
            return i
    return 0        # 上游：回退第一个（并记 warning）


def _onehot_curves(indices: Sequence[int], n_speakers: int) -> np.ndarray:
    t = len(indices)
    curves = np.zeros((t, n_speakers), dtype=np.float32)
    for i, k in enumerate(indices):
        curves[i, int(k)] = 1.0
    return curves


def embeds_by_phone(speakers: Sequence[str], hidden_size: int, names: Sequence[str],
                    embeds: np.ndarray) -> np.ndarray:
    """逐音素嵌入，返回 `[1, T, hiddenSize]`（上游 :86-100）。"""
    idx = [speaker_index_by_suffix(speakers, n) for n in names]
    curves = _onehot_curves(idx, len(speakers))          # [T, nSpk]
    out = curves.dot(embeds.T)                            # [T, hidden]
    return out.reshape(1, out.shape[0], int(hidden_size)).astype(np.float32)


def embeds_by_frame(speakers: Sequence[str], hidden_size: int, total_frames: int,
                    default_spk_by_frame: Sequence[int],
                    curve_sums_by_spk: Dict[int, np.ndarray],
                    embeds: np.ndarray) -> np.ndarray:
    """逐帧嵌入，返回 `[1, totalFrames, hiddenSize]`（上游 :103-140）。

    `curve_sums_by_spk`：说话人下标 → 该说话人声部颜色曲线的**逐帧采样值**（未乘 0.01，
    由调用方用管线里已有的 SampleCurve 等价物采好；上游是在这里 `x * 0.01`）。
    """
    n = len(speakers)
    curves = np.zeros((int(total_frames), n), dtype=np.float32)
    for spk_id, vals in (curve_sums_by_spk or {}).items():
        v = np.asarray(vals, dtype=np.float32)[:int(total_frames)] * 0.01
        curves[:len(v), int(spk_id)] += v
    for fid in range(int(total_frames)):
        s = float(curves[fid].sum())
        if s > 1.0:
            curves[fid] /= s
        else:
            curves[fid, int(default_spk_by_frame[fid])] += 1.0 - s
    out = curves.dot(embeds.T)
    return out.reshape(1, out.shape[0], int(hidden_size)).astype(np.float32)
