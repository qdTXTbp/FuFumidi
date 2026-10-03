# 自动转 C 大调

识别 MIDI 调性并转到 C 大调（也支持转到其他调）。

## 为什么不用「直接加减半音」

朴素的移调做法是给每个音符加减同一个半音数，转出来的东西**音名拼写是错的**。
例如 F# 大调整体降 6 半音听起来是 C 大调，但记谱上每个 F# 都还在该记 F# 的位置，
在 UTAU / Vocaloid 这类按音名绑音素的工作流里会直接唱错。

本插件走**自然音级映射**：先识别源调的调式音阶，把「第几级」映射到目标调的同一级。
所以 F# 大调转 C 大调后，记谱结果是 Gb 大调 —— 听起来一样，音名是对的。

## 用法

在插件面板里：

1. 点击选择区，挑一个 `.mid` / `.midi` 文件
2. 插件自动识别调性，显示置信度和其他候选
3. 选目标调（默认 C 大调），点「转到 C 大调」
4. 结果写入**同目录的新文件**（原文件加 `_C` 后缀），原文件不动
5. 转完自动复检一次，直接看到结果调性

## 命令

也可以从别的插件或渲染层脚本直接调用：

```js
await fuBridge.plugins.invoke('auto-key-cmajor', 'analyze',    { input: 'D:/song.mid' })
await fuBridge.plugins.invoke('auto-key-cmajor', 'toCMajor',  { input: 'D:/song.mid' })
await fuBridge.plugins.invoke('auto-key-cmajor', 'transpose', { input: 'D:/song.mid', target: 'G', mode: 'diatonic' })
```

| 命令 | 参数 | 返回 |
| :-- | :-- | :-- |
| `analyze` | `{ input }` | `{ key, tonic, mode, sharps, confidence, alternatives, notes, tracks, durationSec }` |
| `toCMajor` | `{ input, output? }` | 识别 + 转 C 大调，一步完成 |
| `transpose` | `{ input, output?, target?, mode? }` | `mode` 为 `diatonic`（默认，音级映射）或 `pitch`（纯半音） |
| `scriptPath` | — | 插件自带 Python 脚本的绝对路径 |

失败时统一返回 `{ ok: false, error: '原因' }`，不会抛异常。

## 实现要点

**识别**：Krumhansl-Schmuckler 音级轮廓相关法。音级分布按时值加权，
长音（旋律骨架里的主音）比快速经过音权重高；极短的音做 0.05s 下限截断，
避免打击乐噪点带偏结果。

**移调**：源调音阶的每个音级映射到目标调同音级。源调外的半音（变化音、经过音）
映射到目标调中最近的音级。确定目标音高类后，逐个音符选择最接近原音高的八度，
避免整首歌无端升/降八度。最后夹在 0-127，越界数量会在返回值里报告。

**沙箱**：插件跑在 vm 沙箱里，没有 `fs` / `child_process`，读不了也写不了文件。
所以分工是：渲染层用 `fuBridge.pickFile()` 拿到真实路径 → 主进程编排参数 →
`ctx.engine.run` 跑自带的 `key_tools.py`（`script` 参数支持绝对路径）。
计算全部发生在引擎 Python 进程里，文件不出本机。

## 依赖

只用到引擎环境里已有的 `pretty_midi` 和 `numpy`，不引入新依赖。

## 已知限制

- 输出文件**不写入调号标记**。`pretty_midi` 写文件时不输出 key signature meta，
  DAW 打开会按音高自行推断，通常无碍；但如果你需要文件里带明确的调号，
  导出后需要在 DAW 里确认一次。
- 打击乐轨（channel 10）不参与调性识别，但**会被一起移调**。
  如果鼓组不该跟着走，请先在 DAW 里分离。
- 小调按**自然小调**处理，不用和声小调 / 旋律小调。
  这在流行与录音室语境下通常是想要的；若你的曲子用了 Db 大三和弦这类
  和声小调特征音，转 C 大调后它会变成 C 大三和弦。
