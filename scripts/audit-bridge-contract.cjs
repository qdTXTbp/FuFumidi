#!/usr/bin/env node
// ============================================================
// 桥接契约审计：找出「空函数」与「空引用」这类静默失效
// ============================================================
// 起因（实测）：双击 .mid 打开**完全没反应**。查下来是主进程
// webContents.send('open-file', …) 发出去了，而**整个前端没有任何地方订阅它** ——
// types/ipc.ts 有类型声明、bridge/tauri.js 有个 () => {} 空实现，
// 唯独真正该调的 preload 方法没人用。什么都不抛，UI 只是「没反应」。
//
// 这类缺陷肉眼看 900 行文件是找不到的，必须机械地把两侧抽出来 diff。
//
// 审计四条边界：
//   A. preload 暴露的 fuBridge.X  ↔  前端实际调用 bridge.X()
//        producer-only = **暴露了没人用**（open-file 就是这一类，最危险）
//        consumer-only = 调了不存在的方法（运行时 TypeError）
//   B. main 的 ipcMain.handle('x') ↔ preload 的 ipcRenderer.invoke('x')
//        producer-only = 死 handler；consumer-only = invoke 打空
//   C. main 的 webContents.send('e') ↔ preload 的 ipcRenderer.on('e')
//   D. 桥接层的空实现（=> {} / () => {} / () => null）
//
// 用法：node scripts/audit-bridge-contract.cjs [--verbose]
// 退出码：有「危险」级别的问题时为 1，否则 0（便于挂 CI）。
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } }
function walk(dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist' && e.name !== '.tmp') walk(p, out); }
    else if (/\.(ts|js|vue|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const preload = read(path.join(ROOT, 'preload.js'));
const frontFiles = walk(path.join(ROOT, 'frontend', 'src'));
const mainFiles = walk(path.join(ROOT, 'main')).concat([path.join(ROOT, 'main.js')]).filter(f => fs.existsSync(f));

// ---------- A: preload 暴露 vs 前端调用 ----------
// preload 里形如 "  name: (...) =>" 或 "  name: function"
// （顶层/嵌套的提取见下方 exposedTop / exposedNested）
// ★ 要区分「顶层方法」与「嵌套命名空间的成员」：
//   preload 里既有 `openExternal: …`（顶层），也有 `update: { openExternal: … }`（嵌套）。
//   第一版把两者混为一谈：先是漏掉嵌套（把 openExternal 误报成 consumer-only），
//   改成任意缩进后又把 `list` / `delete` / `defaults` 这些嵌套成员当成了桥接方法（噪声 90 条）。
//   正确做法：按缩进判断层级，分别记顶层方法与「父.子」路径。
const exposedTop = new Set();
const exposedNested = new Set();
{
  let parent = null;
  for (const line of preload.split(/\r?\n/)) {
    const m = /^(\s+)([A-Za-z_$][\w$]*)\s*:\s*(\(|function|async|\{)/.exec(line);
    if (!m) continue;
    const depth = Math.floor(m[1].length / 2);
    const name = m[2], isObj = m[3] === '{';
    if (depth === 1) {
      if (isObj) { parent = name; } else { parent = null; exposedTop.add(name); }
    } else if (depth === 2 && parent) {
      exposedNested.add(parent + '.' + name);
    }
  }
}

// ★ 别名的坑（第二版审计踩到）：实际调用大量写作
//     const b = window.fuBridge;  …  b.dbKvGet(key)
//     (bridge as any).diffsingerListVoicebanks()
//   只匹配 `bridge.X(` 会把它们全报成 producer-only（实测 52 条里绝大多数是假报）。
//   所以先扫一遍收集所有「从 fuBridge 赋值的变量名」，再连它们一起匹配。
// ★ 别名必须**按文件作用域**：`b` 这种短名在别的文件里指的是别的东西 ——
//   全局收集会把 `b.arrayBuffer` / `b.find` / `b.transaction` 这些 DOM/IDB 调用
//   也算成桥接调用，于是「危险」类灌进 16 条假报（第三版踩到）。
const fileAliases = new Map();   // 文件 -> Set(别名)
for (const f of frontFiles) {
  const s = new Set(['bridge', 'fuBridge']);
  const src = read(f);
  // 直接赋值 / 三元赋值：
  //   const b = window.fuBridge
  //   const b = (typeof window !== 'undefined') ? window.fuBridge : null   ← 三元，
  //     display.js:41 就是这个写法，只认「= 后紧跟 fuBridge」会漏掉它。
  // 放宽成「同一行、等号右边提到过 fuBridge」即可（右边出现 fuBridge 基本就是取桥）。
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=[^\n]*fuBridge/g)) s.add(m[1]);
  // ★ 间接取桥（第三版又漏了）：文件里常写成
  //     function br(): any { return (window as any).fuBridge; }
  //     const b = br();
  //   只认直接赋值会把 cloudSync.ts 的 dbKvGet/dbKvSet 全报成 producer-only。
  //   做法：先找「返回 fuBridge 的辅助函数」，再把 `const X = 该函数()` 的 X 也算别名。
  const helpers = new Set();
  for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)[^{]*\{[^}]*fuBridge/g)) helpers.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\([^)]*\)\s*=>[^;\n]*fuBridge/g)) helpers.add(m[1]);
  if (helpers.size) {
    const hre = new RegExp('(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=]+)?=\\s*(?:' + [...helpers].join('|') + ')\\s*\\(', 'g');
    for (const m of src.matchAll(hre)) s.add(m[1]);
  }
  fileAliases.set(f, s);
}
const aliasReOf = (set) => [...set].map(a => a.replace(/[$]/g, '\\$')).join('|');

// ★ 标准 API 名排除表：短别名（`b` / `ab` 之类）在别的上下文里指向 AudioBuffer、
//   IndexedDB、DOM 元素，会把 `ab.getChannelData()`、`b.transaction()` 误报成桥接调用。
//   实测 `getChannelData` 就是这么冒出来的假报（ab 是 AudioBuffer，不是 bridge）。
//   这张表要**显式写下来**：不写，下次审计的人不知道这些是被有意放过的。
//   代价：如果将来真有同名的桥接方法，它会被漏掉 —— 所以桥接方法一律用
//   带前缀的描述性命名（dbXxx / gpuXxx / diffsingerXxx），不要叫 get/set/find。
const STD_API = new Set(['getChannelData','arrayBuffer','createObjectStore','objectStoreNames',
  'transaction','slice','splice','find','findIndex','some','every','filter','map','forEach',
  'keys','values','entries','click','connect','disconnect','get','set','has','delete','push',
  'pop','shift','unshift','indexOf','includes','join','split','replace','match','test','exec',
  'then','catch','finally','toString','valueOf','addEventListener','removeEventListener']);

const bridgeAliasesCache = new Map();
const used = new Map();   // name -> [文件:行]
// 同时抓顶层 `bridge.X(` 与嵌套 `bridge.X.Y(` —— 后者用于识别命名空间访问
// 每个文件用自己的别名集合构造匹配（见上）
for (const f of frontFiles) {
  const src = read(f);
  src.split(/\r?\n/).forEach((rawLine, i) => {
    // 去掉 TS 类型断言 `(bridge as any)` → `bridge`，否则后面的 .X( 接不上
    const line = rawLine.replace(/\(\s*([A-Za-z_$][\w$]*)\s+as\s+[\w$.<>\[\]| ]+\)/g, '$1');
    // 解构调用也要算「用过」：`const { dbKvGet, dbKvSet } = bridge` ——
    // 只认 `bridge.X(` 会把这些全报成 producer-only，噪声大到没人看（第一版就是）。
    const dm = new RegExp('(?:const|let|var)\\s*\\{([^}]+)\\}\\s*=\\s*(?:window\\.)?(?:' + aliasReOf(fileAliases.get(f) || new Set(['bridge'])) + ')\\b').exec(line);
    if (dm) {
      for (const part of dm[1].split(',')) {
        const n = part.split(':').pop().trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(n)) continue;
        if (!used.has(n)) used.set(n, []);
        used.get(n).push(path.relative(ROOT, f) + ':' + (i + 1) + '（解构）');
      }
    }
    if (!bridgeAliasesCache.has(f)) {
      bridgeAliasesCache.set(f, new RegExp('(?:window\\.)?(?:' + aliasReOf(fileAliases.get(f) || new Set(['bridge']))
        + ')\\.([A-Za-z_$][\\w$]*)(?:\\.([A-Za-z_$][\\w$]*))?\\s*\\(', 'g'));
    }
    for (const m of line.matchAll(bridgeAliasesCache.get(f))) {
      // 有第二段就记成「父.子」，否则只记顶层名
      const n = m[2] ? (m[1] + '.' + m[2]) : m[1];
      if (STD_API.has(n)) continue;   // 见 STD_API：短别名撞上标准 API
      if (!used.has(n)) used.set(n, []);
      used.get(n).push(path.relative(ROOT, f) + ':' + (i + 1));
    }
  });
}

// ★ 显式豁免表：这些是「确实没人调用」的桥接面，但**逐条确认过**属于下列情形。
//   写下来的意义：审计报告保持短、可信；下次有人看到豁免表，能直接判断该不该动。
//   规则：新增豁免必须写明理由，不许为了「让审计变绿」而加。
const ALLOWED_UNUSED = {
  // 跨构建：只有 Tauri 构建用到（frontend/src/bridge/tauri.js 是另一套实现）
  rustInvoke: 'Tauri 原生模式专用；Electron 构建下无调用方',
  // 被更强的接口取代，但保留兼容
  gpuPackageUrl: '已被 gpuListPackages 取代（后者返回完整包信息）',
  // 事件类：主进程发，但当前 UI 不订阅（订阅了才有意义）
  onHotkeysState: '快捷键状态事件；UI 目前直接读 store，未订阅',
  // 调试/内部：只在注释或排障里被提到，不是常规调用路径
  getZoomFactor: '仅在 display.js 的注释中被提到（真实值可从 documentElement.dataset.uiScale 读）',
  // TODO(待确认)：下面这些我需要逐个确认「该接界面」还是「该删」——
  //   它们都对应主进程里真实存在的功能，但界面上找不到入口。
  dbStatus: 'TODO 待确认：库状态查询，可能已被 dbList/dbKv* 取代',
  modelPause: 'TODO 待确认：暂停模型下载；界面目前只有取消',
  openEditGuide: 'TODO 待确认：打开编辑引导；界面上没找到入口',
  updateDownload: 'TODO 待确认：更新下载动作；可能与 update.* 命名空间重复',
  updateOpen: 'TODO 待确认：打开更新；可能与 update.* 命名空间重复',
  utauFlags: 'TODO 待确认：UTAU 标志位；界面未接入',
  utauImportVoicebankZip: 'TODO 待确认：从 zip 导入声库；界面上没找到入口',
  // 同名本地函数撞车，桥接方法本身确实没人用
  notify: 'EditorCanvas/ViewEdit 里是同名**本地函数**，桥接的 notify 无人调用',
  pickImage: 'vizbg.ts 里是同名**本地函数**，桥接的 pickImage 无人调用',
};
for (const k of Object.keys(ALLOWED_UNUSED)) exposedTop.delete(k);

// D 类（空实现）里确认为「跨构建已知缺口」的，同样在这里登记，不要静默放过。
const ALLOWED_STUBS = {
  onOpenFile: 'Tauri 构建未实现文件关联（Electron 侧已修好）；见 tauri.js 内注释',
  onFolderWatch: 'Tauri 构建未实现文件夹监听；见 tauri.js 内注释',
};

const exposed = new Set([...exposedTop, ...exposedNested]);
// producer-only 只报**顶层**方法 —— 嵌套成员是命名空间内部实现，不该独立上报
const exposedUnused = [...exposedTop].filter(n => !used.has(n)).sort();
const usedUnexposed = [...used.keys()].filter(n => !exposed.has(n)).sort();

// ---------- B/C: ipcMain 与 ipcRenderer 的频道 ----------
const handlers = new Map();
for (const f of mainFiles) {
  const src = read(f);
  src.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(/ipcMain\.(?:handle|on)\(\s*['"]([^'"]+)['"]/g)) {
      if (!handlers.has(m[1])) handlers.set(m[1], []);
      handlers.get(m[1]).push(path.relative(ROOT, f) + ':' + (i + 1));
    }
  });
}
const invoked = new Map(), listens = new Map(), sent = new Map();
for (const m of preload.matchAll(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)) {
  invoked.set(m[1], (invoked.get(m[1]) || 0) + 1);
}
for (const m of preload.matchAll(/ipcRenderer\.on\(\s*['"]([^'"]+)['"]/g)) {
  listens.set(m[1], (listens.get(m[1]) || 0) + 1);
}
// ★ send 也算消费者（第四版漏的）：`notify: (ev,p) => ipcRenderer.send('app:event', …)`
//   走的是 send 不是 invoke/on，只收集后两者会把 app:event 误报成死 handler。
const sends = new Map();
for (const m of preload.matchAll(/ipcRenderer\.send\(\s*['"]([^'"]+)['"]/g)) {
  sends.set(m[1], (sends.get(m[1]) || 0) + 1);
}
for (const f of mainFiles.concat(walk(path.join(ROOT, 'main')))) {
  const src = read(f);
  for (const m of src.matchAll(/webContents\.send\(\s*['"]([^'"]+)['"]/g)) {
    if (!sent.has(m[1])) sent.set(m[1], []);
    sent.get(m[1]).push(path.relative(ROOT, f));
  }
}

const invokeNoHandler = [...invoked.keys()].filter(c => !handlers.has(c)).sort();
const handlerNoInvoke = [...handlers.keys()].filter(c => !invoked.has(c) && !listens.has(c) && !sends.has(c)).sort();
const sendNoListener = [...sent.keys()].filter(c => !listens.has(c)).sort();

// ---------- D: 桥接层空实现 ----------
const stubs = [];
for (const f of [path.join(ROOT, 'frontend', 'src', 'bridge', 'tauri.js'), path.join(ROOT, 'preload.js')]) {
  if (!fs.existsSync(f)) continue;
  read(f).split(/\r?\n/).forEach((line, i) => {
    // 只揪「对象成员被赋成空函数」这种**桩**形状：`name: () => {}` / `name: () => () => {}`。
    // 不要把 `.catch(() => () => {})` 这类防御性兜底算进来 —— 那是正确的错误处理，
    // 不是功能缺口（第五版把这两类混在一起，D 类虚高）。
    if (/^\s*[A-Za-z_$][\w$]*\s*:\s*\([^)]*\)\s*=>\s*(?:\{\s*\}|null\s*;?\s*$|\(\s*\)\s*=>\s*\{\s*\}\s*,?\s*)$/.test(line)) {
      stubs.push(path.relative(ROOT, f) + ':' + (i + 1) + '  ' + line.trim().slice(0, 90));
    }
  });
}

// ---------- 输出 ----------
const DANGER = [], NOTE = [];
if (usedUnexposed.length) DANGER.push(['A/consumer-only', usedUnexposed.length, usedUnexposed.map(n => n + '  ← ' + used.get(n).slice(0, 2).join(', '))]);
if (invokeNoHandler.length) DANGER.push(['B/consumer-only', invokeNoHandler.length, invokeNoHandler]);
if (exposedUnused.length) NOTE.push(['A/producer-only', exposedUnused.length, exposedUnused]);
if (handlerNoInvoke.length) NOTE.push(['B/producer-only', handlerNoInvoke.length, handlerNoInvoke]);
if (sendNoListener.length) NOTE.push(['C/producer-only', sendNoListener.length, sendNoListener]);
const stubsFiltered = stubs.filter(s => !Object.keys(ALLOWED_STUBS).some(k => new RegExp('^\\s*' + k + '\\s*:').test(s.replace(/^[^:]*:\d+\s+/, ''))));
if (stubsFiltered.length) NOTE.push(['D/空实现', stubsFiltered.length, stubsFiltered]);

function dump(title, rows) {
  for (const [cls, n, items] of rows) {
    console.log('\n[' + cls + '] ' + n + ' 项' + (cls.startsWith('A/consumer') || cls.startsWith('B/consumer') ? '  ← 会直接炸' : ''));
    const show = VERBOSE ? items : items.slice(0, 25);
    for (const it of show) console.log('   ' + it);
    if (!VERBOSE && items.length > show.length) console.log('   …还有 ' + (items.length - show.length) + ' 项（--verbose 看全部）');
  }
}

console.log('桥接契约审计');
console.log('  preload 顶层方法 ' + exposedTop.size + ' 个 / 嵌套成员 ' + exposedNested.size + ' 个；前端引用了 ' + used.size + ' 个访问路径');
console.log('  ipcMain 频道 ' + handlers.size + ' 个；preload invoke ' + invoked.size + ' / on ' + listens.size + ' / send ' + sends.size + '；主进程 send ' + sent.size + ' 个');
if (DANGER.length) { console.log('\n=== 危险（必须修） ==='); dump('danger', DANGER); }
if (NOTE.length) { console.log('\n=== 提示（多为设计如此，逐条确认） ==='); dump('note', NOTE); }
if (!DANGER.length && !NOTE.length) console.log('\n没有发现契约漂移。');
console.log('\n判读要点：');
console.log('  A/producer-only 里藏着「暴露了但没人订阅」这类静默失效 —— open-file 就是这么漏掉的。');
console.log('  但进度类事件（*Progress / *cancel*）按设计就是 producer-only，属正常。');
process.exit(DANGER.length ? 1 : 0);
