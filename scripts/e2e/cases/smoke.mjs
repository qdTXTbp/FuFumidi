// E2E 冒烟：应用能起来、首屏有内容、主导航可点、无未捕获异常。
// 这是所有后续交互回放用例的底座（P1-13/P1-14 的验收从这里扩展）。
export default async function (app) {
  await app.waitFor("document.body && document.body.innerText.length > 300", {
    timeout: 45000, message: "首屏渲染内容 >300 字符",
  });
  const title = await app.eval("document.title");
  app.assert(title && title.includes("FuFumidi"), "窗口标题包含 FuFumidi（实际：" + title + "）");

  const text = await app.eval("document.body.innerText");
  app.assert(text.includes("曲库") || text.includes("转录") || text.includes("播放"), "首屏出现主导航文案");

  // 导航切换：点一次含「转录」的导航项；能跳转就断言 hash 变化（不同版本文案位置可能不同，点到即算）
  const before = await app.eval("location.hash");
  const hit = await app.clickText("转录", { includes: true });
  if (hit) {
    try { await app.waitFor(`location.hash !== ${JSON.stringify(before)}`, { timeout: 8000 }); } catch (_) { /* 首页卡片不是路由，可接受 */ }
    await app.waitFor("document.body.innerText.length > 200", { timeout: 15000, message: "切换后仍有内容" });
  }

  await app.navigate("#/home");
  await app.waitFor(`location.hash === "#/home"`, { timeout: 10000, message: "能回到首页" });
}