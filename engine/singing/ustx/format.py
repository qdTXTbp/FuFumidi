# -*- coding: utf-8 -*-
r"""`.ustx` 格式层 —— **照搬** `OpenUtau.Core/Format/Ustx.cs`（198 行）。

这些是**表达式缩写**（expression abbreviation），音符 / 轨道 / 音素都用它们互相引用。
必须与 OpenUTAU 逐字一致，否则读写 .ustx 时表达式对不上。

放在 ustx 包内（而不是 openutau 包）是因为它本就属于 ustx 格式，
且 ustx 的模型与 openutau 的音素化器都要用它，放这里可以避免循环导入。

## ★ 为什么这一层很要紧（审计发现的缺口，已补）
先前本文件**只有常量表**，而 C# 里 `Format/Ustx.cs` 还负责三件与**读写兼容**直接相关的事：

1. **版本常量 `kUstxVersion = 0.10`**：`Save`/`AutoSave` 会把工程的 `ustxVersion`
   **盖成当前版本**；`Load` 若读到**更新版本**要**拒绝打开**。缺了这条，
   我们保存出来的工程版本号永远是模型默认值 `0.6`，也会去打开未来版本的文件。
2. **`required`** —— 8 个必须存在的表达式缩写。
3. **`AddDefaultExpressions`** —— 打开任何工程后都要补齐这 **26** 个表达式描述符
   （新版本新增的表达式靠它补，老工程才能用上）；其中还会检测 **flag 撞车**
   （两个表达式声明了同一个 flag）并自动合并。

顺带提供 `Create` / `Save` / `AutoSave` / `Load` 四个入口，与 C# 一一对应。

## ★ 版本比较：不能用字符串比
C# 用 `System.Version` 比较（`project.UstxVersion > kUstxVersion`）。
`ustx_version` 在 YAML 里是**字符串**（C# 标了 `SerializeAs = typeof(string)`），
所以 Python 侧**必须转成元组再比** —— 直接字符串比较会得到
`"0.9" > "0.10"` 为 **True** 的错误结果。
"""


class Ustx:
    DYN = 'dyn'
    PITD = 'pitd'
    CLR = 'clr'
    ENG = 'eng'
    VEL = 'vel'
    VOL = 'vol'
    ATK = 'atk'
    DEC = 'dec'
    GEN = 'gen'
    GENC = 'genc'
    BRE = 'bre'
    BREC = 'brec'
    LPF = 'lpf'
    NORM = 'norm'
    MOD = 'mod'
    MODP = 'mod+'
    ALT = 'alt'
    DIR = 'dir'
    SHFT = 'shft'
    SHFC = 'shfc'
    TENC = 'tenc'
    VOIC = 'voic'
    CLRY = 'clry'
    XSY = 'xsy'
    RPIT = 'rpit'
    PITO = 'pito'


# 按字母序的完整清单，供一致性测试逐项核对
ALL = tuple(sorted(v for k, v in vars(Ustx).items() if k.isupper() and isinstance(v, str)))

#: 对应 `public static readonly Version kUstxVersion = new Version(0, 10);`
#: （YAML 里写成字符串 "0.10"，见 `UProject.ustx_version` 的注释）
K_USTX_VERSION = '0.10'

#: 对应 `public static readonly string[] required = { DYN, PITD, CLR, ENG, VEL, VOL, ATK, DEC };`
REQUIRED = (Ustx.DYN, Ustx.PITD, Ustx.CLR, Ustx.ENG, Ustx.VEL, Ustx.VOL, Ustx.ATK, Ustx.DEC)


class FileFormatError(Exception):
    """对应 C# `Load` 抛的 `FileFormatException`（被包在 MessageCustomizableException 里）。"""


def version_tuple(v) -> tuple:
    """把 `"0.10"` 这样的版本串转成可比较的元组 `(0, 10)`。

    对应 C# 的 `System.Version` 比较语义；**不能直接比字符串**
    （`"0.9" > "0.10"` 为 True，是错的）。解析不了的输入按 `(0, 0)` 处理 ——
    比抛异常更贴近"老工程没写版本"的现实。
    """
    parts = []
    for chunk in str(v or '').split('.'):
        try:
            parts.append(int(chunk))
        except ValueError:
            break
    return tuple(parts) if parts else (0, 0)


def add_default_expressions(project) -> str:
    """对应 `AddDefaultExpressions(project)`：补齐 26 个表达式描述符。

    ★ 用 `project.register_expression` 注册（**已存在的不覆盖**）——
      打开老工程时只补新增的，不动用户已有的设置。

    返回人可读的提示串（C# 里是拼好丢给 `MessageCustomizableException` 的
    `<translate:errors.expression.marge>` 文本）；本仓库没有 UI 通知通道，
    交由调用方决定怎么呈现。
    """
    from .model import UExpressionDescriptor
    from .model import UExpressionType as T
    from ..openutau.classic.worldline_resampler import WorldlineResampler

    def desc(name, abbr, mn, mx, dv, flag='', type_=None, options=None):
        d = UExpressionDescriptor(name=name, abbr=abbr, min=mn, max=mx, default_value=dv)
        if type_ is not None:
            d.type = type_
        if flag:
            d.flag = flag
            d.is_flag = True
        if options is not None:
            d.options = list(options)
            d.is_flag = True
        return d

    project.register_expression(desc('dynamics (curve)', Ustx.DYN, -240, 120, 0, type_=T.CURVE))
    project.register_expression(desc('pitch deviation (curve)', Ustx.PITD, -1200, 1200, 0, type_=T.CURVE))
    project.register_expression(desc('voice color', Ustx.CLR, 0, 100, 0, options=[]))
    project.register_expression(desc('resampler engine', Ustx.ENG, 0, 100, 0,
                                     options=['', WorldlineResampler.NAME]))
    project.register_expression(desc('velocity', Ustx.VEL, 0, 200, 100))
    project.register_expression(desc('volume', Ustx.VOL, 0, 200, 100))
    project.register_expression(desc('attack', Ustx.ATK, 0, 200, 100))
    project.register_expression(desc('decay', Ustx.DEC, 0, 100, 0))
    project.register_expression(desc('gender', Ustx.GEN, -100, 100, 0, flag='g'))
    project.register_expression(desc('gender (curve)', Ustx.GENC, -100, 100, 0, type_=T.CURVE))
    project.register_expression(desc('breath', Ustx.BRE, 0, 100, 0, flag='B'))
    project.register_expression(desc('breathiness (curve)', Ustx.BREC, -100, 100, 0, type_=T.CURVE))
    project.register_expression(desc('lowpass', Ustx.LPF, 0, 100, 0, flag='H'))
    project.register_expression(desc('normalize', Ustx.NORM, 0, 100, 86, flag='P'))
    project.register_expression(desc('modulation', Ustx.MOD, 0, 100, 0))
    project.register_expression(desc('modulation plus', Ustx.MODP, 0, 100, 0))
    project.register_expression(desc('alternate', Ustx.ALT, 0, 16, 0))
    project.register_expression(desc('direct', Ustx.DIR, 0, 100, 0, options=['off', 'on']))
    project.register_expression(desc('tone shift', Ustx.SHFT, -36, 36, 0))
    project.register_expression(desc('tone shift (curve)', Ustx.SHFC, -1200, 1200, 0, type_=T.CURVE))
    project.register_expression(desc('tension (curve)', Ustx.TENC, -100, 100, 0, type_=T.CURVE))
    project.register_expression(desc('voicing (curve)', Ustx.VOIC, 0, 100, 100, type_=T.CURVE))
    project.register_expression(desc('voice color y', Ustx.CLRY, 0, 100, 0, options=[]))
    project.register_expression(desc('cross synthesis (curve)', Ustx.XSY, 0, 100, 0, type_=T.CURVE))
    # 绝对音高（音分），供表达式图使用：DiffSinger 渲染出的音高 + 用户自己的音高覆盖
    project.register_expression(desc('rendered pitch (masked curve)', Ustx.RPIT,
                                     2400, 10800, 6000, type_=T.MASKED_CURVE))
    project.register_expression(desc('pitch override (masked curve)', Ustx.PITO,
                                     2400, 10800, 6000, type_=T.MASKED_CURVE))

    # ---- flag 撞车检测：两个表达式声明了同一个 flag → 合并（C# 的 ValidateExpression）
    message = ''
    if _validate_expression(project, 'g', Ustx.GEN):
        message += '\ng flag -> gender'
    if _validate_expression(project, 'B', Ustx.BRE):
        message += '\nB flag -> ' + Ustx.BRE
    if _validate_expression(project, 'H', Ustx.LPF):
        message += '\nH flag-> ' + Ustx.LPF
    if _validate_expression(project, 'P', Ustx.NORM):
        message += '\nP flag-> normalize'
    return message


def _validate_expression(project, flag: str, abbr: str) -> bool:
    """对应私有的 `ValidateExpression`：有别的表达式也声明了这个 flag 就合并掉它。"""
    hit = next((d for d in list(project.expressions.values())
                if d.flag == flag and d.abbr != abbr), None)
    if hit is None:
        return False
    project.marge_expression(hit.abbr, abbr)
    return True


def create():
    """对应 `Create()`：一个带全默认表达式的新工程。"""
    from .model import UProject
    project = UProject()
    add_default_expressions(project)
    return project


def save(file_path: str, project) -> None:
    """对应 `Save(filePath, project)`：**盖版本号 → 写盘 → 标记已保存**。

    ★ 版本号必须在写盘前盖上，否则存出去的还是模型默认值 `0.6`。
    ★ `project.saved` / `project.file_path` 也必须置位：
      `singing/openutau/classic/ust.py:402`、`:523` 的 `[#SETTING] Project=` 行
      **只在 `project.saved` 为真时**才写 —— 之前这里没设，导致导出的 .ust
      永远丢工程路径与「上次保存」信息。
    """
    from . import io as ustx_io
    project.ustx_version = K_USTX_VERSION
    ustx_io.before_save(project)
    ustx_io.save_ustx(project, file_path)
    ustx_io.after_save(project)
    # ★ 写盘成功后才标记（对照上游 `UProject.saved` 的语义）
    project.file_path = file_path
    project.saved = True


def autosave(file_path: str, project) -> None:
    """对应 `AutoSave(filePath, project)`：盖版本号 + 写盘，但**不**标记已保存。"""
    from . import io as ustx_io
    project.ustx_version = K_USTX_VERSION
    ustx_io.before_save(project)
    ustx_io.save_ustx(project, file_path)
    ustx_io.after_save(project)


def load(file_path: str):
    """对应 `Load(filePath)`：读盘 → 补默认表达式 → **版本迁移** → 盖当前版本号。

    ★ **读到更新版本要拒绝打开**（C# 抛 `MessageCustomizableException`，
      这里抛 `FileFormatError`）—— 否则新版本的字段会被我们悄悄丢掉。
    """
    from . import io as ustx_io
    from .model import DEFAULT_EXP_SELECTORS, UTempo, UTimeSignature

    project = ustx_io.load_ustx(file_path)
    add_default_expressions(project)

    v = version_tuple(project.ustx_version)
    if v > version_tuple(K_USTX_VERSION):
        raise FileFormatError(
            '工程文件比软件更新：文件 %s，软件 %s（%s）'
            % (project.ustx_version, K_USTX_VERSION, file_path))

    # ---- 迁移 0.4 → accent 改名成 attack
    if v < (0, 4):
        exp = project.expressions.get('acc')
        if exp is not None and exp.name == 'accent':
            project.expressions.pop('acc', None)
            exp.abbr = Ustx.ATK
            exp.name = 'attack'
            project.expressions[Ustx.ATK] = exp
            for part in project.parts:
                for note in getattr(part, 'notes', []) or []:
                    for e in note.phoneme_expressions:
                        if e.abbr == 'acc':
                            e.abbr = Ustx.ATK
    # ---- 迁移 0.5 → 歌词里的 "..." 改成 "+"
    if v < (0, 5):
        for part in project.parts:
            for note in getattr(part, 'notes', []) or []:
                if note.lyric.startswith('...'):
                    note.lyric = note.lyric.replace('...', '+')
    # ---- 迁移 0.6 → 时间签名/速度从废弃的 beatPerBar/beatUnit/bpm 搬过来
    if v < (0, 6):
        project.time_signatures = [UTimeSignature(0, project.beat_per_bar, project.beat_unit)]
        project.tempos = [UTempo(0, project.bpm)]
        project.build_time_axis()
    # ---- 迁移 0.7 → expSelectors 补齐到新版长度
    if v < (0, 7) and len(project.exp_selectors) < len(DEFAULT_EXP_SELECTORS):
        selectors = list(DEFAULT_EXP_SELECTORS)
        for i in range(len(project.exp_selectors)):
            selectors[i] = project.exp_selectors[i]
        project.exp_selectors = selectors

    project.ustx_version = K_USTX_VERSION
    return project
