// ============================================================
// 主进程设置服务：设置读写深合并、MIDI 文件关联注册表开关
// ============================================================
'use strict';

function registerSettingsIpc({ ipcMain, readSettings, writeSettings, db }) {
  // 设置（深合并嵌套键 + 原子写入）
  ipcMain.handle('settings:load', async () => {
    const fileSettings = readSettings();
    if (db && typeof db.kvGet === 'function') {
      try {
        const sqliteSettings = await db.kvGet('settings');
        if (sqliteSettings && typeof sqliteSettings === 'object') {
          // 以 SQLite 为准（settings.json 作为旧备份/降级）
          return sqliteSettings;
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
    return readSettings();
  });

  // MIDI 文件关联开关（默认开）：通过 HKCU 注册表覆盖 .mid/.midi 的默认打开程序。
  // 开启 → 指向 FuFumidi（新建 FuFumidi.MIDI ProgID + 关联）；关闭 → 移除 HKCU 覆盖，
  // 回落到系统默认程序。仅在 Windows 生效，其它平台返回 {ok:false, reason:'unsupported'}。
  ipcMain.handle('settings:fileAssoc', async (_e, enabled) => {
    if (process.platform !== 'win32') return { ok: false, reason: 'unsupported' };
    const { execFile } = require('child_process');
    const exe = process.execPath;
    const progID = 'FuFumidi.MIDI';
    const run = (args) => new Promise((res) => {
      execFile('reg.exe', args, { windowsHide: true }, (err) => res(!err));
    });
    const hkcu = 'HKCU\\Software\\Classes';
    try {
      if (enabled) {
        // ProgID 定义（打开命令） + 扩展名默认值指向 ProgID
        await run(['add', `${hkcu}\\${progID}\\shell\\open\\command`, '/ve', '/d', `"${exe}" "%1"`, '/f']);
        await run(['add', `${hkcu}\\${progID}\\DefaultIcon`, '/ve', '/d', `"${exe}",0`, '/f']);
        await run(['add', `${hkcu}\\.mid`, '/ve', '/d', progID, '/f']);
        await run(['add', `${hkcu}\\.midi`, '/ve', '/d', progID, '/f']);
      } else {
        // 删除 HKCU 覆盖（NSIS 安装时注册的 HKCR 关联由系统回退）
        await run(['delete', `${hkcu}\\.mid`, '/f']);
        await run(['delete', `${hkcu}\\.midi`, '/f']);
        await run(['delete', `${hkcu}\\${progID}`, '/f']);
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });
}

module.exports = { registerSettingsIpc };
