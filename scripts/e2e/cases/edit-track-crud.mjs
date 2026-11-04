// E2E：6.7 MIDI 轨道 CRUD —— 新建 / 改名 / 上移 / 删除 / 撤销重做。
// 断言直接读 __fufumidiE2E.song().tracks，避免只看 DOM 假象。
import { encodeMidi } from '../../../frontend/src/core/midi.js';

const MINI = Array.from(encodeMidi([{
  name: 'E2E Track CRUD', ch: 0, program: 0,
  notes: [
    { start: 0, end: 480, midi: 60, vel: 100, ch: 0 },
    { start: 480, end: 960, midi: 64, vel: 90, ch: 0 },
  ], ccs: [], events: [],
}], { division: 480 }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function (app) {
  const tracks = async () => JSON.parse(await app.eval(
    'JSON.stringify(((window.__fufumidiE2E.song() || { tracks: [] }).tracks || []).map((t) => ({ name: t.name, notes: (t.notes || []).length })))'));
  const waitCount = async (n, label) => {
    for (let i = 0; i < 40; i++) {
      if ((await tracks()).length === n) return true;
      await sleep(150);
    }
    throw new Error(label + '：轨道数应为 ' + n + '，实际 ' + (await tracks()).length);
  };

  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 钩子' });
  if (!(await app.eval('!!window.__fufumidiE2E.hasSong()'))) {
    await app.eval("window.__fufumidiE2E.importMidi('e2e-track-crud.mid', " + JSON.stringify(MINI) + ')');
    await app.waitFor('!!window.__fufumidiE2E.hasSong()', { timeout: 20000 });
  }
  await sleep(700);
  await app.navigate('#/edit');
  await app.waitFor('location.hash.indexOf("edit") >= 0 && !!document.querySelector("canvas")', { timeout: 30000, message: '编辑页' });

  // 打开检查器「轨道」页签
  const opened = await app.eval("(() => { const t = [...document.querySelectorAll('.insp-tab')].find((x) => (x.textContent || '').indexOf('轨道') >= 0); if (!t) return false; t.click(); return true; })()");
  app.assert(opened, '检查器有「轨道」页签');
  await app.waitFor("!!document.querySelector('[data-guide=track-add]')", { timeout: 15000, message: '轨道操作按钮出现' });

  const n0 = (await tracks()).length;
  app.assert(n0 >= 1, '有初始轨道：' + n0);

  // 新建
  await app.click('[data-guide=track-add]');
  await waitCount(n0 + 1, '新建后');
  const afterAdd = await tracks();
  const added = afterAdd[afterAdd.length - 1];
  app.assert(!!added && /轨道|Track/.test(added.name || ''), '新轨道有默认名：' + JSON.stringify(added));

  // 改名（promptDialog）
  await app.click('[data-guide=track-rename]');
  await app.waitFor("!!document.querySelector('#global-prompt-input')", { timeout: 10000, message: '改名对话框' });
  await app.eval("(() => { const i = document.querySelector('#global-prompt-input'); i.value = 'E2E 改名轨'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  await app.eval("(() => { const box = document.querySelector('#global-prompt-input').closest('.ed-modal-mask'); box.querySelector('button.btn.primary').click(); return true; })()");
  for (let i = 0; i < 30; i++) { if ((await tracks()).some((x) => x.name === 'E2E 改名轨')) break; await sleep(150); }
  app.assert((await tracks()).some((x) => x.name === 'E2E 改名轨'), '改名生效');

  // 上移
  await app.click('[data-guide=track-up]');
  await sleep(300);
  const moved = await tracks();
  app.assert(moved[moved.length - 2] && moved[moved.length - 2].name === 'E2E 改名轨', '上移后顺序正确：' + JSON.stringify(moved.map((x) => x.name)));

  // 删除
  await app.click('[data-guide=track-del]');
  await waitCount(n0, '删除后');
  app.assert(!(await tracks()).some((x) => x.name === 'E2E 改名轨'), '删除后名字消失');

  // 撤销恢复（全量快照要能重建 tracks）
  await app.key('Ctrl+Z');
  await waitCount(n0 + 1, '撤销后');
  app.assert((await tracks()).some((x) => x.name === 'E2E 改名轨'), '撤销恢复被删轨道');

  // 重做再删掉（本应用重做是 Ctrl+Y，不是 Ctrl+Shift+Z）
  await app.key('Ctrl+Y');
  await waitCount(n0, '重做后');
}
