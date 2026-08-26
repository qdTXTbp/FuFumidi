// Web Audio 合成引擎 + 播放器调度（从 legacy FuFumidi.html 抽取，保持行为一致）
import { clamp, midiFreq } from './util.js';

/* GM 音色库映射（program → 内置合成预设） */
const PRESET_FALLBACK = [
  [7, 'piano'], [15, 'musicbox'], [23, 'organ'], [31, 'guitar'], [39, 'bass'],
  [47, 'strings'], [55, 'pad'], [63, 'brass'], [79, 'flute'], [103, 'lead'],
];
export function presetForProgram(p) {
  for (const [max, name] of PRESET_FALLBACK) if (p <= max) return name;
  return 'piano';
}
export function presetFromMode(mode, p, isDrum) {
  if (isDrum) return 'drum';
  if (mode === 'auto') return presetForProgram(p);
  return mode;
}

let _noiseBuf = null;
function noiseBuffer(ctx) {
  if (_noiseBuf && _noiseBuf.ctx === ctx) return _noiseBuf.buf;
  const len = Math.floor(ctx.sampleRate * 1.2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  _noiseBuf = { ctx, buf };
  return buf;
}

/* 包络：attack → decay 到 sustain → 在 end 时刻进入 release */
function voiceEnv(ctx, time, out, o) {
  const { a = 0.01, d = 0.2, s = 0.5, r = 0.12, peak = 0.5, end = null } = o;
  const g = ctx.createGain();
  // Web Audio 的 AudioParam 时间必须非负（高速跳转/快速变速时可能算出微小的负值）
  time = Math.max(0, time);
  const aT = time + a, dT = aT + d;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(peak, aT);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * s), dT);
  if (end != null) {
    const et = Math.max(end, dT + 0.001);
    g.gain.setValueAtTime(Math.max(peak * s, 0.0001), et);
    g.gain.exponentialRampToValueAtTime(0.0001, et + r);
  }
  g.connect(out);
  return g;
}

/* 颤音 */
function vibrato(ctx, time, rate, depth, oscFreq, delay) {
  const lfo = ctx.createOscillator(); lfo.frequency.value = rate;
  const lg = ctx.createGain();
  lg.gain.setValueAtTime(0, time);
  lg.gain.linearRampToValueAtTime(depth, time + (delay || 0.3));
  lfo.connect(lg); lg.connect(oscFreq); lfo.start(time);
  return lfo;
}

/* 生成一个音符的声音 */
export function playVoice(ctx, time, midi, vel, preset, out, endTime, live) {
  const liveArr = live || [];
  // 跳转/变速到曲中时，可能调度到「起始时刻已过去」的延音音符：
  // 统一把触发时刻钳制到当前，避免 AudioParam/Oscillator 负时间报错（尾部仍可听到）
  time = Math.max(ctx.currentTime, time);
  const v = clamp(vel / 127, 0, 1);
  const peak = 0.11 + v * v * 0.92;
  const freq = midiFreq(midi);
  const tStop = Math.max(endTime, time + 0.06) + (preset === 'drum' ? 0.32 : 0.2);
  const reg = (o) => { try { o.stop(tStop); } catch (e) {} liveArr.push({ o, tStop }); return o; };
  const mkOsc = (type, f) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(time); reg(o); return o; };
  const mkFilter = (type, f, q, to) => { const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q || 0.7; fl.connect(to); return fl; };

  /* ---- 鼓组 ---- */
  if (preset === 'drum') {
    const noise = noiseBuffer(ctx);
    const src = () => { const s = ctx.createBufferSource(); s.buffer = noise; s.start(time); reg(s); return s; };
    const to = out;
    if (midi === 35 || midi === 36) {
      const g = voiceEnv(ctx, time, to, { a: .001, d: .28, s: .02, r: .09, peak: peak * 1.1, end: endTime });
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(160, time); o.frequency.exponentialRampToValueAtTime(42, time + .26);
      o.connect(g); o.start(time); reg(o);
    } else if (midi === 38 || midi === 40) {
      const g = voiceEnv(ctx, time, to, { a: .001, d: .18, s: .02, r: .06, peak, end: endTime });
      const n = src(); n.connect(mkFilter('highpass', 1800, 0.7, g));
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 200;
      const og = ctx.createGain(); og.gain.value = .35; o.connect(og); og.connect(g); o.start(time); reg(o);
    } else if (midi === 42 || midi === 44 || midi === 46) {
      const g = voiceEnv(ctx, time, to, { a: .001, d: midi === 46 ? .2 : .05, s: .01, r: .04, peak: peak * .55, end: endTime });
      const n = src(); n.connect(mkFilter('highpass', 7200, 1, g));
    } else if (midi === 49 || midi === 57) {
      const g = voiceEnv(ctx, time, to, { a: .002, d: .75, s: .02, r: .22, peak: peak * .8, end: endTime });
      const n = src(); n.connect(mkFilter('highpass', 3800, 0.8, g));
    } else if (midi === 51 || midi === 53 || midi === 59) {
      const g = voiceEnv(ctx, time, to, { a: .002, d: .42, s: .04, r: .16, peak: peak * .5, end: endTime });
      const n = src(); n.connect(mkFilter('highpass', 5400, 1, g));
      const o = mkOsc('sine', 8000); const og = ctx.createGain(); og.gain.value = .15; o.connect(og); og.connect(g);
    } else if ((midi >= 41 && midi <= 45 && midi !== 42) || (midi >= 47 && midi <= 50)) {
      const g = voiceEnv(ctx, time, to, { a: .002, d: .22, s: .05, r: .08, peak, end: endTime });
      const o = ctx.createOscillator(); o.type = 'sine';
      const f = midiFreq(midi); o.frequency.setValueAtTime(f, time); o.frequency.exponentialRampToValueAtTime(f * .6, time + .2);
      o.connect(g); o.start(time); reg(o);
    } else {
      const g = voiceEnv(ctx, time, to, { a: .002, d: .15, s: .05, r: .08, peak: peak * .8, end: endTime });
      const o = mkOsc('square', freq); o.connect(g);
    }
    return;
  }

  /* ---- 旋律类乐器 ---- */
  if (preset === 'piano') {
    // 改进的三角钢琴：非谐波泛音 + 低频衰减 + 低通柔化 + 自然延音
    const g = voiceEnv(ctx, time, out, { a: .0018, d: clamp(.4 + 70 / freq, .12, 1.6), s: .025, r: .38, peak, end: endTime });
    const lp = mkFilter('lowpass', Math.min(6800, 900 + freq * 3.2), 0.5, g);
    for (const [m, amp] of [[1, 1], [1.98, .52], [3.01, .3], [4.02, .18], [5.0, .12], [6.02, .08], [8.01, .05]]) {
      const o = mkOsc('sine', freq * m);
      const og = ctx.createGain(); og.gain.value = amp;
      o.connect(og); og.connect(lp);
    }
  } else if (preset === 'ep') {
    const g = voiceEnv(ctx, time, out, { a: .003, d: .85, s: .03, r: .2, peak, end: endTime });
    for (const [m, amp] of [[1, 1], [2.004, .35], [4.9, .16]]) { const o = mkOsc('sine', freq * m); const og = ctx.createGain(); og.gain.value = amp; o.connect(og); og.connect(g); }
  } else if (preset === 'organ') {
    const g = voiceEnv(ctx, time, out, { a: .02, d: .03, s: .85, r: .07, peak, end: endTime });
    for (const [m, amp] of [[1, .5], [2, .26], [3, .14], [4, .07]]) { const o = mkOsc('square', freq * m); const og = ctx.createGain(); og.gain.value = amp; o.connect(og); og.connect(g); }
  } else if (preset === 'guitar') {
    const g = voiceEnv(ctx, time, out, { a: .002, d: .26, s: .05, r: .1, peak, end: endTime });
    const lp = mkFilter('lowpass', 3400, 0.6, g);
    for (const [m, amp] of [[1, 1], [2, .4], [3, .18], [4, .08]]) { const o = mkOsc('triangle', freq * m); const og = ctx.createGain(); og.gain.value = amp; o.connect(og); og.connect(lp); }
  } else if (preset === 'bass') {
    const g = voiceEnv(ctx, time, out, { a: .008, d: .3, s: .45, r: .1, peak, end: endTime });
    const lp = mkFilter('lowpass', 950, 0.8, g);
    const o1 = mkOsc('sawtooth', freq); o1.connect(lp);
    const o2 = mkOsc('sine', freq / 2); const og = ctx.createGain(); og.gain.value = .5; o2.connect(og); og.connect(lp);
  } else if (preset === 'strings') {
    const g = voiceEnv(ctx, time, out, { a: .09, d: .3, s: .75, r: .3, peak, end: endTime });
    const lp = mkFilter('lowpass', Math.min(2800, 700 + freq * .5), 0.6, g);
    for (const dt of [-.006, .006]) { const o = mkOsc('sawtooth', freq * (1 + dt)); o.connect(lp); }
  } else if (preset === 'brass') {
    const g = voiceEnv(ctx, time, out, { a: .06, d: .25, s: .65, r: .22, peak, end: endTime });
    const lp = mkFilter('lowpass', Math.min(2600, 800 + freq * .7), 0.7, g);
    const o1 = mkOsc('sawtooth', freq); o1.connect(lp);
    const o2 = mkOsc('sawtooth', freq * 1.004); const og = ctx.createGain(); og.gain.value = .5; o2.connect(og); og.connect(lp);
    vibrato(ctx, time, 5.5, 4, o1.frequency, .4);
  } else if (preset === 'flute') {
    const g = voiceEnv(ctx, time, out, { a: .06, d: .15, s: .7, r: .16, peak, end: endTime });
    const lp = mkFilter('lowpass', 2600, 0.6, g);
    const o = mkOsc('sine', freq); o.connect(lp);
    const o2 = mkOsc('triangle', freq * 2); const og = ctx.createGain(); og.gain.value = .1; o2.connect(og); og.connect(lp);
    vibrato(ctx, time, 5, 2.5, o.frequency, .5);
  } else if (preset === 'lead') {
    const g = voiceEnv(ctx, time, out, { a: .01, d: .05, s: .72, r: .12, peak, end: endTime });
    const o1 = mkOsc('square', freq); o1.connect(g);
    const o2 = mkOsc('sawtooth', freq * 1.002); const og = ctx.createGain(); og.gain.value = .5; o2.connect(og); og.connect(g);
  } else if (preset === 'pad') {
    const g = voiceEnv(ctx, time, out, { a: .35, d: .4, s: .82, r: .5, peak: peak * .7, end: endTime });
    const lp = mkFilter('lowpass', 1100, 0.5, g);
    for (const dt of [-.012, .012]) { const o = mkOsc('sawtooth', freq * (1 + dt)); o.connect(lp); }
  } else if (preset === 'violin') {
    const g = voiceEnv(ctx, time, out, { a: .12, d: .35, s: .78, r: .32, peak, end: endTime });
    const lp = mkFilter('lowpass', Math.min(3200, 900 + freq * .55), 0.65, g);
    for (const dt of [-.008, .008]) { const o = mkOsc('sawtooth', freq * (1 + dt)); o.connect(lp); }
    vibrato(ctx, time, 5.2, 3, lp.frequency, .4);
  } else if (preset === 'cello') {
    const g = voiceEnv(ctx, time, out, { a: .1, d: .4, s: .8, r: .35, peak: peak * .85, end: endTime });
    const lp = mkFilter('lowpass', Math.min(1800, 500 + freq * .45), 0.7, g);
    const o = mkOsc('sawtooth', freq); o.connect(lp);
    vibrato(ctx, time, 4.6, 2.5, o.frequency, .5);
  } else if (preset === 'harp') {
    const g = voiceEnv(ctx, time, out, { a: .002, d: clamp(.4 + 200 / freq, .15, 1.4), s: .015, r: .3, peak: peak * .7, end: endTime });
    for (const [m, amp] of [[1, 1], [2, .5], [3, .28], [4, .14]]) { const o = mkOsc('triangle', freq * m); const og = ctx.createGain(); og.gain.value = amp; o.connect(og); og.connect(g); }
  } else if (preset === 'marimba') {
    const g = voiceEnv(ctx, time, out, { a: .0015, d: clamp(.5 + 120 / freq, .2, 1.2), s: .01, r: .18, peak: peak * .8, end: endTime });
    const o1 = mkOsc('sine', freq); o1.connect(g);
    const o2 = mkOsc('sine', freq * 4); const og = ctx.createGain(); og.gain.value = .22; o2.connect(og); og.connect(g);
  } else if (preset === 'musicbox') {
    const g = voiceEnv(ctx, time, out, { a: .001, d: clamp(.6 + 300 / freq, .3, 2.2), s: .01, r: .4, peak: peak * .6, end: endTime });
    const hp = mkFilter('highpass', 900, .6, g);
    const o = mkOsc('sine', freq); o.connect(hp);
    const o2 = mkOsc('sine', freq * 3); const og = ctx.createGain(); og.gain.value = .3; o2.connect(og); og.connect(hp);
  } else if (preset === 'vibraphone') {
    const g = voiceEnv(ctx, time, out, { a: .003, d: .8, s: .05, r: .5, peak: peak * .65, end: endTime });
    const o = mkOsc('sine', freq); o.connect(g);
    const o2 = mkOsc('sine', freq * 4.01); const og = ctx.createGain(); og.gain.value = .2; o2.connect(og); og.connect(g);
    const trem = ctx.createOscillator(); trem.frequency.value = 5.5; const tg = ctx.createGain(); tg.gain.value = .25;
    trem.connect(tg); tg.connect(g.gain); trem.start(time); reg(trem);
  } else if (preset === 'choir') {
    const g = voiceEnv(ctx, time, out, { a: .28, d: .3, s: .8, r: .4, peak: peak * .62, end: endTime });
    const lp = mkFilter('lowpass', Math.min(2400, 700 + freq * .5), 0.5, g);
    for (const dt of [-.01, .01]) { const o = mkOsc('sawtooth', freq * (1 + dt)); o.connect(lp); }
    vibrato(ctx, time, 3.8, 2, lp.frequency, .6);
  } else if (preset === 'trumpet') {
    const g = voiceEnv(ctx, time, out, { a: .045, d: .28, s: .68, r: .2, peak, end: endTime });
    const lp = mkFilter('lowpass', Math.min(3600, 1100 + freq * .7), 0.7, g);
    const o = mkOsc('sawtooth', freq); o.connect(lp);
    const o2 = mkOsc('square', freq * 2); const og = ctx.createGain(); og.gain.value = .18; o2.connect(og); og.connect(lp);
    vibrato(ctx, time, 5.6, 3.5, o.frequency, .35);
  } else if (preset === 'sax') {
    const g = voiceEnv(ctx, time, out, { a: .07, d: .3, s: .72, r: .22, peak: peak * .8, end: endTime });
    const lp = mkFilter('lowpass', Math.min(2200, 800 + freq * .55), 0.65, g);
    const o = mkOsc('sawtooth', freq); o.connect(lp);
    const o2 = mkOsc('sine', freq); const og = ctx.createGain(); og.gain.value = .45; o2.connect(og); og.connect(lp);
    vibrato(ctx, time, 4.4, 3, o.frequency, .45);
  } else if (preset === 'clarinet') {
    const g = voiceEnv(ctx, time, out, { a: .05, d: .2, s: .75, r: .18, peak: peak * .75, end: endTime });
    const lp = mkFilter('lowpass', 2100, 0.7, g);
    for (const [m, amp] of [[1, 1], [3, .3], [5, .12]]) { const o = mkOsc('square', freq * m); const og = ctx.createGain(); og.gain.value = amp; o.connect(og); og.connect(lp); }
    vibrato(ctx, time, 4.8, 2.2, lp.frequency, .5);
  } else if (preset === 'oboe') {
    const g = voiceEnv(ctx, time, out, { a: .04, d: .22, s: .7, r: .16, peak: peak * .7, end: endTime });
    const lp = mkFilter('lowpass', 2600, 0.7, g);
    const o = mkOsc('square', freq); o.connect(lp);
    const o2 = mkOsc('sawtooth', freq * 1.006); const og = ctx.createGain(); og.gain.value = .4; o2.connect(og); og.connect(lp);
    vibrato(ctx, time, 5.4, 3, o.frequency, .4);
  } else if (preset === 'nylon') {
    const g = voiceEnv(ctx, time, out, { a: .002, d: .3, s: .04, r: .22, peak: peak * .85, end: endTime });
    const lp = mkFilter('lowpass', 3000, 0.6, g);
    for (const [m, amp] of [[1, 1], [2, .42], [3, .2], [4, .1]]) { const o = mkOsc('triangle', freq * m); const og = ctx.createGain(); og.gain.value = amp; o.connect(og); og.connect(lp); }
  } else if (preset === 'steel') {
    const g = voiceEnv(ctx, time, out, { a: .0015, d: .5, s: .04, r: .28, peak: peak * .8, end: endTime });
    const hp = mkFilter('highpass', 600, .7, g);
    for (const [m, amp] of [[1, 1], [2, .45], [2.7, .2]]) { const o = mkOsc('triangle', freq * m); const og = ctx.createGain(); og.gain.value = amp; o.connect(og); og.connect(hp); }
  } else if (preset === 'synthbass') {
    const g = voiceEnv(ctx, time, out, { a: .004, d: .25, s: .62, r: .12, peak: peak * .95, end: endTime });
    const lp = mkFilter('lowpass', Math.min(1400, 180 + freq * .9), 0.85, g);
    const o = mkOsc('sawtooth', freq); o.connect(lp);
    const o2 = mkOsc('square', freq / 2); const og = ctx.createGain(); og.gain.value = .5; o2.connect(og); og.connect(lp);
  } else if (preset === 'sitar') {
    const g = voiceEnv(ctx, time, out, { a: .002, d: .5, s: .18, r: .3, peak: peak * .7, end: endTime });
    const hp = mkFilter('highpass', 500, .5, g);
    const o = mkOsc('sawtooth', freq); o.connect(hp);
    const o2 = mkOsc('triangle', freq * 2); const og = ctx.createGain(); og.gain.value = .4; o2.connect(og); og.connect(hp);
  } else if (preset === 'koto') {
    const g = voiceEnv(ctx, time, out, { a: .001, d: .45, s: .02, r: .35, peak: peak * .7, end: endTime });
    for (const [m, amp] of [[1, 1], [2, .4], [3, .18]]) { const o = mkOsc('triangle', freq * m); const og = ctx.createGain(); og.gain.value = amp; o.connect(og); og.connect(g); }
  } else if (preset === 'bell') {
    const g = voiceEnv(ctx, time, out, { a: .001, d: clamp(.7 + 400 / freq, .3, 2.5), s: .01, r: .6, peak: peak * .55, end: endTime });
    const o = mkOsc('sine', freq); o.connect(g);
    for (const [m, amp] of [[2.76, .3], [5.4, .12]]) { const o2 = mkOsc('sine', freq * m); const og = ctx.createGain(); og.gain.value = amp; o2.connect(og); og.connect(g); }
  } else if (preset === 'accordion') {
    const g = voiceEnv(ctx, time, out, { a: .05, d: .3, s: .75, r: .2, peak: peak * .75, end: endTime });
    const lp = mkFilter('lowpass', 2200, 0.6, g);
    for (const dt of [-.009, .009]) { const o = mkOsc('sawtooth', freq * (1 + dt)); o.connect(lp); }
    const trem = ctx.createOscillator(); trem.frequency.value = 7.2; const tg = ctx.createGain(); tg.gain.value = .28;
    trem.connect(tg); tg.connect(g.gain); trem.start(time); reg(trem);
  } else if (preset === 'banjo') {
    const g = voiceEnv(ctx, time, out, { a: .001, d: .24, s: .02, r: .12, peak: peak * .8, end: endTime });
    const hp = mkFilter('highpass', 800, .6, g);
    for (const [m, amp] of [[1, 1], [2, .4], [3, .2], [4, .1]]) { const o = mkOsc('triangle', freq * m); const og = ctx.createGain(); og.gain.value = amp; o.connect(og); og.connect(hp); }
  } else {
    const g = voiceEnv(ctx, time, out, { a: .004, d: .3, s: .04, r: .16, peak, end: endTime });
    for (const [m, amp] of [[1, 1], [2, .5], [3, .24]]) { const o = mkOsc('sine', freq * m); const og = ctx.createGain(); og.gain.value = amp; o.connect(og); og.connect(g); }
  }
}

/* 合成器：多轨混音 + 路由 */
export class Synth {
  constructor(ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain(); this.master.gain.value = 0.85;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048; this.analyser.smoothingTimeConstant = 0.82;
    this.kill = ctx.createGain(); this.kill.gain.value = 1;
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -18;
    this.compressor.knee.value = 20;
    this.compressor.ratio.value = 6;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.25;
    this.master.connect(this.analyser); this.analyser.connect(this.kill); this.kill.connect(this.compressor); this.compressor.connect(ctx.destination);
    this.trackGains = []; this.vol = []; this.mute = []; this.solo = [];
    this.panners = []; this.pan = [];
    this.live = []; this.activeNotes = [];
    this.sf2 = null;
    this.sf2Ready = false;
    this.sf2Loading = null;
  }
  async loadSf2() {
    if (this.sf2Ready) return true;
    if (this.sf2Loading) return this.sf2Loading;
    this.sf2Loading = (async () => {
      try {
        const JSSynth = (window || {}).JSSynth;
        if (!JSSynth) return false;
        await JSSynth.waitForReady();
        const syn = new JSSynth.Synthesizer();
        syn.init(this.ctx.sampleRate);
        const node = syn.createAudioNode(this.ctx, 4096);
        node.connect(this.master);
        let res = null;
        for (const p of ['../vendor/soundfonts/GeneralUser.sf2', './vendor/soundfonts/GeneralUser.sf2']) {
          try { res = await fetch(p); if (res.ok) break; } catch (e) { res = null; }
        }
        if (!res) throw new Error('SF2 fetch failed');
        const buf = await res.arrayBuffer();
        await syn.loadSFont(buf);
        this.sf2 = syn;
        this.sf2Ready = true;
        return true;
      } catch (e) {
        console.warn('[synth] GeneralUser.sf2 加载失败，使用内置合成器：', e && e.message || e);
        this.sf2 = null;
        this.sf2Ready = false;
        return false;
      } finally {
        this.sf2Loading = null;
      }
    })();
    return this.sf2Loading;
  }
  ensure(n) {
    for (let i = this.trackGains.length; i < n; i++) {
      const g = this.ctx.createGain(); g.gain.value = 1;
      const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
      this.trackGains[i] = g; this.panners[i] = p;
      this.vol[i] = 1; this.pan[i] = 0; this.mute[i] = false; this.solo[i] = false;
      if (p) { g.connect(p); p.connect(this.master); } else { g.connect(this.master); }
    }
  }
  effective(i) {
    if (this.mute[i]) return 0;
    if (this.solo.some(s => s) && !this.solo[i]) return 0;
    return this.vol[i] != null ? this.vol[i] : 1;
  }
  applyRouting() {
    this.ensure(this.vol.length);
    const t = this.ctx.currentTime;
    for (let i = 0; i < this.trackGains.length; i++) this.trackGains[i].gain.setTargetAtTime(this.effective(i), t, 0.02);
  }
  setVolume(v) { this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03); }
  setTrackVol(i, v) { this.ensure(i + 1); this.vol[i] = clamp(v, 0, 1); this.applyRouting(); }
  setTrackMute(i, b) { this.ensure(i + 1); this.mute[i] = b; this.applyRouting(); }
  setTrackSolo(i, b) { this.ensure(i + 1); this.solo[i] = b; this.applyRouting(); }
  setTrackPan(i, v) { this.ensure(i + 1); this.pan[i] = clamp(v, -1, 1); if (this.panners[i]) this.panners[i].pan.setTargetAtTime(this.pan[i], this.ctx.currentTime, 0.02); }
  noteOn(time, note, endTime) {
    this.ensure(note.trk + 1);
    if (this.sf2Ready && this.sf2) {
      const ch = Math.min(15, note.trk || 0);
      try {
        if (note.isDrum) this.sf2.midiSetChannelType(ch, true);
        else if (note.prog != null) this.sf2.midiProgramChange(ch, note.prog);
        this.sf2.midiNoteOn(ch, note.midi, note.vel);
      } catch (e) {}
      const delay = Math.max(0, (endTime - this.ctx.currentTime) * 1000);
      const timer = setTimeout(() => { try { this.sf2 && this.sf2.midiNoteOff(ch, note.midi); } catch (e) {} }, delay);
      this.activeNotes.push({ midi: note.midi, trk: note.trk, vel: note.vel, endTime, timer, sf2: true, ch });
      return;
    }
    const preset = presetFromMode('auto', note.prog, note.isDrum);
    const out = this.trackGains[note.trk];
    playVoice(this.ctx, time, note.midi, note.vel, preset, out, endTime, this.live);
    this.activeNotes.push({ midi: note.midi, trk: note.trk, vel: note.vel, endTime });
    if (this.activeNotes.length > 3000) this.activeNotes = this.activeNotes.filter(a => a.endTime > this.ctx.currentTime);
    if (this.live.length > 256) this.pruneLive();
  }
  preview(midi, prog = 0, vel = 100, dur = 0.7) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.ensure(1);
    if (this.sf2Ready && this.sf2) {
      try {
        this.sf2.midiProgramChange(0, prog);
        this.sf2.midiNoteOn(0, midi, vel);
        const timer = setTimeout(() => { try { this.sf2 && this.sf2.midiNoteOff(0, midi); } catch (e) {} }, dur * 1000);
        this.activeNotes.push({ midi, trk: 0, endTime: t + dur, timer, sf2: true, ch: 0 });
      } catch (e) {}
      return;
    }
    playVoice(this.ctx, t, midi, vel, presetForProgram(prog), this.trackGains[0], t + dur, this.live);
    this.activeNotes.push({ midi, trk: 0, endTime: t + dur });
  }
  pruneLive() {
    const t = this.ctx.currentTime;
    this.live = this.live.filter(x => {
      if (x.tStop > t) return true;
      try { x.o.stop(); } catch (e) {}
      return false;
    });
  }
  allStop() {
    const t = this.ctx.currentTime;
    for (const x of this.live) { if (x.tStop > t) { try { x.o.stop(); } catch (e) {} } }
    for (const a of this.activeNotes) { if (a.timer) { try { clearTimeout(a.timer); } catch (e) {} } if (a.sf2 && a.ch != null) { try { this.sf2 && this.sf2.midiNoteOff(a.ch, a.midi); } catch (e) {} } }
    this.live = [];
    this.activeNotes = [];
  }
  activeNow() {
    const t = this.ctx.currentTime;
    return this.activeNotes.filter(a => a.endTime > t);
  }
}
