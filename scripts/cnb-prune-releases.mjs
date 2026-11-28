#!/usr/bin/env node
// ============================================================
// CNB 发布资产清理：按 tag 白名单保留，其余版本的**资产**逐个删除
// （release 记录与更新说明保留，git tag 不受影响）。
//
// 用法：
//   CNB_TOKEN=xxx node scripts/cnb-prune-releases.mjs --keep v6.7.5,v6.7.4            # 预览
//   CNB_TOKEN=xxx node scripts/cnb-prune-releases.mjs --keep v6.7.5,v6.7.4 --apply    # 真删
//   加 --drop-unpacked-zip 只删各版本的 unpacked 全量 zip（保留 Setup/更新器）
//
// 背景：CNB 组织对象存储有配额，每个版本约 1.76GB（其中 unpacked zip 928MB）。
// 更新链路只用最新版的 latest.yml / metadata / update-manifest / Install / Setup，
// 旧版本资产对升级无任何作用。
// ============================================================
const TOKEN = process.env.CNB_TOKEN;
if (!TOKEN) { console.error('缺少 CNB_TOKEN 环境变量'); process.exit(1); }
const REPO = process.env.CNB_REPO || 'FuFuCloud-mirror/FuFuMIDI';
const API = 'https://api.cnb.cool';
const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
const val = (n, d = '') => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };

const keep = new Set((val('keep', '') || '').split(',').map((s) => s.trim()).filter(Boolean));
const apply = has('apply');
const zipOnly = has('drop-unpacked-zip');

const H = { Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.cnb.api+json' };
const fmt = (n) => n > 1073741824 ? (n / 1073741824).toFixed(2) + 'GB' : (n / 1048576).toFixed(1) + 'MB';

async function api(method, path) {
  const r = await fetch(API + path, { method, headers: H });
  const text = await r.text();
  if (r.status >= 300) throw new Error(method + ' ' + path + ' → ' + r.status + ' ' + text.slice(0, 200));
  try { return JSON.parse(text); } catch (e) { return text; }
}

(async () => {
  if (!keep.size) { console.error('必须用 --keep 指定要保留的 tag（逗号分隔）'); process.exit(2); }
  const list = await api('GET', `/${REPO}/-/releases`);
  const rels = Array.isArray(list) ? list : (list.releases || list.list || []);
  console.log('CNB ' + REPO + ' 共 ' + rels.length + ' 个 release；保留：' + [...keep].join(', ') + (apply ? '' : '（预览模式，加 --apply 才真删）'));

  let freed = 0, deleted = 0;
  for (const rel of rels) {
    const tag = rel.tag_name || rel.tag || rel.name;
    if (keep.has(tag)) { console.log('  跳过 ' + tag); continue; }
    const detail = await api('GET', `/${REPO}/-/releases/tags/${encodeURIComponent(tag)}`);
    const assets = detail.assets || [];
    let sum = 0;
    for (const a of assets) {
      const name = (a.path || '').split('/').pop() || a.name || '';
      if (zipOnly && !/unpacked\.zip$/i.test(name)) continue;
      const size = a.size || a.file_size || 0;
      sum += size;
      if (apply) {
        await api('DELETE', `/${REPO}/-/releases/${detail.id}/assets/${a.id}`);
        deleted++;
      }
      console.log('  ' + (apply ? '删除' : '将删') + ' ' + tag + ' / ' + name + '  ' + fmt(size));
    }
    freed += sum;
    console.log('  小计 ' + tag + '：' + fmt(sum) + '（' + assets.length + ' 项资产）');
  }
  console.log('\n' + (apply ? '已删除 ' + deleted + ' 个资产' : '预计可释放 ' + fmt(freed)) + (apply ? '，释放约 ' + fmt(freed) : ''));
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
