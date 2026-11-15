#!/usr/bin/env node
// 凭据门禁：禁止把 token / 密码 / API key 写死在 scripts/ 下的脚本里。
//
// 起因（2026-11-15）：11 个 publish-*-cnb.js 曾把同一个 CNB API token 明文写在
// `const TOKEN = '…'`，其中 2 个还被提交进了 git 历史。改成 process.env.CNB_TOKEN 之后，
// 用这条门禁防止后人（或下一次复制旧脚本）再把凭据带回来。
//
// 只报「文件:行号 + 原因」，不打印命中的字面值，避免检查结果本身造成二次泄露。
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

const RULES = [
  {
    re: /\b(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PAT)\s*=\s*['"][A-Za-z0-9_-]{8,}['"]/g,
    why: '硬编码凭据赋值（改用 process.env.*）',
  },
  {
    re: /Authorization:\s*Bearer\s+[A-Za-z0-9_-]{8,}/g,
    why: '硬编码 Bearer 请求头',
  },
];

const hits = [];
for (const f of fs.readdirSync(DIR)) {
  if (!/\.(js|cjs|mjs)$/.test(f)) continue;
  let s;
  try { s = fs.readFileSync(path.join(DIR, f), 'utf8'); } catch (e) { continue; }
  for (const r of RULES) {
    r.re.lastIndex = 0;
    let m;
    while ((m = r.re.exec(s))) {
      hits.push(f + ':' + s.slice(0, m.index).split('\n').length + ' ' + r.why);
    }
  }
}

console.log('凭据门禁：' + hits.length + ' 处硬编码 / 基线 0');
if (hits.length) {
  console.error('禁止把凭据写死在源码里，请改用环境变量：\n' + hits.slice(0, 20).join('\n'));
  process.exit(1);
}
