// E2E：P1-1b 编排时间线视图 —— 挂载、片段统计、加标记、加区间、全览。
import { encodeMidi } from '../../../frontend/src/core/midi.js';

const MIDI = Array.from(encodeMidi([
  { name: '钢琴', ch: 0, program: 0, notes: [{ start: 0, end: 1920, midi: 60, vel: 100, ch: 0 }], ccs: [], events: [] },
  { name: '弦乐', ch: 1, program: 48, notes: [{ start: 960, end: 2880, midi: 72, vel: 90, ch: 1 }], ccs: [], events: [] },
], { division: 480 }));

export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 测试钩子已注册' });
  if (!(await app.eval('!!window.__fufumidiE2E.hasSong()'))) {
    await app.eval("window.__fufumidiE2E.importMidi('e2e-arrange.mid', " + JSON.stringify(MIDI) + ")");
    await app.waitFor('!!window.__fufumidiE2E.hasSong()', { timeout: 20000 });
  }
  await app.navigate('#/views?tab=arrange');
  await app.waitFor('location.hash.indexOf("arrange") >= 0', { timeout: 15000, message: '路由到编排页签' });
  await app.waitFor('!!document.querySelector("[data-guide=arrange-canvas] canvas")', { timeout: 30000, message: '编排画布挂载' });
  await app.waitFor('document.body.innerText.indexOf("编排时间线") >= 0', { timeout: 15000, message: '工具栏标题出现' });
  const stat0 = await app.eval('(document.querySelector(".arr-stat") || {}).innerText || ""');
  app.assert(/\d+/.test(stat0) && stat0.indexOf('片段') >= 0, '片段统计可见：' + stat0);
  const clickBtn = (label) => app.eval('(() => { const b = [...document.querySelectorAll(".arr-toolbar button")].find((x) => x.innerText.indexOf(' + JSON.stringify(label) + ') >= 0); if (!b) return false; b.click(); return true; })()');
  app.assert(await clickBtn('加标记'), '找到「加标记」按钮');
  await new Promise((r) => setTimeout(r, 120));
  app.assert(await clickBtn('加标记'), '第二次加标记');
  await new Promise((r) => setTimeout(r, 200));
  const stat1 = await app.eval('(document.querySelector(".arr-stat") || {}).innerText || ""');
  app.assert(stat1.indexOf('2') >= 0 && stat1.indexOf('标记') >= 0, '标记计数变成 2：' + stat1);
  app.assert(await clickBtn('加区间'), '找到「加区间」按钮');
  await new Promise((r) => setTimeout(r, 200));
  const stat2 = await app.eval('(document.querySelector(".arr-stat") || {}).innerText || ""');
  app.assert(stat2.indexOf('区间') >= 0, '区间计数出现：' + stat2);
  await clickBtn('全览');
  await app.screenshot('arrange-view');
  app.assert(true, '编排视图交互通过：' + stat2);
}