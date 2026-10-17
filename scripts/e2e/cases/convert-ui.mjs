// E2E：P0-4b 导出面板在真实应用里挂载正常（格式/响度/dither/限幅/分轨控件都在）。
// 不点「渲染并导出」：那会弹原生保存框，阻塞自动化；落盘链路已由 export-ipc 用例覆盖。
import { encodeMidi } from '../../../frontend/src/core/midi.js';

const MINI = Array.from(encodeMidi([{
  name: 'E2E Convert', ch: 0, program: 0,
  notes: [{ start: 0, end: 480, midi: 60, vel: 100, ch: 0 }], ccs: [], events: [],
}], { division: 480 }));

const PROBE = [
  "JSON.stringify((() => {",
  "  const labels = [...document.querySelectorAll('label')].map((x) => x.textContent.trim());",
  "  const selects = [...document.querySelectorAll('select')].length;",
  "  const checks = [...document.querySelectorAll('input[type=checkbox]')].length;",
  "  const opts = [...document.querySelectorAll('select')].map((s) => [...s.options].map((o) => o.textContent.trim()));",
  "  return { labels, selects, checks, opts };",
  "})())",
].join(' ');

export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 测试钩子已注册' });
  if (!(await app.eval('!!window.__fufumidiE2E.hasSong()'))) {
    await app.eval("window.__fufumidiE2E.importMidi('e2e-convert.mid', " + JSON.stringify(MINI) + ")");
    await app.waitFor('!!window.__fufumidiE2E.hasSong()', { timeout: 20000 });
  }
  await app.navigate('#/convert');
  await app.waitFor('location.hash.indexOf("convert") >= 0', { timeout: 15000, message: '路由到转换页' });
  await app.waitFor('document.body.innerText.indexOf("音频导出") >= 0', { timeout: 20000, message: '音频导出卡片出现' });
  const r = JSON.parse(await app.eval(PROBE));
  const allOpts = r.opts.flat().join('|');
  app.assert(r.labels.some((x) => x.indexOf('导出格式') >= 0), '有「导出格式」控件：' + JSON.stringify(r.labels).slice(0, 200));
  app.assert(r.labels.some((x) => x.indexOf('响度目标') >= 0), '有「响度目标」控件');
  app.assert(r.labels.some((x) => x.indexOf('分轨') >= 0), '有「分轨导出」开关');
  app.assert(r.checks >= 3, '至少 3 个复选框（dither/限幅/分轨），实际 ' + r.checks);
  app.assert(allOpts.indexOf('WAV 24-bit') >= 0 && allOpts.indexOf('WAV 16-bit') >= 0, '格式选项齐全');
  app.assert(allOpts.indexOf('LUFS') >= 0, '响度目标选项齐全');
  app.assert(true, '导出面板挂载正常：' + r.selects + ' 个下拉、' + r.checks + ' 个复选框');
}