#!/usr/bin/env node
// P2-4 跨平台构建/冒烟入口（不签名、不公证；mac/linux 只承诺 dev 包）
// 用法：
//   node scripts/build-platform.mjs --target darwin --dry-run   # 打印要求 + 构建命令（可在任何平台跑）
//   node scripts/build-platform.mjs --target linux             # 仅在 Linux 上真正执行 electron-builder
//   node scripts/build-platform.mjs --target win32 --skip-build # 只打印冒烟清单
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PLAT = require('../main/platform.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
function arg(name, def = '') {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : def;
}
const target = arg('target', process.platform);
const dryRun = argv.includes('--dry-run');
const skipBuild = argv.includes('--skip-build');
const arch = arg('arch', process.arch === 'arm64' && target === 'darwin' ? 'arm64' : 'x64');

if (!PLAT.PLATFORMS.includes(target)) {
  console.error('不支持的目标平台：' + target + '（只支持 ' + PLAT.PLATFORMS.join(' / ') + '）');
  process.exit(2);
}

console.log('FuFumidi 跨平台构建');
console.log('  目标平台：' + target + '（' + PLAT.platformNotes(target) + '）');
console.log('  目标架构：' + arch);
console.log('  安装包后缀：' + PLAT.installerExt(target));
console.log('  内置 Python 期望路径：resources/' + PLAT.pythonRuntimeRelative(target).replace(/\\/g, '/'));
console.log('  数据根：' + (PLAT.defaultDataRoot(target, '<home>') || '工具目录旁 FuFumidiData（main/paths.js）'));
console.log('');
console.log('前提检查：');
const pythonRel = path.join(ROOT, 'resources', PLAT.pythonRuntimeRelative(target));
console.log('  ' + (fs.existsSync(pythonRel) ? '✓' : '✗') + ' resources Python 运行时：' + path.relative(ROOT, pythonRel)
  + (fs.existsSync(pythonRel) ? '' : '（mac/linux 需准备对应平台的 Python 3.11+；Windows 由 build-installers.js 打包）'));
console.log('  ' + (target === process.platform ? '✓' : '✗') + ' 当前平台（' + process.platform + '）'
  + (target === process.platform ? '' : ' ≠ 目标平台 → electron-builder 只能做本机 platform 的原生依赖，请在目标平台/CI matrix 上构建'));
if (target !== 'win32') {
  console.log('  ! 未签名未被公证：macOS 首次打开需右键打开；Linux 依赖系统 ffmpeg（或随包放入）');
}
console.log('');
console.log('冒烟清单（构建后人工/脚本逐条验证）：');
for (const item of PLAT.smokeChecklist(target)) console.log('  · ' + item);
console.log('');

if (skipBuild) process.exit(0);
const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
// electron-builder 的平台参数名：win32 → win，darwin → mac
const EB_FLAG = { win32: 'win', darwin: 'mac', linux: 'linux' };
const args = ['electron-builder', '--' + (EB_FLAG[target] || target), '--' + arch];
if (dryRun || target !== process.platform) {
  console.log((dryRun ? '[dry-run] ' : '[不可在本机构建] ') + cmd + ' ' + args.join(' '));
  process.exit(dryRun ? 0 : 3);
}
console.log('执行：' + cmd + ' ' + args.join(' '));
const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false });
process.exit(r.status || 0);
