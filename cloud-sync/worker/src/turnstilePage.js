// ============================================================
// 托管的 Turnstile 页面
//
// 电脑端（Electron）与手机端（原生 Compose）都无法直接嵌 Turnstile：
// 前者页面来源是本地协议、后者没有官方原生 SDK。
// 因此在本域名下托管此页，两端分别用 iframe / WebView 加载，
// 页面拿到 token 后回传：
//   - iframe：postMessage 给父页面
//   - Android WebView：调用注入的 JS 桥 AndroidBridge.onToken()
// ============================================================

export function turnstileHtml(siteKey) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>人机验证</title>
<style>
  html,body{margin:0;padding:0;background:transparent;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  #wrap{display:flex;align-items:center;justify-content:center;min-height:70px;padding:4px}
  #hint{font-size:12px;color:#8a8f98}
  #err{font-size:12px;color:#e05858;max-width:320px;text-align:center;line-height:1.5}
</style>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>
</head>
<body>
<div id="wrap">
  <div id="ts"></div>
  <div id="hint">正在加载人机验证…</div>
  <div id="err" style="display:none"></div>
</div>
<script>
  var SITEKEY = ${JSON.stringify(siteKey)};

  function post(msg) {
    // iframe -> 父页面
    try { if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*'); } catch (e) {}
    // Android WebView -> JS 桥
    try {
      if (window.AndroidBridge && window.AndroidBridge.onMessage) {
        window.AndroidBridge.onMessage(JSON.stringify(msg));
      }
    } catch (e) {}
  }

  function fail(text) {
    var e = document.getElementById('err');
    var h = document.getElementById('hint');
    if (h) h.style.display = 'none';
    if (e) { e.style.display = 'block'; e.textContent = text; }
    post({ type: 'turnstile-error', error: text });
  }

  function render() {
    if (!(window.turnstile && window.turnstile.render)) { setTimeout(render, 120); return; }
    var h = document.getElementById('hint');
    if (h) h.style.display = 'none';
    try {
      window.turnstile.render('#ts', {
        sitekey: SITEKEY,
        theme: 'auto',
        callback: function (token) { post({ type: 'turnstile-token', token: token }); },
        'error-callback': function () { fail('人机验证加载失败，请检查网络后重试'); },
        'expired-callback': function () { post({ type: 'turnstile-expired' }); }
      });
    } catch (e) {
      fail('人机验证初始化失败：' + e);
    }
  }

  // 脚本本身都加载不到（如网络不通）：给出可见提示而不是干等
  setTimeout(function () {
    if (!(window.turnstile && window.turnstile.render)) {
      fail('无法加载人机验证组件（challenges.cloudflare.com 不可达）');
    }
  }, 8000);

  render();
</script>
</body>
</html>`;
}
