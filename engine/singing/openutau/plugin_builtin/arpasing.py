# -*- coding: utf-8 -*-
"""ArpasingPhonemizer —— `OpenUtau.Plugin.Builtin/ArpasingPhonemizer.cs`(62) 全文件照搬。

注册名：`EN ARPA`（`[Phonemizer("English Arpasing Phonemizer", "EN ARPA", language: "EN")]`）。

Arpasing 是用 CMUdict 把英文单词转成 ARPAbet 音素符号的系统。

## 照搬时保留的语义
1. 构造函数里 `Initialize()` 包在 `try/catch` 里（基类已做）—— 词典装载失败不让构造失败。
2. `LoadG2p` 三层回落：**插件目录** `arpasing.yaml`（缺就写模板，**不包** try/catch）
   → **声库目录** `arpasing.yaml`（**包** try/catch）→ 内置 `ArpabetG2p`，
   最后统一走 `G2pFallbacks`。
3. ★ 插件目录那份：C# 是「不存在就 `Directory.CreateDirectory` + `File.WriteAllBytes`
   写模板」，然后**无条件**读它 —— 若 PluginDir 为空串，`CreateDirectory('')` 会抛，
   被构造函数的 catch 吞掉（g2p 停在 None）。照搬。
4. `LoadVowelFallbacks` 是 ARPAbet 元音间的就近回落表（单行字符串拆分）。

模板数据 `ARPASING_TEMPLATE` 逐字照搬 `OpenUtau.Plugin.Builtin/Data/arpasing.template.yaml`
（对应 C# 资源 `Data.Resources.arpasing_template`）。
"""

import os
from typing import Dict, List

from ..g2p import ArpabetG2p, G2pDictionary, G2pFallbacks, IG2p
from ..phonemizer import register
from .latin_diphone import LatinDiphonePhonemizer

#: 对应 C# 资源 `Data.Resources.arpasing_template`（`Data/arpasing.template.yaml`，50 行）。
ARPASING_TEMPLATE = """%YAML 1.2
---
symbols:
  - {symbol: aa, type: vowel}
  - {symbol: ae, type: vowel}
  - {symbol: ah, type: vowel}
  - {symbol: ao, type: vowel}
  - {symbol: aw, type: vowel}
  - {symbol: ax, type: vowel}
  - {symbol: ay, type: vowel}
  - {symbol: b, type: stop}
  - {symbol: ch, type: affricate}
  - {symbol: d, type: stop}
  - {symbol: dh, type: fricative}
  - {symbol: dr, type: fricative}
  - {symbol: dx, type: tap}
  - {symbol: eh, type: vowel}
  - {symbol: er, type: vowel}
  - {symbol: ey, type: vowel}
  - {symbol: f, type: fricative}
  - {symbol: g, type: stop}
  - {symbol: hh, type: aspirate}
  - {symbol: ih, type: vowel}
  - {symbol: iy, type: vowel}
  - {symbol: jh, type: affricate}
  - {symbol: k, type: stop}
  - {symbol: l, type: liquid}
  - {symbol: m, type: nasal}
  - {symbol: n, type: nasal}
  - {symbol: ng, type: nasal}
  - {symbol: ow, type: vowel}
  - {symbol: oy, type: vowel}
  - {symbol: p, type: stop}
  - {symbol: q, type: stop}
  - {symbol: r, type: liquid}
  - {symbol: s, type: fricative}
  - {symbol: sh, type: fricative}
  - {symbol: t, type: stop}
  - {symbol: th, type: fricative}
  - {symbol: tr, type: fricative}
  - {symbol: uh, type: vowel}
  - {symbol: uw, type: vowel}
  - {symbol: v, type: fricative}
  - {symbol: w, type: semivowel}
  - {symbol: y, type: semivowel}
  - {symbol: z, type: fricative}
  - {symbol: zh, type: fricative}
entries:
  - grapheme: openutau
    phonemes: [ow, p, eh, n, w, uw, t, ah, w, uw]
"""


@register
class ArpasingPhonemizer(LatinDiphonePhonemizer):
    """对应 C# `ArpasingPhonemizer`。

    构造函数的 `try { Initialize(); } catch { Log.Error(...) }` 已由基类实现。
    """

    name = 'English Arpasing Phonemizer'
    tag = 'EN ARPA'
    language = 'EN'

    def load_g2p(self) -> IG2p:
        """对应 `LoadG2p`：插件目录（缺则写模板）→ 声库目录 → `ArpabetG2p`。"""
        g2ps: List[IG2p] = []

        # 插件目录那份：不存在就写模板，然后**无条件**读（无 try/catch，照搬）
        path = os.path.join(self.plugin_dir, 'arpasing.yaml')
        if not os.path.isfile(path):
            # C#: Directory.CreateDirectory(PluginDir) —— 空串会抛，被构造 catch 吞
            os.makedirs(self.plugin_dir, exist_ok=True)
            with open(path, 'wb') as f:
                f.write(ARPASING_TEMPLATE.encode('utf-8'))
        with open(path, encoding='utf-8') as f:
            g2ps.append(G2pDictionary.new_builder().load(f.read()).build())

        # 声库目录那份：包 try/catch
        singer = self.singer
        if singer is not None and singer.found and singer.loaded:
            file = os.path.join(singer.location, 'arpasing.yaml')
            if os.path.isfile(file):
                try:
                    with open(file, encoding='utf-8') as f:
                        g2ps.append(G2pDictionary.new_builder().load(f.read()).build())
                except Exception:
                    import logging
                    logging.getLogger(__name__).error('Failed to load %s', file)

        # 内置 ARPAbet G2P
        g2ps.append(ArpabetG2p())

        return G2pFallbacks(g2ps)

    def load_vowel_fallbacks(self) -> Dict[str, List[str]]:
        """对应 `LoadVowelFallbacks`：ARPAbet 元音间的就近回落表。"""
        raw = ('aa=ah,ae;ae=ah,aa;ah=aa,ae;ao=ow;ow=ao;eh=ae;ih=iy;iy=ih;'
               'uh=uw;uw=uh;aw=ao')
        result: Dict[str, List[str]] = {}
        for entry in raw.split(';'):
            parts = entry.split('=')
            result[parts[0]] = parts[1].split(',')
        return result
