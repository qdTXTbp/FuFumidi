// electron-builder 在 Windows 上给 FuFumidi.exe 写 asar 完整性资源时，会把 200MB
// 的 exe 整份 readFile → writeFile 写回。Defender / 索引器此时常独占刚落盘的 exe，
// writeFile 直接抛 EPERM；重试**整个 dir 阶段**没用（每次重来又会重新触发一次扫描）。
//
// 用 NODE_OPTIONS=--require 注入本文件，只给 fs/promises.writeFile 的 EPERM 加退避重试。
// 只拦 EPERM，其它错误原样抛；最多 10 次、累计约 27s，足够扫描释放句柄。
'use strict';
const fsp = require('fs/promises');

if (typeof fsp.writeFile === 'function' && !fsp.writeFile.__fufumidiEpermRetry) {
  const original = fsp.writeFile;
  const patched = async function writeFileWithRetry(file, data, options) {
    for (let attempt = 0; ; attempt++) {
      try { return await original.call(this, file, data, options); }
      catch (e) {
        if (!e || e.code !== 'EPERM' || attempt >= 9) throw e;
        const wait = 400 * (attempt + 1);
        try { require('fs').writeSync(2, `[fs-retry] EPERM writeFile ${file} — ${attempt + 1}/10，${wait}ms 后重试\n`); }
        catch (_) { /* 日志失败不影响重试 */ }
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  };
  patched.__fufumidiEpermRetry = true;
  fsp.writeFile = patched;
}
