// MIDI 输入消息解析测试（parseNoteMessage）。
//
// ★ 要钉死的语义：Note On vel=0 是**另一种常见的 Note Off 编码**——
//   不少硬件键盘/软件键盘只发这种，漏掉它会导致「音符一直按住不松」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNoteMessage } from '../src/core/midiin.js';

test('parseNoteMessage：Note On / Note Off / 其它', () => {
  assert.equal(parseNoteMessage([0x90, 60, 100]), 'on', 'Note On vel=100');
  assert.equal(parseNoteMessage([0x90, 60, 1]), 'on', 'Note On vel=1（最小力度也算按住）');
  assert.equal(parseNoteMessage([0x90, 60, 0]), 'off', 'Note On vel=0 = Note Off（常见编码）');
  assert.equal(parseNoteMessage([0x80, 60, 64]), 'off', 'Note Off 标准编码');
  assert.equal(parseNoteMessage([0xb0, 7, 100]), null, 'CC 不算音符');
  assert.equal(parseNoteMessage([0xe0, 0, 64]), null, 'Pitch Bend 不算音符');
  assert.equal(parseNoteMessage([0x90, 60]), null, '缺力度字节 → 忽略');
  assert.equal(parseNoteMessage(null), null, '空消息 → 忽略');
});
