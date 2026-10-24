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

  // 降噪选项（默认「关闭」）与显存策略（默认「自动」）
  const denoise = await app.eval('(() => { const w=document.querySelector("[data-guide=denoise-mode]"); const s=w&&w.querySelector("select"); return { has: !!w, value: s?s.value:"", opts: s?[...s.options].map(o=>o.value):[] }; })()');
  app.assert(denoise.has && denoise.value === 'off', '降噪默认关闭：' + JSON.stringify(denoise));
  app.assert(denoise.opts.includes('off') && denoise.opts.includes('light') && denoise.opts.includes('strong'), '降噪三个档位齐全');
  const mem = await app.eval('(() => { const w=document.querySelector("[data-guide=memory-mode]"); const s=w&&w.querySelector("select"); return { has: !!w, value: s?s.value:"", opts: s?[...s.options].map(o=>o.value):[] }; })()');
  app.assert(mem.has && mem.opts.includes('auto') && mem.opts.includes('low') && mem.opts.includes('allow'), '显存策略选项齐全：' + JSON.stringify(mem));
  const chain = await app.eval('(() => { const c=document.querySelector("[data-guide=chain-queues] input"); return c ? c.checked : null; })()');
  app.assert(chain === false, '顺序转录默认关');

  // ★ 2026-10-23：内置预设一律**不写**识别片段长度与其它分块键 —— 这就是
  //   「不强制开启」的机器保证（6.1.x 给每个模型都写了值，切模型就自动套上）。
  const presRaw = await app.eval('window.fuBridge.presets.list().then(r => JSON.stringify(r)).catch(e => "ERR:" + e.message)');
  let pres = null;
  try { pres = JSON.parse(presRaw); } catch (e) {}
  if (pres && pres.presets) {
    const NO_WRITE = ['segment_sec', 'segment_silence', 'probe_segment_sec', 'silence_db',
                      'min_silence', 'max_segment', 'segment_pad'];
    for (const n of Object.keys(pres.presets)) {
      const params = (pres.presets[n] && pres.presets[n].params) || {};
      for (const k of NO_WRITE) {
        app.assert(!(k in params), '预设 ' + n + ' 写了 ' + k + '（这会让它变成强制开启）');
      }
    }
    app.assert('Basic Pitch · 最优' in pres.presets, '内置预设仍齐全');
  } else {
    app.assert(false, 'presets.list 返回异常：' + String(presRaw).slice(0, 120));
  }
  // 分段探测档（probe_segments）必须仍然不存在（2026-10-21 移除后未恢复）
  const probeOpts = await app.eval('(() => JSON.stringify([...document.querySelectorAll("select option")].map(o => o.value).filter(v => v === "probe_segments")))()');
  app.assert(JSON.parse(probeOpts).length === 0, '自动探测（分段）档仍未恢复');


  // P2：驱动/共享显存检测 + 音色稳定开关 + 统一内存实验按钮
  await app.waitFor('!!document.querySelector("[data-guide=gpu-detail]")', { timeout: 30000, message: 'GPU 驱动检测信息出现' });
  const gpuDetail = await app.eval('(() => { const e=document.querySelector("[data-guide=gpu-detail]"); return e?e.innerText:""; })()');
  app.assert(gpuDetail.indexOf('驱动') >= 0 || gpuDetail.indexOf('Driver') >= 0, '驱动检测显示：' + gpuDetail.slice(0, 120));
  app.assert(gpuDetail.indexOf('共享显存回退') >= 0 || gpuDetail.indexOf('Shared-memory') >= 0, '共享显存回退状态显示：' + gpuDetail.slice(0, 160));
  const umBtn = await app.eval('(() => { const e=document.querySelector("[data-guide=unified-memory] button"); return e?e.innerText:""; })()');
  app.assert(!!umBtn && (umBtn.indexOf('统一内存') >= 0 || umBtn.indexOf('unified') >= 0), '统一内存实验按钮存在：' + umBtn);
  // 真的跑一次实验（E2E 数据根没有 GPU 增强包时预期 backend-missing；只要求 IPC 有明确结果）
  await app.eval('document.querySelector("[data-guide=unified-memory] button").click(); true');
  await app.waitFor('(() => { const e=document.querySelector("[data-guide=unified-memory] small"); return !!e && (e.innerText||"").length > 0; })()', { timeout: 60000, message: '统一内存实验结果返回' });
  const umRes = await app.eval('(() => { const e=document.querySelector("[data-guide=unified-memory] small"); return e?e.innerText:""; })()');
  app.assert(umRes.indexOf('统一内存') >= 0 || umRes.indexOf('Unified memory') >= 0, '统一内存实验有结果：' + umRes.slice(0, 160));

  const addBtn = await app.eval('(() => [...document.querySelectorAll(".tr-queues button")].some(b => (b.innerText || "").indexOf("新建队列") >= 0))()');
  app.assert(addBtn, '有「新建队列」按钮（运行中也允许新建，见代码注释）');
  await app.screenshot('transcribe-queue-ui');
  app.assert(true, '转录队列产物歌单 / 识别片段长度 UI + 持久化通过');
}
