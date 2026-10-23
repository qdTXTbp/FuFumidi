// E2E：P0-3b 录音面板在真实应用里能打开、控件齐全、能关闭（无硬件时开始按钮禁用属预期）。
// 真录音落 note 需要 Web MIDI 硬件，自动化环境没有；引擎逻辑由 recorder.test.js 覆盖。
import { encodeMidi } from '../../../frontend/src/core/midi.js';

const MINI = Array.from(encodeMidi([{
  name: 'E2E Record', ch: 0, program: 0,
  notes: [{ start: 0, end: 480, midi: 60, vel: 100, ch: 0 }], ccs: [], events: [],
}], { division: 480 }));

const PANEL = '[data-guide="edit-record"]';

export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 测试钩子已注册' });
  if (!(await app.eval('!!window.__fufumidiE2E.hasSong()'))) {
    await app.eval("window.__fufumidiE2E.importMidi('e2e-record.mid', " + JSON.stringify(MINI) + ") ");
    await app.waitFor('!!window.__fufumidiE2E.hasSong()', { timeout: 20000 });
  }
  await app.navigate('#/edit');
  await app.waitFor('location.hash.indexOf("edit") >= 0', { timeout: 15000 });
  await app.waitFor('!!document.querySelector("canvas")', { timeout: 30000 });
  // 用 data-guide 精确点工具栏按钮（clickText 会被侧栏/播放条里同名的文字干扰）
  const hit = await app.eval("(() => { const b = document.querySelector('[data-guide=\"edit-record-btn\"]'); if (!b) return null; b.click(); return b.innerText.trim(); })()");
  app.assert(!!hit, '工具栏「录音」按钮存在：' + JSON.stringify(hit));
  await app.waitFor('!!document.querySelector(' + JSON.stringify(PANEL) + ')', { timeout: 15000, message: '录音面板打开' });
  const info = JSON.parse(await app.eval("JSON.stringify((() => { const p = document.querySelector('[data-guide=\"edit-record\"]'); return { text: p.innerText, selects: p.querySelectorAll('select').length, inputs: p.querySelectorAll('input').length, buttons: [...p.querySelectorAll('button')].map((b) => b.innerText.trim()) }; })())"));
  app.assert(info.text.indexOf('MIDI 键盘录音') >= 0, '面板标题正确');
  app.assert(info.text.indexOf('输入设备') >= 0 && info.text.indexOf('预备拍') >= 0 && info.text.indexOf('量化') >= 0, '设备/预备拍/量化控件齐全');
  app.assert(info.selects >= 3, '至少 3 个下拉（设备/预备拍/量化/模式），实际 ' + info.selects);
  app.assert(info.buttons.some((x) => x.indexOf('开始录音') >= 0), '有开始录音按钮：' + JSON.stringify(info.buttons));
  app.assert(info.buttons.some((x) => x.indexOf('校准') >= 0), '有延迟校准入口');
  await app.eval("(() => { const p = document.querySelector('[data-guide=\"edit-record\"]'); const b = [...p.querySelectorAll('button')].find((x) => x.innerText.includes('关闭')); if (b) b.click(); return !!b; })()");
  await app.waitFor('!document.querySelector(' + JSON.stringify(PANEL) + ')', { timeout: 10000, message: '录音面板关闭' });
  app.assert(true, '录音面板交互通过（' + info.selects + ' 下拉 / ' + info.inputs + ' 输入 / ' + info.buttons.length + ' 按钮）');
}