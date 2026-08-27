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
  transcribe_params: {},
  plugins_enabled: [],
  lang: 'zh',
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
