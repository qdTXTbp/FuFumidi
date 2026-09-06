// ============================================================
// FuFumidi —— 完整性检验与误删修复（纯 Node 逻辑，不依赖 Electron API）
//
// 校验范围（用户误删真实文件的高发区域）：
//   1. settings.json   缺失 / JSON 损坏 → 备份后重建默认
//   2. presets.json    缺失 / JSON 损坏 → 备份后重置内置预设
//   3. 用户插件清单      plugins_enabled 里启用的插件目录不存在 → 从清单清理
//
// 由 main.js 注入路径与读写函数（deps），便于独立单元测试。
// 触发方式：启动时后台静默 check()；用户在设置页看到警告条后点「一键修复」repair()。
// ============================================================
'use strict';

function createIntegrity(deps) {
  const {
    getSettingsPath,     // () => string   settings.json 绝对路径
    getPluginsUserDir,   // () => string   %APPDATA%/fufumidi/plugins
    getBuiltinPluginsDir,// () => string   app/plugins（内置插件目录）
    readSettings,        // () => object   读取当前设置（损坏时返回默认）
    writeSettings,       // (obj) => void  原子写回设置
    defaultSettings,     // object         DEFAULT_SETTINGS
    isPackaged,          // boolean        打包后 engine 在 asar 内只读，跳过 presets 校验
    getAppAsarPath,      // () => string|null 打包后 resources/app.asar 路径；开发模式返回 null
  } = deps;

  // 定位 engine/presets.json：开发模式在 app/engine/，打包后无法写 → 由调用方控制是否校验
  const getPresetsPath = (() => {
    if (isPackaged) return null;                 // 打包后 presets 内置于 asar，用户删不掉也无需修
    return () => require('path').join(__dirname, 'engine', 'presets.json');
  })();

  function fileValidJson(p) {
    try {
      const raw = require('fs').readFileSync(p, 'utf8');
      JSON.parse(raw);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }

  // 判断某插件 id 是否仍有目录存在（用户目录优先，其次内置目录）
  function pluginDirExists(id) {
    const path = require('path');
    const fs = require('fs');
    const candidates = [
      path.join(getPluginsUserDir(), id, 'plugin.json'),
      path.join(getBuiltinPluginsDir(), id, 'plugin.json'),
    ];
    return candidates.some(p => fs.existsSync(p));
  }

  // 备份文件：同名 .bak-<时间戳>，返回备份路径；失败返回 null
  function backupFile(p) {
    try {
      const fs = require('fs');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const bak = p + '.bak-' + ts;
      fs.copyFileSync(p, bak);
      return bak;
    } catch { return null; }
  }

  // ---- 检验：返回 { ok, issues:[{id, severity, canRepair, path?}] } ----
  // severity: 'warn'=影响使用，'info'=轻微丢失
  function check() {
    const fs = require('fs');
    const issues = [];

    // 1) settings.json
    const sp = getSettingsPath();
    if (!fs.existsSync(sp)) {
      issues.push({ id: 'settings-missing', severity: 'warn', canRepair: true, path: sp });
    } else {
      const v = fileValidJson(sp);
      if (!v.ok) issues.push({ id: 'settings-corrupt', severity: 'warn', canRepair: true, path: sp });
    }

    // 2) presets.json（仅开发模式可校验；打包后跳过）
    const pp = getPresetsPath && getPresetsPath();
    if (pp) {
      if (!fs.existsSync(pp)) {
        issues.push({ id: 'presets-missing', severity: 'info', canRepair: true, path: pp });
      } else {
        const v = fileValidJson(pp);
        if (!v.ok) issues.push({ id: 'presets-corrupt', severity: 'info', canRepair: true, path: pp });
      }
    }

    // 3) 用户插件清单：已启用但目录丢失
    const enabled = (readSettings() || {}).plugins_enabled || [];
    for (const id of enabled) {
      if (!id || !pluginDirExists(id)) {
        issues.push({ id: 'plugin-missing:' + id, severity: 'warn', canRepair: true, path: getPluginsUserDir() + '/' + id });
      }
    }

    // 4) 核心安装文件自检（仅打包环境）：app.asar 缺失/过小 = 更新中断或文件损坏 →
    //    引导用户重新下载安装最新版（点击「一键修复」→ repair 返回 reinstall → 前端弹窗重装）。
    //    更新器替换 75MB 的 asar 需数秒，检查恰逢替换瞬时可能读到半写/缺失文件 → 纯 stat 会误报。
    //    因此：① 对 stat/大小/头 均带多次重试；② 用真正解析「头部内嵌 JSON」来判定完整性，
    //    半写文件的 JSON 必 parse 失败，远比仅看 3 个 uint32 可靠。
    const asarPath = getAppAsarPath && getAppAsarPath();
    if (asarPath) {
      const isCorrupt = () => ({ id: 'core-corrupt', severity: 'warn', canRepair: true, path: asarPath });
      const isMissing = () => ({ id: 'core-missing', severity: 'warn', canRepair: true, path: asarPath });
      const waitMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      // Electron 主进程把 *.asar 路径拦截为「归档目录」：fs.statSync(app.asar).size 恒为 0、
      // fs.openSync(app.asar) 报 EISDIR，永远读不到归档自身原始字节 → 每次启动必误报 core-corrupt。
      // 必须用 Electron 提供的未补丁 original-fs 读取（开发/纯 Node 环境自动回退普通 fs）。
      // （3.1.18 曾根治，3.2.0 上游合并时被回退丢失，此处恢复）
      const rawFs = (() => { try { const m = require('original-fs'); if (m && m.statSync && m.openSync) return m; } catch (e) {} return fs; })();
      // 尝试 N 次读取并解析 asar 头；任一次成功即认为健康（规避替换窗口的瞬时半写/ENOENT）
      let bad = true, anyErr = null;
      for (let attempt = 0; attempt < 4 && bad; attempt++) {
        if (attempt > 0) waitMs(400);
        try {
          const st = rawFs.statSync(asarPath);
          if (st.size < 1 * 1024 * 1024) { bad = true; continue; }   // 过小 = 半写/损坏
          const hdr = Buffer.alloc(16);
          const fd = rawFs.openSync(asarPath, 'r');
          try { rawFs.readSync(fd, hdr, 0, 16, 0); } finally { rawFs.closeSync(fd); }
          // asar 头（实测布局，全员为小端）：
          //   bytes0-3  = 4（pickle 头）
          //   bytes4-7  = headerSize
          //   bytes8-11 = headerSize - 4
          //   bytes12-15= jsonSize（header JSON 长度）
          //   JSON 本体从偏移 16 起、长 jsonSize，首个键为 "files"
          const marker = hdr.readUInt32LE(0);
          const headerSize = hdr.readUInt32LE(4);
          const jsonSize = hdr.readUInt32LE(12);
          const badHdr = (marker !== 4) || !(headerSize > 0 && headerSize <= st.size) || !(jsonSize > 0 && jsonSize <= st.size);
          let ok = false;
          if (!badHdr && 16 + jsonSize <= st.size) {
            const buf = Buffer.alloc(jsonSize);
            const f2 = rawFs.openSync(asarPath, 'r');
            try { rawFs.readSync(f2, buf, 0, jsonSize, 16); } finally { rawFs.closeSync(f2); }
            try {
              const j = JSON.parse(buf.toString('utf8'));
              ok = !!(j && typeof j === 'object' && 'files' in j);   // 半写文件 JSON parse 必抛或缺 files
            } catch (e) { ok = false; }
          }
          bad = !ok;   // 任一字段非法或 JSON 解析失败 → 本次尝试判定为损坏，进入重试
        } catch (e) { bad = true; anyErr = e; }
      }
      if (bad) issues.push(anyErr && (anyErr.code === 'ENOENT') ? isMissing() : isCorrupt());
    }

    return { ok: issues.length === 0, issues };
  }

  // ---- 修复：按 id 数组执行；返回 { ok, results:[{id, ok, action, error?}] } ----
  function repair(ids) {
    const fs = require('fs');
    const path = require('path');
    const results = [];
    const target = Array.isArray(ids) ? ids : (ids || []);

    const run = (id) => {
      // settings 缺失：直接写默认
      if (id === 'settings-missing') {
        try { writeSettings({ ...defaultSettings }); return { id, ok: true, action: 'recreated' }; }
        catch (e) { return { id, ok: false, action: 'recreate', error: String(e && e.message || e) }; }
      }
      // settings 损坏：备份损坏文件 → 写默认
      if (id === 'settings-corrupt') {
        const bak = backupFile(getSettingsPath());
        try { writeSettings({ ...defaultSettings }); return { id, ok: true, action: 'backup+recreated', backup: bak }; }
        catch (e) { return { id, ok: false, action: 'backup+recreate', error: String(e && e.message || e) }; }
      }
      // presets 缺失/损坏：备份（损坏时）→ 写回最小结构，引擎内置预设自动兜底
      if (id === 'presets-missing' || id === 'presets-corrupt') {
        const pp = getPresetsPath && getPresetsPath();
        if (!pp) return { id, ok: false, action: 'skipped-packaged', error: '打包后 presets 内置于 asar，无需修复' };
        let bak = null;
        if (id === 'presets-corrupt') bak = backupFile(pp);
        try {
          fs.mkdirSync(path.dirname(pp), { recursive: true });
          fs.writeFileSync(pp, JSON.stringify({ presets: {} }, null, 2), 'utf8');
          return { id, ok: true, action: 'reset', backup: bak };
        } catch (e) { return { id, ok: false, action: 'reset', error: String(e && e.message || e) }; }
      }
      // 插件缺失：从 plugins_enabled 移除
      if (id.startsWith('plugin-missing:')) {
        const pid = id.slice('plugin-missing:'.length);
        try {
          const s = readSettings();
          const next = { ...s, plugins_enabled: (s.plugins_enabled || []).filter(x => x !== pid) };
          writeSettings(next);
          return { id, ok: true, action: 'disabled', plugin: pid };
        } catch (e) { return { id, ok: false, action: 'disable', error: String(e && e.message || e) }; }
      }
      // 核心安装文件损坏/缺失：返回 reinstall 标记，由前端引导重新下载安装最新版
      if (id === 'core-corrupt' || id === 'core-missing') {
        return { id, ok: false, action: 'reinstall', error: '核心安装文件不完整，需要重新下载并安装最新版' };
      }
      return { id, ok: false, action: 'unknown', error: '未知问题类型' };
    };

    for (const id of target) results.push(run(id));
    const allOk = results.every(r => r.ok);
    return { ok: allOk, results };
  }

  return { check, repair };
}

module.exports = { createIntegrity };
