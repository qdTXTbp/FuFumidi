// 本轨独享效果链（Node 环境，用最小的 Web Audio 替身）。
//
// ★ 要验的四件事：
//   1. **脏参数不会变成 NaN** —— 工程文件可能被人手改过
//   2. **认不出的效果类型被丢弃**，而不是建出一个坏节点
//   3. **顺序即信号流顺序** —— 上下移动按钮改的是数组顺序，链必须跟着变
//   4. **关闭的效果不进链** —— 否则"关了还有声"最难排查
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FX_TYPES, FX_ORDER, makeFx, normalizeFx, buildFxChain, fxSummary } from '../src/core/track_fx.js';

/** 最小 ctx 替身：只记录连接关系，不真的处理音频 */
function makeCtx(withPan = true) {
  const links = [];
  const mkNode = (kind) => {
    const n = {
      kind, gain: { value: 1 }, pan: { value: 0 }, type: '', frequency: { value: 0 },
      Q: { value: 0 }, threshold: { value: 0 }, ratio: { value: 0 },
      attack: { value: 0 }, release: { value: 0 }, delayTime: { value: 0 }, buffer: null,
      connect(d) { links.push([kind, n._id, '→', d && d.kind, d && d._id]); return d; },
      disconnect() {},
    };
    n._id = links.length;
    return n;
  };
  const ctx = {
    sampleRate: 44100,
    _links: links,
    createGain: () => mkNode('gain'),
    createBiquadFilter: () => mkNode('biquad'),
    createConvolver: () => mkNode('convolver'),
    createDelay: () => mkNode('delay'),
    createDynamicsCompressor: () => mkNode('comp'),
    createStereoPanner: withPan ? () => mkNode('pan') : undefined,
    createBuffer: (ch, len) => ({
      numberOfChannels: ch, length: len,
      getChannelData: () => new Float32Array(len),
    }),
  };
  return ctx;
}

/* ------------------------------------------------------------ 注册表 */

test('注册表里的每个类型都有 label 与参数定义，且都在 FX_ORDER 里', () => {
  for (const id of FX_ORDER) {
    const d = FX_TYPES[id];
    assert.ok(d, 'FX_ORDER 里的 ' + id + ' 必须有定义');
    assert.ok(d.label, id + ' 缺 label');
    assert.ok(Array.isArray(d.params) && d.params.length, id + ' 缺参数定义');
    for (const p of d.params) {
      assert.ok(p.k && p.label, id + ' 的参数缺 k/label');
      if (p.kind === 'enum') assert.ok(Array.isArray(p.options));
      else assert.ok(typeof p.min === 'number' && typeof p.max === 'number', id + '.' + p.k + ' 缺范围');
    }
  }
  assert.deepEqual(Object.keys(FX_TYPES).sort(), FX_ORDER.slice().sort());
});

/* ------------------------------------------------------------ 归一化 */

test('超范围参数被夹住，NaN 退回默认值', () => {
  const out = normalizeFx([
    { id: 'a', type: 'gain', enabled: true, params: { gainDb: 999 } },
    { id: 'b', type: 'gain', enabled: true, params: { gainDb: 'not-a-number' } },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].params.gainDb, 24);
  assert.equal(out[1].params.gainDb, 0, 'NaN 应退回默认 0，绝不能进节点');
});

test('认不出的类型 / 非对象条目被丢弃', () => {
  const out = normalizeFx([
    { id: 'a', type: '不存在的效果', params: {} },
    null, 'junk', 42,
    { id: 'b', type: 'gain', params: {} },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'gain');
});

test('枚举参数只接受白名单里的值', () => {
  const out = normalizeFx([{ id: 'a', type: 'filter', params: { type: 'evil', freq: 1000 } }]);
  assert.equal(out[0].params.type, 'lowpass');
  const ok = normalizeFx([{ id: 'b', type: 'filter', params: { type: 'highpass' } }]);
  assert.equal(ok[0].params.type, 'highpass');
});

test('缺 params 时补默认值；enabled 缺失算开启', () => {
  const out = normalizeFx([{ id: 'a', type: 'eq3' }]);
  assert.equal(out[0].params.low, 0);
  assert.equal(out[0].params.mid, 0);
  assert.equal(out[0].enabled, true);
});

test('makeFx 带出默认参数并可直接入链', () => {
  const f = makeFx('reverb');
  assert.equal(f.type, 'reverb');
  assert.equal(f.enabled, true);
  assert.equal(f.params.mix, 0.25);
  assert.ok(f.id);
  assert.equal(makeFx('不存在'), null);
});

test('makeFx 可覆盖参数，但仍受范围约束', () => {
  const f = makeFx('gain', { params: { gainDb: 100 }, enabled: false });
  assert.equal(f.params.gainDb, 24);
  assert.equal(f.enabled, false);
});

/* ------------------------------------------------------------ 建链 */

test('空链 / 全关的链 → 没有节点可接', () => {
  const ctx = makeCtx();
  assert.equal(buildFxChain(ctx, []).input, null);
  const off = buildFxChain(ctx, [makeFx('gain', { enabled: false })]);
  assert.equal(off.input, null, '关掉的效果不该进链');
  assert.equal(off.nodes.length, 0);
});

test('★ 数组顺序就是信号流顺序（上下移动按钮改的是同一个数组）', () => {
  const ctx = makeCtx();
  const a = { ...makeFx('gain', { params: { gainDb: 6 } }), id: 'a' };
  const b = { ...makeFx('pan', { params: { pan: -0.5 } }), id: 'b' };
  const ab = buildFxChain(ctx, [a, b]);
  const ba = buildFxChain(ctx, [b, a]);

  // 两种顺序都要能建出链，且首尾节点类型随顺序反转
  assert.ok(ab.input && ab.output);
  assert.ok(ba.input && ba.output);
  assert.equal(ab.input.kind, 'gain');
  assert.equal(ba.input.kind, 'pan', '换序后入口应换成 pan');
});

test('多节点串联：入口是第一个，出口是最后一个', () => {
  const ctx = makeCtx();
  const chain = buildFxChain(ctx, [makeFx('eq3'), makeFx('comp'), makeFx('gain')]);
  assert.equal(chain.input.kind, 'biquad', 'eq3 的第一个节点是 biquad');
  assert.equal(chain.output.kind, 'gain');
  assert.ok(chain.nodes.length >= 3);
});

test('环境不支持的效果被跳过，而不是整条链失败', () => {
  const ctx = makeCtx(false);                  // 没有 createStereoPanner
  const chain = buildFxChain(ctx, [makeFx('pan'), makeFx('gain')]);
  assert.ok(chain.input, 'pan 不可用时应跳过它，gain 照常入链');
  assert.equal(chain.input.kind, 'gain');
});

test('混响会生成脉冲响应（长度与 seconds 成正比）', () => {
  const ctx = makeCtx();
  let buf = null;
  const realCreate = ctx.createBuffer;
  ctx.createBuffer = (ch, len) => { buf = { ch, len }; return realCreate(ch, len); };
  buildFxChain(ctx, [makeFx('reverb', { params: { seconds: 2 } })]);
  assert.ok(buf, '应该调用过 createBuffer');
  assert.equal(buf.len, 88200, '2 秒 × 44100');
});

/* ------------------------------------------------------------ 摘要 */

test('fxSummary 能看出挂了什么、哪个被关了', () => {
  assert.equal(fxSummary([]), '');
  assert.equal(fxSummary([makeFx('gain')]), '增益');
  assert.equal(fxSummary([makeFx('gain'), makeFx('reverb', { enabled: false })]), '增益 → ［关］混响');
});

test('多次归一化的结果是稳定的（不会越改越飘）', () => {
  const a = normalizeFx([{ id: 'x', type: 'delay', params: { mix: 0.5 } }]);
  const b = normalizeFx(a);
  assert.deepEqual(a, b);
});
