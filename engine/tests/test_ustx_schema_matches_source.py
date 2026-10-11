# -*- coding: utf-8 -*-
"""「照搬」一致性校验：Python 的 ustx 模型 vs OpenUTAU 的 C# 源码。

用户方针：**除外观外不允许自研**。所以这个测试把 C# 源码里的
「非 [YamlIgnore] 的公开字段/属性」自动抽出来，和我们的数据类字段集逐项比对，
缺一个、多一个都算 FAIL —— 让"照搬"由机器强制，而不是靠人记。

需要参考源码在 `_ref/OpenUtau`（找不到就 SKIP，不当失败）。
可离线运行：python engine/tests/test_ustx_schema_matches_source.py
"""

import dataclasses
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

from singing.ustx import model as m  # noqa: E402
from singing.ustx.io import _yaml_key  # noqa: E402

REF = os.environ.get('OPENUTAU_REF') or r'D:/FuFuMIDI/_ref/OpenUtau/OpenUtau.Core/Ustx'

# C# 类 → 我们的类（文件、C# 类名、Python 类、要一并计入的基类）
CLASS_MAP = [
    ('UProject.cs', 'UProject', m.UProject, ()),
    ('UProject.cs', 'UTempo', m.UTempo, ()),
    ('UProject.cs', 'UTimeSignature', m.UTimeSignature, ()),
    ('UTrack.cs', 'URenderSettings', m.URenderSettings, ()),
    ('UTrack.cs', 'UTrack', m.UTrack, ()),
    ('UMixFx.cs', 'UMixFx', m.UMixFx, ()),
    ('UPart.cs', 'UPart', m.UPart, ()),
    ('UPart.cs', 'UVoicePart', m.UVoicePart, ('UPart',)),
    ('UPart.cs', 'UWavePart', m.UWavePart, ('UPart',)),
    ('UNote.cs', 'UNote', m.UNote, ()),
    ('UNote.cs', 'UPitch', m.UPitch, ()),
    ('UNote.cs', 'UVibrato', m.UVibrato, ()),
    ('UNote.cs', 'PitchPoint', m.PitchPoint, ()),
    ('UExpression.cs', 'UExpressionDescriptor', m.UExpressionDescriptor, ()),
    ('UExpression.cs', 'UExpression', m.UExpression, ()),
    ('UCurve.cs', 'UCurve', m.UCurve, ()),
    ('UMaskedCurve.cs', 'UMaskedCurve', m.UMaskedCurve, ()),
    ('UMaskedCurve.cs', 'UMaskedRun', m.UMaskedRun, ()),
    ('UPhoneme.cs', 'UPhonemeOverride', m.UPhonemeOverride, ()),
]

# 已验证**不参与序列化**的键（人工核对过对应的 C# 声明），不算缺字段
VERIFIED_NOT_SERIALIZED = {
    'display_name',     # UPart: [YamlIgnore] public virtual string DisplayName { get; }；子类也是 => 计算属性
}

# 我们的模型里有、但属于运行时基础设施的字段（不作比对）
KNOWN_EXTRA = {
    ('UProject', 'resolution'),        # C# 是 => 表达式属性 + 无 set
    ('UTrack', 'singer_obj'), ('UTrack', 'voice_color_exp'), ('UTrack', 'voice_color2_exp'),
    # 轨道级语言（上游 USingerTrack.Language 的语义落在轨道上；7d41d27 有意添加）
    ('UTrack', 'language'),
    ('URenderSettings', 'renderer_obj'), ('URenderSettings', 'resampler_obj'),
    ('URenderSettings', 'wavtool_obj'),
    ('UVoicePart', 'render_phrases'),
}


def underscored(name):
    """模拟 YamlDotNet 的 UnderscoredNamingConvention。"""
    out = re.sub(r'(?<!^)(?=[A-Z])', '_', name)
    return out.lower()


_TYPE_NOISE = {'int', 'string', 'bool', 'float', 'double', 'void', 'long', 'short',
               'byte', 'char', 'object', 'decimal', 'class', 'var'}


def _member_name(body):
    """从一行「去掉 public 前缀」的 C# 声明里取出会被序列化的成员名，取不到返回 None。

    做法：**从行尾倒推**——声明必然以 `;` 或 `{...}`（可再跟 `= ...;`）收尾，
    紧挨着的那串标识符就是成员名。这样不受「类型里有逗号/空格/泛型」影响。
    """
    body = body.strip().replace('@', '')   # C# 关键字转义：`@in` / `@out`，真实标识符是 in/out
    if body.startswith('static '):
        body = body[len('static '):].strip()
    if body.startswith('const '):          # const 字段不参与序列化（如 UCurve.interval）
        return None
    if re.match(r'^(?:abstract\s+|sealed\s+|partial\s+)*class\b', body):
        return None
    # 跨行的属性声明：`public float @in {` / `public USinger Singer {` 这种只开了个头。
    # 必须排除 enum/struct/interface，否则 `public enum PitchPointShape {` 会被当成属性。
    mb = re.match(r'^(?:static\s+)?(?!enum\b|struct\b|interface\b)[\w<>,\[\]\?\.]+\s+(\w+)\s*\{\s*$', body)
    if mb:
        return mb.group(1)
    m = re.search(r'(\w+)\s*((?:\{[^{}]*\}\s*(?:=[^;]*;)?)|(?:=[^;]*;)|;)\s*$', body)
    if not m:
        return None
    head, name, tail = body[:m.start(1)], m.group(1), m.group(2)
    if '(' in head or '=>' in head:       # 方法 / 构造函数 / 表达式属性
        return None
    if body.count('{') != body.count('}'):  # 跨行声明，本行解析不了
        return None
    if tail.startswith('{') and 'set' not in tail:
        return None                        # 只读属性不序列化
    return name


def yaml_keys_of_cs(path, cls):
    """抽出某个 C# 类里会被 YAML 序列化的成员名（已转成下划线键）。

    要处理的几种真实写法（踩过的坑）：
      - `public string renderer;`                          → 字段
      - `public double Volume { set; get; }`               → 有 set 的属性
      - `public string TrackName { get; set; } = "x";`     → 带初始化器的属性
      - `public Dictionary<string, X> expressions = ...;`  → 泛型类型里含**空格和逗号**
      - `[YamlIgnore] public bool Muted { ... }`           → 内联属性，**只忽略本行**
      - `[YamlIgnore]` 独立一行                            → 只忽略下一行
      - `public int End => position + duration;`           → 表达式属性，不序列化
      - `[YamlMember(Alias = "phonemizer", ...)]`          → 序列化键是**别名**（YamlDotNet 读写都生效）
    """
    src = open(path, encoding='utf-8-sig').read().replace('\r\n', '\n').split('\n')
    start = None
    for i, l in enumerate(src):
        if re.match(r'^\s*public\s+(?:abstract\s+|sealed\s+|partial\s+)?class\s+%s\b' % re.escape(cls), l):
            start = i
            break
    if start is None:
        return None
    end = len(src)
    for j in range(start + 1, len(src)):
        if re.match(r'^\s*(public|internal)\s+(?:abstract\s+|sealed\s+|partial\s+)?class\s+\w+', src[j]):
            end = j
            break

    keys = set()
    skip_next = False
    pending_alias = None
    for raw in src[start:end]:
        # 行尾注释要先去：`public int key = 0;//Music key...` 这种会让「以 ; 结尾」的判断失效
        s = re.sub(r'\s*//.*$', '', raw).strip()
        if not s:
            continue
        while s.startswith('['):          # 摘掉前导属性（可能多个）
            attr, sep, rest = s.partition(']')
            if not sep:
                s = ''
                break
            rest = rest.strip()
            if 'YamlIgnore' in attr:
                if not rest:
                    skip_next = True      # 独立属性行 → 忽略下一行
                s = ''                    # 内联 → 忽略本行
                break
            # ★ YamlMember(Alias = "x")：序列化键是别名本身（YamlDotNet 的
            #   YamlAttributesTypeInspector 把 Alias 当属性名用，读写都生效）。
            #   如 UNote.PhonemizerOverride 的键是 `phonemizer` 而非
            #   `phonemizer_override` —— 这条必须机器强制，否则加载 OpenUTAU
            #   工程时会静默丢字段。
            ma = re.search(r'Alias\s*=\s*"([^"]+)"', attr)
            if 'YamlMember' in attr and ma:
                pending_alias = ma.group(1)
            s = rest
        if not s:
            continue
        if skip_next:
            skip_next = False
            continue
        if not s.startswith('public '):
            continue
        name = _member_name(s[len('public '):])
        if name:
            keys.add(pending_alias if pending_alias else underscored(name))
            pending_alias = None
    return keys


# 比对用 YAML 键（字段可能带 yaml_name 别名，如 vib_in → in）
def our_keys_of(cls):
    return {_yaml_key(f) for f in dataclasses.fields(cls) if f.metadata.get('yaml') is not False}


_PASS, _FAIL = [], []


def check(label, cond, detail=''):
    (_PASS if cond else _FAIL).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label, ('\n       ' + detail) if (detail and not cond) else ''))


def main():
    if not os.path.isdir(REF):
        print('SKIP: 找不到 OpenUTAU 参考源码 %s' % REF)
        return 0
    for fname, cs_cls, py_cls, bases in CLASS_MAP:
        path = os.path.join(REF, fname)
        if not os.path.isfile(path):
            check('%s: 源文件存在 %s' % (cs_cls, fname), False, '缺文件')
            continue
        want = yaml_keys_of_cs(path, cs_cls)
        if want is None:
            check('%s: 在 %s 中找到类' % (cs_cls, fname), False)
            continue
        if not want:
            check('%s: 抽到字段（C# 侧 ≥1 项）' % cs_cls, False, '抽取器没能解析出任何字段')
            continue
        # 基类字段也要算进来（C# 是继承来的，YamlDotNet 一样会序列化）
        for b in bases:
            bw = yaml_keys_of_cs(path, b)
            if bw:
                want |= bw
        got = our_keys_of(py_cls)
        extra = got - want - {e[1] for e in KNOWN_EXTRA if e[0] == cs_cls}
        missing = want - got - _TYPE_NOISE - VERIFIED_NOT_SERIALIZED
        check('%s: 字段集与 C# 一致（C# 侧 %d 项）' % (cs_cls, len(want)),
              not extra and not missing,
              ('C# 有而我们缺的字段: %s\n       我们多出来的字段: %s'
               % (sorted(missing) or '无', sorted(extra) or '无')))
    print('\n结果: %d passed, %d failed' % (len(_PASS), len(_FAIL)))
    return 1 if _FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
