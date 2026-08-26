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
    ctx = new AC();
    synth = new Synth(ctx);
    synth.loadSf2();
    player = new Player(synth);
    player.onEnd = () => {
      // 播完自动复位（由 store 监听处理 UI 状态）
      if (typeof window !== 'undefined' && window.__fufumidiOnEnd) window.__fufumidiOnEnd();
    };
  }
  if (ctx.state === 'suspended') ctx.resume();
  return { ctx, synth, player };
}

export function getCtx() { return ctx; }
export function getSynth() { return synth; }
export function getPlayer() { return player; }
export function hasAudio() { return !!ctx; }
