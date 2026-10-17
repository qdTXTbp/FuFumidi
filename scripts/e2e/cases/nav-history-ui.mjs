// E2E：P1-14 B3 导航历史（后退/前进）+ 会话恢复（上次视图）。

export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 测试钩子已注册' });
  await app.waitFor('!!document.querySelector("[data-guide=nav-back]")', { timeout: 20000, message: '后退按钮存在' });
  // 等首屏路由稳定（启动早期直接改 hash 会被初始化中的路由合并掉）
  await app.waitFor('location.hash.indexOf("home") >= 0 && document.body.innerText.indexOf("导入到曲库") >= 0', { timeout: 20000, message: '首屏就绪' });
  await new Promise((r) => setTimeout(r, 400));
  await app.navigate('#/views');
  await app.waitFor('location.hash.indexOf("views") >= 0 && !!document.querySelector(".group-tabs")', { timeout: 25000, message: '视图页就绪' });
  await new Promise((r) => setTimeout(r, 700));   // 等路由 watcher 落到历史栈（连续两次 hash 变更会被合并成一次）
  await app.navigate('#/resources');
  await app.waitFor('location.hash.indexOf("resources") >= 0 && !!document.querySelector(".rc-tabs")', { timeout: 25000, message: '资源中心就绪' });
  await new Promise((r) => setTimeout(r, 500));   // 等历史栈写入
  const stackNow = JSON.parse(await app.eval('JSON.stringify(window.__fufumidiNav ? window.__fufumidiNav.snapshot() : null)'));
  app.assert(!!stackNow && stackNow.stack.some((p) => p.indexOf('/views') >= 0), '历史栈里记录了视图页：' + JSON.stringify(stackNow && stackNow.stack));
  app.assert(!(await app.eval('document.querySelector("[data-guide=nav-back]").disabled')), '后退按钮已可用');
  await app.eval("document.querySelector('[data-guide=nav-back]').click()");
  await app.waitFor('location.hash.indexOf("views") >= 0 && location.hash.indexOf("resources") < 0', { timeout: 15000, message: '后退回到视图' });
  app.assert(!(await app.eval('document.querySelector("[data-guide=nav-forward]").disabled')), '前进按钮已可用');
  await app.eval("document.querySelector('[data-guide=nav-forward]').click()");
  await app.waitFor('location.hash.indexOf("resources") >= 0', { timeout: 15000, message: '前进回到资源中心' });
  // 会话恢复：回到首页 → 写入自定义会话 → 重载（启动时从首页恢复上次视图）
  await app.navigate('#/home');
  await app.waitFor('location.hash.indexOf("home") >= 0', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 900));   // 让首帧会话写入先发生，避免覆盖我们的测试值
  await app.eval("localStorage.setItem('fufumidi.session.v1', JSON.stringify({ hash: '#/views?tab=arrange', songId: '', at: Date.now() })); true");
  await app.eval('location.reload()');
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 30000, message: '重载后钩子仍在' });
  await app.waitFor('location.hash.indexOf("views") >= 0 && location.hash.indexOf("arrange") >= 0', { timeout: 20000, message: '会话恢复上次视图（视图/编排）' });
  await app.screenshot('nav-history-session');
  app.assert(true, '导航历史与会话恢复通过');
}