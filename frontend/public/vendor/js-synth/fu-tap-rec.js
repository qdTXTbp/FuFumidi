/* FuFumidi 诊断用音频采样 tap（在 AudioWorkletGlobalScope 内运行）
 * 用途：
 *  1. 把 master 输出的 PCM 持续写入环形缓冲（音频线程采样，主线程阻塞不影响）；
 *  2. __fuProbe2：读 wasmModule 的音序器状态（use_system_timer / tick），可选手动 pump；
 *  3. 线程标记：验证 tap 与 js-synth 合成器是否同一 worklet 线程（__fuTapCfg.mark）。
 * 主线程侧需先 tap.port.start()（onmessage 亦可）再 addEventListener 才能收到消息。
 * 正常播放路径不加载此模块，仅诊断会话按需 addModule。 */
(function (G) {
  'use strict';
  function wasm() {
    try { if (typeof AudioWorkletGlobalScope !== 'undefined' && AudioWorkletGlobalScope.wasmModule) return AudioWorkletGlobalScope.wasmModule; } catch (e) {}
    try { if (G.wasmModule) return G.wasmModule; } catch (e2) {}
    return null;
  }
  // 探针：{ seqPtr, mark?, pumpMs? } → { useSysTimer, tick, ts, pumped }
  G.__fuProbe2 = function (_synth, param) {
    var M = wasm();
    if (!M) return { err: 'no wasmModule' };
    if (param && param.mark) {
      if (!G.__fuTapCfg) G.__fuTapCfg = {};
      G.__fuTapCfg.mark = param.mark;
      if (param.seqPtr) G.__fuTapCfg.seqPtr = param.seqPtr;
    }
    var seqPtr = param && param.seqPtr;
    var out = { hasM: true, ts: Date.now() };
    try { out.useSysTimer = M._fluid_sequencer_get_use_system_timer(seqPtr); } catch (e) { out.useSysTimerErr = String(e).slice(0, 60); }
    try { out.tick = M._fluid_sequencer_get_tick(seqPtr); } catch (e2) { out.tickErr = String(e2).slice(0, 60); }
    try { out.tickInternal = G.__fuSeqClockState ? M._fluid_sequencer_get_tick(G.__fuSeqClockState.seqPtr) : null; } catch (e3) {}
    if (param && param.pumpMs) {
      try { M._fluid_sequencer_process(seqPtr, param.pumpMs); out.pumped = param.pumpMs; } catch (e4) { out.pumpErr = String(e4).slice(0, 60); }
    }
    return out;
  };

  if (typeof G.registerProcessor !== 'function' || typeof G.AudioWorkletProcessor !== 'function') return;
  function FuTapRec() {
    var sr = 48000;
    try { sr = sampleRate; } catch (e) {}
    this.sr = sr;
    this.len = sr * 14;
    this.buf = new Float32Array(this.len);
    this.pos = 0;
    this.total = 0;
    this.procCount = 0;
    this.lastReport = 0;
    var self = this;
    this.port.onmessage = function (e) {
      var d = e.data || {};
      if (d.cmd === 'dump') {
        var sec = d.sec || 4;
        var n = Math.min(self.len, Math.floor(sr * sec));
        var out = new Float32Array(n);
        for (var i = 0; i < n; i++) out[i] = self.buf[(self.pos - n + i + self.len * 2) % self.len];
        self.port.postMessage({ total: self.total, sr: sr, data: out }, [out.buffer]);
      } else if (d.cmd === 'stats') {
        self.port.postMessage({ stats: { total: self.total, procCount: self.procCount, mark: G.__fuTapCfg ? G.__fuTapCfg.mark : null, markOk: !!(G.__fuTapCfg && G.__fuTapCfg.mark === 777), hasM: !!wasm(), seqCfg: G.__fuTapCfg ? { seqPtr: G.__fuTapCfg.seqPtr || null, pump: !!G.__fuTapCfg.pump, lastFrame: G.__fuTapCfg.lastFrame || null } : null } });
      }
    };
  }
  FuTapRec.prototype.process = function (inputs) {
    this.procCount++;
    var G2 = G;
    // 线程内可选泵动：__fuTapCfg 由主线程经 callFunction 写入（仅当 tap 与合成器同线程时安全）
    var cfg = G2.__fuTapCfg;
    var M = wasm();
    if (cfg && M && cfg.seqPtr && cfg.pump) {
      var now = 0, rate = 0;
      try { now = currentFrame; rate = sampleRate; } catch (e) {}
      if (now && cfg.lastFrame != null && now !== cfg.lastFrame) {
        var el = (now - cfg.lastFrame) / (rate || 48000) * 1000;
        cfg.lastFrame = now;
        if (el > 0 && el < 500) { try { M._fluid_sequencer_process(cfg.seqPtr, el); } catch (e2) {} }
      } else if (!cfg.lastFrame) {
        cfg.lastFrame = now;
      }
    }
    var inp = inputs[0];
    var i;
    if (inp && inp[0] && inp[0].length) {
      var ch = inp[0];
      for (i = 0; i < ch.length; i++) { this.buf[this.pos] = ch[i]; this.pos = (this.pos + 1) % this.len; this.total++; }
    } else {
      for (i = 0; i < 128; i++) { this.buf[this.pos] = 0; this.pos = (this.pos + 1) % this.len; this.total++; }
    }
    return true;
  };
  try { G.registerProcessor('fu-tap-rec', FuTapRec); } catch (e) {}
})(globalThis);
