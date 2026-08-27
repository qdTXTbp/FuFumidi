#!/usr/bin/env node
// Build GPU enhancement packages: node build-gpu-package.js cuda|directml
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const mode = (process.argv[2] || 'directml').toLowerCase();
const root = __dirname;
const staging = path.join(root, 'gpu-package');
const pythonDir = 'E:\Midi\FuFumidi\resources\python';

const reqCuda = path.join(root, 'engine', 'requirements-gpu-cuda.txt');
const reqDirectML = path.join(root, 'engine', 'requirements-gpu-directml.txt');

function run(cmd) {
  console.log('[run] ' + cmd);
  execSync(cmd, { stdio: 'inherit' });
}

if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
const site = path.join(staging, 'site-packages');
fs.mkdirSync(site, { recursive: true });

if (mode === 'cuda') {
  if (!process.env.SKIP_PIP) run('"' + pythonDir + '\python.exe" -m pip install --no-input -i https://pypi.tuna.tsinghua.edu.cn/simple -r "' + reqCuda + '"');
  else console.log('[skip] pip cuda install');
  const pkgList = ['torch', 'torchgen', 'functorch', 'torchvision', 'torchaudio', 'onnxruntime'];
  for (const pkg of pkgList) {
    const srcDir = path.join(pythonDir, 'Lib', 'site-packages', pkg);
    if (fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, path.join(site, pkg), { recursive: true });
      console.log('[copy] ' + pkg);
    }
  }
} else {
  // DirectML: install a complete CP311 stack into the staging site-packages so the package is self-contained.
  if (!process.env.SKIP_PIP) {
    run('"' + pythonDir + '\python.exe" -m pip install --target "' + site + '" --no-input --no-cache-dir -r "' + reqDirectML + '"');
  } else {
    console.log('[skip] pip directml install (staging must already contain packages)');
  }
}

const outDir = process.env.GPU_PACKAGE_OUT || 'E:\Midi\安装包\FuFumidi\增强包';
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'fufumidi-gpu-' + mode + '.zip');
const sevenZip = process.env.SEVENZIP || '7z';
run('"' + sevenZip + '" a -tzip -mx5 "' + out + '" "' + staging + '\*"');
console.log('[ok] ' + out);