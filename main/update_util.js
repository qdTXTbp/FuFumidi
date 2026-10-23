// ============================================================
// 更新器自检（纯函数，便于单测）
// ============================================================
// 背景：2026-10-18 用户点更新报「安装包损坏，请重新下载」。更新器日志显示
//   INSTALLER_CONFIG: ... "embedded_config":{} , install_path=C:\Program Files\KachinaInstaller
// —— 安装目录里的 FuFumidi.update.exe 是「未嵌入应用配置」的旧更新器（手动部署只换了
//   app.asar，没有同步更新器），于是它把安装路径认错并直接报损坏。
// 这里用与构建断言相同的标记检查：更新器字节里必须含应用数据目录名与主程序名。
'use strict';

const MARKERS = ['FuFumidiData', 'FuFumidi.exe'];

function updaterLooksConfigured(input) {
  let buf = input;
  if (typeof input === 'string') buf = Buffer.from(input, 'latin1');
  else if (input instanceof Uint8Array) buf = Buffer.from(input);
  if (!buf || !buf.length || buf.length < 1024) return false;
  const s = buf.toString('latin1');
  return MARKERS.every((m) => s.indexOf(m) >= 0);
}

module.exports = { updaterLooksConfigured, MARKERS };
