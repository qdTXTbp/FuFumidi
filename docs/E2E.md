# E2E（交互回放）测试

v6.0.0 起引入。目的：给「编辑器交互语言 / App Shell / 命令 / 会话」这类**只能用行为描述**的验收提供可执行底座。

## 运行

```powershell
npm run test:e2e                 # 全部用例
npm run test:e2e -- smoke        # 只跑名字含 smoke 的用例
npm run test:e2e -- smoke --keep # 失败时不关实例（配合 CDP 手动看）
```

- 每个用例起一个**独立开发态实例**（`electron .` + `FUFUMIDI_E2E=1`），不碰你正在用的安装版窗口；
- 数据根落在仓库下 `FuFumidiData/`（已 gitignore，不要提交）；
- 产物：`scripts/e2e/artifacts/`（应用日志 + 失败截图），CI 里作为失败附件。

## 为什么不用 Playwright

Electron 自带 CDP，Node 22 又有全局 `WebSocket`：直接用 `Runtime.evaluate` / `Input.dispatchKeyEvent` / `Page.captureScreenshot` 就能完成交互回放，**零新增依赖**，也不用和 Electron 版本绑定。实现见 `scripts/e2e/lib.mjs`。

## 写一个用例

```js
// scripts/e2e/cases/<name>.mjs
export default async function (app) {
  await app.waitFor("document.body.innerText.length > 300", { timeout: 45000 });
  await app.navigate("#/edit");
  await app.click("button.save");          // CSS 选择器
  await app.clickText("导出 MIDI");        // 文案点击（容忍实现变化）
  await app.key("Ctrl+S");                 // 组合键
  await app.type("hello");                 // 文本输入
  const p = await app.screenshot("after-save");
  app.assert(await app.eval("!!document.querySelector('.toast')"), "保存后有提示");
}
```

约定：
1. 断言失败用 `app.assert`，用例只管行为，不管实现细节（尽量按文案/角色定位）；
2. 会写盘的用例必须用自己的临时目录（`os.tmpdir()`），禁止动真实曲库；
3. 用例之间不得共享状态（每个用例一个新实例）；
4. 新交互上线时必须**先加用例再合并**（P1-13/P1-14 的 PR 规则）。

## 门禁位置

- 本地/批次：`npm run test:e2e -- smoke`（G4 门禁）；
- 发布前：`npm run test:e2e` 全绿 + 安装版冒烟（`deploy-installed.cjs`）；
- 目前用例：`smoke`（首屏/导航/无异常）、`edit-basic`（编辑页画布 + 撤销重做快捷键）。