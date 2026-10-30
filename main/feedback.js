// ============================================================
// 问题反馈：收集 → 脱敏 → 打包 → 上传（主进程）
//
// 分工（**脱敏与模板都在已验证的纯函数里**）：
//   main/feedback-format.js   纯函数：slug / 文件名 / md 模板 / 脱敏（有 9 项单测）
//   engine/feedback_bundle.py 打包 zip + **诊断包在进包的路上脱敏**（有 4 项单测）
//   本文件只做接线：调引擎、拼字段、POST worker、失败兜底
//
// 三条出路，任何一条都不能把用户写的东西丢掉：
//   ① 上传到仓库（worker /feedback，写权限在服务端）
//   ② 存到本地 zip（拖进 Issue / 发邮件都行）
//   ③ 复制 md 到剪贴板 / 打开预填的 issue 页（沿用改版前的做法）
// ============================================================
'use strict';

const os = require('os');

function registerFeedbackIpc({ ipcMain, dialog, BrowserWindow, app, path, fs, spawnEngine, net, readSettings }) {
  const F = require('./feedback-format');

  /** 反馈通道候选地址，按顺序试，某一个不通用下一个。
   *
   *  ★ 平台选型是**实测**出来的（详见 docs/feedback-repo/README.md）：
   *    · `*.workers.dev`：**SNI 阻断**，不只是 DNS 污染 —— 用 DoH 拿到真实 CF IP 后带正确
   *      SNI 直连，三个 IP 全部在 TLS 握手时被 RST。所以它已经从候选里删掉：留着只会
   *      白等 15 秒超时，没有任何成功率。
   *    · Deno Deploy：Cloudflare 收购 Deno 团队后**已停服**，新账号注册 403。
   *    · **Netlify**：`*.netlify.app` 实测未被阻断（404 / 0.49 秒），是当前主通道。
   *    · `fusync.de5.net`：协作者的云同步 worker，CN 实测 3.7 秒可达 —— 反馈路由还没
   *      部署上去（现在返回 401），部署后它就是国内更快的那条。
   *
   *  （Netlify Functions 的默认路径形态 `/.netlify/functions/feedback` 实测 **404** —— 自定义路径
   *    已生效，所以那条候选已删，不留无用请求。） */
  const BASES = [
    'https://fufumidi-feedback.netlify.app',
    'https://fusync.de5.net',
  ];
  const BASE_TIMEOUT_MS = 15000;   // 被墙的域名会一直挂着，给它 15 秒就换下一个

  function settingsPath() {
    try {
      const s = typeof readSettings === 'function' ? readSettings() : null;
      if (s && typeof s === 'object' && s.__path) return String(s.__path);
    } catch (e) { /* 忽略 */ }
    const env = process.env.FUFUMIDI_SETTINGS_PATH;
    return env && fs.existsSync(env) ? env : '';
  }

  /** 稳定安装 id：随机 UUID，只用于限流与去重，不含任何身份信息 */
  function installId() {
    const p = path.join(app.getPath('userData'), 'install-id');
    try {
      const v = fs.readFileSync(p, 'utf8').trim();
      if (/^[a-f0-9-]{16,}$/i.test(v)) return v;
    } catch (e) { /* 还没有 */ }
    const id = require('crypto').randomUUID();
    try { fs.writeFileSync(p, id, 'utf8'); } catch (e) { /* 写不了就用本次的 */ }
    return id;
  }

  function runEngine(args, script, timeoutMs = 120000) {
    return new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: '引擎超时' }); } }, timeoutMs);
      const fin = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
      try {
        spawnEngine(args, {
          script,
          onDone: (_code, r) => fin({ ok: true, result: (r && r.result) || null, raw: (r && r.out) || '' }),
          onError: (e) => fin({ ok: false, error: String(e) }),
        });
      } catch (e) { fin({ ok: false, error: String(e) }); }
    });
  }

  /** 体检报告（health.py，自带 redactor） */
  async function healthReport() {
    const r = await runEngine([], 'health.py', 180000);
    if (!r.ok) return { ok: false, text: '', error: r.error };
    const res = r.result || {};
    return { ok: true, text: String(res.report_text || res.report || ''), raw: res };
  }

  /** 诊断包（diag.py → 原始 zip；脱敏在打包阶段做） */
  async function diagZip() {
    const p = path.join(app.getPath('temp'), 'fufumidi-feedback-diag-' + Date.now() + '.zip');
    const r = await runEngine(['-o', p], 'diag.py', 180000);
    if (!r.ok || !fs.existsSync(p)) return { ok: false, error: r.error || '诊断包生成失败' };
    return { ok: true, path: p, bytes: fs.statSync(p).size };
  }

  function ctxFor(fields, opts = {}) {
    const cpus = os.cpus() || [];
    let gpu = '';
    try {
      const list = (fields && fields.gpuList) || [];
      gpu = list.filter(Boolean).slice(0, 2).join(' / ');
    } catch (e) { /* 忽略 */ }
    return {
      id: opts.id,
      createdAt: new Date().toISOString(),
      appVersion: String(app.getVersion() || ''),
      build: String(process.env.FUFUMIDI_BUILD || ''),
      os: os.platform() + ' ' + os.release() + ' (' + os.arch() + ')',
      cpu: (cpus[0] && cpus[0].model) || '',
      gpu,
      mem: Math.round(os.totalmem() / 1073741824) + ' GB',
      install: app.isPackaged ? '安装版' : '开发版',
      installId: installId(),
      healthReport: opts.healthReport || '',
      hasDiagnostic: !!opts.hasDiagnostic,
      attachments: opts.attachments || [],
      source: 'app',
    };
  }

  async function buildAll(fields, opts = {}) {
    const f = fields || {};
    const id = F.feedbackId(new Date(), require('crypto').randomBytes(3).toString('hex'));
    const wantDiag = !!opts.includeDiagnostic;
    const [health, diag] = await Promise.all([
      healthReport(),
      wantDiag ? diagZip() : Promise.resolve({ ok: false, skipped: true }),
    ]);
    const host = os.hostname();
    const user = (os.userInfo && os.userInfo().username) || '';
    const sanitizeOpts = { hostname: host, username: user };
    // 体检报告已经自带 redactor，这里再兜一次（防御式：rules 变了这里仍然拦得住）
    const report = health.ok ? F.sanitizeText(health.text, sanitizeOpts) : '';
    const attachments = [];
    if (diag.ok) attachments.push({ name: 'diagnostic.zip', bytes: diag.bytes, path: diag.path });
    const ctx = ctxFor(f, { id, healthReport: report, hasDiagnostic: !!diag.ok, attachments });
    const markdown = F.sanitizeText(F.buildMarkdown(f, ctx), sanitizeOpts);
    return { id, markdown, filePath: F.fileNameFor(id, f.title, f.kind), health: report, diag, ctx, sanitizeOpts };
  }

  // 预览：只生成，不落盘、不上传（用户点「查看将要上传的内容」）
  ipcMain.handle('feedback:preview', async (_e, payload) => {
    try {
      const { fields, includeDiagnostic } = payload || {};
      const b = await buildAll(fields, { includeDiagnostic });
      return {
        ok: true, id: b.id, markdown: b.markdown, path: b.filePath,
        attachments: b.ctx.attachments.map((a) => ({ name: a.name, bytes: a.bytes })),
        healthOk: !!b.health,
      };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // 本地打包（失败兜底 / 手动提交）
  ipcMain.handle('feedback:saveLocal', async (evt, payload) => {
    try {
      const win = BrowserWindow.fromWebContents(evt.sender);
      const { fields, includeDiagnostic } = payload || {};
      const b = await buildAll(fields, { includeDiagnostic });
      const r = await dialog.showSaveDialog(win, {
        title: '保存反馈包',
        defaultPath: path.join(app.getPath('downloads'), 'fufumidi-feedback-' + b.id + '.zip'),
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      const mdPath = path.join(app.getPath('temp'), 'fufumidi-feedback-' + b.id + '.md');
      fs.writeFileSync(mdPath, b.markdown, 'utf8');
      const repPath = path.join(app.getPath('temp'), 'fufumidi-feedback-report-' + b.id + '.md');
      if (b.health) fs.writeFileSync(repPath, b.health, 'utf8');
      const res = await runEngine(['--out', r.filePath, '--md', mdPath,
        '--report', b.health ? repPath : '', '--diag', b.diag.ok ? b.diag.path : ''], 'feedback_bundle.py', 180000);
      try { fs.rmSync(mdPath, { force: true }); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      try { fs.rmSync(repPath, { force: true }); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      if (!res.ok || !(res.result && res.result.ok)) return { ok: false, error: (res.result && res.result.error) || res.error || '打包失败' };
      return { ok: true, path: r.filePath, bytes: res.result.bytes, entries: res.result.entries, stripped: res.result.stripped };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // 上传（worker 持有写仓库的令牌；客户端只 POST）
  ipcMain.handle('feedback:submit', async (_e, payload) => {
    try {
      const { fields, includeDiagnostic, turnstile, createIssue } = payload || {};
      const b = await buildAll(fields, { includeDiagnostic });
      const body = {
        installId: b.ctx.installId,
        kind: fields && fields.kind, area: fields && fields.area, severity: fields && fields.severity,
        title: fields && fields.title, filePath: b.filePath, md: b.markdown,
        createIssue: createIssue !== false,
        turnstile: turnstile || '',
        attachments: [],
      };
      if (b.diag.ok) {
        body.attachments.push({ name: 'diagnostic.zip', b64: fs.readFileSync(b.diag.path).toString('base64') });
      }
      let lastErr = '';
      for (const base of BASES) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } }, BASE_TIMEOUT_MS);
        try {
          const res = await net.fetch(base + '/feedback', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            signal: ctrl.signal,
          });
          clearTimeout(timer);
          const j = await res.json().catch(() => null);
          if (res.ok && j && j.ok) {
            if (b.diag.ok) { try { fs.rmSync(b.diag.path, { force: true }); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } }
            return { ok: true, id: j.id, url: j.url, path: j.path, issue: j.issue || null };
          }
          lastErr = (j && j.error) || ('HTTP ' + res.status);
          if (res.status === 429 || res.status === 413 || res.status === 400) break;   // 这些重试也没用
        } catch (e) { clearTimeout(timer); lastErr = String((e && e.message) || e); }
      }
      // 上传失败：**自动兜一份到本地**，用户不至于白填
      const local = path.join(app.getPath('downloads'), 'fufumidi-feedback-' + b.id + '.zip');
      const mdPath = path.join(app.getPath('temp'), 'fufumidi-feedback-' + b.id + '.md');
      fs.writeFileSync(mdPath, b.markdown, 'utf8');
      const repPath = path.join(app.getPath('temp'), 'fufumidi-feedback-report-' + b.id + '.md');
      if (b.health) fs.writeFileSync(repPath, b.health, 'utf8');
      const packed = await runEngine(['--out', local, '--md', mdPath,
        '--report', b.health ? repPath : '', '--diag', b.diag.ok ? b.diag.path : ''], 'feedback_bundle.py', 180000);
      try { fs.rmSync(mdPath, { force: true }); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      try { fs.rmSync(repPath, { force: true }); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      return { ok: false, error: lastErr || '上传失败', savedLocal: !!(packed.ok && packed.result && packed.result.ok), localPath: local, markdown: b.markdown };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  /** 网页兜底：把 md 变成 GitHub「新建文件」页（路径 + 内容都预填） */
  ipcMain.handle('feedback:webFallback', async (_e, payload) => {
    try {
      const { fields, includeDiagnostic } = payload || {};
      const b = await buildAll(fields, { includeDiagnostic });
      const repo = 'qdTXTbp/FuFumidi-Feedback';
      const url = 'https://github.com/' + repo + '/new/main?filename=' + encodeURIComponent(b.filePath)
        + '&value=' + encodeURIComponent(b.markdown.slice(0, 6000));
      return { ok: true, url, markdown: b.markdown, path: b.filePath };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  return { installId };
}

module.exports = { registerFeedbackIpc };
