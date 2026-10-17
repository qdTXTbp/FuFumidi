// ============================================================
// P2-6 AI 生成接入（可选、默认关）——纯逻辑契约
// ============================================================
// 设计原则：
//   · **默认关闭**，且只在专家模式里出现开关；不内置任何模型/网络调用；
//   · 真正的生成能力由用户自备的本地命令提供（ai.provider_cmd 或 FUFUMIDI_AI_CMD），
//     契约：<cmd> --job <job.json> --outdir <outdir>，结果写到 <outdir>/result.json；
//   · 所有产物必须带 **AI 生成标注**（aiGenerated=true + provider/model/时间/prompt 哈希），
//     没有标注的结果一律拒绝 —— 不能把 AI 产物伪装成人工内容；
//   · 本模块只做校验/规范化/标注，不碰 fs/子进程（主进程 main/ai-generate.js 负责执行）。

export const AI_JOB_FORMAT = 'fufumidi-ai-job/v1';

export const AI_KINDS = [
  { id: 'midi', label: 'MIDI（旋律/伴奏）' },
  { id: 'audio', label: '音频（干声/音效）' },
  { id: 'lyrics', label: '歌词/文本' },
];

export const AI_STATUS = {
  DISABLED: 'disabled',
  NOT_CONFIGURED: 'not-configured',
  READY: 'ready',
};

/** 只有布尔 true 才算开启（字符串 'true' / 1 都不算，避免误开）。 */
export function isAiEnabled(settings) {
  return !!(settings && settings['ai.enabled'] === true);
}

/** 当前可用状态：默认关 → disabled；开了但没配命令 → not-configured；否则 ready。 */
export function aiStatusOf({ enabled, providerCmd } = {}) {
  const cmd = String(providerCmd == null ? '' : providerCmd).trim();
  if (enabled !== true) return { code: AI_STATUS.DISABLED, ready: false, reason: 'AI 生成默认关闭（专家模式里可打开）' };
  if (!cmd) return { code: AI_STATUS.NOT_CONFIGURED, ready: false, reason: '未配置本地生成命令（设置 → AI 生成命令）' };
  return { code: AI_STATUS.READY, ready: true, reason: '本地生成命令已配置' };
}

/** FNV-1a 32 位哈希（提示词指纹，用于溯源；与 Rust 侧 macro 哈希同族但不是同一实现）。 */
export function fnv1aHash(s) {
  const str = String(s == null ? '' : s);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

const KINDS = new Set(AI_KINDS.map((k) => k.id));

/** 校验请求（不检查开关/命令，主进程还会再查一次）。 */
export function normalizeAiRequest(raw = {}) {
  const kind = String(raw.kind || 'midi').trim();
  if (!KINDS.has(kind)) return { ok: false, code: 'bad-kind', error: '不支持的生成类型：' + kind };
  const prompt = String(raw.prompt == null ? '' : raw.prompt).trim();
  if (!prompt) return { ok: false, code: 'empty-prompt', error: '提示词不能为空' };
  if (prompt.length > 2000) return { ok: false, code: 'prompt-too-long', error: '提示词最长 2000 字' };
  const title = String(raw.title == null ? '' : raw.title).trim().slice(0, 80);
  let seed = Number(raw.seed);
  if (!Number.isFinite(seed)) seed = 0;
  seed = Math.max(0, Math.min(0x7fffffff, Math.round(seed)));
  return { ok: true, request: { kind, prompt, title, seed } };
}

/** 构造交给外部生成命令的 job（与主进程写盘的 JSON 一致）。 */
export function buildAiJob(request, opts = {}) {
  const createdAt = opts.now instanceof Date ? opts.now.toISOString() : String(opts.now || new Date().toISOString());
  return {
    format: AI_JOB_FORMAT,
    kind: request.kind,
    prompt: request.prompt,
    title: request.title || '',
    seed: request.seed,
    createdAt,
    promptHash: fnv1aHash(request.kind + '\n' + request.prompt),
  };
}

/** 安全文件名：拒绝目录穿越，只保留最后一段；必须带非空名字。 */
export function safeFileName(name) {
  const base = String(name == null ? '' : name).replace(/\\/g, '/').split('/').pop().trim();
  if (!base || base === '.' || base === '..' || /[\u0000-\u001f]/.test(base)) return '';
  return base.slice(0, 160);
}

/**
 * 规范化外部命令的结果。raw 期望：{ ok?, files:[{name, kind?, bytes?}], provider?, model? }。
 * 强制 aiGenerated=true 与 provenance；无文件/名字非法 → 失败。
 */
export function normalizeAiResult(raw, ctx = {}) {
  const filesIn = Array.isArray(raw && raw.files) ? raw.files : [];
  const seen = new Set();
  const files = [];
  for (const f of filesIn) {
    const name = safeFileName(f && f.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const kind = KINDS.has(String(f && f.kind)) ? String(f.kind) : (ctx.kind || 'midi');
    files.push({ name, kind, bytes: Number.isFinite(Number(f && f.bytes)) ? Number(f.bytes) : 0 });
  }
  if (!files.length) return { ok: false, code: 'no-files', error: '生成命令没有返回有效文件' };
  if (files.length > 20) return { ok: false, code: 'too-many-files', error: '一次最多返回 20 个文件' };
  const createdAt = ctx.now instanceof Date ? ctx.now.toISOString() : String(ctx.now || new Date().toISOString());
  return {
    ok: true,
    files,
    meta: {
      aiGenerated: true,
      provider: String((raw && raw.provider) || ctx.provider || 'local').slice(0, 60),
      model: String((raw && raw.model) || ctx.model || '').slice(0, 80),
      kind: ctx.kind || 'midi',
      createdAt,
      promptHash: ctx.promptHash || fnv1aHash(ctx.prompt || ''),
    },
  };
}

/** 统一的 AI 标注文案（UI 徽标；不依赖 i18n，调用方按语言包替换 label）。 */
export function aiLabel(meta) {
  const m = meta || {};
  return {
    badge: 'AI',
    text: 'AI 生成',
    detail: [m.provider || '', m.model || ''].filter(Boolean).join(' · ') || 'local',
    createdAt: m.createdAt || '',
  };
}
