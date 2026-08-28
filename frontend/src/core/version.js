// 应用版本号：统一从主进程 app.getVersion() 读取（带缓存）。
// 浏览器/开发模式无桥接时回退到内置默认值，避免界面硬编码各写一份导致不一致。
let _cached = null;
export async function getAppVersion() {
  if (_cached) return _cached;
  try {
    const b = window.fuBridge;
    if (b && b.getVersion) {
      const v = await b.getVersion();
      if (v) { _cached = 'v' + String(v).replace(/^v/i, ''); return _cached; }
    }
  } catch (e) { /* 忽略，走回退 */ }
  _cached = 'v3.1.4';
  return _cached;
}
