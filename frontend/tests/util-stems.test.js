// 分轨导出的命名工具测试（stemSafeName / stemFileName）。
//
// ★ 要验的三件事：
//   1. **路径非法字符清洗** —— Windows 文件名里的 \/:*?"<>| 必须被替换
//   2. **大小写不敏感去重** —— "Chorus" 和 "chorus" 算同名，后者加序号
//   3. **空值兜底** —— 空名不能产出空文件名
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stemSafeName, stemFileName } from '../src/core/util.js';

test('stemSafeName：非法字符替换、截断、空值兜底', () => {
  assert.equal(stemSafeName('a/b:c*d?e"f<g>h|i'), 'a_b_c_d_e_f_g_h_i');
  assert.equal(stemSafeName('主旋律'), '主旋律');
  assert.equal(stemSafeName('  x  '), 'x');
  assert.equal(stemSafeName('x'.repeat(100)).length, 80, '超长截到 80');
  assert.equal(stemSafeName(''), 'track');
  assert.equal(stemSafeName('///'), 'track', '清完只剩非法字符 → 兜底');
});

test('stemFileName：拼接 + 大小写不敏感去重', () => {
  const used = new Set();
  assert.equal(stemFileName('曲', '主旋律', used), '曲 - 主旋律.wav');
  assert.equal(stemFileName('曲', '主旋律', used), '曲 - 主旋律 (2).wav', '同名加序号');
  assert.equal(stemFileName('曲', '主旋律', used), '曲 - 主旋律 (3).wav');
  assert.equal(stemFileName('Song', 'chorus', used), 'Song - chorus.wav');
  assert.equal(stemFileName('Song', 'Chorus', used), 'Song - Chorus (2).wav', '大小写不同也算同名');
  assert.equal(stemFileName('曲', 'bad:name*', used), '曲 - bad_name_.wav', '轨名先清洗');
});

test('stemFileName：无 used 集合也能用（不炸）', () => {
  assert.equal(stemFileName('曲', '轨', undefined), '曲 - 轨.wav');
});
