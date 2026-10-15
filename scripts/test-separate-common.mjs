// 分离参数构造的回归锁（scripts/test-separate-common.mjs）
// 目的：音频处理面板（engine:separate）与翻唱工作流必须走同一份参数构造与输出命名，
// 否则会出现「面板出一个文件名、工作流找另一个文件名」这种只在运行时才炸的错。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SepCommon = require('../main/separate-common.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sep-common-'));
const Paths = { tempDir: () => TMP, path };

test('输出命名与引擎产物一致（工作流按它查找）', () => {
  assert.deepEqual(SepCommon.outputNames('E:/a/b/src.flac', path), { vocals: 'src_Vocals.wav', instrumental: 'src_Instrumental.wav' });
  assert.deepEqual(SepCommon.outputNames('C:/x/下一个远方 (live).wav', path), { vocals: '下一个远方 (live)_Vocals.wav', instrumental: '下一个远方 (live)_Instrumental.wav' });
});

test('参数构造：模型/目录/开关逐项正确（batch 默认 1，避免长曲挤爆显存）', () => {
  const cfg = { audio: 'E:/song.flac', sep_model: 'v', out_dir: TMP, format: 'wav', tta: true, normalize: true, chunk_size: 1000, num_overlap: 2 };
  const resolveSeparateModel = () => ({ exists: true, modelPath: 'M.ckpt', configPath: 'C.yaml', arch: 'Mel-Band Roformer' });
  const r = SepCommon.buildSeparateRequest(cfg, { resolveSeparateModel, readSettings: () => ({}), Paths, fs });
  assert.equal(r.ok, true);
  assert.deepEqual(r.args, ['separate', 'E:/song.flac', '--output', TMP, '--model', 'M.ckpt', '--config', 'C.yaml',
    '--arch', 'Mel-Band Roformer', '--chunk-size', '1000', '--num-overlap', '2', '--batch-size', '1',
    '--format', 'wav', '--tta', '--normalize']);
  assert.deepEqual(r.names, { vocals: 'song_Vocals.wav', instrumental: 'song_Instrumental.wav' });
  assert.equal(r.model, 'v');
});

test('未安装分离模型 → 明确报错并指出去哪下（不跑到一半才炸）', () => {
  const r = SepCommon.buildSeparateRequest({ audio: 'a.flac', sep_model: 'x' },
    { resolveSeparateModel: () => ({ exists: false, error: '模型未下载，请先到模型管理下载' }), readSettings: () => ({}), Paths, fs });
  assert.equal(r.ok, false);
  assert.match(r.error, /未下载|资源中心/);
});

test('缺少音频 / 未知模型 / 缺配置 都给出可读错误', () => {
  const base = { resolveSeparateModel: () => null, readSettings: () => ({}), Paths, fs };
  assert.equal(SepCommon.buildSeparateRequest({}, base).ok, false);
  assert.equal(SepCommon.buildSeparateRequest({ audio: 'a.wav', sep_model: 'x' }, base).ok, false);
  const noCfg = { resolveSeparateModel: () => ({ exists: true, modelPath: 'm', configPath: '', arch: 'A' }), readSettings: () => ({}), Paths, fs };
  assert.match(SepCommon.buildSeparateRequest({ audio: 'a.wav', sep_model: 'x' }, noCfg).error, /配置文件/);
});

test('默认模型只挑「真能跑」的：没有 .yaml 的模型不许被选成默认', () => {
  const resolve = (id) => (id === 'no_cfg'
    ? { exists: true, modelPath: 'm', configPath: null, arch: 'Mel-Band Roformer' }
    : { exists: true, modelPath: 'm', configPath: 'c.yaml', arch: 'Mel-Band Roformer' });
  const reg = { no_cfg: { splitCat: 'vocal' }, melband_roformer_instvox_duality_v2: { splitCat: 'vocal' } };
  assert.equal(SepCommon.pickDefaultSepModel(reg, resolve), 'melband_roformer_instvox_duality_v2');
  // 全都跑不动 → 空串（上层给「还没安装分离模型」的提示，而不是选中一个点了就炸的）
  assert.equal(SepCommon.pickDefaultSepModel({ no_cfg: { splitCat: 'vocal' } }, resolve), '');
  // VR 家族不需要配置 → 仍然可用
  assert.equal(SepCommon.pickDefaultSepModel({ vr1: { splitCat: 'vr' } },
    () => ({ exists: true, modelPath: 'm', configPath: null, arch: 'UVR-VR' })), 'vr1');
  // 没传解析器时保持旧行为（老调用点）
  assert.equal(SepCommon.pickDefaultSepModel({ no_cfg: { splitCat: 'vocal' } }), 'no_cfg');
});

test('UVR-VR（去噪）模型不需要 yaml 配置也能跑 —— pymss 从权重里读结构与音轨名', () => {
  assert.equal(SepCommon.archNeedsConfig('UVR-VR'), false);
  assert.equal(SepCommon.archNeedsConfig('vr'), false);
  assert.equal(SepCommon.archNeedsConfig('Mel-Band Roformer'), true);
  assert.equal(SepCommon.archNeedsConfig('BS-Roformer'), true);
  const noCfgVr = { resolveSeparateModel: () => ({ exists: true, modelPath: 'U.pth', configPath: null, arch: 'UVR-VR' }), readSettings: () => ({}), Paths, fs };
  const r = SepCommon.buildSeparateRequest({ audio: 'E:/song.flac', sep_model: 'uvr_denoise', out_dir: TMP }, noCfgVr);
  assert.equal(r.ok, true);
  assert.equal(r.args.includes('--config'), false);            // 不能塞一个 null 进去
  assert.equal(r.args[r.args.indexOf('--arch') + 1], 'UVR-VR');
  // 有 config 的架构照旧传（顺序不变，翻唱工作流与面板共用同一份）
  const withCfg = { resolveSeparateModel: () => ({ exists: true, modelPath: 'm', configPath: 'c.yaml', arch: 'Mel-Band Roformer' }), readSettings: () => ({}), Paths, fs };
  const r2 = SepCommon.buildSeparateRequest({ audio: 'a.wav', sep_model: 'x', out_dir: TMP }, withCfg);
  assert.equal(r2.args[r2.args.indexOf('--config') + 1], 'c.yaml');
});

test('输出目录优先级：调用方 > 设置 > 与输入同目录', () => {
  const resolveSeparateModel = () => ({ exists: true, modelPath: 'm', configPath: 'c', arch: 'A' });
  const r1 = SepCommon.buildSeparateRequest({ audio: 'a.wav', sep_model: 'x', out_dir: TMP },
    { resolveSeparateModel, readSettings: () => ({ output_dir: 'Z:/nope' }), Paths, fs });
  assert.equal(r1.dir, TMP);
  const r2 = SepCommon.buildSeparateRequest({ audio: 'E:/Music/a.wav', sep_model: 'x' },
    { resolveSeparateModel, readSettings: () => ({}), Paths, fs });
  assert.equal(r2.dir.replace(/\\/g, '/'), 'E:/Music');
});

test('默认模型挑选：优先 duality v2', () => {
  const reg = { mel_band_roformer_vocals_becruily: { splitCat: 'vocal' }, melband_roformer_instvox_duality_v2: { splitCat: 'vocal' } };
  assert.equal(SepCommon.pickDefaultSepModel(reg), 'melband_roformer_instvox_duality_v2');
  assert.equal(SepCommon.pickDefaultSepModel({}), '');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 清理失败无所谓 */ } });
