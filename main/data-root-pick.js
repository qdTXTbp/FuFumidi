// ============================================================
// 数据根「选哪个目录」的纯逻辑（不碰 fs / electron → 可单测）
//
// 2026-10-24 用户报障后新增：6.2.4 装进 Program Files 后，数据根回退到了
// %APPDATA%\FuFumidi\FuFumidiData 这个**新建的空目录**，而用户十几年数据还在
// 旧便携目录 E:\Midi\FuFumidi\FuFumidiData 里 —— 旧目录从头到尾没被找过。
// 根因：候选表只有 [settings.data_root, 安装目录, %APPDATA%] 三条，缺「上一次用过的位置」。
//
// 现在的选目录规则（**先看谁真有数据，再看谁可写**）：
//   1. settings.data_root（用户显式指定）—— 只要可写就用，即使是空目录
//   2. settings.data_root_last（上次实际用过的）—— **必须有内容**才认领
//   3. 安装目录旁的 FuFumidiData —— 有内容就用（便携版常态）
//   4. 从设置里那些绝对路径反推出来的历史数据根 —— 有内容才认领
//   5. %APPDATA%\FuFumidiData —— 有内容才认领
//   6. 安装目录旁（哪怕还不存在，只要父目录可写就建）—— 全新便携安装
//   7. %APPDATA%\FuFumidiData（新建）
//
// 「必须有内容才认领」是关键：否则会认领到上次故障留下的空目录，问题原地复发。
// 反过来，「有内容」优先于「可写但空」，才不会在换安装位置后又看到一片空白。
// ============================================================
'use strict';
const path = require('path');

/** 数据根目录名 */
const DATA_DIR_NAME = 'FuFumidiData';
/** 数据根下有哪些子目录（任意一个非空即认为「这里有数据」）。与 paths.js 的功能区保持一致。 */
const DATA_SUBDIRS = [
  'models', 'gpu-enhancements', 'soundfonts', 'voicebanks',
  'diffsinger', 'diffsinger-voicebanks', 'midi', 'cache', 'temp', 'logs',
];
/** 向上回溯的最大层数（防止异常路径把循环拖长） */
const MAX_UP = 12;

function samePath(a, b) {
  if (!a || !b) return false;
  try {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  } catch (_) {
    return String(a).toLowerCase() === String(b).toLowerCase();
  }
}

/**
 * 从任意一条绝对路径（文件或目录）反推「可能是数据根」的候选。
 *
 * 例：E:\Midi\FuFumidi\FuFumidiData\soundfonts\x.sf2
 *   → E:\Midi\FuFumidi\FuFumidiData（祖先里 basename 命中）
 *   → 以及每一层祖先下的 FuFumidiData（E:\Midi\FuFumidi\FuFumidiData 再命中一次）
 * 返回的候选**不保证存在**，由调用方用 hasData/canUse 过滤。
 */
function rootsFromHint(p, dirName = DATA_DIR_NAME) {
  const out = [];
  if (!p || typeof p !== 'string') return out;
  if (!path.isAbsolute(p)) return out;
  let cur;
  try { cur = path.resolve(p); } catch (_) { return out; }
  const want = String(dirName).toLowerCase();
  for (let i = 0; i < MAX_UP; i++) {
    let base = '';
    try { base = path.basename(cur); } catch (_) { base = ''; }
    if (base.toLowerCase() === want) out.push(cur);
    out.push(path.join(cur, dirName));
    let parent;
    try { parent = path.dirname(cur); } catch (_) { break; }
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return out;
}

/** 从一堆路径里收集候选（去重、保持顺序） */
function rootsFromHints(hints, dirName = DATA_DIR_NAME) {
  const seen = new Set();
  const out = [];
  for (const h of (hints || [])) {
    for (const c of rootsFromHint(h, dirName)) {
      const k = (() => { try { return path.resolve(c).toLowerCase(); } catch (_) { return c.toLowerCase(); } })();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
  }
  return out;
}

/**
 * 决定用哪个数据根。**纯函数**：所有文件系统事实由注入的谓词提供。
 *
 * @param {object} o
 * @param {string}   o.configured   settings.data_root（用户显式指定，可为空）
 * @param {string}   o.last         settings.data_root_last（上次实际用过，可为空）
 * @param {string}   o.preferred    安装目录旁的 FuFumidiData
 * @param {string}   o.userData     %APPDATA% 下的兜底位置
 * @param {string[]} o.discovered   从设置路径反推出的历史候选（已展开）
 * @param {(d:string)=>boolean} o.canUse     已存在且可写（**不创建目录**）
 * @param {(d:string)=>boolean} o.canCreate  目录还不存在，但父目录可写（可以建）
 * @param {(d:string)=>boolean} o.hasData    该目录里确实有数据
 * @returns {{root:string, reason:string, from:string}}  from = 依据来源，便于日志/UI 说明
 */
function pickDataRoot(o) {
  const opt = o || {};
  const configured = opt.configured || '';
  const last = opt.last || '';
  const preferred = opt.preferred || '';
  const userData = opt.userData || '';
  const discovered = Array.isArray(opt.discovered) ? opt.discovered : [];
  const canUse = opt.canUse || (() => false);
  const canCreate = opt.canCreate || (() => false);
  const hasData = opt.hasData || (() => false);

  // ① 用户显式指定：可写就用，哪怕空着（尊重用户选择，不再偷偷换成别的）
  if (configured && canUse(configured)) {
    return { root: configured, reason: 'configured', from: 'settings.data_root' };
  }

  // ② 上次实际用过的位置：**必须有内容**才认领（防止认领上次故障留下的空目录）
  if (last && hasData(last) && canUse(last)) {
    return { root: last, reason: 'adopted-previous', from: 'settings.data_root_last' };
  }

  // ③ 安装目录旁：有内容就用（便携版常态；也是「同一台机器上换安装位置」的正确行为）
  if (preferred && hasData(preferred) && canUse(preferred)) {
    return { root: preferred, reason: 'install-dir', from: 'install-dir' };
  }

  // ④ 从设置里的绝对路径反推出的历史数据根：有内容才认领
  //    ★ 这一条就是本次报障的修复点（旧便携目录 E:\Midi\FuFumidi\FuFumidiData）
  for (const d of discovered) {
    if (!d) continue;
    if (samePath(d, configured) || samePath(d, preferred) || samePath(d, userData)) continue;
    if (hasData(d) && canUse(d)) {
      return { root: d, reason: 'adopted-previous', from: 'settings-paths' };
    }
  }

  // ⑤ %APPDATA% 兜底位置里**已经有数据**（用户之前就装过、且没被切走）
  if (userData && hasData(userData) && canUse(userData)) {
    return { root: userData, reason: 'user-data', from: 'user-data' };
  }

  // ⑥ 全新安装：安装目录旁（可写即可，空也认；目录还不存在就建出来）
  //    ★ 必须带 canCreate：全新便携安装时 <安装目录>/FuFumidiData 本来就还没建，
  //      只判 canUse 会把它误判成不可用、一路掉到 %APPDATA%（这是本次修 bug 时
  //      自己引入又测出来的回归，别把 canCreate 去掉）。
  if (preferred && (canUse(preferred) || canCreate(preferred))) {
    return { root: preferred, reason: 'install-dir', from: 'install-dir' };
  }

  // ⑦ 实在没有可写的位置：只能落到 %APPDATA%（由调用方创建）
  return {
    root: userData,
    reason: configured ? 'configured-not-writable' : 'install-dir-not-writable',
    from: 'fallback',
  };
}

/** 目录里是否「有数据」：数据根子目录里任意一个非空，或直接有 .fufumidi-ready 标记 + 非空 */
function hasDataDir(dir, opts) {
  const o = opts || {};
  const fs = o.fs || require('fs');
  const exists = o.exists || ((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
  const readdir = o.readdir || ((p) => { try { return fs.readdirSync(p); } catch (_) { return []; } });
  if (!dir || !exists(dir)) return false;
  for (const sub of DATA_SUBDIRS) {
    const p = path.join(dir, sub);
    if (!exists(p)) continue;
    if (readdir(p).length > 0) return true;
  }
  // 没有已知子目录但目录本身有东西（自定义布局 / 老版本）：也算有数据，
  // 但要求有 ready 标记，避免把「随便一个非空目录」当成数据根。
  const mark = path.join(dir, o.readyMark || '.fufumidi-ready');
  if (exists(mark) && readdir(dir).length > 0) return true;
  return false;
}

module.exports = {
  DATA_DIR_NAME,
  DATA_SUBDIRS,
  MAX_UP,
  samePath,
  rootsFromHint,
  rootsFromHints,
  pickDataRoot,
  hasDataDir,
};
