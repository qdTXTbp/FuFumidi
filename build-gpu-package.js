#!/usr/bin/env node
// Build GPU enhancement packages: node build-gpu-package.js cuda|xpu    （DirectML 包已下线）
//
// xpu（Intel）走 --target 隔离安装那一套，**不能**像 cuda 那样装进内置运行时：
// xpu 版 torch 是独立构建（不带 CUDA），装进基础运行时会把 CPU 版 torch 顶掉，
// 而基础运行时是所有非 GPU 路径的兜底 —— 顶掉了就全乱套。
// ★ 走 SJTU 镜像：download.pytorch.org 实测 313 KB/s，SJTU 14.5 MB/s。
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const mode = (process.argv[2] || 'cuda').toLowerCase();
if (!['cuda', 'xpu'].includes(mode)) {
  console.error('用法: node build-gpu-package.js cuda|xpu');
  process.exit(1);
}
const root = __dirname;
const staging = path.join(root, 'gpu-package');
// ★ 必须写成正斜杠（或双反斜杠）：原来的写法 `'E:\Midi\FuFumidi\resources\python'`
// 在 JS 字符串里 \M \F \p 是无效转义会被吃掉、**\r 是回车**，
// 路径实际变成 `E:MidiFuFumidi<CR>esourcespython`，pip 根本起不来 ——
// 这个脚本在带这些字母组合的路径下**从来没跑通过**（cuda 分支同样中招）。
const pythonDir = process.env.FUFUMIDI_PYTHON_DIR || 'E:/Midi/FuFumidi/resources/python';

const reqCuda = path.join(root, 'engine', 'requirements-gpu-cuda.txt');
const reqXpu = path.join(root, 'engine', 'requirements-gpu-xpu.txt');
/** Intel XPU 轮子来源：优先本地目录（用 curl 从镜像拉，实测 31 MB/s），
 *  否则退回 PyTorch 官方 xpu 索引（能用但只有 313 KB/s，一个 torch 轮子要下 40 分钟）。
 *
 *  ★ 为什么不能像 cuda 那样写 `-f <镜像目录>`：
 *    SJTU 的 pytorch-wheels 目录页 pip 解析不了（curl 拿到 0 字节），
 *    pip 只能看到 tuna 上的**普通** torch，于是报「找不到 torch==2.11.0+xpu」。
 *    实测踩过：必须先把 .whl 下到本地再喂给 pip。 */
const xpuWheelsDir = process.env.XPU_WHEELS || '';

function run(cmd) {
  console.log('[run] ' + cmd);
  execSync(cmd, { stdio: 'inherit' });
}

// SKIP_PIP 表示「staging 已经装好了」——此时**绝对不能清空**它：
// 清了又跳过 pip，就会拿一个空目录去打包（打出一个几百 KB 的空包）。
if (process.env.SKIP_PIP) {
  if (!fs.existsSync(staging)) {
    console.error('[错误] 设了 SKIP_PIP 但 staging 不存在：' + staging);
    process.exit(1);
  }
  console.log('[skip] 保留已有 staging：' + staging);
} else if (fs.existsSync(staging)) {
  fs.rmSync(staging, { recursive: true, force: true });
}
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
} else if (mode === 'xpu') {
  // Intel XPU：整套 CP311 栈装进 staging，包自包含。
  if (!process.env.SKIP_PIP) {
    // onnxruntime-directml（XPU 包的 ONNX 后端，与已下线的 DirectML 增强包无关）等从 tuna 装；torch/torchaudio 从本地轮子装（见文件头说明）
    run('"' + pythonDir + '\\python.exe" -m pip install --target "' + site + '" --no-input --no-cache-dir'
        + ' --index-url https://pypi.tuna.tsinghua.edu.cn/simple'
        + ' "onnxruntime-directml>=1.16"');
    if (xpuWheelsDir) {
      const whls = fs.readdirSync(xpuWheelsDir).filter((f) => f.endsWith('.whl'))
        .map((f) => '"' + path.join(xpuWheelsDir, f) + '"');
      if (!whls.length) { console.error('[错误] XPU_WHEELS 目录里没有 .whl：' + xpuWheelsDir); process.exit(1); }
      console.log('[xpu] 用本地轮子：' + whls.length + ' 个');
      run('"' + pythonDir + '\\python.exe" -m pip install --target "' + site + '" --no-input --no-cache-dir'
          + ' --index-url https://pypi.tuna.tsinghua.edu.cn/simple ' + whls.join(' '));
    } else {
      console.log('[xpu] 未设 XPU_WHEELS，退回官方索引（很慢）');
      run('"' + pythonDir + '\\python.exe" -m pip install --target "' + site + '" --no-input --no-cache-dir'
          + ' --index-url https://download.pytorch.org/whl/xpu torch==2.11.0+xpu torchaudio==2.11.0+xpu');
    }
  } else {
    console.log('[skip] pip xpu install (staging must already contain packages)');
  }
}

const outDir = process.env.GPU_PACKAGE_OUT || 'E:/Midi/安装包/FuFumidi/增强包';
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'fufumidi-gpu-' + mode + '.zip');
const sevenZip = process.env.SEVENZIP || '7z';
// ★ 分卷：GitHub Release 单资产上限 2 GB，而 XPU 包解压后 4.6 GB、压完仍超 2 GB。
//   7z 的 -v 会切出 fufumidi-gpu-xpu.zip.001 / .002 …，正好命中
//   main/gpu-ipc.js 的分卷识别正则 '^fufumidi-gpu-<kind>(?:-parts)?\.(zip\.\d{3}|part\d+)'。
const splitSize = mode === 'xpu' ? (process.env.GPU_PACKAGE_SPLIT || '1900m') : '';
// ★★ 归档根必须是 site-packages，不能是 gpu-package：
//   安装侧（main/gpu-ipc.js:249 与 :374）找的是 `extractDir/site-packages`，
//   即**压缩包根目录下**必须有 site-packages。
//   原写法 `7z a out.zip "<staging>\*"` 会把 staging 的目录名一起打进去
//   （条目变成 gpu-package\site-packages\…），解压后根下没有 site-packages，
//   安装时报「压缩包内缺少 site-packages 目录」——cuda 同样中招。
//   正确做法：**切到 staging 里执行**，只归档 site-packages\*。
//   （Windows 上用 cmd 的 cd /d 切目录；7z 按 cwd 决定归档内的相对路径。）
run('cmd /c "cd /d \"' + staging + '\" && \"' + sevenZip + '\" a -tzip -mx5'
    + (splitSize ? ' -v' + splitSize : '') + ' \"' + out + '\" site-packages\\*"');
if (splitSize) {
  console.log('[ok] 分卷产物（每卷 ' + splitSize + '）：');
  for (const f of fs.readdirSync(outDir).filter((x) => x.startsWith('fufumidi-gpu-' + mode + '.zip.'))) {
    console.log('   ' + f + '  ' + (fs.statSync(path.join(outDir, f)).size / 1048576).toFixed(0) + ' MB');
  }
} else {
  console.log('[ok] ' + out);
}