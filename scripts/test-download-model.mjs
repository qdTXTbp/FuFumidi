// ============================================================
// 模型分卷下载实测：从 monologue82/Models 下载 MuScriptor Small
// 验证：测速选源 → 4 路并行下载 → 按序合并 → SHA256 校验
// 用法: node scripts/test-download-model.mjs [small|medium|large]
// ============================================================
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SIZE_KEY = process.argv[2] || 'small';
const CONCURRENCY = 4;

const REPO = 'monologue82/Models';
const BASE = `main/muscriptor/${SIZE_KEY}`;
const HOSTS = [
  'https://gh.jasonzeng.dev/https://raw.githubusercontent.com',
  'https://raw.githubusercontent.com',
  'https://ghfast.top/https://raw.githubusercontent.com',
  'https://gh-proxy.com/https://raw.githubusercontent.com',
];
const HEADERS = { 'user-agent': 'FuFumidi-test' };

const partName = (model, i) => `${model}.part${String(i).padStart(2, '0')}`;
const sha256File = (p) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  const s = fs.createReadStream(p);
  s.on('error', reject);
  s.on('data', (d) => h.update(d));
  s.on('end', () => resolve(h.digest('hex')));
});

async function fetchBytes(url, limit = 0) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 120000);
  const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
  if (!r.ok || !r.body) { clearTimeout(to); throw new Error('HTTP ' + r.status + ' ' + url); }
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    got += value.length;
    if (limit && got >= limit) break;
  }
  clearTimeout(to);
  if (limit) { try { await reader.cancel(); } catch (e) {} }
  return Buffer.concat(chunks);
}

async function main() {
  // 1) manifest
  let manifest = null;
  for (const h of HOSTS) {
    try {
      const b = await fetchBytes(`${h}/${REPO}/main/manifest.json`);
      manifest = JSON.parse(b.toString('utf8'));
      if (manifest?.muscriptor?.[SIZE_KEY]) break;
    } catch (e) { console.log('  manifest 失败:', h, e.message); }
  }
  const meta = manifest?.muscriptor?.[SIZE_KEY];
  if (!meta) throw new Error('manifest 不可用');
  const parts = Number(meta.parts);
  console.log(`\n[清单] ${SIZE_KEY}: ${parts} 卷, ${(meta.size / 1e6).toFixed(1)} MB, sha256=${meta.sha256?.slice(0, 16)}…\n`);

  // 2) 测速
  console.log('[测速] 各源下载 part01 前 256KB:');
  const speeds = [];
  for (const h of HOSTS) {
    const t0 = Date.now();
    try {
      await fetchBytes(`${h}/${REPO}/${BASE}/${partName(meta.model, 1)}`, 256 * 1024);
      const mbps = 0.25 / ((Date.now() - t0) / 1000);
      speeds.push({ host: h, mbps });
      console.log(`  ${h.replace('https://', '').padEnd(40)} ${mbps.toFixed(1)} MB/s`);
    } catch (e) {
      speeds.push({ host: h, mbps: 0 });
      console.log(`  ${h.replace('https://', '').padEnd(40)} 不可达`);
    }
  }
  speeds.sort((a, b) => b.mbps - a.mbps);
  const primary = speeds[0].mbps > 0 ? speeds[0].host : HOSTS[0];
  console.log(`  选用: ${primary.replace('https://', '')}\n`);

  // 3) 并行下载
  const destDir = path.join(ROOT, 'models', 'muscriptor', SIZE_KEY);
  const partsDir = path.join(destDir, '.parts');
  fs.mkdirSync(partsDir, { recursive: true });
  const outFile = path.join(destDir, meta.model || 'model.safetensors');
  let received = 0;
  const order = Array.from({ length: parts }, (_, i) => i + 1);
  let cursor = 0;
  console.log(`[下载] 并发 ${CONCURRENCY} 路…`);
  const tStart = Date.now();
  const dlPart = async (i) => {
    const name = partName(meta.model, i);
    const dest = path.join(partsDir, name);
    const tmp = dest + '.part';
    for (const h of [primary, ...HOSTS.filter((x) => x !== primary)]) {
      try {
        const buf = await fetchBytes(`${h}/${REPO}/${BASE}/${name}`);
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, dest);
        received += buf.length;
        const pct = ((received / meta.size) * 100).toFixed(1);
        process.stdout.write(`\r  进度 ${pct}%  (${name} 完成, ${(buf.length / 1e6).toFixed(1)} MB)`);
        return;
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (_) {}
      }
    }
    throw new Error('分卷下载失败: ' + name);
  };
  const workers = Array.from({ length: Math.min(CONCURRENCY, parts) }, async () => {
    while (cursor < order.length) {
      const i = order[cursor++];
      await dlPart(i);
    }
  });
  await Promise.all(workers);
  const dlMs = Date.now() - tStart;
  console.log(`\n[下载] 完成，耗时 ${(dlMs / 1000).toFixed(1)}s，${(meta.size / dlMs / 1e3).toFixed(1)} MB/s`);

  // 4) 合并
  console.log('[合并] 按序合并分卷…');
  const ws = fs.createWriteStream(outFile);
  for (let i = 1; i <= parts; i++) {
    const p = path.join(partsDir, partName(meta.model, i));
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(p);
      rs.on('error', reject);
      rs.pipe(ws, { end: false });
      rs.on('end', resolve);
    });
  }
  await new Promise((res, rej) => ws.end((e) => (e ? rej(e) : res())));

  // 5) 校验
  const size = fs.statSync(outFile).size;
  console.log(`[校验] 文件大小 ${(size / 1e6).toFixed(1)} MB (期望 ${(meta.size / 1e6).toFixed(1)} MB)`);
  const hash = await sha256File(outFile);
  console.log(`       sha256 ${hash}`);
  if (meta.sha256 && hash !== meta.sha256) {
    console.error('       ✗ SHA256 校验失败!');
    fs.rmSync(outFile, { force: true });
    process.exitCode = 1;
  } else {
    console.log('       ✓ SHA256 校验通过');
  }
  fs.rmSync(partsDir, { recursive: true, force: true });
  console.log(`\n模型就绪: ${outFile}`);
}

main().catch((e) => { console.error('\n失败:', e.message); process.exit(1); });
