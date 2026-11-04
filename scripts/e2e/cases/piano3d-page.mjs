// E2E：3D 钢琴独立页 —— 不再挂在可视化里，独立路由可达、可视化里没有 3D 模式。
import { encodeMidi } from '../../../frontend/src/core/midi.js';

const MINI = Array.from(encodeMidi([{
  name: 'E2E Piano3D', ch: 0, program: 0,
  notes: [
    { start: 0, end: 480, midi: 60, vel: 100, ch: 0 },
    { start: 480, end: 960, midi: 64, vel: 90, ch: 0 },
  ], ccs: [], events: [],
}], { division: 480 }));

export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 钩子' });
  if (!(await app.eval('!!window.__fufumidiE2E.hasSong()'))) {
    await app.eval("window.__fufumidiE2E.importMidi('e2e-piano3d.mid', " + JSON.stringify(MINI) + ')');
    await app.waitFor('!!window.__fufumidiE2E.hasSong()', { timeout: 20000 });
  }
  await new Promise((r) => setTimeout(r, 600));

  await app.navigate('#/piano3d');
  await app.waitFor('location.hash.indexOf("piano3d") >= 0 && !!document.querySelector(".piano3d-page")', { timeout: 30000, message: '3D 钢琴独立页' });
  await app.waitFor('!!document.querySelector(".p3d") && !!document.querySelector("[data-guide=piano3d-fullscreen]")', { timeout: 20000, message: 'Piano3D 组件与全屏按钮' });
  const title = await app.eval("((document.querySelector('.piano3d-page .page-title') || {}).textContent || '').trim()");
  app.assert(title.indexOf('3D') >= 0, '页面标题是 3D 钢琴：' + title);
  const rail = await app.eval("!!([...document.querySelectorAll('.rail-item')].find((x) => (x.getAttribute('title') || '').indexOf('3D') >= 0))");
  app.assert(rail, '主导航有 3D 入口');

  // 可视化里不再有 3D 模式
  await app.navigate('#/viz');
  await app.waitFor('location.hash.indexOf("viz") >= 0', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 400));
  app.assert(!(await app.eval("!!document.querySelector('[data-guide=viz-piano3d]')")), '可视化里没有 3D 钢琴 tab');
  app.assert(!(await app.eval("!!document.querySelector('.viz-page.piano3d')")), '可视化不再挂载 3D 钢琴');
}
