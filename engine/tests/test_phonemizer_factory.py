# -*- coding: utf-8 -*-
"""验证 `Api/PhonemizerFactory.cs`(69) 与 `Api/PhonemizerInstaller.cs`(17)。

覆盖：C# 反射读特性 → Python 类属性 的映射、`name`/`tag` 为空返回 None、
`create()` **不设 Author**、`to_string()` 的两种形态、稳定排序、
`get_by_type_name` 只查已缓存的、以及安装器的拷贝。
"""
import io
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from singing.openutau import api                                    # noqa: E402
from singing.openutau.phonemizer import Phonemizer, register        # noqa: E402

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label,
                         ('\n       ' + str(detail)) if (detail and not cond) else ''))


def _repo():
    return os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))))


def _src(name):
    p = os.path.join(_repo(), '_ref', 'OpenUtau', 'OpenUtau.Core', 'Api', name)
    return io.open(p, encoding='utf-8-sig').read().replace('\r\n', '\n') \
        if os.path.isfile(p) else ''


# ---- 三个测试用音素化器（照上游那套小写类属性）
@register
class _ZhPhonemizer(Phonemizer):
    name = 'CVVC Phonemizer'
    tag = 'ZH CVVC'
    language = 'ZH'

    def __init__(self):
        self.name = self.tag = self.language = ''

    def set_singer(self, singer):
        pass

    def process(self, notes, prev=None, next_=None, prev_neighbour=None,
                next_neighbour=None, prevs=None):
        return ([], [])


@register
class _WithAuthorPhonemizer(Phonemizer):
    name = 'Contributed One'
    tag = 'ZH VCV'
    author = 'Lotte V'
    language = 'ZH'

    def __init__(self):
        self.name = self.tag = self.language = self.author = ''

    def set_singer(self, singer):
        pass

    def process(self, notes, prev=None, next_=None, prev_neighbour=None,
                next_neighbour=None, prevs=None):
        return ([], [])


class _NoNamePhonemizer(Phonemizer):
    tag = 'X NO NAME'          # ★ 没有 name → 不合格

    def __init__(self):
        self.name = self.tag = self.language = ''

    def set_singer(self, singer):
        pass

    def process(self, notes, prev=None, next_=None, prev_neighbour=None,
                next_neighbour=None, prevs=None):
        return ([], [])


class _NoTagPhonemizer(Phonemizer):
    name = 'No Tag'            # ★ 没有 tag → 不合格

    def __init__(self):
        self.name = self.tag = self.language = ''

    def set_singer(self, singer):
        pass

    def process(self, notes, prev=None, next_=None, prev_neighbour=None,
                next_neighbour=None, prevs=None):
        return ([], [])


def main():
    fac_src = _src('PhonemizerFactory.cs')
    ins_src = _src('PhonemizerInstaller.cs')
    api.PhonemizerFactory.reset()

    # ================= 源码一致性
    print('--- 源码一致性 ---')
    check('源码: 反射读 PhonemizerAttribute',
          'type.GetCustomAttribute<PhonemizerAttribute>()' in fac_src)
    check('★ 源码: name 或 tag 为空 → return null',
          'string.IsNullOrEmpty(attr.Name) || string.IsNullOrEmpty(attr.Tag)' in fac_src)
    check('★ 源码: create() 只设 Name/Tag/Language（**不设 Author**）',
          'phonemizer.Name = name;' in fac_src
          and 'phonemizer.Tag = tag;' in fac_src
          and 'phonemizer.Language = language;' in fac_src
          and 'phonemizer.Author' not in fac_src)
    check('源码: ToString 有 author 时加 "(Contributed by …)"',
          'Contributed by {author}' in fac_src)
    check('★ 源码: GetOrAdd（命中时也会先构造）', 'factories.GetOrAdd(type, factory)' in fac_src)
    check('★ 源码: orderedFactories 初始为 []（不是 null）',
          'orderedFactories = []' in fac_src)
    check('源码: BuildList 按 tag OrderBy（稳定排序）',
          'OrderBy(f => f.tag).ToArray()' in fac_src)
    check('源码: Get(string) 在已缓存的 factories 里线性查 FullName',
          'foreach (var factory in factories.Values)' in fac_src
          and 'factory.type.FullName == typeFullName' in fac_src)
    check('源码: PhonemizerTypeValues 用 GetAll() ?? 空',
          'GetAll() ?? Array.Empty<PhonemizerFactory>()' in fac_src)
    check('源码: 安装器拷到 PathManager.Inst.PluginsPath 并覆盖',
          'PathManager.Inst.PluginsPath' in ins_src and 'File.Copy(filePath, destName, true)' in ins_src)

    # ================= 工厂注册
    print('--- 工厂注册 ---')
    f1 = api.PhonemizerFactory.get(_ZhPhonemizer)
    check('get(有 name/tag 的类) → 工厂', f1 is not None)
    check('  name/tag/language 从类属性读到',
          (f1.name, f1.tag, f1.language) == ('CVVC Phonemizer', 'ZH CVVC', 'ZH'),
          (f1.name, f1.tag, f1.language))
    check('  author 缺省为空串', f1.author == '', f1.author)
    check('get(同一个类) 返回**同一实例**（缓存）',
          api.PhonemizerFactory.get(_ZhPhonemizer) is f1)
    check('★ get(没有 name 的类) → None',
          api.PhonemizerFactory.get(_NoNamePhonemizer) is None)
    check('★ get(没有 tag 的类) → None',
          api.PhonemizerFactory.get(_NoTagPhonemizer) is None)
    check('  不合格的类**不进**注册表',
          _NoNamePhonemizer not in api.PhonemizerFactory.registered_types())

    # ================= create()
    print('--- create() ---')
    inst = f1.create()
    check('create() 造出实例并设好 name/tag/language',
          inst.name == 'CVVC Phonemizer' and inst.tag == 'ZH CVVC'
          and inst.language == 'ZH', (inst.name, inst.tag, inst.language))
    check('★ create() **不设** author（照搬 C#）',
          getattr(inst, 'author', '') == '', getattr(inst, 'author', ''))

    # ================= ToString
    print('--- ToString ---')
    check('无 author → "[tag] name"',
          str(f1) == '[ZH CVVC] CVVC Phonemizer', str(f1))
    f2 = api.PhonemizerFactory.get(_WithAuthorPhonemizer)
    check('有 author → 追加 "(Contributed by …)"',
          str(f2) == '[ZH VCV] Contributed One (Contributed by Lotte V)', str(f2))

    # ================= 有序列表
    print('--- 有序列表 ---')
    check('★ 没调 build_list() 时 get_all() 是**空列表**（不是 None）',
          api.PhonemizerFactory.get_all() == [], api.PhonemizerFactory.get_all())
    api.PhonemizerFactory.build_list()
    tags = [f.tag for f in api.PhonemizerFactory.get_all()]
    check('build_list() 后按 tag 升序', tags == sorted(tags), tags)

    # 稳定性：同 tag 的两个工厂保持插入序
    api.PhonemizerFactory.reset()

    @register
    class _SameTagA(Phonemizer):
        name = 'AAA'
        tag = 'SAME'

        def __init__(self):
            self.name = self.tag = self.language = ''

        def set_singer(self, singer):
            pass

    @register
    class _SameTagB(Phonemizer):
        name = 'BBB'
        tag = 'SAME'

        def __init__(self):
            self.name = self.tag = self.language = ''

        def set_singer(self, singer):
            pass

    api.PhonemizerFactory.get(_SameTagA)
    api.PhonemizerFactory.get(_SameTagB)
    api.PhonemizerFactory.build_list()
    same = [f.name for f in api.PhonemizerFactory.get_all() if f.tag == 'SAME']
    check('★ 同 tag 的工厂保持插入序（.NET OrderBy 是稳定排序）',
          same == ['AAA', 'BBB'], same)

    # ================= 按类型全名反查
    print('--- get_by_type_name ---')
    full = '%s.%s' % (_SameTagA.__module__, _SameTagA.__qualname__)
    got = api.PhonemizerFactory.get_by_type_name(full)
    check('按类型全名能反查到工厂', got is not None and got.name == 'AAA', (got and got.name))
    check('★ 未注册过的类型查不到（上游同样：只查已缓存的）',
          api.PhonemizerFactory.get_by_type_name('a.b.NotRegistered') is None)

    # ================= PhonemizerTypeValues
    print('--- PhonemizerTypeValues ---')
    vals = api.PhonemizerTypeValues.get_values()
    check('get_values() 返回 [(类型全名, 展示文案)]',
          bool(vals) and all(isinstance(x, tuple) and len(x) == 2 for x in vals), vals[:2])
    check('  展示文案就是 to_string()', vals[0][1].startswith('['), vals[0][1])
    check('  顺序跟 get_all() 一致',
          [v[0] for v in vals] ==
          ['%s.%s' % (f.type.__module__, f.type.__qualname__)
           for f in api.PhonemizerFactory.get_all()])

    # ================= 安装器
    print('--- PhonemizerInstaller ---')
    from singing.openutau.classic import resampler_item
    root = tempfile.mkdtemp(prefix='fufumidi-phoninst-')
    try:
        resampler_item.host.plugins_path_override = os.path.join(root, 'Plugins')
        src_dll = os.path.join(root, 'MyPhonemizer.dll')
        io.open(src_dll, 'w').write('fake')
        fn, dest = api.PhonemizerInstaller.install(src_dll)
        check('★ 安装到 plugins 目录并返回 (文件名, 目标目录)',
              fn == 'MyPhonemizer.dll'
              and os.path.isfile(os.path.join(dest, 'MyPhonemizer.dll')), (fn, dest))
        # 覆盖：再装一次同名文件
        io.open(src_dll, 'w').write('fake2')
        api.PhonemizerInstaller.install(src_dll)
        with io.open(os.path.join(dest, 'MyPhonemizer.dll'), encoding='utf-8') as f:
            check('★ 重复安装是**覆盖**（C# FileCopy 的 true）', f.read() == 'fake2')
        # plugins_path 是表达式属性
        resampler_item.host.plugins_path_override = ''
        resampler_item.host.data_path = os.path.join(root, 'Data')
        check('plugins_path 是表达式属性（<DataPath>/Plugins）',
              resampler_item.host.plugins_path == os.path.join(root, 'Data', 'Plugins'),
              resampler_item.host.plugins_path)
    finally:
        shutil.rmtree(root, ignore_errors=True)
        resampler_item.host.plugins_path_override = ''

    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


if __name__ == '__main__':
    sys.exit(main())