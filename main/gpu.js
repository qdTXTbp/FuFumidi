// ============================================================
// 主进程 GPU 增强包服务
// 负责 GPU 增强目录、安装/卸载、分卷合并、类型识别、Python 版本约束
//
// 三种增强包（kind）：
//   cuda     —— NVIDIA（torch cu128 + onnxruntime-gpu）
//   ★ DirectML 增强包已下线（2026-10-19 用户决定，不再提供下载与安装）。
//   rocm     —— AMD 较新 Radeon（ROCm 7.2；**只提供 cp312 轮子，必须配 Python 3.12 运行时**）
//   xpu      —— Intel 独显 / 核显（torch+xpu，Intel oneAPI）
//               ★ 与 cuda **互斥**（xpu 版 torch 不带 CUDA，两个包不能同时挂）；
//               ★ 本仓库目前**没有 Intel 显卡实机验证过**，自检会照常比算力，
//                 但界面应标注「未经实机验证」，别让用户以为一定可用。
//
// 另有一类**不是加速、而是能力包**：
//   svc      —— 翻唱变声推理（torch + faiss + contentvec/hubert 编码器 + rmvpe 权重 + pyworld）。
//               不塞进本体（体积大），用户按需在「加速包」页安装；角色权重仍是用户导入的。
//
// ★ Python 版本约束：增强包是按某个 CPython 次版本编译的（site-packages 里的
//   *.pyd 带 ABI tag）。内置运行时是 3.11，而 ROCm 只有 cp312，
//   所以「启用 ROCm = 把解释器切到 3.12」。见 KIND_PY / requiredPython()。
// ============================================================
'use strict';
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const Paths = require('./paths');

const GPU_KINDS = ['cuda', 'rocm', 'xpu', 'svc'];
/** 每种增强包所要求的 CPython 次版本（决定用哪个解释器跑引擎） */
/* 目标 CPython 次版本：只在**包还没装**时用来判断"该按哪个版本构建/下载"（见 fitsPython）。
   ★ 2026-10-17：运行时升到 3.12 之后，这里曾写死 cuda: '3.11' —— 于是装好的 CUDA 包被判定
   与运行时不符、GPU 一直不生效，而界面又只说"已安装"（用户实测："工具 gpu 加速没有生效"）。
   现在**已安装的包以它自己的 ABI 为准**（packAbi 读 torch 的 _C.cp3XX 文件名），
   这里的常量只作为"未安装时的目标版本"。
   ★ svc（RVC 翻唱推理）是**能力包**不是加速包：不切换解释器、不显示加速开关，
     目标版本跟运行时一致（3.12）。DirectML 已在 5.2.0 下线，不再登记。 */
const KIND_PY = { cuda: '3.12', rocm: '3.12', xpu: '3.12', svc: '3.12' };
const KIND_LABEL = { cuda: 'CUDA', rocm: 'ROCm', xpu: 'Intel XPU', svc: 'SVC 推理' };
/** 是否是已知的增强包类型 */
function isGpuKind(kind) {
  return GPU_KINDS.indexOf(String(kind || '').toLowerCase()) >= 0;
}

/** 该增强包要求的 Python 次版本（'3.11' / '3.12'）；未知类型返回 null */
function requiredPython(kind) {
  return KIND_PY[String(kind || '').toLowerCase()] || null;
}

/** 已安装增强包里 torch 扩展的 ABI（'3.11' / '3.12'）——文件名就是权威来源，不看清单声明 */
function packAbi(kind) {
  try {
    const t = path.join(gpuEnhanceSite(kind), 'torch');
    if (!fs.existsSync(t)) return '';
    const f = fs.readdirSync(t).find((n) => /^_C\.cp3\d+-/.test(n));
    const m = f && /cp3(\d+)/.exec(f);
    return m ? ('3.' + m[1]) : '';
  } catch (e) { return ''; }
}

/** 该增强包能否在给定的 Python 次版本下加载。
 *  ★ 已安装的包**以包自己的 ABI 为准**：清单里写的目标版本会过期（运行时升级过，包没重建），
 *    而 _C.cpXX 文件名是编译事实。只有没装包时才退回 KIND_PY 的目标版本。 */
function fitsPython(kind, minor) {
  // 先校验格式：探测失败时可能传进来 'undefined.undefined' 之类的脏值，
  // 不能让它悄悄参与比较（宁可判不匹配，也不要拿脏值去放行）。
  if (!/^\d+\.\d+$/.test(String(minor || ''))) return false;
  const abi = packAbi(kind);
  if (abi) return String(minor) === abi;
  const need = requiredPython(kind);
  if (!need) return false;
  return String(minor) === need;
}

// GPU 增强包落在数据根目录（默认在工具目录旁），与模型/缓存同处一地，不挤占 C 盘
function gpuEnhanceRoot() {
  return Paths.gpuEnhanceRoot();
}
function gpuEnhanceDir(kind) {
  return path.join(gpuEnhanceRoot(), kind || '');
}
function gpuEnhanceSite(kind) {
  return path.join(gpuEnhanceDir(kind), 'site-packages');
}
/** 读取增强包清单（安装时写入）。缺失或损坏返回 null。 */
function readGpuManifest(kind) {
  try {
    const p = path.join(gpuEnhanceDir(kind), 'manifest.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}
function installedGpuKinds() {
  return GPU_KINDS.filter(k => {
    const dir = gpuEnhanceDir(k);
    return fs.existsSync(path.join(dir, 'site-packages')) && fs.existsSync(path.join(dir, 'manifest.json'));
  });
}
function inferGpuKind(nameOrUrl) {
  const t = String(nameOrUrl || '').toLowerCase();
  if (t.indexOf('svc') >= 0 || t.indexOf('rvc') >= 0) return 'svc';
  if (t.indexOf('cuda') >= 0) return 'cuda';
  // rocm / hip：ROCm on Windows 的 torch 里 torch.version.hip 有值、version.cuda 为空
  if (t.indexOf('rocm') >= 0 || t.indexOf('rocmsdk') >= 0 || t.indexOf('-hip') >= 0) return 'rocm';
  // Intel XPU（torch+xpu）放在最后判：文件名里可能同时出现 xpu 与 dml，
  // 但 'xpu' 是更具体的专用包，优先认它。
  if (t.indexOf('xpu') >= 0 || t.indexOf('oneapi') >= 0) return 'xpu';
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
  GPU_KINDS,
  KIND_PY,
  KIND_LABEL,
  ACCEL_KINDS,
  isAccelKind,
  isGpuKind,
  requiredPython,
  fitsPython,
  packAbi,
  gpuEnhanceRoot,
  gpuEnhanceDir,
  gpuEnhanceSite,
  readGpuManifest,
  installedGpuKinds,
  inferGpuKind,
  writeGpuManifest,
  installGpuSite,
  isSplitPackagePath,
  splitPartNumber,
  combineSplitParts,
};
