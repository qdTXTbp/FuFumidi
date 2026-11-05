/** 本地媒体 URL：Tauri 走 127.0.0.1 流式服务，Electron/浏览器保留 file://。 */
export function mediaUrl(p: string): string {
  if (!p) return '';
  const s = String(p);
  if (/^(https?:|file:|data:|blob:)/i.test(s)) return s;
  if (typeof location !== 'undefined' && location.hostname === 'tauri.localhost') {
    return 'http://127.0.0.1:47821/media?path=' + encodeURIComponent(s.replace(/\\/g, '/'));
  }
  const norm = s.replace(/\\/g, '/');
  return 'file:///' + norm.replace(/^([A-Za-z]):/, '$1:');
}
