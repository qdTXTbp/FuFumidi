// 模型候选源排序（国内 CNB / 国外 GitHub 双端）的单元测试。
// 不联网：只断言「地址怎么排」，真实下载行为由 scripts/test-fast-download.mjs 覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mirrorUrls } = require('../main/model-sources.js');
const DS = require('../main/download-source.js');

// 与 main/models.js 里 beat_this 条目一致（改条目时这里要跟着改）
const GH_RAW = 'https://raw.githubusercontent.com/monologue82/Models/main/beat_this/beat_this-final0.ckpt';
const CNB_RAW = DS.cnbRepoRawUrl(DS.CNB_MIRROR_REPOS.models, 'main', 'beat_this/beat_this-final0.ckpt');
const BEAT_THIS = { url: GH_RAW, mirrors: [CNB_RAW] };

test('beat_this：默认（自动）国内源排第一，国外源仍在候选里', () => {
  const urls = mirrorUrls(BEAT_THIS, { source: 'auto' });
  assert.equal(urls[0], CNB_RAW);
  assert.ok(urls.includes(GH_RAW), '必须保留 GitHub 原始地址作兜底');
  assert.ok(urls.some((u) => u === 'https://ghfast.top/' + GH_RAW), 'GitHub 加速前缀要带上');
  assert.equal(new Set(urls).size, urls.length, '不允许重复地址');
});

test('beat_this：下载源选「全球」时 GitHub 排第一，国内仍可回落', () => {
  const urls = mirrorUrls(BEAT_THIS, { source: 'github' });
  assert.equal(urls[0], GH_RAW);
  assert.ok(urls.indexOf(CNB_RAW) > 0);
});

test('beat_this：下载源选「国内」时 CNB 排第一', () => {
  const urls = mirrorUrls(BEAT_THIS, { source: 'cnb' });
  assert.equal(urls[0], CNB_RAW);
});

test('CNB 地址只声明一次（raw 推导 + mirrors 重复给也不会出现两条）', () => {
  const urls = mirrorUrls(BEAT_THIS, { source: 'auto' });
  assert.equal(urls.filter((u) => u === CNB_RAW).length, 1);
});

test('未显式给 mirrors 时，自有 Models 仓库的 raw 仍能推导出国内镜像', () => {
  const urls = mirrorUrls({ url: GH_RAW }, { source: 'auto' });
  assert.equal(urls[0], CNB_RAW);
});

test('Release 资产条目（hFT 式写法）：mirrors=国内，按设置换头', () => {
  const gh = 'https://github.com/monologue82/Models/releases/download/models-extra-v1/hft-transformer-ismir2023.zip';
  const cnb = DS.cnbRepoReleaseUrl(DS.CNB_MIRROR_REPOS.models, 'models-extra-v1', 'hft-transformer-ismir2023.zip');
  const spec = { url: gh, mirrors: [cnb] };
  assert.equal(mirrorUrls(spec, { source: 'auto' })[0], cnb);
  assert.equal(mirrorUrls(spec, { source: 'github' })[0], gh);
});

test('第三方主源（zenodo 之类）不会被套上 gh 前缀，国内 mirrors 依然优先', () => {
  const spec = {
    url: 'https://zenodo.org/record/4034264/files/model.pth?download=1',
    mirrors: [CNB_RAW],
  };
  const urls = mirrorUrls(spec, { source: 'auto' });
  assert.equal(urls[0], CNB_RAW);
  assert.ok(urls.includes(spec.url));
  assert.ok(!urls.some((u) => u.includes('ghfast.top/')), '非 GitHub 地址不应被加速前缀改写');
});

test('只有 mirrors 没有 url 的旧条目也能按偏好排', () => {
  const urls = mirrorUrls({ mirrors: [GH_RAW, CNB_RAW] }, { source: 'github' });
  assert.equal(urls[0], GH_RAW);
  assert.equal(mirrorUrls({ mirrors: [GH_RAW, CNB_RAW] }, { source: 'auto' })[0], CNB_RAW);
});

test('没配任何地址时返回空数组（调用方会抛「没有可用的下载地址」）', () => {
  assert.deepEqual(mirrorUrls({}, { source: 'auto' }), []);
});

test('非法 source 按 auto 处理（不抛错）', () => {
  const urls = mirrorUrls(BEAT_THIS, { source: 'nonsense' });
  assert.equal(urls[0], CNB_RAW);
});
