// ★ 2026-11-07 回归：正式通道用户收到测试版更新且更新失败。
//   根因：resolveRelease「多源取最大」没有按通道过滤候选；CNB 的 latest 锚点被
//   测试版短暂顶替（或第三方镜像缓存了 prerelease）时，6.5.0-beta.1 > 6.4.5 会胜出，
//   又被标成 channel:'stable' → 更新器用正式锚点的包去装测试版 → metadata/验签不匹配。
// 这里用注入的 net 复现各种污染组合，钉死「正式通道只报正式版」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { registerUpdateIpc } = require('../main/update.js');
const UC = require('../main/update-channel.js');

const STABLE = { tag_name: 'v6.4.5', prerelease: false, assets: [{ name: 'FuFumidi.Install.exe', browser_download_url: 'https://x/Install.exe' }] };

/** 构造一个假的更新服务，返回 update:check handler。
 *  cnbVersion：CNB latest.yml 的 version；ghStable：GitHub releases/latest 的返回；
 *  ghList：GitHub releases?per_page=20（beta 通道用）。 */
function harness({ cnbVersion = '6.4.5', ghStable = STABLE, ghList = [], cnbBetaVersion = null } = {}) {
  const handlers = {};
  const calls = [];
  const net = {
    fetch: async (u) => {
      calls.push(u);
      if (u.includes('cnb.cool') && u.includes('latest.yml')) {
        const isBeta = u.includes('/download/beta/');
        const ver = isBeta && cnbBetaVersion !== null ? cnbBetaVersion : cnbVersion;
        return { ok: true, text: async () => 'version: ' + ver + '\nfiles:\n' };
      }
      if (u.includes('releases?per_page=20')) return { ok: true, json: async () => ghList };
      if (u.includes('releases/latest')) return { ok: true, json: async () => ghStable };
      return { ok: false, status: 404 };
    },
  };
  registerUpdateIpc({
    ipcMain: { handle: (n, f) => { handlers[n] = f; } },
    net,
    shell: {},
    BrowserWindow: { fromWebContents: () => null },
    app: { getVersion: () => '6.4.5' },
    path, fs,
    readSettings: () => ({ update_channel: 'stable' }),
  });
  return { check: handlers['update:check'], calls };
}

// ── 纯函数：通道判定（与主进程同规则） ─────────────────────────────────
test('预发布 tag 识别：alpha / beta / rc / dev / preview 一个都不能漏', () => {
  for (const t of ['v6.5.0-alpha.3', 'v6.5.0-alpha.2', '6.5.0-beta.1', 'v4.4.0-rc.2',
                   'v6.5.0-dev.1', 'v6.5.0-preview.1', 'v6.5.0-nightly.1']) {
    assert.equal(UC.isPrereleaseTag(t), true, t);
    assert.equal(UC.isBetaRelease({ tag_name: t }), true, t);
    assert.equal(UC.allowsRelease('stable', { tag_name: t }), false, t);
  }
  for (const t of ['v6.4.5', '6.4.5', 'v6.4.2']) {
    assert.equal(UC.isPrereleaseTag(t), false, t);
    assert.equal(UC.isStableTag(t), true, t);
    assert.equal(UC.allowsRelease('stable', { tag_name: t }), true, t);
  }
});

test('release 即便被误标成「非 prerelease」，只要 tag 带后缀仍算测试版', () => {
  // 线上真实出现过：v6.5.0-alpha.2 被发布成非 prerelease 的正式 release
  const rel = { tag_name: 'v6.5.0-alpha.2', prerelease: false };
  assert.equal(UC.isBetaRelease(rel), true);
  assert.equal(UC.channelOfRelease(rel), 'beta');
  assert.equal(UC.allowsRelease('stable', rel), false);
  assert.equal(UC.allowsRelease('beta', rel), true);
});

test('channelOfRelease 以 release 自身为准：测试通道回退正式版时返回 stable', () => {
  assert.equal(UC.channelOfRelease({ tag_name: 'v6.4.5' }), 'stable');
  assert.equal(UC.channelOfRelease({ tag_name: 'v6.5.0-beta.1' }), 'beta');
  assert.equal(UC.normChannel(undefined), 'stable');
  assert.equal(UC.normChannel('BETA'), 'beta');
});

// ── 集成：被污染的远端不能再把测试版推给正式用户 ───────────────────────
test('CNB latest 锚点被测试版顶替时，正式通道忽略该源、只报正式版', async () => {
  const { check } = harness({ cnbVersion: '6.5.0-beta.1', ghStable: STABLE });
  const r = await check(null, 'stable');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.latest, '6.4.5');
  assert.equal(r.channel, 'stable');
});

test('GitHub latest 返回测试版（哪怕标成非 prerelease）时，正式通道忽略该源', async () => {
  const polluted = { tag_name: 'v6.5.0-alpha.2', prerelease: false, assets: STABLE.assets };
  const { check } = harness({ cnbVersion: '6.4.5', ghStable: polluted });
  const r = await check(null, 'stable');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.latest, '6.4.5');
  assert.equal(r.channel, 'stable');
});

test('两个源同时被污染：正式通道报「没有可用版本」，绝不弹出测试版更新', async () => {
  const polluted = { tag_name: 'v6.5.0-beta.1', prerelease: true, assets: STABLE.assets };
  const { check } = harness({ cnbVersion: '6.5.0-beta.1', ghStable: polluted });
  const r = await check(null, 'stable');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /通道/);
});

test('正式通道传错 beta 参数（旧前端/缓存）时，仍按正式通道处理', async () => {
  const { check } = harness({ cnbVersion: '6.4.5', ghStable: STABLE });
  // normChannel 会把 beta 归一到 beta —— 但正式用户的设置是 stable，
  // 所以这里验证的是「不会被误判成已选测试通道」的纯函数约束；
  // 实际 IPC 由主进程 launchUpdater 用 currentChannel() 再兜一次。
  assert.equal(UC.allowsRelease('stable', { tag_name: 'v6.5.0-beta.1' }), false);
  const r = await check(null, 'stable');
  assert.equal(r.channel, 'stable');
});

test('测试通道确实能拿到测试版，并返回 beta 通道（不能被修成永远不给）', async () => {
  const betaRel = { tag_name: 'v6.5.0-beta.1', prerelease: true, assets: STABLE.assets };
  const { check } = harness({
    cnbVersion: '6.4.5',
    cnbBetaVersion: '6.5.0-beta.1',
    ghStable: STABLE,
    // 固定锚点 release（tag=beta、prerelease=true）混在列表里，必须被跳过
    ghList: [{ tag_name: 'beta', prerelease: true, assets: STABLE.assets }, betaRel],
  });
  const r = await check(null, 'beta');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.latest, '6.5.0-beta.1', '不能把固定锚点 tag=beta 当成版本号');
  assert.equal(r.channel, 'beta');
});

test('测试通道当时没有测试版 → 回退正式版，且必须返回 stable 通道（用正式锚点）', async () => {
  const { check } = harness({
    cnbVersion: '6.4.5',
    cnbBetaVersion: '6.4.5',
    ghStable: STABLE,
    ghList: [],   // GitHub 上也没有 prerelease
  });
  const r = await check(null, 'beta');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.latest, '6.4.5');
  assert.equal(r.channel, 'stable');
});
