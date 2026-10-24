// 校验 app.asar 是否自洽：逐文件按 header 声明的 offset 取出内容，比对 integrity 哈希。
// 6.2.3 首次构建就是因为包内有一个"打包时仍在增长"的日志文件，导致其后所有偏移错位。
const fs = require('fs');
const crypto = require('crypto');

const p = process.argv[2] || 'release/win-unpacked/resources/app.asar';
const raw = fs.readFileSync(p);
const b = raw.readUInt32LE(4);
const jsonlen = raw.readUInt32LE(12);
const hdr = JSON.parse(raw.toString('utf8', 16, 16 + jsonlen));
const base = 8 + b;

let ok = 0;
const bad = [];
const zero = [];
const walk = (node, prefix) => {
  for (const [name, e] of Object.entries(node.files || {})) {
    if (e.files) { walk(e, prefix + name + '/'); continue; }
    if (e.unpacked) continue;
    if (!e.integrity || !e.integrity.hash) continue;
    if (!e.size) { zero.push(prefix + name); continue; }
    const off = base + parseInt(e.offset, 10);
    const got = crypto.createHash('sha256').update(raw.subarray(off, off + e.size)).digest('hex');
    if (got === e.integrity.hash) ok++; else bad.push(prefix + name);
  }
};
walk(hdr, '');

console.log('asar =', p);
console.log('大小 MB =', (raw.length / 1048576).toFixed(1));
console.log('校验通过 =', ok, ' 不一致 =', bad.length, ' 零字节文件 =', zero.length);
if (bad.length) {
  console.log('不一致清单（前 10）:');
  for (const x of bad.slice(0, 10)) console.log('  !', x);
}
// 顺带确认版本
try {
  const pj = JSON.parse(raw.toString('utf8', base + parseInt(hdr.files['package.json'].offset, 10),
    base + parseInt(hdr.files['package.json'].offset, 10) + hdr.files['package.json'].size));
  console.log('asar 内 version =', pj.version);
} catch (e) {
  console.log('package.json 读取失败:', e.message);
}
console.log('判定:', bad.length === 0 ? 'PASS（asar 自洽）' : 'FAIL（asar 偏移损坏）');
process.exit(bad.length === 0 ? 0 : 1);
