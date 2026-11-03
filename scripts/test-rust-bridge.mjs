import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { createRustService } = require('../main/rust.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANDIDATES = [
  path.join(ROOT, 'crates/target/debug/fufumidi-engine.exe'),
  path.join(ROOT, 'crates/target/release/fufumidi-engine.exe'),
  path.join(ROOT, 'resources/rust-core/fufumidi-core.exe'),
];
const BIN = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });

function makeService(bin) {
  if (bin) process.env.FUFUMIDI_RUST_BIN = bin;
  const app = { getAppPath: () => ROOT };
  return createRustService({ app, path, fs });
}

test('探测：找到二进制并返回版本', async (t) => {
  if (!BIN) { t.skip('没有 Rust 二进制（先跑 cargo build --manifest-path crates/Cargo.toml）'); return; }
  const svc = makeService(BIN);
  assert.equal(svc.available(), true);
  const probe = await svc.probe();
  assert.equal(probe.available, true);
  assert.ok(probe.version, 'version 不能为空');
});

test('invoke：旧 CLI 命令仍可用（ping / midi-stats）', async (t) => {
  if (!BIN) { t.skip('没有 Rust 二进制'); return; }
  const svc = makeService(BIN);
  const ping = await svc.invoke(['ping']);
  assert.equal(ping.ok, true);
  const file = path.join(ROOT, 'engine/tests/quality/case1_melody.mid');
  const stats = await svc.invoke(['midi-stats', file]);
  assert.equal(stats.ok, true);
  assert.equal(stats.notes, 8);
});

test('显式路径不存在时优雅降级（不抛异常，返回 available 布尔）', async () => {
  // 仓库里通常还有 resources/rust-core/fufumidi-core.exe 兜底，所以这里不断言 false；
  // 只保证：坏路径不会让 probe 抛异常，且结果形状稳定（ok:true + available:boolean）。
  const svc = makeService(path.join(ROOT, 'does/not/exist/fufumidi-engine.exe'));
  const probe = await svc.probe();
  assert.equal(probe.ok, true);
  assert.equal(typeof probe.available, 'boolean');
});
