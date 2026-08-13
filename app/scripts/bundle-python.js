#!/usr/bin/env node
// ============================================================================
// FuFumidi 内置 Python 运行时捆绑脚本
// ============================================================================
// 目的：把"所有功能依赖内置"，让安装后的应用开箱即用，不依赖用户机器上的
//      任何 Python / pip 环境（对应 main.js resolvePython() 的 app/python/ 路径）。
//
// 原理：
//   1. 下载 python-build-standalone 的自包含 CPython（免安装、含 pip）；
//   2. 解压到 <app>/python/；
//   3. 用内置 pip 安装 engine/requirements-bundle.txt（转录引擎全部依赖）。
//
// 用法：
//   node scripts/bundle-python.js                    # 默认 CPU 版 torch（体积最小）
//   node scripts/bundle-python.js --torch cuda       # NVIDIA 显卡 → CUDA 版 torch
//   node scripts/bundle-python.js --torch directml   # AMD/Intel 显卡 → torch-directml
//   node scripts/bundle-python.js --py 3.11          # 指定 Python 大版本
//   node scripts/bundle-python.js --keep             # 完成后保留下载的压缩包
//
// 输出：app/python/python(.exe) + 全部依赖。打包时随 files:"python/**/*" 分发。
// ============================================================================
'use strict';
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

// ---------- 参数 ----------
const args = process.argv.slice(2);
const TORCH = args.includes('--torch') ? args[args.indexOf('--torch') + 1] : 'cpu';
const PY_VER = args.includes('--py') ? args[args.indexOf('--py') + 1] : '3.11';
const KEEP = args.includes('--keep');

const APP_DIR = path.resolve(__dirname, '..');
const PY_DEST = path.join(APP_DIR, 'python');
const REQ = path.join(APP_DIR, 'engine', 'requirements-bundle.txt');
const DOWNLOADS = path.join(os.tmpdir(), 'fufumidi-python');
// 全新机器 / CI runner 的 %TEMP% 里没有历史 fufumidi-python 目录，createWriteStream
// 会以 ENOENT 失败（本地能跑只是因为 temp 里残留了上次构建的目录）。必须先建目录。
fs.mkdirSync(DOWNLOADS, { recursive: true });

// python-build-standalone 发布版本（astral-sh 接管后的仓库；可被环境变量覆盖）
const REL = process.env.FF_PBS_REL || '20250409';
// 下载镜像链：国内直连 github.com 常不通，自动探测可用的加速镜像。
// FF_PBS_MIRROR 可强制指定（此时跳过探测）。
const MIRROR_LIST = [
  'https://github.com/astral-sh/python-build-standalone/releases/download',
  'https://ghfast.top/https://github.com/astral-sh/python-build-standalone/releases/download',
  'https://gh-proxy.com/https://github.com/astral-sh/python-build-standalone/releases/download',
  'https://ghproxy.net/https://github.com/astral-sh/python-build-standalone/releases/download',
];
function platformTriple() {
  const a = os.arch() === 'x64' ? 'x86_64' : (os.arch() === 'arm64' ? 'aarch64' : os.arch());
  const p = process.platform;
  if (p === 'win32') return `${a}-pc-windows-msvc`;
  if (p === 'darwin') return `${a}-apple-darwin`;
  return `${a}-unknown-linux-gnu`;
}
const TRIPLE = platformTriple();

// python-build-standalone 资产名带完整补丁号（如 cpython-3.11.12 而非 3.11.0）。
// 优先从 GitHub API 解析该 release 的真实资产名；失败则用下面的内置映射回退。
const PATCH_MAP = {
  '3.8': '3.8.20', '3.9': '3.9.21', '3.10': '3.10.17', '3.11': '3.11.12', '3.12': '3.12.10', '3.13': '3.13.3',
};
async function resolvePyFullVer() {
  try {
    const api = `https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/${REL}`;
    const body = await new Promise((res, rej) => {
      https.get(api, { headers: { 'User-Agent': 'FuFumidi-bundle/1.0' } }, r => {
        if (r.statusCode !== 200) return rej(new Error(`HTTP ${r.statusCode}`));
        let d = ''; r.on('data', c => d += c); r.on('end', () => res(d));
      }).on('error', rej);
    });
    // 限定与请求版本相同的大版本（如 3.11.x），避免匹配到列表里更早的 3.10/3.9
    const ver = PY_VER.replace('.', '\\.');
    const re = new RegExp(`"browser_download_url":\\s*"([^"]*cpython-${ver}\\.([0-9]+)%2B${REL}-${TRIPLE}-install_only\\.tar\\.gz)"`);
    const m = body.match(re);
    if (m) { info(`解析到真实资产：cpython-${PY_VER}.${m[2]}+${REL}`); return `${PY_VER}.${m[2]}`; }
    warn('API 未匹配到资产，用内置版本映射回退。');
  } catch (e) { warn(`GitHub API 解析失败（${e.message}），用内置版本映射回退。`); }
  const patch = PATCH_MAP[PY_VER];
  if (!patch) fail(`未知的 Python 版本 ${PY_VER}（可用：${Object.keys(PATCH_MAP).join(' / ')}）`);
  return patch;
}

const warn = m => console.log('\x1b[33m⚠ ' + m + '\x1b[0m');
const info = m => console.log('\x1b[36m▸ ' + m + '\x1b[0m');
const ok = m => console.log('\x1b[32m✓ ' + m + '\x1b[0m');
const fail = m => { console.error('\x1b[31m✗ ' + m + '\x1b[0m'); process.exit(1); };

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const doGet = (u, hops) => {
      const req = https.get(u, { headers: { 'User-Agent': 'FuFumidi-bundle/1.0' }, timeout: 60000 }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 6) {
          res.resume();
          info(`跳转 → ${res.headers.location.split('?')[0]}`);
          return doGet(res.headers.location, hops + 1);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ${u}`));
        const expected = parseInt(res.headers['content-length'] || '0', 10);
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        let got = 0;
        let settled = false;
        const done = (err) => {
          if (settled) return; settled = true;
          try { res.destroy(); } catch {}
          try { file.close(); } catch {}
          if (err) reject(err); else resolve(dest);
        };
        res.on('data', d => { got += d.length; process.stdout.write(`\r    ${(got / 1048576).toFixed(0)} MB`); });
        res.on('aborted', () => done(new Error('连接中断（下载不完整）')));
        res.on('error', e => done(e));
        file.on('error', e => done(e));
        file.on('finish', () => {
          // 校验 Content-Length：连接提前断开时 pipe 会以不完整数据收尾
          if (expected && got !== expected) return done(new Error(`下载不完整：预期 ${expected} 字节，实得 ${got}`));
          process.stdout.write('\n');
          done(null);
        });
      });
      req.on('timeout', () => { req.destroy(new Error('下载超时')); });
      req.on('error', reject);
    };
    doGet(url, 0);
  });
}

// 首选下载法：GitHub API 直链。国内 github.com 常被重置，但 api.github.com 与
// release-assets.githubusercontent.com 可达——用 asset 端点 + Accept: octet-stream
// 拿到签名直链再下载，绕开 github.com。CI 上同样可用。
async function downloadViaApi(fullVer) {
  const probe = `cpython-${fullVer}%2B${REL}-${TRIPLE}-install_only.tar.gz`;
  try {
    const api = `https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/${REL}`;
    const body = await new Promise((res, rej) => {
      https.get(api, { headers: { 'User-Agent': 'FuFumidi-bundle/1.0' }, timeout: 20000 }, r => {
        if (r.statusCode !== 200) return rej(new Error(`HTTP ${r.statusCode}`));
        let d = ''; r.on('data', c => d += c); r.on('end', () => res(d));
      }).on('error', rej);
    });
    // API 的 assets[].name 是字面文件名（+ 未编码），而 URL/文件名用 %2B
    const literalName = probe.replace(/%2B/g, '+');
    const assets = JSON.parse(body).assets;
    const asset = assets.find(a => a.name === literalName);
    if (!asset) throw new Error('API 中未找到资产 ' + literalName);
    const shaAsset = assets.find(a => a.name === literalName + '.sha256');
    // asset 端点 + octet-stream → 302 到签名的 release-assets.githubusercontent.com
    const signedUrlOf = u => new Promise((res, rej) => {
      const req = https.get(u, {
        headers: { 'User-Agent': 'FuFumidi-bundle/1.0', 'Accept': 'application/octet-stream' }, timeout: 20000,
      }, r => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return res(r.headers.location); }
        r.resume(); rej(new Error('asset 端点未重定向: HTTP ' + r.statusCode));
      });
      req.on('error', rej); req.on('timeout', () => { req.destroy(new Error('超时')); });
    });
    const getText = u => new Promise((res, rej) => {
      https.get(u, { headers: { 'User-Agent': 'FuFumidi-bundle/1.0' }, timeout: 20000 }, r => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => res(d));
      }).on('error', rej);
    });
    info('GitHub API 直链就绪（release-assets.githubusercontent.com）');
    const dest = path.join(DOWNLOADS, probe);
    // 官方 .sha256 文件作完整性校验（传输可能被中间环节损坏，仅对大小不够）
    let expectHash = null;
    if (shaAsset) {
      try { expectHash = (await getText(await signedUrlOf(shaAsset.url))).match(/^([0-9a-f]{64})/im)?.[1]?.toLowerCase() || null; }
      catch { warn('无法获取 .sha256，改用大小校验。'); }
    }
    // 复用：已有文件且通过校验则直接跳过下载
    if (expectHash && fs.existsSync(dest)) {
      const crypto = require('crypto');
      const h = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
      if (h === expectHash) { ok('复用已下载的压缩包（SHA256 通过）'); return dest; }
      warn('已有文件 SHA256 不符，重新下载。');
    }
    const loc = await signedUrlOf(asset.url);
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { fs.rmSync(dest, { force: true }); } catch {}
      await download(loc, dest);
      if (expectHash) {
        const crypto = require('crypto');
        const real = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
        if (real === expectHash) { ok('SHA256 校验通过'); break; }
        lastErr = new Error(`SHA256 不符（第 ${attempt} 次）`);
        warn(`SHA256 校验失败（${attempt}/3），重新下载…`);
      } else if (asset.size && fs.statSync(dest).size !== asset.size) {
        lastErr = new Error('大小不符');
        warn(`大小校验失败（${attempt}/3），重新下载…`);
      } else break;
      if (attempt === 3) throw lastErr || new Error('下载校验多次失败');
    }
    return dest;
  } catch (e) {
    warn(`GitHub API 直链下载失败（${e.message}），改用镜像列表。`);
    return null;
  }
}

// 下载带逐镜像回退：直连 github.com 在国内常被重置，失败自动换加速镜像重试。
async function downloadFromMirrors(fullVer) {
  const probe = `cpython-${fullVer}%2B${REL}-${TRIPLE}-install_only.tar.gz`;
  const mirrors = process.env.FF_PBS_MIRROR ? [process.env.FF_PBS_MIRROR] : MIRROR_LIST;
  const dest = path.join(DOWNLOADS, probe);
  let lastErr = null;
  for (const base of mirrors) {
    const host = base.replace(/^https?:\/\//, '').split('/')[0];
    info(`下载源：${host}`);
    try {
      await download(`${base}/${REL}/${probe}`, dest);
      return dest;
    } catch (e) {
      lastErr = e;
      warn(`下载源 ${host} 失败：${e.message}，尝试下一个镜像…`);
      try { fs.rmSync(dest, { force: true }); } catch {}
    }
  }
  fail(`所有下载源均失败：${lastErr ? lastErr.message : ''}\n可设置 FF_PBS_MIRROR 指定可用的下载地址，或手动下载到 ${dest}`);
}

// ---------- 离线模型预置 ----------
// 转录引擎首次运行需要下载的模型（basic-pitch 的 ONNX 已随 wheel 内置，无需处理）：
//   - demucs htdemucs 权重：拷入 <py>/site-packages/demucs/remote/（库已支持本地 drop-in，零改码）
//   - piano 转录 checkpoint：拷入 <app>/models/piano_transcription/（engine_pt.py 读 FUFUMIDI_MODELS_DIR）
// 来源：本地开发机已有则直接拷贝（快、稳）；否则联网下载。
const DEMUCS_TH = '955717e8-8726e21a.th';
const PIANO_CKPT = 'note_F1=0.9677_pedal_F1=0.9186.pth';
function localModelSources() {
  const m = process.env.FF_MODELS_DIR || '';
  return {
    demucs: [
      m && path.join(m, 'demucs', DEMUCS_TH),
      'D:/manga-image-translator/Miniconda3/Lib/site-packages/demucs/remote/' + DEMUCS_TH,
    ].filter(Boolean),
    piano: [
      m && path.join(m, 'piano_transcription', PIANO_CKPT),
      path.join(os.homedir(), 'piano_transcription_inference_data', PIANO_CKPT),
    ].filter(Boolean),
  };
}
async function preseedModels(exe) {
  info('预置离线模型（demucs 人声分离 / piano 钢琴转录，首次转录免联网）…');
  const src = localModelSources();

  // --- demucs：拷入库内置 remote 目录 ---
  // 用 -E 忽略 PYTHONPATH/PYTHONHOME，且不靠 import demucs 猜位置（可能被外部
  // site-packages 劫持，导致 dest 指到别的目录变成自我复制 no-op）；直接以
  // sysconfig.purelib 计算内置 site-packages，再拼 demucs/remote。
  const purelib = spawnSync(exe, ['-E', '-c',
    'import sysconfig;print(sysconfig.get_paths()["purelib"])'],
    { encoding: 'utf8' }).stdout.trim();
  if (purelib) {
    const dm = path.join(purelib, 'demucs', 'remote');
    const dest = path.join(dm, DEMUCS_TH);
    const s = src.demucs.find(p => p && fs.existsSync(p));
    if (s) {
      fs.mkdirSync(dm, { recursive: true });
      fs.copyFileSync(s, dest);
      // 复制后校验真的落在了内置目录（防 self-copy no-op / 路径被劫持）
      if (fs.existsSync(dest) && fs.statSync(dest).size > 8e7) {
        ok(`demucs 模型：内置 remote 就位（${(fs.statSync(dest).size / 1048576).toFixed(0)} MB）→ ${dest}`);
      } else {
        fail(`demucs 模型复制失败：${dest} 未生效，请检查内置 python 的 site-packages 解析。`);
      }
    } else {
      info(`下载 demucs 模型（${DEMUCS_TH}，约 80MB）…`);
      try {
        fs.mkdirSync(dm, { recursive: true });
        await download('https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/' + DEMUCS_TH, dest);
        ok('demucs 模型下载完成');
      } catch (e) { warn(`demucs 模型下载失败：${e.message}（首次人声分离会联网下载）`); }
    }
  } else {
    warn('未定位内置 site-packages，跳过内置 demucs 模型。');
  }

  // --- piano：拷入 <app>/models/piano_transcription（随 extraResources 分发到 resources/models） ---
  const pianoDest = path.join(APP_DIR, 'models', 'piano_transcription', PIANO_CKPT);
  const sp = src.piano.find(p => p && fs.existsSync(p));
  if (sp) {
    fs.mkdirSync(path.dirname(pianoDest), { recursive: true });
    fs.copyFileSync(sp, pianoDest);
    ok(`piano 模型：本地复制（${(fs.statSync(pianoDest).size / 1048576).toFixed(0)} MB）`);
  } else {
    info('下载 piano 模型（约 164MB）…');
    try {
      fs.mkdirSync(path.dirname(pianoDest), { recursive: true });
      await download('https://zenodo.org/record/4034264/files/CRNN_' + encodeURIComponent(PIANO_CKPT) + '?download=1', pianoDest);
      ok('piano 模型下载完成');
    } catch (e) { warn(`piano 模型下载失败：${e.message}（首次钢琴转录会联网下载）`); }
  }
}

function run(cmd, argsArr, cwd) {
  const r = spawnSync(cmd, argsArr, { cwd, stdio: 'inherit', shell: false });
  if (r.status !== 0) fail(`命令失败（退出码 ${r.status}）：${cmd} ${argsArr.join(' ')}`);
}

function tarExe() {
  // Windows 用系统内置 tar.exe（bsdtar/libarchive）：Git Bash 的 GNU tar 对该
  // gzip 文件会报 "gzip: stdin: unexpected end of file"（文件本身校验完全正常）。
  // macOS/Linux 用系统 tar。
  if (process.platform === 'win32') {
    const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(sysTar)) return sysTar;
    try { execSync('where tar', { stdio: 'pipe' }); return 'tar'; } catch { return null; }
  }
  return 'tar';
}

(async () => {
  info(`平台：${process.platform} / ${process.arch} → ${TRIPLE}`);
  info(`torch 版本：${TORCH === 'cuda' ? 'CUDA 12.1' : TORCH === 'directml' ? 'DirectML（AMD/Intel GPU）' : 'CPU（体积最小）'}`);
  info(`目标目录：${PY_DEST}`);

  if (fs.existsSync(path.join(PY_DEST, process.platform === 'win32' ? 'python.exe' : 'bin/python3'))) {
    warn('已存在内置 Python。如需重建，请先删除 app/python/ 目录。');
    process.exit(0);
  }

  const PY_FULL = await resolvePyFullVer();
  let TAR = await downloadViaApi(PY_FULL);
  if (!TAR) TAR = await downloadFromMirrors(PY_FULL);
  ok(`下载完成 ${(fs.statSync(TAR).size / 1048576).toFixed(0)} MB（${path.basename(TAR)}）`);

  // gzip 魔数兜底：文件头必须是 1f 8b，否则删除重来
  const head = fs.readFileSync(TAR).subarray(0, 2);
  if (head[0] !== 0x1f || head[1] !== 0x8b) {
    try { fs.rmSync(TAR, { force: true }); } catch {}
    fail('压缩包损坏（gzip 魔数不符），已删除。请重新运行脚本重试下载。');
  }

  const tar = tarExe();
  if (!tar) fail('未找到 tar 命令，无法解压。请安装系统 tar 后重试。');
  info('解压到 app/python/ …');
  fs.mkdirSync(PY_DEST, { recursive: true });
  // tarball 顶层是 python/ 目录，--strip-components=1 去掉这一层，
  // 使 python.exe 直接位于 app/python/python.exe
  run(tar, ['-xzf', TAR, '-C', PY_DEST, '--strip-components=1'], APP_DIR);

  const exe = process.platform === 'win32'
    ? path.join(PY_DEST, 'python.exe')
    : path.join(PY_DEST, 'bin', 'python3');
  if (!fs.existsSync(exe)) fail(`解压后未找到解释器：${exe}`);

  info('升级 pip …');
  run(exe, ['-m', 'pip', 'install', '--upgrade', 'pip', '--disable-pip-version-check', '-q'], APP_DIR);

  info(`安装 torch（${TORCH}）…`);
  if (TORCH === 'cuda') {
    run(exe, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q',
      'torch', '--index-url', 'https://download.pytorch.org/whl/cu121'], APP_DIR);
  } else if (TORCH === 'directml') {
    run(exe, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', 'torch-directml'], APP_DIR);
  }
  // CPU 版 torch 由 requirements-bundle.txt 统一安装

  info('安装其余依赖（requirements-bundle.txt）…');
  run(exe, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', REQ], APP_DIR);

  ok('依赖安装完成。');
  await preseedModels(exe);
  // 瘦身：删除测试套件与编译缓存，减小包体（委托给 scripts/prune-python.js，
  // 它只碰任务 #38 点名的无运行期用途内容，绝不动任何依赖包）。
  info('清理无用文件（测试套件 / __pycache__ / torch 构建工具）…');
  const prune = path.join(APP_DIR, 'scripts', 'prune-python.js');
  if (fs.existsSync(prune)) {
    const r = spawnSync(process.execPath, [prune, '--commit'], { stdio: 'inherit', shell: false });
    if (r.status !== 0) warn('prune-python.js 清理退出码 ' + r.status + '，继续打包。');
  } else {
    // 兜底：脚本缺失时直接删掉编译缓存（不删任何依赖）
    const stack = [path.join(PY_DEST, 'Lib')];
    while (stack.length) {
      const cur = stack.pop();
      let ents;
      try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const fp = path.join(cur, e.name);
        if (e.isDirectory()) {
          if (e.name === '__pycache__') { try { fs.rmSync(fp, { recursive: true, force: true }); } catch {} }
          else stack.push(fp);
        }
      }
    }
  }
  if (!KEEP) { try { fs.rmSync(TAR, { force: true }); } catch {} }

  // 验证
  info('验证引擎 probe …');
  const r = spawnSync(exe, [path.join(APP_DIR, 'engine', 'music2midi.py'), 'probe'],
                      { encoding: 'utf8', cwd: path.join(APP_DIR, 'engine') });
  if (r.status === 0) {
    try {
      const p = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      ok(`内置 Python 就绪：${p.python} · universal=${p.engines.universal.available} · piano=${p.engines.piano.available} · separate=${p.engines.separate.available}`);
    } catch { ok('probe 返回成功（JSON 解析见上方输出）'); }
  } else {
    warn('probe 未通过（见上方错误）。请检查网络与依赖后重试。');
  }
  // 最终校验：三个引擎的离线模型必须真实就位（basic-pitch ONNX 已随 wheel 内置）
  const purelib2 = spawnSync(exe, ['-E', '-c',
    'import sysconfig;print(sysconfig.get_paths()["purelib"])'],
    { encoding: 'utf8' }).stdout.trim();
  const demucsTh = purelib2 && path.join(purelib2, 'demucs', 'remote', DEMUCS_TH);
  const pianoTh = path.join(APP_DIR, 'models', 'piano_transcription', PIANO_CKPT);
  const bpOnnx = purelib2 && path.join(purelib2, 'basic_pitch', 'saved_models', 'icassp_2022', 'nmp.onnx');
  const checks = [
    ['demucs 人声分离', demucsTh],
    ['piano 钢琴转录', pianoTh],
    ['basic-pitch 通用', bpOnnx],
  ];
  let allOk = true;
  for (const [label, p] of checks) {
    const size = (p && fs.existsSync(p) && fs.statSync(p).size) || 0;
    if (size > 0) ok(`离线模型就位 · ${label}（${(size / 1048576).toFixed(0)} MB）`);
    else { allOk = false; warn(`离线模型缺失 · ${label}：${p || '未知路径'}`); }
  }
  if (!allOk) fail('离线模型校验失败：存在缺失模型，请修复后重新构建。');

  ok('完成。打包时 python 随 extraResources 分发到 resources/python，models 分发到 resources/models。');
})().catch(e => fail(e.stack || String(e)));
