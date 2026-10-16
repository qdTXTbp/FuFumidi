// ============================================================
// 问题反馈：格式化与脱敏（**纯函数**，无 Electron 依赖，可单测）
//
// 这个文件只做「把用户填的东西 + 自动收集的东西」变成一份规范和安全的产物：
//   buildMarkdown()  → issue.md（front-matter + 正文 + 折叠的体检报告）
//   sanitizeText()   → 机器名 / 用户名 / 家目录 / 令牌形状 → 占位符
//   scrubSettings()  → 诊断包里的 settings.json：**先按 key 删敏感项**，再整体过一遍 sanitizeText
//
// ★ 原则：自动收集的部分走**白名单 + 脱敏**，用户自己填的部分原样保留
//   （他写什么就是要我们知道什么）；联系方式只保留用户明确填在 contact 里的。
// ============================================================
'use strict';

const KIND_LABEL = { bug: '功能异常', crash: '崩溃/无响应', perf: '卡顿慢', quality: '识别或音质不对', idea: '功能建议', docs: '文档与文案' };
const AREA_LABEL = {
  transcribe: '转录', score: '变谱', convert: '转换', voice: '音色', sing: '调教',
  play: '播放', library: '曲库', edit: '编辑', update: '更新', resources: '资源中心', other: '其它',
};

/** 标题 → ASCII slug（只留 a-z0-9-）。中文标题会退化成空串，由调用方兜底成 kind。 */
function slugify(title, fallback = 'feedback') {
  const s = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  // 中文标题会只剩数字（实测「变谱第 2 页总是识别失败」→ '2'），那种 slug 毫无信息量，
  // 还不如直接用 kind 兜底（issues/…-bug.md）——文件名要能一眼看出是哪类问题。
  if (s.length < 3 || !/[a-z]/.test(s)) return fallback;
  return s;
}

/** 2026-10-16-a1b2c3 */
function feedbackId(date = new Date(), rand = '') {
  const p = (n) => String(n).padStart(2, '0');
  const d = date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate());
  const r = String(rand || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6) || 'aaaaaa';
  return d + '-' + r.padEnd(6, '0');
}

/** issues/YYYY/MM/<id>-<slug>.md */
function fileNameFor(id, title, kind = 'bug') {
  const m = /^(\d{4})-(\d{2})/.exec(String(id || ''));
  const y = (m && m[1]) || String(new Date().getFullYear());
  const mo = (m && m[2]) || String(new Date().getMonth() + 1).padStart(2, '0');
  return 'issues/' + y + '/' + mo + '/' + id + '-' + slugify(title, kind) + '.md';
}

const TOKEN_PATTERNS = [
  [/hf_[A-Za-z0-9]{16,}/g, '<已隐藏>'],
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, '<已隐藏>'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '<已隐藏>'],
  [/sk-[A-Za-z0-9]{16,}/g, '<已隐藏>'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<已隐藏>'],
  [/\b[A-Fa-f0-9]{32,}\b/g, '<已隐藏>'],
  [/\b[A-Za-z0-9]{28,}\b/g, '<已隐藏>'],
  [/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1<已隐藏>'],
  [/([?&](?:token|access_token|password|secret)=)[^&\s]+/gi, '$1<已隐藏>'],
];

/**
 * 脱敏：机器名 / 用户名 / 家目录 / 令牌形状。
 * hostname 传空串时不替换主机名（避免把常见短词也吃掉 —— 3 字符以下的主机名一律不处理）。
 */
function sanitizeText(text, opts = {}) {
  let s = String(text == null ? '' : text);
  if (!s) return s;
  const host = String(opts.hostname || '');
  const user = String(opts.username || '');
  // 家目录（三种平台）优先，避免先被"用户名"规则切碎
  s = s.replace(/([A-Za-z]:[\\/]Users[\\/])[^\\/:*?"<>|\r\n]+/gi, '$1<用户>');
  s = s.replace(/(\/home\/)[^\/\s]+/g, '$1<用户>');
  s = s.replace(/(\/Users\/)[^\/\s]+/g, '$1<用户>');
  if (user && user.length >= 2) {
    s = s.split(user).join('<用户>');
  }
  if (host && host.length >= 3) {
    s = s.split(host).join('<主机名>');
  }
  for (const [re, rep] of TOKEN_PATTERNS) s = s.replace(re, rep);
  return s;
}

const SENSITIVE_KEY = /(token|secret|password|passwd|api[_-]?key|credential|cookie|session|email|auth)/i;

/** 诊断包里的 settings.json：先按 key 递归删敏感字段，再把整段过一遍 sanitizeText。 */
function scrubSettings(obj, opts = {}) {
  const walk = (v, depth) => {
    if (depth > 6 || v == null) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (typeof v !== 'object') return v;
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (SENSITIVE_KEY.test(k)) { out[k] = '<已移除>'; continue; }
      out[k] = walk(val, depth + 1);
    }
    return out;
  };
  let json = '';
  try { json = JSON.stringify(walk(obj, 0), null, 1); } catch (e) { json = '{}'; }
  return sanitizeText(json, opts);
}

/** 日志/文本附件：脱敏 + 只留尾部 limitBytes（日志最有用的是最后几百行）。 */
function sanitizeLog(text, opts = {}, limitBytes = 256 * 1024) {
  const s = sanitizeText(text, opts);
  if (s.length <= limitBytes) return s;
  return '…（前 ' + (s.length - limitBytes) + ' 字符已截断）\n' + s.slice(s.length - limitBytes);
}

function yamlStr(v) {
  const s = String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
  if (!s) return '';
  return /[:#\[\]{}&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

/**
 * 生成上传的 issue.md。
 * fields: { kind, area, severity, title, symptom, steps, expect, freq, contact }
 * ctx:    { id, createdAt, appVersion, build, os, cpu, gpu, mem, install, installId, healthReport, attachments }
 */
function buildMarkdown(fields, ctx = {}) {
  const f = fields || {};
  const c = ctx || {};
  const atts = Array.isArray(c.attachments) ? c.attachments : [];
  const lines = [];
  lines.push('---');
  lines.push('id: ' + f_y(c.id));
  lines.push('title: ' + f_y(f.title));
  lines.push('kind: ' + f_y(f.kind));
  lines.push('area: ' + f_y(f.area));
  lines.push('severity: ' + f_y(f.severity));
  lines.push('app: ' + f_y(c.appVersion));
  if (c.build) lines.push('build: ' + f_y(c.build));
  lines.push('os: ' + f_y(c.os));
  if (c.cpu) lines.push('cpu: ' + f_y(c.cpu));
  if (c.gpu) lines.push('gpu: ' + f_y(c.gpu));
  if (c.mem) lines.push('mem: ' + f_y(c.mem));
  lines.push('install: ' + f_y(c.install));
  lines.push('install_id: ' + f_y(c.installId));
  lines.push('created: ' + f_y(c.createdAt));
  if (atts.length) {
    lines.push('attachments:');
    for (const a of atts) lines.push('  - ' + f_y(a.name + ' (' + mb(a.bytes) + (a.sha256 ? ', sha256: ' + String(a.sha256).slice(0, 12) : '') + ')'));
  } else {
    lines.push('attachments: []');
  }
  lines.push('contact: ' + (f.contact ? f_y(f.contact) : ''));
  lines.push('---');
  lines.push('');
  lines.push('## 症状');
  lines.push(nonEmpty(f.symptom, '（未填写）'));
  lines.push('');
  if (f.steps) { lines.push('## 复现步骤'); lines.push(f.steps); lines.push(''); }
  if (f.expect) { lines.push('## 期望 vs 实际'); lines.push(f.expect); lines.push(''); }
  if (f.freq) { lines.push('## 频率'); lines.push(f.freq); lines.push(''); }
  lines.push('## 附件');
  lines.push('- [' + (c.hasDiagnostic ? 'x' : ' ') + '] 诊断包（含最近日志与设置，上传前已脱敏）');
  lines.push('- [' + (c.healthReport ? 'x' : ' ') + '] 体检报告（自动生成，已去用户名/机器名）');
  lines.push('');
  if (c.healthReport) {
    lines.push('<details><summary>体检报告（自动生成，已脱敏）</summary>');
    lines.push('');
    lines.push(String(c.healthReport).trim());
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  lines.push('<!-- 本条由 FuFumidi ' + (c.appVersion || '') + ' 上传：' + (c.source || 'app') + ' -->');
  return lines.join('\n');

  function f_y(v) { return yamlStr(v == null ? '' : v); }
}
const f_y = (v) => yamlStr(v == null ? '' : v);
function nonEmpty(v, fallback) { const s = String(v == null ? '' : v).trim(); return s || fallback; }
function mb(bytes) { const b = Number(bytes) || 0; return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }

module.exports = {
  KIND_LABEL, AREA_LABEL,
  slugify, feedbackId, fileNameFor, sanitizeText, scrubSettings, sanitizeLog, buildMarkdown,
};
