// 音效链增益的**时对齐**测量：用固定幅度的测试音代替音乐，前后在同一信号上比较。
// （上一版探针拿播放中的音乐在两个时刻比 rms，音乐自身响度波动会盖过链路增益，
//   数据里「关回去反而更响」就说明那个比值不可信。）
'use strict';
const http = require('http');
const PORT = Number(process.env.CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = list.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  await send('Runtime.enable');
  const ev = async (expr, t = 120000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }), sleep(t).then(() => null)]);
    if (!r) return { __timeout: true };
    if (r.result && r.result.exceptionDetails) return { __err: (r.result.exceptionDetails.exception || {}).description };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  const out = await ev(`(async () => {
    const st = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // 先让音频初始化（ensureAudio 由播放/选曲触发）
    if (!window.__fufumidiActivePlayer) {
      const pick = st.songs.find(s => s.name && !/large-60k/i.test(s.name));
      await st.selectSong(pick.id);
      await sleep(500);
    }
    const syn = window.__fufumidiActivePlayer.syn;
    const ctx = syn.ctx;
    if (st.playing) st.togglePlay();
    await sleep(600);

    const rms = () => {
      const td = new Uint8Array(syn.analyser.fftSize);
      syn.analyser.getByteTimeDomainData(td);
      let s2 = 0;
      for (let i = 0; i < td.length; i++) { const v = (td[i] - 128) / 128; s2 += v * v; }
      return Math.sqrt(s2 / td.length);
    };
    // 连读多次取中位，抵消分析器缓冲窗口内的相位抖动
    const measure = async () => {
      const a = [];
      for (let i = 0; i < 12; i++) { await sleep(60); a.push(rms()); }
      a.sort((x, y) => x - y);
      return +a[6].toFixed(5);
    };

    // 固定幅度的持续测试音（440Hz，直接灌进 master，绕过合成器的音符调度）
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = 440; g.gain.value = 0.25;
    o.connect(g); g.connect(syn.master); o.start();
    await sleep(500);

    const res = {};
    syn.setEqGains([0,0,0,0,0,0,0,0,0,0]); syn.setBassBoost(0); syn.setSpatial(0);
    syn.setFxEnabled(false); await sleep(500);
    res.fxOff = await measure();

    syn.setFxEnabled(true); await sleep(500);
    res.fxOn = await measure();
    res.ratioOnOff = +(res.fxOn / Math.max(1e-9, res.fxOff)).toFixed(3);

    // 均衡器：500Hz 与 1kHz 各 +12dB（测试音 440Hz 落在 500Hz 那段附近）
    syn.setEqGains([0,0,0,12,12,0,0,0,0,0]); await sleep(700);
    res.eqBoost = await measure();
    res.ratioEq = +(res.eqBoost / Math.max(1e-9, res.fxOn)).toFixed(3);

    // 低音增强（120Hz lowshelf）对 440Hz 影响很小，改测 60Hz 的音
    syn.setEqGains([0,0,0,0,0,0,0,0,0,0]);
    o.frequency.value = 60; syn.setBassBoost(0); await sleep(700);
    res.bassOff = await measure();
    syn.setBassBoost(12); await sleep(700);
    res.bassOn = await measure();
    res.ratioBass = +(res.bassOn / Math.max(1e-9, res.bassOff)).toFixed(3);

    // 空间声：s=0 与 s=1 的单调性不该把总电平搞崩
    o.frequency.value = 440; syn.setBassBoost(0); syn.setSpatial(0); await sleep(700);
    res.spat0 = await measure();
    syn.setSpatial(1); await sleep(700);
    res.spat1 = await measure();
    res.ratioSpatial = +(res.spat1 / Math.max(1e-9, res.spat0)).toFixed(3);

    o.stop(); syn.setSpatial(0); syn.setFxEnabled(false);
    await sleep(300);
    return res;
  })()`);
  console.log(JSON.stringify(out, null, 2));

  const ok = out && !out.__err && !out.__timeout;
  let pass = 0, fail = 0;
  const check = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n + (d ? '  [' + d + ']' : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '  [' + d + ']' : '')); } };
  if (ok) {
    console.log('');
    check('开音效后仍有声（不再静音）', out.fxOn > 0.001, 'rms=' + out.fxOn);
    check('开/关音效电平一致（无重复干路的 +6dB 翻倍）',
      out.ratioOnOff > 0.85 && out.ratioOnOff < 1.18, '比值 ' + out.ratioOnOff);
    check('均衡器真实串在信号链上（+12dB 后明显变响）', out.ratioEq > 1.5, '比值 ' + out.ratioEq);
    check('低音增强真实生效（60Hz 提升后变响）', out.ratioBass > 1.2, '比值 ' + out.ratioBass);
    check('空间声不破坏总电平', out.ratioSpatial > 0.6 && out.ratioSpatial < 1.7, '比值 ' + out.ratioSpatial);
  } else {
    console.log('探针执行失败: ' + JSON.stringify(out));
    fail++;
  }
  console.log('\n===== PASS ' + pass + ' / FAIL ' + fail + ' =====');
  try { ws.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('异常: ' + e.message); process.exit(2); });
