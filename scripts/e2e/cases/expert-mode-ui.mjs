// E2E：P1-12 专家模式（普通模式隐藏翻唱/OMR/GPU）+ 任务模板。
import { encodeMidi } from '../../../frontend/src/core/midi.js';

const MINI = Array.from(encodeMidi([{
  name: 'E2E Expert', ch: 0, program: 0,
  notes: [{ start: 0, end: 480, midi: 60, vel: 100, ch: 0 }], ccs: [], events: [],
}], { division: 480 }));

export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 测试钩子已注册' });
  // 1) 普通模式：翻唱导航与资源中心 OMR/GPU 区块隐藏
  const coverTab = await app.eval('!!document.querySelector("[data-view=cover]")');
  app.assert(coverTab === false, '普通模式下翻唱导航隐藏');
  await app.navigate('#/resources?tab=resources');
  await app.waitFor('(() => { const b = document.querySelector(".rc-tab.on"); return !!b && b.innerText.indexOf("资源管理") >= 0; })()', { timeout: 25000, message: '资源管理页签激活' });
  await new Promise((r) => setTimeout(r, 400));
  const gpuShown = await app.eval('!!document.querySelector("[data-guide=res-gpu]")');
  const omrShown = await app.eval('!!document.querySelector("[data-guide=res-omr]")');
  app.assert(gpuShown === false && omrShown === false, '普通模式下 GPU/OMR 区块隐藏');
  // 2) 打开专家模式后重新加载：入口全部出现
  await app.eval("window.fuBridge.saveSettings({ advanced_mode: true }).then(() => true)");
  await app.eval('location.reload()');
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 30000, message: '重载后钩子仍在' });
  await app.waitFor('!!document.querySelector("[data-view=cover]")', { timeout: 20000, message: '专家模式翻唱导航出现' });
  await app.navigate('#/resources?tab=resources');
  await app.waitFor('!!document.querySelector("[data-guide=res-gpu]")', { timeout: 30000, message: '专家模式 GPU 区块出现' });
  app.assert(await app.eval('!!document.querySelector("[data-guide=res-omr]")'), '专家模式 OMR 区块出现');
  // 3) 复原为普通模式给后续用例一个干净环境
  await app.eval("window.fuBridge.saveSettings({ advanced_mode: false }).then(() => true)");
  await app.eval('location.reload()');
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 30000 });
  // 4) 任务模板：编辑页点「乐队编曲」→ 吸附变 1/8、CC 打开
  if (!(await app.eval('!!window.__fufumidiE2E.hasSong()'))) {
    await app.eval("window.__fufumidiE2E.importMidi('e2e-expert.mid', " + JSON.stringify(MINI) + ")");
    await app.waitFor('!!window.__fufumidiE2E.hasSong()', { timeout: 20000 });
  }
  await app.navigate('#/edit');
  await app.waitFor('!!document.querySelector("canvas")', { timeout: 30000 });
  await app.eval("(() => { const tabs = [...document.querySelectorAll('.insp-tabs button, .insp-tab')]; const b = tabs.find((x) => x.innerText.trim().indexOf('视图') >= 0); if (b) b.click(); return !!b; })()");
  await app.waitFor('!!document.querySelector("[data-guide=tpl-band]")', { timeout: 20000, message: '任务模板按钮出现' });
  await app.eval("document.querySelector('[data-guide=tpl-band]').click()");
  await new Promise((r) => setTimeout(r, 300));
  const snap = await app.eval('(() => { const sels = [...document.querySelectorAll(".insp-row select")]; const s = sels.find((x) => [...x.options].some((o) => o.value === "0.125")); return s ? s.value : ""; })()');
  app.assert(String(snap) === '0.125', '模板把吸附切到 1/8，实际 ' + snap);
  await app.screenshot('expert-mode');
  app.assert(true, '专家模式与任务模板通过');
}