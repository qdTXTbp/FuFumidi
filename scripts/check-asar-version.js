// 检查打包产物 app.asar 内的版本号字符串
const asar = require('d:/FuFuMIDI/FuFumidi/node_modules/@electron/asar');

const asarPath = 'd:/FuFuMIDI/FuFumidi/release/win-unpacked/resources/app.asar';

const list = asar.listPackage(asarPath);
const candidates = list.filter(p => p.replace(/\\/g, '/').includes('renderer/dist/assets') && p.endsWith('.js'));

for (const p of candidates) {
  try {
    const buf = asar.extractFile(asarPath, p);
    if (!buf) { console.log('no buf:', p); continue; }
    const txt = buf.toString('utf8');
    const hits = txt.match(/v?3\.1\.0|v?3\.0\.0/g);
    if (hits) console.log(`FOUND in ${p}:`, [...new Set(hits)].join(', '));
  } catch (e) { console.log('err', p, e.message); }
}
console.log('scan complete');
