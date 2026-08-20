#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const dist = path.join(root, 'dist');
const mode = (process.argv[2] || 'full').toLowerCase();

function packAsar(outName) {
  if (fs.existsSync(dist)) fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  const out = path.join(dist, outName);
  try {
    if (fs.existsSync(out)) fs.unlinkSync(out);
    console.log('[pack] ' + out);
    execSync('npx --yes @electron/asar pack . "' + out + '" --unpack-dir=engine --unpack="*.node" --exclude-hidden', { stdio: 'inherit', cwd: root });
    console.log('[ok] ' + out + ' (' + fs.statSync(out).size + ' bytes)');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

if (mode === 'full') {
  packAsar('fufumidi-full.asar');
} else if (mode === 'base') {
  packAsar('fufumidi-base.asar');
  fs.writeFileSync(path.join(dist, 'fufumidi-base.marker'), 'base package: no torch/demucs/piano model');
  console.log('[ok] base marker written');
} else if (mode === 'source') {
  const sevenZip = process.env.SEVENZIP || '7z';
  const out = path.join(dist, 'FuFumidi-source.7z');
  if (fs.existsSync(dist)) fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  const excludes = ['.git', 'node_modules', 'dist', 'release', 'release-base', '.github', 'build.log', 'build.err.log', 'build-base.log', 'build-base.err.log'].map(x => '-xr!' + x).join(' ');
  console.log('[source] compressing with 7z -mx9 ...');
  execSync('"' + sevenZip + '" a -t7z -mx9 "' + out + '" "' + path.join(root, '*') + '" ' + excludes, { stdio: 'inherit', cwd: root });
  console.log('[ok] ' + out + ' (' + fs.statSync(out).size + ' bytes)');
} else {
  console.error('Unknown mode: ' + mode);
  process.exit(1);
}