// E2E：P0-4c 分轨导出打包 ZIP —— 转换页开关可见 + 主进程一次写出多文件 ZIP
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { encodeMidi } from '../../../frontend/src/core/midi.js';
const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

const MINI = Array.from(encodeMidi([{
  name: 'E2E Stems', ch: 0, program: 0,
  notes: [{ start: 0, end: 480, midi: 60, vel: 100, ch: 0 }], ccs: [], events: [],
}], { division: 480 }));

export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000 });
  if (!(await app.eval('!!window.__fufumidiE2E.hasSong()'))) {
    await app.eval("window.__fufumidiE2E.importMidi('e2e-stems.mid', " + JSON.stringify(MINI) + ")");
    await app.waitFor('!!window.__fufumidiE2E.hasSong()', { timeout: 20000 });
  }
  await app.navigate('#/convert');
  await app.waitFor('!!document.querySelector("[data-guide=export-stems]")', { timeout: 30000, message: '分轨开关出现' });
  await app.eval("document.querySelector('[data-guide=export-stems]').click()");
  await app.waitFor('!!document.querySelector("[data-guide=export-stems-zip]")', { timeout: 30000, message: '分轨打包开关出现' });
  app.assert(await app.eval("document.querySelector('[data-guide=export-stems-zip]').checked === true"), '默认打包为一个 ZIP');

  const tmp = path.join(os.tmpdir(), 'fufumidi-e2e-stems-' + Date.now() + '.zip');
  const wav = Buffer.alloc(64, 1);
  const payload = {
    files: [
      { name: 'E2E_Lead_stem.wav', bytes: Array.from(wav) },
      { name: 'E2E_Chords_stem.wav', bytes: Array.from(wav) },
    ],
    suggestedName: 'e2e_stems.zip',
    targetPath: tmp,
  };
  const res = await app.eval('window.fuBridge.exportStemsZip(' + JSON.stringify(payload) + ')');
  try {
    app.assert(res && res.ok === true && res.count === 2, '打包返回两轨：' + JSON.stringify(res));
    app.assert(fs.existsSync(tmp), 'ZIP 已落盘');
    const zip = new AdmZip(tmp);
    const names = zip.getEntries().map((e) => e.entryName).sort();
    app.assert(names.length === 2 && names.some((n) => n.includes('Lead')) && names.some((n) => n.includes('Chords')), 'ZIP 内含两轨：' + names.join(','));
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
  await app.screenshot('stems-zip');
  app.assert(true, '分轨 ZIP 导出通过');
}
