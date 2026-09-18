// ============================================================
// 主进程曲库文件服务：让「每一个 MIDI 曲目」都对应一个真实的 .mid 文件
//
// 目录：<数据根目录>/midi/<曲名>.mid（默认位于工具目录旁，不占 C 盘）
// 说明：曲目字节仍以 IndexedDB / SQLite 为准（云同步沿用），
//       磁盘文件是「必须存在」的镜像，由写盘 / 校验 / 重建三个入口维护，
//       删除曲目时一并删除文件，避免出现只有名字没有内容的「空壳曲目」。
// ============================================================
'use strict';
const Paths = require('./paths');
const crypto = require('crypto');

const MIDI_EXT_RE = /\.(mid|midi|kar|rmi)$/i;

function registerLibraryIpc({ ipcMain, path, fs, shell, rustInvoke }) {
  const midiRoot = () => Paths.midiDir();

  /** 去掉 Windows 非法字符，得到可用的文件名（保留曲名可读性，便于用户在资源管理器中辨认） */
  function safeBase(name) {
    let base = String(name || 'song').replace(MIDI_EXT_RE, '');
    base = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
    if (!base) base = 'song';
    if (base.length > 100) base = base.slice(0, 100);
    return base;
  }
  function uniquePath(base) {
    const dir = midiRoot();
    let p = path.join(dir, base + '.mid'), n = 1;
    while (fs.existsSync(p)) { p = path.join(dir, base + ' (' + n + ').mid'); n++; }
    return p;
  }
  /** 路径安全校验：只允许操作数据根目录 midi/ 下的文件（Windows 大小写不敏感，统一小写比较） */
  function norm(p) {
    try {
      const t = path.resolve(String(p || ''));
      return process.platform === 'win32' ? t.toLowerCase() : t;
    } catch (_) { return ''; }
  }
  function inRoot(p) {
    try {
      const root = norm(midiRoot());
      const target = norm(p);
      return !!root && !!target && (target === root || target.startsWith(root + path.sep));
    } catch (_) { return false; }
  }
  function sameContent(file, bytes) {
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size !== bytes.length) return false;
      const old = fs.readFileSync(file);
      return old.length === bytes.length && Buffer.compare(old, Buffer.from(bytes)) === 0;
    } catch (_) { return false; }
  }

  /**
   * 写盘：把曲目字节落成真实 .mid 文件。
   * - 已有 path 且文件存在且内容一致 → 原样复用（幂等，不产生副本）
   * - 同名文件内容一致 → 复用
   * - 否则新建（重名自动加序号）
   * 返回 { ok, path, existed }
   */
  ipcMain.handle('library:writeMidi', async (_e, opts) => {
    try {
      const o = opts || {};
      const raw = o.bytes;
      if (!raw) return { ok: false, error: '没有曲目字节' };
      const bytes = raw instanceof Uint8Array ? raw
        : raw instanceof ArrayBuffer ? new Uint8Array(raw)
        : ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
        : Array.isArray(raw) ? Uint8Array.from(raw)
        : null;
      if (!bytes || !bytes.length) return { ok: false, error: '曲目字节为空' };
      const prev = o.path && inRoot(o.path) ? String(o.path) : '';
      if (prev && sameContent(prev, bytes)) return { ok: true, path: prev, existed: true };
      const base = safeBase(o.name);
      const same = path.join(midiRoot(), base + '.mid');
      // 同名且内容一致 → 直接复用，不重复写盘（启动自检每次都会调用，避免无谓 IO 与副本）
      if (sameContent(same, bytes)) return { ok: true, path: same, existed: true };
      const target = prev || (fs.existsSync(same) ? uniquePath(base) : same);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, Buffer.from(bytes));
      return { ok: true, path: target, existed: false };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  /** 校验文件是否真实存在（曲库自检 / 「打开所在文件夹」前用） */
  ipcMain.handle('library:hasMidi', (_e, p) => {
    try {
      if (!p || !inRoot(p)) return { ok: true, exists: false };
      const st = fs.statSync(String(p));
      return { ok: true, exists: st.isFile() && st.size > 0, size: st.isFile() ? st.size : 0 };
    } catch (_) { return { ok: true, exists: false }; }
  });

  /** 批量校验：返回丢失的曲目（前端据此重建） */
  ipcMain.handle('library:checkMidi', (_e, items) => {
    const missing = [];
    for (const it of Array.isArray(items) ? items : []) {
      if (!it || !it.id) continue;
      let exists = false;
      try { exists = !!(it.path && inRoot(it.path) && fs.statSync(String(it.path)).isFile()); } catch (_) { exists = false; }
      if (!exists) missing.push({ id: String(it.id), name: String(it.name || '') });
    }
    return { ok: true, missing, root: midiRoot() };
  });

  /** 删除曲目对应的磁盘文件（只在数据根目录 midi/ 内生效） */
  ipcMain.handle('library:deleteMidi', (_e, p) => {
    try {
      if (!p) return { ok: true, deleted: false };
      if (!inRoot(p)) return { ok: false, error: '只能删除曲库目录内的文件' };
      if (!fs.existsSync(p)) return { ok: true, deleted: false };
      fs.rmSync(String(p), { force: true });
      return { ok: true, deleted: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  /** 在资源管理器中定位曲目文件；文件不存在时退化为打开曲库目录 */
  ipcMain.handle('library:reveal', async (_e, p) => {
    try {
      const target = p && inRoot(p) ? String(p) : '';
      if (target && fs.existsSync(target)) { shell.showItemInFolder(target); return { ok: true, path: target }; }
      const dir = midiRoot();
      fs.mkdirSync(dir, { recursive: true });
      await shell.openPath(dir);
      return { ok: true, path: dir, fellBackToDir: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  /** 曲库文件总览（设置页 / 资源中心展示「每个曲目都有真实文件」） */
  ipcMain.handle('library:stats', () => {
    try {
      const dir = midiRoot();
      let count = 0, bytes = 0;
      for (const name of fs.readdirSync(dir)) {
        try {
          const st = fs.statSync(path.join(dir, name));
          if (st.isFile()) { count++; bytes += st.size; }
        } catch (_) {}
      }
      return { ok: true, dir, count, bytes };
    } catch (e) { return { ok: false, dir: midiRoot(), count: 0, bytes: 0, error: String((e && e.message) || e) }; }
  });

  /* ---------------- Rust 核心加速：曲库体检 / 重复检测 ---------------- */
  const hasRust = () => typeof rustInvoke === 'function';
  /** 纯 JS 兜底：逐个文件读取并做最基本的可解析判断（Rust 不可用时使用） */
  function fallbackScan(dir) {
    const files = [];
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return files; }
    for (const n of names) {
      if (!/\.(mid|midi)$/i.test(n)) continue;
      const full = path.join(dir, n);
      let ok = false, size = 0, notes = null;
      try {
        const st = fs.statSync(full);
        size = st.size;
        // 只做「SMF 头 + 至少一段轨道数据」的最低限度判断，避免把空文件当好文件
        const buf = Buffer.alloc(14);
        const fd = fs.openSync(full, 'r');
        try { fs.readSync(fd, buf, 0, 14, 0); } finally { fs.closeSync(fd); }
        ok = size > 14 && buf.toString('latin1', 0, 4) === 'MThd' &&
          buf.readUInt32BE(4) >= 6 && buf.readUInt16BE(12) > 0;
      } catch (_) { ok = false; }
      files.push({ file: full, ok, size, notes });
    }
    return files;
  }

  /**
   * 曲库文件体检：用 Rust 核心（batch-stats）一次性解析 midi/ 下的所有文件，
   * 得到每个文件的轨道数/音符数/BPM，并标出损坏或空文件。
   * Rust 不可用时回退 JS 扫描（只判断文件头，不统计音符数）。
   */
  ipcMain.handle('library:verify', async () => {
    const dir = midiRoot();
    fs.mkdirSync(dir, { recursive: true });
    let engine = 'js';
    let files = [];
    if (hasRust()) {
      try {
        const r = await rustInvoke(['batch-stats', dir], 60000);
        if (r && r.ok && Array.isArray(r.files)) {
          engine = 'rust';
          files = r.files.map(f => ({
            file: f.file,
            ok: f.ok !== false,
            error: f.error || '',
            format: f.format || 0,
            tracks: f.tracks || 0,
            notes: f.notes || 0,
            bpm: f.bpm || 0,
            minMidi: f.min_midi || 0,
            maxMidi: f.max_midi || 0,
            avgVel: f.avg_vel || 0,
          }));
        }
      } catch (_) {}
    }
    if (engine !== 'rust') files = fallbackScan(dir).map(f => ({ ...f, error: f.ok ? '' : '无法解析（Rust 核心不可用，仅做文件头校验）' }));
    // Rust 老版本 batch-stats 不返回 size 时补一次 stat，保证总字节数与曲库一致
    for (const f of files) {
      if (f.size == null) { try { f.size = fs.statSync(f.file).size; } catch (_) { f.size = 0; } }
    }
    const bad = files.filter(f => !f.ok);
    const totalNotes = files.reduce((a, f) => a + (f.notes || 0), 0);
    const totalBytes = files.reduce((a, f) => a + (f.size || 0), 0);
    return { ok: true, engine, dir, count: files.length, badCount: bad.length, totalNotes, totalBytes, files, bad };
  });

  /**
   * 重复曲库文件检测：用 Rust 核心（hash-batch，FNV-1a）算出每个文件的哈希并分组，
   * 供用户清理重复导入。Rust 不可用时回退 JS 读取并哈希。
   */
  ipcMain.handle('library:dupes', async () => {
    const dir = midiRoot();
    fs.mkdirSync(dir, { recursive: true });
    let engine = 'js';
    let rows = [];
    if (hasRust()) {
      try {
        const r = await rustInvoke(['hash-batch', dir], 60000);
        if (r && r.ok && Array.isArray(r.files)) { engine = 'rust'; rows = r.files; }
      } catch (_) {}
    }
    if (engine !== 'rust') {
      rows = [];
      let names = [];
      try { names = fs.readdirSync(dir); } catch (_) {}
      for (const n of names) {
        if (!/\.(mid|midi|sf2|sf3|wav|mp3|flac)$/i.test(n)) continue;   // 与 Rust 侧扫描范围保持一致
        const full = path.join(dir, n);
        try {
          const buf = fs.readFileSync(full);
          // SHA-256 与 Rust 侧 hash-batch 保持一致：去重分组不受「Rust 是否可用」影响
          const digest = crypto.createHash('sha256').update(buf).digest('hex');
          rows.push({ file: full, hash: digest, size: buf.length });
        } catch (_) {}
      }
    }
    const groups = new Map();
    for (const r of rows) {
      const key = String(r.hash || '') + ':' + String(r.size || 0);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ file: r.file, size: r.size || 0 });
    }
    // SHA-256 已将碰撞概率降到可忽略，仍保留逐字节比对作为最终判重，双保险
    const dupes = [];
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const buckets = [];
      for (const f of g) {
        let buf = null;
        try { buf = fs.readFileSync(f.file); } catch (_) { continue; }
        const hit = buckets.find(b => b.buf.length === buf.length && Buffer.compare(b.buf, buf) === 0);
        if (hit) hit.items.push(f); else buckets.push({ buf, items: [f] });
      }
      for (const b of buckets) if (b.items.length > 1) dupes.push(b.items);
    }
    return {
      ok: true,
      engine,
      dir,
      count: rows.length,
      dupeGroups: dupes.length,
      dupeFiles: dupes.reduce((a, g) => a + g.length - 1, 0),
      groups: dupes,
    };
  });
}

module.exports = { registerLibraryIpc };
