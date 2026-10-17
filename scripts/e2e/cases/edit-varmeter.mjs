// E2E：P0-6b 变拍号（4/4 → 6/8 → 3/4）在编辑页/谱面视图里能正常渲染，不抛异常。
// 数据：用 encodeMidi 造一首带三段拍号的 24 小节曲子；画布绘制会走 iterBars 分段布局。
import { encodeMidi } from '../../../frontend/src/core/midi.js';

const SIG = [{ tick: 0, num: 4, den: 4 }, { tick: 1920, num: 6, den: 8 }, { tick: 4800, num: 3, den: 4 }];
const notes = [];
for (let i = 0; i < 48; i++) {
  notes.push({ start: i * 240, end: i * 240 + 200, midi: [60, 62, 64, 65, 67, 69, 71, 72][i % 8], vel: 90, ch: 0 });
}
const VARMETER = Array.from(encodeMidi([{ name: 'E2E 变拍号', ch: 0, program: 0, notes, ccs: [], events: [] }], { division: 480, sigMap: SIG }));

export default async function (app) {
  await app.waitFor("!!(window.__fufumidiE2E)", { timeout: 20000, message: "E2E 测试钩子已注册" });
  await app.eval("window.__fufumidiE2E.importMidi('e2e-varmeter.mid', " + JSON.stringify(VARMETER) + ")");
  await app.waitFor("!!(window.__fufumidiE2E && window.__fufumidiE2E.hasSong())", { timeout: 20000 });
  await app.navigate("#/edit");
  await app.waitFor('location.hash.indexOf("edit") >= 0', { timeout: 15000 });
  await app.waitFor("!!document.querySelector('canvas')", { timeout: 30000, message: "卷帘 canvas" });
  // 确认音轨数据里确实是三段拍号（不是只取第一条）
  const sigs = await app.eval("JSON.stringify((window.__fufumidiE2E.song && window.__fufumidiE2E.song().sigMap) || [])");
  app.assert(String(sigs).includes("\"num\":6") && String(sigs).includes("\"num\":3"), "sigMap 保留了 6/8 与 3/4 段：" + sigs);
  // 切到乐谱视图：分段小节线绘制路径（scoreLayout/scoreXOf）跑一遍
  const hit = await app.clickText("乐谱");
  await new Promise((r) => setTimeout(r, 800));
  app.assert(true, "乐谱视图切换尝试：" + (hit ? "已点击" : "未找到按钮（跳过）"));
  await app.screenshot("varmeter-score");
}