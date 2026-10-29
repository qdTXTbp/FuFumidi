// ============================================================
// 主进程文件日志：补上审计 §5「logDir 零写入」的缺口。
// 打包版没有控制台，未捕获异常/渲染进程崩溃至少要留一份现场。
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
let logFile = '';

function rotate(dir) {
  try {
    const st = fs.statSync(logFile);
    if (st.size < 5 * 1024 * 1024) return;
    const old = logFile + '.1';
    try { fs.rmSync(old, { force: true }); } catch (e) {}
    fs.renameSync(logFile, old);
  } catch (e) {}
}
function write(level, message, extra) {
  if (!logFile) return;
  try {
    rotate(path.dirname(logFile));
    const line = new Date().toISOString() + ' [' + level + '] ' + String(message || '') + (extra ? ' ' + extra : '') + '\n';
    fs.appendFileSync(logFile, line, 'utf8');
  } catch (e) {}
}
function installLogging({ app, dir, fs: f } = {}) {
  try {
    const d = dir || path.join(app.getPath('userData'), 'logs');
    (f || fs).mkdirSync(d, { recursive: true });
    logFile = path.join(d, 'main.log');
    write('INFO', 'logger started', 'v' + (app.getVersion ? app.getVersion() : ''));
    process.on('uncaughtException', (err) => write('FATAL', (err && err.stack) || err));
    process.on('unhandledRejection', (err) => write('ERROR', 'unhandledRejection ' + ((err && err.stack) || err)));
    app.on('render-process-gone', (_e, _wc, details) => write('ERROR', 'render-process-gone', JSON.stringify(details || {})));
    app.on('child-process-gone', (_e, details) => write('ERROR', 'child-process-gone', JSON.stringify(details || {})));
  } catch (e) {}
  return { write, logFile: () => logFile };
}
module.exports = { installLogging, write };
