/**
 * DiffSinger 声库目录同步脚本
 * ------------------------------------------------------------------
 * 用途：把 ModelScope 仓库 aihobbyist/ACG-DiffSinger-VoiceDB 的完整文件
 *       清单，重新抽取为前端可直接消费的静态数据模块
 *       main/diffsinger-ms-catalog.js。
 *
 * 为什么需要它：
 *   「模型管理 → DiffSinger」板块的清单必须完整、可追溯、可随上游仓库更新
 *   同步补充，所以清单不写死在 UI 里，而是由本脚本从官方 API 抽取生成；
 *   生成后的文件被 main 进程 require，随应用一起分发（离线可用）。
 *
 * 用法：
 *   node scripts/diffsinger-ms/sync.mjs                 # 抓取官方 API 并重新生成
 *   node scripts/diffsinger-ms/sync.mjs --offline       # 用本地快照重新生成
 *   node scripts/diffsinger-ms/sync.mjs --check         # 只校验现有清单是否与快照一致
 *
 * 说明：
 *   - 只读取公开只读 API，不做任何写操作。
 *   - 抓取失败时自动回退到 scripts/diffsinger-ms/repo-files.snapshot.json。
 *   - 输出文件为纯 CommonJS，无第三方依赖。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SNAPSHOT = path.join(__dirname, 'repo-files.snapshot.json');
const OUT_FILE = path.join(ROOT, 'main', 'diffsinger-ms-catalog.js');

/** 上游仓库坐标（全球唯一来源，下载直连） */
const REPO = { owner: 'aihobbyist', name: 'ACG-DiffSinger-VoiceDB', revision: 'master' };

/** 小于该字节数的 .zip 视为占位文件（上游尚未上传真实权重） */
const PLACEHOLDER_MAX_BYTES = 64 * 1024;

/** 作品划分：仓库顶层目录 → 作品标识 */
const WORKS = {
  原神: { id: 'genshin', label: '原神' },
  星穹铁道: { id: 'starrail', label: '崩坏：星穹铁道' },
};

/** 目录中文名 → 英文/说明补充（用于国际化无关的分类展示） */
const CATEGORY_DESC = {
  未分类: '未归入地区分类的声库',
  蒙德城: '蒙德地区角色声库',
  璃月港: '璃月地区角色声库',
  稻妻城: '稻妻地区角色声库',
  须弥城: '须弥地区角色声库',
  枫丹廷: '枫丹地区角色声库',
  纳塔: '纳塔地区角色声库（上游暂未上传权重）',
  降临者: '降临者 / 主角阵营声库',
  第一部分: '星穹铁道声库（第一部分）',
  第二部分: '星穹铁道声库（第二部分）',
  第三部分: '星穹铁道声库（第三部分）',
  第四部分: '星穹铁道声库（第四部分）',
  第五部分: '星穹铁道声库（第五部分）',
};

/** 双声线 / 特殊说明，来自上游 README 的角色备注 */
const ROLE_NOTES = {
  菲谢尔: '双声线，包含菲谢尔和奥兹',
  白术: '双声线，包含白术和长生',
  基尼奇: '双声线，包含基尼奇和阿乔',
  藿藿: '双声线，包含藿藿和尾巴',
};

/**
 * 直连 ModelScope 官方下载地址。
 * 该地址对全球用户返回同一份内容与同一份重定向结果（全球同源），
 * 不做任何镜像替换、不改 host、不加代理参数。
 */
function msFileUrl(repoPath) {
  return (
    `https://www.modelscope.cn/api/v1/models/${REPO.owner}/${REPO.name}/repo` +
    `?Revision=${REPO.revision}&FilePath=${encodeURIComponent(repoPath)}`
  );
}

/** 递归列举仓库文件（官方公开 API，只读） */
async function listRepo() {
  const out = [];
  const seen = new Set();
  async function walk(root, depth) {
    if (depth > 6) return;
    const url =
      `https://www.modelscope.cn/api/v1/models/${REPO.owner}/${REPO.name}/repo/files` +
      `?Revision=${REPO.revision}&Root=${encodeURIComponent(root)}`;
    let json = null;
    for (let attempt = 0; attempt < 3 && !json; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'FuFumidi-Catalog-Sync' } });
        if (res.ok) json = await res.json();
      } catch { /* 重试 */ }
      if (!json) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    if (!json || !json.Data || !Array.isArray(json.Data.Files)) {
      throw new Error(`列举失败：${root || '/'}`);
    }
    for (const f of json.Data.Files) {
      if (seen.has(f.Path)) continue;
      seen.add(f.Path);
      out.push({ path: f.Path, type: f.Type === 'tree' ? 'tree' : 'blob', size: f.Size || 0, name: f.Name });
      if (f.Type === 'tree') await walk(f.Path, depth + 1);
    }
  }
  await walk('', 0);
  return out;
}

/** 从完整文件清单构建目录结构 */
function buildCatalog(files) {
  const works = [];
  const byWork = new Map();

  for (const f of files) {
    if (f.type !== 'blob' || !f.path.endsWith('.zip')) continue;
    const seg = f.path.split('/');
    if (seg.length < 2) continue; // 跳过根目录散落文件
    const workKey = seg[0];
    const catKey = seg.length >= 3 ? seg[1] : '';
    const roleName = f.name.replace(/\.zip$/i, '');
    const work = WORKS[workKey];
    if (!work) continue;

    let w = byWork.get(workKey);
    if (!w) {
      w = { id: work.id, label: work.label, source: workKey, categories: [] };
      byWork.set(workKey, w);
      works.push(w);
    }
    let cat = w.categories.find((c) => c.source === catKey);
    if (!cat) {
      cat = { source: catKey, label: catKey || work.label, desc: CATEGORY_DESC[catKey] || '', models: [] };
      w.categories.push(cat);
    }
    const placeholder = f.size <= PLACEHOLDER_MAX_BYTES;
    cat.models.push({
      name: roleName,
      work: work.label,
      workId: work.id,
      category: catKey || work.label,
      desc: ROLE_NOTES[roleName] || (catKey ? `${catKey}声库` : `${work.label}声库`),
      path: f.path,
      size: f.size,
      placeholder,
      url: msFileUrl(f.path),
    });
  }

  for (const w of works) {
    for (const c of w.categories) c.models.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    w.categories.sort((a, b) => a.source.localeCompare(b.source, 'zh-Hans-CN'));
  }
  works.sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
  return works;
}

/** 生成 main/diffsinger-ms-catalog.js 内容 */
function renderModule(works, stats) {
  const header = `// DiffSinger 声库目录（自动生成，请勿手工编辑）
// 来源：ModelScope ${REPO.owner}/${REPO.name} @ ${REPO.revision}
// 生成方式：node scripts/diffsinger-ms/sync.mjs
// 生成时间：${new Date().toISOString()}
//
// 说明：
//   - 本文件是「模型管理 → DiffSinger」板块的唯一数据源，保证清单完整、不遗漏、不截断。
//   - 每个条目的 url 均为直连 ModelScope 官方地址，全球同源，不做镜像替换。
//   - placeholder=true 表示上游仅放了占位文件、尚无真实权重，UI 中标注为暂不可用。
//   - 上游仓库更新后，重新运行同步脚本即可刷新本文件。

const MS_REPO = ${JSON.stringify(REPO, null, 2)};

/** 直连 ModelScope 官方下载地址（全球同源） */
function msFileUrl(repoPath) {
  return \`https://www.modelscope.cn/api/v1/models/\${MS_REPO.owner}/\${MS_REPO.name}/repo\` +
    \`?Revision=\${MS_REPO.revision}&FilePath=\${encodeURIComponent(repoPath)}\`;
}

/** 目录结构：作品 → 分类 → 模型（共 ${stats.total} 条，其中可用 ${stats.available} 条、占位 ${stats.placeholder} 条） */
const WORKS = `;
  const body = JSON.stringify(works, null, 1);
  const footer = `;

/** 分组统计，供 UI 直接展示 */
const STATS = ${JSON.stringify(stats, null, 2)};

/** 扁平化索引：path → model，便于快速查重与下载 */
const BY_PATH = new Map();
for (const w of WORKS) for (const c of w.categories) for (const m of c.models) BY_PATH.set(m.path, m);

module.exports = { MS_REPO, WORKS, STATS, BY_PATH, msFileUrl };
`;
  return header + body + footer;
}

async function main() {
  const argv = process.argv.slice(2);
  const offline = argv.includes('--offline');
  const checkOnly = argv.includes('--check');

  let files;
  if (offline) {
    files = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    console.log(`[offline] 使用本地快照，${files.length} 条`);
  } else {
    try {
      files = await listRepo();
      console.log(`[online] 从 ModelScope 抓取到 ${files.length} 条`);
      fs.writeFileSync(SNAPSHOT, JSON.stringify(files, null, 1) + '\n', 'utf8');
      console.log(`[online] 快照已更新：${path.relative(ROOT, SNAPSHOT)}`);
    } catch (e) {
      console.warn(`[online] 抓取失败（${e.message}），回退快照`);
      files = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    }
  }

  const works = buildCatalog(files);
  const all = works.flatMap((w) => w.categories.flatMap((c) => c.models));
  const stats = {
    total: all.length,
    available: all.filter((m) => !m.placeholder).length,
    placeholder: all.filter((m) => m.placeholder).length,
    works: works.map((w) => ({
      id: w.id, label: w.label, source: w.source,
      models: w.categories.reduce((s, c) => s + c.models.length, 0),
      categories: w.categories.length,
    })),
  };

  if (checkOnly) {
    if (!fs.existsSync(OUT_FILE)) { console.error('目录文件不存在'); process.exit(1); }
    // 说明：本脚本是 ESM，不能直接用 require 读 CommonJS 目录模块；
    // 这里用 createRequire 桥接，才能在校验模式下加载 main/diffsinger-ms-catalog.js。
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const cur = req(OUT_FILE);
    const same = JSON.stringify(cur.WORKS) === JSON.stringify(works);
    console.log(same ? '✅ 现有清单与上游一致' : '⚠️  现有清单与上游不一致，请重新生成');
    process.exit(same ? 0 : 2);
  }

  fs.writeFileSync(OUT_FILE, renderModule(works, stats), 'utf8');
  console.log(`✅ 已生成 ${path.relative(ROOT, OUT_FILE)}`);
  console.log(`   模型 ${stats.total} 条（可用 ${stats.available} / 占位 ${stats.placeholder}）`);
  for (const w of stats.works) console.log(`   - ${w.label}：${w.models} 条 / ${w.categories} 个分类`);
}

main().catch((e) => { console.error(e); process.exit(1); });
