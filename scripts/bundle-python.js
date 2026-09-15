#!/usr/bin/env node
// ============================================================
// 装配内置 Python 运行时：向 resources/python 安装转录引擎的全部依赖
//
// 背景：resources/ 在 .gitignore 里（运行时 1.2GB 不入库），因此这个步骤
// 必须可复现——否则换台机器重新打包必然重现「资源管理 → 模型运行时」自检
// 报 missing 的问题（4.2.0 安装包即如此）。
//
// 用法：
//   node scripts/bundle-python.js            # 安装 + 自检
//   node scripts/bundle-python.js --check    # 只自检
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const pythonDir = path.join(root, 'resources', 'python');
const python = path.join(pythonDir, 'python.exe');
const reqFile = path.join(root, 'engine', 'requirements-bundle.txt');
const depsPy = path.join(root, 'engine', 'deps.py');

// 国内快源优先，官方 PyPI 兜底
const PIP_MIRRORS = [
  'https://pypi.tuna.tsinghua.edu.cn/simple',
  'https://mirrors.aliyun.com/pypi/simple',
  'https://pypi.org/simple',
];

// aria 组的两个包不在 PyPI，只能从 GitHub 拿。依次尝试各加速镜像。
const GIT_MIRRORS = [
  'https://gh.jasonzeng.dev/https://github.com/',
  'https://ghfast.top/https://github.com/',
  'https://gh-proxy.com/https://github.com/',
  'https://github.com/',
];
// 仓库默认分支名不统一，git 与 zip 两条路都两个分支各试一次
const ARCHIVE_REFS = ['main', 'master'];
// amt 声明的 torchaudio<=2.5 会把已装好的 torch/torchaudio 降级，必须 --no-deps
const GIT_PKGS = [
  { name: 'amt', repo: 'EleutherAI/aria-amt', noDeps: true },
  { name: 'ariautils', repo: 'EleutherAI/aria-utils', noDeps: false },
];

const checkOnly = process.argv.includes('--check');

function run(cmd, opts) {
  console.log('[run] ' + cmd);
  return execSync(cmd, Object.assign({ stdio: 'inherit' }, opts || {}));
}

function tryRun(cmd) {
  const r = spawnSync(cmd, { shell: true, stdio: 'pipe', encoding: 'utf8' });
  return r.status === 0;
}

function hasGit() {
  return tryRun('git --version');
}

// 依次尝试各镜像；pip 失败就换下一个源
function pipAnywhere(args) {
  for (const m of PIP_MIRRORS) {
    if (tryRun('"' + python + '" -m pip install --no-input -q --disable-pip-version-check -i ' + m + ' ' + args)) return true;
  }
  return false;
}

if (!fs.existsSync(python)) {
  console.error('[错误] 找不到内置运行时：' + python);
  console.error('       需先准备好 embeddable Python 3.11 到 resources/python（见 docs/TESTING.md / UPDATING.md）。');
  process.exit(1);
}

if (!checkOnly) {
  console.log('== 1/3 安装 engine/requirements-bundle.txt ==');
  if (!pipAnywhere('-r "' + reqFile + '"')) {
    console.error('[错误] requirements-bundle.txt 安装失败：所有镜像均不可用');
    process.exit(1);
  }

  console.log('== 2/3 安装 aria 组（不在 PyPI，走 GitHub）==');
  const git = hasGit();
  console.log(git ? '    检测到 git，优先用 git+ 安装' : '    未检测到 git，改用源码 zip 安装');
  for (const pkg of GIT_PKGS) {
    const extra = pkg.noDeps ? ' --no-deps' : '';
    const specs = [];
    if (git) for (const m of GIT_MIRRORS) specs.push('git+' + m + pkg.repo + '.git');
    for (const m of GIT_MIRRORS) for (const ref of ARCHIVE_REFS)
      specs.push(m + pkg.repo + '/archive/refs/heads/' + ref + '.zip');

    let ok = false;
    for (const spec of specs) {
      if (tryRun('"' + python + '" -m pip install --no-input -q --disable-pip-version-check' + extra + ' "' + spec + '"')) {
        console.log('    [ok] ' + pkg.name + '  <-  ' + spec);
        ok = true;
        break;
      }
    }
    if (!ok) {
      console.error('[错误] ' + pkg.name + ' 安装失败：所有镜像 / 分支组合均不可用');
      process.exit(1);
    }
  }
}

console.log('== 3/3 自检 engine/deps.py check ==');
const r = spawnSync('"' + python + '" "' + depsPy + '" check', { shell: true, encoding: 'utf8' });
const line = (r.stdout || '').split(/\r?\n/).find((l) => l.indexOf('###RESULT') === 0);
if (!line) {
  console.error('[错误] deps.py 未返回结果');
  console.error(r.stdout || '');
  console.error(r.stderr || '');
  process.exit(1);
}
const groups = JSON.parse(line.slice('###RESULT'.length)).groups;
let bad = 0;
for (const [g, v] of Object.entries(groups)) {
  console.log('    ' + g.padEnd(11) + (v.ok ? 'ok' : 'MISSING: ' + v.missing.join(', ') + (v.broken.length ? '  BROKEN: ' + v.broken.join(', ') : '')));
  if (!v.ok) bad++;
}
if (bad) {
  console.error('[错误] ' + bad + ' 个依赖组仍不完整，安装包打出来就是缺依赖的');
  process.exit(1);
}
console.log('[完成] 内置运行时依赖齐备（' + Object.keys(groups).length + ' 组全部 ok）');
