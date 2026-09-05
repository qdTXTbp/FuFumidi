// ============================================================
// 主进程音色工坊服务：SoundFont 库注册表、多源下载/进度、导入/删除/选择
// ============================================================
'use strict';

// 自定义目录（用户上传/下载的 SF2）存在 userData/fufumidi/soundfonts 下，
// 内置随包分发的（如 renderer/vendor/soundfonts/GeneralUser.sf2）由 soundfont:list 单独列出。
function registerSoundfontWorkshopIpc({ ipcMain, BrowserWindow, app, path, fs, net }) {
  // ---- 下载源镜像列表：GitHub 仓库搭配代理镜像加速（与模型下载一致的习惯）----
  // hosts[0] 优先尝试；后续为主仓库 / 镜像回退。
  const _ghHosts = [
    'https://gh.jasonzeng.dev/https://raw.githubusercontent.com',
    'https://raw.githubusercontent.com',
    'https://ghfast.top/https://raw.githubusercontent.com',
    'https://gh-proxy.com/https://raw.githubusercontent.com',
  ];
  // 自家音色库镜像仓库 Release 附件（配 gh.jasonzeng.dev 加速分发大文件）
  const _releaseBase = 'https://gh.jasonzeng.dev/https://github.com/monologue82/FuFumidiSoundFonts/releases/download/v1';

  // ---- 音色库注册表：内置可一键下载的音色库 ----
  // 字段：
  //   id        唯一标识
  //   name      显示名
  //   desc      简单易懂的中文简介（帮助用户选择）
  //   size      预计大小（用于 UI 展示）
  //   license   许可证摘要
  //   minSize   判定“已下载完整”的最小字节数
  //   fromRepo  主仓库 author/repo（用于 GitHub raw 派生镜像路径）
  //   path      若为首个内置仓库（GeneralUser GS 已在 renderer/vendor/soundfonts），visited
  //   bundledPath 随应用内置分发的相对路径（如 'renderer/vendor/soundfonts/GeneralUser.sf2'），存在则无需下载
  //   pre(挂)   选择后用途说明（播放时音色倾向）
  const REGISTRY = [
    {
      id: 'generaluser_gs',
      name: 'GeneralUser GS',
      version: 'v1.471',
      desc: '均衡通用的 General MIDI 音色，体积小巧、兼容性极好，适合绝大多数 MIDI 的日常聆听与试听。',
      size: 38000000,
      license: 'CC BY 3.0 · 可免费用于个人/商用，见包内许可证',
      minSize: 25000000,
      fromRepo: 'ROCKNIX/generaluser-gs',
      repoFile: 'GeneralUser GS v1.471.sf2',
      urls: [
        _releaseBase + '/GeneralUser.GS.v1.471.sf2',   // 自家镜像仓库（Release 附件，经 gh.jasonzeng.dev 加速）
      ],
      bundledPath: 'renderer/vendor/soundfonts/GeneralUser.sf2',   // 内置随包分发，无需下载
    },
    {
      id: 'fluidr3',
      name: 'FluidR3_GM',
      version: '3.1',
      desc: '经典 Fluid R3 通用音色，动态丰满、乐器范围广，是许多音乐软件默认使用的免费音色。',
      size: 148000000,
      license: 'MIT · 可自由使用/分发（保留署名）',
      minSize: 90000000,
      fromRepo: 'pianobooster/fluid-soundfont',
      repoFile: null, // FluidR3 以 GitHub Release 附件形式分发（仓库内无 raw 文件）
      urls: [
        _releaseBase + '/FluidR3_GM.sf2',   // 自家镜像仓库（优先，经 gh.jasonzeng.dev 加速）
        'https://sourceforge.net/projects/androidframe/files/soundfonts/FluidR3_GM.sf2/download', // 官方回退
      ],
      bundledPath: null,
    },
    {
      id: 'arachno',
      name: 'Arachno SoundFont',
      version: '1.0',
      desc: '游戏/怀旧风格浓重的精调音色，乐器辨识度极高，适合游戏音乐和历史 MIDI 的还原试听。',
      size: 148000000,
      license: '免费可自由使用（官方许可）',
      minSize: 90000000,
      fromRepo: 'rwtnb/Drumsthesia',
      repoFile: 'Arachno SoundFont - Version 1.0.sf2',
      bundledPath: null,
    },
    {
      id: 'timbres',
      name: 'Timbres of Heaven',
      version: '最新',
      desc: '轻量但高品质的 GM 音色库，乐器还原自然耐听，体积紧凑适合快速加载。',
      size: 30000000,
      license: '免费音色（作者 S. Christian Collins 授权）',
      minSize: 18000000,
      fromRepo: null,
      repoFile: null,
      bundledPath: null,
    },
    {
      id: 'sgm_v2',
      name: 'SGM-V2.01',
      version: '2.01',
      desc: '备受好评的高品质多采样 GM 音色，细节丰富、动态自然，追求更真实音色时的首选。',
      size: 300000000,
      license: '免费个人/商用（SGM 许可条款）',
      minSize: 2e8,
      fromRepo: null,
      repoFile: null,
      bundledPath: null,
    },
    {
      id: 'aspirin_dx',
      name: 'Aspirin-DX Soundbank',
      version: 'DX',
      desc: '复古电子/DX 合成器风格音色，适合电子乐和较“闪亮”的 MIDI 重演绎。',
      size: 12500000,
      license: '免费可自由使用',
      minSize: 6000000,
      fromRepo: null,
      repoFile: null,
      bundledPath: null,
    },
    {
      id: 'salamander',
      name: 'Salamander Grand Piano',
      version: 'v3',
      desc: '单件三角钢琴多力度采样音色，专为钢琴曲目设计，音色纯净自然。',
      size: 200000000,
      license: 'CC BY 3.0（使用需署名原钢琴录音艺术家）',
      minSize: 1.2e8,
      fromRepo: 'bramanp/salamander-grand-piano-sf2',
      repoFile: null, // 以 Release 附件分发
      bundledPath: null,
    },
  ];

  const sfDir = () => path.join(app.getPath('userData'), 'fufumidi', 'soundfonts');
  // 内置随包 SF 目录（soundfont:list 已扫描），这里作为“已内置可用”的判定来源
  const bundledDir = () => path.join(__dirname, '..', 'renderer', 'vendor', 'soundfonts');

  // 已完成下载判定：registry 目标文件存在且 ≥ minSize
  function localFilePath(item) {
    if (item.bundledPath) return path.join(__dirname, '..', item.bundledPath);
    return path.join(sfDir(), sfFileName(item));
  }
  // 仓库内的目标文件名：优先显式 repoFile，否则从 fromRepo 派生
  function sfFileName(item) {
    if (item.repoFile) return item.repoFile;
    return item.name.replace(/[^a-zA-Z0-9._ -]/g, '').trim() + '.sf2';
  }

  async function statFile(p) {
    try {
      const st = await fs.promises.stat(p);
      return st.isFile() ? st.size : 0;
    } catch (e) { return 0; }
  }

  // GitHub raw 候选 URL 列表（对 fromRepo+repoFile 派生镜像路径）
  function githubRawCandidates(item) {
    if (!item.fromRepo || !item.repoFile) return [];
    const enc = item.repoFile.split('/').map(x => encodeURIComponent(x)).join('/');
    return _ghHosts.map(h => `${h}/${item.fromRepo}/main/${enc}`);
  }

  // 汇总：registry 中每个库的存在状态 + 用户自定义 SF2 列表
  ipcMain.handle('sf-workshop:list', async () => {
    const out = [];
    for (const it of REGISTRY) {
      const p = localFilePath(it);
      const size = await statFile(p);
      out.push({
        id: it.id, name: it.name, version: it.version, desc: it.desc,
        size, expected: it.size, license: it.license,
        downloaded: size >= it.minSize,
        builtin: !!it.bundledPath && size >= it.minSize,
        path: p,
        sources: (githubRawCandidates(it).length ? ['github'] : []) ,
        category: '内置精选',
      });
    }
    // 用户自定义 SF2（拷贝到 userData/fufumidi/soundfonts，非注册表项）
    const customs = [];
    try {
      fs.mkdirSync(sfDir(), { recursive: true });
      for (const f of fs.readdirSync(sfDir())) {
        if (!/\.(sf2|sf3)$/i.test(f)) continue;
        const p = path.join(sfDir(), f);
        const size = await statFile(p);
        customs.push({ id: 'custom:' + f, name: f.replace(/\.[^.]+$/, ''), desc: '用户导入的音色库', size, downloaded: size > 0, builtin: false, category: '我的音色', custom: true, path: p });
      }
    } catch (e) {}
    return { registry: out, customs, dir: sfDir() };
  });

  // 下载进度缓存：供取消
  const _aborts = new Map();

  ipcMain.handle('sf-workshop:download', async (_e, id) => {
    const it = REGISTRY.find(x => x.id === id);
    if (!it) return { ok: false, error: '未知音色库: ' + id };
    const win = BrowserWindow.fromWebContents(_e.sender);
    const send = (p) => { if (win && !win.isDestroyed()) win.webContents.send('sf-workshop:progress', p); };
    // 已存在完整 → 直接返回
    const cur = await statFile(localFilePath(it));
    if (cur >= it.minSize) { send({ id, received: cur, total: cur, percent: 100, done: true }); return { ok: true, existed: true }; }
    fs.mkdirSync(sfDir(), { recursive: true });
    const out = localFilePath(it);
    // 候选 URL 列表：仓库 raw 镜像 + 官方源（fallback）
    const candidates = [...githubRawCandidates(it), ...(it.urls || [])].filter(Boolean);

    const ctrl = new AbortController();
    _aborts.set(id, ctrl);
    let total = 0, lastErr = null;
    let ws = null;
    try {
      for (let i = 0; i < candidates.length; i++) {
        const url = candidates[i];
        let received = 0;
        try {
          const r = await net.fetch(url, { headers: { 'user-agent': 'FuFumidi' }, signal: ctrl.signal });
          if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
          if (total === 0) total = parseInt(r.headers.get('content-length') || '0', 10);
          ws = fs.createWriteStream(out + '.part');
          ws.on('error', () => {});
          const reader = r.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.length;
            send({ id, received, total: total || (it.size * 1.2), percent: total ? Math.min(99, Math.round(received / total * 100)) : 99, done: false });
            await new Promise((res2, rej2) => ws.write(Buffer.from(value), err => (err ? rej2(err) : res2())));
          }
          await new Promise((res2, rej2) => ws.end(err => (err ? rej2(err) : res2())));
          const st = await fs.promises.stat(out + '.part');
          if (st.size < it.minSize) { try { fs.rmSync(out + '.part', { force: true }); } catch (_) {} throw new Error('文件不完整'); }
          await fs.promises.rename(out + '.part', out);
          const fin = await statFile(out);
          send({ id, received: fin, total: fin, percent: 100, done: true });
          _aborts.delete(id);
          return { ok: true, path: out, size: fin };
        } catch (e) {
          lastErr = e;
          try { if (ws) ws.destroy(); } catch (_) {}
          try { fs.rmSync(out + '.part', { force: true }); } catch (_) {}
          send({ id, received: 0, total: total || it.size, percent: 0, done: false, error: '第 ' + (i + 1) + ' 个源失败：' + (e && e.message) });
        }
      }
      // 无自动下载源时给出明确指引；有源但全部失败则提示网络不可达/手动导入
      if (!candidates.length) {
        return { ok: false, error: '该音色暂无自动下载源，请自行获取 .sf2 后到「我的音色」手动导入。' };
      }
      if (lastErr) {
        return { ok: false, error: '自动下载失败（当前网络或镜像不可达）。可在「我的音色」中点击导入，手动选择已下载的 .sf2 文件。' };
      }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      _aborts.delete(id);
      try { fs.rmSync(out + '.part', { force: true }); } catch (_) {}
    }
    return { ok: false, error: '未知错误' };
  });

  ipcMain.handle('sf-workshop:cancel', async (_e, id) => {
    try { const c = _aborts.get(id); if (c) c.abort(); } catch (e) {}
    return { ok: true };
  });

  // 导入本地 .sf2：原生文件对话框 → 拷贝到 userData soundfonts 目录
  ipcMain.handle('sf-workshop:import', async (_e) => {
    const { dialog } = require('electron');
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'SoundFont (SF2/SF3)', extensions: ['sf2', 'sf3'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    const src = r.filePaths[0];
    const base = path.basename(src);
    fs.mkdirSync(sfDir(), { recursive: true });
    const dst = path.join(sfDir(), base);
    if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
    fs.copyFileSync(src, dst);
    return { ok: true, path: dst, name: base };
  });

  // 删除（自定义音色或已下载的注册表库）
  ipcMain.handle('sf-workshop:delete', async (_e, id) => {
    try {
      const target = REGISTRY.find(x => x.id === id);
      let p = null;
      if (target) p = localFilePath(target);
      else if (id && id.startsWith('custom:')) p = path.join(sfDir(), id.slice('custom:'.length));
      if (!p || !fs.existsSync(p)) return { ok: false, error: 'not found' };
      fs.rmSync(p, { force: true });
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // 打开音色目录（管理自定义文件）
  ipcMain.handle('sf-workshop:openDir', async () => {
    try {
      fs.mkdirSync(sfDir(), { recursive: true });
      const { shell } = require('electron');
      shell.openPath(sfDir());
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // ---- 导出 sfDir 供主进程其它模块/设置使用 ----
  return { sfDir, REGISTRY };
}

module.exports = { registerSoundfontWorkshopIpc };