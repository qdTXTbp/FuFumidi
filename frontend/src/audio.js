// 音频引擎单例：AudioContext + Synth + Player
// 惰性初始化：首次播放 / 导入时才创建，避免阻塞首屏。
import { Synth } from './core/synth.js';
import { Player } from './core/player.js';

let ctx = null;
let synth = null;
let player = null;

export function ensureAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('当前环境不支持 Web Audio API');
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
    synth = new Synth(ctx);
    // 加载音色工坊所选的音色库（优先），否则按环境回退：
    //   桌面端默认内置合成器，网页端默认内置 GeneralUser.sf2
    const saved = (typeof window !== 'undefined') ? window.__fufumidi_activeSoundfont : null;
    const bridge = (typeof window !== 'undefined') ? window.fuBridge : null;
    const source = saved && saved !== 'internal' ? saved : (bridge ? undefined : 'web:generaluser');
    synth.setSoundfont(source);
    player = new Player(synth);
    player.onEnd = () => {
      // 播完自动复位（由 store 监听处理 UI 状态）
      if (typeof window !== 'undefined' && window.__fufumidiOnEnd) window.__fufumidiOnEnd();
    };
  }
  if (ctx.state === 'suspended') ctx.resume();
  return { ctx, synth, player };
}

// 应用音色切换（音色工坊选择后立即生效 + 播放前使用）
export function applySoundfont(source) {
  ensureAudio();
  return synth.setSoundfont(source);
}
// 暴露当前 Synth 供 apply / 查询
export function setActiveSoundfontRef(v) {
  if (typeof window !== 'undefined') window.__fufumidi_activeSoundfont = v;
  if (synth) return synth.setSoundfont(v || 'internal');
  return Promise.resolve({ ok: true, using: 'internal' });
}

export function getCtx() { return ctx; }
export function getSynth() { return synth; }
export function getPlayer() { return player; }
export function hasAudio() { return !!ctx; }
