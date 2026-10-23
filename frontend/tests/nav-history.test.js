// P1-14 B3 导航历史 / 深链接 / 会话恢复
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNavHistory, parseDeepLink, buildDeepLink, normalizePath,
  normalizeSession, NAV_LIMIT, SESSION_TTL_MS,
} from '../src/core/nav_history.js';

test('P1-14 历史栈：push/back/forward 与 can* 状态', () => {
  const h = createNavHistory();
  h.push('/home'); h.push('/views?tab=arrange'); h.push('/resources');
  assert.equal(h.current(), '/resources');
  assert.equal(h.canBack(), true);
  assert.equal(h.forward(), null);
  assert.equal(h.back(), '/views?tab=arrange');
  assert.equal(h.back(), '/home');
  assert.equal(h.canBack(), false);
  assert.equal(h.forward(), '/views?tab=arrange');
});

test('P1-14 历史栈：连续重复不入栈；新导航丢弃前进栈', () => {
  const h = createNavHistory();
  h.push('/a'); h.push('/a'); h.push('/b');
  assert.equal(h.snapshot().stack.length, 2);
  h.back();
  assert.equal(h.canForward(), true);
  h.push('/c');
  assert.equal(h.canForward(), false);
  assert.deepEqual(h.snapshot().stack, ['/a', '/c']);
});

test('P1-14 历史栈：limit 丢最旧，onChange 可订阅', () => {
  const h = createNavHistory({ limit: 3 });
  for (let i = 0; i < 6; i++) h.push('/p' + i);
  assert.equal(h.snapshot().stack.length, 3);
  assert.equal(h.snapshot().stack[0], '/p3');
  let calls = 0;
  const off = h.onChange(() => calls++);
  h.push('/x'); assert.equal(calls, 1); off(); h.push('/y'); assert.equal(calls, 1);
  assert.equal(NAV_LIMIT, 50);
});

test('P1-14 normalizePath：hash / 纯路径统一', () => {
  assert.equal(normalizePath('#/views?tab=arrange'), '/views?tab=arrange');
  assert.equal(normalizePath('/music'), '/music');
  assert.equal(normalizePath('music'), '/music');
  assert.equal(normalizePath('#'), '/');
});

test('P1-14 深链接解析：视图 + 合法页签 + 查询参数', () => {
  const r = parseDeepLink('#/views?tab=arrange&x=1');
  assert.equal(r.valid, true);
  assert.equal(r.view, 'views');
  assert.equal(r.tab, 'arrange');
  assert.deepEqual(r.query, { tab: 'arrange', x: '1' });
  // 非法页签被丢弃（allowed 表拦截），不崩
  assert.equal(parseDeepLink('#/resources?tab=nope').tab, '');
  assert.equal(parseDeepLink('#/nope/x').valid, false);
  assert.equal(parseDeepLink('').view, 'home');
  assert.equal(parseDeepLink('#/music?name=a%20b').query.name, 'a b');
});

test('P1-14 深链接生成：合法 tab 保留、非法 tab 丢弃、query 编码', () => {
  assert.equal(buildDeepLink('views', { tab: 'arrange' }), '#/views?tab=arrange');
  assert.equal(buildDeepLink('resources', { tab: 'nope' }), '#/resources');
  assert.equal(buildDeepLink('music', { query: { name: 'a b' } }), '#/music?name=a%20b');
  assert.equal(buildDeepLink('home'), '#/home');
});

test('P1-14 会话快照清洗：过期/未来/损坏都返回 null', () => {
  const now = Date.now();
  const ok = normalizeSession({ hash: '#/views?tab=arrange', songId: 's1', at: now - 1000 }, now);
  assert.equal(ok.hash, '/views?tab=arrange');
  assert.equal(ok.songId, 's1');
  assert.equal(normalizeSession({ hash: '#/x', at: now - SESSION_TTL_MS - 1 }, now), null);
  assert.equal(normalizeSession({ hash: '#/x', at: now + 120000 }, now), null, '未来时间视为坏数据');
  assert.equal(normalizeSession(null, now), null);
  assert.equal(normalizeSession({ at: now }, now), null);
});
