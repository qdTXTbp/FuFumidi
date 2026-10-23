// E2E：P1-13 B3 弯音（PB）泳道 —— 与 CC 共用一条泳道，写入的是 bend 事件（14bit）。
import { encodeMidi } from '../../../frontend/src/core/midi.js';

const MINI = Array.from(encodeMidi([{
  name: 'E2E PB', ch: 0, program: 0,
  notes: [{ start: 0, end: 1920, midi: 60, vel: 100, ch: 0 }], ccs: [], events: [],
}], { division: 480 }));

export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 测试钩子已注册' });
  if (!(await app.eval('!!window.__fufumidiE2E.hasSong()'))) {
    await app.eval("window.__fufumidiE2E.importMidi('e2e-pb.mid', " + JSON.stringify(MINI) + ")");
    await app.waitFor('!!window.__fufumidiE2E.hasSong()', { timeout: 20000 });
  }
  await app.navigate('#/edit');
  await app.waitFor('!!document.querySelector("canvas")', { timeout: 30000 });
  // 高级工具区默认折叠：先展开「更多」，CC 泳道开关在那里
  await app.waitFor('!!document.querySelector("[data-guide=edit-more]")', { timeout: 20000 });
  await app.eval("document.querySelector('[data-guide=edit-more]').click()");
  await app.waitFor('!!document.querySelector("[data-guide=edit-cc-toggle]")', { timeout: 20000, message: 'CC 泳道开关出现' });
  await app.eval("document.querySelector('[data-guide=edit-cc-toggle]').click()");
  await app.waitFor('!!document.querySelector(".cc-lane-canvas")', { timeout: 20000, message: 'CC 泳道出现' });
  // 选「弯音 PB」目标（value=128 的 option）
  const picked = await app.eval("(() => { const sels = [...document.querySelectorAll('select')]; const s = sels.find((x) => [...x.options].some((o) => o.value === '128')); if (!s) return false; s.value = '128'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
  app.assert(picked, 'CC 目标里能找到弯音 PB');
  await new Promise((r) => setTimeout(r, 300));
  // 在泳道上画一笔（y 取上部 → 正弯音）
  await app.eval("(() => { const cv = document.querySelector('.cc-lane-canvas'); const r = cv.getBoundingClientRect(); const o = { bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }; cv.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: r.left + 60, clientY: r.top + 20 })); cv.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: r.left + 200, clientY: r.top + 20 })); cv.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: r.left + 200, clientY: r.top + 20 })); return true; })()");
  await new Promise((r) => setTimeout(r, 300));
  const bends = JSON.parse(await app.eval("JSON.stringify((window.__fufumidiE2E.song().tracks[0].events || []).filter((e) => e.type === 'bend'))"));
  app.assert(bends.length > 0, '写入了 bend 事件，数量 ' + bends.length);
  app.assert(bends.every((e) => e.val >= 0 && e.val <= 16383), '弯音值在 14bit 范围内');
  app.assert(bends.some((e) => e.val > 8192), '画在上部应产生正弯音（>8192）');
  await app.screenshot('edit-pb-lane');
  app.assert(true, '弯音泳道通过：' + bends.length + ' 个 bend 事件');
}