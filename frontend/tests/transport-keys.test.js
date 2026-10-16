// 方向键步长与长按倍数：纯函数测试（core/transport_keys.js）。
//
// 用户 2026-10-14 定：步长可配（秒/百分比/小节）；长按 → 倍数播放；
// 而且**输入框里不许抢方向键**（改数值时还要用左右键移光标）。
import { test } from "node:test";
import assert from "node:assert/strict";

import { seekDelta, seekTarget, holdRate, rewindStep, isEditableTarget } from "../src/core/transport_keys.js";

test("步长：秒", () => {
  assert.equal(seekDelta({ dir: 1, step: 5, unit: "sec" }), 5);
  assert.equal(seekDelta({ dir: -1, step: 5, unit: "sec" }), -5);
});

test("步长：百分比（按总长算）", () => {
  assert.equal(seekDelta({ dir: 1, step: 2, unit: "percent", totalSec: 100 }), 2);
  assert.equal(seekDelta({ dir: -1, step: 10, unit: "percent", totalSec: 250 }), -25);
});

test("步长：小节（需要每小节秒数）", () => {
  assert.equal(seekDelta({ dir: 1, step: 2, unit: "bar", secPerBar: 2.5 }), 5);
  assert.equal(seekDelta({ dir: 1, step: 1, unit: "bar" }), 2);        // 缺省按 2 秒
});

test("非法步长返回 0（不跳）", () => {
  assert.equal(seekDelta({ dir: 1, step: 0 }), 0);
  assert.equal(seekDelta({ dir: 1, step: -3 }), 0);
  assert.equal(seekDelta({ dir: 1, step: "abc" }), 0);
});

test("seekTarget 夹在 [0, 总长] 内", () => {
  assert.equal(seekTarget({ sec: 1, dir: -1, step: 5, unit: "sec" }), 0);
  assert.equal(seekTarget({ sec: 98, dir: 1, step: 5, unit: "sec", totalSec: 100 }), 100);
  assert.equal(seekTarget({ sec: 50, dir: 1, step: 5, unit: "sec", totalSec: 100 }), 55);
});

test("长按倍数：没按够时间就是 1 倍", () => {
  assert.equal(holdRate(0, { delayMs: 400, rate: 2 }), 1);
  assert.equal(holdRate(399, { delayMs: 400, rate: 2 }), 1);
  assert.equal(holdRate(400, { delayMs: 400, rate: 2 }), 2);
  assert.equal(holdRate(2000, { delayMs: 400, rate: 4 }), 4);
  assert.equal(holdRate(2000, { delayMs: 400, rate: 0 }), 1);       // 坏值退回 1 倍
});

test("快退步长 = 步长 × 倍数", () => {
  assert.equal(rewindStep({ step: 5, unit: "sec", rate: 2, elapsedMs: 1000 }), 10);
  assert.equal(rewindStep({ step: 5, unit: "sec", rate: 4, elapsedMs: 1000 }), 20);
});

test("输入框里不抢方向键", () => {
  assert.equal(isEditableTarget({ tagName: "INPUT" }), true);
  assert.equal(isEditableTarget({ tagName: "textarea" }), true);
  assert.equal(isEditableTarget({ tagName: "SELECT" }), true);
  assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isEditableTarget({ tagName: "DIV" }), false);
  assert.equal(isEditableTarget(null), false);
});
