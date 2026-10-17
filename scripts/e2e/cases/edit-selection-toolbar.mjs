// E2E：P1-13 B2 选区批量操作条 —— 全选后移调/力度/删除/撤销，数据逐条回放。
import { encodeMidi } from '../../../frontend/src/core/midi.js';

const MINI = Array.from(encodeMidi([{
  name: 'E2E Sel', ch: 0, program: 0,
  notes: [
    { start: 0, end: 480, midi: 60, vel: 100, ch: 0 },
    { start: 480, end: 960, midi: 64, vel: 90, ch: 0 },
    { start: 960, end: 1440, midi: 67, vel: 95, ch: 0 },
  ],
  ccs: [], events: [],
}], { division: 480 }));

function notes(app) {
  return app.eval("JSON.stringify(((window.__fufumidiE2E.song().tracks[0].notes) || []).map((n) => ({ midi: n.midi, vel: n.vel })))").then(JSON.parse);
}

export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 测试钩子已注册' });
  if (!(await app.eval('!!window.__fufumidiE2E.hasSong()'))) {
    await app.eval("window.__fufumidiE2E.importMidi('e2e-sel.mid', " + JSON.stringify(MINI) + ")");
    await app.waitFor('!!window.__fufumidiE2E.hasSong()', { timeout: 20000 });
  }
  await app.navigate('#/edit');
  await app.waitFor('!!document.querySelector("canvas")', { timeout: 30000 });
  await app.key('Ctrl+A');
  await app.waitFor('!!document.querySelector("[data-guide=sel-badge]")', { timeout: 15000, message: '选区任务条出现' });
  const badge = await app.eval('document.querySelector("[data-guide=sel-badge]").innerText');
  app.assert(badge.indexOf('3') >= 0, '已选 3 个音符：' + badge);
  const before = await notes(app);
  await app.eval("document.querySelector('[data-guide=sel-transpose-up]').click()");
  await new Promise((r) => setTimeout(r, 250));
  const afterPitch = await notes(app);
  app.assert(afterPitch.every((n, i) => n.midi === before[i].midi + 1), '批量升半音生效：' + JSON.stringify(afterPitch));
  await app.eval("document.querySelector('[data-guide=sel-vel-up]').click()");
  await new Promise((r) => setTimeout(r, 250));
  const afterVel = await notes(app);
  app.assert(afterVel.some((n, i) => n.vel > before[i].vel), '批量力度渐强生效：' + JSON.stringify(afterVel));
  await app.eval("document.querySelector('[data-guide=sel-delete]').click()");
  await new Promise((r) => setTimeout(r, 300));
  app.assert((await notes(app)).length === 0, '批量删除生效');
  await app.key('Ctrl+Z');
  await new Promise((r) => setTimeout(r, 350));
  app.assert((await notes(app)).length === 3, '撤销恢复 3 个音符（一次操作 = 一条撤销项）');
  await app.eval("document.querySelector('[data-guide=sel-cancel]') && document.querySelector('[data-guide=sel-cancel]').click()");
  await app.screenshot('edit-selection-toolbar');
  app.assert(true, '选区批量操作条通过');
}