import test from 'node:test';
import assert from 'node:assert/strict';
import { pickDefaultSoundfont, shouldLazyLoadDefaultGm, defaultGmFlagOf } from '../src/core/default_soundfont.js';

test("P0-5 pick：优先 GeneralUser（大小写/路径都不敏感）", () => {
  const list = [
    { id: "piano.sf2", name: "piano", path: "C:/sf/piano.sf2" },
    { id: "GeneralUser.sf2", name: "GeneralUser", path: "C:/app/renderer/vendor/soundfonts/GeneralUser.sf2" },
  ];
  assert.equal(pickDefaultSoundfont(list).path, "C:/app/renderer/vendor/soundfonts/GeneralUser.sf2");
  assert.equal(pickDefaultSoundfont([{ id: "generaluser-gs.sf2", path: "/x/generaluser-gs.sf2" }]).id, "generaluser-gs.sf2");
});

test("P0-5 pick：没有 GeneralUser 时退而求其次找名字像 GM 的", () => {
  assert.equal(pickDefaultSoundfont([{ id: "GM.sf2", path: "/x/GM.sf2" }]).id, "GM.sf2");
  assert.equal(pickDefaultSoundfont([{ id: "General Midi.sf2", path: "/x/General Midi.sf2" }]).id, "General Midi.sf2");
  assert.equal(pickDefaultSoundfont([{ id: "xg.sf2", path: "/x/xg.sf2" }]), null, "只有 xg 不算 GM");
});

test("P0-5 pick：缺 path / 非 sf2 / 空列表都安全返回 null", () => {
  assert.equal(pickDefaultSoundfont([]), null);
  assert.equal(pickDefaultSoundfont(null), null);
  assert.equal(pickDefaultSoundfont([{ id: "GeneralUser.sf2" }]), null, "没有 path 不能加载");
  assert.equal(pickDefaultSoundfont([{ id: "GeneralUser.sf3", path: "/x/GeneralUser.sf3" }]), null, "sf3 不在默认 GM 范围");
});

test("P0-5 shouldLazyLoad：明确关掉就不加载", () => {
  assert.equal(shouldLazyLoadDefaultGm({ defaultGmFlag: "0", explicitSource: "internal" }), false);
  assert.equal(shouldLazyLoadDefaultGm({ defaultGmFlag: "1", explicitSource: "internal" }), true);
  assert.equal(shouldLazyLoadDefaultGm({ explicitSource: null, defaultGmFlag: null }), true, "首次启动（无任何标记）默认加载");
});

test("P0-5 shouldLazyLoad：用户显式选了别的音色就不抢", () => {
  assert.equal(shouldLazyLoadDefaultGm({ explicitSource: "C:/sf/piano.sf2", defaultGmFlag: "1" }), false);
  assert.equal(shouldLazyLoadDefaultGm({ explicitSource: "internal", defaultGmFlag: null }), true);
  assert.equal(shouldLazyLoadDefaultGm({}), true);
});

test("P0-5 defaultGmFlagOf：设置值 → localStorage 标记", () => {
  assert.equal(defaultGmFlagOf(true), "1");
  assert.equal(defaultGmFlagOf(undefined), "1");
  assert.equal(defaultGmFlagOf(false), "0");
});
