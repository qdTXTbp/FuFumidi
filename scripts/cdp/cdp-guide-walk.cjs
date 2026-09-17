// 新手引导「全章节逐步走查」：把 13 个章节的每一步都真的走一遍，验证
//   1) 每一步的选择器都能解析到**可见**的真实元素（不存在死链）
//   2) 每一步都能正常推进（manual 点「下一步」、action 点高亮处）
//   3) 每章走完后引导回到章节目录
//
// 为什么必须在运行时走一遍：引导靠选择器定位界面元素，而选择器是字符串 —— 只有真的把页面
// 切到那一步、等懒加载视图与弹窗就位之后，才知道目标存不存在。静态检查（Grep 选择器字符串）
// 无法覆盖「需要先载入曲目 / 需要先点开某个面板」这类前置条件。
//
// 用法：$env:CDP_PORT='9222'; node cdp-guide-walk.cjs
'use strict';
const http = require('http');
const PORT = Number(process.env.CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, (r) => {
      let b = ''; r.on('data', (c) => (b += c));
      r.on('end', () => resolve(JSON.parse(b)));
    });
    req.on('error', reject);
  });
}

async function main() {
  const targets = await getJson('/json');
  const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
  if (!page) { console.error('找不到渲染进程页面'); process.exit(2); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  const ev = async (expr, t = 600000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
      sleep(t).then(() => null),
    ]);
    if (!r) return { __timeout: true };
    if (r.result && r.result.exceptionDetails) return { __err: (r.result.exceptionDetails.exception || {}).description || r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  console.log('=== 新手引导 · 全章节逐步走查 ===');
  const out = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');

    const waitFor = async (fn, ms = 8000, step = 100) => {
      const t0 = performance.now();
      while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
      return false;
    };
    const visibleCount = (sel) => [...document.querySelectorAll(sel)].filter(e => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).length;

    // 前置：载入一首曲目（大量步骤需要当前曲目才存在目标元素）
    if (!app.currentId && app.songs.length) {
      await app.selectSong(app.songs[0].id);
      await sleep(1500);
    }
    if (app.playing) app.togglePlay();
    // 从干净的现场开始：关掉可能残留的弹窗/沉浸态
    if (app.ui.settingsOpen) app.ui.settingsOpen = false;
    if (app.ui.immersive && app.setImmersive) app.setImmersive(false);
    await sleep(400);

    // GuideOverlay 是 v-if 挂载的，钩子随组件生命周期出现 —— 必须先打开引导再取钩子
    app.ui.guideOpen = true;
    await sleep(600);
    const G = window.__fufumidiGuide;
    if (!G) return { err: '引导钩子不存在（已打开 guideOpen 但组件未挂载？）' };
    await waitFor(() => !!G.state().mode, 4000);
    G.open();
    await waitFor(() => G.state().mode === 'catalog', 3000);

    const chapters = G.chapters();
    const report = { chapterCount: chapters.length, totalSteps: chapters.reduce((a, c) => a + c.steps.length, 0), chapters: [], failures: [], skips: [] };

    for (let ci = 0; ci < chapters.length; ci++) {
      const ch = chapters[ci];
      G.start(ci);
      // 等引导真的进入这一章（可能要先切页）
      const entered = await waitFor(() => { const s = G.state(); return s.mode === 'ig' && s.chapterIdx === ci; }, 6000);
      if (!entered) {
        report.failures.push({ chapter: ch.id, step: -1, reason: '无法进入该章节' });
        report.chapters.push({ id: ch.id, steps: 0, passed: 0, failed: 1 });
        continue;
      }
      let passed = 0, failed = 0, skipped = 0;
      for (let si = 0; si < ch.steps.length; si++) {
        const sel = ch.steps[si].selector;
        // 依赖外部素材的步骤（如 UTAU 的片段列表需要先上传音频）无法在自动化里满足前置条件，
        // 记为 SKIP 并在报告里说明原因，不包装成通过、也不算失败。
        if (ch.steps[si].requires) {
          skipped++;
          report.skips.push({ chapter: ch.id, step: si, selector: sel, requires: ch.steps[si].requires });
          const nextBtn0 = document.querySelector('.ig-card .ig-foot .guide-btn.primary');
          if (nextBtn0) nextBtn0.click();
          await waitFor(() => { const s = G.state(); return s.mode !== 'ig' || s.stepIdx !== si; }, 6000);
          await sleep(120);
          continue;
        }
        // 判「已就位」用 .ig-target（引导给目标元素加的类）：它是真实挂载的结果，
        // 比重新查一次选择器更能反映引导自身的状态
        const attached = await waitFor(() => !!document.querySelector('.ig-target'), 8000);
        if (!attached) {
          const st = G.state();
          const n = visibleCount(sel);
          report.failures.push({
            chapter: ch.id, step: si, selector: sel, title: ch.steps[si].title,
            reason: st.missing ? '引导标记为「未找到目标」' : '等待超时未挂载高亮',
            visibleMatches: n,
          });
          failed++;
          // 用「跳过此步」继续，保证后面步骤仍被走到
          const skipBtn = [...document.querySelectorAll('.ig-card .guide-btn')].find(b => /跳过此步|下一步/.test(b.textContent || ''));
          if (skipBtn) skipBtn.click(); else G.start(ci);
          await sleep(500);
          continue;
        }
        passed++;
        const st0 = G.state();
        const target = document.querySelector('.ig-target');
        if (st0.action && target) {
          target.click();
        } else {
          const nextBtn = document.querySelector('.ig-card .ig-foot .guide-btn.primary');
          if (nextBtn) nextBtn.click();
        }
        // 等推进：步号变化，或本章结束回到目录
        await waitFor(() => {
          const s = G.state();
          return s.mode !== 'ig' || s.stepIdx !== si;
        }, 6000);
        await sleep(120);
      }
      // 本章结束后应回到目录
      const backToCatalog = await waitFor(() => G.state().mode === 'catalog', 5000);
      if (!backToCatalog) report.failures.push({ chapter: ch.id, step: -1, reason: '本章结束后未回到章节目录' });
      report.chapters.push({ id: ch.id, name: ch.name, steps: ch.steps.length, passed, failed, skipped, backToCatalog });
    }

    // 收尾：关闭引导，恢复现场
    app.ui.guideOpen = false;
    if (app.ui.immersive && app.setImmersive) app.setImmersive(false);
    if (app.playing) app.togglePlay();

    return report;
  })()`, 600000);

  if (out && out.__err) { console.error('页面异常: ' + out.__err); process.exit(2); }
  if (out && out.__timeout) { console.error('走查超时'); process.exit(2); }
  if (!out || out.err) { console.error('走查失败: ' + JSON.stringify(out)); process.exit(2); }

  for (const c of out.chapters) {
    const mark = c.failed ? 'FAIL' : 'PASS';
    const sk = c.skipped ? ` (SKIP ${c.skipped})` : '';
    console.log(`  ${mark}  ${c.name || c.id}  [${c.passed}/${c.steps} 步]${sk}`);
  }
  console.log(`\n章节 ${out.chapterCount} 个，步骤合计 ${out.totalSteps} 步`);
  if (out.skips.length) {
    console.log('\n跳过（需外部素材，自动化无法满足前置条件）：');
    for (const s of out.skips) console.log(`  · ${s.chapter} 第 ${s.step + 1} 步 ${s.selector} —— 依赖：${s.requires}`);
  }
  if (out.failures.length) {
    console.log('\n失败明细：');
    for (const f of out.failures) {
      console.log(`  · ${f.chapter} 第 ${f.step + 1} 步 ${f.selector || ''} —— ${f.reason}${f.visibleMatches != null ? `（可见匹配 ${f.visibleMatches} 个）` : ''}`);
    }
  }
  const failedTotal = out.failures.length;
  const skippedTotal = out.skips.length;
  console.log(`\n===== PASS ${out.totalSteps - failedTotal - skippedTotal} / FAIL ${failedTotal} / SKIP ${skippedTotal} =====`);
  try { ws.close(); } catch (e) {}
  process.exit(failedTotal ? 1 : 0);
}
main().catch((e) => { console.error('异常: ' + e.message); process.exit(2); });