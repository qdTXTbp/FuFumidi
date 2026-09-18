// 新手引导「全章节逐步走查」：把 13 个章节的每一步都真的走一遍，验证
//   1) 每一步的选择器都能解析到**可见**的真实元素（不存在死链）
//   2) 每一步都能正常推进（manual 点「下一步」、action 点高亮处）
//   3) 每章走完后引导回到章节目录
//
// 为什么必须在运行时走一遍：引导靠选择器定位界面元素，而选择器是字符串 —— 只有真的把页面
// 切到那一步、等懒加载视图与弹窗就位之后，才知道目标存不存在。静态检查（Grep 选择器字符串）
// 无法覆盖「需要先载入曲目 / 需要先点开某个面板」这类前置条件。
//
// 为什么**逐章**调用而不是一次跑完：一次跑完意味着 3~4 分钟里 CDP 连接上一个字节都不流动，
// 经 VirtualBox NAT 反向隧道时会被静默回收（本机实测会挂住直到超时）。逐章调用让流量保持
// 规律，同时把结果拆细，失败时能直接定位到是哪一章。
//
// 用法：$env:CDP_PORT='9222'; node cdp-guide-walk.cjs
//       （虚拟机内测试用 CDP_PORT=9330 走反向隧道）
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
// 走查要有一首**有和声**的曲目：和弦轨（.chord-lane）只在「逐小节覆盖度 ≥50%」时才渲染，
// 而随机生成的压测曲目（如 large-60k）虽然音符多，却没有任何一个三度音程关系 —— 和弦识别
// 会如实返回空，于是那一步「找不到目标」。这不是产品缺陷，是走查场景选错了素材。
// 复用给全新安装播种子曲的同一段脚本（内容指纹去重，重复导入是幂等的）。
const SEED_EXPR = fs.readFileSync(path.join(__dirname, 'expr-guest-seed.js'), 'utf8');
const PORT = Number(process.env.CDP_PORT || 9222);
const PER_CHAPTER_TIMEOUT = Number(process.env.WALK_TIMEOUT || 180000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let b = ''; r.on('data', (c) => (b += c));
      r.on('end', () => resolve(JSON.parse(b)));
    });
    req.on('error', reject);
  });
}

// 页面内共用的准备逻辑（每次调用都重新取一遍，保证幂等）
const PROLOGUE = `
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
    const waitFor = async (fn, ms = 8000, step = 100) => {
      const t0 = performance.now();
      while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
      return false;
    };
    if (app.playing) app.togglePlay();
    if (app.ui.settingsOpen) app.ui.settingsOpen = false;
    if (app.ui.immersive && app.setImmersive) app.setImmersive(false);
    // 固定用种子曲当工作曲目：它是确定性的（C 大调旋律 + 低音），和弦识别有真实和声输入，
    // 且体量小（200 音符 / 40 秒）不会把整机拖慢。全新安装的曲库为空时也由它建立前提。
    // 内容指纹去重 → 已导入过就不再重复导入。
    if (!app.songs.some(s => s.name === 'guest-seed')) { await ${SEED_EXPR}; }
    const seed = app.songs.find(s => s.name === 'guest-seed')
      || app.songs.find(s => s.song && Array.isArray(s.song.tracks));
    if (seed && app.currentId !== seed.id) { await app.selectSong(seed.id); await sleep(1500); }
    app.ui.guideOpen = true;
    await sleep(500);
    const G = window.__fufumidiGuide;
    if (!G) return { err: 'guide hook missing' };
    await waitFor(() => !!G.state().mode, 4000);
    G.open();
    await waitFor(() => G.state().mode === 'catalog', 3000);`;

async function main() {
  const targets = await getJson('/json');
  const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
  if (!page) { console.error('找不到渲染进程页面'); process.exit(2); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  let socketClosed = false;
  ws.onclose = () => { socketClosed = true; };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  const ev = async (expr, t = PER_CHAPTER_TIMEOUT) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
      sleep(t).then(() => null),
    ]);
    if (!r) return { __timeout: true };
    if (r.result && r.result.exceptionDetails) return { __err: (r.result.exceptionDetails.exception || {}).description || r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  console.log('=== 新手引导 · 全章节逐步走查 ===');
  const meta = await ev(`(async () => {${PROLOGUE}
    const cs = G.chapters();
    app.ui.guideOpen = false;
    return { chapterCount: cs.length, totalSteps: cs.reduce((a, c) => a + c.steps.length, 0), names: cs.map(c => c.name), ids: cs.map(c => c.id) };
  })()`, 90000);
  if (!meta || meta.err || meta.__timeout) { console.error('初始化失败: ' + JSON.stringify(meta)); process.exit(2); }
  console.log(`章节 ${meta.chapterCount} 个，步骤合计 ${meta.totalSteps} 步\n`);

  const results = [];
  // 经虚拟机反向隧道跑时，NAT 会偶发静默回收连接，跑到一半断线就前功尽弃。
  // 用 WALK_FROM / WALK_TO 指定章节区间，断线后可以从断点续跑（默认整轮）。
  const from = Number(process.env.WALK_FROM || 0);
  const to = process.env.WALK_TO ? Number(process.env.WALK_TO) : meta.chapterCount - 1;
  if (from || to !== meta.chapterCount - 1) console.log(`（只跑章节 ${from} ~ ${to}）\n`);
  for (let ci = from; ci <= to; ci++) {
    if (socketClosed) { console.error('CDP 连接已断开，中止（已完成的章节见下）'); break; }
    const r = await ev(`(async () => {${PROLOGUE}
      const ch = G.chapters()[${ci}];
      const failures = [], skips = [];
      let passed = 0;
      G.start(${ci});
      const entered = await waitFor(() => { const s = G.state(); return s.mode === 'ig' && s.chapterIdx === ${ci}; }, 8000);
      if (!entered) return { id: ch.id, name: ch.name, steps: ch.steps.length, passed: 0, failed: 1, failures: [{ step: -1, reason: '无法进入该章节' }], skips: [], backToCatalog: false };
      for (let si = 0; si < ch.steps.length; si++) {
        const sel = ch.steps[si].selector;
        // 依赖外部素材的步骤（如 UTAU 片段列表需要先上传音频）自动化无法满足前置条件，
        // 记为 SKIP 并说明原因，不包装成通过、也不算失败。
        if (ch.steps[si].requires) {
          skips.push({ step: si, selector: sel, requires: ch.steps[si].requires });
          const b = document.querySelector('.ig-card .ig-foot .guide-btn.primary');
          if (b) b.click();
          await waitFor(() => { const s = G.state(); return s.mode !== 'ig' || s.stepIdx !== si; }, 8000);
          await sleep(100);
          continue;
        }
        // 判「已就位」用 .ig-target（引导给目标元素加的类）——它是真实挂载的结果
        const attached = await waitFor(() => !!document.querySelector('.ig-target'), 9000);
        if (!attached) {
          const st = G.state();
          const vis = [...document.querySelectorAll(sel)].filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; }).length;
          failures.push({ step: si, selector: sel, title: ch.steps[si].title, reason: st.missing ? 'guide reported target missing' : 'timeout without highlight', visibleMatches: vis });
          const skipBtn = [...document.querySelectorAll('.ig-card .guide-btn')].find(b => /跳过此步|下一步|Skip|Next/i.test(b.textContent || ''));
          if (skipBtn) skipBtn.click(); else G.start(${ci});
          await sleep(700);
          continue;
        }
        passed++;
        const st0 = G.state();
        const target = document.querySelector('.ig-target');
        if (st0.action && target) target.click();
        else { const nb = document.querySelector('.ig-card .ig-foot .guide-btn.primary'); if (nb) nb.click(); }
        await waitFor(() => { const s = G.state(); return s.mode !== 'ig' || s.stepIdx !== si; }, 9000);
        await sleep(120);
      }
      const backToCatalog = await waitFor(() => G.state().mode === 'catalog', 7000);
      if (!backToCatalog) failures.push({ step: -1, reason: 'chapter did not return to catalog' });
      app.ui.guideOpen = false;
      return { id: ch.id, name: ch.name, steps: ch.steps.length, passed, failed: failures.length, failures, skips, backToCatalog };
    })()`, PER_CHAPTER_TIMEOUT);

    if (!r || r.err || r.__timeout) {
      console.log(`  FAIL  chapter[${ci}] ${meta.names[ci]} —— ${r && r.err ? r.err : 'timeout'}`);
      results.push({ name: meta.names[ci], steps: 0, passed: 0, failed: 1, failures: [{ step: -1, reason: r && r.err ? r.err : 'timeout' }], skips: [] });
      continue;
    }
    const mark = r.failed ? 'FAIL' : 'PASS';
    const sk = r.skips.length ? ` (SKIP ${r.skips.length})` : '';
    console.log(`  ${mark}  ${r.name}  [${r.passed}/${r.steps} 步]${sk}`);
    results.push(r);
    await sleep(200);
  }

  const allFailures = results.flatMap(r => (r.failures || []).map(f => ({ chapter: r.name, ...f })));
  const allSkips = results.flatMap(r => (r.skips || []).map(s => ({ chapter: r.name, ...s })));
  const totalSteps = (from === 0 && to === meta.chapterCount - 1)
    ? meta.totalSteps
    : results.reduce((a, r) => a + (r.steps || 0), 0);
  if (allSkips.length) {
    console.log('\n跳过（需外部素材，自动化无法满足前置条件）：');
    for (const s of allSkips) console.log(`  · ${s.chapter} 第 ${s.step + 1} 步 ${s.selector} —— 依赖：${s.requires}`);
  }
  if (allFailures.length) {
    console.log('\n失败明细：');
    for (const f of allFailures) console.log(`  · ${f.chapter} 第 ${f.step + 1} 步 ${f.selector || ''} —— ${f.reason}${f.visibleMatches != null ? `（可见匹配 ${f.visibleMatches}）` : ''}`);
  }
  console.log(`\n===== PASS ${totalSteps - allFailures.length - allSkips.length} / FAIL ${allFailures.length} / SKIP ${allSkips.length} =====`);
  try { ws.close(); } catch (e) {}
  process.exit(allFailures.length ? 1 : 0);
}
main().catch((e) => { console.error('异常: ' + e.message); process.exit(2); });