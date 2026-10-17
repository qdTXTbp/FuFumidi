// ============================================================
// P2-6 AI 生成（可选，默认关）——主进程 IPC
// ============================================================
// 不内置模型、不联网。生成能力来自用户自备的**本地命令**：
//   ai.provider_cmd（设置）或 FUFUMIDI_AI_CMD（环境变量）
// 契约（与 frontend/src/core/ai_generate.js 一致）：
//   <cmd> --job <job.json> --outdir <dir>
//   <dir>/result.json = { provider, model, files:[{ name, kind, bytes }] }
// 所有产出强制写 aiGenerated=true + 来源/时间/提示词指纹；没有标注的返回直接失败。
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const JOB_FORMAT = 'fufumidi-ai-job/v1';
const KINDS = new Set(['midi', 'audio', 'lyrics']);
const TIMEOUT_MS = 10 * 60 * 1000;

function settingsOf(readSettings) {
  let s = {};
  try { s = readSettings() || {}; } catch (e) { s = {}; }
  return s;
}

function statusOf(s) {
  const enabled = s['ai.enabled'] === true;
  const cmd = String(s['ai.provider_cmd'] || process.env.FUFUMIDI_AI_CMD || '').trim();
  if (!enabled) return { enabled: false, ready: false, code: 'disabled', reason: 'AI 生成默认关闭（设置 → 功能 → 专家模式里可打开）', kinds: [...KINDS] };
  if (!cmd) return { enabled: true, ready: false, code: 'not-configured', reason: '未配置本地生成命令', kinds: [...KINDS] };
  return { enabled: true, ready: true, code: 'ready', reason: '本地生成命令已配置', kinds: [...KINDS] };
}

function fnv1a(s) {
  let h = 0x811c9dc5;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ('00000000' + h.toString(16)).slice(-8);
}

function safeName(n) {
  const base = String(n == null ? '' : n).replace(/\\/g, '/').split('/').pop().trim();
  if (!base || base === '.' || base === '..' || /[\u0000-\u001f]/.test(base)) return '';
  return base.slice(0, 160);
}

function validateRequest(raw) {
  const kind = String((raw && raw.kind) || 'midi');
  if (!KINDS.has(kind)) return { ok: false, code: 'bad-kind', error: '不支持的生成类型' };
  const prompt = String((raw && raw.prompt) || '').trim();
  if (!prompt) return { ok: false, code: 'empty-prompt', error: '提示词不能为空' };
  if (prompt.length > 2000) return { ok: false, code: 'prompt-too-long', error: '提示词最长 2000 字' };
  const seed = Math.max(0, Math.min(0x7fffffff, Math.round(Number(raw && raw.seed) || 0)));
  return { ok: true, request: { kind, prompt, title: String((raw && raw.title) || '').trim().slice(0, 80), seed } };
}

function runCommand(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    let done = false;
    let out = '', err = '';
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      child = spawn(cmd, args, { shell: true, windowsHide: true, env: { ...process.env } });
    } catch (e) {
      finish({ code: -1, out: '', err: String(e && e.message || e), spawnError: true });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch (e) {} finish({ code: -1, out, err: err + '\nTimeout', timeout: true }); }, timeoutMs);
    child.stdout.on('data', (d) => { out += String(d); if (out.length > 200000) out = out.slice(-200000); });
    child.stderr.on('data', (d) => { err += String(d); if (err.length > 200000) err = err.slice(-200000); });
    child.on('error', (e) => { clearTimeout(timer); finish({ code: -1, out, err: err + '\n' + String(e && e.message || e), spawnError: true }); });
    child.on('close', (code) => { clearTimeout(timer); finish({ code: code == null ? -1 : code, out, err }); });
  });
}

function registerAiIpc({ ipcMain, app, readSettings }) {
  ipcMain.handle('ai:status', () => statusOf(settingsOf(readSettings)));

  ipcMain.handle('ai:generate', async (evt, raw) => {
    const s = settingsOf(readSettings);
    const st = statusOf(s);
    if (st.code !== 'ready') return { ok: false, code: st.code, error: st.reason };
    const v = validateRequest(raw);
    if (!v.ok) return v;
    const req = v.request;
    const createdAt = new Date().toISOString();
    const promptHash = fnv1a(req.kind + '\n' + req.prompt);
    const job = { format: JOB_FORMAT, kind: req.kind, prompt: req.prompt, title: req.title, seed: req.seed, createdAt, promptHash };
    const base = path.join(app.getPath('temp'), 'fufumidi-ai-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
    const outdir = path.join(base, 'out');
    let jobPath = '';
    try {
      fs.mkdirSync(outdir, { recursive: true });
      jobPath = path.join(base, 'job.json');
      fs.writeFileSync(jobPath, JSON.stringify(job, null, 2), 'utf8');
    } catch (e) {
      return { ok: false, code: 'io-error', error: '准备生成任务失败：' + String(e && e.message || e) };
    }
    const cmd = String(s['ai.provider_cmd'] || process.env.FUFUMIDI_AI_CMD || '').trim();
    const r = await runCommand(cmd, ['--job', jobPath, '--outdir', outdir], TIMEOUT_MS);
    if (r.spawnError) return { ok: false, code: 'spawn-error', error: '无法启动生成命令：' + String(r.err || '').slice(-400) };
    if (r.timeout) return { ok: false, code: 'timeout', error: '生成超时（10 分钟）' };
    if (r.code !== 0) return { ok: false, code: 'command-failed', error: '生成命令退出码 ' + r.code + '：' + String(r.err || r.out || '').slice(-400) };
    let result = null;
    try { result = JSON.parse(fs.readFileSync(path.join(outdir, 'result.json'), 'utf8')); }
    catch (e) { return { ok: false, code: 'bad-result', error: '缺少或无法解析 result.json' }; }
    const filesIn = Array.isArray(result && result.files) ? result.files : [];
    const files = [];
    const seen = new Set();
    for (const f of filesIn) {
      const name = safeName(f && f.name);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const fp = path.join(outdir, name);
      let size = 0;
      try { size = fs.statSync(fp).size; } catch (e) { continue; }   // 结果文件必须真实存在
      files.push({ name, path: fp, kind: KINDS.has(String(f.kind)) ? String(f.kind) : req.kind, bytes: size });
    }
    if (!files.length) return { ok: false, code: 'no-files', error: '生成命令没有产出有效文件' };
    if (files.length > 20) return { ok: false, code: 'too-many-files', error: '一次最多返回 20 个文件' };
    return {
      ok: true, jobId: path.basename(base), outdir, files,
      meta: {
        aiGenerated: true,
        provider: String((result && result.provider) || 'local').slice(0, 60),
        model: String((result && result.model) || '').slice(0, 80),
        kind: req.kind, createdAt, promptHash,
      },
      log: String(r.out || '').slice(-2000),
    };
  });
}

module.exports = { registerAiIpc };
