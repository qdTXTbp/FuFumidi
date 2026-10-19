// ============================================================
// 主进程设置服务：设置读写深合并、MIDI 文件关联注册表开关
// ============================================================
'use strict';

const path = require('path');
const fs = require('fs');
const { DEFAULT_SETTINGS } = require('./settings');

/** Windows 文件关联 ProgID 的图标来自哪里：
 *  - 打包版：安装后的 FuFumidi.exe 自带 logo，用 exe,0；
 *  - 开发版：electron.exe 的图标是 Electron logo（用户看到「图标丢失/不是本工具 logo」的根因），
 *    改用仓库 build/icon.ico；找不到才退回 exe。
 *  这个值只在注册表写入，不参与渲染。
 */
function fileAssocIconSpec({ app }) {
  try {
    if (app && app.isPackaged) return `"${process.execPath}",0`;
  } catch (e) {}
  const devIcon = path.join(__dirname, '..', 'build', 'icon.ico');
  if (fs.existsSync(devIcon)) return `"${devIcon}",0`;
  return `"${process.execPath}",0`;
}

function registerSettingsIpc({ ipcMain, readSettings, writeSettings, db }) {
  // 设置（深合并嵌套键 + 原子写入）
  ipcMain.handle('settings:load', async () => {
    const fileSettings = readSettings();
    if (db && typeof db.kvGet === 'function') {
      try {
        const sqliteSettings = await db.kvGet('settings');
        if (sqliteSettings && typeof sqliteSettings === 'object') {
          // SQLite 优先，但必须与 DEFAULT_SETTINGS / settings.json 合并，
          // 否则旧快照缺失的默认字段（如 wallpaper_prompt_done）会变成 undefined，
          // 导致「是否首次启动」等判断失效。
          return { ...DEFAULT_SETTINGS, ...fileSettings, ...sqliteSettings };
        }
      } catch (e) {}
      // 首次迁移：把 settings.json 写入 SQLite
      try { await db.kvSet('settings', fileSettings); } catch (e) {}
    }
    return fileSettings;
  });
  ipcMain.handle('settings:save', async (_e, s) => {
    const cur = readSettings();
    const merged = { ...cur, ...(s || {}) };
    for (const k of ['transcribe_params']) {   // 嵌套对象白名单：深合并，避免部分更新丢失兄弟键
      if (s && s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) {
        merged[k] = { ...(cur[k] || {}), ...s[k] };
      }
    }
    writeSettings(merged);
    if (db && typeof db.kvSet === 'function') {
      try { await db.kvSet('settings', merged); } catch (e) {}
    }
    // 返回 { ok } 让前端 store 能正确回写内存，而不是返回裸 settings 对象（r.ok 恒为 undefined）
    return { ok: true, settings: readSettings() };
  });

  // MIDI 文件关联开关（默认开）：通过 HKCU 注册表覆盖 .mid/.midi 的默认打开程序。
  // 开启 → 指向 FuFumidi（新建 FuFumidi.MIDI ProgID + 关联）；关闭 → 移除 HKCU 覆盖，
  // 回落到系统默认程序。仅在 Windows 生效，其它平台返回 {ok:false, reason:'unsupported'}。
  async function applyFileAssoc(enabled) {
    if (process.platform !== 'win32') return { ok: false, reason: 'unsupported' };
    const { execFile } = require('child_process');
    const exe = process.execPath;
    const iconSpec = fileAssocIconSpec({ app: require('electron').app });
    const progID = 'FuFumidi.MIDI';
    const run = (args) => new Promise((res) => {
      execFile('reg.exe', args, { windowsHide: true }, (err) => res(!err));
    });
    const hkcu = 'HKCU\\Software\\Classes';
    try {
      if (enabled) {
        // ProgID 定义（打开命令） + 扩展名默认值指向 ProgID
        await run(['add', `${hkcu}\\${progID}\\shell\\open\\command`, '/ve', '/d', `"${exe}" "%1"`, '/f']);
        await run(['add', `${hkcu}\\${progID}\\DefaultIcon`, '/ve', '/d', iconSpec, '/f']);
        await run(['add', `${hkcu}\\.mid`, '/ve', '/d', progID, '/f']);
        await run(['add', `${hkcu}\\.midi`, '/ve', '/d', progID, '/f']);
        // 让资源管理器刷新图标缓存（失败不影响关联本身）
        try { execFile('ie4uinit.exe', ['-show'], { windowsHide: true }, () => {}); } catch (e) {}
      } else {
        // 删除 HKCU 覆盖（NSIS 安装时注册的 HKCR 关联由系统回退）
        await run(['delete', `${hkcu}\\.mid`, '/f']);
        await run(['delete', `${hkcu}\\.midi`, '/f']);
        await run(['delete', `${hkcu}\\${progID}`, '/f']);
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }

  ipcMain.handle('settings:fileAssoc', async (_e, enabled) => applyFileAssoc(enabled));

  // 启动自愈：打包版每次启动按设置重写 HKCU 关联与图标。
  // 必须做：用户升级/换安装路径后注册表里可能残留旧路径或 Electron 图标，
  // 表现就是「MIDI 文件图标丢失，不是本工具 logo」（本条 bug 的根因）。
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) {
      setTimeout(() => {
        try {
          const s = readSettings();
          if (s && s.file_assoc !== false) {
            applyFileAssoc(true).catch(() => {});
          }
        } catch (e) {}
      }, 3000).unref?.();
    }
  } catch (e) {}
}

module.exports = { registerSettingsIpc };
