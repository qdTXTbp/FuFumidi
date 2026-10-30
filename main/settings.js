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
  ui_material: 'default',
  perf_mode: 'quality',
  engine_path: '',
  engine_mode: 'universal',
  output_dir: '',
  guide_done: false,
  advanced_mode: false,
  /* P2-6 AI 生成（可选、默认关）：本地生成命令由用户自备；
     默认命令留空 = not-configured，不会联网也不会内置模型。 */
  'ai.enabled': false,
  'ai.provider_cmd': '',
  /* P2-1 VST3 离线渲染宿主：解释器与插件目录都不随包分发，需用户自备（见 docs/plugins.md） */
  'plugin.host_python': '',
  'plugin.dirs': [],
  custom_wallpaper: '',
  wallpaper_prompt_done: false,
  wallpaper_enabled: false,
  transcribe_params: {},
  plugins_enabled: [],
  lang: '',   // 界面语言：''=未设定（首次启动按浏览器语言确定），可选 'zh' | 'zh-Hant' | 'en' | 'ja'
  hf_token: '',   // HuggingFace 访问令牌（用于下载 gated 模型，如 MuScriptor 需授权）
  active_soundfont: 'internal',   // 播放时使用的音色库：'internal'=内置合成器，其余为 SF2 文件绝对路径（音色工坊选择，持久化）
  /* P0-5：默认 GM 音色懒加载。true = 桌面端首次播放时后台加载随包分发的 GeneralUser GS
     （renderer/vendor/soundfonts/GeneralUser.sf2，29.8MB），不阻塞首屏；用户在音色工坊显式选过
     音色或关掉此开关则不再自动加载。 */
  default_gm: true,
  /* P0-3b：MIDI 键盘录音的输入延迟补偿（ms，正 = 键盘/驱动比实际发声晚）。延迟校准会用中位数写这里。 */
  midiInputOffsetMs: 0,
  /* P0-4 音频导出默认值（导出面板接线后消费；先给默认，避免老设置文件缺键） */
  'export.audio.format': 'wav24',   // wav16 / wav24 / float32（/ flac 等后续）
  'export.audio.dither': true,      // 仅 16bit 生效
  'export.audio.loudness': 'off',   // off / -14 / -16 / -23 LUFS
  data_root: '',  // 数据根目录（模型 / 依赖 / 缓存 / 临时文件的落点）；留空 = 自动（工具目录旁的 FuFumidiData）
  /* ★ 2026-10-24：上一次实际使用的数据根，**自动写入、仅作线索**。
     存在的理由：6.2.4 装进 Program Files 后数据根回退到 %APPDATA% 下新建的空目录，
     而用户数据还在旧便携目录里 —— 之前没有任何记录能把它找回来。
     注意与 data_root 的区别：data_root 是用户显式指定（优先级最高）；
     这个只是「上次用过的位置」，只有目录**里真有数据**时才会被认领。 */
  data_root_last: '',
  update_channel: 'stable',  // 更新通道：'stable'=正式版（默认），'beta'=测试版（提前收到 X.Y.Z-beta.N / -rc.N）
  download_source: 'auto',   // 下载源：'auto'=自动（优先国内 CNB，失败回退 GitHub），'cnb'=国内优先，'github'=全球优先
  // 线路测速后选定的具体源 id（如 'ghfast' / 'cnb-beta' / 'github'）；空串 = 没选过，按 download_source 的偏好走。
  // 只影响**顺序**（提到最前），不可达时仍会沿回退链换源 —— 不是硬绑定。
  update_preferred_source: '',
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
  // ---- 播放（用户 2026-10-14 定）----
  // 跳过空白片段：**默认关**（给一个显眼的开关）；开头静音**默认跳**。
  skip_silence: false,
  skip_silence_min: 2.5,        // 多长的空档才跳（秒）
  skip_leading_silence: true,   // 开头静音默认跳
  seek_step: 5,                 // 方向键步长（数值）
  seek_step_unit: 'sec',        // 'sec' | 'percent' | 'bar'
  hold_delay_ms: 400,           // 按住多久算"长按"
  hold_rate: 2,                 // 长按时的播放倍数（→ 快进播放；← 快退不出声）
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'fufumidi', 'settings.json');
}

function readSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch (e) {
    const p = settingsPath();
    try { if (fs.existsSync(p)) fs.renameSync(p, p + '.corrupt-' + Date.now()); } catch (e2) { try { require('./log').write('WARN', 'optional failure', String((e2 && e2.stack) || e2)); } catch (_) { /* log failure ignored */ } }
    const repaired = { ...DEFAULT_SETTINGS, guide_done: true };
    try { writeSettings(repaired); } catch (e3) { try { require('./log').write('WARN', 'optional failure', String((e3 && e3.stack) || e3)); } catch (_) { /* log failure ignored */ } }
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
