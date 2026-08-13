#!/usr/bin/env node
// ============================================================================
// FuFumidi 内置 Python 运行时瘦身脚本
// ============================================================================
// 只处理任务 #38 明确点名裁减的无用内容：
//   - torch/bin / torch/share / torch/include : 构建工具与配置，运行期不需要
//   - Lib/test / DLLs/test                    : 标准库测试套件
//   - __pycache__                             : 字节码缓存，解释器按需重建
//   - pip 缓存目录                            : 安装期缓存，运行期不需要
// 其余包（clang/sympy/.*.lib 等）一律不碰，避免越过"不要把依赖项删除了"边界。
//
// 用法：
//   node scripts/prune-python.js --check      # 只列出将处理的条目与大小
//   node scripts/prune-python.js              # 移动到 <python>/.prune-stage/（可逆）
//   node scripts/prune-python.js --commit     # 引擎回归通过后再真正删除暂存
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..');
const PY = path.join(APP_DIR, 'python');
const STAGE = path.join(PY, '.prune-stage');
const COMMIT = process.argv.includes('--commit');
const CHECK = process.argv.includes('--check');

const info = m => console.log('\x1b[36m▸ ' + m + '\x1b[0m');
const ok = m => console.log('\x1b[32m✓ ' + m + '\x1b[0m');
const warn = m => console.log('\x1b[33m⚠ ' + m + '\x1b[0m');

function dirSize(p) {
  let total = 0;
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size;
    const stack = [p];
    while (stack.length) {
      const cur = stack.pop();
      let ents;
      try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const fp = path.join(cur, e.name);
        try { if (e.isDirectory()) stack.push(fp); else total += fs.statSync(fp).size; } catch {}
      }
    }
  } catch {}
  return total;
}
function human(n) { return (n / 1048576).toFixed(0) + ' MB'; }

function collect() {
  const hits = [];
  const seen = new Set();
  const add = p => { if (p && fs.existsSync(p) && !seen.has(p)) { seen.add(p); hits.push(p); } };

  // 1) torch 构建工具目录（仅 site-packages/torch 下，不碰 python/include 标准库头）
  add(path.join(PY, 'Lib/site-packages/torch/bin'));
  add(path.join(PY, 'Lib/site-packages/torch/share'));
  add(path.join(PY, 'Lib/site-packages/torch/include'));

  // 1b) 标准库测试套件（随 python-build-standalone 附带，运行期不需要）
  add(path.join(PY, 'Lib/test'));
  add(path.join(PY, 'DLLs/test'));

  // 2) 所有 __pycache__ 目录
  const stack = [PY];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const fp = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name === '__pycache__') add(fp);
        else stack.push(fp);
      }
    }
  }

  // 3) pip 缓存（安装期遗留）
  add(path.join(PY, 'Lib/site-packages/pip/_vendor/cache'));
  add(path.join(PY, 'pip-cache'));

  return hits;
}

(async () => {
  if (!fs.existsSync(PY)) { warn('未找到 app/python/ 目录。'); process.exit(1); }
  const hits = collect();
  if (!hits.length) { ok('没有需要处理的内容。'); process.exit(0); }

  let total = 0;
  for (const p of hits) total += dirSize(p);
  info(`将处理 ${hits.length} 项，合计 ${human(total)}`);

  if (CHECK) {
    for (const p of hits) console.log('  ' + human(dirSize(p)).padStart(8) + '  ' + path.relative(PY, p));
    process.exit(0);
  }

  if (COMMIT) {
    let n = 0, freed = 0;
    for (const p of hits) {
      const s = dirSize(p);
      try { fs.rmSync(p, { recursive: true, force: true }); freed += s; n++; } catch (e) { warn('删除失败 ' + p + ': ' + e.message); }
    }
    try { fs.rmSync(STAGE, { recursive: true, force: true }); } catch {}
    ok(`已删除 ${n} 项，释放 ${human(freed)}`);
    info('当前 python/ 体积：' + human(dirSize(PY)));
  } else {
    fs.mkdirSync(STAGE, { recursive: true });
    let n = 0, moved = 0;
    for (const p of hits) {
      const rel = path.relative(PY, p).replace(/[\\/]/g, '_');
      const dest = path.join(STAGE, rel);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(p, dest);
        moved += dirSize(dest); n++;
      } catch (e) { warn('移动失败 ' + p + ': ' + e.message); }
    }
    ok(`已暂存 ${n} 项（${human(moved)}）到 .prune-stage/`);
    info('引擎回归通过后执行 node scripts/prune-python.js --commit 完成删除');
  }
})().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
