# -*- coding: utf-8 -*-
r"""onnxruntime 兼容自愈：显卡增强包里的 onnxruntime 加载不了这个声库的模型时，
自动改用**应用自带**的 CPU 版 onnxruntime 重跑同一个命令。

## 为什么必须有这一层

CUDA 增强包装的是 `onnxruntime-gpu==1.20.2`（见 `requirements-gpu-cuda.txt`），
主进程通过 PYTHONPATH 把它挂在引擎搜索路径**最前面**（`main.js:engineEnv`）。
实测这版运行时在**创建推理会话**时就会直接**段错误**（Windows 访问冲突 `0xC0000005`）——
那不是 Python 异常，**try/except 抓不到**，整个引擎进程当场消失。
踩到的文件：Ria（多语言声库）的 `ria-multi-dict.onnx` 与 `dsvariance/vari.variance.onnx`。
同一批文件用随包 Python 自带的 onnxruntime 1.30.0 加载完全正常；花火/空/芙宁娜的模型
两版都能加载 —— 所以只有部分声库会踩到，而且上层只看到一句「引擎退出码 3221225477」。

## 怎么做（三步，只影响「装了增强包」的机器）

1. 只在 `FUFUMIDI_GPU_KINDS` 非空（= 引擎正用着增强包的解释器）时才检查；
2. 对声库里每个 `.onnx` 起一个**子进程**去建会话（子进程崩了父进程毫发无损），
   结论按「解释器 + ORT 版本 + 每个模型的路径/大小/时间戳」写进
   `$FUFUMIDI_CACHE_DIR/ort-compat.json`，下次直接读缓存；
3. 有任何一个加载不了 → **起一个子进程重跑自己**，PYTHONPATH 里把解释器自带的
   site-packages 放到增强包**前面**（于是 `import onnxruntime` 解析到内置 CPU 版），
   并打上 `FUFUMIDI_ORT_FALLBACK=1` 标记避免来回重启；子进程把这条
   中文警告写进渲染结果的 `warnings`，用户能看到「这次为什么没用显卡版」。

★ 为什么是**子进程**而不是 `os.execve` 原地重启：Windows 的 CRT 只有半成品的
  `_execv`，本机实测 execve 之后的新进程**一启动就 0xC0000005 死掉**
  （连一行输出都没有）。子进程 + 转发 stdio 没有这个问题，退出码照样透传给上层。
"""

import json
import os
import subprocess
import sys
import sysconfig

#: 打过这个标记就不再自愈（否则「崩溃 → 重启 → 还是崩」会无限循环）
FALLBACK_ENV = 'FUFUMIDI_ORT_FALLBACK'

#: 子进程探针：建一个 CPU 会话就退出。加载不了 → 进程直接死，退出码非 0。
_PROBE = ("import sys, onnxruntime as ort\n"
          "ort.InferenceSession(sys.argv[1], providers=['CPUExecutionProvider'])\n"
          "print('OK')\n")

#: 单模型探针超时（秒）：大模型首次加载要几秒，给足；**超时不算坏**（不惩罚慢机器）
PROBE_TIMEOUT = 300

FALLBACK_WARNING = (
    "显卡增强包里的 onnxruntime 加载不了这个声库的模型（进程级崩溃），"
    "已自动改用应用自带的 CPU 版 onnxruntime；要恢复显卡加速请更新/重装显卡增强包"
)


def model_files(bank_dir):
    """声库里会用到的 onnx（递归找，稳定排序）。"""
    out = []
    for root, dirs, files in os.walk(bank_dir):
        dirs.sort()
        for f in sorted(files):
            if f.lower().endswith('.onnx'):
                out.append(os.path.join(root, f))
    return out


def _cache_path():
    d = os.environ.get('FUFUMIDI_CACHE_DIR')
    if not d:
        d = os.path.join(os.environ.get('TEMP') or os.environ.get('TMP') or '.', 'fufumidi')
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        return None
    return os.path.join(d, 'ort-compat.json')


def _ort_version():
    try:
        import onnxruntime as ort
        return str(getattr(ort, '__version__', '?'))
    except Exception:                                   # noqa: BLE001
        return '?'


def cache_key(models):
    """解释器 + ORT 版本 + 每个模型的路径/大小/时间戳 → 键。

    换声库、换模型文件、换运行时都会让缓存自动失效。"""
    parts = [sys.executable, _ort_version()]
    for p in models:
        try:
            st = os.stat(p)
            parts.append('%s:%d:%d' % (p, st.st_size, int(st.st_mtime)))
        except OSError:
            parts.append(p + ':missing')
    return '|'.join(parts)


def _load_cache():
    p = _cache_path()
    if not p:
        return {}
    try:
        with open(p, encoding='utf-8') as f:
            return json.load(f) or {}
    except Exception:                                   # noqa: BLE001
        return {}


def _save_cache(data):
    p = _cache_path()
    if not p:
        return
    try:
        tmp = p + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f)
        os.replace(tmp, p)
    except Exception:                                   # noqa: BLE001
        pass


def probe_models(models, runner=None):
    """返回**加载不了**的模型列表（子进程崩了 / 退出码非 0 就算）。

    `runner`：测试注入用，签名 `(argv) -> returncode`。
    """
    broken = []
    for path in models:
        if runner is not None:
            code = runner([sys.executable, '-c', _PROBE, path])
        else:
            try:
                r = subprocess.run([sys.executable, '-c', _PROBE, path],
                                   capture_output=True, timeout=PROBE_TIMEOUT,
                                   env=dict(os.environ))
                code = r.returncode
            except subprocess.TimeoutExpired:
                continue                                # 太慢但没崩：不判它坏
            except Exception:                           # noqa: BLE001
                continue
        if code != 0:
            broken.append(path)
    return broken


def check(bank_dir, runner=None):
    """→ (broken_models, from_cache)。没有模型时返回空。"""
    models = model_files(bank_dir)
    if not models:
        return [], False
    key = cache_key(models)
    cache = _load_cache()
    hit = cache.get(key)
    if isinstance(hit, list):
        return [p for p in hit if p in models], True
    broken = probe_models(models, runner=runner)
    cache[key] = broken
    _save_cache(cache)
    return broken, False


def bootstrap(bank_dir, argv=None, runner=None, execute=None):
    """要写进渲染结果 warnings 的说明（空串 = 什么都没发生；重启时**本函数不返回**）。"""
    if os.environ.get(FALLBACK_ENV) == '1':
        # 已经自愈过一轮：这次就是内置 CPU 版在跑，把原因报给用户
        return FALLBACK_WARNING
    kinds = (os.environ.get('FUFUMIDI_GPU_KINDS') or '').strip()
    if not kinds:
        return ''                                       # 没装增强包：用的本来就是内置版
    if not bank_dir or not os.path.isdir(bank_dir):
        return ''
    try:
        broken, from_cache = check(bank_dir, runner=runner)
    except Exception:                                   # noqa: BLE001
        return ''                                       # 自愈失败不该连累渲染
    if not broken:
        return ''
    (execute or execute_fallback)(argv if argv is not None else sys.argv, broken, from_cache)
    return FALLBACK_WARNING                             # 走到这里说明子进程那条路没接管


def fallback_env(from_env=None):
    """算出「内置 site-packages 优先」的 PYTHONPATH（纯函数，便于测试）。"""
    env = dict(os.environ if from_env is None else from_env)
    purelib = ''
    try:
        purelib = sysconfig.get_paths().get('purelib') or ''
    except Exception:                                   # noqa: BLE001
        purelib = ''
    paths = [purelib] if (purelib and os.path.isdir(purelib)) else []
    for p in (env.get('PYTHONPATH') or '').split(os.pathsep):
        if p and p not in paths:
            paths.append(p)
    if paths:
        env['PYTHONPATH'] = os.pathsep.join(paths)
    env[FALLBACK_ENV] = '1'
    return env


def _pump(stream, out):
    """把子进程的一路输出原样转发到我们这一路（###PROG / ###RESULT 都是行协议）。"""
    try:
        for line in iter(stream.readline, b''):
            out.write(line)
            out.flush()
    except Exception:                                   # noqa: BLE001
        pass                                            # 父进程被上层杀掉时管道会断，正常
    finally:
        try:
            stream.close()
        except Exception:                               # noqa: BLE001
            pass


def _binary(stream):
    return getattr(stream, 'buffer', stream)


def execute_fallback(argv, broken, from_cache=False):
    """起子进程用「内置 site-packages 优先」的 PYTHONPATH 重跑自己，然后透传退出码。

    ★ 不用 os.execve：Windows 上那条路径会让新进程一启动就崩（见模块说明）。
    """
    import threading
    env = fallback_env()
    sys.stderr.write('[ort] %s\n' % FALLBACK_WARNING)
    sys.stderr.write('[ort] 加载不了：%s（缓存=%s）\n'
                     % (', '.join(os.path.basename(b) for b in broken),
                        '是' if from_cache else '否'))
    sys.stderr.flush()
    try:
        sys.stdout.flush()
    except Exception:                                   # noqa: BLE001
        pass
    p = subprocess.Popen([sys.executable] + list(argv), env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    t_out = threading.Thread(target=_pump, args=(p.stdout, _binary(sys.stdout)), daemon=True)
    t_err = threading.Thread(target=_pump, args=(p.stderr, _binary(sys.stderr)), daemon=True)
    t_out.start()
    t_err.start()
    code = p.wait()
    t_out.join(5)
    t_err.join(5)
    raise SystemExit(code)