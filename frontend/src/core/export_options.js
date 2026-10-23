// ============================================================
// P0-4b 导出选项（纯映射/校验；UI 与 IPC 共用）
// ============================================================
// 设置里存的是字符串 id（export.audio.format / dither / loudness），导出面板把它规范成
// 一份确定的对象，再映射成 main/export.js 需要的 IPC 字段。纯函数，便于单测。
// P2-1：export.audio.plugins 是离线插件节点数组（gain/eq/compressor/saturator），
// 在渲染后、响度处理前应用（见 core/plugin_node.js）。

export const EXPORT_FORMATS = [
  { id: 'wav16', label: 'WAV 16-bit', bitDepth: 16, ext: 'wav' },
  { id: 'wav24', label: 'WAV 24-bit', bitDepth: 24, ext: 'wav' },
  { id: 'float32', label: 'WAV 32-bit float', bitDepth: 32, ext: 'wav' },
];

export const LOUDNESS_TARGETS = [
  { id: 'off', label: '关', targetLufs: null },
  { id: '-14', label: '−14 LUFS（流媒体）', targetLufs: -14 },
  { id: '-16', label: '−16 LUFS（播客）', targetLufs: -16 },
  { id: '-23', label: '−23 LUFS（广播 EBU R128）', targetLufs: -23 },
];

import { normalizePluginChain } from './plugin_node.js';

export function formatInfo(id) {
  return EXPORT_FORMATS.find((f) => f.id === id) || EXPORT_FORMATS[1];
}
export function loudnessInfo(id) {
  return LOUDNESS_TARGETS.find((l) => l.id === String(id)) || LOUDNESS_TARGETS[0];
}

/** 把设置/用户输入规范成导出选项（未知值回落到默认 wav24 / dither on / loudness off） */
export function normalizeExportOptions(raw = {}) {
  const fmt = EXPORT_FORMATS.some((f) => f.id === raw.format) ? raw.format : 'wav24';
  const loud = LOUDNESS_TARGETS.some((l) => l.id === String(raw.loudness)) ? String(raw.loudness) : 'off';
  return {
    format: fmt,
    bitDepth: formatInfo(fmt).bitDepth,
    ext: formatInfo(fmt).ext,
    dither: raw.dither == null ? true : !!raw.dither,
    loudness: loud,
    limiter: raw.limiter == null ? true : !!raw.limiter,
    stems: !!raw.stems,
    gainPct: Math.max(0, Math.min(150, Number(raw.gainPct == null ? 100 : raw.gainPct) || 0)),
    plugins: normalizePluginChain(raw.plugins),
  };
}

/** 设置补丁（保存到 settings.js 的键名） */
export function exportOptionsToSettings(opts = {}) {
  const o = normalizeExportOptions(opts);
  return {
    'export.audio.format': o.format,
    'export.audio.dither': o.dither,
    'export.audio.loudness': o.loudness,
    'export.audio.plugins': o.plugins,
  };
}

/**
 * 生成 bridge.exportAudio 的元数据（不含 bytes；渲染完成后补上）。
 * @param {{name:string, format:string, sampleRate:number, channels:number, durationSec:number,
 *          lufs?:number|null, peakDb?:number|null, targetLufs?:number|null, sourceName?:string}} p
 */
export function buildExportMeta(p = {}) {
  const o = normalizeExportOptions({ format: p.format });
  const loud = loudnessInfo(p.targetLufs == null ? 'off' : String(p.targetLufs));
  return {
    name: String(p.name || 'export'),
    ext: o.ext,
    format: o.format,
    bitDepth: o.bitDepth,
    sampleRate: Math.max(1000, Math.round(Number(p.sampleRate) || 44100)),
    channels: Math.max(1, Math.round(Number(p.channels) || 2)),
    durationSec: Number.isFinite(Number(p.durationSec)) ? Math.round(Number(p.durationSec) * 1000) / 1000 : null,
    lufs: Number.isFinite(Number(p.lufs)) ? Math.round(Number(p.lufs) * 10) / 10 : null,
    peakDb: Number.isFinite(Number(p.peakDb)) ? Math.round(Number(p.peakDb) * 100) / 100 : null,
    targetLufs: loud.targetLufs,
    sourceName: String(p.sourceName || ''),
  };
}

/** 文件预估：时长(秒) × 采样率 × 字节/样本 × 声道数 + 44 字节头 */
export function estimateFileBytes(sec, sampleRate, format) {
  const o = formatInfo(format);
  const bytes = Math.max(0, Number(sec) || 0) * Math.max(1000, Number(sampleRate) || 44100) * (o.bitDepth / 8) * 2 + 44;
  return Math.round(bytes);
}
