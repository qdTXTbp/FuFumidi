// ============================================================
// 可选 Rust 核心服务：检测本地编译的 fufumidi-core 二进制，
// 未打包/未编译时优雅降级，不影响纯 Python + Electron 运行。
// ============================================================
'use strict';

const { execFile } = require('child_process');

function createRustService({ app, path, fs }) {
  const EXE = process.platform === 'win32' ? 'fufumidi-core.exe' : 'fufumidi-core';

  function binaryPath() {
    const candidates = [
      path.join(process.resourcesPath, 'rust-core', EXE),
      path.join(process.resourcesPath, 'bin', EXE),
      path.join(app.getAppPath(), 'rust-core', EXE),
    ];
    for (const p of candidates) if (fs.existsSync(p)) return p;
    return null;
  }

  function available() { return !!binaryPath(); }

  function invoke(args, timeoutMs = 5000) {
    const bin = binaryPath();
    if (!bin) return Promise.resolve({ ok: false, error: 'rust_core_not_available', reason: '未找到 Rust 核心二进制' });
    const input = Array.isArray(args) ? args : [args || 'ping'];
    return new Promise((resolve) => {
      execFile(bin, input, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: String(err.message || err), stderr: String(stderr || '').slice(-400) });
          return;
        }
        try {
          const d = JSON.parse(String(stdout || '').trim());
          resolve({ ok: !!d.ok, ...d });
        } catch (e) {
          resolve({ ok: false, error: 'rust_core_bad_output', raw: String(stdout || '').slice(-400) });
        }
      });
    });
  }

  function registerRustIpc({ ipcMain }) {
    ipcMain.handle('rust:status', () => {
      const bin = binaryPath();
      return { ok: !!bin, available: !!bin, binary: bin, version: '0.1.0' };
    });
    ipcMain.handle('rust:invoke', (_e, cmd, args) => invoke([cmd].concat(Array.isArray(args) ? args : [])));
  }

  return { binaryPath, available, invoke, registerRustIpc };
}

module.exports = { createRustService };
