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
    // 应用持久化的音效设置（EQ/低音增强/空间声），随存随用
    try {
      const fx = JSON.parse(localStorage.getItem('fufumidi_fx') || 'null');
      if (fx) {
        if (fx.enabled) synth.setFxEnabled(true);
        if (Array.isArray(fx.gains)) synth.setEqGains(fx.gains);
        if (typeof fx.bass === 'number') synth.setBassBoost(fx.bass);
        if (typeof fx.spatial === 'number') synth.setSpatial(fx.spatial);
      }
    } catch (e) {}
    // 加载音色工坊所选的音色库（优先），否则按环境回退：
    //   桌面端默认内置合成器，网页端默认内置 GeneralUser.sf2
    // localStorage 直读：启动时 restoreSongs→selectSong→ensureAudio 先于 settings 异步加载，
    // window 引用此时尚未同步（曾导致重启后总是回退内置音色），localStorage 同步读取无竞态
    let saved = null;
    try { saved = window.__fufumidi_activeSoundfont || localStorage.getItem('fufumidi_soundfont') || null; } catch (e) { saved = window.__fufumidi_activeSoundfont || null; }
    const bridge = (typeof window !== 'undefined') ? window.fuBridge : null;
    const source = saved && saved !== 'internal' ? saved : (bridge ? undefined : 'web:generaluser');
    // 记录已应用音色：settings 首次同步时据此判断是否需要竞态自愈补加载。
    // 此处先按预期值标记，待 setSoundfont 返回结果后如实修正（见下）：
    // 若启动时 SF2 加载失败（文件被删/移动/损坏，synth 内部会静默回退内置），
    // 仍保留乐观标记会让 settings 自愈误判「已应用」而跳过补加载。
    if (typeof window !== 'undefined') window.__fufumidi_appliedSoundfont = source || 'internal';
    // 诊断钩子：CDP/控制台读取当前播放器实例（只读用途）
    if (typeof window !== 'undefined') window.__fufumidiActivePlayer = null;
    synth.setSoundfont(source).then((r) => {
      // 3.2.6 自查修复：SF2 加载失败时 synth 内部已静默回退内置（r.using !== 'sf2'），
      // 此时如实降级标记，让 settings 同步的自愈机制可识别并补加载；
      // 成功加载 SF2 时维持上方乐观标记（标记语义 = 已选音色源路径）。
      if (typeof window !== 'undefined' && (!r || r.using !== 'sf2')) window.__fufumidi_appliedSoundfont = 'internal';
    }).catch(() => {
      if (typeof window !== 'undefined') window.__fufumidi_appliedSoundfont = 'internal';
    });
    player = new Player(synth);
    if (typeof window !== 'undefined') window.__fufumidiActivePlayer = player;
    player.onEnd = () => {
      // 播完自动复位（由 store 监听处理 UI 状态）
      if (typeof window !== 'undefined' && window.__fufumidiOnEnd) window.__fufumidiOnEnd();
      // 播放模式自动切歌（App.vue 注入 handleTrackEnd）
      if (typeof window !== 'undefined' && window.__fufumidiAutoNext) {
        setTimeout(() => { try { window.__fufumidiAutoNext(); } catch (e) {} }, 10);
      }
    };
    // 曲尾淡出（无缝过渡的听觉掩蔽；可在音效面板关闭）
    window.__fufumidiBaseVol = 0.85;
    setInterval(() => {
      try {
        if (!player || !player.song || !ctx || ctx.state !== 'running') return;
        const xf = localStorage.getItem('fufumidi_crossfade') !== '0';
        const base = window.__fufumidiBaseVol != null ? window.__fufumidiBaseVol : 0.85;
        if (!xf) { if (synth && synth.master.gain.value !== base) synth.setVolume(base); return; }
        // 睡眠定时淡出优先（<15s 时不叠加曲尾淡出）
        if (window.__fufumidiSleepFade) return;
        const cur = player.currentSec();
        const total = player.song.totalSec || 0;
        const left = total - cur;
        // 曲尾淡出 + 曲首淡入（从头播放时），歌曲衔接更顺滑
        if (player.playing && left > 0 && left < 1.5) synth.setVolume(Math.max(0.05, base * (left / 1.5)));
        else if (player.playing && cur < 0.6 && left > 1.5) synth.setVolume(Math.max(0.05, base * Math.min(1, cur / 0.6)));
        else if (synth.master.gain.value !== base) synth.setVolume(base);
      } catch (e) {}
    }, 300);
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
