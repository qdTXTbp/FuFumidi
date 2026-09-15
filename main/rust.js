// ============================================================
// 可选 Rust 核心服务：检测本地编译的 fufumidi-core 二进制，
// 未打包/未编译时优雅降级，不影响纯 Python + Electron 运行。
// ============================================================
'use strict';

const { execFile } = require('child_process');

function createRustService({ app, path, fs }) {
  const EXE = process.platform === 'win32' ? 'fufumidi-core.exe' : 'fufumidi-core';
  // 版本探测结果缓存：二进制不会在运行期变化，探一次即可
  let _probe = null;
  let _probing = null;

  function binaryPath() {
    const candidates = [
      path.join(process.resourcesPath, 'rust-core', EXE),
      path.join(process.resourcesPath, 'bin', EXE),
      path.join(app.getAppPath(), 'rust-core', EXE),
      path.join(app.getAppPath(), '..', 'resources', 'rust-core', EXE),
      path.join(__dirname, '..', 'resources', 'rust-core', EXE),
    ];
    for (const p of candidates) {
      try { if (p && fs.existsSync(p)) return p; } catch (_) {}
    }
    return null;
  }

  function available() { return !!binaryPath(); }

  function invoke(args, timeoutMs = 5000) {
    const bin = binaryPath();
    if (!bin) return Promise.resolve({ ok: false, error: 'rust_core_not_available', reason: '未找到 Rust 核心二进制' });
    const input = Array.isArray(args) ? args : [args || 'ping'];
    return new Promise((resolve) => {
      execFile(bin, input, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
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

  /** 真实探测：跑一次 ping 拿版本，结果缓存；失败也在缓存里（避免反复 spawn） */
  function probe() {
    if (_probe) return Promise.resolve(_probe);
    if (_probing) return _probing;
    const bin = binaryPath();
    if (!bin) {
      _probe = { ok: true, available: false, binary: null, version: null };
      return Promise.resolve(_probe);
    }
    _probing = invoke(['ping'], 4000).then((r) => {
      _probe = {
        ok: true,
        available: !!r.ok,
        binary: bin,
        version: (r && r.version) || null,
        service: (r && r.service) || null,
        error: r && r.ok ? undefined : (r && r.error) || undefined,
      };
      _probing = null;
      return _probe;
    }).catch(() => {
      _probe = { ok: true, available: false, binary: bin, version: null, error: 'rust_core_probe_failed' };
      _probing = null;
      return _probe;
    });
    return _probing;
  }

  function registerRustIpc({ ipcMain }) {
    ipcMain.handle('rust:status', () => probe());
    ipcMain.handle('rust:invoke', (_e, cmd, args) => invoke([cmd].concat(Array.isArray(args) ? args : [])));
  }

  return { binaryPath, available, invoke, probe, registerRustIpc };
}

module.exports = { createRustService };
