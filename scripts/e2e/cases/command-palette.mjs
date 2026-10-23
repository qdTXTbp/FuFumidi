// E2E：C1 命令注册表驱动的命令面板（Ctrl+Shift+P）—— 打开、列命令、搜索、Esc 关闭。
// 数据源是 ViewEdit 里同步注册的菜单动作（C1），不是另维护的一份表。
import { encodeMidi } from '../../../frontend/src/core/midi.js';

const MINI = Array.from(encodeMidi([{
  name: 'E2E Palette', ch: 0, program: 0,
  notes: [{ start: 0, end: 480, midi: 60, vel: 100, ch: 0 }], ccs: [], events: [],
}], { division: 480 }));

export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 测试钩子已注册' });
  if (!(await app.eval('!!window.__fufumidiE2E.hasSong()'))) {
    await app.eval("window.__fufumidiE2E.importMidi('e2e-palette.mid', " + JSON.stringify(MINI) + ")");
    await app.waitFor('!!window.__fufumidiE2E.hasSong()', { timeout: 20000 });
  }
  await app.navigate('#/edit');
  await app.waitFor('location.hash.indexOf("edit") >= 0', { timeout: 15000 });
  await app.waitFor('!!document.querySelector("canvas")', { timeout: 30000 });
  await app.key('Ctrl+Shift+P');
  await app.waitFor('!!document.querySelector(".cp-mask")', { timeout: 15000, message: '命令面板打开' });
  const all = JSON.parse(await app.eval('JSON.stringify([...document.querySelectorAll(".cp-item")].map((x) => x.innerText.trim()))'));
  app.assert(all.length >= 20, '面板列出足够多的命令，实际 ' + all.length);
  app.assert(all.some((x) => x.indexOf('导出') >= 0), '能列出导出类命令');
  app.assert(all.some((x) => x.indexOf('撤销') >= 0), '能列出撤销命令');
  await app.eval('(() => { const i = document.querySelector(".cp-input"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); })()');
  await app.type('量化');
  await new Promise((r) => setTimeout(r, 350));
  const q = JSON.parse(await app.eval('JSON.stringify([...document.querySelectorAll(".cp-item .cp-label")].map((x) => x.innerText.trim()))'));
  app.assert(q.length >= 1 && q.length < all.length, '搜索「量化」后列表收窄且非空：' + JSON.stringify(q.slice(0, 5)));
  app.assert(q.some((x) => x.indexOf('量化') >= 0), '搜索结果命中量化命令');
  await app.key('Escape');
  await app.waitFor('!document.querySelector(".cp-mask")', { timeout: 10000, message: 'Esc 关闭面板' });
  app.assert(true, '命令面板交互通过（全量 ' + all.length + ' 条，搜索命中 ' + q.length + ' 条）');
}