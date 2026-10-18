// E2E：侧栏「搜索框 + 整理方式 + 筛选」布局回归（2026-10-18 问题截图）
// 断言：搜索框独占一行；筛选浮层 fixed 定位且完全在视口内（不被侧栏裁切）；Esc 关闭。
export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 测试钩子已注册' });
  await app.waitFor('!!document.querySelector(".pl-search .text-input")', { timeout: 20000, message: '搜索框出现' });
  await app.waitFor('!!document.querySelector(".pl-controls .lib-filter")', { timeout: 20000, message: '整理/筛选行出现' });

  const rows = await app.eval('(() => { const s = document.querySelector(".pl-search"); const c = document.querySelector(".pl-controls"); return { searchHasSort: !!s.querySelector(".lib-sort"), searchHasFilter: !!s.querySelector(".lib-filter"), controlsHasSort: !!c.querySelector(".lib-sort"), controlsHasFilter: !!c.querySelector(".lib-filter") }; })()');
  app.assert(rows.searchHasSort === false && rows.searchHasFilter === false, '搜索框独占一行：' + JSON.stringify(rows));
  app.assert(rows.controlsHasSort && rows.controlsHasFilter, '整理方式与筛选同排：' + JSON.stringify(rows));

  await app.eval("document.querySelector('.pl-controls .lib-filter .chip-btn').click()");
  await app.waitFor('!!document.querySelector(".lib-filter-pop")', { timeout: 10000, message: '筛选浮层出现' });
  const pop = await app.eval('(() => { const p = document.querySelector(".lib-filter-pop"); const r = p.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, vw: window.innerWidth, vh: window.innerHeight, kinds: [...p.querySelectorAll(".lib-filter-kinds .chip-btn")].length }; })()');
  app.assert(pop.left >= 0 && pop.top >= 0, '浮层未超出视口左上：' + JSON.stringify(pop));
  app.assert(pop.right <= pop.vw + 0.5 && pop.bottom <= pop.vh + 0.5, '浮层未超出视口右下（不被裁切）：' + JSON.stringify(pop));
  app.assert(pop.width >= 200, '浮层宽度可用：' + pop.width);
  app.assert(pop.kinds === 4, '四种筛选类别：' + pop.kinds);

  await app.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await new Promise((r) => setTimeout(r, 200));
  app.assert(await app.eval('!document.querySelector(".lib-filter-pop")'), 'Esc 关闭浮层');
  await app.screenshot('sidebar-filter-ui');
  app.assert(true, '侧栏搜索/筛选布局通过');
}
