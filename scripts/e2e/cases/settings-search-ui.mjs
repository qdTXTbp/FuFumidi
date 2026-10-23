// E2E：P1-14 B4 设置可搜索 —— 关键字命中、点结果切页签并滚到锚点。

export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 测试钩子已注册' });
  await app.waitFor('!!document.querySelector("[data-guide=topbar-settings]")', { timeout: 20000 });
  await app.eval("document.querySelector('[data-guide=topbar-settings]').click()");
  await app.waitFor('!!document.querySelector("[data-guide=settings-search-input]")', { timeout: 20000, message: '设置搜索框出现' });
  const typeSearch = (q) => app.eval("(() => { const i = document.querySelector('[data-guide=settings-search-input]'); i.value = " + JSON.stringify(q) + "; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  await typeSearch('显卡');
  await app.waitFor('!!document.querySelector("[data-guide=settings-search-results]")', { timeout: 10000, message: '搜索结果出现' });
  const hits = await app.eval("JSON.stringify([...document.querySelectorAll('[data-hit]')].map((b) => b.getAttribute('data-hit')))").then(JSON.parse);
  app.assert(hits[0] === 'gpu_install', '别名「显卡」命中 GPU 加速：' + JSON.stringify(hits));
  await app.eval("document.querySelector('[data-hit=gpu_install]').click()");
  await new Promise((r) => setTimeout(r, 500));
  app.assert(await app.eval("!!document.querySelector('[data-guide=set-tab-gpu].active')"), '点击结果切到 GPU 页签');
  await typeSearch('更新通道');
  await app.waitFor('!!document.querySelector("[data-hit=update_channel]")', { timeout: 10000 });
  await app.eval("document.querySelector('[data-hit=update_channel]').click()");
  await new Promise((r) => setTimeout(r, 500));
  app.assert(await app.eval("!!document.querySelector('[data-guide=set-tab-update].active')"), '点击结果切到更新页签');
  await typeSearch('没有这种设置xyz');
  await new Promise((r) => setTimeout(r, 200));
  const emptyText = await app.eval("(document.querySelector('[data-guide=settings-search-results]') || {}).innerText || ''");
  app.assert(String(emptyText).indexOf('没有找到') >= 0, '无结果显示提示');
  await app.screenshot('settings-search');
  app.assert(true, '设置搜索通过');
}