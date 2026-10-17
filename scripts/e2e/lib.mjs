// ============================================================
// E2E 基础设施（v6.0.0 · P1-13/P1-14 的验收依赖）
//
// 设计取舍：不引入 Playwright（多一个 ~300MB 依赖 + 与 Electron 版本绑定）。
// 这里直接走 Electron 自带的 CDP：spawn `electron .` + --remote-debugging-port，
// 用 Node 22 的全局 WebSocket 做 Runtime.evaluate / Input.dispatchKeyEvent / Page.captureScreenshot。
// 好处：零新依赖、和现有 scripts/cdp/* 同一套协议、失败时能留下截图与应用日志。
//
// 关键约定：
//   · 只跑**开发态实例**（electron . + FUFUMIDI_E2E=1）：不抢用户正在用的安装版窗口，
//     数据根落在仓库下 FuFumidiData/（已 gitignore）；
//   · 用例里禁止写真实曲库/删除数据 —— 需要写盘的一律用 case 自己的临时目录；
//   · 每个用例一个全新实例，互不影响。
// ============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const ARTIFACTS = path.join(ROOT, "scripts", "e2e", "artifacts");
const ELECTRON = process.platform === "win32"
  ? path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")
  : path.join(ROOT, "node_modules", "electron", "dist", "electron");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function ensureArtifacts() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
}

function getJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    fetch(url, { signal: ac.signal })
      .then((r) => r.json())
      .then((j) => { clearTimeout(t); resolve(j); })
      .catch((e) => { clearTimeout(t); reject(e); });
  });
}

const VK = {
  Enter: 13, Escape: 27, Space: 32, Backspace: 8, Delete: 46, Tab: 9,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35,
  "=": 187, "-": 189, ",": 188, ".": 190, "/": 191,
};

function parseCombo(combo) {
  const parts = String(combo).split("+").map((s) => s.trim()).filter(Boolean);
  let modifiers = 0;
  const keys = [];
  for (const p of parts) {
    const low = p.toLowerCase();
    if (low === "ctrl" || low === "control") modifiers |= 2;
    else if (low === "shift") modifiers |= 8;
    else if (low === "alt") modifiers |= 1;
    else if (low === "meta" || low === "cmd" || low === "win") modifiers |= 4;
    else keys.push(p);
  }
  const key = keys[keys.length - 1] || "";
  let code = "";
  let vk = 0;
  if (/^[a-zA-Z]$/.test(key)) { code = "Key" + key.toUpperCase(); vk = key.toUpperCase().charCodeAt(0); }
  else if (/^\d$/.test(key)) { code = "Digit" + key; vk = key.charCodeAt(0); }
  else if (VK[key]) { code = key; vk = VK[key]; }
  else { code = key; vk = key ? key.toUpperCase().charCodeAt(0) : 0; }
  return { key, code, vk, modifiers };
}

class Harness {
  constructor(port, child, logFile) {
    this.port = port;
    this.child = child;
    this.logFile = logFile;
    this.ws = null;
    this._id = 0;
    this._pending = new Map();
    this.exceptions = [];
    this.consoleErrors = [];
    this.steps = [];
  }

  async connect(timeoutMs = 60000) {
    const started = Date.now();
    let target = null;
    while (Date.now() - started < timeoutMs) {
      try {
        const list = await getJson(`http://127.0.0.1:${this.port}/json/list`);
        target = (Array.isArray(list) ? list : []).find((t) => t.type === "page" && !/devtools/i.test(t.url || ""));
        if (target && target.webSocketDebuggerUrl) break;
      } catch (_) { /* 应用还没起来 */ }
      await sleep(300);
    }
    if (!target) throw new Error(`CDP 目标在 ${timeoutMs}ms 内没出现（端口 ${this.port}，日志 ${this.logFile}）`);
    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("CDP WebSocket 连接超时")), 15000);
      this.ws.onopen = () => { clearTimeout(t); res(); };
      this.ws.onerror = (e) => { clearTimeout(t); rej(new Error("CDP WebSocket 连接失败")); };
    });
    this.ws.onmessage = (ev) => this._onMessage(ev);
    await this.send("Runtime.enable");
    await this.send("Log.enable");
    await this.send("Page.enable");
    return this;
  }

  _onMessage(ev) {
    let m = null;
    try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.id && this._pending.has(m.id)) {
      const { res, rej, timer } = this._pending.get(m.id);
      clearTimeout(timer);
      this._pending.delete(m.id);
      if (m.error) rej(new Error(`${m.error.message || "CDP error"} (${m.error.code})`));
      else res(m.result);
      return;
    }
    if (m.method === "Runtime.exceptionThrown") {
      const d = (m.params && m.params.exceptionDetails) || {};
      this.exceptions.push({
        text: (d.exception && (d.exception.description || d.exception.value)) || d.text || "unknown",
        url: d.url || "", line: d.lineNumber,
      });
    } else if (m.method === "Log.entryAdded") {
      const e = m.params && m.params.entry;
      if (e && e.level === "error") this.consoleErrors.push({ text: e.text, url: e.url || "" });
    } else if (m.method === "Runtime.consoleAPICalled") {
      const p = m.params || {};
      if (p.type === "error") {
        const text = (p.args || []).map((a) => a.value != null ? String(a.value) : (a.description || "")).join(" ");
        this.consoleErrors.push({ text, url: "" });
      }
    }
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (!this.ws) return Promise.reject(new Error("CDP 未连接"));
    const id = ++this._id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this._pending.delete(id); rej(new Error(`CDP ${method} 超时 ${timeoutMs}ms`)); }, timeoutMs);
      this._pending.set(id, { res, rej, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expr, { timeoutMs = 30000 } = {}) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr, returnByValue: true, awaitPromise: true, timeout: timeoutMs,
    }, timeoutMs + 5000);
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails.exception ? (r.exceptionDetails.exception.description || r.exceptionDetails.exception.value) : r.exceptionDetails.text;
      throw new Error("页面内异常：" + String(d).split("\n")[0]);
    }
    return r && r.result ? r.result.value : undefined;
  }

  async waitFor(expr, { timeout = 15000, interval = 120, message = "" } = {}) {
    const started = Date.now();
    let lastErr = null;
    while (Date.now() - started < timeout) {
      try {
        const v = await this.eval(`!!(${expr})`);
        if (v) return true;
      } catch (e) { lastErr = e; }
      await sleep(interval);
    }
    throw new Error("waitFor 超时" + (message ? "：" + message : "") + " — " + expr + (lastErr ? "（最后错误：" + lastErr.message + "）" : ""));
  }

  async clickText(text, { includes = true } = {}) {
    const q = JSON.stringify(String(text));
    const mode = includes ? "includes" : "===";
    const r = await this.eval(`(() => {
      const t = ${q};
      const sel = "button,a,[role=button],.nav-item,.side-item,.view-tab,li,span,div";
      const cands = Array.from(document.querySelectorAll(sel));
      const hits = cands.filter((el) => {
        const s = (el.innerText || el.textContent || "").trim();
        if (!s || s.length > 60) return false;
        return ${mode === "includes" ? "s.includes(t)" : "s === t"};
      });
      if (!hits.length) return null;
      const el = hits[0];
      el.click();
      return { tag: el.tagName, text: (el.innerText || el.textContent || "").trim().slice(0, 60) };
    })()`);
    return r;
  }

  async click(selector) {
    const r = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click(); return true;
    })()`);
    if (!r) throw new Error("click 找不到元素：" + selector);
    return true;
  }

  async key(combo) {
    const k = parseCombo(combo);
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: k.modifiers };
    await this.send("Input.dispatchKeyEvent", Object.assign({ type: "rawKeyDown" }, base));
    await this.send("Input.dispatchKeyEvent", Object.assign({ type: "keyUp" }, base));
  }

  async type(text) {
    await this.send("Input.insertText", { text: String(text) });
  }

  async screenshot(name) {
    ensureArtifacts();
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    const p = path.join(ARTIFACTS, `${Date.now()}-${name}.png`);
    fs.writeFileSync(p, Buffer.from(r.data, "base64"));
    return p;
  }

  async navigate(hash) {
    await this.eval(`location.hash = ${JSON.stringify(hash)}`);
  }

  assert(cond, message) {
    this.steps.push({ ok: !!cond, message });
    if (!cond) throw new Error("断言失败：" + message);
  }

  async close() {
    try { if (this.ws) this.ws.close(); } catch (_) {}
    try {
      if (process.platform === "win32" && this.child.pid) {
        const { execFileSync } = await import("node:child_process");
        execFileSync("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], { stdio: "ignore" });
      } else if (this.child.pid) {
        this.child.kill("SIGKILL");
      }
    } catch (_) {}
    await sleep(250);
  }
}

export async function launchApp(opts = {}) {
  ensureArtifacts();
  const port = opts.port || (9400 + Math.floor(Math.random() * 400));
  if (!fs.existsSync(ELECTRON)) throw new Error("找不到 Electron：" + ELECTRON);
  const logFile = path.join(ARTIFACTS, `app-${Date.now()}-${port}.log`);
  const out = fs.createWriteStream(logFile, { flags: "a" });
  // ★ 数据根隔离（main/paths.js 的 FUFUMIDI_E2E_DATA_ROOT）：每次启动一个干净目录，
  //   绝不读/写用户真实曲库、模型与自动保存草稿。目录在 artifacts 下（已 gitignore）。
  const dataRoot = path.join(ARTIFACTS, "data-" + port);
  try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(dataRoot, { recursive: true });
  const args = [ROOT, `--remote-debugging-port=${port}`];
  if (Array.isArray(opts.args)) args.push(...opts.args);
  const child = spawn(ELECTRON, args, {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      FUFUMIDI_E2E: "1",
      FUFUMIDI_E2E_DATA_ROOT: dataRoot,
    }, opts.env || {}),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  const app = new Harness(port, child, logFile);
  app.dataRoot = dataRoot;
  try {
    await app.connect(opts.connectTimeoutMs || 60000);
  } catch (e) {
    await app.close();
    throw e;
  }
  return app;
}

export { sleep };