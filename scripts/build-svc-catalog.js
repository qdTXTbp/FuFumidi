// 生成翻唱模型目录快照（SVC 模型目录）：ModelScope 两个社区仓库 → main/svc-catalog.json
//
//   node scripts/build-svc-catalog.js
//
// ★ 目录只是「有哪些模型、在哪、多大」的索引，**不含权重**。应用不内置一键下载
//   （两个仓库都是 CC-BY-NC-4.0：禁商用、必须署名训练者 —— 分发不在我们这边），
//   界面只把用户送到 ModelScope 页面，下载由用户自己完成，再用「导入」放进应用。
//
// 仓库结构（实测 2026-10-10）：
//   RVC  48k（新版）/原神/{中文|英语|日语|韩语}/角色/角色.pth + 同名目录里的 added_*.index
//        40k（旧版）/作品/角色/xx.pth            ← 这一层没有语言目录
//   DDSP 原神|星穹铁道/.../*.sf_pkg              ← SVC-Fusion 专用封装，本轮不接
'use strict';
const fs = require('fs');
const path = require('path');

const REPOS = [
  {
    key: 'rvc',
    ns: 'aihobbyist',
    name: 'RVC_Model_Collection',
    engine: 'rvc',
    site: 'https://www.modelscope.cn/models/aihobbyist/RVC_Model_Collection',
    license: 'CC-BY-NC-4.0',
    commercial: false,
    credits: ['红血球AE3803', '白菜工厂1145号员工', 'YSJS有所建树', '小虫哥_', 'prts.wiki'],
  },
  {
    // 只登记、不接入：.sf_pkg 是 SVC-Fusion 的专用封装（README 明说需配合 SVC-Fusion 使用）
    key: 'ddsp',
    ns: 'aihobbyist',
    name: 'ACG-DDSP-Model',
    engine: 'ddsp',
    site: 'https://www.modelscope.cn/models/aihobbyist/ACG-DDSP-Model',
    license: 'CC-BY-NC-4.0',
    commercial: false,
    credits: ['红血球AE3803'],
    supported: false,
  },
];

const LANGS = ['中文', '日语', '英语', '韩语'];
const UNKNOWN_LANG = '未标语言';

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'FuFumidi' } });
  if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
  return r.json();
}

/** 拉一个仓库的完整文件树 */
async function fileTree(repo) {
  const url = `https://www.modelscope.cn/api/v1/models/${repo.ns}/${repo.name}/repo/files?Revision=master&Recursive=True`;
  const j = await fetchJson(url);
  const files = (j && j.Data && j.Data.Files) || [];
  return files.filter((f) => f.Type === 'blob');
}

/** RVC：把 .pth 与同目录的 .index 配成对，解析出 采样率 / 作品 / 语言 / 角色 */
function buildRvc(files) {
  const byDir = new Map();
  for (const f of files) {
    if (!/\.pth$/i.test(f.Name)) continue;
    const dir = f.Path.split('/').slice(0, -1).join('/');
    if (!byDir.has(dir)) byDir.set(dir, { pth: null, index: null });
    byDir.get(dir).pth = f;
  }
  for (const f of files) {
    if (!/\.index$/i.test(f.Name)) continue;
    const dir = f.Path.split('/').slice(0, -1).join('/');
    const e = byDir.get(dir);
    if (e) e.index = f;
  }
  const out = [];
  for (const [dir, e] of byDir) {
    if (!e.pth) continue;
    const parts = dir.split('/');
    // 48k（新版）/作品/语言/角色   |   40k（旧版）/作品/角色
    const gen = parts[0] || '';
    const sr = /40k/.test(gen) ? 40000 : /48k/.test(gen) ? 48000 : /32k/.test(gen) ? 32000 : 0;
    const hasLang = parts.length > 3 && LANGS.indexOf(parts[2]) >= 0;
    const work = hasLang ? parts[1] : parts[1] || '';
    const lang = hasLang ? parts[2] : UNKNOWN_LANG;
    const character = parts[parts.length - 1] || '';
    out.push({
      id: 'rvc:' + dir,
      name: character,
      work: work || '',
      lang,
      sr,
      gen,
      engine: 'rvc',
      pth: e.pth.Path,
      pthSize: e.pth.Size || 0,
      index: e.index ? e.index.Path : '',
      indexSize: e.index ? e.index.Size || 0 : 0,
    });
  }
  out.sort((a, b) => (a.work === b.work ? (a.lang === b.lang ? a.name.localeCompare(b.name, 'zh') : LANGS.indexOf(a.lang) - LANGS.indexOf(b.lang)) : a.work.localeCompare(b.work, 'zh')));
  return out;
}

/** DDSP（.sf_pkg，本轮只登记不接入） */
function buildDdsp(files) {
  const out = [];
  for (const f of files) {
    if (!/\.sf_pkg$/i.test(f.Name)) continue;
    const parts = f.Path.split('/');
    const work = parts[0] || '';
    const group = parts.length > 2 ? parts[parts.length - 2] : '';
    out.push({
      id: 'ddsp:' + f.Path,
      name: f.Name.replace(/\.sf_pkg$/i, ''),
      work, group, lang: UNKNOWN_LANG, sr: 0, gen: '.sf_pkg',
      engine: 'ddsp', supported: false,
      pth: f.Path, pthSize: f.Size || 0, index: '', indexSize: 0,
    });
  }
  return out;
}

async function main() {
  const models = [];
  const repos = [];
  for (const repo of REPOS) {
    let files = [];
    try {
      files = await fileTree(repo);
    } catch (e) {
      console.warn('[svc-catalog] 拉取失败，跳过：' + repo.name + ' → ' + e.message);
      continue;
    }
    const list = repo.key === 'rvc' ? buildRvc(files) : buildDdsp(files);
    for (const m of list) models.push({ ...m, repo: repo.key });
    repos.push({
      key: repo.key, engine: repo.engine, name: repo.name, site: repo.site,
      license: repo.license, commercial: repo.commercial, credits: repo.credits,
      supported: repo.supported !== false, count: list.length,
    });
    console.log('[svc-catalog] ' + repo.name + '：' + list.length + ' 个模型');
  }
  const langs = [];
  for (const l of LANGS) if (models.some((m) => m.lang === l)) langs.push(l);
  if (models.some((m) => m.lang === UNKNOWN_LANG)) langs.push(UNKNOWN_LANG);
  const works = [...new Set(models.map((m) => m.work).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'));
  const catalog = {
    generated: new Date().toISOString(),
    note: '目录只做索引，不含权重。CC-BY-NC-4.0：禁止商用，必须署名训练者。',
    repos, langs, works, models,
  };
  const dest = path.join(__dirname, '..', 'main', 'svc-catalog.json');
  fs.writeFileSync(dest, JSON.stringify(catalog), 'utf8');
  const kb = (fs.statSync(dest).size / 1024).toFixed(0);
  console.log('[svc-catalog] → ' + dest + '（' + models.length + ' 个模型，' + kb + ' KB）');
}

main().catch((e) => { console.error(e); process.exit(1); });
