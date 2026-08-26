# FuFumidi 插件开发指南

> 完整双语版见 **`plugin-dev.html`**（在应用内「设置 → 插件 → 开发者文档」可直接打开）。
> 本文为快速索引。

FuFumidi 提供插件入口，第三方可在不改动主程序的情况下扩展功能。
插件 = 一个目录 + `plugin.json` 清单 + 入口脚本。插件由你主动安装，等同本地可信代码。

## 1. 安装位置

- **用户插件**（推荐）：`用户目录/fufumidi/plugins/<插件名>/`（Windows 一般位于
  `C:\Users\<你>\AppData\Roaming\fufumidi\fufumidi\plugins`，也可在应用内查看）
- **随应用内置**：`安装目录/resources/app/plugins/<插件名>/`

放好后，在「设置 → 插件」点「重新扫描」，再打开启用开关。

## 2. 最小结构

```
my-plugin/
  plugin.json
  index.js
```

`plugin.json`：

```json
{
  "id": "my-plugin",              // 唯一 ID：小写字母/数字/-/_，必填
  "name": "我的插件",              // 展示名
  "version": "1.0.0",
  "author": "作者",
  "description": "一句话说明",
  "entry": "index.js",            // 主进程入口，必填
  "renderer": "ui.js",            // 可选：注入到界面的脚本
  "commands": ["hello"]           // 可选：声明命令（设置页会列出按钮）
}
```

`index.js`（CommonJS）：

```js
module.exports = {
  activate(ctx) {
    ctx.commands.register('hello', async () => '你好');
  },
  deactivate() { /* 可选 */ }
};
```

## 3. 插件上下文 ctx 提供的 API

| 成员 | 说明 |
| :--- | :--- |
| `commands.register(name, fn)` | 注册命令，fn 返回 Promise/值，渲染层可调用 |
| `events.on(name, cb)` | 订阅应用事件，返回取消订阅函数 |
| `events.emit(name, payload)` | 广播事件（其它插件的同名监听也会收到） |
| `engine.run(args, {script, timeoutMs})` | 运行引擎 Python 脚本，返回 `{code,result,out,err}` |
| `settings.get(key)` / `settings.set(key, val)` | 插件私有持久化设置（存于 settings.json） |
| `ui.broadcast(name, payload)` | 通知渲染层脚本（其用 `fuplugin:<id>:<name>` 事件接收） |
| `ui.notify(text, type)` | 界面顶部 toast 提示 |
| `log(...)` | 输出到「设置 → 插件」日志区与主进程控制台 |
| `app.getSongMeta()` | 轻量歌曲信息 `{fileName, trackCount, totalTicks, totalSec, bpm}` |

## 4. 可订阅的应用事件

| 事件 | payload 摘要 |
| :--- | :--- |
| `song-loaded` | `{fileName, trackCount, totalTicks, totalSec, bpm}` |
| `view-changed` | 视图名（play/edit/transcribe/analyze/score/viz） |
| `transcribe-done` | `{ok, out, note_count, mode, perf}` |
| `refine-done` | `{ok, out, stats, mode}` |

## 5. 引擎脚本（扩展 AI 能力）

`engine.run(['mycmd', path, ...], { script: '/abs/path/或引擎目录内文件名' })`
复用主程序的 Python 环境解析、UTF-8 中文路径适配、超时与 `###RESULT` 解析。

约定：脚本在 stdout 输出一行 `###RESULT {json}`，`engine.run` 会把解析出的 JSON
放入 `result`。示例：把转录 MIDI 再处理一遍的插件，可在 `scripts/` 放自己的 .py 并调用。

## 6. 渲染层脚本（可选 renderer）

`ui.js` 会被注入界面环境，可操作 DOM、调用 `window.fuBridge`、`toast()`。
主进程插件通过 `ctx.ui.broadcast(name, payload)` 发消息，渲染脚本用：

```js
window.addEventListener('fuplugin:my-plugin:my-event', function (ev) {
  // ev.detail 为 payload
});
```

## 7. 安全与健壮性

- 单插件激活/命令/事件处理全部隔离，异常只记日志，不影响主程序。
- `engine.run` 带 30 分钟超时，插件内 Python 死循环会被强制终止。
- 未启用的插件不接收事件、不可调用命令。
- 插件等同本地可信代码：只安装你信任来源的插件。

示例插件见同目录 `example-hello/`。
