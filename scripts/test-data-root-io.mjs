// 数据根解析的**端到端复现**（真 fs + 桩 electron）。
//
// 复刻 2026-10-24 用户报障的现场：
//   旧便携版  E:\Midi\FuFumidi\FuFumidiData  ← models / soundfonts 都在这里
//   新装到    C:\Program Files\FuFumidi       ← 不可写
//   Roaming   %APPDATA%\FuFumidi\FuFumidiData ← 6.2.4 首次启动建出来的空目录
//   settings  active_soundfont 仍指向 E 盘，data_root 为空
// 修复前：数据根 = Roaming 空目录（用户看到模型/音色全丢）。
// 修复后：必须认出 E 盘那个旧目录并继续使用。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** 用桩 electron 重新加载 paths.js（绕过模块级缓存，每个场景一份干净状态） */
function freshPaths(userDataDir) {
  const resolved = require.resolve('../main/paths.js');
  delete require.cache[resolved];
  const origLoad = require('module')._load;
  require('module')._load = function (req, parent, isMain) {
    if (req === 'electron') {
      return { app: { isPackaged: true, getPath: () => userDataDir }, ipcMain: { handle() {} } };
    }
    return origLoad.call(this, req, parent, isMain);
  };
  try {
    return require('../main/paths.js');
  } finally {
    require('module')._load = origLoad;
  }
}

/** 建一棵临时目录树；返回根 */
function scaffold() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-dataroot-'));
  const legacyRoot = path.join(base, 'portable', 'FuFumidiData');   // 旧便携数据根
  const installDir = path.join(base, 'app');                        // 「Program Files」→ 不存在 = 不可写
  const userData = path.join(base, 'roaming');                      // %APPDATA%\FuFumidi
  const roamRoot = path.join(userData, 'FuFumidiData');              // 6.2.4 建出来的空目录
  const legacySettingsDir = path.join(userData, 'fufumidi');

  fs.mkdirSync(path.join(legacyRoot, 'models'), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, 'models', 'basic_pitch_quant.onnx'), 'x');
  fs.mkdirSync(path.join(legacyRoot, 'soundfonts'), { recursive: true });
  const sf2 = path.join(legacyRoot, 'soundfonts', 'GeneralUser.sf2');
  fs.writeFileSync(sf2, 'sf2');

  // 空 Roaming 数据根（+ pendingMigration 会给它补 ready 标记）
  fs.mkdirSync(path.join(roamRoot, 'models'), { recursive: true });
  fs.writeFileSync(path.join(roamRoot, '.fufumidi-ready'), 'stale');

  fs.mkdirSync(legacySettingsDir, { recursive: true });
  fs.writeFileSync(path.join(legacySettingsDir, 'settings.json'), JSON.stringify({
    data_root: '',
    active_soundfont: sf2,
  }, null, 2));

  return { base, legacyRoot, installDir, userData, roamRoot, legacySettingsDir, sf2 };
}

function withEnv(env, fn) {
  const old = {};
  for (const k of Object.keys(env)) { old[k] = process.env[k]; process.env[k] = env[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(env)) {
      if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k];
    }
  }
}

test('报障复现：装到不可写目录 + Roaming 是空壳 → 自动认出旧便携目录', () => {
  const s = scaffold();
  try {
    // ★ 所有解析都必须在 withEnv 回调**内部**做：installRoot 读的是环境变量，
    //   出了回调就还原了（这里写错过一次，导致断言比的是 node 自带目录）。
    withEnv({ FUFUMIDI_INSTALL_ROOT: s.installDir }, () => {
      const P = freshPaths(s.userData);
      assert.equal(P.dataRoot(), s.legacyRoot, '必须沿用旧数据根，而不是 Roaming 空目录');
      assert.equal(P.rootReason(), 'adopted-previous');
      assert.equal(P.rootFrom(), 'settings-paths');
      // 功能区目录必须指向旧位置（模型/音色才找得回来）
      assert.equal(P.modelsDir(), path.join(s.legacyRoot, 'models'));
      assert.equal(P.soundfontsDir(), path.join(s.legacyRoot, 'soundfonts'));
    });
  } finally { fs.rmSync(s.base, { recursive: true, force: true }); }
});

test('认领旧目录后 pendingMigration 不该再把它当迁移目标', () => {
  const s = scaffold();
  try {
    withEnv({ FUFUMIDI_INSTALL_ROOT: s.installDir }, () => {
      const P = freshPaths(s.userData);
      P.dataRoot();
      const pending = P.pendingMigration();
      assert.equal(pending.find((x) => x.name === 'models'), undefined,
        '模型目录已是数据根本身，不该再迁移');
    });
  } finally { fs.rmSync(s.base, { recursive: true, force: true }); }
});

test('rememberRoot 把本次数据根写进 settings.data_root_last，下次能直接找回', () => {
  const s = scaffold();
  try {
    withEnv({ FUFUMIDI_INSTALL_ROOT: s.installDir }, () => {
      const P = freshPaths(s.userData);
      P.dataRoot();
      assert.equal(P.rememberRoot(), true, '首次应写入');
      assert.equal(P.rememberRoot(), false, '没变化时不该反复写盘');
    });
    const st = JSON.parse(fs.readFileSync(path.join(s.legacySettingsDir, 'settings.json'), 'utf8'));
    assert.equal(st.data_root_last, s.legacyRoot);
    assert.equal(st.active_soundfont, s.sf2, '不得破坏其它设置键');
  } finally { fs.rmSync(s.base, { recursive: true, force: true }); }
});

test('有 data_root_last 时即使没有任何路径线索也能找回旧目录', () => {
  const s = scaffold();
  try {
    // 抹掉线索（active_soundfont 指向别处），只留 data_root_last
    fs.writeFileSync(path.join(s.legacySettingsDir, 'settings.json'), JSON.stringify({
      data_root: '', data_root_last: s.legacyRoot, active_soundfont: 'internal',
    }, null, 2));
    withEnv({ FUFUMIDI_INSTALL_ROOT: s.installDir }, () => {
      const P = freshPaths(s.userData);
      assert.equal(P.dataRoot(), s.legacyRoot);
      assert.equal(P.rootFrom(), 'settings.data_root_last');
    });
  } finally { fs.rmSync(s.base, { recursive: true, force: true }); }
});

test('全新机器（哪里都没数据）→ 安装目录可写就用安装目录旁', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-fresh-'));
  try {
    const installDir = path.join(base, 'app');
    const userData = path.join(base, 'roaming');
    fs.mkdirSync(installDir, { recursive: true });
    fs.mkdirSync(path.join(userData, 'fufumidi'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'fufumidi', 'settings.json'), '{"data_root":""}');
    withEnv({ FUFUMIDI_INSTALL_ROOT: installDir }, () => {
      const P = freshPaths(userData);
      assert.equal(P.dataRoot(), path.join(installDir, 'FuFumidiData'));
      assert.equal(P.rootReason(), 'install-dir');
    });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('旧目录被删掉（换机/拔盘）→ 不认死路径，回到可用位置', () => {
  const s = scaffold();
  try {
    fs.writeFileSync(path.join(s.legacySettingsDir, 'settings.json'), JSON.stringify({
      data_root: '', data_root_last: path.join(s.base, 'gone', 'FuFumidiData'),
      active_soundfont: 'internal',
    }, null, 2));
    withEnv({ FUFUMIDI_INSTALL_ROOT: s.installDir }, () => {
      const P = freshPaths(s.userData);
      const root = P.dataRoot();
      assert.notEqual(root, path.join(s.base, 'gone', 'FuFumidiData'), '不存在的目录绝不能认领');
      // 落到 Roaming（那里有空壳 + ready，但没有数据 → 走兜底）
      assert.equal(root, s.roamRoot);
    });
  } finally { fs.rmSync(s.base, { recursive: true, force: true }); }
});
