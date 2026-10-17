// P2-6 AI 生成接入（可选、默认关）纯逻辑测试
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_JOB_FORMAT, AI_KINDS, AI_STATUS, isAiEnabled, aiStatusOf, fnv1aHash,
  normalizeAiRequest, buildAiJob, safeFileName, normalizeAiResult, aiLabel,
} from '../src/core/ai_generate.js';

test('P2-6 AI 默认关：只有布尔 true 算开启', () => {
  assert.equal(isAiEnabled({}), false);
  assert.equal(isAiEnabled({ 'ai.enabled': 'true' }), false);
  assert.equal(isAiEnabled({ 'ai.enabled': 1 }), false);
  assert.equal(isAiEnabled({ 'ai.enabled': true }), true);
  assert.equal(aiStatusOf({ enabled: false, providerCmd: 'x' }).code, AI_STATUS.DISABLED);
  assert.equal(aiStatusOf({ enabled: true, providerCmd: '' }).code, AI_STATUS.NOT_CONFIGURED);
  const ready = aiStatusOf({ enabled: true, providerCmd: ' python gen.py ' });
  assert.equal(ready.code, AI_STATUS.READY);
  assert.equal(ready.ready, true);
});

test('P2-6 请求校验：类型/空提示词/超长/种子夹紧', () => {
  assert.equal(normalizeAiRequest({ kind: 'video', prompt: 'x' }).code, 'bad-kind');
  assert.equal(normalizeAiRequest({ kind: 'midi', prompt: '   ' }).code, 'empty-prompt');
  assert.equal(normalizeAiRequest({ kind: 'midi', prompt: 'x'.repeat(2001) }).code, 'prompt-too-long');
  const ok = normalizeAiRequest({ kind: 'audio', prompt: '  lo-fi 前奏  ', title: '前奏', seed: -5 });
  assert.equal(ok.ok, true);
  assert.equal(ok.request.prompt, 'lo-fi 前奏');
  assert.equal(ok.request.seed, 0);
  assert.equal(ok.request.title, '前奏');
  assert.ok(AI_KINDS.some((k) => k.id === 'midi'));
});

test('P2-6 job 契约：format/时间/提示词指纹稳定', () => {
  const req = normalizeAiRequest({ kind: 'midi', prompt: 'C 大调 8 小节钢琴' }).request;
  const job = buildAiJob(req, { now: new Date('2026-10-18T00:00:00.000Z') });
  assert.equal(job.format, AI_JOB_FORMAT);
  assert.equal(job.createdAt, '2026-10-18T00:00:00.000Z');
  assert.equal(job.promptHash, fnv1aHash('midi\nC 大调 8 小节钢琴'));
  assert.equal(job.promptHash.length, 8);
  assert.notEqual(fnv1aHash('a'), fnv1aHash('b'));
});

test('P2-6 文件名安全：拒绝目录穿越/控制字符/空名', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('a\\b\\c.mid'), 'c.mid');
  assert.equal(safeFileName('  '), '');
  assert.equal(safeFileName('..'), '');
  assert.equal(safeFileName('x\u0000y.mid'), '');
  assert.ok(safeFileName('生成-01.mid').endsWith('.mid'));
});

test('P2-6 结果规范化：强制 AI 标注，去重、过滤非法名', () => {
  const r = normalizeAiResult(
    { provider: 'local-ace', model: 'v1', files: [{ name: 'a.mid', bytes: 100 }, { name: '../b.mid' }, { name: 'a.mid' }] },
    { kind: 'midi', prompt: 'p', now: new Date('2026-10-18T01:00:00.000Z') },
  );
  assert.equal(r.ok, true);
  assert.equal(r.files.length, 2);
  assert.equal(r.files[1].name, 'b.mid');
  assert.equal(r.meta.aiGenerated, true);
  assert.equal(r.meta.provider, 'local-ace');
  assert.equal(r.meta.model, 'v1');
  assert.equal(r.meta.kind, 'midi');
  assert.equal(r.meta.createdAt, '2026-10-18T01:00:00.000Z');
  assert.equal(r.meta.promptHash.length, 8);
});

test('P2-6 结果规范化：空/全非法文件视为失败（不得伪造成成功）', () => {
  assert.equal(normalizeAiResult({ files: [] }).code, 'no-files');
  assert.equal(normalizeAiResult({}).code, 'no-files');
  assert.equal(normalizeAiResult({ files: [{ name: '../' }] }).code, 'no-files');
  const many = { files: Array.from({ length: 21 }, (_, i) => ({ name: 'f' + i + '.mid' })) };
  assert.equal(normalizeAiResult(many).code, 'too-many-files');
});

test('P2-6 AI 标注：徽标与来源信息', () => {
  const l = aiLabel({ provider: 'local-x', model: 'm2', createdAt: 't' });
  assert.equal(l.badge, 'AI');
  assert.equal(l.text, 'AI 生成');
  assert.match(l.detail, /local-x/);
  assert.equal(aiLabel({}).detail, 'local');
});
