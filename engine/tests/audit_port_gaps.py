# -*- coding: utf-8 -*-
"""照搬审计：把「Python 侧还缺什么」交给机器找出来。

`test_openutau_core_matches_source.py` 是**逐项断言**——它只覆盖写断言的人想到的地方。
本脚本补另一面：**枚举式的差异扫描**，用来回答两个问题：

  1. **文件级**：上游某个目录下还有哪些 `.cs` 没有任何 Python 对应物？
  2. **成员级**：已经搬过来的模块里，C# 的哪些公开成员在 Python 侧找不到名字对应的东西？

用法：
    python tests/audit_port_gaps.py            # 全量
    python tests/audit_port_gaps.py Classic    # 只看名字里含 Classic 的行

**这是启发式扫描，不是判据**：C# 与 Python 的命名不可能一一对齐
（`ClassicSingerLoader` 的属性 `Resamplers` → `resamplers` 对得上，
但 `nameConvergence` → `NAME_CONVERGENCE` 就得靠归一化；有些成员是上游死代码，
本就**不该**照搬）。所以输出要人工过一遍，它的价值在于"不遗漏"，而不是"自动判错"。
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

REF_ROOT = os.environ.get('OPENUTAU_REF') or r'D:/FuFuMIDI/_ref/OpenUtau'
CORE = os.path.join(REF_ROOT, 'OpenUtau.Core')
BUILTIN = os.path.join(REF_ROOT, 'OpenUtau.Plugin.Builtin')
PKG = os.path.join(ENGINE, 'singing')

#: **搬运范围**：这些 C# 目录/文件才在本次移植的目标里。
#: 其余（Analysis / Audio / Commands / DawIntegration / DiffSinger / Vogen / UI /
#: MachineLearning / PackageManager …）属于**编辑器层与 AI 层**，不在"引擎照搬"范围内 ——
#: 不过滤的话审计会吐出 200 多条与本次目标无关的噪声。
SCOPE = (
    'Core/Ustx/',
    'Core/Classic/',
    'Core/Render/',
    'Core/Pipeline/',
    'Core/Api/',
    'Core/G2p/',
    'Core/Format/USTx.cs',       # 只搬 .ustx（其余格式是另一个立项）
    'Core/Util/',
    'Core/BaseChinesePhonemizer.cs',
    'Builtin/',
    # ---- OpenUtau.Core **根目录**的文件（原先整个目录都不在 SCOPE 里，
    #      等于 7 个文件 / 3507 行处于审计盲区）。其中 KoreanPhonemizerUtil(1619)
    #      是 7 个韩语音素化器的硬依赖、PlaybackManager(688) 里有 RenderView 要的
    #      MixPlanner —— 不登记就等于"看不见"。逐个列出而不是放行 'Core/'，
    #      因为 'Core/' 会把 DiffSinger/Enunu/Vogen/Analysis 等整套拉进来。
    'Core/KoreanPhonemizerUtil.cs',
    'Core/PlaybackManager.cs',
    'Core/DocManager.cs',
    'Core/SingerManager.cs',
    'Core/PackageManager.cs',
    'Core/MachineLearningPhonemizer.cs',
    'Core/DefaultPhonemizer.cs',
)

#: 范围内的**已知例外**（内嵌资源的设计器文件、纯 UI 辅助等，有意不搬）
OUT_OF_SCOPE = (
    'Resources.Designer.cs',
    'Core/Util/Onnx.cs',            # ONNX 会话封装 → 由宿主注入（见 G2pPack 的决策）
    'Core/Util/CudaGpuDetector.cs',  # GPU 探测 → 主进程 main/gpu.js 已负责
    'Core/Util/EditTool.cs',
    'Core/Util/Frozen.cs',
    'Core/Util/IniFileClass.cs',
    'Core/Util/Json.cs',
    'Core/Util/LibraryLoader.cs',
    'Core/Util/LivePitchMode.cs',
    'Core/Util/LocalizedSort.cs',
    'Core/Util/LyricsHelper.cs',
    'Core/Util/MessageCustomizableException.cs',
    'Core/Util/NotePresets.cs',
    'Core/Util/ReleaseChannel.cs',
    'Core/Util/SingletonBase.cs',
    'Core/Util/SplitLyrics.cs',
    'Core/Util/ThreadGuard.cs',
    'Core/Util/WindowSize.cs',
    'Core/Util/YamlValidator.cs',
    'Core/Util/YamlValues.cs',
    'Core/Util/Zip.cs',
    'Core/Util/PathManager.cs',      # 全局单例 → ClassicHost 的字段
    'Core/Util/Preferences.cs',      # 全局单例 → singer.Preferences
)


def in_scope(label: str, rel: str) -> bool:
    full = label + '/' + rel.replace('\\', '/')
    if not any(full.startswith(s) or full == s for s in SCOPE):
        return False
    return not any(full.startswith(s) for s in OUT_OF_SCOPE)

#: C# 文件名 → Python 模块名（只列**不规则**的；其余按 snake_case 自动推）
EXPLICIT = {
    'IRenderer.cs': 'renderer',
    'Renderers.cs': 'renderers',
    'RenderPhrase.cs': 'render_phrase',
    'RenderEngine.cs': 'render_engine',
    'PhraseSource.cs': 'pipeline_source',
    'PhraseSourceBuilder.cs': 'pipeline_builder',
    'PhraseLayout.cs': 'phrase_layout',
    'Identities.cs': 'pipeline_identities',
    'Snapshots.cs': 'pipeline_snapshots',
    'MusicMath.cs': 'music_math',
    'SplineInterpolate.cs': 'spline',
    'TimeAxis.cs': 'timeaxis',
    'USinger.cs': 'singer',
    'UPhoneme.cs': 'phoneme',
    'UProject.cs': 'model',
    'UTrack.cs': 'model',
    'UPart.cs': 'model',
    'UNote.cs': 'model',
    'UExpression.cs': 'model',
    'UCurve.cs': 'model',
    'UMaskedCurve.cs': 'model',
    'UMixFx.cs': 'model',
    'Ustx.cs': 'format',
    'USTx.cs': 'format',
    'Yaml.cs': 'io',
    'Phonemizer.cs': 'phonemizer',
    'PhonemizerRunner.cs': 'phonemizer_runner',
    'VoiceBank.cs': 'oto',
    'OS.cs': 'os_util',
    'Base64.cs': 'base64_util',
    'ProcessRunner.cs': 'process_runner',
    'IG2p.cs': 'i_g2p',
    'IG2pSymbols.cs': 'i_g2p',
    'G2pDictionary.cs': 'dictionary',
    'G2pDictionaryData.cs': 'dictionary_data',
    'G2pFallbacks.cs': 'fallbacks',
    'G2pPack.cs': 'pack',
    'G2pRemapper.cs': 'remapper',
    'ArpabetG2p.cs': 'arpabet',
    'BaseChinesePhonemizer.cs': 'base_chinese',
    # ---- Classic：旧插件体系 5 个文件合并进 classic/plugin.py（互相直接调用，
    #      拆开只会制造循环导入）；其余按 C# 文件一一对应。
    'IPlugin.cs': 'plugin',
    'Plugin.cs': 'plugin',
    'PluginLoader.cs': 'plugin',
    'PluginRunner.cs': 'plugin',
    'ExeInstaller.cs': 'plugin',
    'UstFlag.cs': 'ust_flag',
    'UstFlagParser.cs': 'ust_flag',
    'Ust.cs': 'ust',
    'UstNote.cs': 'ust_note',
    'Presamp.cs': 'presamp',
    'VoicebankErrorChecker.cs': 'voicebank_error_checker',
    'PresampWatcher.cs': 'presamp_watcher',
    # ---- Core/G2p 的 12 个神经网络/词典 G2p 一一对应到 g2p/<name>.py
    'JapaneseMonophoneG2p.cs': 'japanese_monophone',
    # Core/G2p 其余 10 个（由 g2p/_gen_g2p_modules.py 生成 + korean 手写）
    'FilipinoG2p.cs': 'filipino',
    'FrenchG2p.cs': 'french',
    'FrenchMillefeuilleG2p.cs': 'french_millefeuille',
    'GermanG2p.cs': 'german',
    'GermanMarzipanG2p.cs': 'german_marzipan',
    'ItalianG2p.cs': 'italian',
    'KoreanG2p.cs': 'korean',
    'PortugueseG2p.cs': 'portuguese',
    'RussianG2p.cs': 'russian',
    'SpanishG2p.cs': 'spanish',
    'ArpabetPlusG2p.cs': 'arpabet_plus',
    # ---- Api：PhonemizerFactory 与 PhonemizerInstaller 合并进 openutau/api.py
    'PhonemizerFactory.cs': 'api',
    'PhonemizerInstaller.cs': 'api',
    # ---- Core/Render：编辑器侧（波形/优先级/曲线），一一对应
    'RenderPriority.cs': 'render_priority',
    'RenderProjection.cs': 'render_projection',
    'WaveformRefresh.cs': 'waveform_refresh',
    'RealCurveUpdater.cs': 'real_curve_updater',
    'RenderView.cs': 'render_view',
    'ChineseCVVPlusPhonemizer.cs': 'chinese_cvv_plus',
}

#: 已人工核实「**不是**缺口」的项，键为 `类名:成员名`。
#: 记在这里，下次审计就不会重复出现；**加一项必须写明理由**，
#: 否则这个清单会变成"把噪声藏起来"的地方。
KNOWN_NON_PORT = {
    # ---- 载体差异：命名 / 落点不同，但语义对应
    'ClassicSinger:Empty': '模块常量 OTO_DATA_EMPTY 取代嵌套静态字段 OtoData.Empty',
    'USTx:Load': '静态类方法 → ustx/io.py 的 load_ustx()',
    'USTx:Save': '静态类方法 → ustx/io.py 的 save_ustx()',
    'VoicebankConfig:Subbank': 'C# 把 Subbank 定义在这个文件；本仓库按第 7 节决策放在 oto.py',
    'VoicebankConfig:Color': '同上（Subbank.Color → oto.Subbank.color）',
    'VoicebankConfig:Prefix': '同上',
    'VoicebankConfig:Suffix': '同上',
    'VoicebankConfig:ToneRanges': '同上（→ oto.Subbank.tone_ranges）',
    'BaseChinesePhonemizer:SetUp': '本仓库的 BaseChinesePhonemizer 有意不继承 Phonemizer（见其 docstring）',
    # ---- 类名 / 嵌套类型，不是成员
    'Renderers:Renderers': '类型名，不是成员',
    'Worldline:Worldline': '类型名，不是成员',
    'Worldline:Item': '嵌套类型名，不是成员',
    'PhraseSource:In': '嵌套类型名，不是成员',
    'PhraseSource:Out': '嵌套类型名，不是成员',
    'ClassicSingerLoader:ClassicSingerLoader': '类型名，不是成员',
    # ---- 合并模块：多个 C# 文件放进一个 Python 模块（理由写清楚，便于将来拆开）
    'IPlugin:IPlugin': 'C# 的 interface IPlugin 与 Plugin/PluginLoader/PluginRunner/ExeInstaller 同属一套\n                       旧插件体系，合并在 classic/plugin.py（互相直接调用，拆开只会制造循环导入）',
    'Plugin:Plugin': '合并在 classic/plugin.py（同 IPlugin 一条）',
    'PluginRunner:from': 'C# 的 `static PluginRunner from(...)` —— **from 是 Python 关键字**，'
                       'def from(...)` 是语法错误，所以改名为 `from_host` 并在 docstring 里标注对应关系',
    'PluginLoader:PluginLoader': '合并在 classic/plugin.py（同上）',
    'PluginRunner:PluginRunner': '合并在 classic/plugin.py（同上）',
    'ExeInstaller:ExeInstaller': '合并在 classic/plugin.py（同上）',
    'UstFlagParser:UstFlagParser': 'UstFlag 与 UstFlagParser 同属 68 行的小工具，合并在 classic/ust_flag.py',
    'VoicebankInstaller:VoicebankInstaller': '编辑器侧：从网页下载并安装声库的 UI 流程。引擎只需要\n                       "声库已在磁盘上"这个前提，不需要下载器 —— 超出内嵌引擎范围',
    'VoicebankPublisher:VoicebankPublisher': '编辑器侧：把声库打包成可发布 zip 的 UI 流程，同上超出范围',
    'Resources:Resources': 'Data/Resources.Designer.cs 是 WinForms 的**设计器残留**（资源名常量），\n                       本引擎用不到任何 WinForms 资源',
    'RenderPriority:RenderPriority': 'C# 是 `internal static class RenderPriority`（纯静态类），'
                              'Python 侧是**模块级函数**（无状态、无需类） —— 与 Ust/Renderers 同类误报',
    'Ust:Ust': 'C# 是 `public static class Ust`（纯静态类），Python 侧是**模块** classic/ust.py，没有同名类 —— 与 Renderers/Yaml 同类误报',
    'MusicMath:KeyColor': '嵌套枚举 `enum KeyColor { White, Black }` → 本仓库按枚举约定存字符串名'
                          '（见 `ustx/model.py` 开头的约定），不是成员缺口',
    # ---- 已知在册的后续项（由 §8 跟踪，不必每次重报）
    'RenderEngine:DispatchInFlight': 'M3（渲染引擎的线程/调度）',
    'RenderEngine:PreRenderProject': 'M3',
    'RenderEngine:ReleaseSourceTemp': 'M3',
    'RenderEngine:RenderTracks': 'M3',
    'RenderEngine:completedPhrases': 'M3',
    'RenderEngine:part': 'M3',
    'RenderEngine:phraseEstimatedLengthMs': 'M3',
    'RenderEngine:phraseOffsetMs': 'M3',
    'RenderEngine:phrases': 'M3',
    'RenderEngine:timestamp': 'M3',
    'RenderEngine:trackNo': 'M3',
    'PhonemizerRunner:Dispose': 'M3（线程/调度；本仓库只搬同步版 Phonemize）',
    'PhonemizerRunner:Push': 'M3',
    'PhonemizerRunner:WaitFinish': 'M3',
    'Worldline:DecodeMgc': 'R1.1 缺 ONNX 谐波分离模型，入口报错（见 §7 决策）',
    'Worldline:DecodeBap': 'R1.1 同上',
}

#: **成员级扫描对这些 C# 文件没有意义**（前缀匹配），每条都要写理由。
#: 它们要么是「逻辑被有意挪到按职责命名的模块」，要么是「只有类名/嵌套类型」。
SKIP_MEMBER_CHECK = {
    'Core/Ustx/UNote.cs': '逻辑有意挪走：`Validate`/`ToPhonemizerNote` → `part_validate.py`；'
                          '`Split`/`AddPoint`/`SetExpression` 等属**编辑器侧（M3）**',
    'Core/Ustx/UPart.cs': '同上：音素化段 → `part_validate.py` / `pipeline_source.py`；'
                          '`UpdatePhrases` 属 M3',
    'Core/Ustx/UProject.cs': '同上：`CreateNote`/`RegisterExpression`/`Validate` 属**编辑器侧（M3）**',
    'Core/Ustx/UTrack.cs': '同上：`Validate`/`GetSupportedExps` 属编辑器侧（M3）',
    'Core/Ustx/USinger.cs': '`UOto`/`UOtoSet`/`USubbank` 的类型名与属性已按载体差异落成 '
                            '`oto.py` 的 property（`snake` 对 `MacOS` 这类缩写切分不完美，'
                            '会算成 `is_color_match` 之外的形态）',
    'Core/Ustx/UPhoneme.cs': '`UEnvelope`/`UPhonemeOverride` 是嵌套类型名；其余属 M3',
    'Core/Ustx/TimeAxis.cs': '方法名已在本仓库落地（tick↔ms 系列），差异属归一化',
    'Core/Ustx/UExpression.cs': '（**不跳过** —— 见下）',
    'Core/Util/Base64.cs': '静态类 → 模块级函数（`base64_util.encode_int12_list` 等）',
    'Core/Util/OS.cs': '静态类 → 模块级函数；且 `IsMacOS` 的归一化在这里会算成 `is_mac_os`'
                       '而本仓库写 `is_macos`（首字母缩写大小写，纯命名差异）',
    'Core/Util/ProcessRunner.cs': '静态类名本身，不是成员',
    'Core/Util/Yaml.cs': 'YamlDotNet 的序列化器封装 → `ustx/io.py` 的 `dump_yaml`/`load_yaml`',
    'Builtin/CantoneseSyoPhonemizer.cs': '内嵌类型名 `JyutpingConversion`；`ChangeLyric` 走基类的 '
                                        '`change_lyric`',
    'Builtin/ChineseCVVPlusPhonemizer.cs': '内嵌的 `FlowStyleIntegerSequences` 是 YamlDotNet '
                                           '事件发射器 → 载体替换成 PyYAML 选项',
    'Builtin/SyllableBasedPhonemizer.cs': '`from` 是 C# 关键字残留，不是成员',
    'Builtin/TurkishCVVCPhonemizer.cs': '`Has9BeforeVow` 实现成了模块级辅助，不是类成员',
    'Core/Classic/Ini.cs': '`ToString` → `__str__` 未搬（已在 §4.1 记在册，属次要缺口）',
}

#: 上面那个"跳过"集合**不覆盖**的文件（曲线原语——它们的逻辑没有"按职责命名的模块"可去，
#: 属真缺口，必须留在输出里）。注意 `UExpression` 的键在上面是占位说明，真正的判据在这里。
SKIP_EXCEPT = {
    'Core/Ustx/UExpression.cs',
}


def snake(name: str) -> str:
    """PascalCase / camelCase → snake_case（对齐项目里的字段命名）。"""
    s = re.sub(r'(.)([A-Z][a-z]+)', r'\1_\2', name)
    s = re.sub(r'([a-z0-9])([A-Z])', r'\1_\2', s)
    return s.lower()


def module_candidates(filename: str):
    """C# 文件名 → 可能的 Python 模块名（按优先级）。

    ★ 内置音素化器的模块名去掉了尾巴上的 `Phonemizer`（`ChineseCVVCPhonemizer.cs`
    → `chinese_cvvc.py`），所以要把这一形态也放进候选，否则会误报成"未搬"。
    """
    if filename in EXPLICIT:
        return [EXPLICIT[filename]]
    base = filename[:-3]
    cands = [snake(base)]
    if base.endswith('Phonemizer') and base != 'Phonemizer':
        cands.append(snake(base[:-len('Phonemizer')]))
    return cands


def find_py(cands):
    """在包里按候选模块名找 .py（返回相对包的路径）。"""
    hits = []
    for root, _d, files in os.walk(PKG):
        for f in files:
            if f.endswith('.py') and f[:-3] in cands:
                hits.append(os.path.relpath(os.path.join(root, f), PKG))
    return sorted(hits)


def cs_members(text: str):
    """抽出 C# 里"看起来该照搬"的成员名。

    只取 `public` / `internal` 的方法、属性、常量、字段；
    跳过构造器、`override` 里对基类的重复声明不算（同名仍会去重）、以及纯 UI 类型。
    """
    out = set()
    body = re.sub(r'///.*', '', text)                     # 去 XML 文档注释
    body = re.sub(r'/\*.*?\*/', '', body, flags=re.S)
    # 方法：`public [static|virtual|override|async] Ret Name(`
    for m in re.finditer(r'\b(?:public|internal)\s+(?:static\s+|virtual\s+|override\s+|async\s+|'
                         r'new\s+|sealed\s+|partial\s+)*[\w<>\[\],\.\?]+(?:\s*<[^>]*>)?\s+'
                         r'([A-Za-z_]\w*)\s*\(', body):
        out.add(m.group(1))
    # 属性 / 字段：`public Type Name { get;` 或 `public Type Name =` / `public const Type Name`
    for m in re.finditer(r'\b(?:public|internal)\s+(?:static\s+|readonly\s+|const\s+|override\s+|'
                         r'virtual\s+)*[\w<>\[\],\.\?]+(?:\s*<[^>]*>)?\s+([A-Za-z_]\w*)\s*'
                         r'(?:\{|=>|=|;)', body):
        out.add(m.group(1))
    out -= {'get', 'set', 'if', 'for', 'while', 'return', 'new', 'class', 'struct', 'record'}
    return out


def py_members(path: str):
    """抽出 Python 模块里所有可当"成员"的名字。

    要覆盖四种形态，否则会大量误报：
      · 模块级函数与类（`def f` / `class C`）
      · 模块级常量（`NAME = ...`）
      · 类体里的属性（`name = ...`）
      · **实例字段**（`self.name = ...`）与 `__slots__ = ('a', 'b')`
    """
    text = open(path, encoding='utf-8').read()
    names = set()
    for m in re.finditer(r'^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)', text, re.M):
        names.add(m.group(1))
    for m in re.finditer(r'^\s*class\s+([A-Za-z_]\w*)', text, re.M):
        names.add(m.group(1))
    for m in re.finditer(r'^\s*([A-Za-z_]\w*)\s*[:=]', text, re.M):
        names.add(m.group(1))
    for m in re.finditer(r'\bself\.([A-Za-z_]\w*)\s*[:=]', text):     # 实例字段
        names.add(m.group(1))
    for m in re.finditer(r'__slots__\s*=\s*\(([^)]*)\)', text, re.S):  # __slots__
        for a, b in re.findall(r"'([^']+)'|\"([^\"]+)\"", m.group(1)):
            names.add(a or b)
    return names


#: C# 里"名字不同但语义对应"的成员（不是缺口）。
#: ★ **不要**把 `Equals` 放进来：上游 `UExpressionDescriptor.Equals(other)` 是**带归一化的
#:   值比较**（"空 options 与 None 视为相同"），与 Python dataclass 的 `__eq__` 语义不同
#:   —— 它在 Python 侧是一个真实方法 `equals()`，必须被当成成员来查。
RENAMED = {
    'ToString': {'__str__'},
    'GetHashCode': {'__hash__'},
    'Item': {'__getitem__'},
}


def has_member(py_names, cs_name: str) -> bool:
    """C# 成员名在 Python 侧有没有（归一化后）对应物。

    候选形态要够宽，否则全是误报：
      · `ResamplerItem`（原名） / `resampleritem`（全小写） / `resampler_item`（snake）
      · `RESAMPLER_ITEM`（常量） / `resamplerItem`（camel）
      · ★ C# 的 **`kXxx` 常量前缀**（`kCharTxt`）→ 也要试去掉 `k` 的形态
        （本仓库把 `kCharTxt` 写成了 `CHAR_TXT`）
    """
    if cs_name in RENAMED:
        return bool(RENAMED[cs_name] & py_names)

    forms = {cs_name}
    # C# 的 `kFoo` 常量约定：去掉 k 再归一化
    if len(cs_name) > 1 and cs_name[0] == 'k' and cs_name[1].isupper():
        forms.add(cs_name[1:])

    cands = set()
    for f in forms:
        s = snake(f)
        parts = s.split('_')
        camel = parts[0] + ''.join(p[:1].upper() + p[1:] for p in parts[1:])
        cands |= {f, f.lower(), f.upper(), s, s.upper(), camel,
                  camel[:1].upper() + camel[1:], '_' + s}
    cands |= {n.lstrip('_') for n in cands}
    return any(n in py_names for n in cands)


def main():
    filt = sys.argv[1] if len(sys.argv) > 1 else ''
    print('上游参考：%s' % REF_ROOT)
    print('Python 包：%s' % PKG)
    print()

    rows = []
    scanned = 0
    for base, label in ((CORE, 'Core'), (BUILTIN, 'Builtin')):
        if not os.path.isdir(base):
            continue
        for root, _dirs, files in os.walk(base):
            for f in sorted(files):
                if not f.endswith('.cs'):
                    continue
                cs_path = os.path.join(root, f)
                rel = os.path.relpath(cs_path, base)
                if not in_scope(label, rel):
                    continue
                full = label + '/' + rel.replace('\\', '/')
                if (any(full.startswith(s) for s in SKIP_MEMBER_CHECK)
                        and full not in SKIP_EXCEPT):
                    continue
                if filt and filt.lower() not in rel.lower():
                    continue
                module = EXPLICIT.get(f) or snake(f[:-3])
                hits = find_py(module_candidates(f))
                if not hits:
                    rows.append(('MISSING_FILE', label + '/' + rel, '|'.join(module_candidates(f)), []))
                    continue
                scanned += 1
                py_names = set()
                for h in hits:
                    py_names |= py_members(os.path.join(PKG, h))
                text = open(cs_path, encoding='utf-8-sig').read()
                cls = os.path.splitext(f)[0]
                gaps = [m for m in sorted(cs_members(text))
                        if not has_member(py_names, m)
                        and ('%s:%s' % (cls, m)) not in KNOWN_NON_PORT]
                rows.append(('OK', label + '/' + rel, ','.join(hits), gaps))

    missing = [r for r in rows if r[0] == 'MISSING_FILE']
    with_gaps = [r for r in rows if r[0] == 'OK' and r[3]]

    print('=== 1) 文件级：没有任何 Python 对应物的 .cs（%d 个）===' % len(missing))
    for _s, rel, module, _g in missing:
        print('  %-58s (期望模块名 %s)' % (rel, module))
    print()

    print('=== 2) 成员级：已搬模块里 C# 有、Python 未见名字的成员（%d 个文件）===' % len(with_gaps))
    for _s, rel, py, gaps in with_gaps:
        print('  %-46s → %s' % (rel, py))
        for g in gaps:
            print('        · %s  (期望 %s)' % (g, snake(g)))
    print()

    print('已扫到对应物的 .cs：%d 个' % scanned)
    print('有未覆盖成员的文件：%d 个' % len(with_gaps))
    return 0


if __name__ == '__main__':
    sys.exit(main())
