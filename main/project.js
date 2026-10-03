// ============================================================
// 主进程工程服务：`.fufumidi` 自包含工程包的保存 / 打开
// ============================================================
//
// 包的结构与字段语义定义在 `frontend/src/core/song_project.js`（前端也要读它
// 做解析与校验）。本文件只负责**字节层面**的三件事：
//
//   1. 保存：把 `project.json` + `files/<assetId><ext>` 打成一个 zip；
//   2. 打开：弹窗选文件 → 读出 `project.json` → 把 `files/` 解到缓存目录；
//   3. 把解出来的**本地路径**回给前端，让音频轨能真的读到伴奏。
//
// ★ 两条安全约束（改这个文件时别破坏）：
//   * 音频字节**不过 IPC** —— 前端只给 `srcPath`，由主进程自己读盘。
//     一首伴奏几十 MB，塞进结构化克隆会把渲染进程拖卡。
//   * 解包只认 `files/<合法 id><ext>` 且 id 必须在 `project.json` 的 `assets`
//     里登记过；其余条目**一律忽略**。工程包可能来自别人，不能盲解。
'use strict';

const crypto = require('crypto');
const Paths = require('./paths');
const { inspectEntries } = require('./zip-safe');

/** 与前端 `song_project.js` 的 ASSET_ID_RE 保持一致 */
const ASSET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FILES_ENTRY_RE = /^files\/([A-Za-z0-9_-]{1,64})(\.[A-Za-z0-9]{1,8})?$/;
const EXT_RE = /\.[A-Za-z0-9]{1,8}$/;

function extOf(name) {
  const m = String(name || '').match(EXT_RE);
  return m ? m[0] : '';
}

/** 工程文件 → 缓存目录（同一份工程反复打开落到同一处，不重复解包） */
function cacheDirFor(filePath) {
  const h = crypto.createHash('sha1').update(String(filePath)).digest('hex').slice(0, 16);
  return Paths.at('project-cache', h);
}

function registerProjectIpc({ ipcMain, dialog, path, fs }) {
  /* ---------------------------------------------------------- 保存 */

  ipcMain.handle('project:save', async (_e, payload) => {
    const p = payload || {};
    const json = p.json;
    if (!json || typeof json !== 'object') return { ok: false, error: '没有可保存的工程数据' };

    let target = String(p.filePath || '');
    if (!target) {
      const r = await dialog.showSaveDialog({
        title: '保存工程',
        defaultPath: (p.suggestName || 'untitled') + '.fufumidi',
        filters: [{ name: 'FuFumidi 工程', extensions: ['fufumidi'] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
      target = r.filePath;
    }
    if (!/\.fufumidi$/i.test(target)) target += '.fufumidi';

    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip();
      zip.addFile('project.json', Buffer.from(JSON.stringify(json, null, 2), 'utf8'));

      // 逐个塞 `files/`；源文件读不到就记下来，最后一起报给用户 ——
      // 一次丢文件不该让整次保存失败（否则用户会以为程序坏了）
      const missing = [];
      for (const a of (p.assets || [])) {
        const id = String((a && a.id) || '');
        const name = String((a && a.fileName) || 'audio');
        if (!ASSET_ID_RE.test(id)) { missing.push(name + '（资产 id 非法）'); continue; }
        const src = String((a && a.srcPath) || '');
        if (!src || !fs.existsSync(src)) { missing.push(name); continue; }
        try {
          zip.addFile('files/' + id + extOf(name), fs.readFileSync(src));
        } catch (e) {
          missing.push(name + '（读取失败：' + String(e && e.message || e) + '）');
        }
      }

      fs.mkdirSync(path.dirname(target), { recursive: true });
      zip.writeZip(target);
      return { ok: true, filePath: target, missing };
    } catch (e) {
      return { ok: false, error: '保存失败：' + String(e && e.message || e) };
    }
  });

  /* ---------------------------------------------------------- 打开 */

  ipcMain.handle('project:open', async () => {
    const r = await dialog.showOpenDialog({
      title: '打开工程',
      properties: ['openFile'],
      filters: [{ name: 'FuFumidi 工程', extensions: ['fufumidi'] }],
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, cancelled: true };
    const fp = r.filePaths[0];

    let zip;
    try {
      const AdmZip = require('adm-zip');
      zip = new AdmZip(fp);
    } catch (e) {
      return { ok: false, error: '读取工程失败（不是有效的 zip）：' + String(e && e.message || e) };
    }

    const dir = cacheDirFor(fp);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      return { ok: false, error: '创建工程缓存目录失败：' + String(e && e.message || e) };
    }

    // 整包先过一遍条目校验（绝对路径 / `..` / 重名 / 解压炸弹），任一不满足就整包拒绝
    const check = inspectEntries(zip, dir, { maxEntries: 4096, maxTotalBytes: 4 * 1024 * 1024 * 1024 });
    if (!check.ok) return { ok: false, error: check.error };

    const entry = zip.getEntry('project.json');
    if (!entry) return { ok: false, error: '这个包里没有 project.json，可能不是 FuFumidi 工程' };

    let json;
    try {
      json = JSON.parse(entry.getData().toString('utf8'));
    } catch (e) {
      return { ok: false, error: 'project.json 解析失败：' + String(e && e.message || e) };
    }

    // 只解「清单里登记过的」资产
    const allowed = new Set();
    const assets = (json && json.assets && typeof json.assets === 'object') ? json.assets : {};
    for (const id of Object.keys(assets)) {
      if (ASSET_ID_RE.test(id)) allowed.add(id.toLowerCase());
    }

    const resolved = {};
    for (const e of zip.getEntries()) {
      const name = String(e.entryName == null ? '' : e.entryName).replace(/\\/g, '/');
      const m = name.match(FILES_ENTRY_RE);
      if (!m) continue;
      if (!allowed.has(m[1].toLowerCase())) continue;
      try {
        if (e.isDirectory) continue;
        const dest = path.join(dir, m[1] + (m[2] || ''));
        fs.writeFileSync(dest, e.getData());
        resolved[m[1]] = dest;
      } catch (err) {
        // 单个资产解不出来不影响其它轨，缺的会在前端由 missingAssets() 提示
      }
    }

    return { ok: true, filePath: fp, json, resolved, cacheDir: dir };
  });
}

module.exports = { registerProjectIpc, cacheDirFor };
