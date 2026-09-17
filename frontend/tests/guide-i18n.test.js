// 新手引导的文案覆盖守卫。
//
// 语言守则：新增界面文案必须同时补英文（i18n.js 的 I18N_MAP）与日文（i18n_ja.js），
// 繁体由 zhHant.js 自动转换、不需逐条维护。引导是文案密度很高的组件（章节标题、每步说明、
// 目录文案），漏翻一条就会在英文/日文界面里露出中文，所以这里把它钉死。
//
// 说明：本测试**只扫描引导组件**。全站范围的同类检查尚未建立（见 docs/backlog.md C4），
// 因为历史文案量大、需要先补齐存量；先把新增的高密度文案锁住，避免继续增加欠账。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src');
const GUIDE = path.join(SRC, 'components', 'GuideOverlay.vue');
const EN = path.join(SRC, 'core', 'i18n.js');
const JA = path.join(SRC, 'core', 'i18n_ja.js');

/** 抓出源码里的 t('...') / t("...") 字面量（不含变量拼接，那些无法静态检查） */
function extractKeys(code) {
  const keys = new Set();
  const re = /\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const raw = m[2];
    if (!raw.trim()) continue;
    // 还原 JS 字符串转义（只处理常见几种；引导文案里不含更复杂的转义）
    keys.add(raw.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  }
  return keys;
}

/** 表里是否含该键（键可能用单引号或双引号书写） */
function hasKey(tableText, key) {
  return tableText.includes(`'${key}'`) || tableText.includes(`"${key}"`);
}

const guideCode = fs.readFileSync(GUIDE, 'utf8');
const enText = fs.readFileSync(EN, 'utf8');
const jaText = fs.readFileSync(JA, 'utf8');
const keys = [...extractKeys(guideCode)];

test('引导里能静态提取到文案（守卫本身有效）', () => {
  assert.ok(keys.length > 100, `只提取到 ${keys.length} 条，正则可能失效`);
});

test('引导文案全部有英文条目', () => {
  const missing = keys.filter((k) => !hasKey(enText, k));
  assert.deepEqual(missing, [], `缺英文 ${missing.length} 条：\n` + missing.join('\n'));
});

test('引导文案全部有日文条目', () => {
  const missing = keys.filter((k) => !hasKey(jaText, k));
  assert.deepEqual(missing, [], `缺日文 ${missing.length} 条：\n` + missing.join('\n'));
});