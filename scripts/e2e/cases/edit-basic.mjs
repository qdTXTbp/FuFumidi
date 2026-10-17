// E2E 交互回放（最小版）：进编辑页 → 画布存在 → 撤销/重做/播放不崩。
// P1-13（编辑器交互语言）会把这里扩成「手势脚本」：点击/拖拽/修饰键/吸附逐一回放。
export default async function (app) {
  await app.waitFor("document.body", { timeout: 30000 });
  await app.navigate("#/edit");
  await app.waitFor(`location.hash.indexOf("edit") >= 0`, { timeout: 15000, message: "路由到编辑页" });
  await app.waitFor("!!document.querySelector('canvas')", { timeout: 30000, message: "编辑页出现 canvas" });

  // 键盘交互：撤销/重做/播放空转，验证全局快捷键链路不抛异常
  await app.key("Ctrl+Z");
  await app.key("Ctrl+Shift+Z");
  await app.key("Space");
  await new Promise((r) => setTimeout(r, 300));
  await app.key("Space");

  const hasCanvas = await app.eval("!!document.querySelector('canvas')");
  app.assert(hasCanvas, "交互后编辑画布仍在");
}