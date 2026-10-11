// ============================================================
// UTAU 声库制作 IPC：声库导出 + 人声渲染 + 现成声库导入
// ============================================================
'use strict';
const crypto = require('crypto');
const Paths = require('./paths');
const { safeExtractAllTo } = require('./zip-safe');
const createFastDownload = require('./fast-download');
// 直接 require 而不是走 `registerUtauIpc` 的入参：本模块的注册参数里没有 readSettings，
// 而引擎选择要读设置。Node 模块缓存保证拿到的是同一个 settings 单例。
const { readSettings } = require('./settings');

/**
 * 只保留最近 `keep` 份 payload 缓存目录（每份里是 OpenUtau 的乐句缓存，几十 MB 级）。
 * 见 `utau:renderTrack` 里"缓存按 payload 隔离"的说明。
 */
function pruneOuCacheDirs(root, current, keep = 8) {
  try {
    const fs = require('fs');
    const path = require('path');
    const items = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && path.join(root, e.name) !== current)
      .map((e) => {
        const p = path.join(root, e.name);
        let mtime = 0;
        try { mtime = fs.statSync(p).mtimeMs; } catch (err) { mtime = 0; }
        return { p, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const it of items.slice(Math.max(0, keep - 1))) {
      try { fs.rmSync(it.p, { recursive: true, force: true }); } catch (err) { /* 正被占用就算了 */ }
    }
  } catch (err) { /* 目录不存在等：不影响渲染 */ }
}

function registerUtauIpc({ ipcMain, BrowserWindow, path, fs, os, app, dialog, net, spawnEngine, createEngineSession }) {
  // 统一高速下载器（规范入口，见 docs/DOWNLOADS.md）
  const FastDL = createFastDownload({ net, fs, path });
  // 声库是体积较大的模型类资产：统一放在数据根目录（默认工具目录旁），不挤占 C 盘
  const vbRoot = () => Paths.voicebanksDir();

  // ---- 常驻引擎会话（惰性创建；仅 openutau 引擎——legacy 没有 serve 子命令）----
  // 省每次渲染的 Python 启动 + G2p/音素化器初始化开销。请求失败由调用方
  // 回退一次性 spawn（保留 openutau→legacy 引擎回落链）——功能永远可用。
  let _openUtauSession = null;
  const openUtauSession = () => {
    if (!_openUtauSession && createEngineSession) _openUtauSession = createEngineSession('engine_openutau.py', ['serve']);
    return _openUtauSession;
  };
  const dropOpenUtauSession = () => {
    if (_openUtauSession) { try { _openUtauSession.kill(); } catch (e) {} _openUtauSession = null; }
  };

  // ---- 声库根判定与显示名（对齐上游 VoicebankLoader / VoicebankInstaller）----
  // 上游：声库根 = 顶层有 character.txt 的目录（安装器保证缺时补写），oto.ini 集合从根**递归**加载；
  // character.yaml 的 name: 覆盖 character.txt 的 name=。
  // 这里认 character.txt / character.yaml，并保留「顶层 oto.ini」回落（兼容本应用早期
  // 导入的裸 oto 目录——引擎 load_singer 也支持这种形态）。
  const isBankRoot = (dir) =>
    fs.existsSync(path.join(dir, 'character.txt')) ||
    fs.existsSync(path.join(dir, 'character.yaml')) ||
    fs.existsSync(path.join(dir, 'oto.ini'));

  /** 显示名：character.yaml 的 name: 覆盖 character.txt 的 name=/名前=（上游 ApplyConfig 顺序），
   *  全空回落目录名；上游对无名声库显示 "No Name (Id)"。 */
  const bankDisplayName = (dir) => {
    let name = '';
    try {
      const ct = fs.readFileSync(path.join(dir, 'character.txt'), 'utf8');
      for (const line of ct.split(/\r?\n/)) {
        const m = line.trim().match(/^(?:name|名前)\s*[=：:]\s*(.+)$/i);
        if (m) { name = m[1].trim(); break; }
      }
    } catch (e) {}
    try {
      const y = fs.readFileSync(path.join(dir, 'character.yaml'), 'utf8');
      const m = y.match(/^\s*name\s*:\s*(.+?)\s*$/mi);
      if (m && m[1].trim()) name = m[1].replace(/^["']+|["']+$/g, '').trim();
    } catch (e) {}
    return name || '';
  };

  // 已导入声库列表：<数据根目录>/voicebanks 下每个**声库根**目录（一层，对齐上游 SingersPath）
  ipcMain.handle('utau:listVoicebanks', () => {
    try {
      const root = vbRoot();
      if (!fs.existsSync(root)) return { ok: true, list: [] };
      const list = [];
      for (const name of fs.readdirSync(root)) {
        const dir = path.join(root, name);
        let isDir = false;
        try { isDir = fs.statSync(dir).isDirectory(); } catch (e) { continue; }
        if (!isDir) continue;
        if (!isBankRoot(dir)) continue;
        list.push({ name: bankDisplayName(dir) || name, dir });
      }
      return { ok: true, list };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 导入现成声库 zip → 解压到 userData/voicebanks，返回声库目录
  // directPath（可选）：拖拽导入时由渲染端经 webUtils.getPathForFile 传入，跳过文件对话框
  ipcMain.handle('utau:importVoicebankZip', async (_e, directPath) => {
    try {
      const win = dialog;
      let files;
      if (directPath && typeof directPath === 'string' && /\.zip$/i.test(directPath) && fs.existsSync(directPath)) {
        files = [directPath];
      } else if (typeof dialog.showOpenDialog === 'function') {
        const r = await dialog.showOpenDialog({
          properties: ['openFile'],
          filters: [{ name: 'UTAU 声库', extensions: ['zip'] }],
        });
        if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
        files = r.filePaths;
      } else {
        files = typeof win === 'function' ? [await win()] : [];
      }
      const zipPath = files && files[0];
      if (!zipPath) return { ok: false, canceled: true };

      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipPath);
      const root = vbRoot();
      fs.mkdirSync(root, { recursive: true });
      // 声库名取 zip 文件名（去扩展名，清洗）
      let name = path.basename(zipPath, path.extname(zipPath)).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
      name = name || ('voicebank_' + Date.now());
      let dest = path.join(root, name);
      let i = 2;
      while (fs.existsSync(dest)) { dest = path.join(root, name + '_' + i++); }
      fs.mkdirSync(dest, { recursive: true });
      const _zsafe = safeExtractAllTo(zip, dest);

      if (!_zsafe.ok) throw new Error('压缩包安全校验未通过：' + _zsafe.error);
      // ---- 定位声库根（对齐上游 VoicebankInstaller.AdjustBasePath + VoicebankLoader）----
      // 优先 character.txt / character.yaml（上游判定），回落顶层 oto.ini（兼容裸 oto 包）
      const findRoot = (pred) => {
        const walk = (d, depth) => {
          if (depth > 4) return null;
          if (pred(d)) return d;
          let entries = [];
          try { entries = fs.readdirSync(d); } catch (e) { return null; }
          for (const n of entries) {
            const p = path.join(d, n);
            let isDir = false;
            try { isDir = fs.statSync(p).isDirectory(); } catch (e) { continue; }
            if (!isDir) continue;
            const r = walk(p, depth + 1);
            if (r) return r;
          }
          return null;
        };
        return walk(dest, 0);
      };
      let outDir = findRoot(isBankRoot) || findRoot(d => fs.existsSync(path.join(d, 'oto.ini'))) || dest;
      // 挪到 root 下第一层：listVoicebanks（同上游 SingersPath）一层扫一个声库，
      // 根埋在第二层就永远扫不到——这正是「导入了却选不到」的一类根因
      {
        const rel = path.relative(root, outDir);
        if (rel && rel.split(path.sep).length >= 2) {
          const base = (path.basename(zipPath, path.extname(zipPath)) || 'voicebank')
            .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
          let target = path.join(root, base);
          let i = 2;
          while (fs.existsSync(target)) target = path.join(root, `${base}_${i++}`);
          fs.renameSync(outDir, target);
          outDir = target;
        }
      }
      // 对齐上游安装器：缺 character.txt 的包补写空 character.txt + character.yaml
      // （上游靠它做声库根判定并记录文本编码；oto 集合随后从根递归加载）
      if (!fs.existsSync(path.join(outDir, 'character.txt')) &&
          !fs.existsSync(path.join(outDir, 'character.yaml')) &&
          fs.existsSync(path.join(outDir, 'oto.ini'))) {
        try {
          fs.writeFileSync(path.join(outDir, 'character.txt'), '\n', 'utf8');
          fs.writeFileSync(path.join(outDir, 'character.yaml'), 'textFileEncoding: utf-8\n', 'utf8');
        } catch (e) {}
      }
      return { ok: true, name: bankDisplayName(outDir) || path.basename(outDir), dir: outDir };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 删除已导入的声库目录（只能删除数据根目录 voicebanks 下的声库）
  ipcMain.handle('utau:deleteVoicebank', async (_e, dir) => {
    try {
      if (!dir || typeof dir !== 'string') return { ok: false, error: '参数错误' };
      const root = vbRoot();
      const resolved = path.resolve(dir);
      const rootResolved = path.resolve(root);
      if (!resolved.startsWith(rootResolved + path.sep)) return { ok: false, error: '只能删除已导入的声库目录' };
      if (!fs.existsSync(resolved)) return { ok: false, error: '声库不存在' };
      fs.rmSync(resolved, { recursive: true, force: true });
      return { ok: true, dir: resolved };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('utau:exportVoicebank', async (_e, opts) => {
    try {
      const { dir, files } = opts || {};
      if (!dir || typeof dir !== 'string' || !Array.isArray(files)) {
        return { ok: false, error: '参数错误' };
      }
      if (!fs.existsSync(dir)) return { ok: false, error: '保存目录不存在' };
      for (const f of files) {
        const name = String((f && f.name) || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
        if (!name) continue;
        const buf = Buffer.from(String((f && f.data) || ''), 'base64');
        fs.writeFileSync(path.join(dir, name), buf);
      }
      return { ok: true, dir, count: files.length };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 导出声库为 zip 压缩包：选择保存路径后打包 oto.ini + wav 文件
  ipcMain.handle('utau:exportVoicebankZip', async (_e, opts) => {
    try {
      const { files } = opts || {};
      if (!Array.isArray(files) || !files.length) return { ok: false, error: '参数错误' };
      const defaultDir = app.getPath('downloads') || os.homedir();
      const r = await dialog.showSaveDialog({
        title: '导出声库压缩包',
        defaultPath: path.join(defaultDir, 'voicebank.zip'),
        filters: [{ name: 'UTAU 声库', extensions: ['zip'] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      const AdmZip = require('adm-zip');
      const zip = new AdmZip();
      for (const f of files) {
        const name = String((f && f.name) || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
        if (!name) continue;
        const buf = Buffer.from(String((f && f.data) || ''), 'base64');
        zip.addFile(name, buf);
      }
      zip.writeZip(r.filePath);
      return { ok: true, path: r.filePath, count: files.length };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 查询声库可用别名（P1-4 发音/别名替换）：调 engine_utau.py aliases，可按关键字过滤
  ipcMain.handle('utau:aliases', (evt, cfg) => new Promise((resolve) => {
    const { voicebank, query, limit } = cfg || {};
    try {
      if (!voicebank) return resolve({ ok: false, error: '未选择声库' });
      const args = ['aliases', '--voicebank', String(voicebank), '--limit', String(Math.max(1, Math.min(5000, Number(limit) || 300)))];
      if (query) args.push('--query', String(query));
      spawnEngine(args, {
        script: 'engine_utau.py',
        onDone: (code, r) => {
          if (r && r.result && r.result.ok) return resolve(r.result);
          const err = (r && r.result && r.result.error)
            || (r && (r.err || r.out || '').slice(-400))
            || `引擎退出码 ${code}`;
          resolve({ ok: false, error: err });
        },
        onError: (e) => resolve({ ok: false, error: String(e) }),
      });
    } catch (err) {
      resolve({ ok: false, error: String((err && err.message) || err) });
    }
  }));

  /**
   * 每个别名的录制音高（M8 音域热力图）。
   *
   * 441 个别名的库要逐个读采样 + 逐帧自相关，实测秒级到十几秒，所以超时给足 10 分钟；
   * 引擎那边每分析 20 条会 emit_progress，界面拿它显示进度。
   */
  ipcMain.handle('utau:aliasRange', (evt, cfg) => new Promise((resolve) => {
    const { voicebank, query, limit } = cfg || {};
    if (!voicebank) return resolve({ ok: false, error: '未选择声库' });
    try {
      const args = ['alias-range', '--voicebank', String(voicebank),
        '--limit', String(Math.max(0, Math.min(5000, Number(limit) || 0)))];
      if (query) args.push('--query', String(query));
      spawnEngine(args, {
        script: 'engine_utau.py',
        timeoutMs: 10 * 60 * 1000,
        onDone: (code, r) => {
          if (r && r.result && r.result.ok) return resolve(r.result);
          const err = (r && r.result && r.result.error)
            || (r && (r.err || r.out || '').slice(-400))
            || `引擎退出码 ${code}`;
          resolve({ ok: false, error: err });
        },
        onError: (e) => resolve({ ok: false, error: String(e) }),
      });
    } catch (err) {
      resolve({ ok: false, error: String((err && err.message) || err) });
    }
  }));

  /**
   * 读 oto.ini 的**原始字节**（M8f 声库管理 2.0：别名表可编辑）。
   *
   * ★ 不在这里解析、也不在这里判编码：渲染进程有完整的 CP932 编解码器
   *   （core/shift_jis.js，上一轮实测过字节级正确），解析/判码/写回都在那边做，
   *   主进程只负责"把字节读出来 / 把字节写回去 + 备份"这一件事。
   */
  ipcMain.handle('utau:readOto', (_e, cfg) => {
    try {
      const dir = cfg && cfg.voicebank ? String(cfg.voicebank) : '';
      if (!dir) return { ok: false, error: '未指定声库目录' };
      const root = path.resolve(dir);
      if (!fs.existsSync(root)) return { ok: false, error: '声库目录不存在' };
      const target = path.join(root, 'oto.ini');
      if (!fs.existsSync(target)) return { ok: false, error: '该声库没有 oto.ini' };
      const buf = fs.readFileSync(target);
      return {
        ok: true, path: target, base64: buf.toString('base64'),
        size: buf.length, mtimeMs: fs.statSync(target).mtimeMs,
      };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  /**
   * 写回 oto.ini。字节**由渲染进程按原编码编好**（Shift-JIS / UTF-8 原样保留），
   * 这里只落盘，并先备份一份 `oto.ini.bak`（改坏了能退回去 —— 用户的原音设定比什么都贵）。
   */
  ipcMain.handle('utau:saveOto', (_e, cfg) => {
    try {
      const dir = cfg && cfg.voicebank ? String(cfg.voicebank) : '';
      const base64 = cfg && typeof cfg.base64 === 'string' ? cfg.base64 : '';
      if (!dir) return { ok: false, error: '未指定声库目录' };
      if (!base64) return { ok: false, error: '内容为空' };
      const root = path.resolve(dir);
      if (!fs.existsSync(root)) return { ok: false, error: '声库目录不存在' };
      const target = path.join(root, 'oto.ini');
      // 只允许写声库根目录下的 oto.ini（防目录穿越）
      if (path.dirname(target) !== root) return { ok: false, error: '路径不合法' };
      const buf = Buffer.from(base64, 'base64');
      if (!buf.length) return { ok: false, error: '内容为空' };
      if (buf.length > 8 * 1024 * 1024) return { ok: false, error: 'oto.ini 过大（>8MB）' };
      let backup = '';
      if (fs.existsSync(target)) {
        backup = target + '.bak';
        fs.copyFileSync(target, backup);
      }
      fs.writeFileSync(target, buf);
      return { ok: true, path: target, backup, bytes: buf.length };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 汉字 → 拼音（P1-15）：UTAU 中文声库的别名就是拼音，工具里必须有这一步，
  // 否则用户得自己把「不爱的」转成「bu ai de」再填 —— 实测就是这么过来的。
  ipcMain.handle('sing:toPinyin', (evt, cfg) => new Promise((resolve) => {
    const tokens = (cfg && Array.isArray(cfg.tokens)) ? cfg.tokens.map((x) => String(x)) : null;
    const text = (cfg && typeof cfg.text === 'string') ? cfg.text : null;
    if (!tokens && text === null) return resolve({ ok: false, error: '缺少 tokens / text' });
    if (tokens && tokens.length > 4000) return resolve({ ok: false, error: '一次最多 4000 个 token' });
    try {
      const args = tokens ? ['--tokens', JSON.stringify(tokens)] : ['--text', text];
      // 多音字候选：pypinyin 的 heteronym 结果（界面用来给「换成…」）
      if (cfg && cfg.alternatives) args.push('--alternatives');
      spawnEngine(args, {
        script: 'engine_pinyin.py',
        timeoutMs: 60 * 1000,
        onDone: (code, r) => {
          if (r && r.result && r.result.ok) return resolve(r.result);
          const err = (r && r.result && r.result.error)
            || (r && (r.err || r.out || '').slice(-300))
            || `引擎退出码 ${code}`;
          resolve({ ok: false, error: err });
        },
        onError: (e) => resolve({ ok: false, error: String(e) }),
      });
    } catch (err) {
      resolve({ ok: false, error: String((err && err.message) || err) });
    }
  }));

  // 声库体检（P2-16）：装进来的声库到底能不能用，别等渲染失败才知道。
  // 实测踩过的坑：没有 character.txt 的库整库不可用、空别名让界面误报整轨歌词不合法 ——
  // 这两类事实在装库/选库时就能算出来。
  ipcMain.handle('sing:probeVoicebank', (evt, cfg) => new Promise((resolve) => {
    const dir = cfg && cfg.voicebank ? String(cfg.voicebank) : '';
    if (!dir) return resolve({ ok: false, error: '未指定声库目录' });
    const engine = (cfg && cfg.engine) === 'diffsinger' ? 'diffsinger' : 'utau';
    const lyrics = (cfg && Array.isArray(cfg.lyrics)) ? cfg.lyrics.map((x) => String(x)).slice(0, 4000) : [];
    try {
      const args = ['--voicebank', dir, '--engine', engine];
      if (lyrics.length) args.push('--lyrics', ...lyrics);
      spawnEngine(args, {
        script: 'engine_vbcheck.py',
        timeoutMs: 90 * 1000,
        onDone: (code, r) => {
          if (r && r.result && r.result.ok) return resolve(r.result);
          const err = (r && r.result && r.result.error)
            || (r && (r.err || r.out || '').slice(-300))
            || `引擎退出码 ${code}`;
          resolve({ ok: false, error: err });
        },
        onError: (e) => resolve({ ok: false, error: String(e) }),
      });
    } catch (err) {
      resolve({ ok: false, error: String((err && err.message) || err) });
    }
  }));

  // 引擎支持的 flags 一览（含默认值/范围/说明）：UI 直接展示引擎真实规格，避免文档漂移
  ipcMain.handle('utau:flags', () => new Promise((resolve) => {
    try {
      spawnEngine(['flags'], {
        script: 'engine_utau.py',
        onDone: (code, r) => {
          if (r && r.result && r.result.ok) return resolve(r.result);
          const err = (r && r.result && r.result.error)
            || (r && (r.err || r.out || '').slice(-400))
            || `引擎退出码 ${code}`;
          resolve({ ok: false, error: err });
        },
        onError: (e) => resolve({ ok: false, error: String(e) }),
      });
    } catch (err) {
      resolve({ ok: false, error: String((err && err.message) || err) });
    }
  }));

  // ============================================================
  // UTAU 渲染引擎选择
  // ============================================================
  // `openutau` = 照搬 OpenUTAU 的核心（engine/singing/，引擎入口 engine_openutau.py）
  // `legacy`   = 本项目早期自研的 engine_utau.py
  // 默认走 openutau；**失败自动回落 legacy**，保证任何声库都还能出声（不留死路）。
  const UTAU_ENGINES = { openutau: 'engine_openutau.py', legacy: 'engine_utau.py' };
  function utauEngineScript() {
    try {
      const s = readSettings() || {};
      return UTAU_ENGINES[s.utau_engine] || UTAU_ENGINES.openutau;
    } catch (e) {
      return UTAU_ENGINES.openutau;
    }
  }

  // 渲染 UTAU 工程 → 人声 WAV（调引擎的 render-track，返回字节供预览）
  // cfg.outPath 给了就走「直写模式」：引擎产物直接落到目标路径、**不回传字节**
  //（逐轨导出用 —— 几十 MB 的 WAV 过 IPC 会把渲染进程拖卡）。
  ipcMain.handle('utau:renderTrack', (evt, cfg) => new Promise((resolve) => {
    const { voicebank, notes, sampleNote, bpm, tempoMap, curves, outPath } = cfg || {};
    let notesJson = null;   // notes 落盘文件，出口统一回收
    let tempoJson = null;   // 多点变速（同走 @文件：列表可能很长）
    let settled = false;
    const done = (r) => {
      if (settled) return undefined;
      settled = true;
      if (notesJson) { try { fs.unlinkSync(notesJson); } catch (e) {} notesJson = null; }
      if (tempoJson) { try { fs.unlinkSync(tempoJson); } catch (e) {} tempoJson = null; }
      resolve(r);
      return undefined;
    };
    try {
      if (!voicebank || !notes || !Array.isArray(notes) || !notes.length) {
        return resolve({ ok: false, error: '缺少声库目录或音符' });
      }
      /* 中间产物统一落在数据根目录 temp/（原先落系统 Temp，会持续占用 C 盘）。
         ★★ 输出放在**按 payload 哈希隔离的子目录**里：OpenUtau 的乐句缓存目录是从
            out 的同级推导的（engine_openutau.py: `<out 的目录>/_ou_cache`），而它的缓存
            在"只改了一个音的音高"时会命中旧的：
              实测（同一缓存目录）[67,69,71] 与 [67,69,74] 渲染出**同一份字节**；
              把两次渲染分别放进各自的空目录后，两者才不同。
            表现就是用户最恼火的那种"改了音高，渲染出来没变"。
            这里让缓存按内容隔离：payload 一样 → 复用同一份缓存（快）；payload 变了 → 换目录（准）。 */
      const payloadKey = crypto.createHash('sha1')
        .update(JSON.stringify({ voicebank, notes, sampleNote: sampleNote || 'C4', bpm: bpm || 120 }))
        .digest('hex').slice(0, 16);
      const ouDir = path.join(Paths.tempDir(), 'fufumidi', 'ou', payloadKey);
      fs.mkdirSync(ouDir, { recursive: true });
      pruneOuCacheDirs(path.dirname(ouDir), ouDir);
      const out = path.join(ouDir, 'render.wav');
      // 音符序列走「@临时文件」：整轨数百音符的 JSON 会撞 Windows 32K 命令行上限
      // （spawn ENAMETOOLONG）。两个引擎都原生支持 @file 约定。
      notesJson = path.join(Paths.tempDir(), 'fufumidi', `utau_notes_${Date.now()}_${process.pid}.json`);
      // 有自动化子轨时载荷升级为 {notes, curves}（引擎兼容裸数组，见 engine_openutau.py）——
      // 连续曲线值进渲染就靠它（此前曲线只被采样成逐音符值，画了渲染不理）。
      fs.writeFileSync(notesJson, JSON.stringify(
        (Array.isArray(curves) && curves.length) ? { notes, curves } : notes
      ), 'utf8');
      const args = [
        'render-track', '--voicebank', String(voicebank),
        '--notes', '@' + notesJson,
        '--sample-note', String(sampleNote || 'C4'),
        '--out', out,
      ];
      if (bpm) args.push('--bpm', String(bpm));
      // 多点变速（[{beat,bpm}]，拍单位）：给了就覆盖单点 bpm —— 导入的 ustx 变速段
      // 只有走这条路才能在渲染里生效。
      if (Array.isArray(tempoMap) && tempoMap.length) {
        tempoJson = path.join(Paths.tempDir(), 'fufumidi', `utau_tempo_${Date.now()}_${process.pid}.json`);
        fs.writeFileSync(tempoJson, JSON.stringify(tempoMap), 'utf8');
        args.push('--tempo-map', '@' + tempoJson);
      }

      const primary = utauEngineScript();
      const fallback = primary === UTAU_ENGINES.legacy
        ? UTAU_ENGINES.openutau : UTAU_ENGINES.legacy;

      // ---- 常驻会话优先（仅 openutau；legacy 无 serve，也不值得常驻）----
      // 会话层失败（崩溃/超时）→ 丢会话 + 走一次性路径（引擎回落链保留）；
      // 引擎业务错误（ok=false）同样进回落链 —— openutau 失败可能 legacy 能救。
      if (primary === UTAU_ENGINES.openutau) {
        const sess = openUtauSession();
        if (sess) {
          sess.request(args, { timeoutMs: 15 * 60 * 1000 }).then((r) => {
            if (r && r.ok && r.out && fs.existsSync(r.out)) {
              try {
                if (outPath) {
                  fs.mkdirSync(path.dirname(outPath), { recursive: true });
                  try { fs.renameSync(r.out, outPath); }
                  catch (e) { fs.copyFileSync(r.out, outPath); try { fs.unlinkSync(r.out); } catch (e2) {} }
                  return done({ ok: true, savedTo: outPath, duration_ms: r.duration_ms, warnings: r.warnings || [] });
                }
                const bytes = fs.readFileSync(r.out);
                return done({
                  ok: true, out: r.out, duration_ms: r.duration_ms, bytes,
                  warnings: r.warnings || [],
                  engineVersion: r.engine_version || '',
                  engine: 'openutau',
                });
              } catch (e) {
                return done({ ok: true, out: r.out, error: String(e) });
              }
            }
            // 业务错误或异常形状 → 回一次性路径（保留 legacy 回落链）
            dropOpenUtauSession();
            spawnWith(primary, false);
          }).catch(() => {
            dropOpenUtauSession();
            spawnWith(primary, false);
          });
          return;   // 会话路径接管（两条分支都会 done 或进回退）
        }
      }

      const spawnWith = (script, isRetry) => spawnEngine(args, {
        script,
        onDone: (code, r) => {
          if (r && r.result && r.result.ok && r.result.out && fs.existsSync(r.result.out)) {
            try {
              // 直写模式：产物挪到调用方指定的路径，字节不过 IPC
              if (outPath) {
                fs.mkdirSync(path.dirname(outPath), { recursive: true });
                try { fs.renameSync(r.result.out, outPath); }
                catch (e) { fs.copyFileSync(r.result.out, outPath); try { fs.unlinkSync(r.result.out); } catch (e2) {} }
                return done({ ok: true, savedTo: outPath, duration_ms: r.result.duration_ms, warnings: r.result.warnings || [] });
              }
              // 直接回 Buffer（结构化克隆按字节传递）：整轨 WAV 可达数十 MB，
              // 转成 number[] 会有数百 MB 的 JS 数组开销，是长曲渲染的主要瓶颈。
              const bytes = fs.readFileSync(r.result.out);
              return done({
                ok: true, out: r.result.out, duration_ms: r.result.duration_ms, bytes,
                // 引擎侧提示（歌词回退 / 未支持的 flags / 单个原音渲染失败）透传给 UI
                warnings: r.result.warnings || [],
                engineVersion: r.result.engine_version || '',
                engine: script === UTAU_ENGINES.openutau ? 'openutau' : 'legacy',
              });
            } catch (e) {
              return done({ ok: true, out: r.result.out, error: String(e) });
            }
          }
          const err = (r && r.result && r.result.error)
            || (r && (r.err || r.out || '').slice(-400))
            || `引擎退出码 ${code}`;
          // 首选引擎失败 → 用另一个再试一次（只在首选是 openutau 时回落到 legacy，
          // 反向不回落：legacy 失败通常意味着声库本身有问题，换引擎也救不回来）
          if (!isRetry && primary === UTAU_ENGINES.openutau) {
            return spawnWith(fallback, true);
          }
          done({ ok: false, error: err, engine: script === UTAU_ENGINES.openutau ? 'openutau' : 'legacy' });
        },
        onError: (e) => {
          if (!isRetry && primary === UTAU_ENGINES.openutau) return spawnWith(fallback, true);
          return done({ ok: false, error: String(e) });
        },
      });

      spawnWith(primary, false);
    } catch (err) {
      done({ ok: false, error: String((err && err.message) || err) });
    }
  }));

  // ============================================================
  // 声库资源中心：开源 / 免费 UTAU 声库一键下载安装
  // ============================================================
  // 全部条目都从「作者或上游项目公开托管的 GitHub 仓库」按需拉取（不随安装包分发、
  // 不由本项目二次镜像），使用条款原样展示，由使用者自行遵守。
  // 安装流程：下载仓库归档 zip → 只解出 subdir 下的文件 → 归一化到含 oto.ini 的目录
  // → 落到 <数据根目录>/voicebanks/，随后即可在「曲谱与调声 / 合成渲染」直接选用。
  const VB_REGISTRY = [
    {
      id: 'iona',
      dirName: 'Iona_Beta',
      name: 'Iona Beta',
      author: 'titinko',
      lang: '日本語 · 単独音（CV）',
      desc: '开源 UTAU 编辑器 utsu 自带的测试声库：日文单音（CV）覆盖完整、发音干净，体积适中，适合快速试听与调声练习。',
      license: 'MIT 许可 · 可自由使用/修改/再分发（保留版权声明）',
      repo: 'titinko/utsu',
      ref: 'master',
      subdir: 'src/main/resources/assets/sounds/Iona_Beta',
      officialUrl: 'https://github.com/titinko/utsu',
    },
    {
      id: 'howhow',
      dirName: 'HowHow_CV',
      name: 'HowHow（中文扩张整音）',
      author: 'Hugwalk / EarlySpringCommitee',
      lang: '中文 · 擴張整音（獨立音 + 語尾）',
      desc: '中文扩张整音声库：音头用独立音（如 kai、bei），语尾用「_韵母」或「韵母 R」，中文演唱自然度较高。',
      license: '免费使用 · 禁止商用（HowFun 官方标准，使用须标注作者 Hugwalk）',
      repo: 'EarlySpringCommitee/HowHow-UTAU',
      ref: 'master',
      subdir: 'CV',
      officialUrl: 'https://github.com/EarlySpringCommitee/HowHow-UTAU',
    },
    {
      id: 'chenzhe',
      dirName: 'ChenZhe_Voice',
      name: '陈者（中文单独音）',
      author: 'ciwomuli',
      lang: '中文 · 单独音（CV）',
      desc: '中文单音声库，音节覆盖常见汉字读音、单文件体积小，适合中文曲目的快速试唱。',
      license: '作者公开发布 · 仅供个人学习与非商用（版权归作者）',
      repo: 'ciwomuli/chen_zhe_voice',
      ref: 'master',
      subdir: '',
      officialUrl: 'https://github.com/ciwomuli/chen_zhe_voice',
    },
  ];

  const _vbAborts = new Map();
  const vbDirOf = (it) => path.join(vbRoot(), it.dirName);

  // 在目录（含子目录，深度上限 3）里找 oto.ini：多音阶声库常把 oto.ini 放在子目录
  function findOto(root, depth) {
    depth = depth || 0;
    if (depth > 3 || !root || !fs.existsSync(root)) return null;
    if (fs.existsSync(path.join(root, 'oto.ini'))) return root;
    let names = [];
    try { names = fs.readdirSync(root); } catch (e) { return null; }
    for (const n of names) {
      const p = path.join(root, n);
      let isDir = false;
      try { isDir = fs.statSync(p).isDirectory(); } catch (e) { continue; }
      if (!isDir) continue;
      const r = findOto(p, depth + 1);
      if (r) return r;
    }
    return null;
  }
  const vbInstalled = (it) => {
    try { return !!(findOto(vbDirOf(it), 0)); } catch (e) { return false; }
  };
  function dirBytes(root) {
    let sum = 0;
    try {
      for (const n of fs.readdirSync(root)) {
        const p = path.join(root, n);
        const st = fs.statSync(p);
        if (st.isDirectory()) sum += dirBytes(p); else sum += st.size;
      }
    } catch (e) {}
    return sum;
  }

  ipcMain.handle('utau:voicebankRegistry', () => {
    try {
      return {
        ok: true, dir: vbRoot(),
        list: VB_REGISTRY.map((it) => {
          const installed = vbInstalled(it);
          return {
            id: it.id, name: it.name, author: it.author, lang: it.lang, desc: it.desc,
            license: it.license, officialUrl: it.officialUrl, repo: it.repo,
            installed, dir: vbDirOf(it), size: installed ? dirBytes(vbDirOf(it)) : 0,
          };
        }),
      };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 下载并安装到声库目录（多源轮换 + 断点续传 + 停滞看门狗，与音色库下载同一套策略）
  ipcMain.handle('utau:downloadVoicebank', async (_e, id) => {
    const win = BrowserWindow.fromWebContents(_e.sender);
    const send = (p) => { if (win && !win.isDestroyed()) win.webContents.send('utau:voicebankProgress', p); };
    const it = VB_REGISTRY.find(x => x.id === id);
    if (!it) return { ok: false, error: '未知声库: ' + id };
    if (vbInstalled(it)) {
      send({ id, percent: 100, done: true, phase: 'done' });
      return { ok: true, existed: true, name: it.name, dir: vbDirOf(it) };
    }
    const arch = 'https://github.com/' + it.repo + '/archive/refs/heads/' + it.ref + '.zip';
    const urls = [
      'https://gh.jasonzeng.dev/' + arch,        // 国内加速（与模型/音色库下载同一入口）
      'https://ghfast.top/' + arch,
      'https://gh-proxy.com/' + arch,
      arch,                                       // 官方直连回退
      'https://codeload.github.com/' + it.repo + '/zip/refs/heads/' + it.ref,
    ];
    const dlDir = path.join(Paths.tempDir(), 'voicebank-dl');
    fs.mkdirSync(dlDir, { recursive: true });
    const zipPath = path.join(dlDir, it.id + '.zip');
    const part = zipPath + '.part';

    // 下载字节交给统一入口（多源测速 + 分段并发 + 断点续传 + 停滞看门狗 + 低速轮换）
    const entry = { ctrl: null, isUserAbort: false };
    const ctrl = new AbortController();
    entry.ctrl = ctrl;              // 取消可能早于第一次请求到达，先把控制器挂上
    _vbAborts.set(it.id, entry);
    // ★ 进度只增不减：多源轮换时如果按「本轮字节」重算，进度条会被打回 0 再涨回去，
    //   用户看到的就是「抽搐」。失败换源时保留高水位，另发 phase:'retry' 说明原因。
    let hiPct = 0;

    try {
      await FastDL.downloadFast({
        urls,
        dest: zipPath,
        minSize: 200000,             // 归档 zip 至少几百 KB；过小多半是被代理返回的错误页
        headers: { 'user-agent': 'FuFumidi' },
        isUserAbort: entry,
        ctrl,
        label: it.name || it.id,
        onProgress: (p) => {
          if (p.done) return;
          const total = p.total || 0;
          const pct = total ? Math.min(84, Math.round((p.received || 0) / total * 84)) : hiPct;
          if (pct > hiPct) hiPct = pct;
          if (p.retry) {
            send({ id, phase: 'retry', percent: hiPct, done: false, retry: p.retry, error: '第 ' + p.retry + ' 轮失败，自动换源/续传…' });
          } else {
            send({ id, phase: 'download', received: p.received || 0, total, percent: hiPct, done: false });
          }
        },
      });

      // 解包：只取声库目录，剥掉 GitHub 归档的顶层 <repo>-<ref>/ 前缀
      send({ id, phase: 'extract', percent: 88, done: false });
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipPath);
      const norm = (p) => String(p).replace(/\\/g, '/');
      const needle = it.subdir ? '/' + it.subdir + '/' : null;
      const stage = path.join(dlDir, it.id + '-extract');
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e2) {}
      fs.mkdirSync(stage, { recursive: true });
      let count = 0;
      for (const e of zip.getEntries()) {
        if (e.isDirectory) continue;
        const nm = norm(e.entryName);
        if (nm.indexOf('__MACOSX/') === 0) continue;
        let rel = null;
        if (needle) {
          const i = nm.indexOf(needle);
          if (i < 0) continue;
          rel = nm.slice(i + needle.length);
        } else {
          const i = nm.indexOf('/');
          if (i < 0) continue;
          rel = nm.slice(i + 1);
        }
        if (!rel || rel.endsWith('/')) continue;
        const dest = path.join(stage, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, e.getData());
        count++;
      }
      if (!count) throw new Error('归档里没有找到声库目录「' + (it.subdir || '/') + '」');
      const otoRoot = findOto(stage, 0);
      if (!otoRoot) throw new Error('解包结果里没有 oto.ini，可能声库结构已变更');

      // 落盘到 <voicebanks>/<dirName>
      const finalDir = vbDirOf(it);
      try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch (e2) {}
      fs.mkdirSync(path.dirname(finalDir), { recursive: true });
      try {
        fs.renameSync(otoRoot, finalDir);
      } catch (e2) {
        fs.cpSync(otoRoot, finalDir, { recursive: true });
      }
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e2) {}
      try { fs.rmSync(zipPath, { force: true }); } catch (e2) {}
      if (!findOto(finalDir, 0)) throw new Error('安装后未找到 oto.ini');
      send({ id, phase: 'done', percent: 100, done: true });
      return { ok: true, name: it.name, dir: finalDir, files: count, size: dirBytes(finalDir) };
    } catch (err) {
      send({ id, phase: 'error', percent: 0, done: true, error: String((err && err.message) || err) });
      return { ok: false, error: String((err && err.message) || err) };
    } finally {
      _vbAborts.delete(it.id);
    }
  });

  ipcMain.handle('utau:cancelVoicebankDownload', async (_e, id) => {
    try { const c = _vbAborts.get(id); if (c) { c.isUserAbort = true; c.ctrl.abort(); } } catch (e) {}
    return { ok: true };
  });
}

module.exports = { registerUtauIpc };
