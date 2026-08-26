#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const dist = path.join(root, 'dist');
const mode = (process.argv[2] || 'full').toLowerCase();

function buildFrontend() {
  console.log('[frontend] building Vue renderer ...');
  execSync('npm --prefix frontend run build', { stdio: 'inherit', cwd: root });
}

function packAsar(outName) {
  if (fs.existsSync(dist)) fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  const out = path.join(dist, outName);
  // gpu-package 是构建 GPU 增强包的临时产物（数 GB），绝不能打进 app.asar
  const stagingGpu = path.join(root, 'gpu-package');
  const gpuBackup = path.join(path.dirname(root), 'gpu-package.packbak');
  const hadGpu = fs.existsSync(stagingGpu);
  if (hadGpu) {
    if (fs.existsSync(gpuBackup)) fs.rmSync(gpuBackup, { recursive: true, force: true });
    fs.renameSync(stagingGpu, gpuBackup);
  }
  // frontend/node_modules 只用于本地开发/构建，不能进入 app.asar
  const feNodeModules = path.join(root, 'frontend', 'node_modules');
  const feNodeBak = path.join(path.dirname(root), 'frontend-node_modules.packbak');
  const hadFeNode = fs.existsSync(feNodeModules);
  if (hadFeNode) {
    if (fs.existsSync(feNodeBak)) fs.rmSync(feNodeBak, { recursive: true, force: true });
    fs.renameSync(feNodeModules, feNodeBak);
  }
  try {
    if (fs.existsSync(out)) fs.unlinkSync(out);
    console.log('[pack] ' + out);
    execSync('npx --yes @electron/asar pack . "' + out + '" --unpack-dir=engine --unpack="*.node" --exclude-hidden', { stdio: 'inherit', cwd: root });
    console.log('[ok] ' + out + ' (' + fs.statSync(out).size + ' bytes)');
  } catch (e) {
    if (hadGpu && fs.existsSync(gpuBackup)) { try { fs.renameSync(gpuBackup, stagingGpu); } catch (_) {} }
    if (hadFeNode && fs.existsSync(feNodeBak)) { try { fs.renameSync(feNodeBak, feNodeModules); } catch (_) {} }
    console.error(e.message);
    process.exit(1);
  }
  if (hadGpu && fs.existsSync(gpuBackup)) { try { fs.renameSync(gpuBackup, stagingGpu); } catch (_) {} }
  if (hadFeNode && fs.existsSync(feNodeBak)) { try { fs.renameSync(feNodeBak, feNodeModules); } catch (_) {} }
}

if (mode === 'full') {
  buildFrontend();
  packAsar('fufumidi-full.asar');
} else if (mode === 'base') {
  buildFrontend();
  packAsar('fufumidi-base.asar');
  fs.writeFileSync(path.join(dist, 'fufumidi-base.marker'), 'base package: no torch/demucs/piano model');
  console.log('[ok] base marker written');
} else if (mode === 'source') {
  const sevenZip = process.env.SEVENZIP || '7z';
  const out = path.join(dist, 'FuFumidi-source.7z');
  if (fs.existsSync(dist)) fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  const excludes = ['.git', 'node_modules', 'dist', 'release', 'release-base', 'gpu-package', '.github', 'build.log', 'build.err.log', 'build-base.log', 'build-base.err.log'].map(x => '-xr!' + x).join(' ');
  console.log('[source] compressing with 7z -mx9 ...');
  execSync('"' + sevenZip + '" a -t7z -mx9 "' + out + '" "' + path.join(root, '*') + '" ' + excludes, { stdio: 'inherit', cwd: root });
  console.log('[ok] ' + out + ' (' + fs.statSync(out).size + ' bytes)');
} else {
  console.error('Unknown mode: ' + mode);
  process.exit(1);
}