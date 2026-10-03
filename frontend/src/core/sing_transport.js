// 歌声合成的播放传输器：把**伴奏**与**渲染结果**同时播放。
//
// ## 为什么用 Web Audio 而不是两个 <audio>
//
// 两个 <audio> 各自 `play()` 会有几十毫秒的启动偏差，而且会随时间漂移 ——
// 对"听着伴奏对齐歌词"来说，偏差比不同步更难受。
//
// 这里用**共享的 AudioContext**（复用 `audio.js` 的单例，避免多上下文互相抢时钟），
// 把两条都解码成 `AudioBuffer`，再用 **同一个 `start(when, offset)`** 启动 ——
// 两条源共享同一个时钟，是**采样级同步**。
//
// ## 为什么每次 seek 都要重建 source
//
// `AudioBufferSourceNode` 是**一次性**的（start 后不能再 start）。
// 所以 pause/seek 的做法是：停掉旧 source（保留位置）→ 下次 play 时重建。
// 这是 Web Audio 的标准用法，不是取巧。

import { ensureAudio, getCtx } from '../audio.js';
import { buildFxChain } from './track_fx.js';
import { envelopeFrom } from './track_automation.js';

// 进度驱动：浏览器用 rAF（与刷新同步）；Node（测试）退回定时器。
// ★ 不硬依赖 rAF —— 同步逻辑本身与渲染无关，测试不该为了它引一个 DOM 垫片。
const raf = (fn) => {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(fn);
  const h = setTimeout(fn, 16);
  // ★ Node 下 unref：进度定时器不该拖住进程退出（否则测试跑完不结束）
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};
const caf = (h) => (typeof cancelAnimationFrame === 'function'
  ? cancelAnimationFrame(h) : clearTimeout(h));

/**
 * 淡入淡出：在 buffer 上原地加斜坡（比接 GainNode 简单，且 seek 无状态）。
 *
 * ★ 边界：淡入 + 淡出**超过整段长度**时不能各自铺满 ——
 *   否则中段会被两头各乘一次（200ms 淡入 + 200ms 淡出铺在 22ms 的短音频上，
 *   中段只剩 0.25 倍）。这里按比例收缩到恰好相接。
 */
function applyFades(buf, fadeInMs, fadeOutMs) {
  const sr = buf.sampleRate;
  const n = buf.length;
  let inN = Math.min(n, Math.max(0, Math.round((fadeInMs || 0) / 1000 * sr)));
  let outN = Math.min(n, Math.max(0, Math.round((fadeOutMs || 0) / 1000 * sr)));
  if (inN + outN > n) {
    const k = n / (inN + outN);
    inN = Math.floor(inN * k);
    outN = n - inN;
  }
  if (!inN && !outN) return buf;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < inN; i++) d[i] *= i / inN;
    for (let i = 0; i < outN; i++) d[n - 1 - i] *= i / outN;
  }
  return buf;
}

export class SingTransport {
  /**
   * @param {AudioContext} [ctx] 注入音频上下文（不传则用 `audio.js` 的单例）。
   *   ★ 做成可注入是为了能在 Node 里跑同步逻辑的测试 —— 断言"两条源拿到同一个
   *   when"不需要真的音频设备。
   */
  constructor(ctx) {
    /** @type {AudioContext|undefined} */
    this._ctx = ctx;
    /** @type {{buf: AudioBuffer, gainDb: number, muted: boolean, skipMs: number, label: string,
     *          fx?: any[], bpm?: number, volPoints?: any[], panPoints?: any[]}[]} */
    this.lanes = [];
    this._srcs = [];
    /** 每次起播新建的效果/增益节点 —— 停止时要一并断开，否则延迟的反馈环会留尾巴 */
    this._nodes = [];
    /** 本次播放的起点（ms，相对工程 0） */
    this._offsetMs = 0;
    /** ctx.currentTime 里"工程 0"对应的时刻 */
    this._originAt = 0;
    /** 播放倍率（0.25 ~ 2）：变速试听。1 = 原速。见 setRate()。 */
    this._rate = 1;
    this.playing = false;
    /** 变更通知（UI 用来刷新进度条） */
    this.onTick = null;
    this._raf = 0;
  }

  get ctx() { return this._ctx || getCtx(); }

  /** 总时长（ms）= 各轨的最大值 */
  get durationMs() {
    return this.lanes.reduce((a, l) => Math.max(a, l.buf.duration * 1000 - l.skipMs), 0);
  }

  get positionMs() {
    if (!this.ctx) return this._offsetMs;
    if (!this.playing) return this._offsetMs;
    // ★ 变速：位置按 **倍率缩放** 走 —— 1.5× 时 1 秒墙钟 = 1.5 秒工程时间
    return Math.max(0, Math.min(this.durationMs,
      (this.ctx.currentTime - this._originAt) * 1000 * this._rate));
  }

  /**
   * 播放倍率（0.25 ~ 2）：变速试听用。
   * ★ 播放中改倍率要**先停车再按当前位置重起** —— 只改 `playbackRate` 的话，
   *   `_originAt` 还是旧倍率下的时间原点，进度会瞬间跳一段。
   */
  setRate(r) {
    const v = Math.max(0.25, Math.min(2, Number(r) || 1));
    if (v === this._rate) return this._rate;
    const wasPlaying = this.playing;
    const at = this.positionMs;
    if (wasPlaying) this._kill();
    this._rate = v;
    this._offsetMs = at;
    if (wasPlaying) this.play(at);
    else this._notify();
    return v;
  }

  get rate() { return this._rate; }

  /**
   * 装载一批轨道。**重复调用会整体替换**（清空旧 lane）。
   *
   * @param {{label:string, bytes:Uint8Array|ArrayBuffer, gainDb?:number,
   *          muted?:boolean, skipMs?:number, fadeIn?:number, fadeOut?:number}[]} items
   */
  async load(items) {
    // 只在浏览器里、且还没拿到 ctx 时才去建单例（Node 下没有 window）
    if (!this._ctx && !getCtx() && typeof window !== 'undefined') ensureAudio();
    const ctx = this.ctx;
    if (!ctx) throw new Error('音频上下文不可用');
    this.stop();
    const out = [];
    for (const it of items) {
      if (!it || !it.bytes) continue;
      const raw = it.bytes instanceof Uint8Array
        ? it.bytes
        : new Uint8Array(it.bytes);
      // decodeAudioData 会**转移** ArrayBuffer，所以每次都要切一份新的
      const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      let buf;
      try {
        buf = await ctx.decodeAudioData(ab);
      } catch (e) {
        // 单个文件解不开不该拖垮整条链（比如浏览器不支持的编码）
        continue;
      }
      applyFades(buf, it.fadeIn, it.fadeOut);
      out.push({
        buf,
        label: it.label || '',
        gainDb: it.gainDb || 0,
        muted: !!it.muted,
        skipMs: it.skipMs || 0,
        /* ---- P1：本轨独享效果链 + 自动化子轨 ---- */
        fx: Array.isArray(it.fx) ? it.fx.slice() : [],
        bpm: it.bpm || 120,
        volPoints: Array.isArray(it.volPoints) ? it.volPoints.slice() : [],
        panPoints: Array.isArray(it.panPoints) ? it.panPoints.slice() : [],
      });
    }
    this.lanes = out;
    this._offsetMs = 0;
    return out.length;
  }

  clear() {
    this.stop();
    this.lanes = [];
    this._offsetMs = 0;
  }

  /** 目标增益：dB → 线性（>1 允许，但因为是多轨相加，UI 侧限幅在 1） */
  static _gain(db) {
    return Math.min(1, Math.pow(10, (db || 0) / 20));
  }

  /** 从 `fromMs` 开始播放（不传则从**当前位置**继续） */
  play(fromMs) {
    if (!this.lanes.length) return false;
    if (!this._ctx && !getCtx() && typeof window !== 'undefined') ensureAudio();
    const ctx = this.ctx;
    if (!ctx) return false;
    // ★ 先算好起播位置，再停旧的源 —— 早先误调了 `stop()`（它会把 `_offsetMs`
    //   清成 0），导致"暂停后继续"永远从头开始。
    const at = fromMs == null ? this._offsetMs : Math.max(0, fromMs);
    this._kill();                       // 只停源，不动 `_offsetMs`
    // 留一点点调度余量，避免"when 已经在过去"导致立刻起播的爆音
    const when = ctx.currentTime + 0.03;
    this._originAt = when - at / 1000;
    this._offsetMs = at;

    for (const lane of this.lanes) {
      // 该 lane 在这条时间线上的有效区间
      const startSec = lane.skipMs / 1000;
      const endSec = lane.buf.duration;
      if (endSec <= startSec) continue;
      const atSec = at / 1000;
      if (atSec >= endSec) continue;              // 已经播过头了
      const offsetSec = Math.max(startSec, atSec < startSec ? startSec : atSec);
      const durSec = endSec - offsetSec;
      if (durSec <= 0.001) continue;

      /* ---- 本轨独享的效果链（关掉的、环境不支持的都不进链）---- */
      const src = ctx.createBufferSource();
      src.buffer = lane.buf;
      let head = src;
      const chain = lane.fx && lane.fx.length ? buildFxChain(ctx, lane.fx) : null;
      if (chain && chain.input && chain.output) {
        src.connect(chain.input);
        head = chain.output;
        for (const n of chain.nodes) this._nodes.push(n);
      }

      const g = ctx.createGain();
      g.gain.value = lane.muted ? 0 : SingTransport._gain(lane.gainDb);
      // 自动化按**工程时间**走：buffer 时间 − skipMs = 工程时间
      const t0 = Math.max(0, offsetSec - lane.skipMs / 1000);
      if (!lane.muted && lane.volPoints && lane.volPoints.length) {
        try {
          g.gain.setValueCurveAtTime(
            envelopeFrom(lane.volPoints, lane.bpm, t0, t0 + durSec, 256, 'VOL'),
            when, durSec);
        } catch (_) { /* 老浏览器不支持 setValueCurveAtTime：退回上面的固定增益 */ }
      }
      head.connect(g);
      this._nodes.push(g);

      let tail = g;
      if (ctx.createStereoPanner && lane.panPoints && lane.panPoints.length) {
        const p = ctx.createStereoPanner();
        try {
          p.pan.setValueCurveAtTime(
            envelopeFrom(lane.panPoints, lane.bpm, t0, t0 + durSec, 256, 'PAN'),
            when, durSec);
        } catch (_) { /* 同上，退回 0（居中） */ }
        g.connect(p);
        tail = p;
        this._nodes.push(p);
      }
      tail.connect(ctx.destination);

      // 变速：buffer 播放速率 = rate，此时源时长要除以 rate，否则变速后会提前/延后收尾
      try { src.playbackRate.value = this._rate; } catch (_) { /* 老实现只读，忽略 */ }
      src.start(when, offsetSec, durSec / this._rate);
      this._srcs.push(src);
    }
    this.playing = this._srcs.length > 0;
    if (this.playing) this._pump();
    // 重新装载后保持当前倍率（load 前可能已经设过 1.5×，不该被重置回 1×）
    if (this._rate !== 1 && this.playing) this.setRate(this._rate);
    return this.playing;
  }

  pause() {
    if (!this.playing) return;
    this._offsetMs = this.positionMs;              // 先记位置再停
    this._kill();
  }

  stop() {
    this._kill();
    this._offsetMs = 0;
  }

  seek(ms) {
    const wasPlaying = this.playing;
    const at = Math.max(0, Math.min(this.durationMs, ms));
    this._kill();
    this._offsetMs = at;
    if (wasPlaying) this.play(at);
    else this._notify();
  }

  _kill() {
    for (const s of this._srcs) {
      try { s.onended = null; s.stop(); } catch (_) { /* 已停止 */ }
      try { s.disconnect(); } catch (_) { /* 未连接 */ }
    }
    for (const n of this._nodes) {
      try { n.disconnect(); } catch (_) { /* 未连接 */ }
    }
    this._srcs = [];
    this._nodes = [];
    this.playing = false;
    if (this._raf) { caf(this._raf); this._raf = 0; }
  }

  _pump() {
    const step = () => {
      if (!this.playing) return;
      if (this.positionMs >= this.durationMs - 1) {   // 播完
        this._kill();
        this._offsetMs = this.durationMs;
        this._notify();
        return;
      }
      this._notify();
      this._raf = raf(step);
    };
    this._raf = raf(step);
  }

  _notify() { if (this.onTick) this.onTick(this.positionMs, this.playing); }
}

let _inst = null;

/** 进程级单例（与其它视图共用同一个 AudioContext） */
export function getTransport() {
  if (!_inst) _inst = new SingTransport();
  return _inst;
}
