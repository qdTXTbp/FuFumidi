// ============================================================
// UTAU 声库制作 IPC：声库导出 + 人声渲染 + 现成声库导入
// ============================================================
'use strict';
const Paths = require('./paths');
const { safeExtractAllTo } = require('./zip-safe');
// 直接 require 而不是走 `registerUtauIpc` 的入参：本模块的注册参数里没有 readSettings，
// 而引擎选择要读设置。Node 模块缓存保证拿到的是同一个 settings 单例。
const { readSettings } = require('./settings');

function registerUtauIpc({ ipcMain, BrowserWindow, path, fs, os, app, dialog, net, spawnEngine, createEngineSession }) {
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
      const args = ['aliases', '--voicebank', String(voicebank), '--limit', String(Math.max(1, Math.min(2000, Number(limit) || 300)))];
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
      // 中间产物统一落在数据根目录 temp/（原先落系统 Temp，会持续占用 C 盘）
      const out = path.join(Paths.tempDir(), 'fufumidi', `utau_render_${Date.now()}.wav`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
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

    const STALL_MS = 25000;
    const MAX_ROUNDS = 10;
    const entry = { ctrl: null, isUserAbort: false };
    _vbAborts.set(it.id, entry);
    let ws = null, lastErr = null;

    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const url = urls[round % urls.length];
        const ctrl = new AbortController();
        entry.ctrl = ctrl;
        try {
          let have = 0;
          try { have = fs.statSync(part).size; } catch (e) {}
          const headers = { 'user-agent': 'FuFumidi' };
          if (have > 0) headers['range'] = 'bytes=' + have + '-';
          const r = await net.fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
          if (r.status === 416) {
            try { fs.rmSync(part, { force: true }); } catch (e2) {}
            throw new Error('断点越界已重置');
          }
          if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
          const clen = parseInt(r.headers.get('content-length') || '0', 10);
          const resumable = r.status === 206 && have > 0;
          if (!resumable && have > 0) { try { fs.rmSync(part, { force: true }); } catch (e2) {} have = 0; }
          const total = clen ? have + clen : 0;
          ws = fs.createWriteStream(part, { flags: resumable ? 'a' : 'w' });
          ws.on('error', () => {});
          const reader = r.body.getReader();
          let lastData = Date.now();
          const watchdog = setInterval(() => {
            if (Date.now() - lastData > STALL_MS) {
              try { reader.cancel('stalled'); } catch (e2) {}
              try { ctrl.abort(); } catch (e2) {}
            }
          }, 3000);
          let got = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              lastData = Date.now();
              got += value.length;
              const received = have + got;
              send({ id, phase: 'download', received, total, percent: total ? Math.min(84, Math.round(received / total * 84)) : 0, done: false });
              await new Promise((res2, rej2) => ws.write(Buffer.from(value), err => (err ? rej2(err) : res2())));
            }
          } finally { clearInterval(watchdog); }
          await new Promise((res2, rej2) => ws.end(err => (err ? rej2(err) : res2())));
          ws = null;
          const st = fs.statSync(part);
          // 归档 zip 至少几百 KB；过小多半是被代理返回的错误页
          if (st.size < 200000) { lastErr = new Error('归档过小（' + st.size + ' B），可能被代理拦截'); continue; }
          try { fs.rmSync(zipPath, { force: true }); } catch (e2) {}
          fs.renameSync(part, zipPath);
          break;
        } catch (e) {
          lastErr = e;
          try { if (ws) ws.destroy(); } catch (e2) {}
          ws = null;
          if (entry.isUserAbort) return { ok: false, cancelled: true, error: '已取消' };
          send({ id, phase: 'download', percent: 0, done: false, error: '第 ' + (round + 1) + ' 轮失败，自动换源/续传…' });
          if (round === MAX_ROUNDS - 1) {
            return { ok: false, error: '下载失败（已多源轮换 ' + MAX_ROUNDS + ' 轮）：' + ((lastErr && lastErr.message) || '网络不可达') };
          }
        }
      }

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
