// ROCm 架构覆盖表的护栏（2026-11-20）。
//
// 背景：`torch.version.hip` 非空只证明装的是 ROCm 版 torch，不证明这颗卡的 kernel 在包里。
// 当前 rocm_sdk_libraries_custom-7.2.0 实测只有 7 个 gfx；RX 6000/5000 与老核显不在其中
// （FlowHMR-Windows 用 AMD TheRock 的架构包补这部分）。
// 这张表用于「安装后校验失败时给出可操作原因」，并配合 gpu-ipc 的真实 matmul 对拍。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../../main/gpu-arch.js');

test('normalizeGfx：从 gcnArchName 提取架构，脏值返回空串', () => {
  assert.equal(A.normalizeGfx('gfx1100:sramecc+:xnack-'), 'gfx1100');
  assert.equal(A.normalizeGfx('GFX1201'), 'gfx1201');
  assert.equal(A.normalizeGfx('gfx1030'), 'gfx1030');
  assert.equal(A.normalizeGfx(''), '');
  assert.equal(A.normalizeGfx(null), '');
  assert.equal(A.normalizeGfx('AMD Radeon RX 7900 XTX'), '', '型号名里没有 gfx 时不能瞎猜');
  assert.equal(A.normalizeGfx('sm_86'), '');
});

test('ROCM_GFX_72：7 个架构、无重复、覆盖 RX 9000/7000 与 800M 核显', () => {
  assert.equal(A.ROCM_GFX_72.length, 7);
  assert.equal(new Set(A.ROCM_GFX_72).size, 7);
  for (const g of ['gfx1201', 'gfx1200', 'gfx1100', 'gfx1101', 'gfx1102', 'gfx1150', 'gfx1151']) {
    assert.ok(A.ROCM_GFX_72.includes(g), '缺 ' + g);
  }
  // 已知不在 7.2 包里的老架构，不能被误加进来（加进来就说明表与实测 wheel 脱节）
  for (const g of ['gfx1030', 'gfx1031', 'gfx1032', 'gfx1034', 'gfx1010', 'gfx1012', 'gfx1036', 'gfx1103']) {
    assert.ok(!A.ROCM_GFX_72.includes(g), g + ' 不在 7.2 的 libraries_custom 里，不应列入支持表');
  }
});

test('rocmGfxSupported：支持 true / 不支持 false / 信息不足 null', () => {
  assert.equal(A.rocmGfxSupported('gfx1100'), true);
  assert.equal(A.rocmGfxSupported('gfx1100:sramecc+:xnack-'), true);
  assert.equal(A.rocmGfxSupported('gfx1030'), false);
  assert.equal(A.rocmGfxSupported('gfx1103'), false);
  assert.equal(A.rocmGfxSupported(''), null, '读不到架构时是「未知」，不能判 false');
  assert.equal(A.rocmGfxSupported(null), null);
  assert.equal(A.rocmGfxSupported('gfx1100', ['gfx1100']), true, '支持传入自定义表');
});

test('rocmGfxHint：老卡提示带架构名、系列名与 TheRock 方向', () => {
  const h = A.rocmGfxHint('gfx1030');
  assert.match(h, /gfx1030/);
  assert.match(h, /RX 6800/);
  assert.match(h, /TheRock/);
  assert.match(h, /CPU/);
  assert.match(A.rocmGfxHint('gfx1100'), /算子校验未通过/, '支持的架构应提示是算子问题而非架构问题');
  assert.match(A.rocmGfxHint(''), /gcnArchName/);
});
