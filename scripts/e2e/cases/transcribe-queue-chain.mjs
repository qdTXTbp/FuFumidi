// E2E：运行中切换队列 + 按队列顺序依次转录（2026-10-18 用户需求）
// 用 hook window.__fufumidiTranscribe 绕过原生文件对话框，真实跑 engine；两段短音频。
import fs from 'node:fs';
import path from 'node:path';

function makeWav(seconds, freq) {
  const sr = 22050;
  const n = Math.round(sr * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin(2 * Math.PI * freq * i / sr) * 0.25 * 32767);
    data.writeInt16LE(v, i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

export default async function (app) {
  const dir = path.resolve('scripts/e2e/artifacts/tmp');
  fs.mkdirSync(dir, { recursive: true });
  const wavA = path.join(dir, 'e2e-chain-a.wav');
  const wavB = path.join(dir, 'e2e-chain-b.wav');
  fs.writeFileSync(wavA, makeWav(2.0, 440));
  fs.writeFileSync(wavB, makeWav(2.0, 523.25));

  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000 });
  for (let i = 0; i < 12; i++) {
    if (await app.eval('location.hash.indexOf("transcribe") >= 0')) break;
    await app.eval("location.hash = '#/transcribe'; true");
    await new Promise((r) => setTimeout(r, 250));
  }
  await app.waitFor('!!window.__fufumidiTranscribe', { timeout: 20000, message: '转录 E2E 钩子出现' });

  // 重置为单队列（避免上次残留数据影响断言）
  await app.eval("localStorage.removeItem('fufumidi_queues_v1'); location.reload(); true");
  await app.waitFor('!!window.__fufumidiTranscribe', { timeout: 30000, message: '重载后钩子出现' });
  await new Promise((r) => setTimeout(r, 500));

  // 新建第二个队列（默认队列改名不影响；直接点新建）
  await app.eval("[...document.querySelectorAll('.tr-queues button')].find(b => (b.innerText||'').indexOf('新建队列')>=0).click(); true");
  await app.waitFor('!!document.querySelector("#global-prompt-input")', { timeout: 10000, message: '新建队列输入框出现' });
  await app.eval("(() => { const i = document.querySelector('#global-prompt-input'); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(i, 'E2E 队列 B'); i.dispatchEvent(new Event('input', { bubbles: true })); const foot = document.querySelector('.ed-modal-foot'); [...foot.querySelectorAll('button')].pop().click(); return true; })()");
  await new Promise((r) => setTimeout(r, 400));
  let st = await app.eval('JSON.stringify(window.__fufumidiTranscribe.state())');
  st = JSON.parse(st);
  app.assert(Array.isArray(st.queues) && st.queues.length === 2, '已新建第二个队列：' + st.queues.length);
  const qB = st.queues.find((q) => q.name.indexOf('E2E 队列 B') >= 0);
  app.assert(!!qB, '队列 B 存在');
  // 当前激活是新队列 B → 加 B 的音频
  await app.eval('window.__fufumidiTranscribe.addPaths(' + JSON.stringify([wavB]) + '); true');

  // 队列 B 的产物歌单设为「默认歌单」（验证每个队列各自的目标）
  await app.eval("(() => { const s=document.querySelector('[data-guide=queue-playlist] select'); s.value='default'; s.dispatchEvent(new Event('change',{bubbles:true})); return s.value; })()");
  await new Promise((r) => setTimeout(r, 200));
  // 切回第一个队列，加 A 的音频；A 设为「仅全部曲目」
  const qA = st.queues.find((q) => q.id !== qB.id);
  app.assert(!!qA, '默认队列存在');
  await app.eval("(() => { const b=[...document.querySelectorAll('.tr-queues .tr-pill')].find(x=>x.innerText.indexOf('E2E 队列 B')<0); b.click(); return true; })()");
  await new Promise((r) => setTimeout(r, 300));
  await app.eval("(() => { const s=document.querySelector('[data-guide=queue-playlist] select'); s.value='all'; s.dispatchEvent(new Event('change',{bubbles:true})); return s.value; })()");
  await new Promise((r) => setTimeout(r, 200));
  await app.eval('window.__fufumidiTranscribe.addPaths(' + JSON.stringify([wavA]) + '); true');

  // 打开顺序转录（默认关 → 用户显式开启）
  await app.eval("(() => { const c=document.querySelector('[data-guide=chain-queues] input'); if (!c.checked) c.click(); return c.checked; })()");
  await new Promise((r) => setTimeout(r, 200));
  st = JSON.parse(await app.eval('JSON.stringify(window.__fufumidiTranscribe.state())'));
  app.assert(st.chainMode === true, '顺序转录开关已打开');

  // 启动（不 await 完成，以便在运行中切换视图）
  await app.eval('window.__fufumidiTranscribe.runBatch(); true');
  await app.waitFor('window.__fufumidiTranscribe.state().running === true', { timeout: 15000, message: '转录已启动' });
  const during = JSON.parse(await app.eval('JSON.stringify(window.__fufumidiTranscribe.state())'));
  app.assert(during.runningQueueId !== 0, '运行队列 id 已设置');
  const runQid = during.runningQueueId;
  // 运行中点另一个队列 → 只切视图、不打断
  const other = during.queues.find((q) => q.id !== runQid);
  await app.eval("(() => { const b=[...document.querySelectorAll('.tr-queues .tr-pill')].find(x=>x.innerText.indexOf('E2E 队列 B')>=0); if (b) b.click(); return true; })()");
  await new Promise((r) => setTimeout(r, 300));
  const switched = JSON.parse(await app.eval('JSON.stringify(window.__fufumidiTranscribe.state())'));
  app.assert(switched.running === true && switched.runningQueueId === runQid, '运行中切换视图不打断运行队列');
  app.assert(switched.activeQid !== runQid, '视图已切到另一个队列');

  await app.waitFor('window.__fufumidiTranscribe.state().running === false', { timeout: 180000, message: '顺序转录完成' });
  const final = JSON.parse(await app.eval('JSON.stringify(window.__fufumidiTranscribe.state())'));
  const doneA = (final.queues.find((q) => q.id === runQid)?.items || []).filter((i) => i.status === 'done').length;
  const doneB = (final.queues.find((q) => q.id !== runQid)?.items || []).filter((i) => i.status === 'done').length;
  app.assert(doneA >= 1 && doneB >= 1, '两个队列都完成了转录：A=' + doneA + ' B=' + doneB);
  // 产物歌单：A=仅全部曲目，B=默认歌单 → 全部曲目 2 首、默认歌单 1 首
  const counts = await app.eval("(() => { const lis=[...document.querySelectorAll('.pl-item')]; const all=lis.find(x=>x.innerText.indexOf('全部曲目')>=0); const def=lis.find(x=>x.innerText.indexOf('默认歌单')>=0); return { all: all ? (all.querySelector('em')||{}).textContent : '', def: def ? (def.querySelector('em')||{}).textContent : '' }; })()");
  app.assert(String(counts.all) === '2', '全部曲目应有 2 首：' + JSON.stringify(counts));
  app.assert(String(counts.def) === '1', '默认歌单应有 1 首（B 的产物）：' + JSON.stringify(counts));
  await app.screenshot('transcribe-queue-chain');
  app.assert(true, '运行中切换队列 + 顺序转录通过');
}
