// E2E：P2-6 AI 生成（可选、默认关）—— 专家开关可见、IPC 状态正确、未配置时明确拒绝。
export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 测试钩子已注册' });
  // 默认关闭：IPC 状态必须是 disabled（不是"假成功"）
  const off = await app.eval('window.fuBridge.ai.status()');
  app.assert(off && off.code === 'disabled' && off.ready === false, '默认关闭：' + JSON.stringify(off));
  const rejected = await app.eval("window.fuBridge.ai.generate({ kind: 'midi', prompt: 'e2e' })");
  app.assert(rejected && rejected.ok === false && rejected.code === 'disabled', '关闭时生成被拒绝：' + JSON.stringify(rejected));

  // 打开专家模式后，功能页出现 AI 生成开关
  await app.eval("window.fuBridge.saveSettings({ advanced_mode: true }).then(() => true)");
  await app.eval('location.reload()');
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 30000, message: '重载后钩子仍在' });
  await app.waitFor('!!document.querySelector("[data-guide=topbar-settings]")', { timeout: 20000 });
  await app.eval("document.querySelector('[data-guide=topbar-settings]').click()");
  await app.waitFor('!!document.querySelector("[data-guide=settings-search-input]")', { timeout: 20000 });
  await app.eval("(document.querySelector('[data-guide=set-tab-feature]') || { click() {} }).click()");
  await app.waitFor('!!document.querySelector("[data-guide=ai-generate-row]")', { timeout: 20000, message: '专家模式下 AI 生成行出现' });

  // 打开开关但命令留空 → not-configured
  await app.eval("(() => { const c = document.querySelector('[data-guide=ai-generate-toggle]'); if (!c.checked) c.click(); return c.checked; })()");
  await app.eval("document.querySelector('[data-guide=settings-save]').click()");
  await new Promise((r) => setTimeout(r, 400));
  const noCmd = await app.eval('window.fuBridge.ai.status()');
  app.assert(noCmd && noCmd.enabled === true && noCmd.code === 'not-configured', '开启但未配置命令：' + JSON.stringify(noCmd));

  // 配置一个能启动但不出 result.json 的命令 → 必须报 bad-result，而不是假成功
  await app.eval("document.querySelector('[data-guide=topbar-settings]').click()");
  await app.waitFor('!!document.querySelector("[data-guide=settings-search-input]")', { timeout: 20000 });
  await app.eval("(document.querySelector('[data-guide=set-tab-feature]') || { click() {} }).click()");
  await app.waitFor('!!document.querySelector("[data-guide=ai-generate-cmd]")', { timeout: 20000 });
  await app.eval("(() => { const i = document.querySelector('[data-guide=ai-generate-cmd]'); i.value = 'node scripts/e2e/fixtures/fake-ai-noresult.cjs'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  await app.eval("document.querySelector('[data-guide=settings-save]').click()");
  await new Promise((r) => setTimeout(r, 400));
  const ready = await app.eval('window.fuBridge.ai.status()');
  app.assert(ready && ready.code === 'ready', '配置命令后 ready：' + JSON.stringify(ready));
  const bad = await app.eval("window.fuBridge.ai.generate({ kind: 'midi', prompt: 'e2e bad result' })");
  app.assert(bad && bad.ok === false && bad.code === 'bad-result', '无 result.json 必须失败：' + JSON.stringify(bad));

  // 复原，避免污染后续用例
  await app.eval("window.fuBridge.saveSettings({ advanced_mode: false, 'ai.enabled': false, 'ai.provider_cmd': '' }).then(() => true)");
  await app.eval('location.reload()');
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 30000 });
  await app.screenshot('ai-generate');
  app.assert(true, 'AI 生成门禁与 IPC 通过');
}
