// 空间声（mid/side 展宽）的声道级测量。
// 关键：判定「居中信号不受影响」必须让 L 与 R 是**同一路信号**（同源、同频、同相），
// 否则 L-R 不为 0，展宽本来就该动它（先前用两个不同频率的振荡器测「居中」是无效的）。
// 测量点：音效链出口 fxOut（展宽级之后），用 ChannelSplitter 分左右各读时域 rms。
// 预期（s = 展宽量，base = 单侧输入电平）：
//   居中：L'=R'=base（不变）
//   硬左：L'=1.5*base、R'=0.5*base（R/L = 1/3）
//   硬右：R'=1.5*base、L'=0.5*base（L/R = 1/3）
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const player = window.__fufumidiActivePlayer;
  const syn = player && player.syn;
  if (!syn) return { err: '拿不到 synth' };
  const ctx = syn.ctx;
  if (player.playing) player.pause();
  await sleep(300);

  const wasFx = syn.fxEnabled === true;
  syn.setFxEnabled(true);

  const sp = ctx.createChannelSplitter(2);
  syn.fxOut.connect(sp);
  const mk = () => { const a = ctx.createAnalyser(); a.fftSize = 4096; a.channelCount = 1; a.channelCountMode = 'explicit'; a.channelInterpretation = 'speakers'; return a; };
  const aL = mk(), aR = mk();
  sp.connect(aL, 0); sp.connect(aR, 1);
  const bufL = new Float32Array(aL.fftSize), bufR = new Float32Array(aR.fftSize);
  const rms = (a, buf) => { a.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return Math.sqrt(s / buf.length); };

  // 单路正弦，通过两个增益决定进左/进右（同一路信号 ⇒ 居中时 L 与 R 完全相同）
  const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = 440;
  const gL = ctx.createGain(), gR = ctx.createGain();
  gL.gain.value = 0; gR.gain.value = 0;
  const merger = ctx.createChannelMerger(2);
  osc.connect(gL); gL.connect(merger, 0, 0);
  osc.connect(gR); gR.connect(merger, 0, 1);
  merger.connect(syn.master);
  osc.start(ctx.currentTime + 0.05);

  const base = 0.25;
  const rows = [];
  const sample = async (label, spatial, l, r) => {
    gL.gain.value = l ? base : 0; gR.gain.value = r ? base : 0;
    syn.setSpatial(spatial);
    await sleep(500);
    const L = rms(aL, bufL), R = rms(aR, bufR);
    // 以 s=0 时单侧的电平为 1.0 基准（实测：0.25 输入 → 约 0.150）
    rows.push({ label, spatial, inL: l ? base : 0, inR: r ? base : 0, outL: +L.toFixed(5), outR: +R.toFixed(5), Lnorm: +(L / 0.15025).toFixed(3), Rnorm: +(R / 0.15025).toFixed(3) });
  };
  await sample('居中 s=0', 0, 1, 1);
  const centerBase = rows[0].outL;
  await sample('居中 s=1', 1, 1, 1);
  await sample('硬左 s=0', 0, 1, 0);
  await sample('硬左 s=1', 1, 1, 0);
  await sample('硬右 s=0', 0, 0, 1);
  await sample('硬右 s=1', 1, 0, 1);
  await sample('居中 s=0（回零）', 0, 1, 1);

  osc.stop();
  try { merger.disconnect(); } catch (e) {}
  try { gL.disconnect(); gR.disconnect(); } catch (e) {}
  syn.setSpatial(0);
  syn.setFxEnabled(wasFx);
  await sleep(200);
  try { syn.fxOut.disconnect(sp); sp.disconnect(); } catch (e) {}

  const [c0, c1, hl0, hl1, hr0, hr1, c2] = rows;
  return {
    rows,
    verdicts: {
      '居中信号展宽后应完全不变（不变式）': { s0_L: c0.outL, s1_L: c1.outL, s1_R: c1.outR, deltaPct: +(((c1.outL / c0.outL) - 1) * 100).toFixed(2), LR差: Math.abs(c1.outL - c1.outR) < 1e-4 },
      's=0 时不改变原声（零处理）': { 回零一致: Math.abs(c2.outL - c0.outL) < 1e-4, c0: c0.outL, c2: c2.outL },
      '硬左 s=1：本侧 1.5×、对侧 0.5×': { Lnorm: hl1.Lnorm, Rnorm: hl1.Rnorm, 期望: [1.5, 0.5] },
      '硬右 s=1：本侧 1.5×、对侧 0.5×（左右必须对称）': { Rnorm: hr1.Rnorm, Lnorm: hr1.Lnorm, 期望: [1.5, 0.5] },
      '硬声声像在 s=0 时对侧静音（分离度完整）': { 硬左_idleRight: hl0.outR, 硬右_idleLeft: hr0.outL },
    },
  };
})()
