// ============================================================
// 资源下载吞吐基准（会联网）
// ------------------------------------------------------------
// 目的：给 main/fast-download.js 里的常量（分卷并发、分段策略）提供实测依据。
// 换网络环境 / 换镜像之后重跑一次，把结果更新进 docs/DOWNLOADS.md 第 2 节。
//
// 用法：
//   node scripts/bench-download.mjs                    # 默认测 vocal/kim_melbandroformer 的分卷
//   node scripts/bench-download.mjs vocal/big_beta5e   # 指定清单里的某个键
//   node scripts/bench-download.mjs --window 8000      # 每个并发档位的采样窗口（毫秒）
//
// 只做「读 + 计数」，不落盘（避免污染数据目录）。
// ============================================================
import { argv } from 'node:process';

const ARGS = argv.slice(2);
const WINDOW = (() => {
  const i = ARGS.indexOf('--window');
  return i >= 0 ? parseInt(ARGS[i + 1], 10) || 8000 : 8000;
})();
const CAT = (ARGS.find((a) => !a.startsWith('--') && a.includes('/')) || 'vocal/kim_melbandroformer');
const [cat, key] = CAT.split('/');
const UA = { 'user-agent': 'FuFumidi-bench' };
const CNB = 'https://cnb.cool/FuFuCloud-mirror/Models/-/git/raw/main/';
const GH = 'https://raw.githubusercontent.com/monologue82/Models/main/';

async function fetchManifest() {
  for (const base of [CNB, GH]) {
    try {
      const r = await fetch(base + 'manifest.json', { headers: UA });
      if (r.ok) return await r.json();
    } catch (e) { /* 换下一个源 */ }
  }
  throw new Error('manifest 拉取失败（两个源都不通）');
}

function partUrl(i) {
  const meta = MANIFEST[cat][key];
  const name = meta.model + '.part' + String(i).padStart(2, '0');
  return { url: CNB + cat + '/' + key + '/' + name, size: Math.min(25 * 1024 * 1024, MANIFEST[cat][key].size - (i - 1) * 25 * 1024 * 1024) };
}

/** 同时拉 n 个不同分卷，采样 windowMs，返回聚合吞吐 */
async function measureParts(n) {
  if (n > MANIFEST[cat][key].parts) return null;
  const ctrl = new AbortController();
  const counts = new Array(n).fill(0);
  const t0 = Date.now();
  const timer = setTimeout(() => ctrl.abort(), WINDOW);
  const one = async (idx, part) => {
    try {
      const r = await fetch(partUrl(part).url, { headers: UA, signal: ctrl.signal });
      if (!r.body) return;
      const rd = r.body.getReader();
      for (;;) { const { done, value } = await rd.read(); if (done) break; counts[idx] += value ? value.length : 0; }
    } catch (e) { /* 窗口结束 */ }
  };
  await Promise.allSettled(Array.from({ length: n }, (_, i) => one(i, i + 1)));
  clearTimeout(timer);
  const ms = Date.now() - t0;
  const sum = counts.reduce((a, b) => a + b, 0);
  return { mbps: sum / 1048576 / (ms / 1000), sum, ms };
}

const MANIFEST = await fetchManifest();
const meta = MANIFEST[cat] && MANIFEST[cat][key];
if (!meta) throw new Error('清单里没有 ' + CAT);
console.log('目标：' + CAT + '（' + meta.model + '，' + meta.parts + ' 卷，' + (meta.size / 1048576).toFixed(1) + ' MB，单卷 25 MiB）');
console.log('窗口：' + WINDOW + 'ms/档；源：' + CNB + '\n');
console.log('| 并行分卷 | 聚合 MB/s | 采样字节 | 说明 |');
console.log('| --- | --- | --- | --- |');
for (const n of [1, 2, 4, 8, 12, 16]) {
  const r = await measureParts(n);
  if (!r) continue;
  console.log('| ' + n + ' | ' + r.mbps.toFixed(2) + ' | ' + (r.sum / 1048576).toFixed(1) + ' MB | ' + (n === 12 ? '默认值（PARTS_CONCURRENCY）' : '') + ' |');
}
console.log('\n注：CNB 的 git raw 忽略 Range、不返回 content-length，所以单文件无法分段；提速靠分卷级并发。');
