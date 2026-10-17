// ============================================================
// P2-2 音频 I/O 后端选择与延迟报告（纯逻辑）
// ============================================================
// 现状：应用默认走 WebAudio（跨平台、零安装）。原生 I/O（WASAPI 独占 / ASIO）需要
// Rust 侧 cpal/asio 支持，当前**未随包提供**，因此这里先冻结契约：
//   · 后端优先级与自动回退：native 不可用 → webaudio，且必须把原因写进报告（不静默）；
//   · 延迟口径统一：baseLatency + outputLatency + 输入缓冲 = 估算 RTL；
//   · 目标：RTL ≤ 10ms 才算「低延迟可用」。WebAudio 在 Windows 实测通常 20~40ms，
//     所以"达到目标"只能靠原生后端 —— 报告必须如实体现这一点。
//
// 纯函数，设备枚举/测量由调用方（renderer 或 Rust 侧）提供。

export const AUDIO_BACKENDS = [
  { id: 'webaudio', label: 'WebAudio', native: false, platforms: ['win32', 'darwin', 'linux'], exclusive: false },
  { id: 'wasapi-exclusive', label: 'WASAPI 独占（原生）', native: true, platforms: ['win32'], exclusive: true },
  { id: 'asio', label: 'ASIO（原生）', native: true, platforms: ['win32'], exclusive: true, requires: 'Steinberg ASIO SDK' },
  { id: 'coreaudio', label: 'CoreAudio（原生）', native: true, platforms: ['darwin'], exclusive: false },
  { id: 'alsa', label: 'ALSA/PipeWire（原生）', native: true, platforms: ['linux'], exclusive: false },
];

export const DEFAULT_TARGET_RTL_MS = 10;

/** 后端可用性：给定平台与"原生侧是否真的实现了" */
export function availableBackends(platform, nativeAvailable) {
  return AUDIO_BACKENDS.filter((b) => {
    if (!b.platforms.includes(platform)) return false;
    if (!b.native) return true;
    return !!nativeAvailable;
  }).map((b) => ({ ...b }));
}

/**
 * 选择后端。
 * @param {{setting?:'auto'|'webaudio'|'native'|string, nativeAvailable?:boolean, platform?:string}} p
 * @returns {{backend:string, native:boolean, fallback:boolean, reason:string}}
 */
export function chooseAudioBackend(p = {}) {
  const platform = String(p.platform || (typeof process !== 'undefined' ? process.platform : 'win32'));
  const nativeAvailable = !!p.nativeAvailable;
  const setting = String(p.setting || 'auto');
  const native = AUDIO_BACKENDS.filter((b) => b.native && b.platforms.includes(platform));
  const preferred = native[0] || null;
  if (setting === 'webaudio') {
    return { backend: 'webaudio', native: false, fallback: false, reason: '用户强制 WebAudio' };
  }
  if (setting === 'native' || setting === 'auto') {
    if (nativeAvailable && preferred) {
      return { backend: preferred.id, native: true, fallback: false, reason: '原生后端可用（' + preferred.label + '）' };
    }
    const why = setting === 'native'
      ? '设置了原生后端，但当前包未提供原生 I/O 实现 → 回退 WebAudio'
      : '原生 I/O 未随包提供 → 默认 WebAudio';
    return { backend: 'webaudio', native: false, fallback: true, reason: why };
  }
  // 未知取值：按 auto 处理，但报告里说明
  if (nativeAvailable && preferred) {
    return { backend: preferred.id, native: true, fallback: false, reason: '未知设置，按 auto 选原生：' + preferred.id };
  }
  return { backend: 'webaudio', native: false, fallback: true, reason: '未知设置，按 auto 回退 WebAudio' };
}

/**
 * 延迟报告：把 AudioContext 的 baseLatency/outputLatency（秒）与输入缓冲（毫秒）
 * 折算成估算 RTL。
 * @param {{baseLatency?:number, outputLatency?:number, inputLatencyMs?:number,
 *          sampleRate?:number, bufferFrames?:number}} p
 */
export function latencyReport(p = {}) {
  const base = Math.max(0, Number(p.baseLatency) || 0) * 1000;
  const output = Math.max(0, Number(p.outputLatency) || 0) * 1000;
  const input = Math.max(0, Number(p.inputLatencyMs) || 0);
  const sr = Math.max(1000, Number(p.sampleRate) || 44100);
  const bufferFrames = Math.max(0, Number(p.bufferFrames) || 0);
  const bufferMs = bufferFrames > 0 ? bufferFrames / sr * 1000 : 0;
  const rtl = base + output + input + bufferMs;
  return {
    baseMs: round(base),
    outputMs: round(output),
    inputMs: round(input),
    bufferMs: round(bufferMs),
    sampleRate: sr,
    estimatedRtlMs: round(rtl),
    targetMs: DEFAULT_TARGET_RTL_MS,
    withinTarget: rtl <= DEFAULT_TARGET_RTL_MS,
    grade: rtl <= DEFAULT_TARGET_RTL_MS ? 'low' : (rtl <= 25 ? 'medium' : 'high'),
  };
}

/** 把测量结果整理成一段人话报告（设置页/诊断包用） */
export function formatLatencyReport(report, backend) {
  const r = report || {};
  return [
    '后端：' + (backend || 'unknown'),
    '采样率：' + (r.sampleRate || '?') + ' Hz',
    'baseLatency：' + (r.baseMs != null ? r.baseMs + ' ms' : '?'),
    'outputLatency：' + (r.outputMs != null ? r.outputMs + ' ms' : '?'),
    '估算 RTL：' + (r.estimatedRtlMs != null ? r.estimatedRtlMs + ' ms' : '?')
      + '（目标 ≤ ' + (r.targetMs || DEFAULT_TARGET_RTL_MS) + ' ms → ' + (r.withinTarget ? '达标' : '未达标') + '）',
  ].join('\n');
}

/** 常见缓冲档位（帧）→ 毫秒，供设置界面的缓冲选择使用 */
export function bufferOptions(sampleRate = 48000) {
  const sr = Math.max(1000, Number(sampleRate) || 48000);
  return [64, 128, 256, 512, 1024, 2048].map((frames) => ({ frames, ms: round(frames / sr * 1000) }));
}

function round(v) { return Math.round(v * 100) / 100; }
