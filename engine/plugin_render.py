# -*- coding: utf-8 -*-
"""P2-1 VST3 离线渲染宿主（Phase A）

背景：应用内置插件节点（core/plugin_node.js）只能模拟 gain/EQ/压缩/饱和；真实 VST3 需要
宿主库。这里用 **pedalboard**（JUCE 封装，pip 可装）做离线宿主，不引入实时宿主：

  · FX：输入 WAV → 加载 .vst3 → 设参数 → 渲染 → 输出 WAV
  · 乐器：给音符列表（MIDI）→ 加载音源 .vst3 → 渲染 → 输出 WAV
  · 插件路径支持 .vst3 包目录或包内 DLL（pedalboard 在 Windows 上两种情况实测均需指向 DLL）

宿主解释器不在安装包里（pip 依赖数 GB 级环境）：由 FUFUMIDI_PLUGIN_PYTHON 指定，
开发机默认回退到 _attic/envs/plugin-uv；找不到时明确报 backend-missing。

CLI（主进程 main/plugin-host.js 调用；输出单行 JSON）：
  python plugin_render.py list --dir <dir> [--dir ...]
  python plugin_render.py fx --plugin <path> --in a.wav --out b.wav [--params '{"Name":0.5}']
  python plugin_render.py instrument --plugin <path> --notes '[{"note":60,"velocity":100,"start":0,"duration":0.5}]'
                                      --duration 2.0 --out c.wav [--sample-rate 48000]
"""
import argparse
import json
import os
import sys
import time

SR_DEFAULT = 48000
CANDIDATES = [
    os.environ.get('FUFUMIDI_PLUGIN_PYTHON'),
    r'E:\Midi\_attic\envs\plugin-uv\Scripts\python.exe',
]


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def need(mod):
    try:
        return __import__(mod)
    except Exception as e:  # noqa: BLE001
        raise RuntimeError('缺少 Python 依赖 %s（请在插件宿主环境里 pip install %s）：%s'
                           % (mod, mod, str(e)[:160]))


def load_pedalboard():
    return need('pedalboard')


def resolve_plugin(path):
    """插件路径 → pedalboard 可加载的 DLL 路径；支持 .vst3 包目录。"""
    p = os.path.abspath(str(path or ''))
    if os.path.isfile(p):
        return p
    if os.path.isdir(p):
        for root, _dirs, files in os.walk(p):
            for f in files:
                if f.lower().endswith('.vst3'):
                    return os.path.join(root, f)
    raise RuntimeError('找不到 VST3 插件：%s' % p)


def plugin_name(path):
    p = resolve_plugin(path)
    return os.path.basename(p).rsplit('.', 1)[0]


def list_plugins(dirs):
    seen, out = set(), []
    for d in dirs or []:
        d = os.path.abspath(str(d))
        if not os.path.isdir(d):
            continue
        for root, _sub, files in os.walk(d):
            for f in files:
                if not f.lower().endswith('.vst3'):
                    continue
                path = os.path.join(root, f)
                if path in seen:
                    continue
                seen.add(path)
                # 只列可加载的 .vst3 文件（Windows 上真正可加载的是包内 DLL）；
                # 包目录虽也能被 resolve_plugin 递归解析，但不重复列，避免列表噪声。
                out.append({'name': f.rsplit('.', 1)[0], 'path': path, 'format': 'vst3'})
    return out


def make_plugin(path):
    pb = load_pedalboard()
    return pb.load_plugin(resolve_plugin(path))


def apply_params(plugin, params):
    if not params:
        return []
    applied = []
    for name, value in params.items():
        try:
            plugin.set_parameter(name, float(value))
            applied.append(name)
        except Exception:  # noqa: BLE001
            pass
    return applied


def render_fx(args):
    sf = need('soundfile')
    import numpy as np  # noqa: F401
    t0 = time.time()
    plugin = make_plugin(args.plugin)
    audio, sr = sf.read(args.input, always_2d=True)
    audio = audio.astype('float32')
    if args.sample_rate:
        sr = int(args.sample_rate)
    params = json.loads(args.params) if args.params else {}
    applied = apply_params(plugin, params)
    out = plugin(audio.T, float(sr), buffer_size=int(args.buffer or 8192))
    out = np.asarray(out, dtype='float32')
    if out.ndim == 1:
        out = out.reshape(1, -1)
    sf.write(args.out, out.T, int(sr))
    peak = float(np.abs(out).max()) if out.size else 0.0
    rms = float(np.sqrt((out.astype('float64') ** 2).mean())) if out.size else 0.0
    emit({'ok': True, 'mode': 'fx', 'plugin': plugin.name, 'params': applied,
          'sampleRate': int(sr), 'seconds': round(out.shape[1] / float(sr), 3),
          'peak': round(peak, 5), 'rms': round(rms, 5), 'out': os.path.abspath(args.out),
          'elapsed': round(time.time() - t0, 2)})
    return 0


def render_instrument(args):
    sf = need('soundfile')
    mido = need('mido')
    import numpy as np
    t0 = time.time()
    sr = int(args.sample_rate or SR_DEFAULT)
    plugin = make_plugin(args.plugin)
    params = json.loads(args.params) if args.params else {}
    applied = apply_params(plugin, params)
    notes_raw = str(args.notes or '[]')
    if notes_raw.startswith('@'):
        with open(notes_raw[1:], 'r', encoding='utf-8') as f:
            notes_raw = f.read()
    notes = json.loads(notes_raw)
    if not notes:
        raise RuntimeError('没有音符（--notes 为空）')
    msgs = []
    for n in notes:
        note = max(0, min(127, int(n.get('note', 60))))
        vel = max(0, min(127, int(n.get('velocity', 100))))
        start = max(0.0, float(n.get('start', 0.0)))
        dur = max(0.01, float(n.get('duration', 0.5)))
        ch = max(0, min(15, int(n.get('channel', 0))))
        msgs.append(mido.Message('note_on', note=note, velocity=vel, time=start, channel=ch))
        msgs.append(mido.Message('note_off', note=note, velocity=0, time=start + dur, channel=ch))
    msgs.sort(key=lambda m: m.time)
    out = plugin(msgs, duration=float(args.duration), sample_rate=float(sr),
                 num_channels=int(args.channels or 2), buffer_size=int(args.buffer or 8192))
    out = np.asarray(out, dtype='float32')
    if out.ndim == 1:
        out = out.reshape(1, -1)
    sf.write(args.out, out.T, sr)
    peak = float(np.abs(out).max()) if out.size else 0.0
    rms = float(np.sqrt((out.astype('float64') ** 2).mean())) if out.size else 0.0
    emit({'ok': True, 'mode': 'instrument', 'plugin': plugin.name, 'params': applied,
          'sampleRate': sr, 'duration': float(args.duration), 'notes': len(notes),
          'peak': round(peak, 5), 'rms': round(rms, 5), 'out': os.path.abspath(args.out),
          'elapsed': round(time.time() - t0, 2)})
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description='FuFumidi VST3 离线渲染宿主')
    sub = ap.add_subparsers(dest='cmd', required=True)
    lp = sub.add_parser('list')
    lp.add_argument('--dir', action='append', default=[])
    lp.set_defaults(func=lambda a: (emit({'ok': True, 'plugins': list_plugins(a.dir)}), 0)[1])
    fx = sub.add_parser('fx')
    fx.add_argument('--plugin', required=True)
    fx.add_argument('--in', dest='input', required=True)
    fx.add_argument('--out', required=True)
    fx.add_argument('--params', default='')
    fx.add_argument('--sample-rate', type=int, default=0)
    fx.add_argument('--buffer', type=int, default=8192)
    fx.set_defaults(func=render_fx)
    ins = sub.add_parser('instrument')
    ins.add_argument('--plugin', required=True)
    ins.add_argument('--notes', required=True)
    ins.add_argument('--duration', type=float, required=True)
    ins.add_argument('--out', required=True)
    ins.add_argument('--params', default='')
    ins.add_argument('--sample-rate', type=int, default=SR_DEFAULT)
    ins.add_argument('--channels', type=int, default=2)
    ins.add_argument('--buffer', type=int, default=8192)
    ins.set_defaults(func=render_instrument)
    a = ap.parse_args(argv)
    try:
        return a.func(a) or 0
    except Exception as e:  # noqa: BLE001
        emit({'ok': False, 'error': str(e), 'code': 'plugin-error'})
        return 1


if __name__ == '__main__':
    sys.exit(main())
