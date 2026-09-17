// 繁体转换的用词回归护栏。
//
// 背景：zhHant 的 PHRASE 表先于逐字表执行，「移动」曾被误收成「移动→移送」，
// 于是界面上所有「已移动」在繁體下都显示成「已移送」。这类错误不会报错、也没有自动守卫，
// 只能靠用例钉住。这里同时覆盖逐字转换与多字词转换两条路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { zhToHant } from '../src/core/zhHant.js';

test('只需字形转换的词不会被 PHRASE 表误改（移动 → 移動，而非移送）', () => {
  assert.equal(zhToHant('已移动 '), '已移動 ');
  assert.equal(zhToHant('拖动音符移动'), '拖動音符移動');
});

test('PHRASE 表的繁体用词仍然生效', () => {
  assert.equal(zhToHant('设置'), '設定');
  assert.equal(zhToHant('默认'), '預設');
  assert.equal(zhToHant('文件夹'), '資料夾');
  assert.equal(zhToHant('导入'), '匯入');
  assert.equal(zhToHant('撤销'), '復原');
});

test('常见界面文案整体转换正确', () => {
  assert.equal(zhToHant('已删除 12 个短音'), '已刪除 12 個短音');
  assert.equal(zhToHant('轨道混音器'), '軌道混音器');
  assert.equal(zhToHant('播放列表'), '播放清單');
});

test('不需要转换的文本原样返回', () => {
  assert.equal(zhToHant('MIDI 120 BPM'), 'MIDI 120 BPM');
  assert.equal(zhToHant(''), '');
});
