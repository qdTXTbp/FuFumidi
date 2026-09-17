// 音效链 + 倍速量纲 的端到端验证（宿主机本地应用，CDP 9222）
//
// A 音效：开着音效不应静音、也不应比关着响一倍（重复干路），且 EQ 增益要真的起作用
// B 倍速：速度倍率与界面同向；播放时间文本与歌曲时间轴同量纲
//
// 用法：$env:CDP_PORT='9222'; node cdp-fx-tempo.cjs
'use strict';
const http = require('http');
const PORT = Number(process.env.CDP_PORT || 9222);

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, (r) => {
      let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve(JSON.parse(b)));
    });
    req.on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const targets = await getJson('/json');
  const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
  if (!page) throw new Error('找不到渲染进程页面');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  await send('Runtime.enable');
  const ev = async (expr, timeout = 120000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
      sleep(timeout).then(() => null),
    ]);
    if (!r) return { __timeout: true };
    if (r.result && r.result.exceptionDetails) return { __err: (r.result.exceptionDetails.exception || {}).description };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const STORE = `document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')`;

  let pass = 0, fail = 0;
  const check = (n, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + n + (d ? '  [' + d + ']' : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '  [' + d + ']' : '')); } };

  // 分析器读数（应用自己的 analyser：长期存在且在通往 destination 的链路上，可信）
  const PROBE = `(() => {
    const a = window.__fufumidiActivePlayer.syn.analyser;
    const td = new Uint8Array(a.fftSize);
    a.getByteTimeDomainData(td);
    let mn = 255, mx = 0, s2 = 0;
    for (let i = 0; i < td.length; i++) {
      if (td[i] < mn) mn = td[i]; if (td[i] > mx) mx = td[i];
      const v = (td[i] - 128) / 128; s2 += v * v;
    }
    return { min: mn, max: mx, rms: +Math.sqrt(s2 / td.length).toFixed(4) };
  })()`;

  try {
    console.log('\n=== 0. 准备（普通曲目，先关掉音效）===');
    const r0 = await ev(`(async () => {
      const st = ${STORE};
      if (st.playing) st.togglePlay();
      await new Promise(r => setTimeout(r, 300));
      const pick = st.songs.find(s => s.name && !/large-60k/i.test(s.name));
      if (!pick) return { err: '没有曲目' };
      await st.selectSong(pick.id);
      await new Promise(r => setTimeout(r, 1500));
      const syn = window.__fufumidiActivePlayer.syn;
      syn.setFxEnabled(false);
      syn.setEqGains([0,0,0,0,0,0,0,0,0,0]);
      syn.setBassBoost(0);
      syn.setSpatial(0);
      if (!st.playing) st.togglePlay();
      return { song: pick.name };
    })()`, 180000);
    console.log('  曲目: ' + JSON.stringify(r0));
    if (!r0 || r0.err) throw new Error('准备失败: ' + JSON.stringify(r0));
    await sleep(3500);

    console.log('\n=== A. 音效链 ===');
    const off = await ev(PROBE);
    console.log('  音效关闭: ' + JSON.stringify(off));
    check('音效关闭时正常发声（基线）', !!(off && off.rms > 0.02), 'rms=' + (off && off.rms));

    await ev(`(() => { window.__fufumidiActivePlayer.syn.setFxEnabled(true); return true; })()`);
    await sleep(1500);
    const on = await ev(PROBE);
    console.log('  音效开启（全部增益为 0）: ' + JSON.stringify(on));
    check('开启音效不再静音（本次核心）', !!(on && on.rms > 0.02), 'rms=' + (on && on.rms));
    // 注意：这里两次读数取自播放中的不同时刻，音乐自身响度在变，比值不可用作电平判据。
    // 「开关音效电平一致 / 无并联干路 +6dB」由 cdp-fx-gain.cjs 用固定测试音做时对齐测量。

    // 把 EQ 低频整体 +12dB，响度应可测地变大 —— 证明均衡器真的在信号链上
    await ev(`(() => { window.__fufumidiActivePlayer.syn.setEqGains([12,12,12,12,6,0,0,0,0,0]); return true; })()`);
    await sleep(1500);
    const boosted = await ev(PROBE);
    console.log('  EQ 低频 +12dB: ' + JSON.stringify(boosted));
    check('均衡器真实生效（低频增益提升后响度变大）',
      !!(boosted && on && boosted.rms > on.rms * 1.05), 'rms ' + (on && on.rms) + ' → ' + (boosted && boosted.rms));

    // 低音增强 + 空间声也不应把声音搞没
    await ev(`(() => {
      const s = window.__fufumidiActivePlayer.syn;
      s.setEqGains([0,0,0,0,0,0,0,0,0,0]); s.setBassBoost(8); s.setSpatial(0.8);
      return true;
    })()`);
    await sleep(1500);
    const xrow = await ev(PROBE);
    console.log('  低音增强 8 + 空间声 0.8: ' + JSON.stringify(xrow));
    check('低音增强 / 空间声 开启后仍有声且不过分异常',
      !!(xrow && xrow.rms > 0.02 && xrow.rms < 1.6), 'rms=' + (xrow && xrow.rms));

    // 关回去
    await ev(`(() => {
      const s = window.__fufumidiActivePlayer.syn;
      s.setFxEnabled(false); s.setEqGains([0,0,0,0,0,0,0,0,0,0]); s.setBassBoost(0); s.setSpatial(0);
      return true;
    })()`);
    await sleep(1500);
    const back = await ev(PROBE);
    console.log('  关回去: ' + JSON.stringify(back));
    check('关掉音效后恢复正常', !!(back && back.rms > 0.02), 'rms=' + (back && back.rms));

    console.log('\n=== B. 倍速与时间量纲 ===');
    const measure = async (tempo) => {
      return await ev(`(async () => {
        const st = ${STORE};
        st.setTempo(${tempo});
        await new Promise(r => setTimeout(r, 600));
        const P = window.__fufumidiActivePlayer;
        if (!st.playing) st.togglePlay();
        await new Promise(r => setTimeout(r, 600));
        const t0 = P.currentTick(), w0 = P.ctx.currentTime, s0 = P.currentSec();
        await new Promise(r => setTimeout(r, 3000));
        const t1 = P.currentTick(), w1 = P.ctx.currentTime, s1 = P.currentSec();
        const song = st.currentSong.song;
        const dSong = song.baseSec(t1) - song.baseSec(t0);
        return {
          tempo: ${tempo}, scale: +P.scale.toFixed(4),
          wallSec: +(w1 - w0).toFixed(2), songSec: +dSong.toFixed(2),
          ratio: +(dSong / (w1 - w0)).toFixed(3),
          curSecDelta: +(s1 - s0).toFixed(2),
        };
      })()`, 180000);
    };
    const m1 = await measure(1);
    const m2 = await measure(2);
    const mHalf = await measure(0.5);
    console.log('  1x  : ' + JSON.stringify(m1));
    console.log('  2x  : ' + JSON.stringify(m2));
    console.log('  0.5x: ' + JSON.stringify(mHalf));

    check('1x 为原速', !!(m1 && Math.abs(m1.ratio - 1) < 0.08), '倍率 ' + (m1 && m1.ratio));
    check('界面「加速」到 2x → 实际速度 2 倍（方向修复）', !!(m2 && Math.abs(m2.ratio - 2) < 0.15),
      '倍率 ' + (m2 && m2.ratio) + '（修复前为 0.5）');
    check('界面「减速」到 0.5x → 实际速度一半', !!(mHalf && Math.abs(mHalf.ratio - 0.5) < 0.08),
      '倍率 ' + (mHalf && mHalf.ratio) + '（修复前为 2）');
    check('内部时间倍率是速度倍率的倒数', !!(m2 && Math.abs(m2.scale - 0.5) < 1e-6), 'scale=' + (m2 && m2.scale));

    check('播放时间文本按歌曲时间轴推进（2x 时与歌曲时间一致，不再翻倍）',
      !!(m2 && Math.abs(m2.curSecDelta - m2.songSec) < Math.max(0.25, m2.songSec * 0.1)),
      '时间文本走了 ' + (m2 && m2.curSecDelta) + 's / 歌曲实际走了 ' + (m2 && m2.songSec) + 's');

    await ev(`(() => { ${STORE}.setTempo(1); return true; })()`);
    console.log('\n===== 汇总：PASS ' + pass + ' / FAIL ' + fail + ' =====');
  } finally {
    try { ws.close(); } catch (e) {}
  }
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('异常: ' + (e && e.message)); process.exit(2); });
