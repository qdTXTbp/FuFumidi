// ============================================================
// P2-4 跨平台支持：路径/运行时/冒烟清单的单一来源
// ============================================================
// 目标：把散落在各模块里的 "python.exe / Scripts/" 这类 Windows 假设收进一处，
// 让 macOS/Linux dev 包至少能启动、跑通核心流程（签名/公证与原生音频 I/O 不在本模块范围）。
'use strict';
const path = require('path');

const PLATFORMS = ['win32', 'darwin', 'linux'];

/** 内置 Python 运行时在 resources/ 下的相对路径（随包分发的只有 Windows 构建） */
function pythonRuntimeRelative(platform) {
  return platform === 'win32' ? 'python/python.exe' : 'python/bin/python3';
}

/** venv 里的解释器相对路径 */
function venvPythonRelative(platform) {
  return platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
}

/** 安装包扩展名（发布物命名用） */
function installerExt(platform) {
  if (platform === 'darwin') return 'dmg';
  if (platform === 'linux') return 'AppImage';
  return 'exe';
}

/** 数据根默认位置（Windows 在工具目录旁；mac/linux 走用户目录，避免写安装目录） */
function defaultDataRoot(platform, homeDir) {
  const home = homeDir || '';
  if (platform === 'win32') return '';   // 由 main/paths.js 按工具目录推导
  if (!home) return '';
  // 目标平台的路径必须用该平台的风格（在 Windows 上规划 mac/linux 构建时同样是 /）
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'FuFumidiData');
  return path.posix.join(home, '.local', 'share', 'FuFumidiData');
}

/** 各平台"能跑起来"的最小冒烟清单（人工/脚本共用） */
function smokeChecklist(platform) {
  const common = [
    '应用启动到首页（无白屏、无渲染进程未捕获异常）',
    '导入一个 MIDI（曲库出现曲目，双击进入播放）',
    '播放/暂停/跳转/循环正常，音频不出错',
    '切到编辑页（钢琴卷帘），画一笔并撤销',
    '转换页离线渲染并导出 WAV（文件可播放、含 BWF 元数据）',
    '设置页打开/关闭，主题与语言切换不崩',
  ];
  if (platform === 'win32') {
    common.push('midi 输入设备枚举/录音页可打开（无设备也不崩）');
    common.push('资源中心 GPU 增强包/识谱引擎状态可读');
  } else {
    common.push('系统音频输出可用（WebAudio 起播不报错）');
    common.push('不访问 Windows 专有 API（注册表 / taskkill / .exe 路径）');
  }
  return common;
}

/** 给 CI/构建脚本的一句话平台说明 */
function platformNotes(platform) {
  if (platform === 'win32') return '正式发布平台（NSIS 安装包 + kachina 更新器）';
  if (platform === 'darwin') return 'dev 包（未签名未公证）：需 Apple Developer 账号才能分发';
  if (platform === 'linux') return 'dev 包（AppImage/Flatpak 未做）：依赖系统 Python 与 FFmpeg';
  return '未知平台：只支持 win32/darwin/linux';
}

/** 候选解释器（按优先级）：用户配置 > 内置运行时 > 系统 python3 */
function pythonCandidates(platform, opts = {}) {
  const root = opts.resourcesRoot || '';
  const p = platform === 'win32' ? path.win32 : path.posix;
  const out = [];
  if (opts.configured) out.push(String(opts.configured));
  if (root) out.push(p.join(root, pythonRuntimeRelative(platform)));
  out.push(platform === 'win32' ? 'python.exe' : 'python3');
  return out;
}

module.exports = {
  PLATFORMS, pythonRuntimeRelative, venvPythonRelative, installerExt,
  defaultDataRoot, smokeChecklist, platformNotes, pythonCandidates,
};
