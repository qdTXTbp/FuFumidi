// E2E：P2-5 DAWproject 导出 —— 转换页入口可见 + 主进程 ZIP 落盘（project.xml/metadata.xml）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { encodeMidi } from '../../../frontend/src/core/midi.js';
const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

const MINI = Array.from(encodeMidi([{
  name: 'E2E DAWproject', ch: 0, program: 0,
  notes: [
    { start: 0, end: 480, midi: 60, vel: 100, ch: 0 },
    { start: 480, end: 960, midi: 64, vel: 90, ch: 0 },
  ], ccs: [], events: [],
}], { division: 480 }));

export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 测试钩子已注册' });
  if (!(await app.eval('!!window.__fufumidiE2E.hasSong()'))) {
    await app.eval("window.__fufumidiE2E.importMidi('e2e-dawproject.mid', " + JSON.stringify(MINI) + ")");
    await app.waitFor('!!window.__fufumidiE2E.hasSong()', { timeout: 20000 });
  }
  await app.navigate('#/convert');
  await app.waitFor('!!document.querySelector("[data-guide=export-dawproject]")', { timeout: 30000, message: 'DAWproject 导出按钮出现' });
  const disabled = await app.eval("document.querySelector('[data-guide=export-dawproject]').disabled");
  app.assert(disabled === false, '有曲目时按钮可用');

  const tmp = path.join(os.tmpdir(), 'fufumidi-e2e-dawproject-' + Date.now() + '.dawproject');
  const projectXml = '<?xml version="1.0" encoding="UTF-8"?>\n<Project version="1.0"><Application name="FuFumidi" version="6.0.0"/></Project>';
  const metaXml = '<?xml version="1.0" encoding="UTF-8"?>\n<MetaData><Title>E2E</Title></MetaData>';
  const payload = {
    files: [{ name: 'project.xml', data: projectXml }, { name: 'metadata.xml', data: metaXml }],
    suggestedName: 'e2e.dawproject',
    filePath: tmp,
  };
  const res = await app.eval('window.fuBridge.exportDawproject(' + JSON.stringify(payload) + ')');
  try {
    app.assert(res && res.ok === true, '导出返回 ok：' + JSON.stringify(res));
    app.assert(fs.existsSync(tmp), 'ZIP 已落盘：' + tmp);
    const zip = new AdmZip(tmp);
    app.assert(!!zip.getEntry('project.xml'), '包内有 project.xml');
    app.assert(!!zip.getEntry('metadata.xml'), '包内有 metadata.xml');
    const text = zip.readAsText('project.xml');
    app.assert(text.includes('<Application name="FuFumidi"'), 'project.xml 内容正确');
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
  await app.screenshot('dawproject-ui');
  app.assert(true, 'DAWproject 导出通过');
}
