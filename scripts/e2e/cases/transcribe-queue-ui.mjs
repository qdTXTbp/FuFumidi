// E2E：转录队列「产物歌单」+「识别片段长度」UI 与持久化（2026-10-18 用户需求）
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

  const target = await app.eval('(() => { const w = document.querySelector("[data-guide=queue-playlist]"); const s = w && w.querySelector("select"); return { has: !!w, hasSelect: !!s, disabled: !!(s && s.disabled), options: s ? [...s.options].map(o => ({ v: o.value, t: o.textContent.trim() })) : [] }; })()');
  app.assert(target.has && target.hasSelect, '队列有「产物歌单」下拉：' + JSON.stringify(target));
  app.assert(target.options.some((o) => o.t === '跟随当前歌单') && target.options.some((o) => o.t === '仅加入全部曲目'), '歌单选项完整：' + JSON.stringify(target.options));
  app.assert(target.options.some((o) => o.v === 'default'), '包含实际歌单选项：' + JSON.stringify(target.options));

  await app.eval('(() => { const s = document.querySelector("[data-guide=queue-playlist] select"); s.value = "default"; s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()');
  await new Promise((r) => setTimeout(r, 300));
  const persisted = await app.eval('(() => { try { const d = JSON.parse(localStorage.getItem("fufumidi_queues_v1") || "{}"); const active = d.active; const q = (d.queues || []).find(x => x.id === active) || (d.queues || [])[0]; return q ? q.playlistTarget : null; } catch (e) { return "ERR:" + e.message; } })()');
  app.assert(persisted === 'default', '产物歌单已持久化到队列：' + persisted);
  const hint = await app.eval('(() => { const e = document.querySelector(".tr-queues"); return e ? e.innerText : ""; })()');
  app.assert(hint.indexOf('本队列') >= 0, '队列摘要显示产物歌单');

  const seg = await app.eval('(() => { const w = document.querySelector("[data-guide=segment-sec]"); const r = w && w.querySelector("input[type=range]"); return { has: !!w, hasRange: !!r, text: w ? w.innerText.slice(0, 160) : "" }; })()');
  app.assert(seg.has && seg.hasRange, '有「识别片段长度」滑条控件：' + JSON.stringify(seg));
  app.assert(seg.text.indexOf('识别片段长度') >= 0 || seg.text.indexOf('Recognition segment length') >= 0, '控件标题正确：' + seg.text);

  await app.eval('(() => { const r = document.querySelector("[data-guide=segment-sec] input[type=range]"); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; setter.call(r, "5"); r.dispatchEvent(new Event("input", { bubbles: true })); r.dispatchEvent(new Event("change", { bubbles: true })); return true; })()');
  await new Promise((r) => setTimeout(r, 300));
  const segText = await app.eval('(() => document.querySelector("[data-guide=segment-sec]").innerText)()');
  app.assert(/5\s*s/.test(segText) || segText.indexOf('5s') >= 0, '片段长度滑条显示 5s：' + segText.slice(0, 120));

  // 降噪选项（默认「关闭」）与显存策略（默认「自动」）
  const denoise = await app.eval('(() => { const w=document.querySelector("[data-guide=denoise-mode]"); const s=w&&w.querySelector("select"); return { has: !!w, value: s?s.value:"", opts: s?[...s.options].map(o=>o.value):[] }; })()');
  app.assert(denoise.has && denoise.value === 'off', '降噪默认关闭：' + JSON.stringify(denoise));
  app.assert(denoise.opts.includes('off') && denoise.opts.includes('light') && denoise.opts.includes('strong'), '降噪三个档位齐全');
  const mem = await app.eval('(() => { const w=document.querySelector("[data-guide=memory-mode]"); const s=w&&w.querySelector("select"); return { has: !!w, value: s?s.value:"", opts: s?[...s.options].map(o=>o.value):[] }; })()');
  app.assert(mem.has && mem.opts.includes('auto') && mem.opts.includes('low') && mem.opts.includes('allow'), '显存策略选项齐全：' + JSON.stringify(mem));
  const chain = await app.eval('(() => { const c=document.querySelector("[data-guide=chain-queues] input"); return c ? c.checked : null; })()');
  app.assert(chain === false, '顺序转录默认关');

  const addBtn = await app.eval('(() => [...document.querySelectorAll(".tr-queues button")].some(b => (b.innerText || "").indexOf("新建队列") >= 0))()');
  app.assert(addBtn, '有「新建队列」按钮（运行中也允许新建，见代码注释）');
  await app.screenshot('transcribe-queue-ui');
  app.assert(true, '转录队列产物歌单 / 识别片段长度 UI + 持久化通过');
}
