// ============================================================
// 通用工具：响应、ID、base64/字节转换、哈希、随机数
// ============================================================

// 统一 JSON 响应
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

export const error = (message, status = 400, extra = {}) =>
  json({ ok: false, error: message, ...extra }, status);

export const ok = (data = {}) => json({ ok: true, ...data });

// 随机 ID（不带连字符）
export function randomId(bytes = 16) {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 随机 N 位数字验证码
export function randomCode(n = 6) {
  const max = Math.pow(10, n);
  const r = crypto.getRandomValues(new Uint32Array(1))[0] % max;
  return r.toString().padStart(n, '0');
}

// base64 <-> Uint8Array
export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// SHA-256 hex
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// PBKDF2 密码哈希（$pbkdf2$iter$saltB64$hashB64）
//
// 迭代次数受 Workers 的 CPU 预算约束：免费版单次请求约 10ms，
// 原生 PBKDF2-SHA256 实测 100k 次约 14ms，理论上会超限。
// 但线上实测 100k 可正常完成注册（DB 中存量账号均为 $pbkdf2$100000$），
// 说明本 Worker 的 CPU 配额足够，故维持 100k 以保证密码强度。
// 哈希串内记录了 iterations，verifyPassword 按各条记录自己的参数验证，
// 因此将来调整此值不会影响存量账号。
const PBKDF2_ITER = 100000;
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER },
    key,
    256
  );
  const hash = new Uint8Array(bits);
  return `$pbkdf2$${PBKDF2_ITER}$${bytesToB64(salt)}$${bytesToB64(hash)}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [, , iterStr, saltB64, hashB64] = stored.split('$');
    const iterations = parseInt(iterStr, 10);
    const salt = b64ToBytes(saltB64);
    const expected = b64ToBytes(hashB64);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      key,
      256
    );
    const got = new Uint8Array(bits);
    if (got.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff |= got[i] ^ expected[i];
    return diff === 0;
  } catch (e) {
    return false;
  }
}

export const nowMs = () => Date.now();

// 终端 i;
export function verifyEmailFormat(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}