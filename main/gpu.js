// ============================================================
// 主进程 GPU 增强包服务
// 负责 GPU 增强目录、安装/卸载、分卷合并、类型识别
// ============================================================
'use strict';
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

function gpuEnhanceRoot() {
  return path.join(app.getPath('userData'), 'fufumidi', 'gpu-enhancements');
}
function gpuEnhanceDir(kind) {
  return path.join(gpuEnhanceRoot(), kind || '');
}
function gpuEnhanceSite(kind) {
  return path.join(gpuEnhanceDir(kind), 'site-packages');
}
function installedGpuKinds() {
  return ['cuda', 'directml'].filter(k => {
    const dir = gpuEnhanceDir(k);
    return fs.existsSync(path.join(dir, 'site-packages')) && fs.existsSync(path.join(dir, 'manifest.json'));
  });
}
function inferGpuKind(nameOrUrl) {
  const t = String(nameOrUrl || '').toLowerCase();
  if (t.indexOf('cuda') >= 0) return 'cuda';
  if (t.indexOf('directml') >= 0 || t.indexOf('dml') >= 0) return 'directml';
  return null;
}
function writeGpuManifest(kind, meta) {
  try {
    const dir = gpuEnhanceDir(kind);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ kind, installedAt: new Date().toISOString(), ...(meta || {}) }, null, 2), 'utf8');
  } catch (e) {}
}
function installGpuSite(kind, srcSite, meta) {
  if (!fs.existsSync(srcSite)) throw new Error('缺少 site-packages 目录');
  const finalDir = gpuEnhanceDir(kind);
  const tmpDir = finalDir + '.tmp-' + Date.now();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpSite = path.join(tmpDir, 'site-packages');
    fs.mkdirSync(tmpSite, { recursive: true });
    fs.cpSync(srcSite, tmpSite, { recursive: true, force: true });
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify({ kind, installedAt: new Date().toISOString(), ...(meta || {}) }, null, 2), 'utf8');
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, finalDir);
  } catch (e) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    throw e;
  }
}
function isSplitPackagePath(p) {
  const b = path.basename(String(p || ''));
  return /\.part\d+$/i.test(b) || /\.zip\.\d{3}$/i.test(b);
}
function splitPartNumber(p) {
  const m = String(p).match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
}
async function combineSplitParts(parts, outZip) {
  const sorted = parts.slice().sort((a, b) => splitPartNumber(a) - splitPartNumber(b));
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outZip);
    let idx = 0, finished = false;
    function next() {
      if (finished) return;
      if (idx >= sorted.length) { finished = true; ws.end(); return; }
      const rs = fs.createReadStream(sorted[idx++]);
      rs.on('error', reject);
      rs.pipe(ws, { end: false });
      rs.on('end', next);
    }
    ws.on('finish', resolve);
    ws.on('error', reject);
    next();
  });
}

module.exports = {
  gpuEnhanceRoot,
  gpuEnhanceDir,
  gpuEnhanceSite,
  installedGpuKinds,
  inferGpuKind,
  writeGpuManifest,
  installGpuSite,
  isSplitPackagePath,
  splitPartNumber,
  combineSplitParts,
};
