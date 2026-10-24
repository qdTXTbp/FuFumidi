// 数据根选择规则的纯逻辑测试（main/data-root-pick.js 不依赖 electron/fs）。
//
// 2026-10-24 用户报障：6.2.4 装进 Program Files 后，数据根回退到了
// %APPDATA%\FuFumidi\FuFumidiData 这个**新建的空目录**，而用户数据还在旧便携目录
// E:\Midi\FuFumidi\FuFumidiData —— 旧目录从来没被找过。
// 这里把「先看谁真有数据」的规则和几个真实场景一起钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Pick = require('../main/data-root-pick.js');

const A = 'E:\\Midi\\FuFumidi\\FuFumidiData';
const PREF = 'C:\\Program Files\\FuFumidi\\FuFumidiData';
const ROAM = 'C:\\Users\\u\\AppData\\Roaming\\FuFumidi\\FuFumidiData';

/** 造一组「存在的目录 + 有数据的目录」 */
function world(existing, withData) {
  const ex = new Set(existing.map((p) => p.toLowerCase()));
  const dt = new Set(withData.map((p) => p.toLowerCase()));
  return {
    canUse: (d) => ex.has(String(d).toLowerCase()),
    hasData: (d) => dt.has(String(d).toLowerCase()),
  };
}

test('报障场景：Program Files 不可写 + Roaming 是空目录 → 必须认领旧便携目录', () => {
  // 关键：Roaming 存在但**没有数据**；安装目录不存在（不可写 = 探测不到）
  const w = world([A, ROAM], [A]);
  const r = Pick.pickDataRoot({
    configured: '',
    last: '',
    preferred: PREF,
    userData: ROAM,
    discovered: [A],
    canUse: w.canUse,
    hasData: w.hasData,
  });
  assert.equal(r.root, A);
  assert.equal(r.reason, 'adopted-previous');
  assert.equal(r.from, 'settings-paths');
});

test('Roaming 里也已经有数据时：先认领「上次用过的」，退而认领 Roaming', () => {
  const w1 = world([A, ROAM], [A, ROAM]);
  const r1 = Pick.pickDataRoot({
    configured: '', last: A, preferred: PREF, userData: ROAM, discovered: [A],
    canUse: w1.canUse, hasData: w1.hasData,
  });
  assert.equal(r1.root, A, 'data_root_last 优先');
  assert.equal(r1.from, 'settings.data_root_last');

  const r2 = Pick.pickDataRoot({
    configured: '', last: '', preferred: PREF, userData: ROAM, discovered: [],
    canUse: w1.canUse, hasData: w1.hasData,
  });
  assert.equal(r2.root, ROAM, '没有任何历史线索时才用 Roaming');
  assert.equal(r2.reason, 'user-data');
});

test('空目录永远不被认领（防止认领上次故障留下的空壳）', () => {
  const w = world([A, ROAM], []);            // 都存在，但都没有数据
  const r = Pick.pickDataRoot({
    configured: '', last: A, preferred: PREF, userData: ROAM, discovered: [A],
    canUse: w.canUse, hasData: w.hasData,
  });
  // A 空 → 不认；PREF 不可写 → 只能落到 Roaming
  assert.equal(r.root, ROAM);
  assert.equal(r.reason, 'install-dir-not-writable');
});

test('便携版常态：安装目录旁有数据 → 用它，不抢 Roaming', () => {
  const w = world([PREF, ROAM], [PREF]);
  const r = Pick.pickDataRoot({
    configured: '', last: '', preferred: PREF, userData: ROAM, discovered: [],
    canUse: w.canUse, hasData: w.hasData,
  });
  assert.equal(r.root, PREF);
  assert.equal(r.reason, 'install-dir');
});

test('换安装位置：旧位置没数据了 → 用新的安装目录（不误认旧路径）', () => {
  const NEWPREF = 'D:\\Apps\\FuFumidi\\FuFumidiData';
  const w = world([NEWPREF], []);            // 旧 A 已经不存在
  const r = Pick.pickDataRoot({
    configured: '', last: A, preferred: NEWPREF, userData: ROAM,
    discovered: [A],                        // 线索里还留着旧路径
    canUse: w.canUse, hasData: w.hasData,
  });
  assert.equal(r.root, NEWPREF, '旧路径不存在就不该被认领');
  assert.equal(r.reason, 'install-dir');
});

test('用户显式指定 data_root 时最高优先（哪怕空着、哪怕有别的历史目录）', () => {
  const MY = 'F:\\MyData';
  const w = world([MY, A, PREF, ROAM], [A]);
  const r = Pick.pickDataRoot({
    configured: MY, last: A, preferred: PREF, userData: ROAM, discovered: [A],
    canUse: w.canUse, hasData: w.hasData,
  });
  assert.equal(r.root, MY);
  assert.equal(r.reason, 'configured');
});

test('显式指定但不可写 → 回退并给出 configured-not-writable', () => {
  const w = world([ROAM], []);
  const r = Pick.pickDataRoot({
    configured: 'Z:\\gone', last: '', preferred: PREF, userData: ROAM,
    discovered: [], canUse: w.canUse, hasData: w.hasData,
  });
  assert.equal(r.root, ROAM);
  assert.equal(r.reason, 'configured-not-writable');
});

test('rootsFromHint：从数据根内的文件路径反推出数据根', () => {
  const sf2 = A + '\\soundfonts\\GeneralUser.sf2';
  const cands = Pick.rootsFromHint(sf2);
  const norm = cands.map((p) => p.toLowerCase());
  assert.ok(norm.includes(A.toLowerCase()), '必须包含数据根本身：' + cands.join(' | '));
});

test('rootsFromHint：从数据根目录本身、以及常见子目录都能反推', () => {
  for (const hint of [A, A + '\\models\\basic_pitch_quant.onnx', A + '\\midi\\x.mid']) {
    const norm = Pick.rootsFromHint(hint).map((p) => p.toLowerCase());
    assert.ok(norm.includes(A.toLowerCase()), '反推失败：' + hint);
  }
});

test('rootsFromHint：相对路径/空值直接忽略', () => {
  assert.deepEqual(Pick.rootsFromHint(''), []);
  assert.deepEqual(Pick.rootsFromHint('soundfonts\\x.sf2'), []);
  assert.deepEqual(Pick.rootsFromHint(null), []);
});

test('rootsFromHints：多条线索去重且保持顺序', () => {
  const list = Pick.rootsFromHints([
    A + '\\soundfonts\\a.sf2',
    A + '\\models\\b.onnx',
    'D:\\Other\\FuFumidiData\\midi\\c.mid',
  ]);
  const low = list.map((p) => p.toLowerCase());
  assert.equal(new Set(low).size, low.length, '不应有重复');
  assert.ok(low.includes(A.toLowerCase()));
  assert.ok(low.includes('d:\\other\\fufumididata'));
});

test('hasDataDir：只有已知子目录非空才算有数据', () => {
  const fs = {
    existsSync: (p) => {
      const s = String(p).toLowerCase();
      return s === A.toLowerCase()
        || s === (A + '\\models').toLowerCase()
        || s === (A + '\\soundfonts').toLowerCase();
    },
    readdirSync: (p) => {
      const s = String(p).toLowerCase();
      if (s === (A + '\\models').toLowerCase()) return ['x.onnx'];
      if (s === (A + '\\soundfonts').toLowerCase()) return [];      // 空目录
      return [];
    },
  };
  assert.equal(Pick.hasDataDir(A, { fs }), true, 'models 非空 → 有数据');

  const fs2 = {
    existsSync: (p) => {
      const s = String(p).toLowerCase();
      return s === A.toLowerCase() || s === (A + '\\models').toLowerCase();
    },
    readdirSync: () => [],
  };
  assert.equal(Pick.hasDataDir(A, { fs: fs2 }), false, '子目录全空 → 无数据');
  assert.equal(Pick.hasDataDir('C:\\nope', { fs: fs2 }), false, '不存在 → 无数据');
});

test('DATA_SUBDIRS 覆盖 paths.js 的所有功能区', () => {
  for (const k of ['models', 'gpu-enhancements', 'soundfonts', 'voicebanks',
    'diffsinger', 'diffsinger-voicebanks', 'midi', 'cache', 'temp']) {
    assert.ok(Pick.DATA_SUBDIRS.includes(k), '缺少功能区：' + k);
  }
});
