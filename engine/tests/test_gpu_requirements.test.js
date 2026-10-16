// 清单自检：torch / torchaudio / torchvision 的版本必须两两对齐（构建标签也要一致）。
// 用户实测过的故障：DirectML 清单缺 torchaudio → 设备上留下主环境的 2.11 版 → torch 2.4.1 加载 DLL 失败（WinError 127）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 本文件在 engine/tests/ 下，仓库根要往上两级
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const files = ['requirements-gpu-cuda.txt', 'requirements-gpu-directml.txt', 'requirements-gpu-xpu.txt'];
const ver = (txt, name) => {
  const m = new RegExp('^' + name + '==([^\\s#]+)', 'm').exec(txt);
  return m ? m[1] : null;
};
const core = (v) => (v || '').split('+')[0];
const tag = (v) => (v || '').split('+')[1] || '';

for (const f of files) {
  test(f + '：torch 系三个包的版本与构建标签必须一致', () => {
    const txt = fs.readFileSync(path.join(root, 'engine', f), 'utf8');
    const t = ver(txt, 'torch');
    assert.ok(t, f + ' 缺 torch 行');
    // torchaudio **必须**与 torch 同版本同构建（这是 WinError 127 的直接成因）
    const ta = ver(txt, 'torchaudio');
    assert.ok(ta, f + ' 缺 torchaudio 声明：设备上会留下主环境的旧版，torch 加载 DLL 直接失败');
    assert.equal(core(ta), core(t), f + ' 的 torchaudio 版本应与 torch 完全一致：' + ta + ' vs ' + t);
    if (tag(t)) assert.equal(tag(ta), tag(t), f + ' 的 torchaudio 构建标签应与 torch 一致（否则装到 CPU 轮子）：' + ta + ' vs ' + t);
    // torchvision 版本号**本来就与 torch 不同**（2.4.1 ↔ 0.19.1 才是正确配对），只校验构建标签
    const tv = ver(txt, 'torchvision');
    if (tv && tag(t)) assert.equal(tag(tv), tag(t), f + ' 的 torchvision 构建标签应与 torch 一致：' + tv + ' vs ' + t);
  });
  test(f + '：必须声明 transformers（部分识别模型依赖）', () => {
    const txt = fs.readFileSync(path.join(root, 'engine', f), 'utf8');
    assert.match(txt, /^transformers[>=<]/m, f + ' 缺 transformers 声明');
  });
}
