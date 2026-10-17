// E2E：C2 任务中心整链路 —— 主进程登记任务 → 10Hz 事件 push → 前端面板显示进度 → 取消。
// 用 tasks:demo（仅 E2E 实例注册的 2 秒假任务）验证，不触碰真实业务。

export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 测试钩子已注册' });
  await app.waitFor('!!(window.fuBridge && window.fuBridge.tasks && window.fuBridge.tasks.list)', { timeout: 15000, message: 'tasks 桥可用' });
  const demo = await app.eval('(async () => { const r = await window.fuBridge.tasks.demo({ intervalMs: 250, steps: 8 }); return JSON.stringify(r); })()');
  const demoId = JSON.parse(demo).id;
  app.assert(!!demoId, 'demo 任务已登记：' + demoId);
  await app.click('[data-guide="task-center-btn"]');
  await app.waitFor('!!document.querySelector("[data-guide=task-center] .tc-panel")', { timeout: 15000, message: '任务面板打开' });
  await app.waitFor('document.body.innerText.indexOf("E2E 演示任务") >= 0', { timeout: 15000, message: '面板显示演示任务' });
  await new Promise((r) => setTimeout(r, 450));
  const running = JSON.parse(await app.eval('(async () => JSON.stringify(await window.fuBridge.tasks.list()))()'));
  const t0 = running.find((x) => x.id === demoId);
  app.assert(t0 && t0.status === 'running', '任务处于 running：' + JSON.stringify(t0 && t0.status));
  app.assert(t0.progress > 0, '进度事件已推送到渲染进程：' + t0.progress);
  const cancelled = await app.eval('(async () => JSON.stringify(await window.fuBridge.tasks.cancel(' + JSON.stringify(demoId) + ')))()');
  app.assert(JSON.parse(cancelled).ok === true, '取消返回 ok：' + cancelled);
  await new Promise((r) => setTimeout(r, 450));
  const after = JSON.parse(await app.eval('(async () => JSON.stringify(await window.fuBridge.tasks.list()))()'));
  const t1 = after.find((x) => x.id === demoId);
  app.assert(t1 && t1.status === 'canceled', '取消后状态为 canceled：' + JSON.stringify(t1 && t1.status));
  await app.waitFor('[...document.querySelectorAll(".tc-status")].some((e) => e.innerText.indexOf("已取消") >= 0)', { timeout: 20000, message: '面板显示已取消状态' });
  app.assert(true, '任务中心链路通过（running → 取消 → canceled）');
}