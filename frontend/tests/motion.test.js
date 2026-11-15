// 全局动效阻尼参数（core/motion.js）——纯函数单测，不碰 DOM。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SPRING, normalizeSpring, dampingRatio, springStep, springSettle,
  springEasing, tierMotion, motionCssVars,
} from '../src/core/motion.js';

function maxOf(fn, steps = 240) {
  let m = 0;
  for (let i = 0; i <= steps; i++) m = Math.max(m, fn(i / steps));
  return m;
}

test('normalizeSpring：缺省回退默认值，非法值被夹到可用范围', () => {
  assert.deepEqual(normalizeSpring(), { ...DEFAULT_SPRING });
  const p = normalizeSpring({ stiffness: -1, damping: 0, mass: 999 });
  assert.ok(p.stiffness >= 20 && p.stiffness <= 2000);
  assert.ok(p.damping >= 1 && p.damping <= 200);
  assert.ok(p.mass > 0 && p.mass <= 10);
});

test('dampingRatio：默认欠阻尼（有回弹），c=2√(km) 为临界阻尼', () => {
  assert.ok(dampingRatio(DEFAULT_SPRING) < 1);
  assert.ok(dampingRatio(DEFAULT_SPRING) > 0.5);
  const critical = { stiffness: 200, damping: 2 * Math.sqrt(200 * 1), mass: 1 };
  assert.ok(Math.abs(dampingRatio(critical) - 1) < 1e-9);
});

test('springStep：起点为 0，长时间后收敛到 1', () => {
  assert.equal(springStep(DEFAULT_SPRING, 0), 0);
  assert.ok(Math.abs(springStep(DEFAULT_SPRING, 5) - 1) < 1e-4);
});

test('springStep：欠阻尼会产生过冲，临界阻尼不过冲', () => {
  const under = maxOf((t) => springStep(DEFAULT_SPRING, t * 0.8));
  assert.ok(under > 1.001, '默认参数应有可见回弹：' + under);
  const critical = { stiffness: 200, damping: 2 * Math.sqrt(200), mass: 1 };
  const crit = maxOf((t) => springStep(critical, t * 0.8));
  assert.ok(crit <= 1.0001, '临界阻尼不应过冲：' + crit);
});

test('springSettle：稳定时间落在 80ms–900ms，同阻尼比下刚度越大越快', () => {
  // ζ 相同（≈0.716），只改刚度：避免过阻尼参数比欠阻尼先"稳定"造成误判
  const slow = springSettle({ stiffness: 80, damping: 12.8, mass: 1 });
  const fast = springSettle({ stiffness: 600, damping: 35, mass: 1 });
  for (const d of [slow, fast]) assert.ok(d >= 0.08 && d <= 0.9);
  assert.ok(fast < slow, `刚度更大应更快：fast=${fast} slow=${slow}`);
});

test('springEasing：输出合法 linear()，首 0 尾 1 且保留过冲采样', () => {
  const s = springEasing(DEFAULT_SPRING, 24);
  assert.ok(s.startsWith('linear(0, '));
  assert.ok(s.endsWith(', 1)'));
  const nums = s.slice(7, -1).split(',').map((x) => Number(x.trim()));
  assert.equal(nums.length, 25);
  assert.ok(nums.some((v) => v > 1.001), '缓动里应保留 >1 的过冲值');
});

test('tierMotion / motionCssVars：三档齐全，旧 token 指向弹簧派生值', () => {
  const vars = motionCssVars(DEFAULT_SPRING);
  for (const tier of ['fast', 'base', 'slow']) {
    assert.ok(vars['--spring-ease-' + tier].startsWith('linear('));
    assert.match(vars['--spring-dur-' + tier], /^\d+ms$/);
  }
  assert.equal(vars['--ease-out'], vars['--spring-ease-base']);
  assert.equal(vars['--ease-spring'], vars['--spring-ease-fast']);
  assert.equal(vars['--motion-base'], vars['--spring-dur-base']);

  const fast = tierMotion(DEFAULT_SPRING, 'fast');
  const slow = tierMotion(DEFAULT_SPRING, 'slow');
  assert.ok(fast.durationMs < slow.durationMs);
});

test('motionCssVars：同参数结果确定，调参数会改变时长', () => {
  const a = motionCssVars(DEFAULT_SPRING);
  const b = motionCssVars(DEFAULT_SPRING);
  assert.deepEqual(a, b);
  const stiffer = motionCssVars({ ...DEFAULT_SPRING, stiffness: 600 });
  assert.notEqual(a['--spring-dur-base'], stiffer['--spring-dur-base']);
});
