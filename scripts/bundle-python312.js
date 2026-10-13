#!/usr/bin/env node
// ============================================================
// 装配【Python 3.12 引擎运行时】到 resources/python312
//
// 为什么需要第二套运行时：AMD 的 Windows ROCm 轮子只有 **cp312**，而内置运行时是 3.11。
// 启用 ROCm 增强包时，应用会把引擎解释器切到这套 3.12 运行时（见 main.js 的
// bundledPython312 / resolvePython / engineEnv）。
//
// ★ 两个硬性约定（改坏了 ROCm 就不生效）：
//   1) 目录里**不能有 python312._pth**。embeddable 发行版带这个文件，它会开启
//      isolated 模式 —— 直接忽略 PYTHONPATH，而 GPU 增强包正是靠 PYTHONPATH 叠加的。
//      所以这里用 NuGet 的完整版布局（tools/ 下就是 Lib/Scripts/DLLs/include/libs，
//      与 resources/python 的 3.11 布局一致），它天然没有 ._pth。
//   2) 依赖装齐后才写 `.fufumidi-engine-ready` 标记；main.js 只认带标记的 3.12 运行时，
//      否则会把整个引擎切到一个缺依赖的解释器上（所有转录功能一起挂）。
//
// 与 bundle-python.js 的关系：依赖清单、TF 剔除、aria git 包、VC++ 运行库部署全部同源
//（同一份 engine/requirements-bundle.txt），只有目标目录与运行时来源不同。
//
// 用法：
//   node scripts/bundle-python312.js            # 装配 + 自检（首次会下 ~15MB NuGet + 依赖）
//   node scripts/bundle-python312.js --check    # 只自检，不安装
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const pythonDir = path.join(root, 'resources', 'python312');
const python = path.join(pythonDir, process.platform === 'win32' ? 'python.exe' : 'bin/python3');
const reqFile = path.join(root, 'engine', 'requirements-bundle.txt');
const depsPy = path.join(root, 'engine', 'deps.py');
const readyMark = path.join(pythonDir, '.fufumidi-engine-ready');

// 完整版布局（含 Lib/Scripts/ensurepip），与 resources/python 的 3.11 一致；
// embeddable 版带 ._pth 会屏蔽 PYTHONPATH，不能用于本用途。
const PY312_VERSION = '3.12.10';
const NUPKG_URLS = [
  'https://globalcdn.nuget.org/packages/python.' + PY312_VERSION + '.nupkg',
  'https://www.nuget.org/api/v2/package/python/' + PY312_VERSION,
];

const PIP_MIRRORS = [
  'https://pypi.tuna.tsinghua.edu.cn/simple',
  'https://mirrors.aliyun.com/pypi/simple',
  'https://pypi.org/simple',
];
const VCRUNTIME = [
  'vcruntime140.dll', 'vcruntime140_1.dll', 'vcruntime140_threads.dll',
  'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll',
  'msvcp140_atomic_wait.dll', 'msvcp140_codecvt_ids.dll',
  'concrt140.dll', 'vcomp140.dll', 'vccorlib140.dll',
];
const VCRUNTIME_SRC = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const TF_STACK = ['tensorflow', 'tensorflow-intel', 'tensorflow-estimator', 'tensorflow-io-gcs-filesystem', 'keras'];
const GIT_MIRRORS = [
  'https://gh.jasonzeng.dev/https://github.com/',
  'https://ghfast.top/https://github.com/',
  'https://gh-proxy.com/https://github.com/',
  'https://github.com/',
];
const ARCHIVE_REFS = ['main', 'master'];
const GIT_PKGS = [
  { name: 'amt', repo: 'EleutherAI/aria-amt', noDeps: true },
  { name: 'ariautils', repo: 'EleutherAI/aria-utils', noDeps: false },
];

const checkOnly = process.argv.includes('--check');

function tryRun(cmd) {
  const r = spawnSync(cmd, { shell: true, stdio: 'pipe', encoding: 'utf8' });
  return r.status === 0;
}
function pipAnywhere(args) {
  for (const m of PIP_MIRRORS) {
    if (tryRun('"' + python + '" -m pip install --no-input -q --disable-pip-version-check -i ' + m + ' ' + args)) return true;
  }
  return false;
}

/* ---------------- 1) 准备 3.12 运行时本体 ---------------- */
function ensureRuntime() {
  if (fs.existsSync(python)) { console.log('[1/5] 3.12 运行时已存在：' + pythonDir); return; }
  console.log('[1/5] 未找到 ' + pythonDir + '，开始下载并展开 NuGet python ' + PY312_VERSION + ' …');
  const tmp = path.join(root, '.workbuddy', 'tmp', 'py312-bootstrap');
  fs.mkdirSync(tmp, { recursive: true });
  const nupkg = path.join(tmp, 'python.' + PY312_VERSION + '.nupkg');
  if (!fs.existsSync(nupkg) || fs.statSync(nupkg).size < 1024 * 1024) {
    let ok = false;
    for (const u of NUPKG_URLS) {
      console.log('    下载 ' + u);
      if (spawnSync('curl.exe', ['-sSL', '--retry', '5', '--retry-all-errors', '--max-time', '600', '-o', nupkg, u], { stdio: 'inherit' }).status === 0
          && fs.existsSync(nupkg) && fs.statSync(nupkg).size > 1024 * 1024) { ok = true; break; }
    }
    if (!ok) { console.error('[错误] NuGet 包下载失败（3 个源都不可用）'); process.exit(1); }
  }
  // nupkg 就是 zip，tools/ 下即完整 CPython 布局（Lib / Scripts / DLLs / include / libs）
  fs.mkdirSync(tmp, { recursive: true });
  const unzipDir = path.join(tmp, 'unzip');
  fs.rmSync(unzipDir, { recursive: true, force: true });
  // ★ 解压要三条兜底。原来只试了 C:/Program Files/7-Zip/7z.exe —— 但本机 7z 是
  //   scoop 装的（在 PATH 上、不在 Program Files），于是直接掉到 PowerShell 分支；
  //   而 PS 5.1 的 Expand-Archive **只认 .zip 扩展名**，喂 .nupkg 会拒，
  //   结果报「7z 与 PowerShell 都不可用」——其实两个都在。（实测踩到。）
  const zipCopy = path.join(tmp, 'python312.zip');
  let unzipped = tryRun('"C:/Program Files/7-Zip/7z.exe" x -y -o"' + unzipDir + '" "' + nupkg + '"');
  if (!unzipped) {
    // 兜底 2：PATH 上的 7z（scoop / winget / choco 装的多半在这）
    unzipped = tryRun('7z x -y -o"' + unzipDir + '" "' + nupkg + '"');
  }
  if (!unzipped) {
    // 兜底 3：复制成 .zip 再 Expand-Archive（PS 5.1 认扩展名）
    try { fs.copyFileSync(nupkg, zipCopy); } catch (e) {}
    unzipped = tryRun('powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath \'' + zipCopy + '\' -DestinationPath \'' + unzipDir + '\' -Force"');
  }
  if (!unzipped) {
    console.error('[错误] 展开 NuGet 包失败（已试：Program Files 的 7z / PATH 上的 7z / Expand-Archive）');
    process.exit(1);
  }
  const tools = path.join(unzipDir, 'tools');
  if (!fs.existsSync(path.join(tools, 'python.exe'))) { console.error('[错误] NuGet 包里没有 tools/python.exe'); process.exit(1); }
  fs.mkdirSync(path.dirname(pythonDir), { recursive: true });
  fs.cpSync(tools, pythonDir, { recursive: true });
  // 兜底：万一上游改成带 ._pth 的布局，直接删掉它（否则 PYTHONPATH 会被忽略）
  for (const f of fs.readdirSync(pythonDir)) {
    if (/^python\d+\._pth$/i.test(f)) { fs.rmSync(path.join(pythonDir, f)); console.log('    已移除 ' + f + '（它会屏蔽 PYTHONPATH）'); }
  }
  console.log('    已展开到 ' + pythonDir);
}

if (!checkOnly) {
  ensureRuntime();
  if (!fs.existsSync(python)) { console.error('[错误] 找不到 ' + python); process.exit(1); }

  console.log('[2/5] 引导 pip（ensurepip）');
  if (!tryRun('"' + python + '" -m pip --version')) {
    if (!tryRun('"' + python + '" -m ensurepip --upgrade')) { console.error('[错误] ensurepip 失败'); process.exit(1); }
  }
  console.log('    ' + (spawnSync('"' + python + '" -m pip --version', { shell: true, encoding: 'utf8' }).stdout || '').trim());

  console.log('[3/5] 安装 engine/requirements-bundle.txt');
  // ★ Python 3.12 上必须把 basic-pitch 拆出来单独装（实测踩到）：
  //   basic-pitch 声明了 `tensorflow<2.15.1,>=2.4.1; python_version >= "3.11"`，
  //   而 TensorFlow **从未为 3.12 发布过 2.15.x 轮子**（最早 2.16.0rc0）——
  //   约束不可能满足，pip 于是报「所有镜像均不可用」，看起来像网络问题，其实是依赖冲突。
  //   这也正是基础运行时必须停在 3.11 的原因。
  //   而本脚本本来就要把 TensorFlow 卸掉（见下方 TF_STACK），说明它根本不该进来；
  //   所以：主清单里剔掉 basic-pitch，再用 --no-deps 单独装它，
  //   它真正需要的运行时依赖由主清单与下面的补充项提供。
  const reqText = fs.readFileSync(reqFile, 'utf8');
  const reqFiltered = reqText.split(/\r?\n/)
    .filter(l => !/^\s*basic-pitch\b/i.test(l))
    .join('\n');
  const reqTmp = path.join(require('os').tmpdir(), 'fufumidi-req312.txt');
  fs.writeFileSync(reqTmp, reqFiltered, 'utf8');
  if (!pipAnywhere('-r "' + reqTmp + '"')) {
    console.error('[错误] requirements-bundle.txt 安装失败（已剔除 basic-pitch）：所有镜像均不可用');
    process.exit(1);
  }
  console.log('    单独安装 basic-pitch（--no-deps，绕开 tensorflow<2.15.1 在 3.12 上无解）');
  if (!pipAnywhere('--no-deps basic-pitch>=0.4.0')) {
    console.error('[错误] basic-pitch 安装失败');
    process.exit(1);
  }
  // basic-pitch 真正需要的、主清单没覆盖的运行时依赖（--no-deps 装它就得自己补）
  // ★ resampy 是 basic-pitch 的依赖，--no-deps 装它就必须自己补上 ——
  //   漏了它，自检会报 `universal FAIL missing: resampy`，脚本据此拒绝写就绪标记，
  //   整个 3.12 运行时白装（实测第一轮就漏了这一个）。
  pipAnywhere('scikit-learn>=1.0 typing-extensions>=4.0 mir-eval>=0.6 resampy>=0.4');
  // 与 3.11 运行时一致：basic-pitch 会拖来整套 TensorFlow，装完立刻卸掉
  for (const p of TF_STACK) tryRun('"' + python + '" -m pip uninstall -y -q ' + p);
  if (spawnSync('"' + python + '" -c "import tensorflow"', { shell: true }).status === 0) {
    console.error('[错误] TensorFlow 仍在运行时里（约 1.1GB，不应随包分发）');
    process.exit(1);
  }
  console.log('    已确认运行时不带 TensorFlow（走 ONNX 后端）');

  console.log('[4/5] 部署 VC++ 2015-2022 x64 运行库');
  const lack = [];
  for (const dll of VCRUNTIME) {
    const src = path.join(VCRUNTIME_SRC, dll);
    if (!fs.existsSync(src)) { lack.push(dll); continue; }
    try { fs.copyFileSync(src, path.join(pythonDir, dll)); } catch (_) {}
  }
  if (lack.length) {
    console.error('[错误] 宿主机缺这些运行库文件：' + lack.join(', '));
    console.error('       请先装「Microsoft Visual C++ 2015-2022 Redistributable (x64)」，再重跑本脚本。');
    process.exit(1);
  }
  console.log('    已部署 ' + VCRUNTIME.length + ' 个 DLL');

  console.log('[5/5] 安装 aria 组（不在 PyPI，走 GitHub）');
  const git = tryRun('git --version');
  for (const pkg of GIT_PKGS) {
    const extra = pkg.noDeps ? ' --no-deps' : '';
    const specs = [];
    if (git) for (const m of GIT_MIRRORS) specs.push('git+' + m + pkg.repo + '.git');
    for (const m of GIT_MIRRORS) for (const ref of ARCHIVE_REFS)
      specs.push(m + pkg.repo + '/archive/refs/heads/' + ref + '.zip');
    let ok = false;
    for (const spec of specs) {
      if (tryRun('"' + python + '" -m pip install --no-input -q --disable-pip-version-check' + extra + ' "' + spec + '"')) {
        console.log('    [ok] ' + pkg.name + '  <-  ' + spec); ok = true; break;
      }
    }
    if (!ok) { console.error('[错误] ' + pkg.name + ' 安装失败：所有镜像 / 分支组合均不可用'); process.exit(1); }
  }
}

/* ---------------- 自检 ---------------- */
if (!fs.existsSync(python)) {
  console.log('== 自检 ==');
  console.log('    Python 3.12 运行时尚未安装（' + pythonDir + ' 不存在）');
  console.log('    → ROCm 增强包在应用里会显示为「已安装但未启用」，其余功能不受影响。');
  console.log('    运行 `node scripts/bundle-python312.js` 即可装配。');
  process.exit(0);
}
console.log('== 自检 engine/deps.py check ==');
const r = spawnSync('"' + python + '" "' + depsPy + '" check', { shell: true, encoding: 'utf8' });
const line = (r.stdout || '').split(/\r?\n/).find((l) => l.indexOf('###RESULT') === 0);
if (!line) { console.error('[错误] deps.py 未返回结果'); console.error(r.stdout || r.stderr || ''); process.exit(1); }
const groups = JSON.parse(line.slice('###RESULT'.length)).groups;
let bad = 0;
for (const [g, v] of Object.entries(groups)) {
  const detail = (v.missing.length ? '  missing: ' + v.missing.join(', ') : '') +
                 (v.broken.length ? '  broken: ' + v.broken.join(', ') : '');
  console.log('    ' + g.padEnd(11) + (v.ok ? 'ok' : 'FAIL' + detail));
  if (!v.ok) bad++;
}
if (bad) {
  console.error('[错误] ' + bad + ' 个依赖组不完整 —— 不要写就绪标记，应用不会切到这套运行时');
  process.exit(1);
}
if (!checkOnly) {
  // 只有全部就绪才落标记：main.js 的 bundledPython312() 只认带标记的目录
  fs.writeFileSync(readyMark, new Date().toISOString());
  console.log('[完成] 3.12 引擎运行时已就绪，已写就绪标记 ' + path.basename(readyMark));
} else {
  console.log('[完成] 自检通过（--check 模式，未写标记）');
}
