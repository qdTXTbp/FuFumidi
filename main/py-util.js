// ============================================================
// 主进程 Python 工具：JS 值 → Python 字面量、输出 JSON 解析
// ============================================================
'use strict';

// JS 值 → Python 字面量（安全内嵌到 -c 代码；JSON 的 true/false/null 不是合法 Python）
function pyLit(v) {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(pyLit).join(', ') + ']';
  if (typeof v === 'object') return '{' + Object.keys(v).map(k => pyLit(k) + ': ' + pyLit(v[k])).join(', ') + '}';
  return 'None';
}

function parsePyJson(out) {
  const m = (out || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

module.exports = { pyLit, parsePyJson };
