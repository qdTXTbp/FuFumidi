#!/usr/bin/env node
// ============================================================
// 打包 AMD ROCm GPU 加速包：node scripts/build-gpu-package-rocm.js
//
// 与 build-gpu-package.js（cuda / directml）的区别：
//   - ROCm on Windows 只有 cp312 轮子（Python 3.12），所以这里固定用 3.12 语义安装，
//     应用侧须在「启用 AMD ROCm 加速」时切到 3.12 运行时（见 manifest.json 的 python 字段）。
//   - 组件一律取 AMD 官方 repo.radeon.com 的 wheel 直链（PyPI 上没有 rocm / rocm-sdk-* 这套 Windows 包）。
//   - rocm-sdk-devel（约 1.37GB，仅编译期头文件/导入库）**不打进运行时包**：
//     rocm 元包里 devel 是可选 extra，运行时只需 core + libraries-custom。
//
// ★ 为什么用「解压 wheel」而不是 pip install：
//   pip --target 装到同一个目录时，二次安装（哪怕只是补几个通用依赖）会让 pip 重新解析
//   target 里已有 torch 的依赖链，进而**卸载后重装** rocm-sdk-libraries-custom —— 中途被
//   打断就会留下残缺的 site-packages（实测丢了 1655/1740 个文件，torch 直接 import 失败）。
//   这些 wheel 都不含 .data 目录，直接解压即等价安装，且可逐条目校验，所以这里走解压 + 校验。
//
// 用法：
//   node scripts/build-gpu-package-rocm.js                 # 下载 + 解压 + 校验 + 打包 + 分卷
//   SKIP_DOWNLOAD=1 node scripts/build-gpu-package-rocm.js # 跳过下载（离线重打包）
//   KEEP_STAGING=1 node scripts/build-gpu-package-rocm.js  # 复用现有 staging（不归档）
//
// 环境变量：
//   PY312            Python 3.12 解释器路径（仅用于数据/校验）
//   ROCM_WHEELS      已下载 wheel 的目录（默认 .workbuddy/tmp/rocm-wheels）
//   GPU_PACKAGE_OUT  产物输出目录（默认 <repo>/gpu-package-out）
//   SEVENZIP         7z 可执行文件（默认 'C:/Program Files/7-Zip/7z.exe'）
//   PART_SIZE        分卷单片字节数（默认 1572864000 = 1.5GiB，与既有 CUDA 分卷一致）
//   SKIP_PIP         跳过解压（KEEP_STAGING 下只补 rocm_sdk + 重新打包时用）
//   SKIP_ZIP         跳过压缩分卷
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = path.resolve(path.join(__dirname, '..'));

const PY312 = process.env.PY312 || 'C:/Users/26276/AppData/Local/Programs/Python/Python312/python.exe';
const WHEELS = process.env.ROCM_WHEELS || path.join(REPO, '.workbuddy', 'tmp', 'rocm-wheels');
const STAGING = path.join(REPO, 'gpu-package-rocm');
const OUT_DIR = process.env.GPU_PACKAGE_OUT || path.join(REPO, 'gpu-package-out');
const SEVENZIP = process.env.SEVENZIP || 'C:/Program Files/7-Zip/7z.exe';
// 系统自带 bsdtar：git-bash 的 /usr/bin/tar 也能用，但显式走 System32 更稳
const TAR = process.env.TAR || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const PART_SIZE = parseInt(process.env.PART_SIZE || '1572864000', 10); // 1.5 GiB
const NAME = 'fufumidi-gpu-rocm';

const ROCM_REL = '7.2';
const ROCM_BASE = `https://repo.radeon.com/rocm/windows/rocm-rel-${ROCM_REL}`;
// 运行时组件（不含 devel）
const SDK_WHEELS = [
  'rocm_sdk_core-7.2.0.dev0-py3-none-win_amd64.whl',
  'rocm_sdk_libraries_custom-7.2.0.dev0-py3-none-win_amd64.whl',
];
const TORCH_WHEELS = [
  'torch-2.9.1%2Brocmsdk20260116-cp312-cp312-win_amd64.whl',
  'torchaudio-2.9.1%2Brocmsdk20260116-cp312-cp312-win_amd64.whl',
  'torchvision-0.24.1%2Brocmsdk20260116-cp312-cp312-win_amd64.whl',
];
// rocm 元包（sdist）：提供 `rocm_sdk` Python 模块 —— torch/_rocm_init.py 在运行时
// 会 `import rocm_sdk` 并调 `initialize_process`，缺了它 torch 直接 import 失败。
const ROCM_META = 'rocm-7.2.0.dev0.tar.gz';

const t0 = Date.now();
function log(...a) { console.log('[' + ((Date.now() - t0) / 1000).toFixed(1) + 's]', ...a); }

function run(cmd, args, opts = {}) {
  log('[run]', path.basename(cmd), args.map((x) => (String(x).length > 90 ? '…' : x)).join(' ').slice(0, 180));
  return new Promise((resolve, reject) => {
    // 本机 spawnSync / execFileSync 一律 EBUSY，必须走异步 spawn
    const c = spawn(cmd, args, { stdio: 'inherit', windowsHide: true, ...opts });
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(path.basename(cmd) + ' 退出码 ' + code))));
  });
}
function capture(cmd, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('error', reject);
    c.on('close', (code) => resolve({ code, out, err }));
  });
}
function fileSize(p) { try { return fs.statSync(p).size; } catch (e) { return -1; } }
function sha256(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(p);
    rs.on('error', reject);
    rs.on('data', (d) => h.update(d));
    rs.on('end', () => resolve(h.digest('hex')));
  });
}
function human(n) {
  return n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GiB'
    : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MiB' : (n / 1024).toFixed(0) + ' KiB';
}

/** 顺序分卷：把 src 按 partSize 切成 <outBase>.part1 / .part2 …（与既有 CUDA 分卷同规格） */
async function splitFile(src, outBase, partSize) {
  const total = fs.statSync(src).size;
  const nParts = Math.max(1, Math.ceil(total / partSize));
  const parts = [];
  const fd = fs.openSync(src, 'r');
  const CHUNK = 16 * 1024 * 1024;
  const buf = Buffer.allocUnsafe(CHUNK);
  try {
    for (let i = 1; i <= nParts; i++) {
      const p = outBase + '.part' + i;
      parts.push(p);
      const ws = fs.createWriteStream(p);
      let remaining = Math.min(partSize, total - (i - 1) * partSize);
      while (remaining > 0) {
        const want = Math.min(CHUNK, remaining);
        const got = fs.readSync(fd, buf, 0, want, null);
        if (got <= 0) throw new Error('分卷时读到意外 EOF');
        remaining -= got;
        const chunk = Buffer.from(buf.subarray(0, got)); // 拷贝：buf 会被复用
        await new Promise((res, rej) => ws.write(chunk, (e) => (e ? rej(e) : res())));
      }
      await new Promise((res, rej) => ws.end((e) => (e ? rej(e) : res())));
      log('  分卷', path.basename(p), human(fs.statSync(p).size));
    }
  } finally { fs.closeSync(fd); }
  return parts;
}

async function download() {
  fs.mkdirSync(WHEELS, { recursive: true });
  const list = [...SDK_WHEELS, ...TORCH_WHEELS, ROCM_META];
  // 并发下载（单连接只有 ~4MB/s，并行能把 2GB 拉到可接受时长）
  await Promise.all(list.map((f) => {
    const dest = path.join(WHEELS, decodeURIComponent(f));
    return run('curl.exe', ['-sSL', '--retry', '6', '--retry-delay', '3', '--retry-all-errors',
      '-C', '-', '-o', dest, `${ROCM_BASE}/${f}`]);
  }));
}

/** 把 rocm 元包里的 `rocm_sdk` 模块装进 site-packages。
 *  不走 `pip install <sdist>`：该 sdist 的 setup.py 会在构建期动态探测目标 GPU family，
 *  在没有 AMD 卡的构建机上不可控；直接取其 src/rocm_sdk 与 wheel 实际安装的内容一致。 */
async function installRocmSdkModule(site) {
  const tarPath = path.join(WHEELS, ROCM_META);
  const extractRoot = path.join(WHEELS, 'meta-extract');
  if (!fs.existsSync(path.join(extractRoot, 'rocm-7.2.0.dev0', 'src', 'rocm_sdk'))) {
    fs.mkdirSync(extractRoot, { recursive: true });
    await run(TAR, ['-xzf', tarPath, '-C', extractRoot]);
  }
  const src = path.join(extractRoot, 'rocm-7.2.0.dev0', 'src', 'rocm_sdk');
  if (!fs.existsSync(path.join(src, '__init__.py'))) throw new Error('rocm 元包里找不到 rocm_sdk 模块：' + src);
  fs.cpSync(src, path.join(site, 'rocm_sdk'), { recursive: true });
  log('  已装入 rocm_sdk 模块（torch 运行时依赖）');
}

/** 逐条目校验：wheel 里每个文件在 site-packages 里都存在（解压式安装的完整性证明） */
const VERIFY_PY = [
  'import sys, zipfile, os',
  'site = sys.argv[1]',
  'bad = []',
  'total = 0',
  'for w in sys.argv[2:]:',
  '    z = zipfile.ZipFile(w)',
  '    for n in z.namelist():',
  '        if n.endswith("/"): continue',
  '        total += 1',
  '        p = os.path.join(site, n.replace("/", os.sep))',
  '        if not os.path.exists(p): bad.append(n)',
  'print("###TOTAL", total)',
  'for b in bad[:10]: print("MISSING", b)',
  'print("###MISSING", len(bad))',
].join('\n');

async function verifySite(wheels, site) {
  const r = await capture(PY312, ['-c', VERIFY_PY, site, ...wheels]);
  const tm = (r.out || '').match(/###TOTAL (\d+)/);
  const mm = (r.out || '').match(/###MISSING (\d+)/);
  if (!tm || !mm) throw new Error('校验脚本无输出：\n' + (r.out || '') + (r.err || ''));
  const total = parseInt(tm[1], 10), missing = parseInt(mm[1], 10);
  if (missing) throw new Error(`site-packages 完整性校验失败：缺 ${missing}/${total} 个文件\n` + (r.out || '').split('\n').filter((l) => l.startsWith('MISSING')).join('\n'));
  log(`  完整性校验通过：${total} 个文件全部就位`);
  return total;
}

async function main() {
  if (!fs.existsSync(PY312)) throw new Error('找不到 Python 3.12：' + PY312);
  const pv = await capture(PY312, ['--version']);
  const pyVer = (pv.out + pv.err).trim();
  log('Python:', PY312, '->', pyVer);
  if (!/Python 3\.12\./.test(pyVer)) throw new Error('ROCm Windows 轮子是 cp312，必须用 Python 3.12（当前 ' + pyVer + '）');

  if (!process.env.SKIP_DOWNLOAD) {
    log('== 1/5 下载 ROCm 组件（core + libraries_custom + torch 三件套 + rocm 元包）==');
    await download();
  } else log('== 1/5 跳过下载 ==');

  const local = [...SDK_WHEELS, ...TORCH_WHEELS].map((f) => path.join(WHEELS, decodeURIComponent(f)));
  for (const f of local) {
    if (!fs.existsSync(f)) throw new Error('缺少 wheel：' + f);
    log('  就绪', path.basename(f), human(fileSize(f)));
  }
  if (!fs.existsSync(path.join(WHEELS, ROCM_META))) throw new Error('缺少 rocm 元包：' + path.join(WHEELS, ROCM_META));

  log('== 2/5 准备 staging ==');
  if (fs.existsSync(STAGING) && !process.env.KEEP_STAGING) {
    const bak = STAGING + '.old-' + Date.now();
    fs.renameSync(STAGING, bak);      // 用改名而非删除：本机批量删除有守卫
    log('  已把旧 staging 改名为', path.basename(bak));
  }
  const site = path.join(STAGING, 'site-packages');
  fs.mkdirSync(site, { recursive: true });

  if (!process.env.SKIP_PIP) {
    log('== 3/5 解压 wheel 到 site-packages（等价安装，免 pip 依赖解析）==');
    for (const w of local) await run(SEVENZIP, ['x', '-y', '-o' + site, w]);
    await verifySite(local, site);
  } else log('== 3/5 跳过解压 ==');
  await installRocmSdkModule(site);

  log('== 4/5 写 manifest.json ==');
  const manifest = {
    kind: 'rocm',
    vendor: 'amd',
    python: '3.12',                       // 关键：ROCm 轮子是 cp312，须配合 Python 3.12 运行时
    rocm: ROCM_REL,
    torch: '2.9.1+rocmsdk20260116',
    torchvision: '0.24.1+rocmsdk20260116',
    torchaudio: '2.9.1+rocmsdk20260116',
    sdk: ['rocm-sdk-core 7.2.0.dev0', 'rocm-sdk-libraries-custom 7.2.0.dev0'],
    sdk_excluded: ['rocm-sdk-devel（编译期，运行时不需要）'],
    generic_deps_expected_from_base: ['filelock', 'typing-extensions', 'sympy', 'networkx', 'jinja2', 'fsspec', 'setuptools'],
    onnx_provider: 'CPUExecutionProvider', // Windows 无 ROCm 版 ONNX EP，basic-pitch 仍走 CPU
    note: 'AMD ROCm on Windows 需 Adrenalin 26.1.1+ 驱动，且仅支持较新 Radeon（RX 7000/9000、Radeon PRO W7000、Ryzen AI 等）',
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(STAGING, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const zipPath = path.join(OUT_DIR, NAME + '.zip');

  if (!process.env.SKIP_ZIP) {
    log('== 5/5 压缩 + 分卷 ==');
    if (fs.existsSync(zipPath)) fs.renameSync(zipPath, zipPath + '.old-' + Date.now());
    await run(SEVENZIP, ['a', '-tzip', '-mx5', zipPath, path.join(STAGING, '*')]);
    log('  zip:', human(fileSize(zipPath)));
    const parts = await splitFile(zipPath, path.join(OUT_DIR, NAME), PART_SIZE);
    log('  分卷完成，共', parts.length, '片');
    let total = 0;
    for (const p of parts) {
      const sz = fs.statSync(p).size;
      total += sz;
      log('   ', path.basename(p), human(sz), 'sha256=' + (await sha256(p)).slice(0, 16));
    }
    log('  分卷合计', human(total));
  } else log('== 5/5 跳过压缩 ==');

  log('完成。产物目录：' + OUT_DIR);
}

main().catch((e) => { console.error('[失败]', (e && e.stack) || e); process.exit(1); });
