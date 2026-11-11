#!/usr/bin/env node
// ============================================================
// 生成热补丁：把工作区里改过的几个小文件打成一个 zip + 签名清单。
// 产物 push 到仓库 patches/ 目录即生效 —— 不建 release、不 bump 版本。
//
// 用法：
//   node scripts/build-hotpatch.mjs \
//     --id 2026-11-11-01 \
//     --files engine/audio_io.py,engine/engine_muscriptor.py \
//     --notes "修 xxx" --min 6.4.0 --max 6.4.99 \
//     --key E:/ed25519-private.pem --out release/hotpatch
//
//   --map "目标相对路径=源路径" 可显式指定映射（可重复）。
//   自动映射见 mapSourceToTarget()。
// 输出：hotpatch.json、hotpatch-<id>.zip、README.txt
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const HM = require('../main/hotpatch_manifest.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, def = '') {
  const vals = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--' + name && i + 1 < process.argv.length) vals.push(process.argv[++i]);
  }
  return vals.length ? vals : [def];
}
const one = (name, def = '') => arg(name, def)[0];

/** 工作区源文件 → 安装目录内可覆盖的真实文件 */
function mapSourceToTarget(src) {
  const s = src.replace(/\\/g, '/');
  if (s.startsWith('resources/app.asar.unpacked/')) return s;
  if (s.startsWith('engine/')) return 'resources/app.asar.unpacked/' + s;
  if (s.startsWith('renderer/dist/vendor/js-synth/')) return 'resources/app.asar.unpacked/' + s;
  if (s.startsWith('renderer/vendor/soundfonts/')) return 'resources/app.asar.unpacked/' + s;
  throw new Error('无法推断目标路径（请用 --map 显式指定）：' + src);
}

const id = one('id', new Date().toISOString().slice(0, 10) + '-01');
const notes = one('notes', '');
const min = one('min', '');
const max = one('max', '');
const outDir = path.resolve(one('out', 'release/hotpatch'));
const keyPath = one('key', process.env.FUFUMIDI_UPDATE_KEY || 'E:/ed25519-private.pem');
if (!fs.existsSync(keyPath)) {
  console.error('私钥不存在：' + keyPath + '\n可用 --key 或 FUFUMIDI_UPDATE_KEY 指定');
  process.exit(2);
}

// 收集映射
const pairs = [];
for (const f of one('files', '').split(',').map((x) => x.trim()).filter(Boolean)) {
  pairs.push([mapSourceToTarget(f), f]);
}
for (const m of arg('map', '')) {
  if (!m) continue;
  const i = m.indexOf('=');
  if (i <= 0) throw new Error('--map 需要 "目标=源" 格式：' + m);
  pairs.push([m.slice(0, i).replace(/\\/g, '/'), m.slice(i + 1)]);
}
if (!pairs.length) {
  console.error('没有文件：用 --files engine/xxx.py,... 或 --map "目标=源"');
  process.exit(2);
}

const zip = new AdmZip();
const files = [];
const seen = new Set();
for (const [rel, src] of pairs) {
  const v = HM.validateRelPath(rel);
  if (!v.ok) throw new Error('目标路径不合法：' + rel + '（' + v.reason + '）');
  if (seen.has(v.rel)) throw new Error('重复目标路径：' + v.rel);
  seen.add(v.rel);
  const abs = path.resolve(ROOT, src);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('源文件不存在：' + abs);
  const buf = fs.readFileSync(abs);
  if (buf.length > HM.MAX_FILE_BYTES) throw new Error('单个文件超过上限：' + src);
  zip.addFile(v.rel, buf);
  files.push({ path: v.rel, size: buf.length, sha256: HM.sha256Buffer(buf) });
}
files.sort((a, b) => a.path.localeCompare(b.path));

const zipName = 'hotpatch-' + id + '.zip';
fs.mkdirSync(outDir, { recursive: true });
const zipPath = path.join(outDir, zipName);
zip.writeZip(zipPath);
const zipBuf = fs.readFileSync(zipPath);
if (zipBuf.length > HM.MAX_PACKAGE_BYTES) throw new Error('补丁包超过上限，请拆分或改走完整发版');

const manifest = HM.signHotpatch({
  format: HM.FORMAT,
  id,
  notes,
  target: { min, max },
  package: { name: zipName, size: zipBuf.length, sha256: HM.sha256Buffer(zipBuf) },
  files,
}, fs.readFileSync(keyPath, 'utf8'));

// 默认用内嵌公钥自校验；--pub 只给「临时密钥跑单元/自建密钥」场景用。
const selfPub = one('pub', '');
const check = HM.verifyHotpatch(manifest, selfPub ? { publicKeyB64: selfPub } : {});
if (!check.ok) throw new Error('自校验失败：' + check.error);

const manifestPath = path.join(outDir, 'hotpatch.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(outDir, 'README.txt'), [
  '热补丁产物',
  '==========',
  '把 hotpatch.json 与 ' + zipName + ' 一起 push 到仓库的 patches/ 目录（master 分支）。',
  '客户端启动后会自动拉取、验签并覆盖；不需要建 release / tag，也不需要 bump 版本号。',
  '',
  '固定地址（客户端按下载源设置多源回退）：',
  '  CNB    https://cnb.cool/FuFuCloud-mirror/FuFuMIDI/-/git/raw/master/patches/hotpatch.json',
  '  GitHub https://raw.githubusercontent.com/qdTXTbp/FuFumidi/master/patches/hotpatch.json',
  '',
  '适用版本：' + (min || '不限') + ' ~ ' + (max || '不限'),
  '文件：',
  ...files.map((f) => '  ' + f.path + '  (' + f.size + ' B)'),
  '',
  '撤回补丁：把 hotpatch.json 的 id 改回上一个已发布 id，或 push 一个空 files 的清单',
  '（构建工具不允许空清单，撤回请手工把 id 设为 retired 并重新签名，或直接在界面点回滚）。',
  '',
].join('\n'), 'utf8');

console.log('已生成：');
console.log('  ' + manifestPath);
console.log('  ' + zipPath + '  (' + zipBuf.length + ' B)');
console.log('  ' + path.join(outDir, 'README.txt'));
console.log('  id=' + id + '  files=' + files.length + '  sig ok');
