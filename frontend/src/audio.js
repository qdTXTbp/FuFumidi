// 音频引擎单例：AudioContext + Synth + Player
// 惰性初始化：首次播放 / 导入时才创建，避免阻塞首屏。
import { Synth } from './core/synth.js';
import { Player } from './core/player.js';
import { t } from './core/i18n.js';

let ctx = null;
let synth = null;
let player = null;
let __fufumidiCtxWedged = false;   // synth 实测报告「context 被毒化」（见 ensureEngineHealthy）

// 初始化必须整体成功才落到模块变量（见下方 catch 的说明），所以这里用局部名装配。
export function ensureAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error(t('当前环境不支持 Web Audio API'));
    let c = null;
    try {
      try { c = new AC({ latencyHint: 'interactive' }); } catch (e) { c = new AC(); }
      const s = new Synth(c);
      // 应用持久化的音效设置（EQ/低音增强/空间声），随存随用
      try {
        const fx = JSON.parse(localStorage.getItem('fufumidi_fx') || 'null');
        if (fx) {
          if (fx.enabled) s.setFxEnabled(true);
          if (Array.isArray(fx.gains)) s.setEqGains(fx.gains);
          if (typeof fx.bass === 'number') s.setBassBoost(fx.bass);
          if (typeof fx.spatial === 'number') s.setSpatial(fx.spatial);
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
      s.setSoundfont(source).then((r) => {
        // 3.2.6 自查修复：SF2 加载失败时 synth 内部已静默回退内置（r.using !== 'sf2'），
        // 此时如实降级标记，让 settings 同步的自愈机制可识别并补加载；
        // 成功加载 SF2 时维持上方乐观标记（标记语义 = 已选音色源路径）。
        if (typeof window !== 'undefined' && (!r || r.using !== 'sf2')) window.__fufumidi_appliedSoundfont = 'internal';
      }).catch(() => {
        if (typeof window !== 'undefined') window.__fufumidi_appliedSoundfont = 'internal';
      });
      const p = new Player(s);
      p.onEnd = () => {
        // 播完自动复位（由 store 监听处理 UI 状态）
        if (typeof window !== 'undefined' && window.__fufumidiOnEnd) window.__fufumidiOnEnd();
        // 播放模式自动切歌（App.vue 注入 handleTrackEnd）
        if (typeof window !== 'undefined' && window.__fufumidiAutoNext) {
          setTimeout(() => { try { window.__fufumidiAutoNext(); } catch (e) {} }, 10);
        }
      };
      // ★ 引擎自愈钩子：SF2 worklet 毒化实测（装载成功但 context 永远 suspended）时，
      //   synth 会回调这里；audio.js 在下一次 ensureEngineHealthy 里整体重建。
      s.onContextWedged = () => { __fufumidiCtxWedged = true; };
      // 三件都建好后再落到模块变量：任何一步抛异常都不会留下
      // 「ctx 有值但 synth/player 为 null」的半初始化单例。那种状态下上面这个 if (!ctx)
      // 永远不会再进入、也就永远不会重建，而调用方（如 selectSong 里的 player.stop()）
      // 会直接崩在 null 上 —— 表现为「任何一次选曲都失败，必须重启应用」。
      ctx = c; synth = s; player = p;
      if (typeof window !== 'undefined') window.__fufumidiActivePlayer = p;
    } catch (e) {
      // 关掉半成品上下文并保持模块变量为 null，让下一次 ensureAudio 能重新尝试
      try { if (c && c.state !== 'closed') c.close(); } catch (_) {}
      ctx = null; synth = null; player = null;
      throw e;
    }
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

/**
 * 引擎健康自愈：播放前调用。context 卡死在 suspended（resume 永不返回）时整体重建。
 * 背景（2026-10-11 曲库全无声事故）：libfluidsynth 的 worklet 胶水在部分环境会把
 * AudioContext 毒化成「装载一切成功、但永远无声」，且 resume() 的 promise 永不 settle ——
 * 唯一的解法是换一个全新 AudioContext（实测新建的 context 立即 running）。
 * 重建会封禁本会话的 worklet 合成路径（sessionStorage 标记，synth 侧读取），
 * 下一次 setSoundfont 直接走主线程 ScriptProcessor 合成。
 * 返回 { rebuilt }：rebuilt=true 时旧 player 已废弃，调用方必须重新装载当前曲目。
 */
export async function ensureEngineHealthy() {
  ensureAudio();
  if (ctx.state === 'running' && !__fufumidiCtxWedged) return { rebuilt: false };
  if (ctx.state !== 'running') {
    // SF2 装载若在进行中，等它结束再判断（装载期间 state 可能仍 suspended）
    try { if (synth && synth.sf2Loading) await Promise.race([synth.sf2Loading, new Promise((r) => setTimeout(r, 3000))]); } catch (e) {}
    if (ctx.state === 'running' && !__fufumidiCtxWedged) return { rebuilt: false };
    let ok = false;
    try {
      ok = await Promise.race([
        ctx.resume().then(() => ctx.state === 'running').catch(() => false),
        new Promise((r) => setTimeout(() => r(false), 1500)),
      ]);
    } catch (e) { ok = false; }
    if (ok && !__fufumidiCtxWedged) return { rebuilt: false };
  }
  // ——到这里：context 救不回来 —— 整体重建 ——
  // ★ 重试循环：本机实测「渲染器刚启动那几秒创建的 AudioContext 会永久卡死在
  //   suspended（resume 永不返回），稍后创建的正常」—— 所以重建后若仍不 running，
  //   关掉重试（最多 5 次、间隔 800ms），总能拿到一个健康的 context。
  console.warn('[audio] AudioContext 无法恢复（启动期创建的 context 已损坏），重建音频引擎');
  try { sessionStorage.setItem('fufumidi_worklet_banned', '1'); } catch (e) {}
  let running = false;
  for (let i = 0; i < 5 && !running; i++) {
    try { if (ctx && ctx.state !== 'closed') { try { ctx.close(); } catch (e2) {} } } catch (e) {}
    ctx = null; synth = null; player = null;
    __fufumidiCtxWedged = false;
    ensureAudio();
    try {
      running = await Promise.race([
        ctx.resume().then(() => ctx.state === 'running').catch(() => false),
        new Promise((r) => setTimeout(() => r(false), 1200)),
      ]);
    } catch (e) { running = false; }
    if (!running) await new Promise((r) => setTimeout(r, 800));
  }
  if (!running) console.warn('[audio] 重建 5 次仍无健康的 AudioContext（本机音频子系统异常）');
  return { rebuilt: true };
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
