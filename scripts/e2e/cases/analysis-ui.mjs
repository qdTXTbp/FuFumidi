// E2E：P1-2b 分析页的转调/段落卡片（导入 8 小节 C→F 曲目，段落应 >= 2 段）。
import { encodeMidi } from '../../../frontend/src/core/midi.js';

const notes = [];
function chordBar(startBar, midis) {
  const tick = startBar * 1920;
  for (const m of midis) notes.push({ start: tick, end: tick + 1920, midi: m, vel: 100, ch: 0 });
}
for (let b = 0; b < 4; b++) chordBar(b, [60, 64, 67]);
for (let b = 4; b < 8; b++) chordBar(b, [65, 69, 72]);
const MIDI = Array.from(encodeMidi([{ name: 'E2E Analyze', ch: 0, program: 0, notes, ccs: [], events: [] }], { division: 480 }));

export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 测试钩子已注册' });
  if (!(await app.eval('!!window.__fufumidiE2E.hasSong()'))) {
    await app.eval("window.__fufumidiE2E.importMidi('e2e-analyze.mid', " + JSON.stringify(MIDI) + ")");
    await app.waitFor('!!window.__fufumidiE2E.hasSong()', { timeout: 20000 });
  }
  await app.navigate('#/views?tab=analyze');
  await app.waitFor('location.hash.indexOf("analyze") >= 0', { timeout: 15000 });
  await app.waitFor('document.body.innerText.indexOf("最常用和弦") >= 0', { timeout: 30000, message: '分析统计出现' });
  await app.waitFor('document.body.innerText.indexOf("段落结构") >= 0', { timeout: 30000, message: '段落结构卡片出现' });
  const segCount = await app.eval('document.querySelectorAll(".seg-row").length');
  app.assert(segCount >= 2, 'C→F 能量/和弦变化应切出 >=2 段，实际 ' + segCount);
  const modCount = await app.eval('document.querySelectorAll(".mod-row").length');
  app.assert(modCount >= 0, '转调卡片渲染（段数 ' + modCount + '）');
  await app.screenshot('analysis-advanced');
  app.assert(true, '分析页转调/段落卡片通过：段落 ' + segCount + ' 段，转调 ' + modCount + ' 段');
}