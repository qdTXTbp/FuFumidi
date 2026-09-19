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
  _cached = 'v4.1.0';
  return _cached;
}

/* ── 版本比较（语义化）──────────────────────────────────────────────────
   必须是语义化比较，不能只比数字段：测试版 4.4.0-beta.1 与正式版 4.4.0 的
   数字段完全相同，只比数字会把两者判成同一个版本 —— 测试通道用户永远收不到
   更新，正式通道用户也会把测试版当成「已是最新」。
   规则（与 semver 一致）：4.4.0-beta.1 < 4.4.0-rc.1 < 4.4.0 */
export function parseVersion(v) {
  const s = String(v || '').replace(/^v/i, '').trim();
  const m = s.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return { nums: [0, 0, 0], pre: [] };
  return {
    nums: [parseInt(m[1], 10) || 0, parseInt(m[2], 10) || 0, parseInt(m[3], 10) || 0],
    pre: m[4] ? m[4].split('.') : [],
  };
}

/** 比较两个版本号：a<b 返回 -1，相等返回 0，a>b 返回 1。
 *  支持 x.y.z 与 x.y.z-beta.N / x.y.z-rc.N（预发布版小于同号正式版）。 */
export function cmpVersion(a, b) {
  const A = parseVersion(a), B = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] < B.nums[i] ? -1 : 1;
  }
  if (!A.pre.length && !B.pre.length) return 0;
  if (!A.pre.length) return 1;
  if (!B.pre.length) return -1;
  const n = Math.max(A.pre.length, B.pre.length);
  for (let i = 0; i < n; i++) {
    const x = A.pre[i], y = B.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) { const d = Number(x) - Number(y); if (d) return d < 0 ? -1 : 1; }
    else if (xn !== yn) return xn ? -1 : 1;   // 数字标识符 < 字母标识符
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/* ── 更新通道 ───────────────────────────────────────────────────────────
   'stable'（默认）：只更新到正式版（GitHub releases/latest 锚点）。
   'beta'：额外接收测试版（prerelease），提前拿到 X.Y.Z-beta.N / -rc.N。
   真正的通道分流在主进程（main/update.js）；这里的值通过检查更新与启动更新器
   的 IPC 参数传过去。localStorage 与 settings.update_channel 双写：前者保证
   启动瞬间就能读到，后者是跨设备/重装的持久值。 */
const CHANNEL_KEY = 'fufumidi_update_channel';

export function getUpdateChannel() {
  try { return localStorage.getItem(CHANNEL_KEY) === 'beta' ? 'beta' : 'stable'; } catch (e) { return 'stable'; }
}

export function setUpdateChannel(v) {
  const ch = v === 'beta' ? 'beta' : 'stable';
  try { localStorage.setItem(CHANNEL_KEY, ch); } catch (e) {}
  try {
    if (window.fuBridge && typeof window.fuBridge.saveSettings === 'function') {
      window.fuBridge.saveSettings({ update_channel: ch }).catch(() => {});
    }
  } catch (e) {}
  return ch;
}

/* ── 下载源 ───────────────────────────────────────────────────────────
   'auto'（默认）：优先国内 CNB，不可用自动回退 GitHub（镜像 → 官方）
   'cnb'：国内优先（CNB Releases 镜像）
   'github'：全球优先（GitHub 官方直连，失败回退国内镜像）
   真正的分流在主进程（main/download-source.js + main/update.js）；这里的值
   通过检查更新 / 启动更新器的 IPC 传过去。localStorage 与
   settings.download_source 双写，前者保证启动瞬间可读，后者持久化。 */
const SOURCE_KEY = 'fufumidi_download_source';

export function getDownloadSource() {
  try {
    const v = localStorage.getItem(SOURCE_KEY);
    return v === 'cnb' || v === 'github' ? v : 'auto';
  } catch (e) { return 'auto'; }
}

export function setDownloadSource(v) {
  const s = v === 'cnb' || v === 'github' ? v : 'auto';
  try { localStorage.setItem(SOURCE_KEY, s); } catch (e) {}
  try {
    if (window.fuBridge && typeof window.fuBridge.saveSettings === 'function') {
      window.fuBridge.saveSettings({ download_source: s }).catch(() => {});
    }
  } catch (e) {}
  return s;
}
