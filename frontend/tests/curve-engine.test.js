// P1-13 B3 曲线引擎：点运算 + MIDI 弯音换算
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePoints, clampPoints, insertPoint, removePoint, movePoint, valueAt,
  simplifyPoints, quantizePoints, smoothPoints, scalePoints, mergePoints,
  bendToUnit, unitToBend, bendToCents, centsToBend, bendNorm, isBendCenter,
} from '../src/core/curve_engine.js';

test('P1-13 点列表：排序 + 同 beat 去重（保留后者）', () => {
  const p = normalizePoints([{ beat: 2, value: 10 }, { beat: 1, value: 5 }, { beat: 2, value: 20 }, null, { beat: 'x' }]);
  assert.deepEqual(p, [{ beat: 1, value: 5 }, { beat: 2, value: 20 }]);
});

test('P1-13 clampPoints：按目标范围钳制', () => {
  assert.deepEqual(clampPoints([{ beat: 0, value: 200 }, { beat: 1, value: -5 }], 0, 100), [{ beat: 0, value: 100 }, { beat: 1, value: 0 }]);
});

test('P1-13 insertPoint/removePoint/movePoint：不可变、自动重排', () => {
  const a = normalizePoints([{ beat: 0, value: 0 }, { beat: 2, value: 2 }]);
  const b = insertPoint(a, 1, 9);
  assert.deepEqual(b, [{ beat: 0, value: 0 }, { beat: 1, value: 9 }, { beat: 2, value: 2 }]);
  assert.deepEqual(a, [{ beat: 0, value: 0 }, { beat: 2, value: 2 }], '不改入参');
  const c = insertPoint(b, 1, 7);           // 同 beat 替换
  assert.deepEqual(c[1], { beat: 1, value: 7 });
  assert.deepEqual(removePoint(c, 1), [{ beat: 0, value: 0 }, { beat: 2, value: 2 }]);
  assert.deepEqual(movePoint(c, 1, 3, 5), [{ beat: 0, value: 0 }, { beat: 2, value: 2 }, { beat: 3, value: 5 }]);
});

test('P1-13 valueAt：线性插值 + 两端保持（不外插）', () => {
  const p = [{ beat: 1, value: 10 }, { beat: 3, value: 30 }];
  assert.equal(valueAt(p, 0), 10);
  assert.equal(valueAt(p, 1.5), 15);
  assert.equal(valueAt(p, 2), 20);
  assert.equal(valueAt(p, 9), 30);
  assert.equal(valueAt([], 2, 42), 42);
});

test('P1-13 simplifyPoints：直线上的中间点被去掉，拐点保留', () => {
  const straight = [{ beat: 0, value: 0 }, { beat: 1, value: 10 }, { beat: 2, value: 20 }, { beat: 3, value: 100 }];
  const s = simplifyPoints(straight, 1);
  assert.deepEqual(s.map((x) => x.value), [0, 20, 100], '直线段中间点 + 末点保留');
  assert.equal(simplifyPoints([{ beat: 0, value: 1 }], 1).length, 1);
});

test('P1-13 quantizePoints：中间点对齐步长，首尾保持', () => {
  const p = [{ beat: 0, value: 0 }, { beat: 0.37, value: 5 }, { beat: 0.61, value: 6 }, { beat: 1.3, value: 9 }];
  const q = quantizePoints(p, 0.25);
  assert.equal(q[0].beat, 0);
  assert.equal(q[1].beat, 0.25);
  assert.equal(q[2].beat, 0.5);   // 0.61 → 0.5（四舍五入到 0.25 网格）
  assert.equal(q[3].beat, 1.3);
});

test('P1-13 smoothPoints：中间点被邻域平均，首尾不动', () => {
  const p = [{ beat: 0, value: 0 }, { beat: 1, value: 30 }, { beat: 2, value: 0 }];
  const s = smoothPoints(p, 3);
  assert.equal(s[0].value, 0);
  assert.equal(s[2].value, 0);
  assert.equal(s[1].value, 10);
});

test('P1-13 scalePoints / mergePoints：批量缩放与合并', () => {
  assert.deepEqual(scalePoints([{ beat: 0, value: 100 }, { beat: 1, value: 50 }], 0.5, 0, 100), [{ beat: 0, value: 50 }, { beat: 1, value: 25 }]);
  const m = mergePoints([{ beat: 0, value: 1 }, { beat: 2, value: 3 }], [{ beat: 1, value: 2 }, { beat: 2, value: 9 }]);
  assert.deepEqual(m, [{ beat: 0, value: 1 }, { beat: 1, value: 2 }, { beat: 2, value: 9 }], '同 beat 后者覆盖');
});

test('P1-13 弯音：14bit ↔ 泳道 0..127 往返', () => {
  assert.equal(bendToUnit(8191), 127);
  assert.equal(bendToUnit(0), 64, '中心必须是 64');
  assert.equal(bendToUnit(-8192), 0);
  assert.equal(unitToBend(127), 16383);
  assert.equal(unitToBend(64), 8192, '中心回读精确');
  assert.equal(unitToBend(0), 0);
  // 127 档量化误差上限 = 半档 ≈ 16384/(2*127) ≈ 65
  for (const v of [-8192, -4000, 0, 1234, 8191]) {
    assert.ok(Math.abs(unitToBend(bendToUnit(v)) - (v + 8192)) <= 65, 'v=' + v);
  }
});

test('P1-13 弯音 ↔ 音分：默认 ±2 半音，超范围钳制', () => {
  assert.equal(bendToCents(8191), 199.98);
  assert.equal(bendToCents(-8192), -200);
  assert.equal(bendToCents(0), 0);
  assert.equal(centsToBend(200), 8191, '范围上限 8191（200/200*8192 溢出）');
  assert.equal(centsToBend(-200), -8192);
  assert.equal(centsToBend(100, 2), 4096);
  assert.equal(bendToCents(4096, 2), 100);
  assert.equal(centsToBend(0), 0);
});

test('P1-13 弯音归一化/居中判断', () => {
  assert.equal(bendNorm(0), 0);
  assert.ok(Math.abs(bendNorm(8191) - 0.99988) < 0.001, '正满量程 ≈ +1（8191/8192）');
  assert.equal(bendNorm(-4096), -0.5);
  assert.equal(isBendCenter(0), true);
  assert.equal(isBendCenter(0.5), true);
  assert.equal(isBendCenter(2), false);
});
