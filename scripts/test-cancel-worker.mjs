// 回归钉子：「取消转录」必须同时能匹配 worker 路径的两本账。
//
// 背景（2026-10-14 用户实测）：点「取消转录」后转录照旧跑完。链路是
//   前端 cfg.id = "batch<N>" → engine:cancel → cancelJob(id)
// 但 worker 路径按**内部键** "w<N>" 记 _engineWorkerPending，前端 id 只存在 logId 里，
// 于是 get(id) 必然落空、返回 false、什么也没杀。
// 2026-07 修过一次"只查 spawn 路径"，这次是同一条链路上的第二处漏配 —— 所以钉在源码层：
// 只要有人把 logId 匹配删掉，这条就红。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../main/engine.js", import.meta.url), "utf8");
const cancelJob = src.slice(src.indexOf("function cancelJob("), src.indexOf("return {", src.indexOf("function cancelJob(")));

test("cancelJob 存在且会按 logId 反查（前端 id 只记在 logId 里）", () => {
  assert.ok(cancelJob.length > 200, "cancelJob 没找到或太短");
  assert.match(cancelJob, /ent\.logId === id/, "缺少 logId 匹配 —— 取消会再次落空");
  assert.match(cancelJob, /p\.child\.kill\(\)/, "缺少杀 worker 进程 —— 只 reject 不会让 python 停手");
});

test("取消不会被当成 worker 失败而回落到 spawn（否则会重跑整段）", () => {
  const tq2 = readFileSync(new URL("../main/task-queue.js", import.meta.url), "utf8");
  const i = tq2.indexOf("engineWorkerConvert(cfg)");
  const blk = tq2.slice(i, i + 600);
  assert.match(blk, /e\.canceled/, "回落分支没排除取消 —— 取消会重跑整段转录");
});

test("engine:cancel 处理器两条路径都问一次（spawn + worker）", () => {
  const tq = readFileSync(new URL("../main/task-queue.js", import.meta.url), "utf8");
  const h = tq.slice(tq.indexOf("ipcMain.handle('engine:cancel'"));
  assert.match(h, /convertChildren\.get\(id\)/, "没查 spawn 路径");
  assert.match(h, /cancelEngineJob\(id\)/, "没查 worker 路径");
});
