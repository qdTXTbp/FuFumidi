// 模型下载三态（资源中心 S7）：纯函数单测。
//
// 为什么值得单测：这些分支错了不会抛异常，只会把「暂停」显示成「下载失败」、
// 或把未下载模型的体积显示成 0；而用户正是看着这两个数决定要不要继续下。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DL, manifestBytes, expectedBytes, downloadState,
  beginEntry, markPauseRequested, markCancelRequested, applyProgress, applyResult,
} from '../src/core/model-download.js';

test('manifestBytes：分卷总大小 > size > minSize，缺信息就如实给下界', () => {
  const msst = { parts: 3, partSizes: [10, 20, 5], size: 0, minSize: 1 };
  assert.deepEqual(manifestBytes(msst), { bytes: 35, isMin: false, source: 'parts' });
  assert.deepEqual(manifestBytes({ size: 123, minSize: 1 }), { bytes: 123, isMin: false, source: 'size' });
  assert.deepEqual(manifestBytes({ minSize: 500 }), { bytes: 500, isMin: true, source: 'minSize' });
  assert.deepEqual(manifestBytes({ size: 0, minSize: 0 }), { bytes: 0, isMin: false, source: '' });
  assert.deepEqual(manifestBytes(null), { bytes: 0, isMin: false, source: '' });
});

test('manifestBytes：partSizes 数量对不上时不瞎算，退回 size/minSize', () => {
  assert.deepEqual(manifestBytes({ parts: 3, partSizes: [10], minSize: 99 }).source, 'minSize');
  assert.deepEqual(manifestBytes({ parts: 2, partSizes: [0, 0], size: 0, minSize: 7 }).bytes, 7);
});

test('manifestBytes：Tauri 的 totalSize（清单总量）优先于 size / minSize', () => {
  // size 对 marker 型模型只是标记文件大小，未下载时是 0，不能当清单大小
  assert.deepEqual(manifestBytes({ size: 0, totalSize: 5_364_504_192, minSize: 5_000_000_000 }), { bytes: 5_364_504_192, isMin: false, source: 'totalSize' });
  // 分卷 partSizes 合计仍然优先（与实际落盘切片一致）
  assert.equal(manifestBytes({ parts: 1, partSizes: [10], totalSize: 99 }).source, 'parts');
});

test('MSST 条目（parts 有数、partSizes=null、totalSize 为清单大小）显示精确总量', () => {
  const msst = { id: 'msst:multi:HTDemucs4', exists: false, size: 0, parts: 10, partSizes: null, totalSize: 5_364_504_192, minSize: 4_828_053_772 };
  const e = expectedBytes(msst, undefined);
  assert.equal(e.bytes, 5_364_504_192);   // 精确清单总量，而不是 minSize
  assert.equal(e.isMin, false);
});

test('★ 未下载时展示清单大小或 minSize，不再是 0', () => {
  assert.equal(expectedBytes({ minSize: 5e8 }, undefined).bytes, 5e8);
  assert.equal(expectedBytes({ minSize: 5e8 }, undefined).isMin, true);
  assert.equal(expectedBytes({ parts: 2, partSizes: [100, 200] }, undefined).bytes, 300);
  assert.equal(expectedBytes({ exists: false, size: 0, minSize: 400 }, {}).bytes, 400);
});

test('expectedBytes：下载中用进度 total（含已收），已安装用磁盘体积', () => {
  const live = expectedBytes({ exists: false, minSize: 100 }, { active: true, received: 20, total: 100 });
  assert.deepEqual(live, { bytes: 100, received: 20, isMin: false, live: true });
  const paused = expectedBytes({ exists: false, minSize: 100 }, { paused: true, received: 40, total: 0 });
  assert.equal(paused.bytes, 40);
  assert.equal(expectedBytes({ exists: true, size: 777 }, {}).bytes, 777);
  // marker 型已安装：size 只是标记文件（远小于 minSize）→ 退回清单总量
  const marker = expectedBytes({ exists: true, size: 4096, minSize: 5e9, totalSize: 5.3e9 }, {});
  assert.equal(marker.bytes, 5.3e9);
});

test('downloadState：三态 + 已安装优先于陈旧错误', () => {
  assert.equal(downloadState({ exists: false }, undefined), DL.IDLE);
  assert.equal(downloadState({ exists: false }, { active: true }), DL.DOWNLOADING);
  assert.equal(downloadState({ exists: false }, { paused: true }), DL.PAUSED);
  assert.equal(downloadState({ exists: false }, { error: 'boom' }), DL.FAILED);
  assert.equal(downloadState({ exists: true }, { error: '陈旧' }), DL.INSTALLED);
  assert.equal(downloadState({ exists: true }, { active: true }), DL.DOWNLOADING);
  // 刚下完、model_list 还没刷新：先按已安装显示，避免闪「未安装」
  assert.equal(downloadState({ exists: false }, { done: true }), DL.INSTALLED);
});

test('beginEntry：暂停后重入续传，不把进度打回 0', () => {
  const paused = { active: false, paused: true, percent: 42, received: 420, total: 1000, error: '' };
  const e = beginEntry(paused);
  assert.equal(e.active, true);
  assert.equal(e.paused, false);
  assert.equal(e.percent, 42);
  assert.equal(e.received, 420);
  assert.equal(e.total, 1000);
  assert.equal(e.pauseReq, false);
  // 首次下载从 0 开始
  assert.equal(beginEntry(undefined).percent, 0);
});

test('★ 暂停事件不是失败：paused:true 落暂停态，error 不写进失败', () => {
  const e = applyProgress({ active: true, percent: 30 }, { id: 'm', percent: 40, paused: true, error: '已暂停（断点已保留，继续时会接着下）' });
  assert.equal(e.active, false);
  assert.equal(e.paused, true);
  assert.equal(e.error, '');
  assert.match(e.text, /断点/);
  assert.equal(e.percent, 30);   // 终态事件常带 received/total=0，进度条不能跳回 0
  assert.equal(downloadState({ exists: false }, e), DL.PAUSED);
});

test('★ 取消事件不是失败：canceled:true 落取消态并可重新下载', () => {
  const e = applyProgress({ active: true, percent: 30 }, { id: 'm', percent: 30, canceled: true, error: '下载中断（断点已保留，可稍后重试续传）' });
  assert.equal(e.active, false);
  assert.equal(e.paused, false);
  assert.equal(e.canceled, true);
  assert.equal(e.error, '');
  assert.equal(e.percent, 30);   // 取消事件 percent=0 时保留最后进度（重新下载时会从断点续传）
  assert.equal(downloadState({ exists: false }, e), DL.IDLE);
  // 也认 error === 'canceled' 这种后端写法
  assert.equal(applyResult({ active: true }, { ok: false, error: 'canceled' }).canceled, true);
});

test('★ 暂停请求后迟到的普通进度不能把状态翻回下载中', () => {
  const req = markPauseRequested({ active: true, percent: 50, received: 50 });
  const late = applyProgress(req, { id: 'm', percent: 60, received: 60, total: 100 });
  assert.equal(late.active, false);
  assert.equal(late.paused, true);
  assert.equal(late.percent, 60);          // 进度仍可前进
  const cancelReq = markCancelRequested({ active: true, percent: 10 });
  assert.equal(applyProgress(cancelReq, { id: 'm', percent: 20 }).canceled, true);
});

test('applyProgress：普通进度累加，done 落 100%', () => {
  const a = applyProgress({ active: true }, { id: 'm', percent: 12.6, speed: 300, received: 10, total: 80, text: 'ghfast' });
  assert.equal(a.active, true);
  assert.equal(a.percent, 13);
  assert.equal(a.speed, 300);
  assert.equal(a.text, 'ghfast');
  const b = applyProgress(a, { id: 'm', done: true });
  assert.equal(b.active, false);
  assert.equal(b.done, true);
  assert.equal(b.percent, 100);
  assert.equal(b.speed, 0);
});

test('applyResult：成功 / 暂停 / 取消 / 失败四种终态', () => {
  const ok = applyResult({ active: true, percent: 80 }, { ok: true, path: 'x' });
  assert.equal(ok.done, true);
  assert.equal(ok.percent, 100);
  assert.equal(ok.error, '');
  const paused = applyResult({ active: true, percent: 80 }, { ok: false, paused: true, error: '已暂停（断点已保留，继续时会接着下）' });
  assert.equal(paused.paused, true);
  assert.equal(paused.error, '');
  const canceled = applyResult({ active: true, percent: 80 }, { ok: false, canceled: true });
  assert.equal(canceled.canceled, true);
  assert.equal(canceled.error, '');
  assert.equal(canceled.percent, 0);
  const failed = applyResult({ active: true }, { ok: false, error: '所有镜像下载失败' });
  assert.equal(failed.active, false);
  assert.equal(failed.error, '所有镜像下载失败');
  assert.equal(downloadState({ exists: false }, failed), DL.FAILED);
  const thrown = applyResult({}, new Error('network'));  // 非对象也要能落失败
  assert.equal(typeof thrown.error, 'string');
});
