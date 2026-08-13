// ============================================================
// example-hello 渲染层脚本（可选字段 renderer）
// 运行在界面环境，可使用 window.fuBridge 与 DOM。
// 主进程插件可通过 ctx.ui.broadcast(name, payload) 通知本脚本，
// 本脚本用 window.addEventListener('fuplugin:<id>:<name>', fn) 接收。
// ============================================================
(function () {
  const id = 'example-hello';
  window.addEventListener('fuplugin:' + id + ':greet', function (ev) {
    toast('[插件] 收到广播：' + (ev.detail && ev.detail.text || ''), 'ok');
  });
  console.log('[plugin:example-hello] 渲染脚本已加载');
})();
