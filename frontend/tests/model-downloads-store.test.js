// 跨页共享的下载状态（stores/modelDownloads）：资源中心与 App.vue 顶部条读同一份。
//
// 为什么值得单测：旧实现两份状态各自订阅；这个 store 若把「暂停」当失败、
// 或切页后丢状态，UI 不会抛异常，只会让用户以为下载丢了/失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { computed } from 'vue';

// ---- 桥 mock：modelDownload 挂起，便于模拟「下载中」时的事件与用户动作 ----
const listeners = [];
const calls = { downloads: [], pauses: [], cancels: [], msCancels: [] };
const pending = [];
const bridge = {
  onModelProgress: (cb) => { listeners.push(cb); return () => {}; },
  modelList: async () => [{ id: 'a', name: 'A 模型' }, { id: 'b', name: 'B 模型' }],
  modelDownload: (id, channel) => new Promise((resolve) => { calls.downloads.push([id, channel]); pending.push({ id, resolve }); }),
  modelPause: async (id) => { calls.pauses.push(id); return { ok: true, paused: true }; },
  modelCancel: async (id) => { calls.cancels.push(id); return { ok: true }; },
  diffsingerMsCancelDownload: async (name) => { calls.msCancels.push(name); return { ok: true }; },
};
globalThis.window = { fuBridge: bridge };

const { useModelDownloadStore } = await import('../src/stores/modelDownloads.ts');
const emit = (p) => listeners.forEach((cb) => cb(p));
const tick = () => new Promise((r) => setImmediate(r));

test('跨页共享：开始→进度→暂停→继续→完成，顶部条数据同步', async () => {
  setActivePinia(createPinia());
  const dl = useModelDownloadStore();
  dl.ensureEvents();
  dl.ensureEvents();                 // 幂等：不会重复订阅
  assert.equal(listeners.length, 1);
  dl.ensureNames();
  await tick();
  assert.equal(dl.nameOf('a'), 'A 模型');

  // 开始下载：store 立刻置 active（两处视图同时可见），modelDownload 挂起模拟真实下载
  const bar = computed(() => dl.barItems);   // 顶部条 / 资源中心都是对这个 getter 的响应式读取
  assert.equal(bar.value.length, 0);
  const startP = dl.start({ id: 'a', name: 'A 模型' });
  assert.equal(dl.prog.a.active, true);
  assert.equal(dl.prog.a.paused, false);
  assert.equal(bar.value.length, 1);         // 开始即出现在顶部条（无需等首个进度事件）

  // 进度事件（资源中心与顶部条读同一份 prog）
  emit({ id: 'a', received: 50, total: 100, percent: 50, done: false, active: true });
  assert.equal(dl.prog.a.percent, 50);
  assert.equal(bar.value.length, 1);
  assert.equal(bar.value[0].name, 'A 模型');
  assert.equal(bar.value[0].percent, 50);
  assert.equal(bar.value[0].canPause, true);

  // 暂停：乐观落暂停态（切页也保持），后端随后以 paused 返回
  const pauseP = dl.pause('a');
  assert.equal(dl.prog.a.paused, true);
  assert.equal(dl.prog.a.active, false);
  await pauseP;
  pending.shift().resolve({ ok: false, paused: true, error: '已暂停（断点已保留，继续时会接着下）' });
  await startP;
  assert.equal(dl.prog.a.paused, true);
  assert.equal(dl.prog.a.error, '');      // 暂停不是失败
  assert.equal(bar.value.length, 1);      // 暂停后条目仍在（可从任意页面继续）
  assert.equal(bar.value[0].paused, true);
  assert.equal(bar.value[0].percent, 50); // 进度冻结在暂停点，不跳回 0

  // 继续：同一个 modelDownload 重入，进度不跳回 0
  const resumeP = dl.start({ id: 'a', name: 'A 模型' });
  assert.equal(dl.prog.a.active, true);
  assert.equal(dl.prog.a.percent, 50);
  emit({ id: 'a', received: 100, total: 100, percent: 100, done: true, active: false });
  pending.shift().resolve({ ok: true });
  await resumeP;
  assert.equal(dl.prog.a.done, true);
  assert.equal(dl.barItems.length, 0);    // 完成才从条上消失
});

test('失败 / 取消：均从顶部条移除；取消不当作失败', async () => {
  setActivePinia(createPinia());
  const dl = useModelDownloadStore();

  const failP = dl.start({ id: 'b', name: 'B 模型' });
  pending.shift().resolve({ ok: false, error: '所有镜像下载失败' });
  await failP;
  assert.equal(dl.prog.b.error, '所有镜像下载失败');
  assert.equal(dl.barItems.length, 0);

  const cancelP = dl.start({ id: 'b', name: 'B 模型' });
  await dl.cancel('b');
  pending.shift().resolve({ ok: false, canceled: true });
  await cancelP;
  assert.equal(dl.prog.b.canceled, true);
  assert.equal(dl.prog.b.error, '');      // 取消不是失败
  assert.equal(dl.barItems.length, 0);
});

test('model_list.active 兜底 + DiffSinger 通道（不支持暂停、取消走独立通道）', async () => {
  setActivePinia(createPinia());
  const dl = useModelDownloadStore();

  // 刷新 model_list 时后端 active 兜底：本地没有记录才恢复成下载中
  dl.syncActive([{ id: 'a', active: true }, { id: 'c', active: false }]);
  assert.equal(dl.prog.a.active, true);
  assert.equal(dl.prog.c, undefined);

  // DiffSinger AI 声库（dsms:）：展示名用 label；不支持暂停；取消走独立通道
  dl.applyProgress({ id: 'dsms:x', label: 'AI 声库', percent: 10, done: false, active: true });
  const dsms = dl.barItems.find((x) => x.id === 'dsms:x');
  assert.equal(dsms.name, 'AI 声库');
  assert.equal(dsms.canPause, false);
  const r = await dl.pause('dsms:x');
  assert.deepEqual(r, { ok: false, unsupported: true });
  await dl.cancel('dsms:x');
  assert.deepEqual(calls.msCancels, ['x']);
  assert.equal(dl.prog['dsms:x'].canceled, true);
});
