#!/usr/bin/env node
/* FuFumidi 打包脚本
 * 用法:
 *   node build.js full     -> 完整包 asar
 *   node build.js base     -> 基础包 asar（标记基础包）
 *   node build.js source   -> 源码 7z mx9 最高压缩
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const dist = path.join(root, 'dist');
if (!fs.existsSync(dist)) fs.mkdirSync(dist, { recursive: true });

const mode = (process.argv[2] || 'full').toLowerCase();

function packAsar(outName) {
  const out = path.join(dist, outName);
  if (fs.existsSync(out)) fs.unlinkSync(out);
  console.log('[pack] ' + out);
  execSync(`npx --yes @electron/asar pack . "${out}" --unpack-dir=engine --unpack='*.node'`, { stdio: 'inherit', cwd: root });
  console.log('[ok] ' + out + ' (' + fs.statSync(out).size + ' bytes)');
}

if (mode === 'full') {
  packAsar('fufumidi-full.asar');
} else if (mode === 'base') {
  packAsar('fufumidi-base.asar');
  // 基础包标记：供安装脚本识别（不进入 asar，仅生成到 dist）
  fs.writeFileSync(path.join(dist, 'fufumidi-base.marker'), 'base package: no torch/demucs/piano model');
  console.log('[ok] base marker written');
} else if (mode === 'source') {
  const sevenZip = process.env.SEVENZIP || '7z';
  const out = path.join(dist, 'FuFumidi-source.7z');
  if (fs.existsSync(out)) fs.unlinkSync(out);
  console.log('[source] compressing with 7z -mx9 ...');
  // 排除不需要进入源码包的目录
  const excludes = ['.git', 'node_modules', 'dist', '.github'];
  const args = excludes.map(x => `-xr!${x}`).join(' ');
  execSync(`"${sevenZip}" a -t7z -mx9 "${out}" "${path.join(root, '*')}" ${args}`, { stdio: 'inherit', cwd: root });
  console.log('[ok] ' + out + ' (' + fs.statSync(out).size + ' bytes)');
} else {
  console.error('Unknown mode: ' + mode);
  process.exit(1);
}
