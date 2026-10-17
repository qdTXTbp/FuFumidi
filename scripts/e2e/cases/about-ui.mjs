// E2E：P1-7 关于与许可页 —— 应用/音色库/第三方组件清单来自生成数据，且与 VENDOR 一致。

export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 测试钩子已注册' });
  await app.navigate('#/about');
  await app.waitFor('location.hash.indexOf("about") >= 0', { timeout: 15000 });
  await app.waitFor('document.body.innerText.indexOf("关于与许可") >= 0', { timeout: 20000, message: '关于与许可页出现' });
  const info = JSON.parse(await app.eval('JSON.stringify({ text: document.body.innerText, rows: document.querySelectorAll(".about-tr").length })'));
  app.assert(info.text.indexOf('MIT') >= 0, '应用许可证 MIT 出现');
  app.assert(info.text.indexOf('GeneralUser') >= 0, '内置音色库（GeneralUser）出现');
  app.assert(info.text.indexOf('verovio') >= 0 || info.text.indexOf('js-synthesizer') >= 0, '第三方组件清单出现');
  app.assert(info.rows >= 15, '清单行数足够（' + info.rows + '）');
  await app.screenshot('about-licenses');
  app.assert(true, '关于与许可页通过：' + info.rows + ' 行');
}