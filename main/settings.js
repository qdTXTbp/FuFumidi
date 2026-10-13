// ============================================================
// 主进程设置持久化服务
// 串行化原子写入，避免插件/应用并发写截断
// ============================================================
'use strict';
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const DEFAULT_SETTINGS = {
  theme: 'fufu',
  accent: '',
  ui_mode: 'light',
  font_size: 'standard',
  density: 'comfortable',
  perf_mode: 'quality',
  engine_path: '',
  engine_mode: 'universal',
  output_dir: '',
  guide_done: false,
  advanced_mode: false,
  custom_wallpaper: '',
  wallpaper_prompt_done: false,
  wallpaper_enabled: false,
  transcribe_params: {},
  plugins_enabled: [],
  lang: '',   // 界面语言：''=未设定（首次启动按浏览器语言确定），可选 'zh' | 'zh-Hant' | 'en' | 'ja'
  hf_token: '',   // HuggingFace 访问令牌（用于下载 gated 模型，如 MuScriptor 需授权）
  active_soundfont: 'internal',   // 播放时使用的音色库：'internal'=内置合成器，其余为 SF2 文件绝对路径（音色工坊选择，持久化）
  data_root: '',  // 数据根目录（模型 / 依赖 / 缓存 / 临时文件的落点）；留空 = 自动（工具目录旁的 FuFumidiData）
  update_channel: 'stable',  // 更新通道：'stable'=正式版（默认），'beta'=测试版（提前收到 X.Y.Z-beta.N / -rc.N）
  download_source: 'auto',   // 下载源：'auto'=自动（优先国内 CNB，失败回退 GitHub），'cnb'=国内优先，'github'=全球优先
  // UTAU 渲染引擎：'openutau'=照搬 OpenUTAU 的核心（engine/singing，默认），
  // 'legacy'=早期自研的 engine_utau.py。首选失败时主进程会自动回落到另一个引擎。
  utau_engine: 'openutau',
  // 轨道渲染器（★ 与上面是**两件事**：utau_engine 选"哪个引擎"，这里选"引擎里用哪个渲染器"）。
  //   'CLASSIC'          = 逐音素：ClassicRenderer + Worldline 变调器（默认，最快）
  //   'WORLDLINE-R'      = 乐句级 WORLD 合成（v10）
  //   'WORLDLINE-R1.1'   = v10 + hnsep 谐波/噪声分离（v11）。**需要先下载 hnsep 模型**
  //                        （资源中心），否则渲染时会给出明确报错。
  //   'WORLDLINE-R2'     = v20：WORLD 特征 → mel ONNX（随包 83.4 KB）→ ONNX 声码器出波形。
  //                        **需要 128bin/512hop 的通用声码器**（资源中心「NSF-HiFiGAN 通用声码器」），
  //                        没装时渲染会给出明确报错。
  //   实测同机同段：CLASSIC 6.39× 实时 / v10 —— / v11 1.94× 实时（比 v10 慢 3.29×）。
  utau_renderer: 'CLASSIC',
  diffsinger_enabled: true, // DiffSinger 模块开关：**默认启用**，不再要求用户先手动点一次「启用模块」。
                          // 置 false 仍可显式关闭（保留字段仅为兼容旧 settings.json；主进程已不再据此拦截）。
  // 操作系统级全局热键：{ 动作id: { accel, enabled } }。
  // ★ 默认空 = **一个都不注册** —— 系统级热键会和其他软件抢键，必须由用户在设置里显式录制并启用。
  global_hotkeys: {},
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'fufumidi', 'settings.json');
}

function readSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch (e) {
    const p = settingsPath();
    try { if (fs.existsSync(p)) fs.renameSync(p, p + '.corrupt-' + Date.now()); } catch (e2) {}
    const repaired = { ...DEFAULT_SETTINGS, guide_done: true };
    try { writeSettings(repaired); } catch (e3) {}
    return repaired;
  }
}

let _settingsWrites = Promise.resolve();
function writeSettings(s) {
  _settingsWrites = _settingsWrites.then(() => {
    const p = settingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  }).catch(() => {});
}

module.exports = {
  DEFAULT_SETTINGS,
  SETTINGS_PATH: settingsPath,
  readSettings,
  writeSettings,
};
