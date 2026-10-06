# -*- coding: utf-8 -*-
r"""声库探测 —— **照搬** `OpenUtau.Core/DiffSinger/DiffSingerSinger.cs`
与 `DiffSingerBasePhonemizer._executeSetSinger`（:79-136）。

★ `dsdur/` 是**强制**的：上游 `:87` 拼出路径，`:126-134` 读不到就抛
  `Failed to load {durationModelPath}`，整个 `SetSinger` 失败。
  我们这里同样抛 `RenderError` —— 缺 `dsdur` 的声库**不是"能出声但不准"**，
  而是根本不该被当成 DiffSinger 声库。

★ 另两处上游特有的加载优先级：
  - vocoder：`<声库>/dsvocoder/vocoder.yaml` 优先，否则 `Dependency/<dsconfig.vocoder>`
    （`DiffSingerSinger.cs:200-211`）
  - 音素表：`LoadPhonemes` 按扩展名分流（`.json` 取 JSON 值 / 其它取**行号**）
    （`DiffSingerUtils.cs:363-384`）
"""

import io
import json
import os
from dataclasses import dataclass
from typing import Dict, Optional

import yaml

from .config import DsAcousticConfig, DsDurConfig, DsVocoderConfig
from . import RenderError

#: 对应 `DiffSingerUtils.cs:15-16`
HEAD_FRAMES = 8
TAIL_FRAMES = 8


def _read_yaml(path: str) -> dict:
    with io.open(path, encoding='utf-8') as f:
        return yaml.safe_load(f) or {}


def find_dsconfig(singer_dir: str, max_depth: int = 2) -> Optional[str]:
    """在声库目录里向下找 `dsconfig.yaml`（≤ `max_depth` 层）。"""
    if os.path.isfile(os.path.join(singer_dir, 'dsconfig.yaml')):
        return os.path.join(singer_dir, 'dsconfig.yaml')
    if max_depth <= 0:
        return None
    try:
        entries = sorted(os.listdir(singer_dir))
    except OSError:
        return None
    for name in entries:
        sub = os.path.join(singer_dir, name)
        if os.path.isdir(sub):
            got = find_dsconfig(sub, max_depth - 1)
            if got:
                return got
    return None


# ---------------------------------------------------------------- dsdur（A 层）

def load_ds_dur(singer_dir: str) -> DsDurConfig:
    """加载 `<声库>/dsdur/dsconfig.yaml`（**缺失即抛**，对齐 `:87` + `:160-164`）。"""
    root = os.path.join(singer_dir, 'dsdur')
    cfg_path = os.path.join(root, 'dsconfig.yaml')
    if not os.path.isfile(cfg_path):
        raise RenderError(
            '该声库没有 dsdur/（时长模型子包），无法作为 DiffSinger 声库使用：%s' % cfg_path)
    raw = _read_yaml(cfg_path)
    # ★ 这三个键在上游是**无默认值的必填**（`DiffSingerConfig.cs:71-72` 等），
    #   缺了上游会 `Path.Join(root, null)` 抛 ArgumentNullException。
    for key in ('linguistic', 'dur', 'phonemes'):
        if not raw.get(key):
            raise RenderError('dsdur/dsconfig.yaml 缺少必需键 "%s"：%s' % (key, cfg_path))
    speakers = raw.get('speakers')
    return DsDurConfig(
        root=root,
        linguistic=raw['linguistic'],
        dur=raw['dur'],
        phonemes=raw['phonemes'],
        languages=raw.get('languages'),
        speakers=list(speakers) if isinstance(speakers, (list, tuple)) else None,
        use_lang_id=bool(raw.get('use_lang_id', False)),
        hop_size=int(raw.get('hop_size', 512)),
        sample_rate=int(raw.get('sample_rate', 44100)),
        raw=raw,
    )


def load_phoneme_tokens(cfg: DsDurConfig) -> Dict[str, int]:
    """对应 `LoadPhonemes`（`DiffSingerUtils.cs:363-384`）。

    ★ `.json` → **取 JSON 的值**；其它（`.txt`）→ **token id = 行号（0-based）**。
      本声库用 `sr3_dur.phonemes.json`（189 条，**id 从 1 开始**），
      所以「id = 行号」那条分支在这里不适用 —— 别混用根目录的
      `liu2_ying2_aco.phonemes.json`，那是**声学模型**的表，语义不同。
    """
    path = cfg.path(cfg.phonemes)
    if not os.path.isfile(path):
        raise RenderError('找不到音素表：%s' % path)
    if os.path.splitext(path)[1].lower() == '.json':
        with io.open(path, encoding='utf-8') as f:
            return {str(k): int(v) for k, v in json.load(f).items()}
    result: Dict[str, int] = {}
    with io.open(path, encoding='utf-8') as f:
        for i, line in enumerate(f):
            # ★ 照搬 :377-384：整行作为 key（不 strip），重复行后者覆盖
            result[line.rstrip('\r\n')] = i
    return result


def load_language_ids(cfg: DsDurConfig) -> Dict[str, int]:
    """对应 `LoadLanguageIds`（`:386-389`）。

    ★ 上游只在 `use_lang_id == true` 时调用（`:98-109`）；否则不读文件。
      音素前缀不在表里时默认 0（`GetValueOrDefault(..., 0)`）。
    """
    if not cfg.use_lang_id or not cfg.languages:
        return {}
    path = cfg.path(cfg.languages)
    if not os.path.isfile(path):
        raise RenderError('use_lang_id 为真但找不到语言表：%s' % path)
    with io.open(path, encoding='utf-8') as f:
        return {str(k): int(v) for k, v in json.load(f).items()}


# ---------------------------------------------------------------- 声学/声码器（B 层）

def load_acoustic(singer_dir: str) -> DsAcousticConfig:
    """加载 `<声库>/dsconfig.yaml`（根，**声学模型侧**的配置）。"""
    path = find_dsconfig(singer_dir)
    if not path:
        raise RenderError('该声库里找不到 dsconfig.yaml：%s' % singer_dir)
    root = os.path.dirname(path)
    raw = _read_yaml(path)
    for key in ('acoustic', 'vocoder', 'phonemes'):
        if not raw.get(key):
            raise RenderError('dsconfig.yaml 缺少必需键 "%s"：%s' % (key, path))
    speakers = raw.get('speakers')
    return DsAcousticConfig(
        root=root,
        acoustic=raw['acoustic'],
        vocoder=raw['vocoder'],
        phonemes=raw['phonemes'],
        hop_size=int(raw.get('hop_size', 512)),
        win_size=int(raw.get('win_size', 2048)),
        fft_size=int(raw.get('fft_size', 2048)),
        num_mel_bins=int(raw.get('num_mel_bins', 128)),
        mel_fmin=float(raw.get('mel_fmin', 40)),
        mel_fmax=float(raw.get('mel_fmax', 16000)),
        mel_base=str(raw.get('mel_base', '10')),
        mel_scale=str(raw.get('mel_scale', 'slaney')),
        sample_rate=int(raw.get('sample_rate', 44100)),
        use_lang_id=bool(raw.get('use_lang_id', False)),
        use_key_shift_embed=bool(raw.get('use_key_shift_embed', False)),
        use_speed_embed=bool(raw.get('use_speed_embed', False)),
        use_energy_embed=bool(raw.get('use_energy_embed', False)),
        use_breathiness_embed=bool(raw.get('use_breathiness_embed', False)),
        use_voicing_embed=bool(raw.get('use_voicing_embed', False)),
        use_tension_embed=bool(raw.get('use_tension_embed', False)),
        use_continuous_acceleration=bool(raw.get('use_continuous_acceleration', False)),
        use_variable_depth=bool(raw.get('use_variable_depth', False)),
        use_shallow_diffusion=raw.get('use_shallow_diffusion'),
        _max_depth=float(raw.get('max_depth', 0.6)),
        languages=raw.get('languages'),
        speakers=list(speakers) if isinstance(speakers, (list, tuple)) else None,
        raw=raw,
    )


def load_vocoder(acoustic: DsAcousticConfig, dependency_dir: Optional[str] = None
                 ) -> DsVocoderConfig:
    """对应 `DiffSingerSinger.getVocoder()`（:200-211）。

    ★ **声库自带 `dsvocoder/` 优先**；没有时用调用方给的**通用声码器**（`dependency_dir` 指向
      含 `vocoder.yaml` 的目录，或该目录里的某个 .onnx —— 主进程传的就是 onnx 路径）；
      再退到上游语义的 `Dependency/<dsconfig.vocoder>`。
      `pitch_controllable` 在**这里**（vocoder.yaml），不在 dsconfig。
    """
    local = os.path.join(acoustic.root, 'dsvocoder')
    # 调用方给的覆盖：目录，或目录里的文件（取父目录）
    ov_dir = None
    if dependency_dir:
        ov_dir = dependency_dir if os.path.isdir(dependency_dir) else os.path.dirname(dependency_dir)
    if os.path.isfile(os.path.join(local, 'vocoder.yaml')):
        root = local                      # 声库自带的最准，覆盖请求在这里被忽略（调用方会提示）
    elif ov_dir and os.path.isfile(os.path.join(ov_dir, 'vocoder.yaml')):
        # ★ 通用声码器（如 nsf_hifigan_44.1k_hop512_128bin_2024.02）：没有 dsvocoder 的声库靠它才渲染得出来。
        #   以前调用方把覆盖参数写成了恒 None，于是这类声库直接报"无法定位声码器"。
        root = ov_dir
    else:
        if not dependency_dir:
            raise RenderError(
                '声库没有 dsvocoder/，也没给 Dependency 目录，无法定位声码器：%s'
                % acoustic.vocoder)
        root = os.path.join(dependency_dir, acoustic.vocoder)
        if not os.path.isdir(root):
            # 也允许 Dependency 下直接放 onnx（此时 vocoder 字段就是文件名）
            cand = os.path.join(dependency_dir, acoustic.vocoder)
            if os.path.isfile(cand):
                return DsVocoderConfig(
                    root=dependency_dir, model=os.path.basename(cand),
                    hop_size=acoustic.hop_size, win_size=acoustic.win_size,
                    fft_size=acoustic.fft_size, num_mel_bins=acoustic.num_mel_bins,
                    mel_fmin=acoustic.mel_fmin, mel_fmax=acoustic.mel_fmax,
                    mel_base=acoustic.mel_base, mel_scale=acoustic.mel_scale,
                    sample_rate=acoustic.sample_rate)
            raise RenderError('找不到声码器：%s' % root)
    raw = _read_yaml(os.path.join(root, 'vocoder.yaml'))
    return DsVocoderConfig(
        root=root,
        model=raw.get('model', 'model.onnx'),
        sample_rate=int(raw.get('sample_rate', 44100)),
        hop_size=int(raw.get('hop_size', 512)),
        win_size=int(raw.get('win_size', 2048)),
        fft_size=int(raw.get('fft_size', 2048)),
        num_mel_bins=int(raw.get('num_mel_bins', 128)),
        mel_fmin=float(raw.get('mel_fmin', 40)),
        mel_fmax=float(raw.get('mel_fmax', 16000)),
        mel_base=str(raw.get('mel_base', '10')),
        mel_scale=str(raw.get('mel_scale', 'slaney')),
        pitch_controllable=bool(raw.get('pitch_controllable', False)),
        raw=raw,
    )


def verify_vocoder_matches(voc: DsVocoderConfig, acoustic: DsAcousticConfig) -> None:
    """对应 `DiffSingerRenderer.cs:202-238` 的 8 项一致性硬校验（全抛，不降级）。

    ★ `mel_base` **不要求相等**（上游 `:230-234` 把它注释掉了，因为可以在
      `:477-496` 做数值变换）；其余必须逐项相等。
    """
    checks = (
        ('sample_rate', voc.sample_rate, acoustic.sample_rate),
        ('hop_size', voc.hop_size, acoustic.hop_size),
        ('win_size', voc.win_size, acoustic.win_size),
        ('fft_size', voc.fft_size, acoustic.fft_size),
        ('num_mel_bins', voc.num_mel_bins, acoustic.num_mel_bins),
        ('mel_scale', voc.mel_scale, acoustic.mel_scale),
    )
    for name, a, b in checks:
        if a != b:
            raise RenderError('声码器与声学模型的 %s 不一致（%r vs %r）' % (name, a, b))
    for name, a, b in (('mel_fmin', voc.mel_fmin, acoustic.mel_fmin),
                       ('mel_fmax', voc.mel_fmax, acoustic.mel_fmax)):
        if abs(a - b) > 1e-5:
            raise RenderError('声码器与声学模型的 %s 不一致（%r vs %r）' % (name, a, b))
    for name, value in (('mel_base', voc.mel_base), ('mel_scale', voc.mel_scale)):
        allowed = ('10', 'e') if name == 'mel_base' else ('slaney', 'htk')
        if value not in allowed:
            raise RenderError('声码器的 %s 必须是 %s 之一，实际 %r' % (name, ' / '.join(allowed), value))


def model_hash(path: str) -> int:
    """模型字节的 XXH64 —— 对应上游 `singer.acousticHash` / `vocoder.hash`
    （`DiffSingerCache.cs` 的 `identifier`）。

    ★ 照搬要点：**在声库加载时算一次**并缓存，而不是每次推理都读全量字节
      （acoustic 有 244MB，每次读会拖垮性能）。
    ★ 上游的 acoustic/vocoder hash 用的是 `XXH64.DigestOf(bytes)`；
      dsdur/dsvariance 侧的 `linguisticHash`/`varianceHash` 同理。
    """
    from singing.openutau import xxhash
    h = 0
    with open(path, 'rb') as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            h = xxhash.xxh64(chunk, h)
    return h


@dataclass
class DsSinger:
    """一个已解析的 DiffSinger 声库（A 层 + B 层各自的配置）。"""

    dir: str
    dur: DsDurConfig
    acoustic: DsAcousticConfig
    vocoder: DsVocoderConfig
    phoneme_tokens: Dict[str, int]
    language_ids: Dict[str, int]
    #: 各阶段的模型字节 hash（tensorcache 的 `identifier`）
    hashes: Dict[str, int] = None

    @property
    def hop_size(self) -> int:
        """B 层的 hop（渲染时用）。"""
        return self.vocoder.hop_size

    @property
    def sample_rate(self) -> int:
        return self.vocoder.sample_rate

    def model(self, which: str) -> str:
        """`which ∈ {'linguistic', 'dur', 'acoustic', 'vocoder'}` → onnx 绝对路径。"""
        if which == 'linguistic':
            return self.dur.path(self.dur.linguistic)
        if which == 'dur':
            return self.dur.path(self.dur.dur)
        if which == 'acoustic':
            return self.acoustic.path(self.acoustic.acoustic)
        if which == 'vocoder':
            return self.vocoder.model_path()
        raise KeyError(which)


def load_singer(singer_dir: str, dependency_dir: Optional[str] = None) -> DsSinger:
    """一次性把 A 层（dsdur）与 B 层（根 dsconfig + vocoder）的配置都读出来。"""
    dur = load_ds_dur(singer_dir)
    acoustic = load_acoustic(singer_dir)
    vocoder = load_vocoder(acoustic, dependency_dir)
    verify_vocoder_matches(vocoder, acoustic)
    sg = DsSinger(
        dir=singer_dir,
        dur=dur,
        acoustic=acoustic,
        vocoder=vocoder,
        phoneme_tokens=load_phoneme_tokens(dur),
        language_ids=load_language_ids(dur),
    )
    # ★ tensorcache 的 `identifier`：各阶段模型字节的 XXH64（加载时算一次）
    sg.hashes = {}
    for which in ('linguistic', 'dur', 'acoustic', 'vocoder'):
        p = sg.model(which)
        if os.path.isfile(p):
            try:
                sg.hashes[which] = model_hash(p)
            except OSError:
                pass
    var = os.path.join(singer_dir, 'dsvariance')
    if os.path.isfile(os.path.join(var, 'dsconfig.yaml')):
        import yaml
        with open(os.path.join(var, 'dsconfig.yaml'), encoding='utf-8') as f:
            vc = yaml.safe_load(f) or {}
        for which, key in (('variance_linguistic', 'linguistic'),
                           ('variance', 'variance')):
            p = os.path.join(var, str(vc.get(key) or ''))
            if vc.get(key) and os.path.isfile(p):
                try:
                    sg.hashes[which] = model_hash(p)
                except OSError:
                    pass
    pit = os.path.join(singer_dir, 'dspitch')
    if os.path.isfile(os.path.join(pit, 'dsconfig.yaml')):
        import yaml
        with open(os.path.join(pit, 'dsconfig.yaml'), encoding='utf-8') as f:
            pc = yaml.safe_load(f) or {}
        for which, key in (('pitch_linguistic', 'linguistic'), ('pitch', 'pitch')):
            p = os.path.join(pit, str(pc.get(key) or ''))
            if pc.get(key) and os.path.isfile(p):
                try:
                    sg.hashes[which] = model_hash(p)
                except OSError:
                    pass
    return sg
