// ============================================================
// 导出 / 保存对话框的默认目录 —— 全应用唯一决策点
// ============================================================
// 历史：每个导出 handler 都各自写死 app.getPath('downloads')。用户在设置里
// 明明有「默认输出目录」，那一项却只管转录结果，于是导出 MusicXML 时保存框
// 永远落在系统下载目录，批量导出又得一首一首点（B 站 2026-11-09 反馈）。
//
// 现在统一读「设置 → 功能 → 导出默认目录」(export.default_dir)：
//   · 用户指定且目录仍存在          → 用之；
//   · 未填 / 被删 / 无权限 / 读失败 → 回落系统下载目录，保持旧行为。
// 目录有效性每次都查，不缓存：用户可能随时在资源管理器里删掉或改设置。
//
// ★ settings.js 在这里是**懒 require**：主进程之外的单测 require 本模块时，
//   不会因为 electron 的 app 没就绪而炸掉；readSettings 也可注入，方便测试。
'use strict';
const fs = require('fs');

/**
 * @param {object} [app] Electron 的 app（用于回落 downloads）
 * @param {Function} [readSettings] 注入的设置读取函数（测试用）
 * @returns {string} 可用的默认导出目录；连 downloads 都拿不到时返回 ''
 */
function exportDefaultDir(app, readSettings) {
  let preferred = '';
  try {
    const read = readSettings || (() => require('./settings').readSettings());
    const s = read() || {};
    preferred = String(s['export.default_dir'] || '').trim();
  } catch (e) {
    preferred = ''; // 设置未加载 / 文件损坏：按「未配置」处理
  }
  if (preferred) {
    try {
      if (fs.statSync(preferred).isDirectory()) return preferred;
    } catch (e) {
      preferred = ''; // 目录被删或不可访问：不要把死路径交给保存对话框
    }
  }
  try { return (app && typeof app.getPath === 'function' && app.getPath('downloads')) || ''; }
  catch (e) { return ''; }
}

/** 保存对话框的 defaultPath = 默认目录 + 文件名（目录不可用时只给文件名） */
function saveDefaultPath(app, path, name, readSettings) {
  const dir = exportDefaultDir(app, readSettings);
  return dir ? path.join(dir, String(name || '')) : String(name || '');
}

module.exports = { exportDefaultDir, saveDefaultPath };
