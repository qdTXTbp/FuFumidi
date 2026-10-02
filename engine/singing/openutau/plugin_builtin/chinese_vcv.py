# -*- coding: utf-8 -*-
"""中文 VCV 音素化器 —— **照搬** `OpenUtau.Plugin.Builtin/ChineseVCVPhonemizer.cs`（241 行）。

C# 声明：`[Phonemizer("Chinese VCV Phonemizer", "ZH VCV", "樗儿", language: "ZH")]`

支持直接输入汉字（`SetUp` 阶段统一转无声调拼音），再按"前字尾韵母 + 本字拼音"做 VCV 拼接；
句末无后续邻居时追加一个尾韵 `R` 音素。

## 照搬时保留的语义（别"整理"掉）
1. `tailMap` 表的**行序只影响可读性**，真正生效的是它建出的 `pinyin → 尾韵母` 字典；
   重复键在 C# 的 `ToDictionary` 会抛异常，这里同样抛（不静默覆盖）。
   注意 `-` 不出现在表里 —— `- tian` 这类歌词要靠 `ExtractPurePinyin` 先剥前缀。
2. `ExtractPurePinyin` 的三步：`Trim` → 去掉**开头**的 `-` → 含空格则取**最后一段**。
   所以 `- tian` → `tian`，`ian bu` → `bu`，而 `+`（连音符）原样保留。
3. **`+` 提前返回**：`currentPure == "+"` 时直接产出一个 `"+"` 音素，不查 oto、不加尾韵。
4. 候选顺序：有前邻且前邻尾韵母非空时 `[尾韵 本字, * 本字]`，然后**无论有没有前邻**都追加
   `- 本字` 与 `本字`。所以顺序是 `tail 本字 / * 本字 / - 本字 / 本字`。
5. `CheckOtoUntilHit` 与 JA VCV 的那份**不同**（别抄错了）：
   - color / toneShift / alt **只看音符自身的 `phonemeAttributes`，不回落轨道默认值**
     （即 `attr.voiceColor ?? ""`，而不是 `?? GetParentVoiceColor()`）。
   - `alt` 命中与普通命中是**两个独立 if**（不是 `else if`）—— 两者会**同时**进结果表。
   - `index` 是可传入的参数：主音素用 `0`，尾韵 `R` 用 `1`。
6. 尾韵 `R`：**只有没有后续邻居时**才加；位置是
   `totalDuration - min(totalDuration / 6, 60)`（tick，整数除法），即最多提前 60 tick。
7. 全部落空 → 仍然带尾韵逻辑地回落成**原拼音**。
"""

import unicodedata

from ..base_chinese import BaseChinesePhonemizer
from ..phonemizer import Note, Phoneme, Phonemizer, Result, register
from ..oto import UOto

#: 拼音 → 尾韵母 的对照表。格式：`尾韵母=拼音1,拼音2,...`
TAIL_MAP = (
    'a=a,ba,pa,ma,fa,da,ta,na,la,ga,ka,ha,zha,cha,sha,za,ca,sa,ya,lia,jia,qia,xia,wa,gua,kua,hua,zhua,shua,dia',
    'ang=ang,bang,pang,mang,fang,dang,tang,nang,lang,gang,kang,hang,zhang,chang,shang,rang,zang,cang,sang,yang,liang,jiang,qiang,xiang,wang,guang,kuang,huang,zhuang,chuang,shuang,niang',
    'ao=ao,bao,pao,mao,dao,tao,nao,lao,gao,kao,hao,zhao,chao,shao,rao,zao,cao,sao,yao,biao,piao,miao,diao,tiao,niao,liao,jiao,qiao,xiao',
    'ai=ai,bai,pai,mai,dai,tai,nai,lai,gai,kai,hai,zhai,chai,shai,zai,cai,sai,wai,guai,kuai,huai,zhuai,chuai,shuai',
    'an=an,ban,pan,man,fan,dan,tan,nan,lan,gan,kan,han,zhan,chan,shan,ran,zan,can,san,wan,duan,tuan,nuan,luan,guan,kuan,huan,zhuan,chuan,shuan,ruan,zuan,cuan,suan',
    'o=o,bo,po,mo,fo,wo,duo,tuo,nuo,luo,guo,kuo,huo,zhuo,chuo,shuo,ruo,zuo,cuo,suo',
    'ong=ong,dong,tong,nong,long,gong,kong,hong,zhong,chong,rong,zong,cong,song,yong,jiong,qiong,xiong',
    'ou=ou,pou,mou,fou,dou,tou,lou,gou,kou,hou,zhou,chou,shou,rou,zou,cou,sou,you,miu,diu,niu,liu,jiu,qiu,xiu',
    'e=e,me,de,te,ne,le,ge,ke,he,zhe,che,she,re,ze,ce,se',
    'en=en,ben,pen,men,fen,nen,gen,ken,hen,zhen,chen,shen,ren,zen,cen,sen,wen,dun,tun,lun,gun,kun,hun,zhun,chun,shun,run,zun,cun,sun',
    'eng=eng,beng,peng,meng,feng,deng,teng,neng,leng,geng,keng,heng,weng,zheng,cheng,sheng,reng,zeng,ceng,seng',
    'ei=ei,bei,pei,mei,fei,dei,tei,nei,lei,gei,kei,hei,zhei,shei,zei,wei,dui,tui,gui,kui,hui,zhui,chui,shui,rui,zui,cui,sui',
    'ie=ye,bie,pie,mie,die,tie,nie,lie,jie,qie,xie',
    'ue=yue,nue,lue,jue,que,xue',
    'u=u,bu,pu,mu,fu,du,tu,nu,lu,gu,ku,hu,zhu,chu,shu,ru,zu,cu,su,wu',
    'v=yu,nv,lv,ju,qu,xu',
    'vn=yun,jun,qun,xun',
    'i=i,bi,pi,mi,di,ti,ni,li,ji,qi,xi,yi',
    'in=yin,bin,pin,min,nin,lin,jin,qin,xin',
    'ing=ying,bing,ping,ming,ding,ting,ning,ling,jing,qing,xing',
    'ir=zhi,chi,shi,ri',
    'iz=zi,ci,si',
    'er=er',
    'ian=yan,bian,pian,mian,dian,tian,nian,lian,jian,qian,xian,yuan,juan,quan,xuan',
)


def _build_tail_lookup():
    """对应 C# 静态构造里的 `SelectMany` + `ToDictionary`（重复键抛异常）。"""
    lookup = {}
    for line in TAIL_MAP:
        parts = line.split('=')
        tail = parts[0]
        for pinyin in parts[1].split(','):
            if pinyin in lookup:
                raise ValueError('TAIL_MAP 表里有重复键: %r' % pinyin)
            lookup[pinyin] = tail
    return lookup


#: 拼音 → 尾韵母
TAIL_LOOKUP = _build_tail_lookup()


@register
class ChineseVCVPhonemizer(Phonemizer):
    """对应 `ChineseVCVPhonemizer`。"""

    name = 'Chinese VCV Phonemizer'
    tag = 'ZH VCV'
    language = 'ZH'
    author = '樗儿'

    def __init__(self):
        super().__init__()
        self.singer = None

    def set_singer(self, singer) -> None:
        self.singer = singer

    def set_up(self, notes, project, track) -> None:
        """★ 注意：C# 这里**不调** `base.SetUp`，所以 `project`/`track` 不会被设置。

        别"顺手补上"—— `CheckOtoUntilHit` 只看音符自身的属性、不回落轨道默认值，
        是否设置 project/track 不影响它；但补上会改变 `phoneme_attributes` 之外的
        隐含状态，属于无谓的行为变更。
        """
        BaseChinesePhonemizer.romanize_notes(notes)

    def process(self, notes, prev=None, next_=None, prev_neighbour=None,
                next_neighbour=None, prevs=None) -> Result:
        note = notes[0]
        current_lyric = unicodedata.normalize('NFC', note.lyric or '')
        total_duration = sum(n.duration for n in notes)

        # 1. 音素提示优先（强制覆盖）：命中就用 oto 别名，否则**直接用 hint**（不回落）
        if note.phonetic_hint:
            hint = unicodedata.normalize('NFC', note.phonetic_hint)
            hit, ph = self._check_oto_until_hit([hint], note, 0)
            if hit:
                return self.make_simple_result(ph.alias)
            return self.make_simple_result(hint)

        # 2. 提取纯拼音
        current_pure = self.extract_pure_pinyin(current_lyric)

        # 3. 连音符原样透传
        if current_pure == '+':
            return self.make_simple_result('+')

        # 4. 生成候选列表（按优先级）
        candidates = []
        if prev_neighbour is not None:
            prev_lyric = unicodedata.normalize('NFC', prev_neighbour.lyric or '')
            if prev_neighbour.phonetic_hint:
                prev_lyric = unicodedata.normalize('NFC', prev_neighbour.phonetic_hint)
            prev_pure = self.extract_pure_pinyin(prev_lyric)
            tail = TAIL_LOOKUP.get(prev_pure)
            if tail:
                candidates.append('%s %s' % (tail, current_pure))   # 优先级1：精确 VCV
                candidates.append('* %s' % current_pure)            # 优先级2：通配符

        candidates.append('- %s' % current_pure)                    # 优先级3：开头格式
        candidates.append(current_pure)                             # 优先级4：纯拼音兜底

        # 5. 按优先级匹配 oto
        hit, oto = self._check_oto_until_hit(candidates, note, 0)
        if hit:
            return self._make_result_with_tail_r(oto.alias, note, current_pure,
                                                 total_duration, next_neighbour)

        # 6. 全部失败：返回原拼音保底
        return self._make_result_with_tail_r(current_pure, note, current_pure,
                                             total_duration, next_neighbour)

    # ------------------------------------------------------------------ 辅助

    def _make_result_with_tail_r(self, main_phoneme, note: Note, current_pure: str,
                                 total_duration: int, next_neighbour) -> Result:
        """对应 `MakeResultWithTailR`：句末追加尾韵 `R` 音素。"""
        if next_neighbour is not None:
            # 有后续音符时不需要尾韵（由后续音符的 VCV 连接承担）
            return self.make_simple_result(main_phoneme)

        tail = TAIL_LOOKUP.get(current_pure)
        if tail:
            tail_r_alias = '%s R' % tail
            hit, tail_oto = self._check_oto_until_hit([tail_r_alias], note, 1)
            if hit:
                return Result(phonemes=[
                    Phoneme(phoneme=main_phoneme),
                    Phoneme(phoneme=tail_oto.alias,
                            position=total_duration - min(total_duration // 6, 60)),
                ])
        return self.make_simple_result(main_phoneme)

    @staticmethod
    def extract_pure_pinyin(lyric: str) -> str:
        """对应 `ExtractPurePinyin`：剥掉开头的 `-`，含空格时取最后一段。"""
        if lyric is None or not lyric.strip():
            return ''
        result = lyric.strip()
        if result.startswith('-'):
            result = result[1:].strip()
        if ' ' in result:
            result = result.split(' ')[-1].strip()
        return result

    def _check_oto_until_hit(self, inputs, note: Note, index: int):
        """对应 `CheckOtoUntilHit`。返回 `(是否命中, UOto 或 None)`。

        ★ 与 JA VCV 的那份有两处不同，见模块 docstring 第 5 条。
        """
        if self.singer is None:
            return False, None

        attr = next((a for a in (note.phoneme_attributes or []) if a.index == index), None)
        color = attr.voice_color if (attr is not None and attr.voice_color is not None) else ''
        tone_shift = attr.tone_shift if (attr is not None and attr.tone_shift is not None) else 0
        alt = attr.alternate if attr is not None else None

        results = []
        for input_ in inputs:
            # 先试带备用索引的别名（注意：与下面那个 if 是**并列**，不是 else if）
            if alt is not None:
                oto_alt = self.mapped_oto('%s%d' % (input_, alt),
                                          note.tone + tone_shift, color)
                if oto_alt is not None:
                    results.append(oto_alt)
            oto = self.mapped_oto(input_, note.tone + tone_shift, color)
            if oto is not None:
                results.append(oto)

        if not results:
            return False, None
        matched = next((o for o in results if o.is_color_match(color)), None)
        if matched is None:
            matched = results[0]
        return True, matched
