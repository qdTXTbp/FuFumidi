# -*- coding: utf-8 -*-
"""instrument names → 标准乐器名 + 移调半音数（"变谱"用）

## 为什么需要它

Audiveris 装上 OCR 语言包后能把谱面左侧的乐器名读出来，但读出来的是**原文**，而且带 OCR 误识：

    实测（原神《苍白的骑行》总谱第 1 页）
    Flute 1,2 / Oboe1,2 / Clarinet (135) 1,2 / Bassoon 1,2 / Ham (F) 1,2 /
    Horn (F) 3,4 / Trumpet (Bb) 1,2 / Trumpet (BB) 3 / Trombone 1.2,3 / Tuba /
    Tubular Bells / Glockenspiel / Piano / Piano / SoloViola /
    Violin I I / Violin II . / Viola / Violon Cello / Double Bum

    Ham = Horn（OCR）、Double Bum = Double Bass、Violon Cello = Violoncello、Violin I I = Violin I

两件事靠它解决：

1. **名字归一**：轨名从 "Ham (F) 1,2" 回到 "Horn in F"，用户一眼看得懂；
2. **移调校正**：移调乐器按**记谱音高**写在谱上，MIDI 里必须换成**实际音高**，
   否则 Horn in F 整条低/高一个纯五度、Clarinet/Trumpet in Bb 差大二度 —— 实测那份总谱
   25 个声部里有 8 个是移调乐器，等于三分之一的音是错的。

移调量的符号约定：**实际音高 = 记谱音高 + transpose**（半音）。
例：Horn in F 记谱比实际高纯五度 → transpose = -7。
"""
import re

#: 乐器词表：键是「规范化后的名字片段」，值是 (显示名, 移调半音, 声部族)
#: 片段按长度从长到短匹配，避免 "violin" 抢了 "violoncello"。
INSTRUMENTS = [
    # ---- 木管 ----
    ("piccolo", ("Piccolo", 12, "woodwind")),
    ("altoflute", ("Alto Flute", 0, "woodwind")),
    ("bassflute", ("Bass Flute", 0, "woodwind")),
    ("flute", ("Flute", 0, "woodwind")),
    ("oboe", ("Oboe", 0, "woodwind")),
    ("englishhorn", ("English Horn", -7, "woodwind")),
    ("coranglais", ("English Horn", -7, "woodwind")),
    ("clarinet", ("Clarinet", 0, "woodwind")),          # 具体移调看调号标注（见 key_transpose）
    ("basset", ("Basset Horn", -7, "woodwind")),
    ("bassclarinet", ("Bass Clarinet", -2, "woodwind")),
    ("saxophone", ("Saxophone", -2, "woodwind")),
    ("sax", ("Saxophone", -2, "woodwind")),
    ("bassoon", ("Bassoon", 0, "woodwind")),
    ("contrabassoon", ("Contrabassoon", -12, "woodwind")),
    ("recorder", ("Recorder", 0, "woodwind")),
    # ---- 铜管 ----
    ("horn", ("Horn", 0, "brass")),                     # 具体移调看调号标注
    ("trumpet", ("Trumpet", 0, "brass")),
    ("cornet", ("Cornet", -2, "brass")),
    ("flugelhorn", ("Flugelhorn", -2, "brass")),
    ("trombone", ("Trombone", 0, "brass")),
    ("tuba", ("Tuba", 0, "brass")),
    ("euphonium", ("Euphonium", 0, "brass")),
    ("saxhorn", ("Saxhorn", -7, "brass")),
    # ---- 打击 ----
    ("timpani", ("Timpani", 0, "percussion")),
    ("timp", ("Timpani", 0, "percussion")),
    ("glockenspiel", ("Glockenspiel", 12, "percussion")),
    ("glock", ("Glockenspiel", 12, "percussion")),
    ("xylophone", ("Xylophone", 12, "percussion")),
    ("vibraphone", ("Vibraphone", 0, "percussion")),
    ("marimba", ("Marimba", 0, "percussion")),
    ("celesta", ("Celesta", 12, "percussion")),
    ("tubularbells", ("Tubular Bells", 0, "percussion")),
    ("tubbells", ("Tubular Bells", 0, "percussion")),
    ("chimes", ("Tubular Bells", 0, "percussion")),
    ("crashcymbal", ("Crash Cymbal", 0, "percussion")),
    ("crcym", ("Crash Cymbal", 0, "percussion")),
    ("cymbal", ("Cymbal", 0, "percussion")),
    ("snaredrum", ("Snare Drum", 0, "percussion")),
    ("bassdrum", ("Bass Drum", 0, "percussion")),
    ("triangle", ("Triangle", 0, "percussion")),
    ("tambourine", ("Tambourine", 0, "percussion")),
    ("percussion", ("Percussion", 0, "percussion")),
    ("drum", ("Drum", 0, "percussion")),
    # ---- 键盘 / 弹拨 ----
    ("piano", ("Piano", 0, "keyboard")),
    ("pno", ("Piano", 0, "keyboard")),
    ("keyboard", ("Keyboard", 0, "keyboard")),
    ("organ", ("Organ", 0, "keyboard")),
    ("harpsichord", ("Harpsichord", 0, "keyboard")),
    ("harp", ("Harp", 0, "plucked")),
    ("guitar", ("Guitar", -12, "plucked")),
    ("banjo", ("Banjo", 0, "plucked")),
    ("mandolin", ("Mandolin", 0, "plucked")),
    ("lute", ("Lute", 0, "plucked")),
    # ---- 弦乐 ----
    ("violoncello", ("Violoncello", 0, "strings")),
    ("cello", ("Violoncello", 0, "strings")),
    ("contrabass", ("Double Bass", -12, "strings")),
    ("doublebass", ("Double Bass", -12, "strings")),
    ("doublebum", ("Double Bass", -12, "strings")),      # 实测 OCR 误识
    ("uprightbass", ("Double Bass", -12, "strings")),
    ("bassviolin", ("Double Bass", -12, "strings")),
    ("violin", ("Violin", 0, "strings")),
    ("viola", ("Viola", 0, "strings")),
    ("viol", ("Viol", 0, "strings")),
    ("strings", ("Strings", 0, "strings")),
]

#: OCR / 缩写变体 → 词表里的规范片段（先做这一层替换，再落表）
VARIANTS = [
    ("hn", "horn"), ("ham", "horn"), ("hrn", "horn"), ("cor", "horn"),
    ("tpt", "trumpet"), ("trp", "trumpet"), ("tromp", "trumpet"),
    ("thu", "trombone"), ("tbn", "trombone"), ("tromb", "trombone"),
    ("trb", "trombone"), ("bsn", "bassoon"), ("ban", "bassoon"),
    ("cl", "clarinet"), ("clar", "clarinet"), ("clt", "clarinet"),
    ("ob", "oboe"), ("fl", "flute"), ("flt", "flute"),
    ("vln", "violin"), ("v1n", "violin"), ("vl1", "violin"), ("vno", "violin"),
    ("vla", "viola"), ("vc", "violoncello"), ("vlc", "violoncello"),
    ("violonc", "violoncello"), ("violon", "violoncello"),
    ("cb", "contrabass"), ("db", "doublebass"), ("cbs", "contrabass"),
    ("hp", "harp"), ("hrp", "harp"), ("glock", "glockenspiel"),
    ("timp", "timpani"), ("tmp", "timpani"), ("kettledrum", "timpani"),
    ("perc", "percussion"), ("cym", "cymbal"), ("crcy", "crashcymbal"),
    ("pf", "piano"), ("pft", "piano"), ("klavier", "piano"),
]

_VARIANT_MAP = dict(VARIANTS)
_VARIANT_SORTED = sorted(VARIANTS, key=lambda x: -len(x[0]))
_INSTR_SORTED = sorted(INSTRUMENTS, key=lambda x: -len(x[0]))

#: 调号标注 → 移调半音（只对**同族里会移调**的乐器生效：号/单簧/萨克斯/小号等）
KEY_TRANSPOSE = {
    "c": 0,
    "bb": -2, "b": -2, "bes": -2, "bflat": -2, "135": -2,   # 实测 OCR 把 (Bb) 读成 (135)
    "a": -3,
    "ab": -4, "g#": -4, "as": -4,
    "f": -7,
    "e": -9, "eb": -9, "es": -9, "d#": -9,
    "d": -10,
    "g": -5,
    "db": -1, "c#": -1, "des": -1,
}

#: 哪些族需要用调号标注来定移调（写成 C 的乐器不算）
KEYED_FAMILIES = {"horn", "trumpet", "clarinet", "cornet", "flugelhorn", "saxhorn",
                  "basset", "saxophone", "sax", "englishhorn", "coranglais"}

_CLEAN_RE = re.compile(r"[^a-z0-9#]+")
_TOKEN_RE = re.compile(r"[a-z0-9#]+")

#: 调号标注的默认值：名字里**没写**调号时按常见编制补。
#: 只在 KEYED_FAMILIES 上生效 —— 现代总谱里单簧管/小号默认 Bb、号默认 F。
#: 不补的话会退化成 0（= 不移调），那对移调乐器必然是错的。
KEY_FALLBACK = {
    "clarinet": "bb", "trumpet": "bb", "cornet": "bb", "flugelhorn": "bb",
    "saxhorn": "bb", "horn": "f", "basset": "f", "englishhorn": "f", "coranglais": "f",
}


def norm_key(raw):
    """把谱面上的乐器名压成可匹配的紧凑串：小写、去空格与非字母数字。

    "Horn (F) 1,2" → "hornf12"；"Vln. I" → "vlni"；"Double Bum" → "doublebum"
    """
    s = str(raw or "").lower()
    s = s.replace("flat", "b").replace("sharp", "#")
    s = _CLEAN_RE.sub("", s)
    return s


def _expand_tokens(raw):
    """按**整词**替换缩写变体，再拼成紧凑串（"Cl. (Bb) 1,2" → "clarinetbb12"）。

    整词替换是为了不误伤："cor" 是 horn 的变体，但 "coranglais"/"cornet" 里的
    "cor" 是词的一部分 —— 按子串替换会把英国管读成圆号、短号读成圆号（实测过）。
    """
    out = []
    for tk in _TOKEN_RE.findall(str(raw or "").lower()):
        out.append(_VARIANT_MAP.get(tk, tk))
    return "".join(out)


def _expand_substring(compact):
    """按子串替换（只替换**第一个**命中的变体）—— 老办法，留给连写的情况。

    连写的缩写（"vlnI"、"hnf12"）整词替换认不出来，这一路兜底；顺序仍是长的优先。
    """
    for short, full in _VARIANT_SORTED:
        idx = compact.find(short)
        if idx >= 0:
            return compact[:idx] + full + compact[idx + len(short):]
    return compact


def _key_tag(compact, frag):
    """从**乐器名片段之后**的尾巴里抠调号标注 → "f" / "bb" / "135"。

    ★ 必须是片段的尾巴，不能在整串里搜：老实现拿 "flute12" 里的 "e" 当调号，
      于是"长笛"也带了个 key（对不移调乐器无害，但显示名/调试输出全是错的）。
    "hornf12"(frag=horn) → "f"；"trumpetbb3"(frag=trumpet) → "bb"；"flute12" → ""。
    """
    pos = compact.find(frag)
    if pos < 0:
        return ""
    rest = compact[pos + len(frag):]
    rest = re.sub(r"^in(?=[a-z#0-9])", "", rest)          # "Horn in F" 的 in
    m = re.match(r"(des|135|bb|ab|as|eb|es|db|c#|d#|g#|b|a|f|e|d|g|c)(?=[0-9iv.,]*$)", rest)
    return m.group(1) if m else ""


def match(raw):
    """乐器名 → dict(name, transpose, family, key) ；认不出返回 None。

    ★ 认不出就返回 None，绝不猜：猜错比不认更糟（会把整条声部移调错）。
    """
    compact = norm_key(raw)
    if not compact:
        return None
    # 1) OCR / 缩写变体展开：先按整词（不误伤 coranglais / cornet），再按子串兜底（连写缩写）
    # 原始紧凑串先查一次："Cor anglais" 压成 "coranglais" 正好就是词表键，
    # 先走整词展开反而会被 "cor"→horn 抢走。
    hit = None
    for cand in (compact, _expand_tokens(raw), _expand_substring(compact)):
        if not cand:
            continue
        # 2) 落乐器词表（长键优先，避免 violin 抢 violoncello）
        for frag, info in _INSTR_SORTED:
            if frag in cand:
                hit = (frag, info, cand)
                break
        if hit:
            break
    if not hit:
        return None
    frag, (disp, base_tr, family), compact = hit
    key = _key_tag(compact, frag)
    key_default = False
    if not key and frag in KEYED_FAMILIES:
        key = KEY_FALLBACK.get(frag, "")           # 名字里没写调号 → 按常见编制补
        key_default = bool(key)
    transpose = base_tr
    if frag in KEYED_FAMILIES and key:
        transpose = KEY_TRANSPOSE.get(key, base_tr)
    return {
        "name": disp,
        "transpose": transpose,
        "family": family,
        "key": key,
        "keyDefault": key_default,
        "raw": str(raw or ""),
        "matched": frag,
    }


#: 调号标注的规范写法（OCR 常把 Bb 读成 BB / 135 / b）
KEY_LABEL = {"c": "C", "bb": "Bb", "b": "Bb", "bes": "Bb", "bflat": "Bb", "135": "Bb",
             "a": "A", "ab": "Ab", "as": "Ab", "f": "F", "e": "E", "eb": "Eb", "es": "Eb",
             "d": "D", "g": "G", "db": "Db", "c#": "C#", "des": "Db", "g#": "G#", "d#": "Eb"}


#: 声部限定词：罗马数字（含 OCR 常把 II 读成 ll/11）
_ROMAN = {"i": "I", "ii": "II", "iii": "III", "iv": "IV", "v": "V",
          "ll": "II", "lll": "III", "11": "II", "111": "III", "1st": "I", "2nd": "II"}


def _qualifier(raw):
    """从原始名里抠出「第几支 / 独奏 / 合奏」这类限定词，返回 (前缀, 后缀)。

    "Horn (F) 3,4" → ("", "3,4")；"Violin II ." → ("", "II")；
    "V1n.ll" → ("", "II")（OCR 把 II 读成 ll）；"SoloViola" → ("Solo", "")；
    "Trumpet (BB) 3" → ("", "3")（括号里的调号先剔掉，别当成编号）。
    """
    s = str(raw or "")
    low = s.lower()
    comp = _CLEAN_RE.sub("", low)
    pre = []                                  # 放名字前面：Solo Viola / Tutti Violin
    bits = []                                 # 放名字后面：Violin I / Horn in F 3,4
    if "solo" in comp:
        pre.append("Solo")
    if "tutti" in comp:
        pre.append("Tutti")
    body = re.sub(r"\([^)]*\)", " ", s)              # 括号里的调号先剔掉
    body = re.sub(r"(?<=[A-Za-z])(?=\d)", " ", body)   # "Oboe1,2" → "Oboe 1,2"
    # 编号必须是**独立的**数字组 —— 否则 "V1n.ll" 里的 1 会被当成编号
    m = re.search(r"(?<![0-9A-Za-z])\d+(?:[.,]\d+)*(?![0-9A-Za-z])", body)
    if m:
        bits.append(m.group(0))
    else:
        for tk in _TOKEN_RE.findall(low):
            if tk in _ROMAN:
                bits.append(_ROMAN[tk])
                break
    return " ".join(pre), " ".join(bits)


def part_number(raw):
    """声部编号（"1,2" / "II" / "3"），没有就是空串 —— 跨页对声部身份要用它。"""
    return _qualifier(raw)[1]


def display_name(raw, fallback=""):
    """给界面用的显示名：标准名 + （调号）+ （声部编号），认不出就原样返回。

    两把小提琴都要叫 "Violin" 是没法看的 —— 实测那份总谱有 Vln.I / Vln.II /
    Horn 1,2 / Horn 3,4 这样的成对声部，编号必须留在名字里。
    """
    m = match(raw)
    if not m:
        s = str(raw or "").strip()
        return s or fallback
    out = m["name"]
    if m["key"] and m["family"] in ("brass", "woodwind") and m["transpose"] != 0:
        out = "%s in %s" % (out, KEY_LABEL.get(m["key"], m["key"].upper()))
    pre, post = _qualifier(raw)
    if pre:
        out = pre + " " + out
    if post:
        out = out + " " + post
    return out


def ascii_name(raw, fallback="Part"):
    """给 MIDI 轨名用（latin-1 安全）：标准名 + 去掉非 ASCII。"""
    s = display_name(raw, fallback)
    out = "".join(ch for ch in s if 32 <= ord(ch) < 127).strip()
    return out or fallback
