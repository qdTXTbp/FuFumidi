// Canvas 连续曲率路径（core/canvas_shape.js）——用假 ctx 记录绘图指令。
import test from 'node:test';
import assert from 'node:assert/strict';
import { squirclePath } from '../src/core/canvas_shape.js';

function recorder() {
  const calls = [];
  return {
    calls,
    beginPath: () => calls.push(['beginPath']),
    moveTo: (x, y) => calls.push(['moveTo', x, y]),
    lineTo: (x, y) => calls.push(['lineTo', x, y]),
    bezierCurveTo: (...a) => calls.push(['bezierCurveTo', ...a]),
    closePath: () => calls.push(['closePath']),
  };
}

test('squirclePath：半径 0 退化成直角矩形，不产生曲线', () => {
  const ctx = recorder();
  squirclePath(ctx, 0, 0, 100, 40, 0);
  assert.equal(ctx.calls.filter((c) => c[0] === 'bezierCurveTo').length, 0);
  assert.equal(ctx.calls.filter((c) => c[0] === 'lineTo').length, 3);
  assert.equal(ctx.calls[ctx.calls.length - 1][0], 'closePath');
});

test('squirclePath：四个角各 2 段三次贝塞尔（连续曲率）', () => {
  const ctx = recorder();
  squirclePath(ctx, 10, 20, 120, 60, 8);
  const curves = ctx.calls.filter((c) => c[0] === 'bezierCurveTo');
  assert.equal(curves.length, 8);
  assert.equal(ctx.calls[0][0], 'beginPath');
  assert.equal(ctx.calls[1][0], 'moveTo');
  assert.equal(ctx.calls[ctx.calls.length - 1][0], 'closePath');
});

test('squirclePath：支持四角独立半径，0 半径的角不出曲线', () => {
  const ctx = recorder();
  squirclePath(ctx, 0, 0, 80, 80, [6, 0, 10, 0]);
  const curves = ctx.calls.filter((c) => c[0] === 'bezierCurveTo');
  assert.equal(curves.length, 4);
});

test('squirclePath：半径被夹到短边一半，坐标不越界', () => {
  const ctx = recorder();
  squirclePath(ctx, 0, 0, 20, 10, 999);
  for (const c of ctx.calls) {
    if (c[0] === 'bezierCurveTo') {
      for (let i = 1; i < c.length; i += 2) {
        assert.ok(c[i] >= -0.001 && c[i] <= 20.001, 'x 越界: ' + c[i]);
        assert.ok(c[i + 1] >= -0.001 && c[i + 1] <= 10.001, 'y 越界: ' + c[i + 1]);
      }
    }
  }
});
