// GitHub issue #39 回归护栏：同一条轨在卷帘、混音台、分析页、乐谱、迷你卷帘必须同一颜色。
//
// 根因是两套调色板并存且顺序不同：
//   --track-1..8（主题色板，8 色，深浅各一档）  vs  VIEW_TRACK_RAMP（固定序列，10 色）
// 同一索引落到两种颜色，用户看到「drum 轨在轨道图是红、在均衡器是蓝」「Voice 是土黄 vs 紫」。
// 修复后所有「轨色」入口统一走 palette.trackColor()；10 色序列只留给波形/视频导出。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { trackColor, TRACK_FALLBACK, VIEW_TRACK_RAMP } from '../src/core/palette.js';

test('issue #39：轨色按 8 色主题色板取值（node 无 document 时走 TRACK_FALLBACK）', () => {
  assert.equal(trackColor(0), '#3b82f6');
  assert.equal(trackColor(3), '#f59e0b', 'Voice 在用户截图里是土黄');
  assert.equal(trackColor(4), '#ef4444', 'drum 在用户截图里是红');
  assert.equal(trackColor(8), trackColor(0), '超过 8 轨按 8 回绕');
  assert.equal(trackColor(-1), trackColor(7), '负数也回绕');
  assert.equal(trackColor(undefined), trackColor(0));
  assert.equal(trackColor('2'), trackColor(2), '字符串轨号也能用');
});

test('issue #39 的核心断言：同索引在两套色板上必须是不同颜色', () => {
  for (const i of [0, 3, 4, 7]) {
    assert.notEqual(
      trackColor(i), VIEW_TRACK_RAMP[i % VIEW_TRACK_RAMP.length],
      'index ' + i + ' 两套色板撞成同色，护栏失效',
    );
  }
  assert.equal(TRACK_FALLBACK.length, 8);
  assert.equal(VIEW_TRACK_RAMP.length, 10);
});

test('源码契约：不再用 TRACK_COLORS[i] 给轨道上色', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const files = [
    'src/stores/app.ts',
    'src/store.js',
    'src/core/viz.js',
    'src/views/ViewAnalyze.vue',
    'src/views/ViewScore.vue',
    'src/views/ViewEdit.vue',
  ];
  const bad = [];
  for (const rel of files) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const s = fs.readFileSync(p, 'utf8');
    if (/TRACK_COLORS\s*\[/.test(s)) bad.push(rel);
  }
  assert.deepEqual(bad, [], '这些文件仍在用 10 色序列取轨色：' + bad.join(', '));
});
