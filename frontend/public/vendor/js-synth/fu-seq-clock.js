/* FuFumidi 音序器时钟（在 AudioWorkletGlobalScope 内运行）
 * 由渲染器通过 audioWorklet.addModule 加载；synth.js 用 callFunction('__fuSeqClockStart', { seqPtr }) 启动。
 * 目的：fluid_sequencer 的时钟在 worklet 音频线程按真实流逝毫秒数推进，
 * 渲染器主线程阻塞（切页 / 乐谱重绘）不影响音序事件（noteon/noteoff）的准时分发。
 *
 * 实现说明：AudioWorkletGlobalScope 没有 setTimeout/setInterval（worklet 无定时器 API），
 * 因此注册一个 numberOfOutputs=0 的常驻 AudioWorkletProcessor（'fu-seq-clock'），
 * 渲染器侧创建该节点后，其 process() 在每个渲染量子（约 2.7ms@48kHz）被音频线程调用，
 * 用 currentFrame 差值换算毫秒并调用 fluid_sequencer_process(seqPtr, elapsedMs)。 */
(function (G) {
  'use strict';
  function scope() {
    // libfluidsynth worklet 构建把 WASM 模块挂在 AudioWorkletGlobalScope.wasmModule；
    // 本脚本所在模块的 globalThis 与 AudioWorkletGlobalScope 不保证同一对象，做双保险
    try {
      if (typeof AudioWorkletGlobalScope !== 'undefined' && AudioWorkletGlobalScope.wasmModule) return AudioWorkletGlobalScope;
    } catch (e) {}
    return G;
  }
  // 诊断探针：返回 worklet 内 WASM 模块可见性（经 callFunction 返回值链路回传）
  G.__fuSeqProbe = function () {
    var S = scope();
    var M = S.wasmModule;
    return {
      hasM: !!M,
      procType: M ? typeof M._fluid_sequencer_process : 'no-module',
      keys: M ? Object.keys(M).filter(function (k) { return k.indexOf('sequencer') >= 0; }).slice(0, 10) : [],
      scopeIsGlobal: S === G,
      hasRegisterProcessor: typeof G.registerProcessor === 'function',
      procCount: G.__fuSeqProcCount || 0,
      state: G.__fuSeqClockState ? { seqPtr: G.__fuSeqClockState.seqPtr, lastFrame: G.__fuSeqClockState.lastFrame, lastTs: G.__fuSeqClockState.lastTs } : null,
      rawTick: (function () { try { var st2 = G.__fuSeqClockState; return st2 && M ? M._fluid_sequencer_get_tick(st2.seqPtr) : -1; } catch (e) { return -2; } })(),
    };
  };
  G.__fuSeqClockStop = function () {
    G.__fuSeqClockState = null;
    return true;
  };
  // 注册待驱动的音序器；真正的推进由下方 FuSeqClockProcessor.process() 完成
  G.__fuSeqClockStart = function (_synth, param) {
    try {
      var M = scope().wasmModule;
      var seqPtr = param && param.seqPtr;
      if (!M || typeof seqPtr !== 'number' || typeof M._fluid_sequencer_process !== 'function') return false;
      if (typeof G.registerProcessor !== 'function') return false;
      var f0 = 0;
      try { f0 = currentFrame; } catch (e) {} // worklet 全局裸标识符（globalThis 上不可见）
      G.__fuSeqClockState = { seqPtr: seqPtr, lastFrame: f0, lastTs: Date.now() };
      return true;
    } catch (e) { return false; }
  };

  // 常驻时钟节点：1 输出经零增益接 destination，process() 返回 true 保持调度
  if (typeof G.registerProcessor === 'function' && typeof G.AudioWorkletProcessor === 'function') {
    var FuSeqClockProcessor = function () {
      this._M = scope().wasmModule || null;
    };
    FuSeqClockProcessor.prototype.process = function () {
      G.__fuSeqProcCount = (G.__fuSeqProcCount || 0) + 1;
      var st = G.__fuSeqClockState;
      if (st && this._M) {
        var now = 0, rate = 0;
        try { now = currentFrame; rate = sampleRate; } catch (e) {} // 裸标识符；globalThis 上不可见
        if (now && st.lastFrame != null && now !== st.lastFrame) {
          var el = (now - st.lastFrame) / (rate || 48000) * 1000;
          st.lastFrame = now;
          st.lastTs = Date.now();
          if (el > 0 && el < 500) { try { this._M._fluid_sequencer_process(st.seqPtr, el); } catch (e2) {} }
        } else {
          // currentFrame 不可用时退化为真实时间差
          var ts = Date.now();
          var el2 = ts - (st.lastTs || ts);
          st.lastTs = ts;
          if (el2 > 0 && el2 < 500) { try { this._M._fluid_sequencer_process(st.seqPtr, el2); } catch (e3) {} }
        }
      }
      return true;
    };
    try { G.registerProcessor('fu-seq-clock', FuSeqClockProcessor); } catch (e) {}
  }
})(globalThis);
