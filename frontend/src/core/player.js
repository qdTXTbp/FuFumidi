// 播放器（lookahead 调度 + 变速 / 循环 / 跳转）——从 legacy FuFumidi.html 抽取
import { clamp } from './util.js';

/* 节拍器咔哒声 */
function metroClick(ctx, time, accent, out) {
  time = Math.max(0, time);
  const o = ctx.createOscillator();
  o.type = 'square';
  o.frequency.value = accent ? 1760 : 1175;
  const g = ctx.createGain();
  g.gain.setValueAtTime(accent ? 0.5 : 0.3, time);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
  o.connect(g); g.connect(out);
  o.start(time); o.stop(time + 0.07);
}

export class Player {
  constructor(synth) {
    this.syn = synth; this.ctx = synth.ctx;
    this.song = null; this.events = [];
    // 通道事件（CC / 弯音）与音符分开存放：音符靠 lookahead 建节点，通道事件只是状态变更
    this.ctlEvents = []; this.ccursor = 0;
    this._ctlByCh = new Map(); this._bendByCh = new Map();
    this.playing = false; this.pausedTick = 0;
    this.scale = 1; this.loop = false; this.loopStart = 0; this.loopEnd = 0;
    this.metro = false; this.metroBeat = 0;
    this.onEnd = null; this._timer = null;
    // 硬件 MIDI 输出等外部旁听回调：onNote(n, noteTime, noteEndTime) / onStop()
    this.onNote = null; this.onStop = null;
    // 预排窗口（秒）：基础 1.0s。主线程被重操作（切页 / 乐谱重绘）阻塞时，阻塞期间无法
    // 调度新音符——窗口越大，可容忍的阻塞越长（音符节点由 Web Audio 渲染线程按绝对时间
    // 发声；SF2 worklet 路径则把事件写入音频线程音序器）。bumpAhead 在可预见的重操作前
    // 临时扩到 2.5s。
    this.AHEAD_BASE = 1.0;
    this.aheadSec = this.AHEAD_BASE;
    this._aheadTimer = null;
  }
  load(song) { this.song = song; this.pausedTick = 0; this.loop = false; this.loopStart = 0; this.loopEnd = 0; this.prepare(); }
  prepare() {
    const arr = [];
    const st = this.song.chanStateAt;
    for (const tr of this.song.tracks) for (const n of tr.notes) {
      // 通道取「音符自己的通道」，而不是轨序号：轨号与 MIDI 通道并不一一对应
      // （24 轨的文件里轨 16 才是 ch9 鼓、轨 20~22 各自是 ch15），用轨号会让
      // 轨 15~22 全挤到同一个通道，甚至被鼓轨把整条通道改成鼓组。
      // 音色/音色库同样要取「该通道在该时刻」的状态：文件里会中途换音色，
      // program/bank 是通道级状态，也可能写在别的轨里。
      const ch = n.ch != null ? n.ch : (tr.ch != null ? tr.ch : 0);
      const s = st ? st(ch, n.start) : null;
      arr.push({
        start: n.start, end: n.end, midi: n.midi, vel: n.vel,
        trk: tr.index,                                   // 仅用于轨道音量/声像路由
        ch,
        prog: s && s.program != null ? s.program : tr.program,
        bank: s ? s.bank : 0,
        isDrum: ch === 9,
      });
    }
    arr.sort((a, b) => a.start - b.start || a.midi - b.midi);
    this.events = arr;

    // 通道事件（CC / 弯音）：音量(CC7)、声像(CC10)、表情(CC11)、延音(CC64)、弯音等
    // 「演奏信息」在 MIDI 里是通道级事件，手机端 BASSMIDI 直接播放它们，电脑端此前完全忽略。
    // 这里与音符放在同一条时间轴上调度；库号 CC0/CC32 除外（音色库选择由 synth 做缺库回退）。
    const ctl = [];
    const ctlByCh = new Map();
    const bendByCh = new Map();
    for (const tr of this.song.tracks) {
      for (const c of (tr.ccs || [])) {
        if (!c || c.cc == null || c.ch == null || c.cc === 0 || c.cc === 32) continue;
        ctl.push({ start: c.tick || 0, kind: 'cc', ch: c.ch, cc: c.cc, val: c.cv });
        const a = ctlByCh.get(c.ch); if (a) a.push(c); else ctlByCh.set(c.ch, [c]);
      }
      for (const e of (tr.events || [])) {
        if (e.type !== 'bend' || e.ch == null) continue;
        ctl.push({ start: e.tick || 0, kind: 'bend', ch: e.ch, val: e.val });
        const a = bendByCh.get(e.ch); if (a) a.push(e); else bendByCh.set(e.ch, [e]);
      }
    }
    ctl.sort((a, b) => a.start - b.start);
    for (const a of ctlByCh.values()) a.sort((x, y) => x.tick - y.tick);
    for (const a of bendByCh.values()) a.sort((x, y) => x.tick - y.tick);
    this.ctlEvents = ctl;
    this._ctlByCh = ctlByCh;
    this._bendByCh = bendByCh;
    this.ccursor = 0;
  }
  // 通道事件里第一个不早于 tick 的下标
  _firstCtlIndex(tick) {
    const ev = this.ctlEvents || [];
    let lo = 0, hi = ev.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ev[m].start <= tick) lo = m + 1; else hi = m; }
    return lo;
  }
  // 播放/拖动到 tick 处重新开始时，补发该时刻之前已经生效的通道状态。
  // 不补的话，跳转后引擎里的音量/声像/表情/延音还是旧值（或默认值），听起来就和手机端不同。
  _applyCtlBaseline(tick) {
    if (!this.syn || !this.syn.midiEvent) return;
    const t = this.ctx.currentTime;
    for (const [ch, arr] of this._ctlByCh) {
      const last = new Map();
      for (const c of arr) { if (c.tick > tick) break; last.set(c.cc, c.cv); }
      for (const [cc, val] of last) this.syn.midiEvent(t, { kind: 'cc', ch, cc, val });
    }
    for (const [ch, arr] of this._bendByCh) {
      let v = null;
      for (const e of arr) { if (e.tick > tick) break; v = e.val; }
      if (v != null) this.syn.midiEvent(t, { kind: 'bend', ch, val: v });
    }
  }
  noteTime(n) { return this.startSec + (this.song.baseSec(n.start) - this.song.baseSec(this.startTick)) * this.scale; }
  noteEndTime(n) { return this.startSec + (this.song.baseSec(n.end) - this.song.baseSec(this.startTick)) * this.scale; }
  play() {
    if (!this.song || this.playing) return;
    if (this.pausedTick >= this.song.totalTicks) this.pausedTick = 0;
    this.playing = true;
    this.startTick = this.pausedTick;
    this.startSec = this.ctx.currentTime + 0.05;
    this.cursor = this._firstIndex(this.startTick);
    this._cbCursor = this.cursor;
    this.ccursor = this._firstCtlIndex(this.startTick);
    this._applyCtlBaseline(this.startTick);
    this.metroBeat = Math.max(0, Math.ceil(this.startTick / this.song.tpb));
    this.syn.applyRouting();
    clearInterval(this._timer);
    this._timer = setInterval(() => this._sched(), 25);
  }
  _firstIndex(tick) {
    let lo = 0, hi = this.events.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.events[m].end < tick) lo = m + 1; else hi = m; }
    return lo;
  }
  pause() {
    if (!this.playing) return;
    const tick = this.currentTick();
    this.playing = false;
    this.pausedTick = tick;
    clearInterval(this._timer); this._timer = null;
    clearTimeout(this._aheadTimer); this._aheadTimer = null; this.aheadSec = this.AHEAD_BASE;
    this.syn.allStop();
    if (this.onStop) this.onStop();
  }
  // 临时扩大预排窗口并立即预排一次：用于切页/重渲染等即将阻塞主线程的场景，
  // 预排的音符由 Web Audio 渲染线程按绝对时间发声，主线程阻塞不断流。
  bumpAhead(sec = 2.5, ms = 6000) {
    if (!this.playing) return;
    this.aheadSec = sec;
    // SF2 ScriptProcessor 回退路径的音符经主线程 setTimeout 触发，同步放宽迟到容忍度
    // 避免成片掉音（worklet 音序器路径不受影响）；内联合成器同步放宽 live 修剪上限，
    // 避免预排的待发声振荡器被提前杀掉。
    if (this.syn) {
      this.syn._sf2LateTol = Math.min(0.3, sec * 0.15);
      this.syn._liveLimit = 1500;
    }
    clearTimeout(this._aheadTimer);
    this._aheadTimer = setTimeout(() => {
      this.aheadSec = this.AHEAD_BASE;
      if (this.syn) { this.syn._sf2LateTol = 0.04; this.syn._liveLimit = 1024; }
    }, ms);
    this._sched();
  }
  stop() { this.pause(); this.pausedTick = 0; }
  seekTick(tick) {
    if (!this.song) return;
    this.pausedTick = clamp(tick, 0, this.song.totalTicks);
    if (this.playing) this._restartAt(this.pausedTick);
  }
  seekSec(sec) {
    if (!this.song) return;
    this.seekTick(this.song.secToTick(sec / this.scale));
  }
  _restartAt(tick) {
    this.syn.allStop();
    this.startTick = tick;
    this.startSec = this.ctx.currentTime + 0.05;
    this.cursor = this._firstIndex(tick);
    this._cbCursor = this.cursor;
    this.ccursor = this._firstCtlIndex(tick);
    this._applyCtlBaseline(tick);
    if (this.song) this.metroBeat = Math.max(0, Math.ceil(tick / this.song.tpb));
    this._sched();
  }
  setScale(s) {
    this.scale = s;
    if (this.playing) { const t = this.currentTick(); this.pausedTick = t; this._restartAt(t); }
  }
  setLoop(on, a, b) {
    this.loopStart = a != null ? a : 0;
    this.loopEnd = b != null ? b : this.song ? this.song.totalTicks : 0;
    this.loop = !!(on && this.loopEnd > this.loopStart);
  }
  setMetronome(on) {
    this.metro = !!on;
    if (this.song) this.metroBeat = Math.max(0, Math.ceil((this.playing ? this.currentTick() : this.pausedTick) / this.song.tpb));
  }
  currentTick() {
    if (!this.playing) return this.pausedTick;
    const rel = (this.ctx.currentTime - this.startSec) / this.scale;
    return this.song.secToTick(this.song.baseSec(this.startTick) + rel);
  }
  currentSec() { return this.song.baseSec(this.currentTick()) * this.scale; }
  progress() { return this.song.totalSec ? this.currentSec() / this.song.totalSec : 0; }
  _sched() {
    if (!this.playing) return;
    // SF2 音序器路径：事件写入音频线程音序器后按绝对 tick 自行分发，预排窗口额外扩到
    // 30s——主线程长任务（切页 / 乐谱重绘 / 大文件渲染）阻塞远超 aheadSec 也不会断粮。
    // 其余路径（内置合成器 / ScriptProcessor 回退）维持 aheadSec（预排即创建节点，窗口大内存涨）。
    const extra = this.syn && this.syn._sf2SeqMode ? 30 : 0;
    const ahead = this.ctx.currentTime + this.aheadSec + extra;
    const ev = this.events;
    while (this.cursor < ev.length) {
      const n = ev[this.cursor];
      const t = this.noteTime(n);
      if (t > ahead) break;
      const e = this.noteEndTime(n);
      if (e < this.ctx.currentTime - 0.03) { this.cursor++; continue; }
      this.syn.noteOn(t, n, e);
      this.cursor++;
    }
    // 通道事件（CC / 弯音）：与音符同一条时间轴。它们是状态变更而非发声事件，
    // 迟到也要补发（跳转/主线程卡顿后直接落到最新状态），所以不做丢弃判断。
    const cev = this.ctlEvents;
    while (this.ccursor < cev.length) {
      const c = cev[this.ccursor];
      const tc = this.noteTime(c);
      if (tc > ahead) break;
      this.syn.midiEvent(tc, c);
      this.ccursor++;
    }
    // 硬件 MIDI 旁听：与可听时刻同步（单独游标，仅推进到可听窗口内的事件才回调），
    // 否则大预排窗口会让外接音源提前 30s 发声。
    if (this.onNote) {
      if (this._cbCursor == null || this._cbCursor > this.cursor) this._cbCursor = this.cursor;
      while (this._cbCursor < this.cursor) {
        const n = this.events[this._cbCursor];
        const t = this.noteTime(n);
        if (t > this.ctx.currentTime + 0.35) break;
        const e = this.noteEndTime(n);
        if (e >= this.ctx.currentTime - 0.03) this.onNote(n, t, e);
        this._cbCursor++;
      }
    } else {
      this._cbCursor = this.cursor;
    }
    if (this.metro && this.song) {
      const tpb = this.song.tpb;
      while (true) {
        const tick = this.metroBeat * tpb;
        const t = this.startSec + (this.song.baseSec(tick) - this.song.baseSec(this.startTick)) * this.scale;
        if (t > ahead) break;
        if (t >= this.ctx.currentTime - 0.03) {
          const sig = this.song.sigMap[0] || { num: 4 };
          metroClick(this.ctx, t, this.metroBeat % sig.num === 0, this.syn.master);
        }
        this.metroBeat++;
      }
    }
    if (this.loop) {
      if (this.currentTick() >= this.loopEnd) this._restartAt(this.loopStart);
    } else if (this.cursor >= ev.length && this.playing) {
      const lastEnd = ev.length ? this.noteEndTime(ev[ev.length - 1]) : 0;
      if (this.ctx.currentTime >= lastEnd + 0.12) {
        this.pause(); this.pausedTick = 0; this.seekTick(0);
        if (this.onEnd) this.onEnd();
      }
    }
  }
}
