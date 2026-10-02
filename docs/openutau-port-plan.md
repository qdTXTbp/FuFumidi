# FuFumidi × OpenUTAU 照搬移植：进度与计划

> 上游：`OpenUtau/`（C#）—— `OpenUtau.Core` + `OpenUtau.Plugin.Builtin` + `cpp/worldline`
> 落点：`engine/singing/`（纯 Python，**不依赖 torch / numpy**，可脱离主程序单测）
> 方针：**除外观外不允许自研** —— 每一处都应能回答"对应 OpenUTAU 的哪个文件/函数"
> 最后更新：2026-10-02 —— P0~P2 完成；MOD+ / `WorldlineRenderer` v10 / `JapaneseCVVC` /
> **G2p 基础设施** / **`PhonemeBased`+`Monophone`+`LatinDiphone` 基类** / **`ChineseCVV`** /
> **`ArpabetG2p`** 已补齐
> 2026-10-03 复核：四项测试 **1,390 项断言全绿**（含 `worldline.dll` 真机端到端）

---

## 0. 一句话现状

**整条链路通了：`歌词 → 音素 → 乐句 → 变调 → 拼接 → 样本`。**

- P0 把 `Pipeline/PhraseSource.FromPart` / `BuildPhrases` / `PhraseSourceBuilder` /
  `Snapshots` 搬完，可以从 `UVoicePart` 直接构建 `RenderPhrase[]` 并断言其哈希。
- P1-a 搬完执行层的**底座**：`Format/Wave.cs`、`IResampler` / `IWavtool` 两个接口、
  `ResamplerManifest`，以及内置拼接器 `SharpWavtool`（`simple` 与默认的 `convergence`
  都可用，后者连 NWaves 的 `IirPeak` / `ZiFilter.ZeroPhase` 一起转写了）。
- P1-b 搬完**变调**：`Classic/Frq.cs`、`Worldline.cs` 的 `SynthSegment` + `Resample`、
  6 个原生 ctypes 绑定、`Classic/WorldlineResampler.cs`。
- P1-d 搬完**串起来**的那一步：`Classic/ClassicRenderer.cs`（internal / external
  两条分支）+ `RenderEngine.cs` 里渲染器要用的 `Progress`。
- P2 搬完**声库侧全部三块**：`Classic/VoicebankConfig.cs`（`character.yaml` 模型）、
  `Classic/VoicebankLoader.cs`（`character.txt` / `oto.ini` / `prefix.map` →
  `oto.Voicebank`，含 `FileTrace`），以及 **`ClassicSinger`**（oto 表的构建与查询：
  子音色匹配、`prefix+phoneme+suffix` 映射、搜索词、原子发布）+ `OtoWatcher`
  + `ClassicSingerLoader`。
  → `render_phrase.py` 里 MOD+ 分支的守卫（`classic_singer is not None`）**现在可以真被触发了**。
- 随后补齐 `RenderPhrase.cs` 里最大的一段独立逻辑：**MOD+**（73 行）——
  用 `.frq` 分析出的音高偏差对每个音素做细粒度微调（元音段铺 `toneDiffStretch`、
  辅音段反向铺 `toneDiffFix`，两端按包络渐入/渐出）。至此 `RenderPhrase` 只剩
  表达式图一处未搬。
- 再补齐 **`WorldlineRenderer`**（276 行）与它的 `PhraseSynthV2`：
  **v10（`WORLDLINE-R`，正是 Classic 歌手的默认渲染器）全通并真机验证**；
  v11（R1.1）与 v20（R2）各缺一块外部依赖（ONNX 谐波分离模型 / 程序集内嵌 mel 模型 +
  可下载声码器包），都在**入口处**给精确报错，不是静默算错。
  → 至此 Classic 线的**三条渲染器路径**（`CLASSIC` / `WORLDLINE-R*`）都可跑。
- 再补一个音素化器：**`JapaneseCVVCPhonemizer`**（298 行）—— 日语三条线（VCV / CVVC /
  Presamp）已通两条；CVVC 还负责在下一个音符之前**插一个 VC 音素**。
- 再补 **G2p 基础设施**（`Api/IG2p.cs` + `IG2pSymbols.cs` + `G2pDictionaryData.cs` +
  `G2pDictionary.cs` + `G2pFallbacks.cs` + `G2pPack.cs`，共 387 行 C#）——
  这是 `SyllableBasedPhonemizer`(2204) / `PhonemeBasedPhonemizer`(226) 两条基类线的前置；
  搬完它，"解锁 17 个语言音素化器"就只差那两条基类本身。
  ONNX 会话做成**可注入**（没注入就是 C# 里 `Session == null` 的既有分支，返回空）。
- 再补**音素驱动那条基类线**：`PhonemeBasedPhonemizer`(226) + `MonophonePhonemizer`(31)。
  这条线是 `ChineseCVV` / `LatinDiphone`（→ Arpasing / FrenchCMU / GermanDiphone）的前置。
  与 `SyllableBased` 那条线的分工：**这条以"音素序列"为单位**（G2P 查符号 → 按时长铺开 →
  逐个换别名），那条以"音节"为单位。
- 再补一个**中文**音素化器：`ChineseCVVMonophonePhonemizer`(133，含手写的 `ChineseCVVG2p`)
  —— 把拼音拆成「整音 + 尾韵」（`duang` → `duang` + `_ang`），其余交给 `Monophone` 那条线。
  它是 `PhonemeBased`+`Monophone` 就位后的**第一个实际用户**，也算对那条基类的端到端验证。
- ★ 并**修掉一个跨模块的真 bug**：`USinger.try_get_mapped_oto` 返回 `(found, oto)`
  （照搬 C# 的 `out` 参数），但有**三个**音素化器把它当裸值用 —— 在真 `ClassicSinger`
  上会 `AttributeError: 'tuple' object has no attribute 'is_color_match'`。
  之所以一直没暴露，是因为**测试替身也返回裸值**（替身与真实现接口不一致 → 测试全绿）。
  现在统一走 `Phonemizer.mapped_oto()`（**严格解包**，替身写错就立刻 TypeError），
  并补了一条**用真 `ClassicSinger`** 驱动的回归用例。
- 再补 `LatinDiphonePhonemizer`(35) + **`ArpabetG2p`**(195) —— Arpasing 那条线的前置；
  `ArpabetG2p` 的词典数据走 `set_data_dir()` 注入（**不在引擎内硬编码路径**）。
- ★ 最后补**音节驱动那条基类线**：`SyllableBasedPhonemizer`（**2204 行，全文件**），
  连带两个此前缺口的依赖：
  - `G2pRemapper`(53)：把子类**硬编码**的符号表套到（YAML / G2P 模型）字典上；
  - `YamlWatcher`(47)：监视声库/插件目录的 `.yaml` 变更 → 清缓存 + 让歌手重载。

  `SyllableBased` 家族有 **17 个具体子类**（EnglishVCCV / EnglishCVVC / …），
  所以这条基类就位后，"逐个补子类"变成纯体力活。这一步同时搬来了：
  YAML 配置装载（`symbols` / `replacements` / `fallbacks` / `timings` /
  `diphthongs` / `vowelsustains` / `isglides`，含**版本比对 + 旧文件改名备份**）、
  组语法规则引擎（`vowel` / `consonant&y` / `vowel!a` / `vowel=i`，含**组捕获回填**）、
  边界替换（`"null"` 占位符）、以及 `MakePhonemes` / `ScalePhonemes` 的 tick 对齐。

  ★ 这一步又踩了一次"**替身属性面不全**"：`HasOto` 第二段查 `singer.TryGetOto`、
  `SetSinger` 读 `singer.Loaded`（= `Found && loaded`），而老的测试替身
  只有 `try_get_mapped_oto` / `loaded` → 一跑就 `AttributeError`。
  已按"替身照抄真实现的**属性面**"把 `_OtoSinger` 补齐（加 `try_get_oto`、`is_loaded`）；
  引擎侧也统一走 `_singer_is_loaded()` 助手，避免替身与真实现的差异再漏进测试。

**真机验证**（加载 OpenUTAU 随包分发的 `runtimes/win-x64/native/worldline.dll`）：
`RenderPhrase.from_part` → `ClassicRenderer.render()` 产出的样本，主频用**过零率**实测
≈ 440Hz（源素材 300Hz、tone 69）—— 变调与拼接都真的生效了。

已完成规模：Python **17,047 行**（`engine/singing/**/*.py`，72 个文件，排除 `__pycache__`），
对应 C# **约 12,218 行**（对第 3 节列出的 60 个 C# 源文件逐项 `wc -l` 求和，
含 `RenderEngine.cs` 的 `Progress` 部分）。
另有 NWaves 三段转写（**无 C# 对应物**，属第三方库替换）。

一致性测试 **7,772 行 / 1,390 项断言**（四个文件合计：19 + 59 + **1312** + 6；
参考源码缺失时自动 SKIP）。

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
| 乐句渲染输入（`RenderPhrase` / 3 类，含 MOD+） | 663 行 | ✅ 完成（只剩表达式图未搬） |
| 渲染器接口与注册表 | 146 + 141 行 | ✅ 完成（具体渲染器未搬） |
| Worldline 纯逻辑 | 780 行中约 400 | ✅ 完成（原生边界另计） |
| 音素化器基类 / 中文基类 | 250 + 51 行 | ✅ 完成 |
| `SyllableBasedPhonemizer`(2204) / `PhonemeBased`+`Monophone`(257) | 2204 + 257 行 | ✅ 完成（`SyllableBased` 那条线连同 `YamlWatcher` + `G2pRemapper` 一并搬完；17 个具体子类未搬） |
| 内置音素化器 | 51 个文件 / 25,707 行 | 🟡 **8 / 51**（JA VCV / JA CVVC / ZH VCV / ZH CVVC / ZH CVV / **FR VCCV / FR CVVC / TR CVVC**） |
| Classic 参数层 | 188 + 57 行 | ✅ 完成 |
| Classic 执行层 · 底座（WAV / 接口 / 清单） | 173 + 25 + 11 + 28 行 | ✅ 完成 |
| Classic 执行层 · 内置 wavtool | 187 行（+NWaves 三段转写） | ✅ 完成 |
| Classic 执行层 · Worldline 变调 | 66 + `Frq` 284 行 | ✅ 完成（`Resample` 主路径 + 真机验证） |
| Classic 渲染器（串起来） | 152 行 | ✅ 完成（internal / external 两条分支） |
| Classic 声库配置（`character.yaml`） | 91 行 | ✅ 完成 |
| Classic 声库加载（`character.txt` / `oto.ini` / `prefix.map`） | 549 行 | ✅ 完成（`FileTrace` + `Voicebank` 一并补齐） |
| Classic 歌手（`ClassicSinger` + `OtoWatcher` + `ClassicSingerLoader`） | 243 + 42 + 30 行 | ✅ 完成 |
| Worldline 的 `PhraseSynthV2` | 780 行中约 240 | ✅ 完成（v10 全通；R1.1 缺 hnsep 模型） |
| Classic 执行层 · 外部工具进程 | ~700 行 | ❌ 未开始 |
| `WorldlineRenderer` | 276 行 | 🟡 v10 全通（真机验证）；v11/v20 缺外部依赖，入口报错 |
| Pipeline（乐句切分 / 快照 / 后台构建） | 548 + 162 + 216 行 | ✅ 完成 |
| G2p（字素→音素） | 387 行（基座）+ 771 行（具体语言） | 🟡 基座 + **`ArpabetG2p`** 完成；其余 9 个语言 G2p 未搬 |
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
| `openutau/oto.py` | `Ustx/USinger.cs` 的 `UOto` 部分 + `Classic/VoiceBank.cs`（`Voicebank` / `OtoSet` / `Oto` / `Subbank`） |
| `openutau/singer.py` | `Ustx/USinger.cs`（基类与 `SingerTypeUtils`） |
| `openutau/phoneme.py` | `Ustx/UPhoneme.cs` |
| `openutau/phonemizer.py` | `Api/Phonemizer.cs` |
| `openutau/timeaxis.py` | `Ustx/TimeAxis.cs` |
| `openutau/renderer.py` | `Render/IRenderer.cs` |
| `openutau/renderers.py` | `Render/Renderers.cs` |
| `openutau/phrase_layout.py` | `Render/PhraseLayout.cs` |
| `openutau/render_phrase.py` | `Render/RenderPhrase.cs`（3 个类） |
| `openutau/worldline.py` | `Render/Worldline.cs` 的**纯逻辑部分** + 10 个导出的 ctypes 绑定 |
| `openutau/pipeline_source.py` | `Pipeline/PhraseSource.cs`（5 个数据类 + `Evaluate`/`Sample` + `FromPart`/`BuildPhrases`/`DrivenPhonemes`） |
| `openutau/pipeline_identities.py` | `Pipeline/Identities.cs` |
| `openutau/pipeline_builder.py` | `Pipeline/PhraseSourceBuilder.cs`（`PhraseBuildGate` + 单线程 worker） |
| `openutau/pipeline_snapshots.py` | `Pipeline/Snapshots.cs`（5 个快照类 + `DocumentSnapshotStore`） |
| `ustx/model.py` 的 `UPart.Id` / `UVoicePart.ApplyPhraseSourceResult` | `Ustx/UPart.cs` 的对应片段 |
| `openutau/binary_writer.py` | `System.IO.BinaryWriter`（缓存键字节布局复刻） |
| `openutau/xxhash.py` | `K4os.Hash.xxHash.XXH32` / `XXH64` |
| `openutau/classic/resampler_item.py` | `Classic/ResamplerItem.cs` |
| `openutau/wave.py` | `Format/Wave.cs`（解码后端可注入；编辑器侧部分未搬） |
| `openutau/classic/i_resampler.py` | `Classic/IResampler.cs` |
| `openutau/classic/i_wavtool.py` | `Classic/IWavtool.cs` |
| `openutau/classic/resampler_manifest.py` | `Classic/ResamplerManifest.cs` |
| `openutau/classic/sharp_wavtool.py` | `Classic/SharpWavtool.cs` |
| `openutau/classic/nwaves_filter.py` | **无 C# 对应物**：NWaves 的 `DesignFilter.IirPeak` + `TransferFunction.Zi` + `ZiFilter.ZeroPhase`（第三方库替换） |
| `openutau/classic/frq.py` | `Classic/Frq.cs`（`IFrqFiles` / `Frq` / `Mrq` / `OtoFrq`） |
| `openutau/classic/worldline_resampler.py` | `Classic/WorldlineResampler.cs` |
| `openutau/worldline.py` 的 `SynthSegment` / `resample` / `WorldlineNative` | `Render/Worldline.cs` 的对应片段 + `cpp/worldline/worldline.h` 的 6 个导出 |
| `openutau/classic/classic_renderer.py` | `Classic/ClassicRenderer.cs` |
| `openutau/classic/worldline_renderer.py` | `Classic/WorldlineRenderer.cs`（v10 全通；v11/v20 入口报错） |
| `openutau/render_engine.py`（部分：`Progress`） | `Render/RenderEngine.cs` 的 `Progress`（其余属 M3） |
| `openutau/classic/ini.py` | `Classic/Ini.cs` |
| `openutau/base_chinese.py` | `BaseChinesePhonemizer.cs` |
| `openutau/classic/voicebank_config.py` | `Classic/VoicebankConfig.cs`（`VoicebankConfig` / `SymbolSet` / `SymbolSetPreset` / `SingerTypeValues`） |
| `openutau/classic/voicebank_loader.py` | `Classic/VoicebankLoader.cs`（`FileTrace` + `VoicebankLoader`） |
| `openutau/classic/classic_singer.py` | `Classic/ClassicSinger.cs`（`OtoData` + `ClassicSinger`） |
| `openutau/classic/oto_watcher.py` | `Classic/OtoWatcher.cs`（监视后端可注入） |
| `openutau/classic/classic_singer_loader.py` | `Classic/ClassicSingerLoader.cs`（歌手工厂可注册） |
| `openutau/plugin_builtin/japanese_vcv.py` | `Plugin.Builtin/JapaneseVCVPhonemizer.cs` |
| `openutau/plugin_builtin/chinese_vcv.py` | `Plugin.Builtin/ChineseVCVPhonemizer.cs` |
| `openutau/plugin_builtin/chinese_cvvc.py` | `Plugin.Builtin/ChineseCVVCPhonemizer.cs` |
| `openutau/plugin_builtin/japanese_cvvc.py` | `Plugin.Builtin/JapaneseCVVCPhonemizer.cs` |
| `openutau/g2p/i_g2p.py` | `Api/IG2p.cs` + `Api/IG2pSymbols.cs` |
| `openutau/g2p/dictionary_data.py` | `Api/G2pDictionaryData.cs` |
| `openutau/g2p/dictionary.py` | `Api/G2pDictionary.cs`（Trie + Builder） |
| `openutau/g2p/fallbacks.py` | `Api/G2pFallbacks.cs` |
| `openutau/g2p/pack.py` | `Api/G2pPack.cs`（ONNX 会话可注入） |
| `openutau/plugin_builtin/phoneme_based.py` | `Plugin.Builtin/PhonemeBasedPhonemizer.cs` |
| `openutau/plugin_builtin/monophone.py` | `Plugin.Builtin/MonophonePhonemizer.cs` |
| `openutau/plugin_builtin/chinese_cvv.py` | `Plugin.Builtin/ChineseCVVPhonemizer.cs`（含 `ChineseCVVG2p`） |
| `openutau/g2p/arpabet.py` | `G2p/ArpabetG2p.cs`（数据走 `set_data_dir` 注入） |
| `openutau/plugin_builtin/latin_diphone.py` | `Plugin.Builtin/LatinDiphonePhonemizer.cs` |
| `openutau/g2p/remapper.py` | `Api/G2pRemapper.cs` |
| `openutau/classic/yaml_watcher.py` | `Classic/YamlWatcher.cs`（监视后端可注入） |
| `openutau/plugin_builtin/syllable_based.py` | `Plugin.Builtin/SyllableBasedPhonemizer.cs`（2204 行，全文件） |
| `openutau/plugin_builtin/french_vccv.py` | `Plugin.Builtin/FrenchVCCVPhonemizer.cs`（**`SyllableBased` 首个真实用户**） |
| `openutau/plugin_builtin/french_cvvc.py` | `Plugin.Builtin/FrenchCVVCPhonemizer.cs`（757 行；同法语家族第二个真实用户） |
| `openutau/plugin_builtin/turkish_cvvc.py` | `Plugin.Builtin/TurkishCVVCPhonemizer.cs`（356 行；直接继承 `Phonemizer`） |

每个模块的 `__init__.py` 里维护着一份"已照搬 / 未照搬"清单，与上表同步。

---

## 4. 验证方式

```bash
cd engine/tests
python test_ustx_schema_matches_source.py        # 19 passed
python test_ustx_roundtrip.py                    # 59 passed
python test_openutau_core_matches_source.py      # 1312 passed ← 含 worldline.dll 真机端到端
python -m pytest test_singing_adapters.py -q     # 6 passed
```

合计 **1,390 项断言，全绿**。参考源码缺失时自动 SKIP（`OPENUTAU_REF` 环境变量可指定路径），
整套测试**可离线运行**。

`worldline.dll` 真机测试的 SKIP 条件是"找不到 `/d/FuFuMIDI/_ref/OpenUtau/runtimes/win-x64/native/worldline.dll`
或 dll 加载失败" —— **本机可得，所以那几条是真的跑了**（端到端一条断言输出主频 ≈ 440Hz）。

> 两个可选依赖的降级行为：
> - 第三方 `pypinyin`（`BaseChinesePhonemizer` 用来做汉字→拼音）：**未安装不崩**，
>   汉字原样返回，于是 `ZH VCV.Romanize*` 那几条断言会失败。本机已装 `0.55.0`，
>   全绿。这属于**环境缺依赖**，不是照搬偏差。
> - `onnx`（仅 `test_diffsinger_smoke.py` 用）：已改成 `pytest.importorskip`，缺失即整文件跳过。
>
> （顺带记一笔：`romanize` 里 `if pinyin_result is None` 这个降级守卫是死分支 ——
> 列表推导永远不会是 `None`。要不要改成真判空属于 M2-b 的事，别顺手改。）

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
| 12 | **`Dictionary<T, ...>` / `HashSet<T>` 以对象为键** | C# 是**引用相等**；Python 的 `@dataclass` 生成 `__eq__` 后 `__hash__` 变 `None`（**根本不能当键**），就算能当键也是**逐字段比较** —— 两个内容相同的音符会被合并成一个 | 键改用 `id(obj)`（`PhraseSource._of` 的 `noteIndexByNote`、`PhraseSourceBuilder` 的 `latest` 字典） |
| 13 | **`list.Contains(obj)` / `list.IndexOf(obj)`** | 同上：C# 是引用相等，Python `in`/`index` 走 `__eq__` | 写成 `any(p is obj for p in list)`；别为了省事写 `obj in list` |
| 14 | **`TimeAxis.Clone()` 不复制 `Timestamp`** | 克隆体恒为 0，所以 `RenderPhrase.Hash()` 里那一项**实际没有贡献**（"改速度导致缓存失效"只能靠 pitches/dynamics 间接覆盖） | **照搬不修**；已在 `RenderPhrase._hash` 的 docstring 里写明，要修应单独立项 |
| 15 | **`Array.Resize(ref arr, n)` 在 `n` 变小时会截断** | 不是"只扩容"：后写入的段若位置更靠前，会**悄悄丢掉**前面已累加的样本（`n < 0` 时 C# 抛 `ArgumentOutOfRangeException`） | 照搬（`SharpWavtool._resize`），负数同样抛；别写成"取 max" |
| 16 | **NAudio 的 16 位换算两头不对称** | 写用 `short.MaxValue = 32767`、读用 `/32768`，往返误差上界因此是 `1/32767 + 1/32768` 而不是 `1/32768` | 照搬；写测试期望时别按"对称量化"算 |
| 17 | **`F0FrameCount` 是"缓冲上界"不是"帧数"** | 拿它当长度去读数据会读到尾巴上的**填充 0**（被当成无声）；实测 pyin 对 1 秒 44.1kHz 只产出 99 帧、容量 101 | `F0()` 按**返回值**裁长度；`method == -1`（只要帧数）才按容量算 |
| 18 | **同一份文件里两处"无声判据"阈值不同** | `Frq.Build` 统计平均用 `f > 0`；`OtoFrq.Completion` 却把 `<= 60` 当无声。统一它们会让 `.frq` 的平均音高与 MOD+ 的偏差同时漂 | 照搬，别"整理"成同一个常量 |
| 19 | **构造器链里两条路方向相反** | `SynthSegment` 的 resampler 路径**不做**输入增益（增益在 `Resample` 输出端）、乐句路径**做**输入增益；照搬时若合并成一个 `if` 分支，很容易把增益做两次或一次都不做 | 用显式布尔参数区分两条路，并在 docstring 里写明"增益在哪一侧" |
| 20 | **`IirPeak` 是"峰值单位增益"谐振器，不是放大器** | 断言"它把目标频率放大 N 倍"必错；`\|H(w0)\| = 1`、直流为 0 | 测它要测"直流被压掉、中心频率保持"，或直接对着公式算系数 |
| 21 | **`lock(obj)` 是不可重入不了解的坑** | C# 的 `Monitor` **同线程可重复进入**；Python 的 `threading.Lock` 不是 → **自锁死**（线程等自己）。本项目真实踩到：`ClassicRenderer` 先按 `item.outputFile` 加锁，再进 `WorldlineResampler` 里的**同一把**锁 | 凡 C# 用 `lock` 的地方，Python 一律用 `RLock`；并在测试里断言"同线程可重复进入" |
| 22 | **"谁负责跑 resampler"在两条分支上不同** | `RenderInternal` 自己跑 resampler；`RenderExternal` **不跑** —— 那是 `ExeWavtool` 的活（`item.resampler.NoWrapperScript && !File.Exists(outputFile)` 那个分支）。照着"补齐"会在外部路径上把 resampler 跑两遍或一遍都不跑 | 照搬这条**有意的不对称**，并在 docstring 里写明"缓存文件是谁产出的" |
| 23 | **.NET 的 `Encoding.GetEncoding("shift_jis")` 实为 code page 932** | Python 的 `'shift_jis'` 是 JIS，读老声库会在边缘字符上解错（`①`、`～`、`¥` 一类） | 编码名统一过一张表映射到 `'cp932'`；`.NET` 名字非法会抛，而 Python 的 `codecs.lookup` 会把空白归一化掉，所以**显式拒绝含空白的名字**（`#Charset: utf-8` 正是靠这一点被判成"没声明"） |
| 24 | **`new StreamReader(stream, encoding)` 默认检测 BOM、解码失败不抛** | Python `open(encoding=...)` 默认 `errors='strict'`，坏字节直接抛；带 UTF-8 BOM 的 `character.txt` 会被当成 cp932 解出 `\ufeff` | `_read_text` 手写 BOM 检测（UTF-8/16/32，UTF-32 必须排在 UTF-16 前）+ `errors='replace'`（.NET 的替换字符是 `'?'`、Python 是 `U+FFFD`，唯一差异） |
| 25 | **C# `double.ToString()` 没带 `InvariantCulture`** | 写出 `0.0` 时 C# 是 `"0"`、Python 是 `"0.0"`；指数形式 C# 是 `"1E-05"`；更要命的是**逗号小数点的系统上上游会写出坏 oto.ini** | `_cs_double` 复刻"最短可往返 + 省 `.0` + 大写 `E`"；那个区域性缺陷**不照搬**（Python 固定用 `.`），已记档 |
| 26 | **`Array.ForEach(s, temp => temp.Trim())` 什么都不做** | `string` 不可变，trim 结果被丢弃 → `name = Foo`（等号两侧有空格）**认不出来**，会落进 `OtherInfo`。以为它 trim 了就会写出错的测试期望 | 照搬（不 trim），并在测试里把"认不出来"写成断言 |
| 27 | **`AddAliasForMissingFiles` 造出的 oto `IsValid` 是 false** | 看着像 bug（对象初始化器里没写 `IsValid`），而 `ClassicSinger` 只收有效条目 → 该功能当前实际不生效。若"顺手修好"，行为会变 | 照搬 + 记档：改正确属行为变更，应单独立项 |

| 28 | **`character.txt` 的键表里**没有** `portrait`** | 写了 `portrait=p.png` 会被**静默忽略**（`PortraitOpacity` / `PortraitHeight` 同理）；它们只在 `character.yaml` 里 | 照搬（`parse_character_txt` 只认 name/名前/image/author/created by/voice*/cv/sample/web/version）。测试里想验 portrait 就得给 `character.yaml` |
| 29 | **`Voicebank.Reload()` 会重读整个声库** | 它会把 `subbanks` / `oto_sets` 一起清掉重建 —— 在测试里手工往 `voicebank.subbanks` 塞值，`singer.reload()` 一跑就没了，表现为"子音色匹配整条失效" | 子音色必须来自**真实的 `prefix.map`**（制表符三列：音名 / 前缀 / 后缀）。这也是一条真实行为：运行期改 `voicebank.subbanks` 是留不住的 |
| 30 | **`Save()` 在"没加载过"时会崩** | C# 里 `oto_watcher` 只在 `Reload()` 里创建，`Save()` 直接 `otoWatcher.Paused = true` → NRE。Python 侧是 `AttributeError` | 照搬（已在测试里把"会崩"写成断言）。修它属行为变更，应单独立项 |
| 31 | **`Regex.Escape` ≠ `re.escape`（但本例里无碍）** | 两者转义字符集不同（Python 多转 `-`/`&`/`~`，C# 多转 `#`）。这里 pattern 只当**分组身份**用（同 prefix+suffix ⇒ 同 pattern），转义是逐字符的确定性映射、对输入单射，所以**分组结果完全一致** | 用 `re.escape` 即可；但要知道"pattern 串本身长得不一样"，别拿它去跟 C# 做字符串相等断言 |

| 32 | **`(int)Math.Ceiling(x) / n` 是「先 ceil 再整数除法」** | 分子可为负时，C# 的整数除法**向零截断**，Python 的 `//` 向下取整 —— `-1/5` 得 `0` vs `-1`。直接照抄成 `ceil(x) // n` 会在负数段算错下标 | 用 `idiv(math.ceil(x), n)`。本轮 MOD+ 的 `endIndex` 正是这个形态 |
| 33 | **`Math.Clamp(v, 0, n-1)` 在 `n == 0` 时抛 `ArgumentException`** | C# 抛错、被外层的 per-phoneme `catch` 吞掉 → **整个音素被跳过**；若 Python 侧写成 `max(0, min(-1, v))` 会静默得到 0 并继续算，结果完全不同 | 显式在 `n <= 0` 时抛错，让同一层 `except` 接住 —— 这才是"等价" |
| 34 | **C# 的局部函数可以用在使用之后** | `Fade(...)` 在 C# 里声明在调用它的循环**下面**（同一块内合法）；Python 必须先定义 | 提前定义闭包，别以为"照抄顺序"能行 |
| 35 | **函数"算了却没返回"的东西** | `blend_continuous_noise_features` 累加了 `sp` 却只返回 `sp_harmonic`（漏了 `sp`），而 C# 的 `WorldSynthesisContinuousNoise(f0, sp, spHarmonic, …)` **两个都要**。★ 当时那条测试**跟着实现写成了 5 元组**并断言"谐波在第三个位置"，于是"一致地错"、测试全绿 | 移植多返回值函数时，**逐个数 C# 调用点要几个参数**，别只照着自己写的返回值改测试。已改成 6 元组并让测试断言 **sp 与 sp_harmonic 各归其位** |
| 36 | **测试替身与真实现的返回契约不一致** | 这是本轮最贵的一类：`USinger.try_get_mapped_oto` 返回 `(found, oto)`，而**三个**音素化器当裸值用 → 真 `ClassicSinger` 上 `AttributeError: 'tuple' object has no attribute 'is_color_match'`。**测试全绿**，因为替身也返回裸值（两边一致地错） | ① 替身必须**照抄真实现的签名与返回形状**；② 关键接口补一条**用真实现**驱动的用例（本轮的 `test_phonemizers_against_real_singer`）；③ 在基类加**严格解包**的统一入口 `Phonemizer.mapped_oto()`，替身写错立刻 `TypeError` |
| 37 | **把返回元组的函数当布尔用** | `if self._check_oto_until_hit_vc(...):` —— 元组**恒为真**，于是永远走"命中"分支，然后在 `oto1 is None` 上炸。同一处还**重复调用**了两次（第二次才解包） | 一次调用、立刻解包：`hit, oto = f(); if hit:`。已在本模块注释里点明这是自己踩过的坑 |
| 38 | **`^[\p{P}]$` 只匹配「恰好一个」标点字符** | 字符类**没有量词**又带首尾锚点，所以 `"!!"`（两个字符）**不匹配** —— 直觉上会以为"全是标点"。而且 Python 的 `re` **没有 `\p{P}`**，直接翻译会抛错 | 用 `unicodedata.category(ch).startswith('P')` 等价实现，并**显式保留"只判一个字符"**（`len(s) != 1 → False`）。读 C# 正则时要**先看有没有量词** |
| 39 | **`Array.IndexOf` 找不到返回 **-1**，而它被拿去乘了** | `startTick = -ConsonantLength * firstVowel` —— 找不到元音时 `firstVowel = -1`，于是 `startTick` 变成**正** `ConsonantLength`（本该是 0 或负）。Python 里若按"没找到就当 0"处理，整条音符的音素位置会全偏 | 照搬：`first_vowel = is_vowel.index(True) if True in is_vowel else -1`，并**专门为这个 quirk 写一条断言**（无元音时首音素 position = +60） |
| 40 | **C# 的 `List.Sort` 是**不稳定**排序，Python 的 `sorted` 是稳定的** | 等键元素的相对顺序在 C# 里是**未定义**的（introsort）。这里影响对齐表：同一下标的两项谁先谁后会改变后续的"手动项去重"结果 | 实测对齐表通常 < 16 项 → C# 走插入排序，**恰好是稳定的**，所以 Python 的稳定排序等价。已把"这是巧合一致"写进注释；若将来对齐表规模变大（> 16），需要重新核对 |
| 41 | **`len > 2` 而不是 `len >= 2`（离一错位）** | `ChineseCVVG2p.Query` 里"取双字母声母 zh/ch/sh" 的条件是 `lyric.Length > 2`。所以 `"zhang"`(5) 会拆成 `zh`+`ang`，而 `"zh"`(2) **不会** —— 落到下一个条件变成 `z`+`h`、查不到尾韵。写成 `>= 2` 会让 `"zh"` 的行为完全不同 | 照搬 `len > 2`，并**两个都写进测试**（`zhang → ['zhang','_ang']` 与 `zh → ['zh']`）。凡是 C# 里出现 `> N` 的地方，都要问一句"边界上那个值会怎样" |
| 42 | **★ struct 的值语义会静默消失**（本轮最贵的一类） | `Syllable` / `Ending` 在 C# 是 `struct`。`var syllable = syllables[i];` 是**拷贝** → 之后写 `syllable.prevBasePhoneme = …` **不会回写数组**；`ApplyBoundaryReplacements(Syllable x)` 是**按值**入参 → 函数里改 `x.prevV` 不会影响调用者。Python 的 `dataclass` 是引用语义，照字面转写会让"改副本"变成"改原对象" | 凡 C# 结构体被赋给局部变量 / 传参的地方，**显式 `copy.copy()`**；`ApplyBoundaryReplacements` 内部第一件事就是 `copy.copy(syllable)`。并写一条断言："调用后原对象字段不变" |
| 43 | **struct 上的 `FirstOrDefault(...) ?? 默认值` 是死代码** | `PhonemeAttributes` 是 struct，`List<T>.FirstOrDefault()` **永远不返回 null**（返回 `default(T)`），所以 `attr = dynamicAttrs?.FirstOrDefault(...) ?? notes[0].phonemeAttributes?.FirstOrDefault(...) ?? default` 里**第二支只在 `dynamicAttrs` 本身为 null 时才可能走到**。按"没找到就回落"去实现是**行为变更** | 照抄成 `if dynamicAttrs is None: 查 notes[0] else: 查 dynamicAttrs，找不到就给 DEFAULT_ATTR`，并在 docstring 写明"那一支实践上不可达" |
| 44 | **`(int)` 是向零截断，`Convert.ToInt32` 是四舍六入五成双 —— 同一个文件里两种都有** | `AssignAllAffixes` 的 `altValue = (int)altExpr.value` 是**截断**（2.7 → 2）；而 `ChineseCVVCPhonemizer` 的 `Convert.ToInt32(...)` 是**银行家舍入**（由 `int(round(x))` 复刻）。混用会让 `.5` 附近差 1 | 逐个看 C# 写的是哪一种：`(int)expr` / 整数除法 → `idiv()` 或 `int()`；`Convert.ToInt32` → `int(round())`。测试里对 `2.7 → 2` 这种**能区分两种语义**的值写断言 |
| 45 | **`System.Version` 的缺段补 **-1**，于是 `"1.2" < "1.2.0"`** | YAML 版本比对用 `Version.TryParse`；`Version("1.2")` 的 Build/Revision 是 **-1**（不是 0），所以它**小于** `Version("1.2.0")`。若按"补 0 / 按字符串比"实现，本该触发的"版本过旧要备份重写"就不会触发 | `_parse_version()` 显式把缺段填 `-1`，并按 4 元组比较；单独为 `"1.2" < "1.2.0"` 写断言 |
| 46 | **规则过滤的 `where` 与"边界"耦合：`inside` 的规则在边界上**不生效** | `ApplyReplacements` 的过滤是 `where=="all" \|\| (!isBoundary && where=="inside") \|\| (isBoundary && where=="boundary")`。句末 `Ending` 那条路径**恒传 `isBoundary=true`**，于是所有默认 `where="inside"` 的规则在句末**一个都不参与** | 测试里要**两套都写**：`inside` 规则在音节内部生效、在句末不生效；要让句末也生效必须写 `where="all"`（本轮就是这里先写错了期望） |
| 47 | **C# 的 `params` 重载在 Python 里要用**仅关键字参数** | `TryAddPhoneme(list, tone, params string[])` 与 `TryAddPhoneme(list, tone, bool isGlide, params string[])` 同名。Python 用 `*targets` + 仅关键字 `is_glide=False` 复刻 —— 但**位置传 `True` 会被 `*targets` 吃掉**（本轮测试就先这么写错了） | 签名写成 `(self, source, tone, *targets, is_glide: bool = False)`，docstring 里点明对应哪个重载；测试用关键字形式调用 |


### 附：写测试时的最大陷阱 —— 凭直觉填期望

**症状**：连续出现"实现正确、测试期望错误"。本项目一轮内错了 7 处
（权重、增益、长度、夹紧方向、分帧插值…）。

**规律**：凡"看起来像常数"的值（weight / gain / 阈值 / 长度）**几乎都是公式值**。
本轮又栽了三次，全是这一类：

- `IirPeak` 不是"把目标频率放大"的带通，而是**峰值处单位增益**的谐振器
  （`|H(w0)| = 1`，直流为 0），我按直觉断言"增益 > 5"；
- `ZiFilter` 的冲激响应手算时把 `b1 - a1*y0` 错写成了 `b1`；
- 断言 `.frq` 会把 f0 搬到分析帧上，却忘了**同一份数据还要过一遍音高弯曲**，
  于是"300Hz"被弯成了 "440Hz" —— 应该断言的是"有声/无声判定生效"。

三次都靠"把公式抄进测试"或"把中间量打印出来"才发现。

本轮还多了一类**更贵的**教训：**卡死比报错难查一个数量级**。表现是整份测试
静默不动、无任何输出（stdout 被重定向后是块缓冲，所以"没输出"既可能是卡死也可能
只是没 flush）。定位手段按性价比排序：

1. **先拿最小复现跑一遍**（把可疑那一段单独拎出来计时）—— 本轮一跑就发现单线程
   0.3s 能跑完，于是"是不是太慢"这个问题直接被排除；
2. **`faulthandler.dump_traceback_later(15, exit=True)`** —— 一次性给出**所有线程**的
   Python 栈，本轮正是它把两个 worker 钉在 `get_cache_lock` 那一行上；
3. `python -u` + 重定向到文件（而不是 `| Select-Object`，那会把输出全缓冲住）。

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
| **`Subbank` / `FileTrace` 的落点** | `Subbank` 留在 `oto.py`、`FileTrace` 留在 `classic/voicebank_loader.py`，两侧互相引用即可 | C# 把 `Subbank` 定义在 `VoicebankConfig.cs`、`FileTrace` 定义在 `VoicebankLoader.cs`，但 `oto.py` 在 `classic/` **之外**：反向导入会先把 `classic` 包初始化，而 `classic/__init__.py` 必须延迟到 `openutau/__init__.py` 末尾才导入（渲染器注册顺序）—— 必然成环。所以 `Oto.file_trace` 用 `TYPE_CHECKING` 前向引用标注，`voicebank_config.py` 反过来 `from ..oto import Subbank`。**文件边界服从可导入性**，已写进各自 docstring |
| **`DocManager.Inst`（Revision/Project/MainScheduler）** | 用可注入宿主 `pipeline_source.host` 顶替；`from_part` 另留显式 `revision` 参数 | 与 `ClassicHost` 同一套路。未配置时 `project=None` → 构建结果按"part 已被删除"同一条路径丢弃，不会静默写错地方 |
| **`TaskScheduler mainScheduler`** | 可调用对象（`fn -> None`）；为 `None` 时就地应用 | Python 无 `TaskScheduler`。`None` 恰好对应 C# "没有 worker 的测试宿主"那条路径 |
| **`BlockingCollection.Take(token)`** | `queue.Queue` + 哨兵对象唤醒 | Python 的 `get()` 不能被 `Event` 打断，只能塞哨兵；语义相同（dispose 后 worker 立即退出） |
| **快照里的 `tempos`** | 沿用 `TimeAxis.tempos_between_ticks()` 既有的 `dict` 形态 | 该方法早已按此形态落地，改成 `UTempo` 会让 `RenderPhrase` 一起改，收益为零 |
| **`UPart.Id` / `UTrack.TrackNo` / `UCurve.descriptor`** | 补成运行时字段（`NO_YAML`） | 它们都是 C# 的 `[YamlIgnore]` 成员，不写盘；但管线与 `CurveSource` 要读 |
| **是否随包分发 UTAU 的 resampler.exe / wavtool.exe** | **不分发**，Classic 线走自包含路径（`SharpWavtool` + 未来的 `WorldlineResampler`） | `docs/utau/selection-report.md` 早已定调：原版 exe 是闭源 freeware、**重分发授权不明**、仅 Windows 且依赖日文 locale。`ExeResampler` / `ExeWavtool` 仍会搬（OpenUTAU 就是这么设计的），但只服务"用户自备工具"，不进关键路径 |
| **NWaves（.NET 库）缺失** | 把用到的三段（`IirPeak` / `TransferFunction.Zi` / `ZiFilter.ZeroPhase`）逐行转写进 `classic/nwaves_filter.py` | 与 `pypinyin` 替代 `csharp-pinyin` 同类：.NET 库没法在 Python 里引用。NWaves 是 MIT，文件头写明出处与行级对应 |
| **`Wave.OpenFile` + NAudio 解码/重采样链** | 折叠成可注入的 `WaveHost.decode_mono(path)`；默认只认 44.1kHz PCM WAV，其它**明确报错** | C# 的 `WdlResamplingSampleProvider` 是自研重采样器，照搬=自研 DSP。音源基本就是 44.1k WAV；其它容器由宿主接 ffmpeg（项目已有 `engine/ffmpeg_wrap.py`） |
| **`Array.Resize` 的浮点语义** | 照搬（含"变小时截断"与"负数抛错"） | 上游就是靠"音素位置单调不减"成立的；改成"取 max"是行为变更 |
| **原生 `worldline` 库的取用方式** | 运行期 ctypes 加载；`WorldlineNative(library_path)` 可显式指定，`get_native()` 惰性缓存 | 与 C# 的 `DllImport("worldline")` 解析结果对齐（`worldline.dll` / `libworldline.so` / `libworldline.dylib`）。找不到库时 `available=False`，纯逻辑照常工作，只有真调 DSP 才抛 |
| **`worldline` 的 NumSharp `NDArray`** | 一律换成**扁平 `list[float]`**（`frame * sp_size + k`） | 数学一致；而且 ctypes 本来就要传 `double*` 扁平缓冲，省掉一次 `ToArray<double>()`。包不依赖 numpy 这条底线也保住了 |
| **`WorldlineNative.F0` 的错误语义** | C# 的包装 `catch` 住异常后**返回 null**（调用方随即 NRE）；这里让 `SynthRequestError` 冒出来 | 失败语义相同（都是"拿不到 f0"），但错误信息可读。已在 docstring 注明这是有意的差异 |
| **`MessageCustomizableException`（带 `<translate:...>` 键的 UI 文案）** | 不产生；`WorldlineResampler.do_resampler` 保留**异常类型**并把音素名写进消息 | 翻译键是 UI 层（M3）的事，管线不需要。渲染器要按类型分支，所以类型必须保住 |
| **`Renderers.GetCacheLock` 的锁类型** | C# 是 `object` + `lock()`（= `Monitor`，**可重入**）→ Python 用 `threading.RLock` | 嵌套加锁是真实存在的（`ClassicRenderer` → `WorldlineResampler` → `SharpWavtool` 都按同一 key 加锁）。用 `threading.Lock` 会在第一次真渲染时自锁死 —— 已实测并加了回归断言 |
| **`Parallel.ForEach` 的异常聚合** | `AggregateException`（顺序不定）→ 按**提交顺序**取第一个异常原样重抛 | 失败语义相同（都会把失败暴露出来），但顺序可预期，且不必引入一个 Python 里不存在的类型 |
| **`Progress` 的合并派发（coalescing）** | 不搬；只保留 `total/completed/complete/clear` + 一个 `notify` 回调 | C# 那套"最多一个 UI 投递在飞"是为了不刷爆 UI，且绑定 `DocManager.ExecuteCmd` / `MainScheduler`（都是 M3 的编辑器层）。合并策略交给宿主 |
| **`Progress` 的 `total = 0`** | C# 算出 NaN 继续走；Python 让它抛 `ZeroDivisionError` | 这是"调用方没算好总步数"的显式错误，静默给 NaN 只会让"进度条不动"更难查 |
| **`WanaKanaNet.ToRomaji`（第三方日文罗马字库）** | 做成**可注入钩子** `classic_singer.set_romaji_converter(fn)`；未注入时跳过罗马字搜索词 | 未注入 ⇒ 只留"别名小写去空格"一项。**这与 C# 里那次调用抛异常被 `catch { }` 吞掉的结果完全一致**，所以不是行为差异，只是少一项搜索词 |
| **`FileSystemWatcher`（.NET 专有）** | `OtoWatcher` 的监视后端做成**可注入**；不注入时用 `_NoopBackend`（不监视） | Python 标准库没有等价物。真监视是**宿主能力**（可接 `watchdog`），不是引擎逻辑，所以没在这里自研轮询器。代价只是失去"外部改 oto.ini 自动重载"（需要时显式 `reload()`） |
| **`SingerManager.Inst.ScheduleReload`** | 可注入的模块级 `scheduler`；默认实现**直接 `singer.reload()`** | 与 `ClassicHost` / `Renderer` 注册表同一套路。差别只在时机（C# 是丢到主调度器排队），不在结果。★ docstring 里已提醒：watcher 回调可能在别的线程，真多线程用要注入排队版本 |
| **`EnunuSinger` / `DiffSingerSinger` / `VoicevoxSinger`** | `ClassicSingerLoader` 改成**工厂注册表**，未注册时回落到 `ClassicSinger` | 与 `Renderers.CreateRenderer` 同一套路。C# 的 `default` 分支本来也是 `ClassicSinger`，所以未注册时的行为与 C# 的"该类型不存在"一致 |
| **`IDisposable`** | `dispose()`，并额外支持 `with` 用法 | Python 无 `IDisposable`；`with` 是顺手的等价物，不改变语义 |
| **`as_float32` 的落点** | 提到 `music_math.py` 成为**共享**辅助（原先只在 `worldline.py` 里私有） | MOD+ 也要用它（C# 写了 `2f` / `1.0f` / `100f` 与 `(float)(diff * 100)`）。放在共用处，避免两份实现悄悄漂移；`worldline` 的私有版已删除并改为导入 |
| **MOD+ 里 `OtoFrq` 的导入方式** | **函数内惰性导入** | `classic/` 包反向依赖 `render_phrase`（`classic_renderer` → `RenderPhrase`），模块级导入成环。`oto.py` 对 `VoicebankLoader` 用的是同一招 |
| **WorldlineRenderer 的 v11 / v20** | **v10 做完整；v11/v20 在入口处给精确报错**（列出缺什么、给替代方案），不写半截实现 | v11 要 ONNX 谐波分离模型 `Hnsep`（`SynthSegment` 的谐波分支 + `HnAnalysisF0In` + `sp_env_harmonic` 传递都还没接）；v20 要 `Data.Resources.mel`（**程序集内嵌资源**，仓库里无独立文件）+ 可下载包 `pc-nsf-hifigan`（走未搬的 `PackageManager`）。★ v10 就是 `GetDefaultRenderer` 对 Classic 歌手给的默认渲染器，所以它是真正高价值的那条 |
| **`G2pPack` 的 ONNX 会话** | **可注入的会话工厂**（`g2p.pack.set_onnx_session_factory`）；没注入时 `session is None` → `predict` 返回空 | C# 直接 `new InferenceSession(g2pData)`（`Microsoft.ML.OnnxRuntime`）。★ 没注入时**不是"降级成别的算法"**，而是走 C# 里**本来就有的** `Session == null` 分支（返回空 → 查不到 → 由上层回落）。所以两边落点相同，只是"未登录词没法预测" |
| **`SynthCancelled`** | 自定义异常，`analyze_requests(cancellation)` 里检查 `threading.Event` 后抛 | 对应 C# 把 `CancellationToken` 交给 `Parallel.For` 抛出的 `OperationCanceledException`；渲染器 `except SynthCancelled: return result` 与 C# 逐字对应 |

---

## 8. 未完成清单（按优先级）

### ~~P0 —— 把链路接通~~ ✅ 已完成

`PhraseSource.FromPart` / `BuildPhrases` / `DrivenPhonemes`（548 行的剩余部分）、
`PhraseSourceBuilder.cs`（162）、`Snapshots.cs`（216）三块都已落地，见第 3 节对照表。
本轮同时补齐了两个"不搬就没法用"的零件：`UPart.Id` / `UVoicePart.ApplyPhraseSourceResult`
（`UPart.cs` 的对应片段）与 `RenderPhrase.FromPart`。

接下来可选的两项收尾（都不阻塞 P1）：

- `UPart.UpdatePhrases()`：把"音素化 → 取快照 → 投递 → 等落地"串起来，
  依赖音素化器的 `PhonemesUpToDate` 判定（编辑器侧，可与 M3 一起做）。
- `ExpressionGraph/*`：`driven_phonemes()` 目前走的是"C# 的提前返回"那条路径，
  真接上图之后要把 `DrivenPhonemes` 的剩余分支搬进来。

### ~~P1-a —— 底座 + 内置 wavtool~~ ✅ 已完成

`Format/Wave.cs`（WAV 缓存文件的读写）、`Classic/IResampler.cs` / `IWavtool.cs` /
`ResamplerManifest.cs`、`Classic/SharpWavtool.cs`，外加 NWaves 三段原语的转写。
见第 3 节对照表。

> 决策点已定：**不随包分发 UTAU 的外部工具**（理由见第 7 节），
> Classic 线走 `SharpWavtool` + `WorldlineResampler` 这条自包含路径。

### ~~P1-b —— Worldline 变调~~ ✅ 已完成

`Classic/Frq.cs`(284)、`Worldline.cs` 的 `SynthSegment` + `Resample`
（含 `.frq` 接入、音高弯曲、`srcEndMs` 两支不对称）、6 个原生导出的 ctypes 绑定，
以及 `Classic/WorldlineResampler.cs`(66)。见第 3 节对照表。

**真机验证**：加载 `runtimes/win-x64/native/worldline.dll`，把 300Hz 正弦按
tone 69 变调，输出主频用**过零率**实测 ≈ 440Hz（±10% 内）。

> 仍有未搬的两块（都不阻塞 P1-d）：
> - `PhraseSynthV2`（R1.1，约 240 行）：`AnalyzeRequests` 的并行分析、`Synth`、
>   `SynthContinuousNoise`，以及 `DecodeMgc` / `DecodeBap` / `HnAnalysisF0In` /
>   `WorldSynthesisContinuousNoise` 四个绑定 + `Core/Analysis/Hnsep`。只被
>   `WorldlineRenderer` 用。
> - `OtoFrq` 的消费方：`ClassicSinger` **已在 P2 搬完**；剩"把 `OtoFrq` 挂到 `UOto` 上"
>   这一步（类型本身在 `frq.py` 里）。

### ~~P1-d —— 把两端串起来~~ ✅ 已完成

`Classic/ClassicRenderer.cs`(152) 与 `RenderEngine.cs` 里的 `Progress`
（渲染器接口需要的那一小块）。**里程碑达成**：`RenderPhrase → 变调 → 拼接 → 样本`
已端到端真机跑通（见第 0 节）。

> **已补齐**：`WorldlineRenderer`(276) + `PhraseSynthV2`（约 240 行）已落地，
> v10（`WORLDLINE-R`，Classic 歌手的默认渲染器）**真机端到端验证**；R1.1/R2 在入口报错。
> 仍未接的是 R1.1 的谐波分支：`HnAnalysisF0In` 绑定 + `Core/Analysis/Hnsep`（ONNX）
> + `SynthSegment` 的 `sp_env_harmonic` 传递。

### P1-c —— 外部工具线（独立可选）

`Util/Base64.cs`(77) + `Util/ProcessRunner.cs`(95) + `OS.cs`(119) +
`Classic/ExeResampler.cs`(141) / `ExeWavtool.cs`(224) / `UnixWavtool.cs` /
`ToolsManager.cs`(140) / `VoicebankFiles.cs`(122)。

> 只服务"用户自备 resampler/wavtool"（OpenUTAU 的原生用法）。`ToolsManager` 里
> `SearchWavtools` 会构造 `SharpWavtool(true/false)`，所以它必须排在 P1-a 之后
> （现在已满足）。`ExeWavtool` 还顺带决定了"外部路径下谁跑 resampler"这件事
> （见第 6 节陷阱 22）。

### ~~P2 —— 声库与 .frq~~ ✅ 已完成

| 项 | 体量 | 状态 |
|---|---|---|
| `Classic/VoicebankConfig.cs` | 91 行 | ✅ 完成（`classic/voicebank_config.py`） |
| `Classic/VoicebankLoader.cs` | 549 行 | ✅ 完成（`classic/voicebank_loader.py`，含 `FileTrace`） |
| `Classic/VoiceBank.cs` 的 `Voicebank` | 57 行 | ✅ 完成（补进 `oto.py`；`Subbank`/`Oto`/`OtoSet` 原已在） |
| `Classic/ClassicSinger.cs` | 243 行 | ✅ 完成（`classic/classic_singer.py`） |
| `Classic/OtoWatcher.cs` | 42 行 | ✅ 完成（`classic/oto_watcher.py`，监视后端可注入） |
| `Classic/ClassicSingerLoader.cs` | 30 行 | ✅ 完成（`classic/classic_singer_loader.py`，歌手工厂可注册） |
| `OtoFrq` 接进 `UOto`（MOD+ 在运行期消费它） | — | ✅ 完成（`render_phrase._apply_mod_plus`） |

> 说明：C# 里并没有一个叫 `UOtoFrq` 的类型 —— 那就是 `UOto.Frq`（`OtoFrq?`）。
> MOD+ 在**第一次用到时**惰性 `new OtoFrq(oto, cSinger.Frqs)` 并挂在 oto 上，
> 同时缓存进 `ClassicSinger.Frqs`（按 wav 路径为键），所以同一音源只分析一次。

本轮（声库侧）顺带补上的两个"不搬就缺零件"的东西：
`oto.Voicebank`（`character.txt` + `character.yaml` + oto 摊平后的结果，含它的
`reload()`）与 `classic/voicebank_loader.FileTrace`（`Oto.file_trace` 的真实类型）。
`Preferences` 也补了 `load_deep_folder_singer`（**默认 true**，`SearchAll` 靠它决定是否递归）。

**新加的一致性断言**（`test_openutau_core_matches_source.py`）：
- `VoicebankConfig.cs`：枚举名 / 18 个字段的**名字与声明顺序** / 每个默认值
  （含 `0.67f`、三态 `bool?`、引用类型必须是 `None` 而不是 `''`）/ `OmitNull` 写盘与
  未知键忽略 / 往返。
- `VoicebankLoader.cs`：6 个 `kXxx` 常量 / 20 个成员名逐项落地 / `FileTrace.copy` 独立 /
  `.NET shift_jis → cp932` / `_cs_double` 的 `"0"`、`"1E-05"` / `parse_double` 的
  "空串算成功" / `_read_lines` 的三种换行 / **oto 六种行形态**（合法、空别名回退、截断行
  判有效、数值报错、无 `=`、空行）/ `FileTrace` 每行独立且行号递增 /
  `CheckWavExist` 的缺失标记 / `AddFilenameAlias` 的"同名不重复加"与 `FileTrace` 共享 /
  `write_oto_set` 往返逐字符一致 / `#Charset:` 的"不 trim"怪癖与 10 行上限 / BOM 检测 /
  `character.txt` 的键识别与死代码 quirk / 判型（配置优先 + 遗留 dsconfig）/ `ApplyConfig`
  的引用语义 / `prefix.map` 去重与音域分段 / `SearchAll` 的深/浅两档。

### P3 —— 更多音素化器（当前 8 / 51）

**两条基类线现在都就位了**（`SyllableBased` 2204 / `PhonemeBased`+`Monophone`+`LatinDiphone` 292），
所以下面这些基本是"照着 C# 逐个转写 + 配一致性测试"的体力活。优先级建议：

1. `SyllableBased` 家族里**只用文本字典、不依赖语言 G2p 类**的：
   `FrenchCVVC`(757，**已完成**) —— 它们是新基类的**真实用户**
2. 直接继承 `Phonemizer` 的独立实现：`TurkishCVVC`(356，**已完成**)
3. `JapanesePresampPhonemizer` / `PresampSamplePhonemizer`（还需 `Classic/Presamp.cs` 731）
4. `ChineseCVVPlusPhonemizer`（中文线补全）
5. **`ArpasingPhonemizer`(62)**：前置（`LatinDiphone` + `ArpabetG2p` + 字典）**都已完成**，
   只剩随包 `arpasing.yaml` 词典数据要一起搬
6. 韩语系列 / 欧洲各语系（大多要先搬 `Core/G2p` 的语言 G2p 类）

### P4 —— 编辑器侧（M3）

`ustx` 读写已就绪，但编辑器（钢琴卷帘 / 音素编辑 / 音高曲线）尚未接。
另需 `Render/RenderEngine.cs`(542) / `RealCurveUpdater.cs`(214) / `RenderView.cs`(185)。

---

## 9. 里程碑

| 里程碑 | 判据 |
|---|---|
| ~~M1 抽象层~~ | ✅ 已完成（`singing/api.py` + 适配器） |
| ~~M2-c `.ustx` 双向兼容~~ | ✅ 已完成 |
| **M2-a 渲染器主体** | ✅ Classic 线全通：`CLASSIC` 与 `WORLDLINE-R` 两条路径**都真机跑通**（含 MOD+）；R1.1/R2 缺外部依赖（入口报错） |
| **M2-b 音素化器** | 🟡 3 / 51 |
| **M2 渲染输入链路** | ✅ 完成（P0）：`歌词 → 音素 → 乐句 → RenderPhrase[]`，可断言哈希 |
| **M2 拼接出声** | ✅ 完成（P1-a）：`RenderPhrase → 音素 wav 拼接`（`SharpWavtool`） |
| **M2 变调出声** | ✅ 完成（P1-b）：`音素 wav → 按音高拉伸`（`Worldline.Resample`，真机验证） |
| **~~M2 端到端可跑~~** | ✅ **完成（P1-d）**：`歌词 → 音素 → 乐句 → 变调 → 拼接 → 样本`（真机验证主频） |
| **~~M2 声库侧~~** | ✅ **完成（P2）**：`character.txt/yaml + oto.ini + prefix.map` → `ClassicSinger` → oto 查询 |
| M3 编辑器替换 | ⬜ |
| M4 删除旧的 UTAU / DiffSinger 模块 | ⬜ 等音素化器与编辑器接完，且已冻结基线 `openutau-port-baseline` |

---

## 10. 提交约定

一个 C# 文件（或其紧密小簇）一个 commit。commit message 必须包含：

1. **照搬范围**（Python 文件 ↔ C# 文件）
2. **本轮发现的上游怪癖**（死代码 / 重复赋值 / 语义不一致…）
3. **与 C# 的载体差异**（第三方库替换、全局单例替换、容器类型替换）
4. **测试数量变化**
5. **下一步**

> "发现"比"写了多少行"更有价值 —— 它是唯一能防止后人重踩的东西。
