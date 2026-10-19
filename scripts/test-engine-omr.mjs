#!/usr/bin/env node
// P1-4 引擎 OMR 测试运行器：找一个带 pytest 的 Python 跑 engine/tests/test_omr*.py
// 用法：node scripts/test-engine-omr.mjs
//   环境变量 FUFUMIDI_TEST_PYTHON 可指定解释器；找不到 pytest 时打印跳过并退出 0
//   （仓库发布包不带 pytest，只有开发环境/CI 才跑；门禁不给普通用户制造依赖）
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANDIDATES = [
  process.env.FUFUMIDI_TEST_PYTHON,
  'E:/Midi/_attic/envs/engine-test/Scripts/python.exe',
  'E:/Midi/FuFumidi/resources/python/python.exe',
  'python',
  'py',
].filter(Boolean);

function hasPytest(exe) {
  try {
    const r = spawnSync(exe, ['-c', 'import pytest; print(pytest.__version__)'], { encoding: 'utf8', timeout: 30000 });
    return r.status === 0 && String(r.stdout).trim().length > 0;
  } catch (e) { return false; }
}

const exe = CANDIDATES.find(hasPytest);
if (!exe) {
  console.log('跳过引擎 OMR 测试：没有找到带 pytest 的 Python（设置 FUFUMIDI_TEST_PYTHON 或用开发环境）');
  process.exit(0);
}
const r = spawnSync(exe, ['-m', 'pytest', 'engine/tests/test_omr.py', 'engine/tests/test_omr_backends.py', 'engine/tests/test_align_sofa.py', 'engine/tests/test_segment_options.py', '-q'], {
  cwd: ROOT, encoding: 'utf8', timeout: 10 * 60 * 1000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
});
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
if (r.status !== 0) {
  console.error('引擎 OMR 测试失败（退出码 ' + r.status + '）');
  process.exit(r.status || 1);
}
console.log('引擎 OMR/对齐测试通过（' + exe + '）');
