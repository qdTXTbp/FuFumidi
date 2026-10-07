'use strict';
// 插件沙箱的**唯一定义**：内置模块白名单/黑名单 + 注入插件上下文的全局对象。
//
// 为什么单独抽一个文件：这份常量原来在 plugin-host.js（进程内 vm）与 plugin-worker.js
// （worker 线程 vm）里各抄了一遍，而且已经漂移 —— host 的上下文给了 structuredClone，
// worker 的没给，于是「同一个插件在进程内跑 / 在 worker 里跑」行为不同。
// 两份常量必须只有一处定义，改一处就是改两处。
//
// 边界说明（别把 vm 当安全边界）：Node 的 vm 模块明确不是安全沙箱，这里的白/黑名单是
// 「卫生围栏」—— 拦的是插件作者的手滑，不是对抗性攻击。真正的隔离靠 worker 线程 + 进程边界。

const SANDBOX_ALLOWED_BUILTINS = new Set([
  'path', 'util', 'events', 'url', 'querystring', 'assert', 'os', 'crypto', 'buffer',
]);
const SANDBOX_DENIED_BUILTINS = new Set([
  'fs', 'child_process', 'net', 'http', 'https', 'dns', 'tls', 'worker_threads', 'cluster', 'repl', 'v8',
]);

/**
 * 生成插件 vm 上下文的全局对象。
 * @param {{ version?: string }} [opts] version 会出现在 plugin 看到的 process.version 里，
 *        用来区分「进程内沙箱」与「worker 沙箱」（调试时能看出插件跑在哪一侧）。
 */
function createSandboxGlobals(opts) {
  const version = (opts && opts.version) || 'sandbox';
  return {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    setImmediate, clearImmediate,
    queueMicrotask,
    Buffer,
    TextEncoder, TextDecoder,
    URL, URLSearchParams,
    structuredClone,
    JSON,
    Math,
    Date,
    process: {
      platform: process.platform,
      arch: process.arch,
      env: {},
      versions: {},
      version,
      pid: 0,
    },
  };
}

module.exports = { createSandboxGlobals, SANDBOX_ALLOWED_BUILTINS, SANDBOX_DENIED_BUILTINS };
