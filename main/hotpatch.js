// ============================================================
// 热补丁（与版本更新完全解耦的小改动通道）
// ------------------------------------------------------------
// 目标：修 Python 引擎等「app.asar.unpacked 下的真实文件」时，
// 不建 release / 不 bump 版本号 / 不让用户下载 700MB 安装包。
//
// 流程：仓库固定路径的 hotpatch.json（Ed25519 签名）
//   → 多源下载 → 校验 zip 与每个文件的 sha256 → 白名单路径
//   → 备份到 FuFumidiData（受 kachina ignoreFolderPath 保护）
//   → 原子替换 → 写状态 → 每次启动校验目标 hash，被完整更新冲掉就自动重放。
//
// 边界：app.asar 内的 main/*.js / renderer/dist/assets/*.js 不在可覆盖范围，
// 那类改动必须整包发版（改 asar 内部字节会破坏 integrity 与 exe 内嵌哈希）。
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Paths = require('./paths');
const DS = require('./download-source');
const HM = require('./hotpatch_manifest');
const createFastDownload = require('./fast-download');

const PATCH_REPO_CNB = 'FuFuCloud-mirror/FuFuMIDI';
const PATCH_REPO_GH = 'qdTXTbp/FuFumidi';
const PATCH_DIR = 'patches';
const MANIFEST_NAME = 'hotpatch.json';
// ★ 两个远端的默认分支都是 master（git ls-remote --symref 实测）。写 main 会永远 404。
const PATCH_BRANCH = 'master';

/** 仓库固定地址的候选源（按「设置 → 下载源」排序，另一端留作回落） */
function urlsFor(name, source) {
  const p = PATCH_DIR + '/' + name;
  const cnb = DS.cnbRepoRawUrl(PATCH_REPO_CNB, PATCH_BRANCH, p);
  const raw = 'https://raw.githubusercontent.com/' + PATCH_REPO_GH + '/' + PATCH_BRANCH + '/' + p;
  const gh = ['https://ghfast.top/' + raw, raw];
  return DS.orderUrls(cnb, gh, source === undefined ? DS.currentSource() : source);
}

function log(level, msg) {
  try { require('./log').write(level, 'hotpatch', msg); } catch (_) { /* 日志不可用时不影响补丁 */ }
}

function atomicJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function stateFile(root) { return path.join(root, 'state.json'); }
function readState(root) {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
    return { applied: Array.isArray(j.applied) ? j.applied : [], lastCheck: j.lastCheck || '', lastError: j.lastError || '' };
  } catch (_) { return { applied: [], lastCheck: '', lastError: '' }; }
}

/** 目标文件当前内容是否仍与补丁期望一致（完整更新会整体替换 app.asar.unpacked） */
function targetsMatch(files, targetRoot) {
  for (const f of files) {
    const abs = path.join(targetRoot, ...f.path.split('/'));
    try {
      if (HM.sha256Buffer(fs.readFileSync(abs)) !== f.sha256) return false;
    } catch (_) { return false; }
  }
  return true;
}

/** 解析 zip 并逐条目校验（不落盘解压 → 天然不会创建符号链接或目录穿越） */
function planFromZip(zipBuf, files) {
  const AdmZip = require('adm-zip');
  const entries = new AdmZip(Buffer.from(zipBuf)).getEntries();
  const byName = new Map();
  for (const e of entries) {
    if (e.isDirectory) continue;
    const v = HM.validateRelPath(e.entryName);
    if (!v.ok) return { ok: false, error: '补丁包内含非法条目：' + v.reason };
    byName.set(v.rel, e.getData());
  }
  const out = [];
  for (const f of files) {
    if (!byName.has(f.path)) return { ok: false, error: '补丁包缺文件：' + f.path };
    const buf = byName.get(f.path);
    if (buf.length !== f.size || HM.sha256Buffer(buf) !== f.sha256) {
      return { ok: false, error: '文件内容校验失败：' + f.path };
    }
    out.push({ rel: f.path, buf });
  }
  if (byName.size !== files.length) return { ok: false, error: '补丁包含清单外的文件' };
  return { ok: true, files: out };
}

/** 备份 + 原子替换；中途失败把已改的文件全部还原。返回 {ok, backups} */
function applyToDisk(plan, ctx) {
  const { targetRoot, stateRoot, id } = ctx;
  const backupRoot = path.join(stateRoot, 'backup', id);
  const backups = [];
  const done = [];
  try {
    for (const f of plan.files) {
      const abs = path.join(targetRoot, ...f.rel.split('/'));
      let original = null;
      try { original = fs.readFileSync(abs); } catch (_) { original = null; }
      backups.push({ rel: f.rel, absent: original === null, buf: original });
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = abs + '.fuhp-' + process.pid;
      fs.writeFileSync(tmp, f.buf);
      fs.renameSync(tmp, abs);
      done.push(abs);
    }
    // 备份落盘（回滚依据）；失败不阻断本次应用，但记录告警
    try {
      for (const b of backups) {
        const dst = path.join(backupRoot, ...b.rel.split('/'));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        if (b.buf) fs.writeFileSync(dst, b.buf);
      }
      atomicJson(path.join(backupRoot, 'index.json'), {
        id, at: new Date().toISOString(),
        files: backups.map((b) => ({ rel: b.rel, absent: b.absent })),
      });
    } catch (e) { log('WARN', '备份写入失败：' + String(e && e.message)); }
    return { ok: true, backups };
  } catch (e) {
    for (const abs of done) {
      const idx = done.indexOf(abs);
      const b = backups[idx];
      try {
        if (b && b.absent) fs.unlinkSync(abs);
        else if (b) fs.writeFileSync(abs, b.buf);
      } catch (_) { /* 尽力回滚 */ }
    }
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function rollback(stateRoot, targetRoot) {
  const state = readState(stateRoot);
  const last = state.applied[state.applied.length - 1];
  if (!last) return { ok: false, error: '没有已应用的补丁' };
  const backupRoot = path.join(stateRoot, 'backup', last.id);
  let idx;
  try { idx = JSON.parse(fs.readFileSync(path.join(backupRoot, 'index.json'), 'utf8')); }
  catch (_) { return { ok: false, error: '找不到该补丁的备份' }; }
  try {
    for (const b of idx.files) {
      const abs = path.join(targetRoot, ...b.rel.split('/'));
      const src = path.join(backupRoot, ...b.rel.split('/'));
      if (b.absent) { try { fs.unlinkSync(abs); } catch (_) { /* 原本不存在的文件，删不掉也无妨 */ } }
      else fs.writeFileSync(abs, fs.readFileSync(src));
    }
    state.applied = state.applied.filter((a) => a.id !== last.id);
    atomicJson(stateFile(stateRoot), state);
    log('INFO', '已回滚补丁 ' + last.id);
    return { ok: true, id: last.id };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

async function fetchJson(net, urls) {
  let notFound = 0;
  let errors = 0;
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 8000);
      let r;
      try {
        r = await net.fetch(url, { headers: { 'user-agent': 'FuFumidi', accept: 'application/json' }, signal: ctrl.signal });
      } finally { clearTimeout(to); }
      if (!r.ok) {
        if (r.status === 404) notFound++;
        else errors++;
        continue;
      }
      const text = await r.text();
      if (!text || text.length > 256 * 1024) { errors++; continue; }
      return { manifest: JSON.parse(text), notFound: 0, errors: 0 };
    } catch (_) { errors++; /* 换下一个源 */ }
  }
  return { manifest: null, notFound, errors };
}

let _queue = Promise.resolve();

/**
 * 检查并（按需）应用补丁。串行执行，启动自动检查与手动点击不会打架。
 * ctx: { net, fs, path, appVersion, readSettings, targetRoot, stateRoot, source?, force? }
 */
function check(ctx) {
  const run = async () => {
    const { net, appVersion, readSettings, targetRoot, stateRoot, force } = ctx;
    const state = readState(stateRoot);
    state.lastCheck = new Date().toISOString();
    const finish = (result) => {
      state.lastError = result.ok === false ? (result.error || '') : '';
      if (result.id && result.ok !== false) {
        state.applied = state.applied.filter((a) => a.id !== result.id);
        state.applied.push({ id: result.id, at: new Date().toISOString(), files: (result.files || []).map((f) => f.path || f.rel) });
      }
      try { atomicJson(stateFile(stateRoot), state); } catch (e) { log('WARN', '状态写入失败：' + String(e && e.message)); }
      return result;
    };
    if (process.env.FUFUMIDI_NO_HOTPATCH === '1') return finish({ ok: true, status: 'disabled' });

    const source = ctx.source === undefined ? DS.sourceOf(readSettings()) : ctx.source;
    const fetched = await fetchJson(net, urlsFor(MANIFEST_NAME, source));
    const manifest = fetched.manifest;
    if (!manifest) {
      // 只要有一个源明确回 404，就说明「仓库还没放补丁」是事实，不是网络故障；
      // 用户网络里 raw.githubusercontent 常被墙，不能因此每天报一条错误。
      if (fetched.notFound > 0) {
        if (fetched.errors) log('INFO', '补丁源：' + fetched.notFound + ' 个 404（无补丁），' + fetched.errors + ' 个不可用');
        return finish({ ok: true, status: 'none' });
      }
      return finish({ ok: false, status: 'unreachable', error: '所有补丁源都不可用（' + fetched.errors + ' 个源失败）' });
    }
    // publicKeyB64 仅用于测试注入临时密钥；生产不传 → 用 update_sign.js 内嵌公钥。
    const v = HM.verifyHotpatch(manifest, { currentVersion: appVersion, publicKeyB64: ctx.publicKeyB64 });
    if (!v.ok) {
      // 清单还在但已不适用当前版本（例如 6.6.0 用户看到 6.5.x 的旧清单）：
      // 属正常状态，不记错误，等发布方 push 新清单自然接管。
      if (v.reason === 'version') return finish({ ok: true, status: 'skipped', id: manifest.id, notes: manifest.notes || '' });
      return finish({ ok: false, status: 'invalid', error: v.error });
    }

    const already = state.applied.some((a) => a.id === manifest.id);
    const match = targetsMatch(v.files, targetRoot);
    if (already && match && !force) return finish({ ok: true, status: 'up-to-date', id: manifest.id, files: v.files });

    // 补丁包：优先用本地缓存（完整更新冲掉后的重放无需重新下载）
    const cacheDir = path.join(stateRoot, 'cache');
    const cachePath = path.join(cacheDir, manifest.package.name);
    let zipBuf = null;
    try {
      const b = fs.readFileSync(cachePath);
      if (HM.sha256Buffer(b) === manifest.package.sha256) zipBuf = b;
    } catch (_) { /* 缓存不存在或已损坏 */ }
    if (!zipBuf) {
      const FastDL = createFastDownload({ net, fs, path: ctx.path || path });
      fs.mkdirSync(cacheDir, { recursive: true });
      const tmp = cachePath + '.part';
      try {
        await FastDL.downloadFast({
          urls: urlsFor(manifest.package.name, source),
          dest: tmp,
          minSize: 1,
          expectSize: manifest.package.size,
          label: manifest.package.name,
          headers: { 'user-agent': 'FuFumidi' },
        });
        zipBuf = fs.readFileSync(tmp);
        if (HM.sha256Buffer(zipBuf) !== manifest.package.sha256) {
          return finish({ ok: false, status: 'corrupt', error: '补丁包 sha256 不符' });
        }
        fs.renameSync(tmp, cachePath);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (_) { /* 下载失败的临时文件可能本就不存在 */ }
        return finish({ ok: false, status: 'download-failed', error: String((e && e.message) || e) });
      }
    }
    const plan = planFromZip(zipBuf, v.files);
    if (!plan.ok) return finish({ ok: false, status: 'invalid', error: plan.error });

    const res = applyToDisk(plan, { targetRoot, stateRoot, id: manifest.id });
    if (!res.ok) return finish({ ok: false, status: 'apply-failed', error: res.error });
    log('INFO', (already ? '重放' : '应用') + '补丁 ' + manifest.id + '（' + plan.files.length + ' 个文件）');
    return finish({ ok: true, status: already ? 'replayed' : 'applied', id: manifest.id, files: v.files, notes: manifest.notes || '' });
  };
  _queue = _queue.then(run, run);
  return _queue;
}

function status(stateRoot, targetRoot) {
  const state = readState(stateRoot);
  const last = state.applied[state.applied.length - 1] || null;
  let healthy = null;
  if (last) {
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(stateRoot, 'backup', last.id, 'index.json'), 'utf8'));
      healthy = idx.files.every((b) => {
        const abs = path.join(targetRoot, ...b.rel.split('/'));
        if (!fs.existsSync(abs)) return false;
        return true;
      });
    } catch (_) { healthy = null; }
  }
  return {
    enabled: process.env.FUFUMIDI_NO_HOTPATCH !== '1',
    applied: state.applied,
    lastCheck: state.lastCheck,
    lastError: state.lastError,
    healthy,
  };
}

/** 注册 IPC + 启动延迟自动检查（只在打包版启用，不阻塞启动） */
function registerHotpatchIpc(opts) {
  const { ipcMain, net, app, BrowserWindow, readSettings, fs: injectedFs, path: injectedPath } = opts;
  const targetRoot = opts.targetRoot || Paths.installRoot();
  const stateRoot = opts.stateRoot || path.join(Paths.dataRoot(), 'hotpatch');
  const appVersion = opts.appVersion || (app && app.getVersion ? app.getVersion() : '0.0.0');
  const mk = () => ({ net, appVersion, readSettings, targetRoot, stateRoot, fs: injectedFs || fs, path: injectedPath || path });

  ipcMain.handle('hotpatch:check', async () => check({ ...mk(), force: true }));
  ipcMain.handle('hotpatch:status', async () => status(stateRoot, targetRoot));
  ipcMain.handle('hotpatch:rollback', async () => {
    const r = rollback(stateRoot, targetRoot);
    try { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('hotpatch:changed', r); } catch (_) { /* 窗口可能已关闭，广播失败不影响补丁本身 */ }
    return r;
  });

  if (app && app.isPackaged && opts.autoCheck !== false) {
    const t = setTimeout(() => {
      check(mk()).then((r) => {
        if (r && r.ok && (r.status === 'applied' || r.status === 'replayed')) {
          try { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('hotpatch:changed', r); } catch (_) { /* 窗口可能已关闭，广播失败不影响补丁本身 */ }
        }
      }).catch((e) => log('WARN', '自动检查异常：' + String(e && e.message)));
    }, 9000);
    try { t.unref(); } catch (_) { /* 某些宿主没有 unref，定时器随进程退出即可 */ }
  }
}

module.exports = {
  FORMAT: HM.FORMAT,
  urlsFor, readState, targetsMatch, planFromZip, applyToDisk, rollback,
  check, status, registerHotpatchIpc,
  stateFile,
  // 供测试注入
  _internals: { atomicJson, log },
};
