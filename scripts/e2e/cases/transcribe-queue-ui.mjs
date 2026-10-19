// E2E：转录队列「产物歌单」+「识别片段长度」UI（2026-10-18 用户需求）
export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000 });
  for (let i = 0; i < 12; i++) {
    const ok = await app.eval('location.hash.indexOf("transcribe") >= 0');
    if (ok) break;
    await app.eval("location.hash = '#/transcribe'; true");
    await new Promise((r) => setTimeout(r, 250));
  }
  await app.waitFor('location.hash.indexOf("transcribe") >= 0', { timeout: 20000, message: '路由到转录页' });
  await app.waitFor('!!document.querySelector(".tr-queues")', { timeout: 20000, message: '转录队列区出现' });

  const target = await app.eval('(() => { const w = document.querySelector("[data-guide=queue-playlist]"); const s = w && w.querySelector("select"); return { has: !!w, hasSelect: !!s, disabled: !!(s && s.disabled), options: s ? [...s.options].map(o => o.textContent.trim()) : [] }; })()');
  app.assert(target.has && target.hasSelect, '队列有「产物歌单」下拉：' + JSON.stringify(target));
  app.assert(target.options.includes('跟随当前歌单') && target.options.includes('仅加入全部曲目'), '歌单选项完整：' + JSON.stringify(target.options));
  app.assert(target.options.some((x) => /默认歌单|Default|プレイリスト/.test(x)), '包含实际歌单选项：' + JSON.stringify(target.options));

  const seg = await app.eval('(() => { const w = document.querySelector("[data-guide=segment-sec]"); return { has: !!w, text: w ? w.innerText.slice(0, 120) : "" }; })()');
  app.assert(seg.has, '有「识别片段长度」控件');
  app.assert(seg.text.indexOf('识别片段长度') >= 0 || seg.text.indexOf('Recognition segment length') >= 0, '控件标题正确：' + seg.text);

  // 新建队列按钮在运行中也不应报错（这里只断言按钮存在且可点；不启动真实转录）
  const addBtn = await app.eval('(() => [...document.querySelectorAll(".tr-queues button")].some(b => (b.innerText || "").indexOf("新建队列") >= 0))()');
  app.assert(addBtn, '有「新建队列」按钮');
  await app.screenshot('transcribe-queue-ui');
  app.assert(true, '转录队列产物歌单 / 识别片段长度 UI 通过');
}
