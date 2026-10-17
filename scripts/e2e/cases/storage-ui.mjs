// E2E：P1-9 存储治理页 —— 分类占用表、总计、曲库 protected、刷新。

export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 测试钩子已注册' });
  await app.navigate('#/resources?tab=storage');
  await app.waitFor('location.hash.indexOf("storage") >= 0', { timeout: 15000 });
  await app.waitFor('!!document.querySelector("[data-guide=storage-panel]")', { timeout: 30000, message: '存储面板出现' });
  await app.waitFor('document.body.innerText.indexOf("存储治理") >= 0', { timeout: 15000 });
  const info = JSON.parse(await app.eval('JSON.stringify({ rows: document.querySelectorAll(".st-row").length, areas: document.querySelectorAll("[data-area]").length, text: document.querySelector("[data-guide=storage-panel]").innerText })'));
  app.assert(info.areas >= 8, '分类行数 >= 8，实际 ' + info.areas);
  app.assert(info.text.indexOf('总计') >= 0, '有总计');
  app.assert(info.text.indexOf('曲库') >= 0, '曲库类别出现');
  app.assert(info.text.indexOf('不可清理') >= 0, '曲库标记为不可清理');
  const before = info.text;
  await app.eval("(() => { const b = [...document.querySelectorAll('[data-guide=storage-panel] button')].find((x) => x.innerText.trim() === '刷新'); if (b) b.click(); return !!b; })()");
  await new Promise((r) => setTimeout(r, 500));
  const after = await app.eval('document.querySelector("[data-guide=storage-panel]").innerText');
  app.assert(after.length > 50, '刷新后仍有内容');
  await app.screenshot('storage-governance');
  app.assert(true, '存储治理页通过：' + info.areas + ' 个分类，刷新前后 ' + before.length + '/' + after.length + ' 字符');
}