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
    this.syn.allStop();
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
    const ahead = this.ctx.currentTime + 0.18;
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
