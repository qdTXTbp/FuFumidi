// ============================================================
// 启动窗口（splash）专用 preload
// 只暴露三条只读事件：状态、开始展开、淡出。保持 contextIsolation。
// ============================================================
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splashBridge', {
  onStatus: (cb) => {
    const w = (_e, s) => { try { cb(s); } catch (e) {} };
    ipcRenderer.on('splash:status', w);
    return () => ipcRenderer.removeListener('splash:status', w);
  },
  onExpand: (cb) => {
    const w = () => { try { cb(); } catch (e) {} };
    ipcRenderer.on('splash:expand', w);
    return () => ipcRenderer.removeListener('splash:expand', w);
  },
  onFade: (cb) => {
    const w = () => { try { cb(); } catch (e) {} };
    ipcRenderer.on('splash:fade', w);
    return () => ipcRenderer.removeListener('splash:fade', w);
  },
  // 卡片弹簧展开完成：主进程据此显示主窗口并淡出启动页
  expanded: () => { try { ipcRenderer.send('splash:expanded'); } catch (e) {} },
  // 告诉主进程「splash 页面已挂载，可以开始推状态」
  ready: () => { try { ipcRenderer.send('splash:ui-ready'); } catch (e) {} },
});
