# -*- coding: utf-8 -*-
r"""`engine_diffsinger.py` 的**契约测试**（CLI 层）。

★ 为什么重写：旧版测的是**已删除的「v2 五段式」路径**（`pipeline == "v2"`）——
  那条管线上游根本不存在。现在测的是与上游对齐的 `pipeline == "upstream"`。

本文件**不需要 pytest**（随包的 `resources/python` 没装），可直接
`python tests/test_diffsinger_cli.py` 运行；也能被 pytest 收集。

要验的契约（`main/diffsinger.js` 与 `singing/adapters/diffsinger.py` 依赖）：
1. `###RESULT` / `###PROG` 前缀与 JSON 可解析
2. 失败时也是**退出码 0 + `ok:false`**（不是 `sys.exit(1)`）
3. `###PROG` 的 `percent` 单调不减、落在 0..100
4. 渲染返回键齐全（`ok/out/duration_ms/warnings/engine_version/phoneme_count/
   sample_rate/device/pipeline/range`）
5. 缺 `dsdur/` 的声库**明确报错**（上游 `SetSinger` 的强契约，不静默退化）
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE_DIR = os.path.dirname(HERE)
ENGINE = os.path.join(ENGINE_DIR, 'engine_diffsinger.py')
BANK = os.environ.get('DIFFSINGER_TEST_BANK') or \
    r'C:\Users\26276\Downloads\Compressed\liu2_ying2'

# ★ 契约里的 `engineVersion` / `engine_version` 要与引擎的 VERSION 一致
sys.path.insert(0, os.path.dirname(HERE))
import engine_diffsinger as _EDG                                # noqa: E402

VERSION = _EDG.VERSION

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    shown = '' if cond or detail is None else ('\n       ' + str(detail))
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label, shown))


def python_exe():
    """优先用随包的 python（与应用运行时一致），否则用当前解释器。"""
    bundled = os.path.join(os.path.dirname(ENGINE_DIR), 'resources', 'python',
                           'python.exe')
    return bundled if os.path.isfile(bundled) else sys.executable


def run(*args):
    p = subprocess.run([python_exe(), ENGINE] + list(args),
                       capture_output=True, text=True, encoding='utf-8',
                       errors='replace', cwd=ENGINE_DIR)
    return p


def parse_lines(stdout, prefix):
    out = []
    for line in stdout.splitlines():
        if line.startswith(prefix):
            body = line[len(prefix):].strip()
            try:
                out.append(json.loads(body))
            except Exception:  # noqa: BLE001
                pass
    return out


def main():
    print('引擎:', ENGINE)
    print('声库:', BANK)
    print()

    # ---------------- deps
    print('--- deps ---')
    p = run('deps', '--check')
    check('退出码 0', p.returncode == 0, p.returncode)
    res = parse_lines(p.stdout, '###RESULT ')
    check('有 ###RESULT 且可解析', len(res) == 1, p.stdout[:200])
    if res:
        r = res[0]
        check('ok=true', r.get('ok') is True)
        check('含 installed/missing/gpu',
              all(k in r for k in ('installed', 'missing', 'gpu')), sorted(r))
        check('★ 报告 pypinyin 缺失（打包缺口）',
              'pypinyin' in r.get('installed', []) or 'pypinyin' in r.get('missing', []),
              r.get('missing'))

    # ---------------- inspect
    print('--- inspect ---')
    if not os.path.isdir(BANK):
        print('  跳过：找不到声库')
    else:
        p = run('inspect', '--voicebank', BANK)
        check('退出码 0', p.returncode == 0, p.returncode)
        res = parse_lines(p.stdout, '###RESULT ')
        check('有 ###RESULT', len(res) == 1, p.stdout[:200])
        if res:
            r = res[0]
            check('ok=true', r.get('ok') is True, r.get('error'))
            check('★ pipeline == "upstream"', r.get('pipeline') == 'upstream',
                  r.get('pipeline'))
            check('音素数 189', r.get('phonemeCount') == 189, r.get('phonemeCount'))
            check('语言前缀含 zh', 'zh' in (r.get('langPrefixes') or []),
                  r.get('langPrefixes'))
            # ★ 注意：旧版也没有 `hasVocoder`，前端用的是 `builtinVocoder`
            check('hasAcoustic/hasDur 都为真',
                  r.get('hasAcoustic') and r.get('hasDur'),
                  (r.get('hasAcoustic'), r.get('hasDur')))
            check('vocoder 字段是 onnx 文件名',
                  str(r.get('vocoder') or '').endswith('.onnx'), r.get('vocoder'))
            check('hasPitchPredictor 为真（本声库有 dspitch）',
                  r.get('hasPitchPredictor') is True, r.get('hasPitchPredictor'))
            # ---- ★ 以下字段是 `ViewDiffSinger.vue:306-310` **直接渲染**的，
            #   少一个就会在页面上出现「词典 undefined 词」或错误的声码器提示。
            check('★ name 来自 character.txt（不是目录名）',
                  r.get('name') == '流萤', r.get('name'))
            check('★ dictionaryWords 是数字（词典 N 词）',
                  isinstance(r.get('dictionaryWords'), int)
                  and r['dictionaryWords'] > 0, r.get('dictionaryWords'))
            check('★ builtinVocoder 为真（本声库自带 dsvocoder/）',
                  r.get('builtinVocoder') is True, r.get('builtinVocoder'))
            check('★ languages 是字符串数组（匹配 TS 声明）',
                  isinstance(r.get('languages'), list)
                  and all(isinstance(x, str) for x in r['languages']),
                  r.get('languages'))
            check('★ 同时给 engineVersion 与 engine_version（两种命名都兼容）',
                  r.get('engineVersion') == r.get('engine_version') == VERSION,
                  (r.get('engineVersion'), r.get('engine_version')))

    # ---------------- render
    print('--- render ---')
    if not os.path.isdir(BANK):
        print('  跳过：找不到声库')
    else:
        notes = [{'startBeat': 0.375, 'durBeat': 0.375, 'pitch': 62, 'lyric': 'zh/n'},
                 {'startBeat': 0.75, 'durBeat': 0.375, 'pitch': 63, 'lyric': 'zh/i'},
                 {'startBeat': 1.375, 'durBeat': 0.375, 'pitch': 61, 'lyric': 'zh/h'},
                 {'startBeat': 1.75, 'durBeat': 0.5, 'pitch': 62, 'lyric': 'zh/ao'}]
        out = os.path.join(os.environ.get('TEMP', '.'), '_cli_contract.wav')
        p = run('render', '--voicebank', BANK,
                '--notes', json.dumps(notes, ensure_ascii=False),
                '--bpm', '120', '--out', out, '--device', 'cpu')
        check('★ 失败也是退出码 0（不是 sys.exit(1)）', p.returncode == 0, p.returncode)
        prog = parse_lines(p.stdout, '###PROG ')
        check('有 ###PROG', len(prog) >= 2, len(prog))
        if prog:
            pcts = [x.get('percent', -1) for x in prog]
            check('★ percent 单调不减', all(pcts[i] <= pcts[i + 1]
                                            for i in range(len(pcts) - 1)), pcts)
            check('★ percent 落在 0..100', all(0 <= v <= 100 for v in pcts), pcts)
            check('★ percent 单调（progress 有序）', pcts == sorted(pcts), pcts)
        res = parse_lines(p.stdout, '###RESULT ')
        check('有 ###RESULT', len(res) == 1, p.stdout[-300:])
        if res:
            r = res[0]
            check('ok=true', r.get('ok') is True, r.get('error'))
            check('★ 返回键齐全',
                  all(k in r for k in ('ok', 'out', 'duration_ms', 'warnings',
                                       'engine_version', 'phoneme_count',
                                       'sample_rate', 'device', 'pipeline', 'range')),
                  sorted(r))
            check('★ pipeline == "upstream"', r.get('pipeline') == 'upstream',
                  r.get('pipeline'))
            check('★ 时长 1100–1300 ms（期望 1126）',
                  1100 <= (r.get('duration_ms') or 0) <= 1300, r.get('duration_ms'))
            check('★ 不含 wav 键（CLI 不该吐采样）', 'wav' not in r, sorted(r))
            check('采样率 44100', r.get('sample_rate') == 44100, r.get('sample_rate'))
            check('输出文件存在', os.path.isfile(r.get('out') or ''), r.get('out'))

    # ---------------- 缺 dsdur 的声库必须报错
    print('--- 缺 dsdur/ 的声库（上游强契约）---')
    import tempfile
    import shutil
    tmp = tempfile.mkdtemp(prefix='fufumidi-nodur-')
    try:
        p = run('inspect', '--voicebank', tmp)
        check('★ 退出码 0（仍走 ok:false）', p.returncode == 0, p.returncode)
        res = parse_lines(p.stdout, '###RESULT ')
        check('★ ok=false', res and res[0].get('ok') is False, res)
        check('★ 错误信息提到 dsdur',
              res and 'dsdur' in (res[0].get('error') or ''), res)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # ---------------- pitch-edit
    print('--- pitch-edit ---')
    if not os.path.isdir(BANK):
        print('  跳过：找不到声库')
    else:
        p = run('pitch-edit', '--voicebank', BANK,
                '--notes', '[{"startBeat":0,"durBeat":1,"pitch":60,"lyric":"zh/a"}]',
                '--bpm', '120', '--device', 'cpu')
        check('退出码 0', p.returncode == 0, p.returncode)
        res = parse_lines(p.stdout, '###RESULT ')
        check('有 ###RESULT', len(res) == 1, p.stdout[:200])
        if res:
            r = res[0]
            check('ok=true', r.get('ok') is True, r.get('error'))
            check('★ pipeline == "upstream-pitch"',
                  r.get('pipeline') == 'upstream-pitch', r.get('pipeline'))
            check('含 points 且是 [x,y] 对',
                  isinstance(r.get('points'), list)
                  and all(len(x) == 2 for x in (r.get('points') or [])[:3]),
                  (r.get('point_count'), r.get('points', [])[:2]))

    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


def test_cli_contract():
    """pytest 入口（随包 python 没装 pytest 时整个模块仍可 `python` 直接跑）。"""
    assert main() == 0


if __name__ == '__main__':
    sys.exit(main())
