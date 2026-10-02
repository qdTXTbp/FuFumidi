# -*- coding: utf-8 -*-
"""中文 CVV（十月式整音扩张）—— **照搬**
`OpenUtau.Plugin.Builtin/ChineseCVVPhonemizer.cs`（133 行）。

C# 声明：`[Phonemizer("Chinese CVV (十月式整音扩张) Phonemizer", "ZH CVV", language: "ZH")]`
（**没有 author** —— 第三个位置参数缺席。）

它做的事（C# 注释）：把 `"duang"` 拆成 `"duang"` + `"_ang"`，以产生正确的尾音。

## 结构
- `ChineseCVVMonophonePhonemizer : MonophonePhonemizer` —— 继承**音素驱动那条线**；
  靠 `ChineseCVVG2p` 把拼音拆成「整音 + 尾韵」，剩下的铺时长/换别名都交给基类。
- `ChineseCVVG2p : IG2p`（同文件内的手写实现）—— 只需要"拆拼音"这一件事。

## 照搬时保留的语义（别"整理"掉）
1. `ConsonantLength = 120`（基类默认是 60）。
2. `LoadG2p()` 的三段回落：插件目录 `zhcvv.yaml` → 声库目录 `zhcvv.yaml` → 内置
   `ChineseCVVG2p`；**最后统一包进 `G2pFallbacks`**。
   注意插件目录那份**没包 try/catch**、声库目录那份**包了** —— 照搬这个不对称。
3. `IsVowel(phoneme)` 的判据是 **`!phoneme.StartsWith("_")`** —— 也就是说
   **只有尾韵（`_xx`）不是元音，其它一律算元音**（包括 "duang" 这种带声母的整音）。
   这直接决定了对齐与时长分配。
4. `IsGlide` **恒 false**；`IsValidSymbol` **恒 true**；`UnpackHint` 只做切分
   **不过滤**（与 `G2pDictionary` 那份相反）。
5. `Query` 的拆解顺序：
   - `len > 2 && cSet.has(lyric[:2])` → 声母取**前两个字符**（zh/ch/sh），韵母取余下；
   - 否则 `len > 1 && cSet.has(lyric[:1])` → 声母取**一个字符**；
   - 否则整串当韵母。
   ★ 第一个条件要求 `len > 2` —— 所以 `"zha"`（长度 3）能走双字母声母，
   而 `"zh"`（长度 2）**不能**，会落到第二个条件把 `z` 当声母。
6. 两条拼写修正（顺序不能反）：
   - `vowel in ("un", "uan")` 且声母是 `j/q/x/y` → 韵母改成 `"v" + vowel[1:]`
     （`jun` → `jvn`、`juan` → `jvan`）。
   - 然后 `vowel == "an"` 且声母是 `y` → 韵母改成 `"ian"`。
     ★ 第二条**排在后面**，所以它看到的是**第一条改过之后**的韵母
     （`yuan` → 先变 `yvan`，不等于 `an`，所以第二条不触发）。
7. 查到尾韵时返回 `[lyric, tail]`（**整音原样在前**、尾韵在后），查不到只返回 `[lyric]`。

## 照搬的"死字段"
`pinyinList` / `tailList` 在 C# 里**声明后从未被使用**（`pinyins`/`tails` 两份大表也是）。
照搬进来并标注 —— 删掉它们属于"顺手清理"，但留着才能对照"上游到底用了什么"。
"""

import os

from ..base_chinese import BaseChinesePhonemizer
from ..g2p import G2pDictionary, G2pFallbacks, IG2p
from ..phonemizer import register
from .monophone import MonophonePhonemizer

#: 声母表（**死字段**：C# 里 `pinyins` / `tails` / `pinyinList` / `tailList` 都声明后未使用）
PINYINS = (
    "a,ai,an,ang,ao,ba,bai,ban,bang,bao,bei,ben,beng,bi,bian,biao,bie,bin,bing,bo,bu,ca,cai,"
    "can,cang,cao,ce,cei,cen,ceng,cha,chai,chan,chang,chao,che,chen,cheng,chi,chong,chou,chu,"
    "chua,chuai,chuan,chuang,chui,chun,chuo,ci,cong,cou,cu,cuan,cui,cun,cuo,da,dai,dan,dang,"
    "dao,de,dei,den,deng,di,dia,dian,diao,die,ding,diu,dong,dou,du,duan,dui,dun,duo,e,ei,en,"
    "eng,er,fa,fan,fang,fei,fen,feng,fo,fou,fu,ga,gai,gan,gang,gao,ge,gei,gen,geng,gong,gou,"
    "gu,gua,guai,guan,guang,gui,gun,guo,ha,hai,han,hang,hao,he,hei,hen,heng,hong,hou,hu,hua,"
    "huai,huan,huang,hui,hun,huo,ji,jia,jian,jiang,jiao,jie,jin,jing,jiong,jiu,ju,jv,juan,jvan,"
    "jue,jve,jun,jvn,ka,kai,kan,kang,kao,ke,kei,ken,keng,kong,kou,ku,kua,kuai,kuan,kuang,kui,"
    "kun,kuo,la,lai,lan,lang,lao,le,lei,leng,li,lia,lian,liang,liao,lie,lin,ling,liu,lo,long,"
    "lou,lu,luan,lun,luo,lv,lve,ma,mai,man,mang,mao,me,mei,men,meng,mi,mian,miao,mie,min,ming,"
    "miu,mo,mou,mu,na,nai,nan,nang,nao,ne,nei,nen,neng,ni,nian,niang,niao,nie,nin,ning,niu,"
    "nong,nou,nu,nuan,nun,nuo,nv,nve,o,ou,pa,pai,pan,pang,pao,pei,pen,peng,pi,pian,piao,pie,"
    "pin,ping,po,pou,pu,qi,qia,qian,qiang,qiao,qie,qin,qing,qiong,qiu,qu,qv,quan,qvan,que,qve,"
    "qun,qvn,ran,rang,rao,re,ren,reng,ri,rong,rou,ru,rua,ruan,rui,run,ruo,sa,sai,san,sang,sao,"
    "se,sen,seng,sha,shai,shan,shang,shao,she,shei,shen,sheng,shi,shou,shu,shua,shuai,shuan,"
    "shuang,shui,shun,shuo,si,song,sou,su,suan,sui,sun,suo,ta,tai,tan,tang,tao,te,tei,teng,ti,"
    "tian,tiao,tie,ting,tong,tou,tu,tuan,tui,tun,tuo,wa,wai,wan,wang,wei,wen,weng,wo,wu,xi,xia,"
    "xian,xiang,xiao,xie,xin,xing,xiong,xiu,xu,xv,xuan,xvan,xue,xve,xun,xvn,ya,yan,yang,yao,ye,"
    "yi,yin,ying,yo,yong,you,yu,yv,yuan,yvan,yue,yve,yun,yvn,za,zai,zan,zang,zao,ze,zei,zen,"
    "zeng,zha,zhai,zhan,zhang,zhao,zhe,zhei,zhen,zheng,zhi,zhong,zhou,zhu,zhua,zhuai,zhuan,"
    "zhuang,zhui,zhun,zhuo,zi,zong,zou,zu,zuan,zui,zun")

TAILS = "_vn,_ing,_ong,_an,_ou,_er,_ao,_eng,_ang,_en,_en2,_ai,_iong,_in,_ei"

#: **死字段**：C# 里这两个列表建好后从未被读取。照搬保留以示"上游到底有什么"。
PINYIN_LIST = PINYINS.split(',')
TAIL_LIST = TAILS.split(',')

#: `ChineseCVVG2p.consonants`（23 个）
G2P_CONSONANTS = "b,p,m,f,d,t,n,l,g,k,h,j,q,x,z,c,s,zh,ch,sh,r,y,w"

#: `ChineseCVVG2p.vowels`（拼音韵母 → 尾韵，25 项）
G2P_VOWELS = ("ai=_ai,uai=_uai,an=_an,ian=_en2,uan=_an,van=_en2,ang=_ang,iang=_ang,"
              "uang=_ang,ao=_ao,iao=_ao,ou=_ou,iu=_ou,ong=_ong,iong=_ong,ei=_ei,ui=_ei,"
              "uei=_ei,en=_en,un=_un,uen=_un,eng=_eng,in=_in,ing=_ing,vn=_vn")


def _build_c_set():
    return set(G2P_CONSONANTS.split(','))


def _build_v_dict():
    """`拼音韵母 → 尾韵`。重复键抛错（C# 的 `ToDictionary` 同样抛）。"""
    out = {}
    for item in G2P_VOWELS.split(','):
        key, value = item.split('=')
        if key in out:
            raise ValueError('G2P_VOWELS 里有重复键: %r' % key)
        out[key] = value
    return out


class ChineseCVVG2p(IG2p):
    """对应同文件内的 `class ChineseCVVG2p : IG2p`（手写实现）。

    它只回答一件事：**把拼音拆成「整音 + 尾韵」**。其余三个方法都是常量返回。
    """

    CONSONANTS = _build_c_set()
    VOWELS = _build_v_dict()

    def is_vowel(self, phoneme: str) -> bool:
        """★ 判据是"**不以 `_` 开头**" —— 所以带声母的整音（`duang`）**算元音**，
        只有尾韵（`_ang`）不算。这条直接决定对齐与时长分配。"""
        return not phoneme.startswith('_')

    def is_glide(self, phoneme: str) -> bool:
        return False

    def query(self, lyric: str):
        """对应 `Query`：拆出「整音 + 尾韵」。"""
        consonant = ''
        vowel = ''
        if len(lyric) > 2 and lyric[:2] in self.CONSONANTS:
            # 先试双字母声母（zh / ch / sh）
            consonant = lyric[:2]
            vowel = lyric[2:]
        elif len(lyric) > 1 and lyric[:1] in self.CONSONANTS:
            consonant = lyric[:1]
            vowel = lyric[1:]
        else:
            vowel = lyric

        # ★ 两条修正的**顺序是语义**：第二条看到的是第一条改过之后的韵母
        if vowel in ('un', 'uan') and consonant in ('j', 'q', 'x', 'y'):
            vowel = 'v' + vowel[1:]
        if vowel == 'an' and consonant == 'y':
            vowel = 'ian'

        tail = self.VOWELS.get(vowel)
        if tail is not None:
            return [lyric, tail]
        return [lyric]

    def is_valid_symbol(self, symbol: str) -> bool:
        return True

    def unpack_hint(self, hint: str, separator: str = ' '):
        """★ 只切分、**不过滤**（与 `G2pDictionary.unpack_hint` 相反）。"""
        return hint.split(separator)


@register
class ChineseCVVMonophonePhonemizer(MonophonePhonemizer):
    """对应 `ChineseCVVMonophonePhonemizer`（文件名是 ChineseCVVPhonemizer.cs）。"""

    name = 'Chinese CVV (十月式整音扩张) Phonemizer'
    tag = 'ZH CVV'
    language = 'ZH'

    def __init__(self):
        super().__init__()
        #: 基类默认 60，这里改 120
        self.consonant_length = 120

    def load_g2p(self) -> IG2p:
        """对应 `LoadG2p`：插件目录 → 声库目录 → 内置，最后统一走 `G2pFallbacks`。"""
        g2ps = []

        # 插件目录那份：**没有** try/catch（照搬这个不对称）
        path = os.path.join(self.plugin_dir, 'zhcvv.yaml')
        if os.path.isfile(path):
            with open(path, encoding='utf-8') as f:
                g2ps.append(G2pDictionary.new_builder().load(f.read()).build())

        # 声库目录那份：**包了** try/catch
        singer = self.singer
        if singer is not None and singer.found and singer.loaded:
            file = os.path.join(singer.location, 'zhcvv.yaml')
            if os.path.isfile(file):
                try:
                    with open(file, encoding='utf-8') as f:
                        g2ps.append(G2pDictionary.new_builder().load(f.read()).build())
                except Exception:
                    import logging
                    logging.getLogger(__name__).error('Failed to load %s', file)

        g2ps.append(ChineseCVVG2p())
        return G2pFallbacks(g2ps)

    def load_vowel_fallbacks(self):
        """对应 `LoadVowelFallbacks`：`_un=_en;_uai=_ai`。"""
        out = {}
        for entry in '_un=_en;_uai=_ai'.split(';'):
            parts = entry.split('=')
            out[parts[0]] = parts[1].split(',')
        return out

    def set_up(self, notes, project, track) -> None:
        """对应 `SetUp`：先 `base.SetUp`，再做汉字→拼音的罗马化。"""
        super().set_up(notes, project, track)
        BaseChinesePhonemizer.romanize_notes(notes)
