#!/usr/bin/env node
/**
 * 裁剪内置 Python 运行时（resources/python）里**运行时用不到**的东西。
 *
 *   node scripts/prune-python-bundle.cjs            # 真删
 *   node scripts/prune-python-bundle.cjs --dry-run  # 只报告
 *
 * 为什么要有这个脚本：内置运行时是安装包体积的 82%（实测 1.48 GB / 2.28 GB 程序占用），
 * 而其中有近 300 MB 是调试符号、静态库、CPython 头文件和测试套件 —— 打包时顺手带上，
 * 用户一次也用不到。bundle-python.js 产出运行时之后跑一遍本脚本即可。
 *
 * 删除的五类（每一类都有明确理由，见 CATEGORIES）：
 *   __pycache__ / *.pyc : 解释器会自动重建；只是首次 import 慢一点点
 *   *.pdb               : 原生库的 Windows 调试符号，只在调试崩溃转储时用
 *   *.lib / *.a         : 静态导入库，只在**链接**时需要，运行期完全用不到
 *   目录名 tests / CPython 的 Lib/test : 测试套件（注意：numpy/testing、torch/testing
 *                         这类是**公开 API**，名字是 testing 不是 tests，绝不匹配）
 *   include/            : CPython 头文件（Python.h），只有编译 C 扩展时需要
 *
 * 删完请务必跑一次导入自检（脚本末尾会提示命令）：
 *   resources\python\python.exe -c "import numpy, scipy, librosa, soundfile, pretty_midi, mido, yaml, PIL, onnxruntime, basic_pitch, torch"
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.env.FUFUMIDI_PY || path.join(__dirname, '..', 'resources', 'python');
const DRY = process.argv.includes('--dry-run');

if (!fs.existsSync(path.join(ROOT, 'python.exe'))) {
  console.error('不是内置 Python 运行时（缺 python.exe）：' + ROOT);
  process.exit(1);
}

const CATEGORIES = [
  { key: 'pycache', why: '解释器自动重建', match: (full, name, parts) => name.endsWith('.pyc') || parts.includes('__pycache__') },
  { key: 'pdb', why: 'Windows 调试符号', match: (full, name) => name.endsWith('.pdb') },
  { key: 'staticlib', why: '链接期才需要的导入库', match: (full, name) => name.endsWith('.lib') || name.endsWith('.a') },
  { key: 'tests', why: '测试套件（testing 是公开 API，不匹配）', dir: (full, name) => name === 'tests' },
  // CPython 自带的回归测试包：Lib/test 有 2000+ 文件
  { key: 'tests', why: 'CPython 回归测试包', match: (full, name, parts) => parts[0] === 'Lib' && parts[1] === 'test' },
  { key: 'include', why: 'CPython 头文件', match: (full, name, parts) => parts[0] === 'include' },
];

const totals = new Map();
const samples = new Map();
let bytesBefore = 0;

function dirSize(dir) {
  let n = 0;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += dirSize(p);
    else { try { n += fs.statSync(p).size; } catch (err) {} }
  }
  return n;
}

function bump(key, bytes, sample) {
  totals.set(key, (totals.get(key) || 0) + bytes);
  if (sample) {
    const arr = samples.get(key) || [];
    if (arr.length < 4) arr.push(sample);
    samples.set(key, arr);
  }
}

function walk(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    const parts = path.relative(ROOT, full).split(path.sep);
    const isDir = e.isDirectory();
    let size = null;
    const getSize = () => (size == null ? (size = isDir ? dirSize(full) : (() => { try { return fs.statSync(full).size; } catch (err) { return 0; } })()) : size);
    const hit = CATEGORIES.find((c) => (isDir ? c.dir && c.dir(full, e.name, parts) : c.match && c.match(full, e.name, parts)));
    if (hit) {
      const n = getSize();
      if (!DRY) fs.rmSync(full, { recursive: true, force: true });
      bump(hit.key, n, path.relative(ROOT, full));
      continue;
    }
    if (isDir) walk(full);
    else bytesBefore += getSize();
  }
}

console.log((DRY ? '[dry-run] ' : '') + '裁剪目标：' + ROOT);
walk(ROOT);
let freed = 0;
for (const [key, bytes] of totals) {
  freed += bytes;
  console.log('  ' + key.padEnd(10) + (bytes / 1048576).toFixed(1).padStart(8) + ' MB   ' + (samples.get(key) || []).join(', '));
}
console.log('合计释放 ' + (freed / 1048576).toFixed(1) + ' MB；剩余 ' + ((bytesBefore) / 1048576).toFixed(1) + ' MB');
if (!DRY) {
  console.log('下一步：跑一次导入自检 ——');
  console.log('  "' + path.join(ROOT, 'python.exe') + '" -c "import numpy, scipy, librosa, soundfile, pretty_midi, mido, yaml, PIL, onnxruntime, basic_pitch"');
}
