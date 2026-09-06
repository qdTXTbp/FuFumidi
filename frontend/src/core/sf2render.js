// ============================================================
// SF2 离线渲染：用当前音色工坊所选 SF2 音色把整曲渲染为 AudioBuffer，
// 供转换导出（WAV / 视频）使用——保证导出音频与播放音色一致。
// 此前导出恒用内置合成器（playVoice 预设），与播放时的 SF2 音色不符。
//
// 实现：js-synthesizer 的主线程 Synthesizer（非 worklet）+ libfluidsynth WASM，
// 在主线程按 128 帧块渲染（离线导出无实时约束，主线程渲染即可），
// 通道/程序映射与 synth.noteOn 的 SF2 路径一致（ch=min(15,trk)，鼓轨 SetChannelType）。
// ============================================================

let _libLoading = null;     // js-synthesizer.min.js + libfluidsynth 胶水（主线程）
let _renderSyn = null;      // 常驻离线合成器（同一 SF2/采样率重复导出免重载）
let _renderSynKey = '';

function loadScript(src) {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

async function ensureLib() {
  const w = window || {};
  if (w.JSSynth && w.Module) return true;
  if (!_libLoading) {
    _libLoading = (async () => {
      if (!w.JSSynth) {
        const ok = await loadScript('./vendor/js-synth/js-synthesizer.min.js');
        if (!ok || !(window || {}).JSSynth) throw new Error('js-synthesizer 脚本加载失败');
      }
      if (!(window || {}).Module) {
        const ok = await loadScript('./vendor/js-synth/libfluidsynth-2.4.6-with-libsndfile.js');
        if (!ok || !(window || {}).Module) throw new Error('libfluidsynth 运行时加载失败');
      }
      return true;
    })().catch((e) => { _libLoading = null; throw e; });
  }
  return _libLoading;
}

// 读取 .sf2 内容：与 synth.js 的 _readSf2Buffer 相同的解析规则
async function readSf2Buffer(source) {
  const isRel = source === 'web:generaluser' || (typeof source === 'string' && (source[0] === '.' || source[0] === '/'));
  if (isRel) {
    const paths = source === 'web:generaluser'
      ? ['../vendor/soundfonts/GeneralUser.sf2', './vendor/soundfonts/GeneralUser.sf2']
      : [source];
    for (const p of paths) {
      try { const res = await fetch(p); if (res.ok) return await res.arrayBuffer(); } catch (e) {}
    }
    return null;
  }
  const bridge = (typeof window !== 'undefined') ? window.fuBridge : null;
  if (bridge && bridge.readSoundFont) {
    try { const ab = await bridge.readSoundFont(source); return ab || null; } catch (e) { return null; }
  }
  try { const res = await fetch(source); if (res.ok) return await res.arrayBuffer(); } catch (e) { return null; }
}

async function ensureRenderSynth(source, sampleRate) {
  const key = source + '|' + sampleRate;
  if (_renderSyn && _renderSynKey === key) return _renderSyn;
  await ensureLib();
  const JSSynth = (window || {}).JSSynth;
  if (!JSSynth || !JSSynth.Synthesizer) throw new Error('JSSynth.Synthesizer 不可用');
  await JSSynth.waitForReady();
  const buf = await readSf2Buffer(source);
  if (!buf) throw new Error('无法读取音色文件');
  if (_renderSyn) { try { _renderSyn.close(); } catch (e) {} _renderSyn = null; }
  const syn = new JSSynth.Synthesizer();
  syn.init(sampleRate);
  await syn.loadSFont(new Uint8Array(buf));
  _renderSyn = syn;
  _renderSynKey = key;
  return syn;
}

// 当前生效的 SF2 来源（'internal' / 空返回 null）
export function activeSf2Source() {
  let v = null;
  try { v = window.__fufumidi_activeSoundfont || localStorage.getItem('fufumidi_soundfont') || null; } catch (e) { v = window.__fufumidi_activeSoundfont || null; }
  if (!v || v === 'internal') return null;
  return v;
}

// 整曲离线渲染 → AudioBuffer（2 通道）。opts:
//   rate 采样率 | scale 速度倍率 | startSec/endSec 导出切片（秒，归一化到片段起点）
//   onProgress(0..1) 进度回调
// 返回 null 表示当前未使用 SF2（调用方回退内置合成器渲染路径）
export async function renderSongWithSf2(song, opts = {}) {
  const source = activeSf2Source();
  if (!source || !song) return null;
  const sr = opts.rate || 44100;
  const scale = opts.scale || 1;
  const startSec = Math.max(0, opts.startSec || 0);
  const endSec = opts.endSec != null ? opts.endSec : (song.totalSec / scale);
  const segLen = Math.max(0, endSec - startSec);
  const TAIL = 1.5;
  const totalLen = Math.max(1, Math.ceil((segLen + TAIL) * sr));

  const syn = await ensureRenderSynth(source, sr);
  try { syn.midiSystemReset ? syn.midiSystemReset() : syn.reset(); } catch (e) {}

  // 音符事件（与 synth.noteOn 的 SF2 路径相同的通道/程序映射）
  const evs = [];
  for (const tr of song.tracks) {
    const ch = Math.min(15, tr.index || 0);
    if (tr.isDrum) { try { syn.midiSetChannelType(ch, true); } catch (e) {} }
    else { try { syn.midiProgramChange(ch, tr.program || 0); } catch (e) {} }
    for (const n of tr.notes) {
      const t0 = song.baseSec(n.start) / scale - startSec;
      const e0 = song.baseSec(n.end) / scale - startSec;
      if (e0 <= 0 || t0 >= segLen + TAIL) continue;
      if (e0 <= t0) continue;
      evs.push({ t: Math.max(0, t0), on: 1, key: n.midi, vel: n.vel, ch });
      evs.push({ t: Math.max(0, e0), on: 0, key: n.midi, ch });
    }
  }
  evs.sort((a, b) => a.t - b.t);

  // 分块渲染：块边界前触发到期事件（128 帧 ≈ 2.9ms 定位精度，与实时播放抖动同量级）
  const BLOCK = 128;
  const outL = new Float32Array(totalLen), outR = new Float32Array(totalLen);
  let pos = 0, ei = 0, lastP = 0;
  while (pos < totalLen) {
    const next = Math.min(pos + BLOCK, totalLen);
    const tNext = next / sr;
    while (ei < evs.length && evs[ei].t <= tNext) {
      const e = evs[ei++];
      try {
        if (e.on) syn.midiNoteOn(e.ch, e.key, e.vel);
        else syn.midiNoteOff(e.ch, e.key);
      } catch (err) {}
    }
    // render() 无返回值（失败经异常抛出），直接渲染到切片视图
    syn.render([outL.subarray(pos, next), outR.subarray(pos, next)]);
    pos = next;
    if (opts.onProgress) {
      const p = pos / totalLen;
      if (p - lastP >= 0.02) { lastP = p; try { opts.onProgress(p); } catch (e) {} }
    }
  }

  const octx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, 1, sr);
  const out = octx.createBuffer(2, totalLen, sr);
  out.copyToChannel(outL, 0);
  out.copyToChannel(outR, 1);
  return out;
}
