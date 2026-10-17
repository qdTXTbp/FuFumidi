// E2E 交互回放（最小版）：造一首最小 MIDI → 进编辑页 → 画布存在 → 撤销/重做/播放不崩。
// 数据根是隔离的（scripts/e2e/lib.mjs 会传 FUFUMIDI_E2E_DATA_ROOT），所以这里必须自己造曲目。
// P1-13（编辑器交互语言）会把这里扩成「手势脚本」：点击/拖拽/修饰键/吸附逐一回放。
import { encodeMidi } from '../../../frontend/src/core/midi.js';

const MINI = Array.from(encodeMidi([{
  name: "E2E Mini", ch: 0, program: 0,
  notes: [
    { start: 0, end: 480, midi: 60, vel: 100, ch: 0 },
    { start: 480, end: 960, midi: 64, vel: 90, ch: 0 },
    { start: 960, end: 1440, midi: 67, vel: 95, ch: 0 },
  ],
  ccs: [], events: [],
}], { division: 480 }));

export default async function (app) {
  await app.waitFor("document.body && document.body.innerText.length > 100", { timeout: 30000, message: "首屏有内容" });
  const hasSong = await app.eval("!!(window.__fufumidiE2E && window.__fufumidiE2E.hasSong())");
  if (!hasSong) {
    await app.waitFor("!!(window.__fufumidiE2E)", { timeout: 15000, message: "E2E 测试钩子已注册" });
    await app.eval("window.__fufumidiE2E.importMidi('e2e-mini.mid', " + JSON.stringify(MINI) + ")");
    await app.waitFor("!!(window.__fufumidiE2E && window.__fufumidiE2E.hasSong())", { timeout: 20000, message: "导入最小 MIDI 后有当前曲目" });
  }
  await app.navigate("#/edit");
  await app.waitFor('location.hash.indexOf("edit") >= 0', { timeout: 15000, message: "路由到编辑页" });
  await app.waitFor("!!document.querySelector('canvas')", { timeout: 30000, message: "编辑页出现 canvas" });

  await app.key("Ctrl+Z");
  await app.key("Ctrl+Shift+Z");
  await app.key("Space");
  await new Promise((r) => setTimeout(r, 300));
  await app.key("Space");

  const hasCanvas = await app.eval("!!document.querySelector('canvas')");
  app.assert(hasCanvas, "交互后编辑画布仍在");
}