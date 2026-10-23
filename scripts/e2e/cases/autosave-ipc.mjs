// E2E：P0-2 自动保存草稿的 IPC 链（preload → main/project.js → main/autosave.js → 磁盘）。
// 不依赖 30s 定时器：直接走 bridge 的 write/list/read/clear，验证三处同改真的通了、数据能原样往返。
export default async function (app) {
  await app.waitFor("!!(window.__fufumidiE2E)", { timeout: 20000, message: "E2E 测试钩子已注册" });
  const out = await app.eval(`(async () => {
    const p = window.fuBridge.project;
    const docId = "e2e-autosave-" + Date.now();
    const model = { midi: [77, 84, 104, 100, 0, 0], tpb: 480, name: "E2E 草稿" };
    const w = await p.autosaveWrite({ docId, model, meta: { kind: "edit", title: "E2E 草稿" } });
    const list = await p.autosaveList();
    const hit = (list || []).find((x) => x.docId === docId);
    const r = await p.autosaveRead(docId);
    const c = await p.autosaveClear(docId);
    const list2 = await p.autosaveList();
    return JSON.stringify({
      wrote: !!(w && w.ok), path: (w && w.path) || "", bytes: (w && w.bytes) || 0,
      listed: !!hit, metaTitle: hit ? hit.meta.title : "",
      readOk: !!(r && r.ok), dataBack: r && r.data ? r.data.midi.join(",") : "",
      cleared: !!(c && c.removed),
      goneFromList: !(list2 || []).some((x) => x.docId === docId),
    });
  })()`);
  const r = JSON.parse(out);
  app.assert(r.wrote, "autosave:write 成功落盘");
  app.assert(r.bytes > 0 && r.path.endsWith(".json"), "拿到草稿路径与字节数");
  app.assert(r.listed, "autosave:list 能看到刚写的草稿");
  app.assert(r.metaTitle === "E2E 草稿", "meta 原样往返");
  app.assert(r.readOk && r.dataBack === "77,84,104,100,0,0", "autosave:read 数据原样往返");
  app.assert(r.cleared && r.goneFromList, "autosave:clear 后从列表消失");
}