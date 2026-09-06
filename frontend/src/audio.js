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
    // localStorage 直读：启动时 restoreSongs→selectSong→ensureAudio 先于 settings 异步加载，
    // window 引用此时尚未同步（曾导致重启后总是回退内置音色），localStorage 同步读取无竞态
    let saved = null;
    try { saved = window.__fufumidi_activeSoundfont || localStorage.getItem('fufumidi_soundfont') || null; } catch (e) { saved = window.__fufumidi_activeSoundfont || null; }
    const bridge = (typeof window !== 'undefined') ? window.fuBridge : null;
    const source = saved && saved !== 'internal' ? saved : (bridge ? undefined : 'web:generaluser');
    // 记录已应用音色：settings 首次同步时据此判断是否需要竞态自愈补加载
    if (typeof window !== 'undefined') window.__fufumidi_appliedSoundfont = source || 'internal';
    // 诊断钩子：CDP/控制台读取当前播放器实例（只读用途）
    if (typeof window !== 'undefined') window.__fufumidiActivePlayer = null;
    synth.setSoundfont(source);
    player = new Player(synth);
    if (typeof window !== 'undefined') window.__fufumidiActivePlayer = player;
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
export async function setActiveSoundfontRef(v) {
  if (typeof window !== 'undefined') {
    window.__fufumidi_activeSoundfont = v;
    window.__fufumidi_appliedSoundfont = v || 'internal';
    // 同步写 localStorage：ensureAudio 启动时同步直读（settings 异步加载前即可恢复上次选择）
    try { localStorage.setItem('fufumidi_soundfont', v || 'internal'); } catch (e) {}
  }
  if (!synth) return Promise.resolve({ ok: true, using: 'internal' });
  // 切换音色前确保 AudioContext 处于运行态（首次交互/切页可能 suspended，
  // 加载 SF2 时若未 resume 会让某些环境下的初始化/解码异常，表现为「应用失败」）
  if (ctx && ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
  return synth.setSoundfont(v || 'internal');
}

export function getCtx() { return ctx; }
export function getSynth() { return synth; }
export function getPlayer() { return player; }
export function hasAudio() { return !!ctx; }
