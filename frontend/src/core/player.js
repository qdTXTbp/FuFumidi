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
    for (const tr of this.song.tracks) for (const n of tr.notes) arr.push({ start: n.start, end: n.end, midi: n.midi, vel: n.vel, trk: tr.index, prog: tr.program, isDrum: tr.isDrum, ch: tr.ch != null ? tr.ch : 0 });
    arr.sort((a, b) => a.start - b.start || a.midi - b.midi);
    this.events = arr;
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
