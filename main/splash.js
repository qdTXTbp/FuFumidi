// ============================================================
// 启动窗口（splash）
//
// 实现方式：启动页是一个覆盖 workArea 的**不透明**置顶窗口（深色底 + 居中卡片）；
// 加载完成后卡片在渲染层用弹簧参数扩展满整个窗口，再通知主进程显示主窗口。
//
// 为什么不用透明窗口 / 逐帧 setBounds：
//   · 透明 + 全屏窗口在部分显卡与远程桌面上容易闪烁甚至崩溃；
//   · 逐帧改 OS 窗口尺寸在 Windows 上会有明显重绘抖动；
//   · 弹簧动画放在渲染层，和设计稿完全同一套参数，60fps 稳定。
// ============================================================
'use strict';

const path = require('path');
const fs = require('fs');

/** 打包后读 renderer/dist/splash.html；源码环境回退到 frontend/public */
function splashFile(rootDir) {
  const cands = [
    path.join(rootDir, 'renderer', 'dist', 'splash.html'),
    path.join(rootDir, 'frontend', 'public', 'splash.html'),
  ];
  for (const p of cands) {
    try { if (fs.existsSync(p)) return p; } catch (e) { /* 忽略：继续找下一个 */ }
  }
  return cands[0];
}

function create({ BrowserWindow, screen, rootDir }) {
  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    frame: false,
    backgroundColor: '#070b12',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    hasShadow: false,
    title: 'FuFumidi',
    webPreferences: {
      preload: path.join(rootDir, 'preload-splash.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 与主窗口一致：部分机器开启沙箱会让 GPU/渲染子进程启动即崩溃
      sandbox: false,
      backgroundThrottling: false,
      devTools: false,
    },
  });
  try { win.setMenuBarVisibility(false); } catch (e) { /* 无边框窗口没有菜单栏 */ }
  win.loadFile(splashFile(rootDir));
  win.once('ready-to-show', () => { try { win.show(); } catch (e) { /* 窗口可能已被销毁 */ } });
  return win;
}

function send(win, channel, payload) {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send(channel, payload); } catch (e) { /* 页面尚未就绪 */ }
}

function sendStatus(win, stage, pct, key, text) {
  send(win, 'splash:status', { stage, pct, key, text });
}
function sendExpand(win) { send(win, 'splash:expand'); }
function destroy(win) {
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) { /* 忽略 */ }
}
/** 窗口整体淡出（Windows/macOS 支持 setOpacity；不支持时直接销毁） */
function fadeOut(win, ms = 200) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) { resolve(); return; }
    const steps = Math.max(1, Math.round(ms / 16));
    let i = 0;
    let ok = true;
    const timer = setInterval(() => {
      i += 1;
      try { win.setOpacity(Math.max(0, 1 - i / steps)); } catch (e) { ok = false; }
      if (i >= steps || !ok) {
        clearInterval(timer);
        destroy(win);
        resolve();
      }
    }, 16);
  });
}

module.exports = { create, sendStatus, sendExpand, fadeOut, destroy };
