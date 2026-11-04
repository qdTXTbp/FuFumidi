// E2E：智能分轨行 —— 模型状态可见、预算选项齐全、关闭智能分轨时预算禁用。
export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 钩子' });
  await new Promise((r) => setTimeout(r, 800));
  let mounted = false;
  for (let i = 0; i < 4 && !mounted; i++) {
    await app.navigate('#/transcribe');
    try {
      await app.waitFor('location.hash.indexOf("transcribe") >= 0 && !!document.querySelector(".tr-stem-row")', { timeout: 5000 });
      mounted = true;
    } catch (e) { await new Promise((r) => setTimeout(r, 400)); }
  }
  app.assert(mounted, '转录页与智能分轨行挂载');

  const probe = JSON.parse(await app.eval(`JSON.stringify((() => {
    const row = document.querySelector('.tr-stem-row');
    const sel = row && row.querySelector('select.select-input');
    const cb = row && row.querySelector('input[type=checkbox]');
    const badge = row && row.querySelector('.ms-badge');
    return {
      hasRow: !!row, hasToggle: !!cb, hasBudget: !!sel,
      options: sel ? [...sel.options].map((o) => o.value) : [],
      budgetDisabled: sel ? sel.disabled : null,
      badgeText: badge ? badge.textContent.trim() : '',
      hasStatus: !!row.querySelector('.tr-stem-status'),
      guide: !!row.querySelector('[data-guide=stem-to-resources], .fu-badge'),
    };
  })())`));
  app.assert(probe.hasRow && probe.hasToggle && probe.hasBudget, '智能分轨行含开关与预算：' + JSON.stringify(probe));
  app.assert(JSON.stringify(probe.options) === JSON.stringify(['auto', '6', '12', '16', 'all']), '预算选项齐全：' + JSON.stringify(probe.options));
  app.assert(probe.hasStatus && probe.badgeText.length > 0, '模型状态可见：' + probe.badgeText);

  // 关掉智能分轨 → 预算禁用；再打开恢复
  await app.eval("(() => { const cb = document.querySelector('.tr-stem-row input[type=checkbox]'); cb.click(); return true; })()");
  await new Promise((r) => setTimeout(r, 250));
  const off = await app.eval("document.querySelector('.tr-stem-row select.select-input').disabled");
  app.assert(off === true, '关闭智能分轨后预算禁用');
  await app.eval("(() => { const cb = document.querySelector('.tr-stem-row input[type=checkbox]'); cb.click(); return true; })()");
  await new Promise((r) => setTimeout(r, 250));
  const on = await app.eval("document.querySelector('.tr-stem-row select.select-input').disabled");
  app.assert(on === false, '重新打开后预算可用');
}
