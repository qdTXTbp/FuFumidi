// ============================================================
// 取字体并子集化（M1-b：字体全部内置，离线可用）
//
// 为什么必须子集化：思源黑体全量一个权重就 10+ MB（可变字体更大），而安装包体积
// 刚做过优化（去掉重复运行时省了 1.27 GB），不能又被字体吃回去。
// 做法：从仓库 UI 文案里抽出**实际用到的字符集**，用 pyftsubset 裁成 woff2。
//
// 授权：三款都是 OFL（可随应用分发）；清单里记来源 URL + 许可证，见 fonts/MANIFEST.json。
// 依赖：fonttools（应用自带 Python 里已有，实测 4.66.1）+ brotli（woff2 需要）。
//
// 用法：node scripts/fetch-fonts.mjs [--force]
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, '_attic', 'fonts-src');          // 下载缓存（不进仓库）
const OUT = path.join(ROOT, 'frontend', 'src', 'assets', 'fonts');
const PY = process.env.FUFUMIDI_PY || 'E:\\Midi\\FuFumidi\\resources\\python\\python.exe';
const FORCE = process.argv.includes('--force');

const FONTS = [
  {
    id: 'sans-sc', file: 'fufumidi-sans-sc.woff2', family: 'FuFumidi Sans',
    note: '界面正文与中文（可变字重 400–600）', license: 'OFL-1.1',
    urls: [
      'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf',
      'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf',
    ],
  },
  {
    id: 'mono', file: 'fufumidi-mono.woff2', family: 'FuFumidi Mono',
    note: '数字/遥测（时间码、BPM、百分比）', license: 'OFL-1.1',
    urls: [
      'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf',
      'https://raw.githubusercontent.com/google/fonts/main/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf',
    ],
  },
  {
    id: 'display', file: 'fufumidi-display.woff2', family: 'FuFumidi Display',
    note: '仅标题/品牌衬线（正文禁止使用）', license: 'OFL-1.1',
    urls: [
      'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/cinzel/Cinzel%5Bwght%5D.ttf',
      'https://raw.githubusercontent.com/google/fonts/main/ofl/cinzel/Cinzel%5Bwght%5D.ttf',
    ],
  },
];

/** UI 里实际会用到的字符：ASCII 可打印 + 中文标点 + 常用符号，其余从 src 里扫 */
function collectChars() {
  const set = new Set();
  for (let c = 0x20; c < 0x7f; c++) set.add(String.fromCharCode(c));
  for (const ch of '　、。〈〉《》「」『』【】〔〕！＂＃％＆（）＊＋，－．／：；＜＝＞？＠［］＾＿｀｛｜｝～¥·—…‰′″€£↑↓←→↔√×÷±≈≠≤≥∞°′″✓✔✕✗★☆●○◆◇■□▲△▼▽♪♩♫♬⟶⚡⏱⏸⏵') set.add(ch);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'dist', 'assets'].includes(e.name)) walk(p); continue; }
      if (!/\.(vue|ts|js|json|css)$/.test(e.name)) continue;
      for (const ch of fs.readFileSync(p, 'utf8')) if (ch.charCodeAt(0) > 0x7f) set.add(ch);
    }
  };
  walk(path.join(ROOT, 'frontend', 'src'));
  return [...set].join('');
}

async function download(urls, dst) {
  for (const u of urls) {
    try {
      const res = await fetch(u, { redirect: 'follow' });
      if (!res.ok) { console.log('   ' + res.status + ' ' + u); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 50000) { console.log('   太小(' + buf.length + 'B) ' + u); continue; }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, buf);
      console.log('   ✓ ' + (buf.length / 1048576).toFixed(2) + ' MB  ' + u.slice(0, 72));
      return { url: u, bytes: buf.length, sha: crypto.createHash('sha256').update(buf).digest('hex') };
    } catch (e) { console.log('   ✗ ' + String(e.message).slice(0, 60) + '  ' + u.slice(0, 60)); }
  }
  throw new Error('全部下载源都失败：' + urls[0]);
}

const chars = collectChars();
fs.mkdirSync(SRC, { recursive: true });
const charsFile = path.join(SRC, 'chars.txt');
fs.writeFileSync(charsFile, chars);
console.log('字符集：' + [...chars].length + ' 个字符（含 CJK ' + [...chars].filter((c) => c.charCodeAt(0) > 0x2e80).length + '）');
fs.mkdirSync(OUT, { recursive: true });

const manifest = [];
for (const f of FONTS) {
  const raw = path.join(SRC, f.id + '.ttf');
  const dst = path.join(OUT, f.file);
  if (!FORCE && fs.existsSync(dst) && fs.existsSync(path.join(OUT, 'MANIFEST.json'))) { console.log('跳过 ' + f.id + '（已存在）'); continue; }
  console.log('▶ ' + f.id);
  if (!fs.existsSync(raw)) {
    const meta = await download(f.urls, raw);
    f._meta = meta;
  }
  // pyftsubset：保留可变轴（一个文件覆盖 400–600），只裁字符，去掉 hinting 与无关表
  execFileSync(PY, ['-m', 'fontTools.subset', raw,
    '--text-file=' + charsFile, '--output-file=' + dst, '--flavor=woff2',
    '--layout-features=kern,liga,calt,ccmp,locl', '--no-hinting', '--desubroutinize',
    '--drop-tables+=DSIG', '--name-IDs=*', '--recalc-bounds',
  ], { stdio: 'inherit' });
  const out = fs.statSync(dst);
  manifest.push({
    id: f.id, family: f.family, file: f.file, note: f.note, license: f.license,
    source: (f._meta && f._meta.url) || '(cached)',
    sourceSha256: (f._meta && f._meta.sha) || null,
    outBytes: out.size, outSha256: crypto.createHash('sha256').update(fs.readFileSync(dst)).digest('hex'),
  });
  console.log('   → ' + f.file + '  ' + (out.size / 1024).toFixed(0) + ' KB');
}
if (manifest.length) {
  const old = fs.existsSync(path.join(OUT, 'MANIFEST.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'MANIFEST.json'), 'utf8')) : [];
  const merged = [...old.filter((o) => !manifest.some((m) => m.id === o.id)), ...manifest];
  fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify({ generatedAt: new Date().toISOString(), chars: [...chars].length, fonts: merged }, null, 1));
  console.log('MANIFEST.json 已写');
}
