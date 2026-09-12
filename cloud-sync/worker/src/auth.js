// ============================================================
// 账号与鉴权：注册(仅校验邮箱语法) / 登录(会话)
// 注册与登录都须通过 Turnstile 人机验证。
// 邮箱只做格式校验，不做邮件验证码验证。
// ============================================================
import {
  error, ok, randomId, nowMs,
  hashPassword, verifyPassword, sha256Hex, verifyEmailFormat,
} from './util.js';

const SESSION_TTL = 90 * 24 * 3600 * 1000; // 会话 90 天

// Turnstile 人机验证：仅配置 TURNSTILE_SECRET 后才会真正校验。
// 注意：Worker 的密钥/变量都挂在 env 上（不是在 globalThis）。
async function verifyTurnstile(env, token) {
  const secret = env && env.TURNSTILE_SECRET;
  if (!secret) {
    // 未配置 secret：开发联调放行（配置 TURNSTILE_SECRET 后即强制校验）
    console.log('[turnstile] 未配置 TURNSTILE_SECRET，跳过人机验证');
    return true;
  }
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token }),
    });
    const data = await res.json();
    return !!(data && data.success === true);
  } catch (e) {
    // 校验服务本身异常：按"未通过"处理，避免整个请求变成 500
    console.error('[turnstile] siteverify failed', e);
    return false;
  }
}

// 某用户当前的云端存档数量（用于登录冲突提示与手动同步的选择界面）
export async function cloudCounts(env, userId) {
  const songs = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM songs WHERE user_id=? AND deleted=0'
  ).bind(userId).first();
  const pls = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM playlists WHERE user_id=? AND deleted=0'
  ).bind(userId).first();
  return { cloudSongs: (songs && songs.c) || 0, cloudPlaylists: (pls && pls.c) || 0 };
}

async function issueSession(env, userId, deviceId) {
  const token = randomId(32);
  await env.DB.prepare(
    'INSERT INTO sessions(token_hash,user_id,device_id,created_at,expires_at) VALUES(?,?,?,?,?)'
  ).bind(await sha256Hex(token), userId, deviceId || '', nowMs(), nowMs() + SESSION_TTL).run();
  return token;
}

export function createAuth(env) {
  return {
    // POST /auth/register  {email,password,turnstile,deviceId}
    async register(body) {
      const { email, password, turnstile } = body || {};
      const em = (email || '').toLowerCase();
      if (!verifyEmailFormat(em)) return error('邮箱格式不正确');
      if (!password || password.length < 8) return error('密码至少 8 位');
      if (!(await verifyTurnstile(env, turnstile))) return error('人机验证未通过');

      const existing = await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(em).first();
      if (existing) return error('邮箱已注册，请直接登录');

      const userId = randomId(16);
      await env.DB.prepare(
        'INSERT INTO users(id,email,password,email_verified,created_at) VALUES(?,?,?,1,?)'
      ).bind(userId, em, await hashPassword(password), nowMs()).run();
      const token = await issueSession(env, userId, body && body.deviceId);
      const counts = await cloudCounts(env, userId);
      return ok({ token, userId, email: em, ...counts });
    },

    // POST /auth/login  {email,password,turnstile,deviceId}
    async login(body) {
      const em = ((body && body.email) || '').toLowerCase();
      if (!(await verifyTurnstile(env, body && body.turnstile))) return error('人机验证未通过');
      const user = await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(em).first();
      if (!user) return error('账号不存在，请先注册');
      if (!(await verifyPassword(body && body.password, user.password))) return error('密码或邮箱不正确');
      const token = await issueSession(env, user.id, body && body.deviceId);
      const counts = await cloudCounts(env, user.id);
      return ok({ token, userId: user.id, email: user.email, ...counts });
    },

    // POST /auth/logout
    async logout(tokenHash) {
      if (tokenHash) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(tokenHash).run();
      return ok();
    },

    // 鉴权中间件：Authorization: Bearer <token>
    async requireAuth(request) {
      const h = request.headers.get('Authorization') || '';
      const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
      if (!token) return { err: error('未登录', 401) };
      const tokenHash = await sha256Hex(token);
      const session = await env.DB.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash=?').bind(tokenHash).first();
      if (!session || nowMs() > session.expires_at) return { err: error('登录已过期', 401) };
      return { user: { id: session.user_id, tokenHash } };
    },
  };
}