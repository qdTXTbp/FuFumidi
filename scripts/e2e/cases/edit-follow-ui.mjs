// E2E：P1-13 B4 跟随播放 —— 开关状态、持久化、播放中不崩（视口滚动策略有单测）。
import { encodeMidi } from '../../../frontend/src/core/midi.js';

const MINI = Array.from(encodeMidi([{
  name: 'E2E Follow', ch: 0, program: 0,
  notes: [{ start: 0, end: 480, midi: 60, vel: 100, ch: 0 }, { start: 3840, end: 4320, midi: 64, vel: 90, ch: 0 }], ccs: [], events: [],
}], { division: 480 }));

export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 测试钩子已注册' });
  if (!(await app.eval('!!window.__fufumidiE2E.hasSong()'))) {
    await app.eval("window.__fufumidiE2E.importMidi('e2e-follow.mid', " + JSON.stringify(MINI) + ")");
    await app.waitFor('!!window.__fufumidiE2E.hasSong()', { timeout: 20000 });
  }
  await app.navigate('#/edit');
  // 跟随按钮在「更多」高级工具区里
  await app.waitFor('!!document.querySelector("[data-guide=edit-more]")', { timeout: 30000 });
  await app.eval("document.querySelector('[data-guide=edit-more]').click()");
  await app.waitFor('!!document.querySelector("[data-guide=edit-follow]")', { timeout: 30000, message: '跟随按钮出现' });
  const initial = await app.eval('document.querySelector("[data-guide=edit-follow]").classList.contains("active")');
  app.assert(initial === true, '默认开启跟随播放');
  await app.eval("document.querySelector('[data-guide=edit-follow]').click()");
  await new Promise((r) => setTimeout(r, 150));
  app.assert((await app.eval('document.querySelector("[data-guide=edit-follow]").classList.contains("active")')) === false, '点击后关闭');
  app.assert((await app.eval("localStorage.getItem('fufumidi_edit_follow')")) === '0', '关闭状态已持久化');
  await app.eval("document.querySelector('[data-guide=edit-follow]').click()");
  await new Promise((r) => setTimeout(r, 150));
  app.assert((await app.eval("localStorage.getItem('fufumidi_edit_follow')")) === '1', '重新开启已持久化');
  // B4：mini-map 点击导航（不崩、画布仍在）
  const miniOk = await app.eval("(() => { const cv = document.querySelector('[data-guide=edit-minimap]'); if (!cv) return false; const r = cv.getBoundingClientRect(); cv.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width * 0.6, clientY: r.top + r.height / 2 })); return true; })()");
  app.assert(miniOk, 'mini-map 存在并可点击导航');
  await new Promise((r) => setTimeout(r, 250));
  app.assert(await app.eval('!!document.querySelector("canvas")'), 'mini-map 导航后画布仍在');
  // B4：选区循环（设置 → 清除）
  await app.key('Ctrl+A');
  await app.waitFor('!!document.querySelector("[data-guide=edit-loop-set]")', { timeout: 15000 });
  await app.eval("document.querySelector('[data-guide=edit-loop-set]').click()");
  await new Promise((r) => setTimeout(r, 200));
  app.assert((await app.eval('document.querySelector("[data-guide=edit-loop-set]").classList.contains("active")')) === true, '选区循环已开启（按钮高亮）');
  await app.eval("document.querySelector('[data-guide=edit-loop-clear]').click()");
  await new Promise((r) => setTimeout(r, 200));
  app.assert((await app.eval('document.querySelector("[data-guide=edit-loop-set]").classList.contains("active")')) === false, '清除循环后高亮消失');
  // 播放 600ms：跟随逻辑每帧跑一遍，不应崩也不应清空画布
  await app.click('.tp-play');
  await new Promise((r) => setTimeout(r, 600));
  app.assert(await app.eval('!!document.querySelector("canvas")'), '播放 + 跟随后画布仍在');
  try { await app.click('.tp-play'); } catch (e) {}
  await app.screenshot('edit-follow');
  app.assert(true, '跟随播放 UI 通过');
}