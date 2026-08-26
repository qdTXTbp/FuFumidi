// ============================================================
// plugin-host.js —— FuFumidi 插件宿主（主进程）
//
// 第三方插件结构（目录名不限，须含 plugin.json）：
//   <pluginsRoot>/<anyDir>/plugin.json
//   {
//     "id": "my-tool",                 // 唯一 ID（小写字母/数字/-/_）
//     "name": "我的工具",               // 展示名
//     "version": "1.0.0",
//     "author": "作者名",
//     "description": "一句话说明",
//     "entry": "index.js",             // 必填：CommonJS 入口，导出 activate(ctx)
//     "renderer": "ui.js",             // 可选：注入到界面执行的主脚本（浏览器环境）
//     "commands": ["cmd-a", "cmd-b"]   // 可选：声明可在界面触发的命令
//   }
//
// 插件入口（entry）：
//   module.exports = {
//     activate(ctx) { ctx.commands.register('hello', async (payload) => '你好'); },
//     deactivate()  { /* 可选：卸载清理 */ }
//   };
//
// ctx 提供受控 API：commands / events / engine / settings / ui / log / app。
// 隔离：单插件激活、命令、事件监听全部 try/catch，任何异常只记日志，不拖垮主进程。
// 引擎调用走统一 spawnEngine，带超时与结果解析，插件内死循环由超时兜底。
// ============================================================
const path = require('path');
const fs = require('fs');

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

class PluginHost {
  /**
   * @param {object} deps
   * @param {() => object} deps.getSettings       读取当前设置对象
   * @param {(s:object)=>object} deps.saveSettings 保存设置（返回合并后对象）
   * @param {(args:Array, opts:object)=>import('child_process').ChildProcess} deps.spawnEngine
   *        统一引擎子进程（已带超时/结果解析/中文路径适配）
   * @param {(channel:string, payload:any)=>void} deps.broadcast 发送到所有渲染窗口
   */
  constructor(deps) {
    this._get = deps.getSettings;
    // 重要：插件设置保存必须“读当前完整设置 → 合并 → 写回”，
    // 否则启动时插件激活会把 {plugins:...} 当成整份设置写盘，
    // 抹掉 guide_done / theme / lang 等所有应用设置（导致新手引导每次出现）。
    this._save = (s) => deps.saveSettings({ ...(deps.getSettings()), ...(s || {}) });
    this._spawnEngine = deps.spawnEngine;
    this._broadcast = deps.broadcast;
    this._dirs = [];            // 扫描根目录（用户目录优先）
    this._plugins = new Map();  // id -> 插件运行时
    this._listeners = new Map();// 预留
    this._songMeta = deps.getSongMeta || null;
    this._curId = null;         // _settingsObj 上下文辅助
  }

  /** 设置扫描根目录（先扫描的目录优先级更高） */
  setRoots(dirs) { this._dirs = dirs.filter(Boolean); }

  /** 重新扫描并加载全部插件（启用状态持久化在设置里） */
  loadAll() {
    const seen = new Set();
    for (const root of this._dirs) {
      if (!fs.existsSync(root)) continue;
      let entries = [];
      try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { continue; }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const dir = path.join(root, ent.name);
        try { this._loadPlugin(dir); seen.add(this._manifestId(dir)); }
        catch (e) { this._log('插件加载失败：' + dir + ' — ' + (e && e.message)); }
      }
    }
    // 清理：目录已消失的插件卸载
    for (const [id, pl] of this._plugins) {
      if (!seen.has(id)) { try { this._deactivate(pl); } catch (e) {} this._plugins.delete(id); }
    }
    return this.list();
  }

  /** 重播所有已加载插件的渲染脚本（供窗口 did-finish-load 后补发，避免启动时序丢失） */
  broadcastScripts() {
    for (const pl of this._plugins.values()) {
      if (!pl.enabled || !pl.manifest || !pl.manifest.renderer) continue;
      const rp = path.join(pl.dir, pl.manifest.renderer);
      if (!fs.existsSync(rp)) continue;
      try { this._broadcast('plugins:script', { id: pl.id, code: fs.readFileSync(rp, 'utf8') }); }
      catch (e) { this._log(`插件 ${pl.id} 渲染脚本重播失败：${e.message}`); }
    }
  }

  _manifestId(dir) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    return m.id;
  }

  _loadPlugin(dir) {
    const mfPath = path.join(dir, 'plugin.json');
    if (!fs.existsSync(mfPath)) return;
    const manifest = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
    if (!manifest || typeof manifest.id !== 'string' || !ID_RE.test(manifest.id)) {
      throw new Error('plugin.json 缺少合法 id');
    }
    if (this._plugins.has(manifest.id)) {
      return; // 同 ID 插件已加载（更高优先级目录），跳过
    }
    // 沙箱边界：插件目录必须在允许的根目录内，entry 不允许越界
    const pluginRoot = path.resolve(dir);
    const rootOk = this._dirs.some(root => {
      const r = path.resolve(root);
      return pluginRoot === r || pluginRoot.startsWith(r + path.sep);
    });
    if (!rootOk) throw new Error('插件目录不在允许的根目录内：' + dir);
    const entryPath = manifest.entry ? path.resolve(dir, manifest.entry) : null;
    if (entryPath && entryPath !== pluginRoot && !entryPath.startsWith(pluginRoot + path.sep)) {
      throw new Error('entry 路径越界：' + manifest.entry);
    }
    if (!entryPath || !fs.existsSync(entryPath)) throw new Error('entry 不存在：' + (manifest.entry || ''));
    const pl = {
      id: manifest.id,
      dir,
      manifest,
      enabled: this._enabledSet().has(manifest.id),
      commands: new Map(),
      listeners: [],
      ctx: null,
    };
    pl.ctx = this._makeCtx(pl);
    try {
      const mod = require(entryPath);
      if (mod && typeof mod.activate === 'function') mod.activate(pl.ctx);
      else if (typeof mod === 'function') mod(pl.ctx);
      else throw new Error('entry 需导出 activate(ctx) 或导出函数');
    } catch (e) {
      this._log(`插件 ${manifest.id} 激活失败：${e.message}`);
      return;
    }
    this._plugins.set(manifest.id, pl);
    if (manifest.renderer) {
      const rp = path.join(dir, manifest.renderer);
      if (fs.existsSync(rp)) {
        try { this._broadcast('plugins:script', { id: manifest.id, code: fs.readFileSync(rp, 'utf8') }); }
        catch (e) { this._log(`插件 ${manifest.id} 渲染脚本读取失败：${e.message}`); }
      }
    }
    this._log(`已加载插件：${manifest.name}（${manifest.id}）`);
  }

  _makeCtx(pl) {
    const m = pl.manifest;
    const self = this;
    const pluginSettings = () => {
      const s = self._get() || {};
      return (s.plugins && s.plugins[m.id]) || {};
    };
    return {
      id: pl.id,
      manifest: m,
      commands: {
        register(name, fn) { if (typeof fn === 'function') pl.commands.set(String(name), fn); },
        list() { return Array.from(pl.commands.keys()); },
      },
      events: {
        on(name, cb) {
          if (typeof cb !== 'function') return () => {};
          const l = { name, cb };
          pl.listeners.push(l);
          return () => { pl.listeners = pl.listeners.filter(x => x !== l); };
        },
        emit(name, payload) { self.emit(name, payload); },
      },
      engine: {
        /**
         * 运行引擎 Python 脚本。script 可为 engine/ 下文件名或绝对路径。
         * 返回 Promise<{ code, result, out, err }>（result 为 ###RESULT 解析对象）
         */
        run(args, opts = {}) {
          return new Promise((resolve) => {
            try {
              self._spawnEngine(args, {
                script: opts.script || 'music2midi.py',
                onLog: (line) => self._broadcast('plugins:log', { id: pl.id, line }),
                timeoutMs: opts.timeoutMs || 30 * 60 * 1000,
                onDone: (code, r) => resolve({ code, result: r.result, out: r.out, err: r.err }),
                onError: (e) => resolve({ code: -1, result: null, out: '', err: String(e) }),
              });
            } catch (e) { resolve({ code: -1, result: null, out: '', err: String(e) }); }
          });
        },
      },
      settings: {
        get(key) {
          const base = pluginSettings();
          return key ? (base[key] ?? undefined) : base;
        },
        set(key, val) {
          const s = self._get() || {};
          const base = pluginSettings();
          if (typeof key === 'object' && key !== null) Object.assign(base, key);
          else base[key] = val;
          self._save({ plugins: { ...(s.plugins || {}), [m.id]: base } });
          return { ...base };
        },
      },
      ui: {
        broadcast(name, payload) { self._broadcast('plugins:ui', { id: pl.id, name, payload }); },
        notify(text, type) { self._broadcast('plugins:ui', { id: pl.id, name: '__toast', payload: { text: String(text || ''), type: type || 'info' } }); },
      },
      log: (...args) => {
        const line = args.map(a => (typeof a === 'string' ? a : safeStr(a))).join(' ');
        self._broadcast('plugins:log', { id: pl.id, line });
      },
      app: {
        getSongMeta() { return self._songMeta ? self._songMeta() : null; },
      },
    };
  }

  /** 应用级事件广播到所有已启用插件 */
  emit(name, payload) {
    for (const pl of this._plugins.values()) {
      if (!pl.enabled) continue;
      for (const l of pl.listeners) {
        if (l.name !== name) continue;
        try { l.cb(payload); } catch (e) { this._log(`插件 ${pl.id} 处理事件 ${name} 出错：${e.message}`); }
      }
    }
  }

  _deactivate(pl) {
    try {
      if (pl.ctx && pl.manifest.entry) {
        const mod = require(require.resolve(path.join(pl.dir, pl.manifest.entry)));
        if (mod && typeof mod.deactivate === 'function') mod.deactivate();
      }
    } catch (e) { this._log(`插件 ${pl.id} 卸载出错：${e.message}`); }
  }

  // ---- 启用状态 ----
  _enabledSet() {
    const s = this._get() || {};
    const arr = Array.isArray(s.plugins_enabled) ? s.plugins_enabled : [];
    return new Set(arr);
  }
  setEnabled(id, enabled) {
    const pl = this._plugins.get(id);
    if (!pl) return false;
    const set = this._enabledSet();
    if (enabled) set.add(id); else set.delete(id);
    this._save({ plugins_enabled: Array.from(set) });
    pl.enabled = enabled;
    if (!enabled) { try { this._deactivate(pl); } catch (e) {} }
    return true;
  }

  // ---- 命令调用（来自渲染层） ----
  async invoke(id, command, payload) {
    const pl = this._plugins.get(id);
    if (!pl) return { ok: false, error: '插件不存在：' + id };
    if (!pl.enabled) return { ok: false, error: '插件未启用：' + id };
    const fn = pl.commands.get(String(command));
    if (typeof fn !== 'function') return { ok: false, error: '命令不存在：' + command };
    try {
      const r = await fn(payload);
      return { ok: true, result: r === undefined ? null : r };
    } catch (e) {
      this._log(`插件 ${id} 命令 ${command} 出错：${e.message}`);
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  list() {
    return Array.from(this._plugins.values()).map(pl => ({
      id: pl.id,
      name: pl.manifest.name || pl.id,
      version: pl.manifest.version || '',
      author: pl.manifest.author || '',
      description: pl.manifest.description || '',
      enabled: pl.enabled,
      commands: Array.from(pl.commands.keys()),
    }));
  }

  _log(line) {
    try { this._broadcast('plugins:log', { id: '*', line }); } catch (e) {}
    console.log('[plugins]', line);
  }
}

function safeStr(v) {
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

module.exports = PluginHost;
