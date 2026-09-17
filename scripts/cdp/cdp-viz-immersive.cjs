// 可视化「沉浸模式 + 瀑布流纵深」的端到端验证（宿主机本地应用，CDP 9222）
//
// 覆盖：
//   B  6 万音符大曲目下的单帧绘制调用数（窗口裁剪是否真的生效）
//   C  琴键配色是否跟随主题（浅色 / 专业工作站）
//   D  缩放是否只作用在可视音域（放大后画面不再被横向裁掉）
//   E  沉浸模式：周边三栏隐去 + HUD 出现 + 静止 3 秒淡出 + 退出后如实恢复
//   F  播放时的音乐能量是否拿到非 0 值
//
// 用法：$env:CDP_PORT='9222'; node cdp-viz-immersive.cjs
// 极密压力曲目（60000 音符 / 约 160 音符每秒）由 CDP_MIDI 指定；本仓库不含该二进制样本，
// 用任意 ≥100 音符/秒的 MIDI 替代即可（断言看的是密度量级，不是具体文件）。
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const PORT = Number(process.env.CDP_PORT || 9222);
const MIDI = process.env.CDP_MIDI || path.join(__dirname, 'large-60k.mid');
// 报告写到 CDP_OUT_DIR（默认脚本所在目录）
const OUT_DIR = process.env.CDP_OUT_DIR || __dirname;
const STORE = `document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')`;

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, (r) => {
      let b = ''; r.on('data', (c) => (b += c));
      r.on('end', () => resolve(JSON.parse(b)));
    });
    req.on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const targets = await getJson('/json');
  const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
  if (!page) throw new Error('找不到渲染进程页面');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  return { ws, send };
}

function makeEval(send) {
  return async (expr, timeout = 60000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
      sleep(timeout).then(() => null),
    ]);
    if (!r) return { __timeout: true };
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      return { __err: (d.exception && d.exception.description) || d.text };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
}

const out = [];
function log(label, v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  out.push(label + ' : ' + s);
  console.log(label + ' : ' + s);
}

async function main() {
  const { ws, send } = await connect();
  const ev = makeEval(send);
  let pass = 0, fail = 0;
  const check = (name, ok, detail) => {
    if (ok) { pass++; console.log('  PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
  };

  try {
    /* ---------- 0. 装 6 万音符曲目并进入可视化页 ---------- */
    console.log('\n=== 0. 准备大曲目 ===');
    const rLoad = await ev(`(async () => {
      const st = ${STORE};
      let it = st.songs.find(s => s.name === 'large-60k');
      if (!it) {
        const buf = await window.fuBridge.readBinary(${JSON.stringify(MIDI)});
        await st.importFiles([{ name: 'large-60k.mid', bytes: buf }]);
        it = st.songs.find(s => s.name === 'large-60k');
      }
      if (!it) return { err: '导入后仍找不到曲目' };
      await st.selectSong(it.id);
      return { id: it.id, songs: st.songs.length, tracks: it.song ? it.song.tracks.length : 0,
               notes: it.song ? it.song.tracks.reduce((a, t) => a + t.notes.length, 0) : 0 };
    })()`, 180000);
    log('曲目', rLoad);
    if (!rLoad || rLoad.err || !rLoad.notes) throw new Error('大曲目未就绪：' + JSON.stringify(rLoad));

    await ev(`(location.hash = '#/views?tab=viz', true)`);
    await sleep(1500);
    const rPage = await ev(`(() => {
      const cv = document.getElementById('vizRoll');
      return { roll: !!cv, cw: cv && cv.clientWidth, ch: cv && cv.clientHeight, view: ${STORE}.view };
    })()`);
    log('可视化页', rPage);
    check('可视化页已挂载 #vizRoll', !!(rPage && rPage.roll), JSON.stringify(rPage));

    /* ---------- 1. 帧内绘制调用探针 ---------- */
    await ev(`(() => {
      if (!window.__vizProbe) {
        const P = CanvasRenderingContext2D.prototype;
        const origRect = P.roundRect, origFill = P.fillRect;
        window.__vizProbe = { on: false, rects: 0, fills: 0, maxRight: 0, frames: [], cvW: 0 };
        P.roundRect = function (x, y, w, h) {
          const p = window.__vizProbe;
          if (p.on) { p.rects++; if (x + w > p.maxRight) p.maxRight = x + w; }
          return origRect.apply(this, arguments);
        };
        P.fillRect = function (x, y, w, h) {
          const p = window.__vizProbe;
          if (p.on) p.fills++;
          return origFill.apply(this, arguments);
        };
        const loop = () => {
          const p = window.__vizProbe;
          if (p.on) {
            const last = p.last || { rects: p.rects, fills: p.fills, t: performance.now() };
            p.frames.push({ dr: p.rects - last.rects, df: p.fills - last.fills, ms: performance.now() - last.t });
            p.last = { rects: p.rects, fills: p.fills, t: performance.now() };
          }
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      }
      const cv = document.getElementById('vizRoll');
      const p = window.__vizProbe;
      p.on = true; p.rects = 0; p.fills = 0; p.maxRight = 0; p.frames = []; p.last = null; p.cvW = cv ? cv.width : 0;
      return true;
    })()`);

    /* ---------- 2. 播放 + 采样（B 项） ---------- */
    console.log('\n=== B. 6 万音符：单帧绘制调用数 / 帧间隔 ===');
    await ev(`(async () => { const st = ${STORE}; if (!st.playing) st.togglePlay(); return st.playing; })()`);
    await sleep(3000);
    const rPerf = await ev(`(() => {
      const p = window.__vizProbe;
      p.on = false;
      const vizFrames = p.frames.filter(f => f.dr > 0);
      const dr = vizFrames.map(f => f.dr).sort((a, b) => a - b);
      const ms = vizFrames.map(f => f.ms).sort((a, b) => a - b);
      const q = (a, r) => a.length ? +a[Math.min(a.length - 1, Math.floor(a.length * r))].toFixed(1) : 0;
      return { totalNotes: 60000, probeFrames: p.frames.length, vizFrames: vizFrames.length,
               rectsPerFrame: { max: dr.length ? dr[dr.length - 1] : 0, p50: q(dr, 0.5), p95: q(dr, 0.95) },
               fillsPerFrame: { max: Math.max(0, ...p.frames.map(f => f.df)) },
               frameMs: { p50: q(ms, 0.5), p95: q(ms, 0.95), max: q(ms, 0.999) },
               energy: +(${STORE}.ui ? 0 : 0) };
    })()`);
    log('绘制调用', rPerf);
    if (rPerf && rPerf.rectsPerFrame) {
      check('瀑布每帧绘制调用数远小于全曲音符数', rPerf.rectsPerFrame.p95 < 3000,
        'p95=' + rPerf.rectsPerFrame.p95 + ' / 60000 音符');
      check('帧间隔 p95 未出现明显卡顿（<40ms）', rPerf.frameMs.p95 < 40, 'p95=' + rPerf.frameMs.p95 + 'ms');
    }

    /* ---------- 3. 能量（F 项） ---------- */
    // 注意：用普通曲目验证。large-60k 是极端密度压力文件（160 音符/秒），
    // 在这个环境里它本身就不出声（分析器读到纯静音，与本次改动无关），
    // 拿它验证能量只会得到假阴性。
    const rSwitch = await ev(`(async () => {
      const st = ${STORE};
      if (st.playing) st.togglePlay();
      await new Promise(r => setTimeout(r, 300));
      // 曲目的 song 是懒解析的，未选中的曲目 song 为 null —— 不能按 song 过滤
      const pick = st.songs.find(s => s.name && !/large-60k/i.test(s.name));
      if (!pick) return { err: '没有其他曲目' };
      await st.selectSong(pick.id);
      await new Promise(r => setTimeout(r, 1500));
      location.hash = '#/views?tab=viz';
      await new Promise(r => setTimeout(r, 800));
      const cur = st.currentSong;
      const notes = cur && cur.song ? cur.song.tracks.reduce((a, t) => a + t.notes.length, 0) : 0;
      if (!st.playing) st.togglePlay();
      return { name: pick.name, notes };
    })()`, 120000);
    log('切到普通曲目', rSwitch);
    await sleep(4500);
    const rEnergy = await ev(`(() => {
      const st = ${STORE};
      const cv = document.getElementById('vizRoll');
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth, h = cv.clientHeight;
      const x = Math.min(120, Math.round(0.2 * h));
      const wN = Math.floor(h - x);
      const g = cv.getContext('2d');
      const d = g.getImageData(Math.round(w * 0.5 * dpr), Math.round(wN * 0.06 * dpr), 1, 1).data;
      return {
        playing: st.playing,
        ctxState: window.__fufumidiActivePlayer ? window.__fufumidiActivePlayer.syn.ctx.state : null,
        energy: +(window.__fufumidiVizEnergy || 0).toFixed(4),
        rollTopPixel: [d[0], d[1], d[2]],
      };
    })()`);
    log('播放中能量', rEnergy);
    check('播放时能量非 0（背景随音乐脉动生效）', !!(rEnergy && rEnergy.energy > 0.01), 'energy=' + (rEnergy && rEnergy.energy));
    await ev(`(async () => { const st = ${STORE}; if (st.playing) st.togglePlay(); return true; })()`);
    await sleep(3000);
    const rEnergyIdle = await ev(`+(window.__fufumidiVizEnergy || 0).toFixed(4)`);
    log('暂停后能量（应收敛到接近 0）', rEnergyIdle);
    check('暂停后能量回落（包络有收音）',
      typeof rEnergyIdle === 'number' && rEnergyIdle < (rEnergy.energy || 1) * 0.5,
      'playing=' + (rEnergy && rEnergy.energy) + ' idle=' + rEnergyIdle);

    // 换回大曲目，后续的渲染类断言都跑在它上面
    await ev(`(async () => {
      const st = ${STORE};
      const it = st.songs.find(s => s.name === 'large-60k');
      if (it) await st.selectSong(it.id);
      location.hash = '#/views?tab=viz';
      return true;
    })()`, 120000);
    await sleep(2000);
    // 重新挂探针（切歌会重绘，探针对象仍在但计数被重置）
    await ev(`(() => { const p = window.__vizProbe; p.rects = 0; p.maxRight = 0; return true; })()`);

    /* ---------- 4. 缩放语义（D 项） ---------- */
    console.log('\n=== D. 缩放作用在可视音域，而不是把画面横向裁掉 ===');
    // 旧实现是 g = w/52*zoom（把琴键拉宽），zoom=3 时最右的音符块可到 ~3 倍画布宽；
    // 新实现把 zoom 作用在可视音域上，任何绘制都不该越出画布右边界。
    const rZoomMax = await ev(`(() => {
      const btns = [...document.querySelectorAll('.vc-head .chip-btn')];
      const plus = btns.find(b => b.textContent.trim() === '+');
      if (!plus) return { err: '找不到放大按钮' };
      for (let i = 0; i < 25; i++) plus.click();
      return { clicked: true };
    })()`);
    await sleep(900); // Vue 的 DOM 更新是异步的，等一拍再读标签
    const rZoomLabel = await ev(`document.querySelector('.vc-zoom').textContent.trim()`);
    log('放大后标签', { rZoomMax, rZoomLabel });
    check('放大按钮把缩放推到 300%（确认本项测试真的在放大态下进行）', rZoomLabel === '300%', String(rZoomLabel));

    const rClip = await ev(`(() => {
      const p = window.__vizProbe;
      p.rects = 0; p.maxRight = 0; p.on = true;
      return new Promise(res => setTimeout(() => {
        const cv = document.getElementById('vizRoll');
        const dpr = window.devicePixelRatio || 1;
        p.on = false;
        res({ maxRightCss: +(p.maxRight / dpr).toFixed(1), canvasCssW: cv.clientWidth, rects: p.rects, dpr });
      }, 2000));
    })()`);
    log('放大后的绘制范围', rClip);
    if (rClip && rClip.canvasCssW) {
      check('放大后无绘制超出画布右边界', rClip.maxRightCss <= rClip.canvasCssW * 1.05,
        '最右 ' + rClip.maxRightCss + 'px / 画布 ' + rClip.canvasCssW + 'px');
    }
    // 复位并确认下限：3.0 → 30 次 −0.1 足以触到 0.4 的钳位
    await ev(`(() => {
      const btns = [...document.querySelectorAll('.vc-head .chip-btn')];
      const minus = btns.find(b => b.textContent.trim() === '−');
      for (let i = 0; i < 30; i++) minus.click();
      return true;
    })()`);
    await sleep(700);
    const rZoomBack = await ev(`document.querySelector('.vc-zoom').textContent.trim()`);
    check('缩小按钮可回到 40%（下限）', rZoomBack === '40%', String(rZoomBack));
    await ev(`(() => {
      const btns = [...document.querySelectorAll('.vc-head .chip-btn')];
      const plus = btns.find(b => b.textContent.trim() === '+');
      for (let i = 0; i < 6; i++) plus.click();
      return true;
    })()`);
    await sleep(700);
    const rZoom100 = await ev(`document.querySelector('.vc-zoom').textContent.trim()`);
    check('可回到 100%', rZoom100 === '100%', String(rZoom100));

    /* ---------- 5. 沉浸模式（E 项） ---------- */
    console.log('\n=== E. 沉浸模式 ===');
    // 先把周边两栏都置为「显式打开」，退出后必须回到打开 —— 这是最容易写错的地方
    const before = await ev(`(() => {
      const st = ${STORE};
      st.sidebarOpen = true; st.playerbarOpen = true;
      return { sidebar: st.sidebarOpen, playerbar: st.playerbarOpen, immersive: st.ui.immersive };
    })()`);
    await sleep(600);
    const rEnter = await ev(`(() => {
      const btns = [...document.querySelectorAll('.vc-head .chip-btn')];
      const btn = btns.find(b => /沉浸模式/.test(b.textContent));
      if (!btn) return { err: '找不到沉浸模式按钮' };
      btn.click();
      return { clicked: true };
    })()`);
    log('点击进入', rEnter);
    await sleep(900);
    const rIn = await ev(`(() => {
      const st = ${STORE};
      const shell = document.querySelector('.app-shell');
      const disp = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).display : 'missing'; };
      const hero = document.querySelector('.viz-hero');
      return {
        shellImmersive: shell.classList.contains('immersive'),
        uiImmersive: st.ui.immersive,
        sidebarOpen: st.sidebarOpen, playerbarOpen: st.playerbarOpen,
        topbarDisp: disp('.topbar'), sidebarDisp: disp('.sidebar'),
        playerbarDisp: disp('.playerbar'),
        hud: !!document.querySelector('.viz-hud'),
        heroPad: hero ? getComputedStyle(hero).padding : '',
        heroBorder: hero ? getComputedStyle(hero).borderTopWidth : '',
      };
    })()`);
    log('沉浸态', rIn);
    check('app-shell 进入 immersive', !!(rIn && rIn.shellImmersive));
    check('顶栏已隐去', !!(rIn && rIn.topbarDisp === 'none'), rIn && rIn.topbarDisp);
    check('侧栏已隐去', !!(rIn && rIn.sidebarDisp === 'none'), rIn && rIn.sidebarDisp);
    check('播放栏已隐去', !!(rIn && (rIn.playerbarDisp === 'none' || rIn.playerbarDisp === 'missing')),
      rIn && rIn.playerbarDisp + '（v-if 直接移除，missing 也算隐去）');
    check('HUD 浮层已出现', !!(rIn && rIn.hud));
    check('卡片壳已去掉（padding=0 / 无边框）',
      !!(rIn && parseFloat(rIn.heroPad) === 0 && parseFloat(rIn.heroBorder) === 0),
      rIn && (rIn.heroPad + ' / ' + rIn.heroBorder));

    // 静止后自动淡出。先等「进入时的提示 toast」自己消失（它的出现/消失会让
    // Chromium 在指针下方重新判定 hover 并补发 mousemove，从而把淡出定时器续上），
    // 再开始计数 —— 期间只要真有一次鼠标移动，本次结论就不算数。
    await sleep(6000);
    await ev(`(() => {
      window.__mvCount = 0;
      window.addEventListener('mousemove', () => { window.__mvCount++; }, true);
      return true;
    })()`);
    let rFade = null;
    for (let i = 0; i < 14; i++) {
      await sleep(700);
      rFade = await ev(`(() => {
        const h = document.querySelector('.viz-hud');
        const head = document.querySelector('.vc-head');
        return { hudHidden: h.classList.contains('hud-hidden'), headHidden: head.classList.contains('hud-hidden'),
                 hudOpacity: getComputedStyle(h).opacity, mv: window.__mvCount };
      })()`);
      if (rFade && rFade.hudHidden) break;
    }
    log('静止后（轮询至多 9.8s，期间 mousemove 计数一并记录）', rFade);
    check('静止且无鼠标移动时 HUD 自动淡出', !!(rFade && rFade.hudHidden && rFade.mv === 0),
      'hudHidden=' + (rFade && rFade.hudHidden) + ' mousemove=' + (rFade && rFade.mv));
    check('头部工具条一并淡出', !!(rFade && rFade.headHidden), 'headHidden=' + (rFade && rFade.headHidden));

    // 退出（点 HUD 的退出按钮）
    const rExit = await ev(`(() => { document.querySelector('.hud-exit').click(); return true; })()`);
    await sleep(900);
    const rOut = await ev(`(() => {
      const st = ${STORE};
      const shell = document.querySelector('.app-shell');
      const disp = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).display : 'missing'; };
      return {
        shellImmersive: shell.classList.contains('immersive'), uiImmersive: st.ui.immersive,
        sidebarOpen: st.sidebarOpen, playerbarOpen: st.playerbarOpen,
        topbarDisp: disp('.topbar'), sidebarDisp: disp('.sidebar'), playerbarDisp: disp('.playerbar'),
        hud: !!document.querySelector('.viz-hud'),
      };
    })()`);
    log('退出后', rOut);
    check('immersive 类已摘掉', !!(rOut && !rOut.shellImmersive && !rOut.uiImmersive));
    check('侧栏恢复到进入前的原状', !!(rOut && rOut.sidebarOpen === before.sidebar), 'before=' + before.sidebar + ' after=' + (rOut && rOut.sidebarOpen));
    check('播放栏恢复到进入前的原状', !!(rOut && rOut.playerbarOpen === before.playerbar), 'before=' + before.playerbar + ' after=' + (rOut && rOut.playerbarOpen));
    check('顶栏恢复显示', !!(rOut && rOut.topbarDisp !== 'none'), rOut && rOut.topbarDisp);
    check('HUD 已移除', !!(rOut && !rOut.hud));

    // 键盘快捷键路径：I 进入 / Esc 退出
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'i', code: 'KeyI', windowsVirtualKeyCode: 73, nativeVirtualKeyCode: 73 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'i', code: 'KeyI', windowsVirtualKeyCode: 73, nativeVirtualKeyCode: 73 });
    await sleep(700);
    const rKeyIn = await ev(`({ immersive: ${STORE}.ui.immersive, hud: !!document.querySelector('.viz-hud') })`);
    check('按 I 可进入沉浸模式', !!(rKeyIn && rKeyIn.immersive && rKeyIn.hud), JSON.stringify(rKeyIn));
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(700);
    const rKeyOut = await ev(`({ immersive: ${STORE}.ui.immersive, sidebar: ${STORE}.sidebarOpen, playerbar: ${STORE}.playerbarOpen })`);
    check('按 Esc 可退出并恢复原状',
      !!(rKeyOut && !rKeyOut.immersive && rKeyOut.sidebar === before.sidebar && rKeyOut.playerbar === before.playerbar),
      JSON.stringify(rKeyOut));

    /* ---------- 6. 琴键配色跟随主题（C 项） ---------- */
    console.log('\n=== C. 琴键配色跟随主题 ===');
    // 在键盘带里横向取样，取中位亮度（少数被高亮的键不会左右结论）。
    // 取 y = wN + 0.8x：黑键只占 0.6x 高，这样只采到白键，不会把黑键混进来。
    const PROBE = `(() => {
      const cv = document.getElementById('vizRoll');
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth, h = cv.clientHeight;
      const x = Math.min(120, Math.round(0.2 * h));
      const wN = Math.floor(h - x);
      const y = Math.round((wN + x * 0.8) * dpr);
      const g = cv.getContext('2d');
      const lums = [];
      for (let i = 1; i < 40; i++) {
        const px = Math.round(w * i / 40 * dpr);
        const d = g.getImageData(px, y, 1, 1).data;
        lums.push(0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2]);
      }
      lums.sort((a, b) => a - b);
      const med = lums[Math.floor(lums.length / 2)];
      return { medianLum: +med.toFixed(1), minLum: +lums[0].toFixed(1), maxLum: +lums[lums.length - 1].toFixed(1) };
    })()`;

    const rLight = await ev(`(() => {
      localStorage.setItem('fufumidi_theme', 'light');
      localStorage.setItem('fufumidi_mode', 'light');
      return true;
    })()`);
    await send('Page.reload', { ignoreCache: true });
    await sleep(9000);
    await ev(`(async () => {
      const st = ${STORE};
      const it = st.songs.find(s => s.name === 'large-60k');
      if (it) await st.selectSong(it.id);
      location.hash = '#/views?tab=viz';
      return true;
    })()`, 120000);
    await sleep(2500);
    const rLumLight = await ev(PROBE);
    log('浅色主题键盘亮度', rLumLight);

    await ev(`(() => { localStorage.setItem('fufumidi_theme', 'studio'); return true; })()`);
    await send('Page.reload', { ignoreCache: true });
    await sleep(9000);
    await ev(`(async () => {
      const st = ${STORE};
      const it = st.songs.find(s => s.name === 'large-60k');
      if (it) await st.selectSong(it.id);
      location.hash = '#/views?tab=viz';
      return true;
    })()`, 120000);
    await sleep(2500);
    const rTheme = await ev(`({ theme: document.documentElement.style.getPropertyValue('--canvas'), body: getComputedStyle(document.body).backgroundColor })`);
    log('studio 主题令牌', rTheme);
    const rLumStudio = await ev(PROBE);
    log('studio 主题键盘亮度', rLumStudio);

    if (rLumLight && rLumStudio) {
      check('浅色主题键盘是浅色', rLumLight.medianLum > 180, '中位亮度 ' + rLumLight.medianLum);
      check('studio 深色主题键盘跟随变暗（修复前恒为亮白）', rLumStudio.medianLum < 110, '中位亮度 ' + rLumStudio.medianLum);
    }

    // 恢复浅色主题
    await ev(`(() => { localStorage.setItem('fufumidi_theme', 'light'); return true; })()`);

    console.log('\n===== 汇总：PASS ' + pass + ' / FAIL ' + fail + ' =====');
    fs.writeFileSync(path.join(OUT_DIR, 'viz-immersive-report.txt'), out.join('\n'), 'utf8');
  } finally {
    try { ws.close(); } catch (e) {}
  }
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('异常: ' + (e && e.message)); process.exit(2); });
