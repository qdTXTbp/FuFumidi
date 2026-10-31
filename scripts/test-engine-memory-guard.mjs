import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { createEngineService } from '../main/engine.js';

test('Issue #35：低内存 + Aria CUDA 在提交前被拒绝', async () => {
  const oldTotal = os.totalmem, oldFree = os.freemem;
  try {
    os.totalmem = () => 8 * 1024 ** 3;
    os.freemem = () => 2 * 1024 ** 3;
    const svc = createEngineService({ resolvePython: () => process.execPath, engineDir: process.cwd(), engineEnv: () => ({}) });
    await assert.rejects(
      svc.engineWorkerConvert({ audio: 'a.wav', out: 'a.mid', mode: 'piano', model: 'aria' }),
      /蓝屏|DPC_WATCHDOG|低内存/
    );
  } finally { os.totalmem = oldTotal; os.freemem = oldFree; }
});

test('Issue #35：可用内存极低时所有转录在提交前被拒绝', async () => {
  const oldTotal = os.totalmem, oldFree = os.freemem;
  try {
    os.totalmem = () => 8 * 1024 ** 3;
    os.freemem = () => 0.8 * 1024 ** 3;
    const svc = createEngineService({ resolvePython: () => process.execPath, engineDir: process.cwd(), engineEnv: () => ({}) });
    await assert.rejects(
      svc.engineWorkerConvert({ audio: 'a.wav', out: 'a.mid', mode: 'universal', model: 'basic' }),
      /可用内存|1.5 GB|蓝屏/
    );
  } finally { os.totalmem = oldTotal; os.freemem = oldFree; }
});
