# FuFumidi × OpenUTAU 照搬移植：进度与计划

> 上游：`OpenUtau/`（C#）—— `OpenUtau.Core` + `OpenUtau.Plugin.Builtin` + `cpp/worldline`
> 落点：`engine/singing/`（纯 Python，**不依赖 torch / numpy**，可脱离主程序单测）
> 方针：**除外观外不允许自研** —— 每一处都应能回答"对应 OpenUTAU 的哪个文件/函数"
> 最后更新：2026-10-01（提交 `039419c`）

---

## 0. 一句话现状

**引擎的"纯逻辑层"基本搬完，链路是断的。** 音素化（歌词→音素）与乐句构建（音素→渲染输入）
两头都通了，但中间缺 `Pipeline/PhraseBuilder` 与 `PhraseSource.FromPart`；
渲染器的"参数层"（`ResamplerItem`）通了，"执行层"（resampler/wavtool）还差外部工具进程。

已完成规模：Python **5,954 行**，对应 C# **7,342 行**（逐文件实测 `wc -l`）；
一致性测试 **2,497 行 / 471 项断言**。

---

## 1. 方针（不可协商的三条）

1. **逐文件对齐 C# 的文件边界**，不做"更合理"的合并或拆分。
   `Core/Classic/` → `openutau/classic/`，`Plugin.Builtin` → `openutau/plugin_builtin/`。
2. **上游的怪癖照搬并记录，不"顺手修好"**。死代码、重复赋值、大小写不一致的比较，
   都在 docstring 里写明"这是上游既有行为；改成正确行为属于行为变更，应单独立项"。
3. **"照搬"由机器强制，不靠自觉**。每个模块配"源码一致性测试"，
   直接从 C# 源文件解析出常量/枚举/写入顺序与 Python 侧逐项比对。

---

## 2. 进度总览

| 子系统 | 上游体量 | 状态 |
|---|---|---|
| `.ustx` 工程格式（读写） | ~2,000 行 | ✅ 完成 |
| 乐句渲染输入（`RenderPhrase` / 3 类） | 663 行 | ✅ 完成 |
| 渲染器接口与注册表 | 146 + 141 行 | ✅ 完成（具体渲染器未搬） |
| Worldline 纯逻辑 | 780 行中约 400 | ✅ 完成（原生边界另计） |
| 音素化器基类 / 中文基类 | 250 + 51 行 | ✅ 完成 |
| 内置音素化器 | 51 个文件 / 25,707 行 | 🟡 **3 / 51** |
| Classic 参数层 | 188 + 57 行 | ✅ 完成 |
| Classic 执行层（外部工具进程） | ~1,300 行 | ❌ 未开始 |
| Pipeline（乐句切分 / 快照） | 988 行 | ❌ **未开始（关键缺口）** |
| G2p（字素→音素） | 771 行 + 数据 | ❌ 未开始 |
| 编辑器侧 | — | ❌ 未开始（M3） |

---

## 3. 已完成清单（文件级对照）

| Python | C# |
|---|---|
| `ustx/model.py` | `Ustx/UProject.cs` `UTrack.cs` `UPart.cs` `UNote.cs` `UExpression.cs` `UCurve.cs` `UMaskedCurve.cs` `UMixFx.cs` `UPhoneme.cs` |
| `ustx/io.py` | `Util/Yaml.cs`（`UnderscoredNamingConvention` / `OmitNull`） |
| `ustx/format.py` | `Format/Ustx.cs` |
| `openutau/music_math.py` | `Util/MusicMath.cs`（全文件） |
| `openutau/spline.py` | `Util/SplineInterpolate.cs` |
| `openutau/oto.py` | `Ustx/USinger.cs` 的 `UOto` 部分 + `Classic/VoiceBank.cs` |
| `openutau/singer.py` | `Ustx/USinger.cs`（基类与 `SingerTypeUtils`） |
| `openutau/phoneme.py` | `Ustx/UPhoneme.cs` |
| `openutau/phonemizer.py` | `Api/Phonemizer.cs` |
| `openutau/timeaxis.py` | `Ustx/TimeAxis.cs` |
| `openutau/renderer.py` | `Render/IRenderer.cs` |
| `openutau/renderers.py` | `Render/Renderers.cs` |
| `openutau/phrase_layout.py` | `Render/PhraseLayout.cs` |
| `openutau/render_phrase.py` | `Render/RenderPhrase.cs`（3 个类） |
| `openutau/worldline.py` | `Render/Worldline.cs` 的**纯逻辑部分** + 10 个导出的 ctypes 绑定 |
| `openutau/pipeline_source.py` | `Pipeline/PhraseSource.cs`（5 个数据类 + `Evaluate`/`Sample`） |
| `openutau/pipeline_identities.py` | `Pipeline/Identities.cs` |
| `openutau/binary_writer.py` | `System.IO.BinaryWriter`（缓存键字节布局复刻） |
| `openutau/xxhash.py` | `K4os.Hash.xxHash.XXH32` / `XXH64` |
| `openutau/classic/resampler_item.py` | `Classic/ResamplerItem.cs` |
| `openutau/classic/ini.py` | `Classic/Ini.cs` |
| `openutau/base_chinese.py` | `BaseChinesePhonemizer.cs` |
| `openutau/plugin_builtin/japanese_vcv.py` | `Plugin.Builtin/JapaneseVCVPhonemizer.cs` |
| `openutau/plugin_builtin/chinese_vcv.py` | `Plugin.Builtin/ChineseVCVPhonemizer.cs` |
| `openutau/plugin_builtin/chinese_cvvc.py` | `Plugin.Builtin/ChineseCVVCPhonemizer.cs` |

每个模块的 `__init__.py` 里维护着一份"已照搬 / 未照搬"清单，与上表同步。

---

## 4. 验证方式

```bash
cd engine/tests
python test_ustx_schema_matches_source.py        # 19 passed
python test_ustx_roundtrip.py                    # 59 passed
python test_openutau_core_matches_source.py      # 393 passed
python test_singing_adapters.py                  # 19 passed / 1 skipped
```

参考源码缺失时自动 SKIP（`OPENUTAU_REF` 环境变量可指定路径），整套测试**可离线运行**。

---

## 5. 方法：源码一致性测试

核心手段 —— **把"照搬"写成可执行断言**。三种模式：

**① 常量 / 枚举表**
```python
want = dict(re.findall(r'public const string (\w+) = "([^"]*)";', cs))
got  = {k: v for k, v in vars(Ustx).items() if k.isupper() and isinstance(v, str)}
assert want == got
```
枚举注意：**最后一枚枚值后面没有逗号**（`(\w+)\s*,?\s*$`），名字大小写要归一。

**② 字节布局的写入顺序**（哈希 / 序列化 —— 最容易漏、后果最严重）
```python
# C#: re.findall(r'writer\.Write\((.+?)\);', body)
# 我们: 逐行 re.match(r"\s*w\.write_\w+\((.*)\)\s*$", line)   ← 容许嵌套括号
assert [_norm(x) for x in cs_writes] == [_norm(x) for x in py_writes]
```
> 推论：Python 侧要**统一用一个 `w.write_xxx(...)` 风格的 writer**。
> 为省事写 `w_str()` / `w_int()` 局部辅助会让这种校验抓不到 ——
> 本项目里就是因此把 `BinaryWriter` 的复刻抽成了共享模块。

**③ 关键算式 / 常量的存在性**——直接把上游源码串写进断言：
```python
assert 'Math.Pow(2, 1.0 - velocity * 0.01)' in cs
assert '(i + 1) == phrase.dynamics.Length' in cs
```
便宜、稳定，而且**写断言的过程本身就是复查**。

---

## 6. ★ C# → Python 语义陷阱清单

| # | 陷阱 | 后果 | 对策 |
|---|---|---|---|
| 1 | **`struct` → 类** | `ToList()/ToArray()/MemberwiseClone()` 后改元素：C# 改副本、**Python 污染原对象**。对象被重复使用时症状累加、不可复现 | 逐元素**新建**（`Vector2(p.x, p.y)`），并断言"原对象未被改动" |
| 2 | **`?? default` 在 struct 上** | 不是 null 而是"字段全空实例"。当成 null 处理会让最常见的"没传可选参数"崩掉 | 用"全默认值"实例，别用 `None` |
| 3 | **`Convert.ToInt32(double)`** | **四舍六入五成双**，不是截断；`.5` 附近差 1 | `int(round(x))`，**别写 `int(x)`** |
| 4 | **`(int)` 与整数除法** | C# 整数除法**向零截断**，Python `//` 向下取整（负数不同） | `idiv(a, b)` 辅助 |
| 5 | **`double / 0`** | C# 得 ±Inf/NaN 继续算，Python 抛 `ZeroDivisionError` | `fdiv(a, b)` 返回 inf/nan |
| 6 | **`(float)` 转换** | C# 在该步舍到 float32；Python 全 double | 显式 `struct.unpack('<f', struct.pack('<f', v))[0]` |
| 7 | **`float[]` 逐步累加** | C# 每步都舍到 float32 | 接受 ~1e-7 偏差并**写进 docstring**，或整体用 numpy.float32；**别默默忽略** |
| 8 | **`str(obj)`** | Python 默认带**内存地址** → 进哈希则"每次重建对象哈希都变"、缓存永不命中 | 基类显式 `__str__` 返回类型名（对齐 C# 默认 `Object.ToString()`） |
| 9 | **`Array.BinarySearch`** | 未命中时用**插入点** `~idx`，只在 `(0, len)` 内插值 | `bisect.bisect_left` + 命中判定 |
| 10 | **`if (TryX(out v)) return ...;`** | 可能是"**命中**即返回（未命中继续往下）"，也可能"一律返回" | 逐字读清楚 —— 同一项目里两种语义**确实同时存在**（`phoneticHint` 的处理在 JA VCV 与 ZH VCV 恰好相反） |
| 11 | **`Math.Round`** | 与 Python `round()` 同为 banker's rounding | ✅ 这条**不用担心** |

### 附：写测试时的最大陷阱 —— 凭直觉填期望

**症状**：连续出现"实现正确、测试期望错误"。本项目一轮内错了 7 处
（权重、增益、长度、夹紧方向、分帧插值…）。

**规律**：凡"看起来像常数"的值（weight / gain / 阈值 / 长度）**几乎都是公式值**。

**对策**：把 **C# 的公式抄进测试里算期望**：
```python
# ❌ 错：expect = 1.3
# ✅ 对：
w_hi = 1.0 / (1.0 + math.exp(-5.0))
expect = math.pow(0.5 / (0.5 * w_hi + 1.0 * (1 - w_hi)), 0.86)
```
另外**先确认测试输入是现实的**：上游 `PhonemeSource.Velocity = vel * 0.01f` 是**归一化**值，
测试里传 `100.0` 会得到 `2^-99`，整条分支直接塌掉。

> 完整方法论另见 Skill：`~/.workbuddy/skills/csharp-to-python-conformance-port/`

---

## 7. 关键决策记录

| 议题 | 决定 | 理由 |
|---|---|---|
| **Worldline 的原生库** | 分两步：纯逻辑已搬 + `WorldlineNative`（ctypes）为**可选**后端 | `Worldline.cs` 380 行是 `DllImport`，真 DSP 在 `cpp/worldline/` 的 1,534 行 C++ 里（Bazel + vendor 的 WORLD）。把 1,534 行 C++ 重写成 Python 等于**自研 WORLD 声码器**，违背方针且性能差。选 ctypes 绑官方 `worldline.dll` |
| **汉字→拼音** | 用 `pypinyin` 替代 NuGet `csharp-pinyin` | 已实测无声调输出一致，含 `ü` 写法（`nv/lv/yun/jun` 对得上 `tailMap` 的 `v`/`vn`） |
| **`CreateRenderer` 的 `new`** | 改为**注册表**（未注册返回 `None`） | 避免 `renderers.py` 反向依赖具体渲染器（循环导入）；C# 对未知名同样返回 null |
| **全局单例**（`ToolsManager` / `VoicebankFiles` / `PathManager` / `Preferences`） | 用可注入的宿主对象顶替 | Python 无全局单例；未配置时抛 `NotImplementedError`，**不静默给错路径** |
| **float32 vs float64** | 保留 float64，偏差写进 docstring | 引入 numpy 会让这个包不能脱离 numpy 单测；偏差约 1e-7，且哈希仍按 float32 写出 |
| **`IsHanzi` 的判据** | 收窄为"长度为 1 且为汉字" | 让"先收集、再按 `Length == 1` 替换"两处**共用同一判据**；否则多字汉字串会被收集却替换不到，`pinyinIndex` **错位** |

---

## 8. 未完成清单（按优先级）

### P0 —— 把链路接通（推荐下一步）

**`Pipeline/PhraseBuilder` + `PhraseSource.FromPart` + `Snapshots.cs`**（988 行）
> **当前最大的缺口。** 没有它，音素化的结果无法喂给已经写好的 `RenderPhrase` ——
> 整条链路是断的。做了这一项，"歌词 → 渲染输入"就端到端可测。
>
> - `PhraseSource.cs` 剩余部分：`FromPart`(约 30 行) + `BuildPhrases`
> - `PhraseSourceBuilder.cs`：162 行
> - `Snapshots.cs`：216 行（快照 + 增量失效，依赖 `Identities`，已就位）
> - `PhonemeAnchors` / `ExpressionGraph`：表达式图相关，可先留 `None` 守卫

### P1 —— 让渲染能出声

| 项 | 体量 | 说明 |
|---|---|---|
| `Classic/IResampler.cs` + `IWavtool.cs` | 25 行 | 两个接口，简单 |
| `Classic/SharpWavtool.cs` | 187 行 | 内置 wavtool；**依赖 NWaves 滤波器**（需评估） |
| `Classic/ExeResampler.cs` / `ExeWavtool.cs` | 141 + 224 行 | 外部工具进程（spawn + 参数拼装） |
| `Classic/ToolsManager.cs` / `VoicebankFiles.cs` | 140 + 122 行 | 工具发现与临时文件管理 |
| `Classic/WorldlineResampler.cs` | 66 行 | 调 `Worldline.Resample` |
| `Classic/ClassicRenderer.cs` | 152 行 | 串起来 |
| `Classic/WorldlineRenderer.cs` | 276 行 | Worldline 线（R1.1/R2） |

> 决策点：**是否随包分发 UTAU 的外部 resampler/wavtool**（OpenUTAU 需要用户自备）。
> 若不分发，则 Classic 线只能走 `SharpWavtool` + `WorldlineResampler` 这条自包含路径。

### P2 —— 声库与 .frq

| 项 | 体量 |
|---|---|
| `Classic/ClassicSinger.cs` | 243 行 |
| `Classic/Frq.cs`（`.frq` 基频文件） | 284 行 |
| `UOtoFrq`（MOD+ 依赖） | — |
| `Classic/VoicebankLoader.cs` / `VoicebankConfig.cs` | 549 + 91 行 |

> 补齐后 `render_phrase.py` 里 MOD+ 分支的守卫（`classic_singer is not None`）才会启用。

### P3 —— 更多音素化器（当前 3 / 51）

同模式，风险低，适合批量推进。优先级建议：

1. `JapaneseCVVCPhonemizer` / `JapanesePresampPhonemizer`（日语线补全）
2. `ChineseCVVPhonemizer`(133) / `ChineseCVVPlusPhonemizer`（中文线补全）
3. `PresampSamplePhonemizer`(164) — 需要 `Classic/Presamp.cs`(731)
4. **`Arpasing` 系**：`ArpasingPhonemizer.cs` 只有 62 行，但它牵出整条
   `OpenUtau.Core/G2p`（771 行 + 数据）+ `LatinDiphonePhonemizer`(35) +
   随包 `arpasing.yaml` 词典 —— **单列一步**，不要当成"一个 62 行文件"
5. 韩语系列 / 欧洲各语系

### P4 —— 编辑器侧（M3）

`ustx` 读写已就绪，但编辑器（钢琴卷帘 / 音素编辑 / 音高曲线）尚未接。
另需 `Render/RenderEngine.cs`(542) / `RealCurveUpdater.cs`(214) / `RenderView.cs`(185)。

---

## 9. 里程碑

| 里程碑 | 判据 |
|---|---|
| ~~M1 抽象层~~ | ✅ 已完成（`singing/api.py` + 适配器） |
| ~~M2-c `.ustx` 双向兼容~~ | ✅ 已完成 |
| **M2-a 渲染器主体** | 🟡 参数层完成；执行层待做（P1） |
| **M2-b 音素化器** | 🟡 3 / 51 |
| **M2 端到端可跑** | ⬜ **需 P0 + P1**：`歌词 → 音素 → 乐句 → 渲染 → WAV` |
| M3 编辑器替换 | ⬜ |
| M4 删除旧的 UTAU / DiffSinger 模块 | ⬜ 等 M2 端到端可跑，且已冻结基线 `openutau-port-baseline` |

---

## 10. 提交约定

一个 C# 文件（或其紧密小簇）一个 commit。commit message 必须包含：

1. **照搬范围**（Python 文件 ↔ C# 文件）
2. **本轮发现的上游怪癖**（死代码 / 重复赋值 / 语义不一致…）
3. **与 C# 的载体差异**（第三方库替换、全局单例替换、容器类型替换）
4. **测试数量变化**
5. **下一步**

> "发现"比"写了多少行"更有价值 —— 它是唯一能防止后人重踩的东西。
