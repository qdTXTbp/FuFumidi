// Web Audio 合成引擎 + 播放器调度（从 legacy FuFumidi.html 抽取，保持行为一致）
import { clamp, midiFreq } from './util.js';
import { t } from './i18n.js';

// SF2 合成器设置：与手机端 FuMiVoice（BASSMIDI）对齐。
// FluidSynth 的混响与合唱**默认开启**，而 BASSMIDI 两项默认关闭——同一个音色库
// 在两端因此听感不同（PC 更"湿"、有空间感与轻微失谐，手机端干净贴耳；
// 单声道音色库如 FluidR3 Mono 尤其明显）。这里显式关闭，让两端听到的是同一个声音。
export const SF2_SYNTH_SETTINGS = { reverbActive: false, chorusActive: false };

// 读出 SF2/SF3 里的 (bank, preset) 清单：SF3 只有采样数据是 Vorbis 压缩，
// 预设头（phdr）与 SF2 完全相同，可直接扫。失败时返回空集合，
// resolveSf2Bank 会因此始终退回 0 号库（等价于不做库选择，不会更差）。
// 离线导出渲染（sf2render.js）复用同一份实现，保证导出与播放一致。
export function indexSf2Presets(buf) {
  const set = new Set();
  try {
    const b = new Uint8Array(buf);
    // 找 'phdr' 标签（RIFF 结构：[4 字节 id][4 字节长度][数据]）
    let at = -1;
    for (let i = 0, n = b.length - 4; i < n; i++) {
      if (b[i] === 0x70 && b[i + 1] === 0x68 && b[i + 2] === 0x64 && b[i + 3] === 0x72) { at = i; break; }
    }
    if (at < 0) return set;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const count = Math.floor(dv.getUint32(at + 4, true) / 38) - 1;   // 每条 38 字节，末条是终止记录
    for (let k = 0; k < count; k++) {
      const o = at + 8 + k * 38;
      set.add(dv.getUint16(o + 22, true) * 128 + dv.getUint16(o + 20, true));   // bank * 128 + preset
    }
  } catch (e) { /* 解析失败按“未知”处理 */ }
  return set;
}

// 该音符最终使用的 (bank, prog)：文件选了库里不存在的库号 → 退回 0 号库。
// FluidSynth 选不到音色时会沿用上一个音色（整条通道错音），退库比错音更接近
// 手机端 BASSMIDI 的表现。
export function resolveSf2Bank(presets, bank, prog) {
  const b = bank > 0 ? bank : 0;
  if (!b) return { bank: 0, prog };
  const known = !!(presets && presets.size);
  if (!known || !presets.has(b * 128 + prog)) return { bank: 0, prog };
  return { bank: b, prog };
}

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
    /* ---------------- 音效链：10 段 EQ + 低音增强 + 空间展宽（可旁路） ---------------- */
    // 拓扑：master → fxIn → [EQ 级联] → [bassShelf] → [mid/side 展宽] → fxOut → analyser → ...
    // fxEnabled=false 时走 master → analyser 直连（零处理旁路）
    const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    this.fxIn = ctx.createGain(); this.fxOut = ctx.createGain();
    this.eqFilters = EQ_FREQS.map((f, i) => {
      const bq = ctx.createBiquadFilter();
      bq.type = i === 0 ? 'lowshelf' : (i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking');
      bq.frequency.value = f; bq.Q.value = 1.1; bq.gain.value = 0;
      return bq;
    });
    for (let i = 0; i < this.eqFilters.length - 1; i++) this.eqFilters[i].connect(this.eqFilters[i + 1]);
    this.bassShelf = ctx.createBiquadFilter();
    this.bassShelf.type = 'lowshelf'; this.bassShelf.frequency.value = 120; this.bassShelf.gain.value = 0;
    this.eqFilters[this.eqFilters.length - 1].connect(this.bassShelf);
    // mid/side 立体声展宽：L' = L + s*(L-R)/2, R' = R - s*(L-R)/2（s=0 原声，s=1 最大展宽）
    this.splitter = ctx.createChannelSplitter(2);
    this.merger = ctx.createChannelMerger(2);
    const midL = ctx.createGain(), midR = ctx.createGain();
    const invR = ctx.createGain(), invL = ctx.createGain();
    const sideL = ctx.createGain(), sideR = ctx.createGain();
    invR.gain.value = -1; invL.gain.value = -1;
    sideL.gain.value = 0; sideR.gain.value = 0;
    this.bassShelf.connect(this.splitter);
    this.splitter.connect(midL, 0); this.splitter.connect(midR, 1);        // L/R 直通（mid 分量）
    this.splitter.connect(invR, 1);                                        // -R
    this.splitter.connect(invL, 0);                                        // -L
    midL.connect(sideL); invR.connect(sideL);   // side = L - R（左耳加正 side）
    midR.connect(sideR); invL.connect(sideR);   // 反相 side 加到右耳
    sideL.connect(this.merger, 0, 0); midL.connect(this.merger, 0, 0);
    sideR.connect(this.merger, 0, 1); midR.connect(this.merger, 0, 1);
    this.bassShelf.connect(this.fxOut);
    this.merger.connect(this.fxOut);
    this.fxOut.connect(this.analyser);
    this.fxEnabled = false;
    this.setSpatial = (v) => { const s = Math.max(0, Math.min(1, v || 0)); try { sideL.gain.setTargetAtTime(s * 0.5, ctx.currentTime, 0.03); sideR.gain.setTargetAtTime(-s * 0.5, ctx.currentTime, 0.03); } catch (e) {} };
    this.setEqGains = (gains) => { if (!Array.isArray(gains)) return; this.eqFilters.forEach((f, i) => { try { f.gain.setTargetAtTime(Math.max(-12, Math.min(12, gains[i] || 0)), ctx.currentTime, 0.03); } catch (e) {} }); };
    this.setBassBoost = (db) => { try { this.bassShelf.gain.setTargetAtTime(Math.max(0, Math.min(12, db || 0)), ctx.currentTime, 0.03); } catch (e) {} };
    this.setFxEnabled = (on) => {
      this.fxEnabled = !!on;
      try { this.master.disconnect(); } catch (e) {}
      this.master.connect(on ? this.fxIn : this.analyser);
    };
    this.trackGains = []; this.vol = []; this.mute = []; this.solo = [];
    this.panners = []; this.pan = [];
    // 通道混音状态（音色库/SF2 播放用；说明见 setChannelVol 一段的注释）
    this.chVol = {}; this.chMute = {}; this.chSolo = {}; this.chPan = {};
    this._fileCc7 = {}; this._fileCc10 = {};   // 文件里该通道最后一次 CC7 / CC10
    this._knownCh = new Set();                 // 已下发过通道增益的通道
    this.live = []; this.activeNotes = [];
    this.sf2 = null;
    this.sf2Ready = false;
    this.sf2Loading = null;
    this.sf2Node = null;
    // 待触发的 SF2 note-on 定时器（用于调度：音符必须按绝对时间发声，与内置合成器一致）
    this._sf2Pending = [];
    // 主线程卡顿时（如切页触发重渲染）延迟触发的容忍度（秒）：超过即跳过该音，
    // 避免音头聚簇噪点。切页时 Player.bumpAhead 会临时放宽（见 player.js）。
    this._sf2LateTol = 0.04;
    // 活跃发声节点修剪上限：预排窗口扩大时（切页 bumpAhead）临时放宽，
    // 避免预排的待发声振荡器被 pruneLive 提前杀掉。
    this._liveLimit = 1024;
    // SF2 AudioWorklet 音序器调度：fluid_sequencer 时钟在 worklet 线程推进
    // （fu-seq-clock.js），音符事件按绝对时间分发给合成器——主线程阻塞不再造成
    // 音符迟到/掉音。ScriptProcessor 回退路径仍用 setTimeout。
    this.sf2Seq = null;          // WorkletSequencer 代理
    this._sf2SeqClient = null;   // 合成器在音序器里的 clientId
    this._sf2SeqMode = false;
    this._seqAnchor = null;      // { ctx, seq }：AudioContext 时间 ↔ 音序器 tick（毫秒）锚点
    this._sf2ChProg = [];        // 各通道已调度的 program（避免每音符重复 programchange）
    this._sf2ChBank = [];        // 各通道已调度的音色库（避免每音符重复 CC0）
    this._sf2DrumCh = [];        // 已设为鼓组的通道
    this._sf2Presets = null;     // 已加载音色库里的 (bank, preset) 清单，见 _indexSf2Presets
    this._sf2ChProgOverride = {}; // 混音台手动指定的通道音色（ch → program），优先于文件音色
  }
  // 指定加载的音色：'internal'（内置合成器）或 SF2 来源（网页相对路径 / 桌面绝对路径 / URL）。
  // 由音色工坊切换并持久化（settings.active_soundfont）。
  async setSoundfont(source) {
    // 内置合成器：不加载 SF2，回退到 Web Audio playVoice 预设
    if (!source || source === 'internal') {
      this.clearSf2();
      return { ok: true, using: 'internal' };
    }
    if (this.sf2Loading) { try { await this.sf2Loading; } catch (e) {} }
    const task = this._loadSf2From(source)
      .then((r) => { this.sf2Loading = null; return r; })
      .catch((e) => {
        console.warn('[synth] SF2 加载失败，回退内置合成器：', e && e.message || e);
        this.clearSf2();
        this.sf2Loading = null;
        return { ok: false, using: 'internal', error: String(e && e.message || e) };
      });
    this.sf2Loading = task;
    return task;
  }
  clearSf2() {
    if (this.sf2Seq) {
      // 停掉 worklet 内的音序器时钟并清空未分发事件（换音色/回退内置前）
      try { if (this.sf2) this.sf2.callFunction('__fuSeqClockStop', null).catch(() => {}); } catch (e) {}
      try { this.sf2Seq.removeAllEvents(); } catch (e) {}
      this.sf2Seq = null;
      this._sf2SeqClient = null;
      this._sf2SeqMode = false;
      this._seqAnchor = null;
    }
    // 摘掉常驻时钟节点
    try { if (this._seqClockNode) { this._seqClockNode.disconnect(); } } catch (e) {}
    try { if (this._seqClockMute) { this._seqClockMute.disconnect(); } } catch (e) {}
    this._seqClockNode = null;
    this._seqClockMute = null;
    try { if (this.sf2Node) this.sf2Node.disconnect(); } catch (e) {}
    this.sf2Node = null;
    this.sf2 = null;
    this.sf2Ready = false;
    this._sf2ChProg = [];
    this._sf2ChBank = [];
    this._sf2DrumCh = [];
    // 引擎重建后通道增益需要重新下发（用户推子保留，见通道混音一段）
    this._knownCh = new Set();
  }
  // js-synth 按需懒加载（原先在 index.html 同步 <script> 加载会阻塞首帧）。
  // 两条路径：
  //   AudioWorklet（首选）：libfluidsynth 在 worklet 音频线程里合成，主线程长任务
  //     （切页 / 乐谱重绘）完全不影响音频——ScriptProcessor 的主线程合成在阻塞时会断流。
  //   ScriptProcessor（回退）：主线程合成，仅作为 addModule 失败时的兜底。
  _jssynthLibLoading = null;    // js-synthesizer.min.js（AudioWorkletNodeSynthesizer + Synthesizer 类）
  _jssynthGlueLoading = null;   // libfluidsynth 胶水（仅回退路径需要，2.4MB）
  _workletModulesLoading = null;
  _workletModules = false;
  _ensureJSSynthLib() {
    if ((window || {}).JSSynth) return Promise.resolve(true);
    if (this._jssynthLibLoading) return this._jssynthLibLoading;
    this._jssynthLibLoading = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = './vendor/js-synth/js-synthesizer.min.js';
      s.onload = () => resolve(!!(window || {}).JSSynth);
      s.onerror = () => { console.warn('[synth] js-synthesizer 脚本加载失败'); resolve(false); };
      document.head.appendChild(s);
    });
    return this._jssynthLibLoading;
  }
  _ensureJSSynthGlue() {
    if ((window || {}).Module) return Promise.resolve(true);
    if (this._jssynthGlueLoading) return this._jssynthGlueLoading;
    this._jssynthGlueLoading = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = './vendor/js-synth/libfluidsynth-2.4.6-with-libsndfile.js';
      s.onload = () => resolve(!!(window || {}).Module);
      s.onerror = () => { console.warn('[synth] libfluidsynth 胶水脚本加载失败'); resolve(false); };
      document.head.appendChild(s);
    });
    return this._jssynthGlueLoading;
  }
  // 在 AudioWorkletGlobalScope 内加载 libfluidsynth + js-synthesizer 的 worklet 处理器。
  // glue 在 worklet 作用域求值后会导出 AudioWorkletGlobalScope.wasmModule 供处理器使用。
  _ensureWorkletModules() {
    if (this._workletModules) return Promise.resolve(true);
    if (this._workletModulesLoading) return this._workletModulesLoading;
    this._workletModulesLoading = (async () => {
      await this.ctx.audioWorklet.addModule('./vendor/js-synth/libfluidsynth-2.4.6-with-libsndfile.js');
      await this.ctx.audioWorklet.addModule('./vendor/js-synth/js-synthesizer.worklet.min.js');
      // 音序器时钟模块（失败不影响合成，仅回退 setTimeout 调度）
      try { await this.ctx.audioWorklet.addModule('./vendor/js-synth/fu-seq-clock.js'); } catch (e) {
        console.warn('[synth] 音序器时钟模块加载失败：', e && e.message || e);
      }
      this._workletModules = true;
      return true;
    })();
    this._workletModulesLoading.catch(() => { this._workletModulesLoading = null; }); // 失败允许重试
    return this._workletModulesLoading;
  }
  async _loadSf2From(source) {
    const buf = await this._readSf2Buffer(source);
    if (!buf) { this.clearSf2(); return { ok: false, using: 'internal', error: t('无法读取音色文件') }; }
    // 大音色解析时会在主线程占用一小段时间；上限与主进程 file:readSoundFont 一致(512MB)。
    // 覆盖店内可下载的 FluidR3/Arachno(~141MB)、SGM(~300MB)；更大的（如 1.2GB Salamander）
    // 会在读取阶段被主进程拒掉（buf 为 null 走上方“无法读取音色文件”），不会整包塞进 JS 合成器。
    const MAX_SF2 = 512 * 1024 * 1024;
    if (buf.byteLength > MAX_SF2) {
      this.clearSf2();
      return { ok: false, using: 'internal', error: t('音色包过大（>') + Math.round(MAX_SF2 / 1048576) + 'MB' + t('），超出当前合成器可承载范围，请改用内置音色或更小的音色包。') };
    }
    // 记下这份音色库里实际存在的 (bank, preset)：回放时若文件指定的库号库里没有，
    // 就退回 0 号库（见 _sf2ProgramFor），避免 FluidSynth 选不到音色而沿用上一音色。
    this._sf2Presets = indexSf2Presets(buf);
    // 首选 AudioWorklet
    try {
      const r = await this._loadSf2Worklet(buf, source);
      if (r) return r;
    } catch (e) {
      console.warn('[synth] AudioWorklet 合成器初始化失败，回退 ScriptProcessor：', e && e.message || e);
    }
    // 回退 ScriptProcessor
    return this._loadSf2ScriptProcessor(buf, source);
  }
  async _loadSf2Worklet(buf, source) {
    const loaded = await this._ensureJSSynthLib();
    const JSSynth = (window || {}).JSSynth;
    if (!loaded || !JSSynth || !JSSynth.AudioWorkletNodeSynthesizer) return null;
    if (!this.ctx.audioWorklet) return null;
    await this._ensureWorkletModules();
    this.clearSf2();
    const syn = new JSSynth.AudioWorkletNodeSynthesizer();
    const node = syn.createAudioNode(this.ctx, SF2_SYNTH_SETTINGS);
    try {
      node.connect(this.master);
      // SF2 在 worklet 堆内加载（loadSFont 返回 Promise，缓冲经 structured clone 传入）
      await syn.loadSFont(new Uint8Array(buf));
    } catch (e) {
      try { node.disconnect(); } catch (e2) {}
      throw e;
    }
    this.sf2 = syn;
    this.sf2Node = node;
    this.sf2Ready = true;
    console.info('[synth] SF2 已启用 AudioWorklet 合成（音频线程渲染，主线程卡顿不影响发声）');
    // 音序器调度：把 noteon/noteoff 以绝对 tick 写入 fluid_sequencer，
    // 由 fu-seq-clock 在 worklet 线程按真实流逝毫秒推进时钟并准时分发。
    this._sf2SeqMode = false;
    try {
      const seq = await syn.createSequencer();
      seq.setTimeScale(1000); // tick 单位 = 毫秒
      const clientId = await seq.registerSynthesizer(syn);
      const seqPtr = await seq.getRaw();
      const ok = await syn.callFunction('__fuSeqClockStart', { seqPtr });
      if (!ok) throw new Error('worklet 内时钟启动失败');
      // 创建常驻时钟节点：worklet 无定时器 API，由该节点的 process() 在音频线程
      // 每个渲染量子推进音序器。Chromium 不允许输入/输出同时为 0，故给 1 个输出
      // 并经零增益接入 destination：图保持连通（必然被调度）且不发声。
      try {
        this._seqClockNode = new AudioWorkletNode(this.ctx, 'fu-seq-clock', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
        const mute = this.ctx.createGain();
        mute.gain.value = 0;
        this._seqClockNode.connect(mute);
        mute.connect(this.ctx.destination);
        this._seqClockMute = mute;
      } catch (e2) {
        try { await syn.callFunction('__fuSeqClockStop', null); } catch (e3) {}
        throw new Error('时钟节点创建失败：' + (e2 && e2.message || e2));
      }
      const t0 = await seq.getTick();
      this._seqAnchor = { ctx: this.ctx.currentTime, seq: t0 };
      this.sf2Seq = seq;
      this._sf2SeqClient = clientId;
      this._sf2SeqMode = true;
      console.info('[synth] SF2 音序器调度已启用（音符时值由音频线程时钟分发，主线程卡顿不影响）');
    } catch (e) {
      this.sf2Seq = null;
      this._sf2SeqClient = null;
      this._seqAnchor = null;
      console.warn('[synth] 音序器调度不可用，SF2 音符回退主线程 setTimeout 触发：', e && e.message || e);
    }
    return { ok: true, using: 'sf2', mode: 'worklet', source: typeof source === 'string' ? source : 'soundfont' };
  }
  // AudioContext 时间（秒）→ 音序器 tick（毫秒，绝对）
  _seqTickFor(t) {
    const a = this._seqAnchor;
    if (!a) return 0;
    return a.seq + Math.round((t - a.ctx) * 1000);
  }
  // 重读音序器时钟，校正与 AudioContext 时钟的长期漂移（寻址/暂停/恢复后调用）
  _reanchorSeq() {
    if (!this._sf2SeqMode || !this.sf2Seq) return;
    this.sf2Seq.getTick().then((t) => {
      if (this._sf2SeqMode) this._seqAnchor = { ctx: this.ctx.currentTime, seq: t };
    }).catch(() => {});
  }
  async _loadSf2ScriptProcessor(buf, source) {
    let loaded = await this._ensureJSSynthLib();
    const JSSynth = (window || {}).JSSynth;
    if (!loaded || !JSSynth) { this.clearSf2(); return { ok: false, using: 'internal', error: t('JSSynth 不可用') }; }
    loaded = await this._ensureJSSynthGlue();
    if (!loaded) { this.clearSf2(); return { ok: false, using: 'internal', error: t('libfluidsynth 运行时不可用') }; }
    // 防御自愈：ScriptProcessor 版 Synthesizer 的 ccall 在调用期读取全局 Module。
    // 若 Module 被外部覆盖成无 _fluid_* 导出的对象（旧版 Verovio 加载逻辑等），
    // 调用会报「func is not a function」。检测到时重建运行时。
    const hasFluidRuntime = () => {
      const m = (window || {}).Module;
      if (!m) return false;
      try { return Object.keys(m).some(k => k.indexOf('_fluid_') === 0); } catch (e) { return false; }
    };
    if (!hasFluidRuntime()) {
      console.warn('[synth] 全局 libfluidsynth 运行时无效，正在重建…');
      this._jssynthGlueLoading = null;
      try { window.Module = undefined; } catch (e) {}
      loaded = await this._ensureJSSynthGlue();
      if (!loaded) { this.clearSf2(); return { ok: false, using: 'internal', error: t('libfluidsynth 运行时不可用') }; }
    }
    await JSSynth.waitForReady();
    this.clearSf2();
    const syn = new JSSynth.Synthesizer();
    syn.init(this.ctx.sampleRate, SF2_SYNTH_SETTINGS);
    // 回退路径：缓冲越大越能扛主线程抖动（8192≈186ms）；正常情况不会走到这里
    const node = syn.createAudioNode(this.ctx, 8192);
    node.connect(this.master);
    await syn.loadSFont(new Uint8Array(buf));
    this.sf2 = syn;
    this.sf2Node = node;
    this.sf2Ready = true;
    return { ok: true, using: 'sf2', mode: 'script-processor', source: typeof source === 'string' ? source : 'soundfont' };
  }
  // 读取 .sf2 内容：网页内置相对路径→fetch；桌面/本地路径→IPC；否则 URL fetch
  async _readSf2Buffer(source) {
    const isRel = source === 'web:generaluser' || (typeof source === 'string' && (source[0] === '.' || source[0] === '/'));
    if (isRel) {
      const paths = source === 'web:generaluser'
        ? ['../vendor/soundfonts/GeneralUser.sf2', './vendor/soundfonts/GeneralUser.sf2']
        : [source];
      for (const p of paths) {
        try { const res = await fetch(p); if (res.ok) return await res.arrayBuffer(); } catch (e) {}
      }
      return null;
    }
    const bridge = (typeof window !== 'undefined') ? window.fuBridge : null;
    if (bridge && bridge.readSoundFont) {
      try { const ab = await bridge.readSoundFont(source); return ab || null; } catch (e) { return null; }
    }
    try { const res = await fetch(source); if (res.ok) return await res.arrayBuffer(); } catch (e) { return null; }
  }
  loadSf2() {
    // 兼容旧调用：网页端默认加载内置 GeneralUser；桌面端由音色工坊 setSoundfont 接管
    const bridge = window && window.fuBridge;
    return this.setSoundfont(bridge ? undefined : 'web:generaluser').catch(() => this.clearSf2());
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
  // ---- 音色 / 音色库下发 ----
  // MIDI 的 program 与 bank（CC0）都是通道级状态，文件里会中途变化，也可能写在别的轨里；
  // 这里按「音符所在通道 + 该时刻的状态」下发，与手机端 BASSMIDI 直接播放文件事件一致。
  // 该音符最终使用的 (bank, prog)：文件选了库里不存在的库号 → 退回 0 号库。
  // 若用户通过混音台给某通道手动指定了音色（_sf2ChProgOverride），则优先用它（0 号库）。
  _sf2ProgramFor(note) {
    const ch = note.ch != null ? note.ch : Math.min(15, note.trk || 0);
    const ov = this._sf2ChProgOverride[ch];
    if (ov != null) return resolveSf2Bank(this._sf2Presets, 0, ov);
    return resolveSf2Bank(this._sf2Presets, note.bank || 0, note.prog != null ? note.prog : 0);
  }
  // 音序器路径：CC0（库号）先于 programchange，二者同一 tick（音序器对同一时刻按写入顺序分发）
  _seqApplyProgram(ch, note, tick) {
    if (!this.sf2Seq) return;
    const { bank, prog } = this._sf2ProgramFor(note);
    if (this._sf2ChBank[ch] !== bank) {
      try { this.sf2Seq.sendEventAt({ type: 'controlchange', channel: ch, control: 0, value: bank }, tick, true); } catch (e) {}
      this._sf2ChBank[ch] = bank;
    }
    if (this._sf2ChProg[ch] !== prog) {
      try { this.sf2Seq.sendEventAt({ type: 'programchange', channel: ch, preset: prog }, tick, true); } catch (e) {}
      this._sf2ChProg[ch] = prog;
    }
  }
  // 主线程合成路径（ScriptProcessor 回退）：直接调 js-synth API
  _directApplyProgram(ch, note) {
    const { bank, prog } = this._sf2ProgramFor(note);
    if (this._sf2ChBank[ch] !== bank) {
      try { this.sf2.midiControl(ch, 0, bank); } catch (e) {}
      this._sf2ChBank[ch] = bank;
    }
    try { this.sf2.midiProgramChange(ch, prog); } catch (e) {}
    this._sf2ChProg[ch] = prog;
  }
  // 通用通道事件（CC / 弯音）。
  // 手机端 BASSMIDI 是直接播放文件事件的，音量(CC7)、声像(CC10)、表情(CC11)、
  // 延音(CC64)、弯音这些「演奏信息」都在其中；电脑端此前只发音符与音色，
  // 这些全部丢失（表情渐强、钢琴踏板、弯音都没了），是两端听感的另一半差异。
  // 注意：库号 CC0/CC32 不在这里下发，它由 _sf2ProgramFor 做「缺库退回 0 号库」处理。
  midiEvent(time, ev) {
    if (!ev || !this.sf2Ready || !this.sf2) return;
    const ch = ev.ch != null ? ev.ch : 0;
    if (ev.kind === 'bend') { this._sendBendAt(ch, ev.val, time); return; }
    if (ev.cc === 7) {
      // 文件自己的通道音量（自动化）：记为基准，再由推子/静音/独奏叠加后下发
      this._fileCc7[ch] = ev.val;
      this._applyChannelGain(ch, time);
      return;
    }
    if (ev.cc === 10) {
      this._fileCc10[ch] = ev.val;
      this._applyChannelPan(ch, time);
      return;
    }
    this._sendCcAt(ch, ev.cc, ev.val, time);
  }
  // 通道事件的两种下发路径：音序器写绝对 tick；回退路径按绝对时间 setTimeout。
  // time 为空表示「立刻」（混音台推子这类实时操作）。
  _sendCcAt(ch, cc, val, time) {
    if (!this.sf2Ready || !this.sf2) return;
    if (this._sf2SeqMode && this.sf2Seq) {
      const now = this.ctx.currentTime;
      const at = time == null ? now : Math.max(now, time);
      const tick = Math.max(this._seqTickFor(now), this._seqTickFor(at));
      try { this.sf2Seq.sendEventAt({ type: 'controlchange', channel: ch, control: cc, value: val }, tick, true); } catch (e) {}
      return;
    }
    const now = this.ctx.currentTime;
    const delay = Math.max(0, ((time == null ? now : Math.max(now, time)) - now) * 1000);
    const fire = () => { if (!this.sf2) return; try { this.sf2.midiControl(ch, cc, val); } catch (e) {} };
    if (delay === 0) fire(); else this._sf2Pending.push(setTimeout(fire, delay));
  }
  _sendBendAt(ch, val, time) {
    if (!this.sf2Ready || !this.sf2) return;
    if (this._sf2SeqMode && this.sf2Seq) {
      const now = this.ctx.currentTime;
      const at = time == null ? now : Math.max(now, time);
      const tick = Math.max(this._seqTickFor(now), this._seqTickFor(at));
      try { this.sf2Seq.sendEventAt({ type: 'pitchbend', channel: ch, value: val }, tick, true); } catch (e) {}
      return;
    }
    const now = this.ctx.currentTime;
    const delay = Math.max(0, ((time == null ? now : Math.max(now, time)) - now) * 1000);
    const fire = () => { if (!this.sf2) return; try { this.sf2.midiPitchBend(ch, val); } catch (e) {} };
    if (delay === 0) fire(); else this._sf2Pending.push(setTimeout(fire, delay));
  }
  /* ---------------- 通道混音（音色库 / SF2 播放） ----------------
     音色库的输出只有一路混合节点（sf2Node → master），没法在 Web Audio 层按轨插增益，
     所以音色库模式的混音台改用 MIDI 通道音量(CC7) / 声像(CC10)：音量、静音、独奏
     立即生效（包括正在发声的音符），且不改变音色 —— 与手机端 BASSMIDI 播放同一文件
     时的模型一致。
     叠加关系是「推子优先、文件自动化打底」：
       通道实际音量 = 文件 CC7（文件没写过则按 127）× 推子 × 静音/独奏
     粒度是「通道」而非「轨」：同一通道上的多条轨物理上分不开，会一起变化。 */
  resetChannelMix() {
    this.chVol = {}; this.chMute = {}; this.chSolo = {}; this.chPan = {};
    this._fileCc7 = {}; this._fileCc10 = {}; this._knownCh = new Set();
    this._sf2ChProgOverride = {};
  }
  // 手动给某通道指定音色（混音台）：prog<0 表示清除覆盖、回到文件原音色。
  // program 是通道级状态，同一通道上的多条轨会一起变，与手机端 BASSMIDI 一致。
  // 设置后立即对当前播放的曲目生效（下一个该通道的音符以及已按覆盖下发的通道）。
  setChannelProgram(ch, prog) {
    if (prog == null || prog < 0) delete this._sf2ChProgOverride[ch];
    else this._sf2ChProgOverride[ch] = Math.round(clamp(prog, 0, 127));
    // 清掉下发缓存，强制下一次音符按新音色重新下发
    this._sf2ChBank[ch] = undefined;
    this._sf2ChProg[ch] = undefined;
    const cur = this._sf2ChProgOverride[ch];
    if (cur == null || !this.sf2Ready) return;
    const { bank, prog: p } = resolveSf2Bank(this._sf2Presets, 0, cur);
    const now = this.ctx.currentTime;
    if (this._sf2SeqMode && this.sf2Seq) {
      const tick = this._seqTickFor(now);
      try { this.sf2Seq.sendEventAt({ type: 'controlchange', channel: ch, control: 0, value: bank }, tick, true); } catch (e) {}
      try { this.sf2Seq.sendEventAt({ type: 'programchange', channel: ch, preset: p }, tick, true); } catch (e) {}
    } else if (this.sf2) {
      try { this.sf2.midiControl(ch, 0, bank); } catch (e) {}
      try { this.sf2.midiProgramChange(ch, p); } catch (e) {}
    }
  }
  _anyChSolo() { for (const k in this.chSolo) if (this.chSolo[k]) return true; return false; }
  _chEffective(ch) {
    if (this.chMute[ch]) return 0;
    if (this._anyChSolo() && !this.chSolo[ch]) return 0;
    return this.chVol[ch] != null ? this.chVol[ch] : 1;
  }
  _applyChannelGain(ch, time) {
    const base = this._fileCc7[ch];
    const val = Math.round((base == null ? 127 : base) * this._chEffective(ch));
    this._sendCcAt(ch, 7, Math.max(0, Math.min(127, val)), time);
  }
  _applyChannelPan(ch, time) {
    // 声像没法相乘，用户推子按偏移叠加在文件 CC10 之上（默认 64 = 居中）
    const base = this._fileCc10[ch] == null ? 64 : this._fileCc10[ch];
    const val = base + Math.round((this.chPan[ch] || 0) * 63);
    this._sendCcAt(ch, 10, Math.max(0, Math.min(127, val)), time);
  }
  _applyAllChannelGains() {
    const t = this.ctx ? this.ctx.currentTime : 0;
    for (const ch of this._knownCh) this._applyChannelGain(ch, t);
  }
  setChannelVol(ch, v) { this.chVol[ch] = clamp(v, 0, 1); this._applyChannelGain(ch); }
  setChannelMute(ch, b) { this.chMute[ch] = !!b; this._applyChannelGain(ch); }
  setChannelSolo(ch, b) { this.chSolo[ch] = !!b; this._applyAllChannelGains(); }
  setChannelPan(ch, v) { this.chPan[ch] = clamp(v, -1, 1); this._applyChannelPan(ch); }
  noteOn(time, note, endTime) {
    this.ensure(note.trk + 1);
    if (this.sf2Ready && this.sf2) {
      // 用音符自己的 MIDI 通道（不是轨序号）；note.ch 由 player.prepare 从文件里取
      const ch = note.ch != null ? note.ch : Math.min(15, note.trk || 0);
      // 该通道首次发声时补发一次通道增益/声像：混音台在起播前调过的推子不会丢
      if (!this._knownCh.has(ch)) {
        this._knownCh.add(ch);
        this._applyChannelGain(ch, time);
        this._applyChannelPan(ch, time);
      }
      // —— 音序器路径（AudioWorklet + fu-seq-clock）：事件按绝对 tick 写入 fluid_sequencer，
      // worklet 线程准时分发。主线程阻塞期间已写入的事件照常发声，无迟到/掉音。 ——
      if (this._sf2SeqMode && this.sf2Seq) {
        const now = this.ctx.currentTime;
        const onTime = Math.max(now, time);
        // 调度本身被拖延过久（主线程长任务超出预排窗口）时跳过，避免解阻塞后音头聚簇噪点
        if (time < now - (this._sf2LateTol || 0.04)) return;
        const tick = Math.max(this._seqTickFor(now), this._seqTickFor(onTime));
        if (note.isDrum) {
          if (!this._sf2DrumCh[ch]) { try { this.sf2.midiSetChannelType(ch, true); } catch (e) {} this._sf2DrumCh[ch] = true; }
        } else {
          this._seqApplyProgram(ch, note, tick);
        }
        // 'note' 事件 = noteon + 时值到后自动 noteoff（fluid seqbind 内部调度）
        const dur = Math.max(60, Math.round((Math.max(endTime, onTime + 0.06) - onTime) * 1000));
        try { this.sf2Seq.sendEventAt({ type: 'note', channel: ch, key: note.midi, vel: note.vel, duration: dur }, tick, true); } catch (e) {}
        this.activeNotes.push({ midi: note.midi, trk: note.trk, vel: note.vel, start: onTime, endTime, sf2: true, ch });
        return;
      }
      // 调度到与内置合成器一致的绝对发声时刻：播放器 lookahead 会把音符提前 0~0.18s
      // 传入，若立即触发会导致音符提前发声、节奏与内置合成器不一致。
      // JSSynth 无「按绝对时间 note-on」API，故用 setTimeout 补足；禁止把音符发在起点之前。
      const onTime = Math.max(this.ctx.currentTime, time);
      const delayOn = Math.max(0, (onTime - this.ctx.currentTime) * 1000);
      const sendOff = () => {
        if (!this.sf2) return;
        try { this.sf2.midiNoteOff(ch, note.midi); } catch (e) {}
      };
      if (delayOn === 0) {
        // onTime 即当前时刻：立即触发（跳转/快速变速后追赶音符）
        try { if (note.isDrum) this.sf2.midiSetChannelType(ch, true); else this._directApplyProgram(ch, note); this.sf2.midiNoteOn(ch, note.midi, note.vel); } catch (e) {}
        const offTimer = setTimeout(sendOff, Math.max(0, (Math.max(endTime, onTime + 0.06) - onTime) * 1000));
        this.activeNotes.push({ midi: note.midi, trk: note.trk, vel: note.vel, start: onTime, endTime, timer: offTimer, sf2: true, ch });
      } else {
        const onTimer = setTimeout(() => {
          if (!this.sf2) return;
          // 主线程卡顿（如打开乐谱/大文件渲染）会让多个到期 setTimeout 同时触发，
          // 若强行触发会产生大量音头聚簇 → 噪点/爆破。超过容忍度（默认 40ms，
          // 切页时 bumpAhead 临时放宽）的音符跳过本次触发。
          const now = this.ctx.currentTime;
          if (onTime < now - (this._sf2LateTol || 0.04)) return;
          try { if (note.isDrum) this.sf2.midiSetChannelType(ch, true); else this._directApplyProgram(ch, note); this.sf2.midiNoteOn(ch, note.midi, note.vel); } catch (e) {}
          const offTimer = setTimeout(sendOff, Math.max(0, (Math.max(endTime, onTime + 0.06) - now) * 1000));
          this.activeNotes.push({ midi: note.midi, trk: note.trk, vel: note.vel, start: onTime, endTime, timer: offTimer, sf2: true, ch });
        }, delayOn);
        this._sf2Pending.push(onTimer);
      }
      return;
    }
    const ch = note.ch != null ? note.ch : Math.min(15, note.trk || 0);
    const ov = this._sf2ChProgOverride[ch];
    const preset = presetFromMode('auto', ov != null ? ov : note.prog, note.isDrum);
    const out = this.trackGains[note.trk];
    playVoice(this.ctx, time, note.midi, note.vel, preset, out, endTime, this.live);
    this.activeNotes.push({ midi: note.midi, trk: note.trk, vel: note.vel, start: time, endTime });
    if (this.activeNotes.length > 3000) this.activeNotes = this.activeNotes.filter(a => a.endTime > this.ctx.currentTime);
    if (this.live.length > this._liveLimit) this.pruneLive(this._liveLimit);
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
        this.activeNotes.push({ midi, trk: 0, start: t, endTime: t + dur, timer, sf2: true, ch: 0 });
      } catch (e) {}
      return;
    }
    playVoice(this.ctx, t, midi, vel, presetForProgram(prog), this.trackGains[0], t + dur, this.live);
    this.activeNotes.push({ midi, trk: 0, start: t, endTime: t + dur });
  }
  pruneLive(limit = 256) {
    const t = this.ctx.currentTime;
    const expires = this.live.filter(x => x.tStop <= t);
    for (const x of expires) { try { x.o.stop(); } catch (e) {} }
    this.live = this.live.filter(x => x.tStop > t);
    if (this.live.length > limit) {
      const sorted = this.live.slice().sort((a, b) => a.tStop - b.tStop);
      const remove = sorted.slice(0, this.live.length - limit);
      for (const x of remove) { try { x.o.stop(); } catch (e) {} }
      this.live = this.live.filter(x => !remove.includes(x));
    }
  }
  allStop() {
    const t = this.ctx.currentTime;
    for (const x of this.live) { if (x.tStop > t) { try { x.o.stop(); } catch (e) {} } }
    // 取消尚未触发的 SF2 note-on（跳转/暂停/停止时，避免 antedated 音符稍后误发声）
    for (const tm of this._sf2Pending) { try { clearTimeout(tm); } catch (e) {} }
    this._sf2Pending = [];
    // 音序器路径：清掉所有未分发的调度事件（未来 noteon/noteoff/programchange）
    if (this.sf2Seq && this._sf2SeqClient != null) {
      try { this.sf2Seq.removeAllEventsFromClient(this._sf2SeqClient); } catch (e) {}
    }
    for (const a of this.activeNotes) { if (a.timer) { try { clearTimeout(a.timer); } catch (e) {} } if (a.sf2 && a.ch != null) { try { this.sf2 && this.sf2.midiNoteOff(a.ch, a.midi); } catch (e) {} } }
    this.live = [];
    this.activeNotes = [];
    // 上面清掉了未分发的调度事件（含 program/bank 变更），缓存的通道状态已不可信，
    // 清掉让下一个音符重新下发，避免跳转后沿用错误的音色。
    this._sf2ChProg = [];
    this._sf2ChBank = [];
    // 跳转/重排后重读音序器锚点（校正与 AudioContext 时钟的漂移）
    this._reanchorSeq();
  }
  activeNow() {
    const t = this.ctx.currentTime;
    // start 为空（旧数据）时兼容为「只要还没结束就认为活动」；
    // 有 start 时只返回「已经开始且未结束」的音符，避免 lookahead 提前 0.18s 预调度
    // 导致琴键高亮/和弦判断早于实际发声。
    return this.activeNotes.filter(a => a.endTime > t && (a.start == null || a.start <= t));
  }
}
