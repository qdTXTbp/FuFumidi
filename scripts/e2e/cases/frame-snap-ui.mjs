// E2E：P1-6 帧吸附 UI —— 勾选后出现帧率选择，时间码仍正常显示。
import { encodeMidi } from '../../../frontend/src/core/midi.js';

const MINI = Array.from(encodeMidi([{
  name: 'E2E Frame', ch: 0, program: 0,
  notes: [{ start: 0, end: 480, midi: 60, vel: 100, ch: 0 }], ccs: [], events: [],
}], { division: 480 }));

export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 测试钩子已注册' });
  if (!(await app.eval('!!window.__fufumidiE2E.hasSong()'))) {
    await app.eval("window.__fufumidiE2E.importMidi('e2e-frame.mid', " + JSON.stringify(MINI) + ")");
    await app.waitFor('!!window.__fufumidiE2E.hasSong()', { timeout: 20000 });
  }
  await app.navigate('#/edit');
  await app.waitFor('location.hash.indexOf("edit") >= 0', { timeout: 15000 });
  await app.waitFor('!!document.querySelector("canvas")', { timeout: 30000 });
  // 帧吸附在检查器「视图」分页里：先切到该分页
  await app.eval("(() => { const tabs = [...document.querySelectorAll('.insp-tabs button, .insp-tab')]; const b = tabs.find((x) => x.innerText.trim().indexOf('视图') >= 0); if (b) b.click(); return !!b; })()");
  await new Promise((r) => setTimeout(r, 250));
  await app.waitFor('!!document.querySelector("[data-guide=edit-framesnap]")', { timeout: 20000, message: '帧吸附开关出现' });
  const before = await app.eval('document.querySelectorAll(".insp-row select").length');
  await app.eval("(() => { const row = document.querySelector('[data-guide=edit-framesnap]'); const cb = row.querySelector('input[type=checkbox]'); cb.click(); return cb.checked; })()");
  await new Promise((r) => setTimeout(r, 250));
  const after = await app.eval('document.querySelectorAll(".insp-row select").length');
  app.assert(after > before, '勾选帧吸附后出现帧率下拉（' + before + ' → ' + after + '）');
  const fpsOpts = await app.eval('JSON.stringify([...document.querySelectorAll(".insp-row select")].map((s) => [...s.options].map((o) => o.textContent.trim())).flat())');
  app.assert(String(fpsOpts).indexOf('23.976') >= 0 && String(fpsOpts).indexOf('29.97') >= 0, '帧率选项齐全：' + String(fpsOpts).slice(0, 160));
  const status = await app.eval('document.body.innerText');
  app.assert(/\d{2}:\d{2}:\d{2}[:.]\d{2}/.test(status), '状态栏时间码格式正确');
  app.assert(true, '帧吸附 UI 通过：' + before + '→' + after + ' 个下拉');
}