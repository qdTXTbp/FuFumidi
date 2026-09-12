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
      // Arachno：上游仓库该文件为 Git LFS（raw 直链只返回 134 字节指针），必须走
      // media.githubusercontent.com 真身；gh.jasonzeng.dev 可代理该域名做国内加速。
      id: 'arachno',
      name: 'Arachno SoundFont',
      version: '1.0',
      desc: '游戏/怀旧风格浓重的精调音色，乐器辨识度极高，适合游戏音乐和历史 MIDI 的还原试听。',
      size: 155000000,
      license: '免费可自由使用（官方许可）',
      minSize: 90000000,
      fromRepo: null,
      repoFile: null,
      bundledPath: null,
      urls: [
        // 主源：自家 soundfonts-v1 Release（prerelease）经 ghfast/gh.jasonzeng 加速——
        // 上游该文件是 Git LFS，raw 直链只回 134 字节指针，直连 media CDN 从国内又极易中断
        'https://gh.jasonzeng.dev/https://github.com/qdTXTbp/FuFumidi/releases/download/soundfonts-v1/Arachno_SoundFont_Version_1.0.sf2',
        'https://ghfast.top/https://github.com/qdTXTbp/FuFumidi/releases/download/soundfonts-v1/Arachno_SoundFont_Version_1.0.sf2',
        'https://github.com/qdTXTbp/FuFumidi/releases/download/soundfonts-v1/Arachno_SoundFont_Version_1.0.sf2',
        // 回退：LFS 真身（无加速，不稳定）+ archive.org 裸 SF2
        'https://media.githubusercontent.com/media/rwtnb/Drumsthesia/main/Arachno%20SoundFont%20-%20Version%201.0.sf2',
        'https://archive.org/download/free-soundfonts-sf2-2019-04/Arachno_SoundFont_Version_1.0.sf2',
      ],
    },
    {
      // Timbres of Heaven：作者许可条款禁止未经书面授权再分发（只能链官方页），且官方
      // 分发为 .7z 压缩包（工具内无解包运行时）→ 标记 manual，UI 显示「前往官网」+ 手动导入。
      id: 'timbres',
      name: 'Timbres of Heaven',
      version: '4.0 (XGM)',
      desc: '高品质全能 GM/XGM 音色库（约 370MB），乐器还原自然耐听。受作者许可条款限制不提供自动下载，请前往官网下载解压后导入。',
      size: 370000000,
      license: '免费使用 · 不可再分发（Don Allen / Midkar 授权条款）',
      minSize: 180000000,
      fromRepo: null,
      repoFile: null,
      bundledPath: null,
      manual: true,
      officialUrl: 'https://midkar.com/SoundFonts/index.html',
    },
    {
      // SGM-V2.01 官方按 GitHub 100MB 限制拆为 3 个独立 SF2 分发（乐器号互补，均为完整合法音色库）。
      // 应用内提供三份独立下载/启用；一份覆盖不全 GM 时按需搭配。
      id: 'sgm_v2_part1',
      name: 'SGM-V2.01 (Part 1)',
      version: '2.01',
      desc: '高品质多采样 GM 音色之一：含钢琴/风琴/吉他等前 31 号乐器（Program 0–30）。',
      size: 101600000,
      license: '免费个人/商用（SGM 许可条款）',
      minSize: 90000000,
      fromRepo: null,
      repoFile: null,
      urls: [
        _releaseBase + '/SGM_V2_01_part1.sf2',   // 自家镜像仓库（Release 附件，经 gh.jasonzeng.dev 加速）
      ],
      bundledPath: null,
    },
    {
      id: 'sgm_v2_part2',
      name: 'SGM-V2.01 (Part 2)',
      version: '2.01',
      desc: '高品质多采样 GM 音色之一：含贝斯/弦乐/铜管/木管等中段乐器（Program 31–79）。',
      size: 104400000,
      license: '免费个人/商用（SGM 许可条款）',
      minSize: 90000000,
      fromRepo: null,
      repoFile: null,
      urls: [
        _releaseBase + '/SGM_V2_01_part2.sf2',   // 自家镜像仓库（Release 附件，经 gh.jasonzeng.dev 加速）
      ],
      bundledPath: null,
    },
    {
      id: 'sgm_v2_part3',
      name: 'SGM-V2.01 (Part 3)',
      version: '2.01',
      desc: '高品质多采样 GM 音色之一：含合成音色/SFX 与全部鼓组（Program 80–127 + 鼓）。',
      size: 99500000,
      license: '免费个人/商用（SGM 许可条款）',
      minSize: 90000000,
      fromRepo: null,
      repoFile: null,
      urls: [
        _releaseBase + '/SGM_V2_01_part3.sf2',   // 自家镜像仓库（Release 附件，经 gh.jasonzeng.dev 加速）
      ],
      bundledPath: null,
    },
    {
      // Aspirin-DX：上游 NeoSoundFonts 持续维护（libre 重制版），直接链其 Release 附件，
      // 走 gh.jasonzeng.dev / ghfast 代理加速 + 官方直连回退。
      id: 'aspirin_dx',
      name: 'Aspirin-DX Soundbank',
      version: '2026-07-08',
      desc: 'FM 合成器风格的 GM 音色库（Fairytale Edition，libre 重制版），复古电子乐与合成器音色出彩。',
      size: 69000000,
      license: 'libre 开源重制（NeoSoundFonts 维护）',
      minSize: 60000000,
      fromRepo: null,
      repoFile: null,
      bundledPath: null,
      urls: [
        'https://gh.jasonzeng.dev/https://github.com/NeoSoundFonts/Aspirin-DX-Soundbank/releases/download/2026-07-08/Version-20260708.sf2',
        'https://ghfast.top/https://github.com/NeoSoundFonts/Aspirin-DX-Soundbank/releases/download/2026-07-08/Version-20260708.sf2',
        'https://github.com/NeoSoundFonts/Aspirin-DX-Soundbank/releases/download/2026-07-08/Version-20260708.sf2',
      ],
    },
    {
      // Salamander：上游 FreePats 只分发 tar.xz 压缩包（工具内无法解包）且无 GitHub 托管的
      // 裸 SF2 → 解包后随自家 soundfonts-v1 Release（prerelease）分发，CC-BY-3.0 允许再分发。
      id: 'salamander',
      name: 'Salamander Grand Piano',
      version: '3+20200602',
      desc: '单件三角钢琴多力度采样音色（Yamaha C5，16 力度层），专为钢琴曲目设计，音色纯净自然。',
      size: 310000000,
      license: 'CC BY 3.0（使用需署名原钢琴录音艺术家）',
      minSize: 1.2e8,
      fromRepo: null,
      repoFile: null,
      bundledPath: null,
      urls: [
        'https://gh.jasonzeng.dev/https://github.com/qdTXTbp/FuFumidi/releases/download/soundfonts-v1/Salamander_Grand_Piano_SF2_V3_20200602.sf2',
        'https://ghfast.top/https://github.com/qdTXTbp/FuFumidi/releases/download/soundfonts-v1/Salamander_Grand_Piano_SF2_V3_20200602.sf2',
        'https://github.com/qdTXTbp/FuFumidi/releases/download/soundfonts-v1/Salamander_Grand_Piano_SF2_V3_20200602.sf2',
      ],
    },

    // ---------- 以下 8 款与手机端 FuMiVoice「音色库」目录保持一致 ----------
    // 源速度：jsDelivr 实测约 2.6MB/s，但对单文件限 20MB、对单仓库限 50MB；
    // 雅马哈三角钢琴 / Galaxy 电钢 / Supersaw / GIGA FM 体积超限只能走第三方 GitHub Pages，
    // 实测仅约 24KB/s —— 这几项标 slow，由界面提前告知用户“较慢”，避免误以为卡住。
    {
      id: 'fluidr3_mono',
      name: 'FluidR3 Mono GM',
      version: '3.1 (mono)',
      fileName: 'FluidR3Mono_GM.sf3',
      desc: '完整 128 音色 + 鼓组，音色均衡自然，日常聆听首选；单声道 SF3 体积仅约 14MB，载入很快。',
      size: 14563174,
      license: 'CC BY 3.0 · 可自由使用（保留署名）',
      minSize: 9000000,
      fromRepo: null,
      repoFile: null,
      bundledPath: null,
      category: '通用音色库',
      urls: ['https://cdn.jsdelivr.net/gh/musescore/MuseScore@2.1/share/sound/FluidR3Mono_GM.sf3'],
    },
    {
      id: 'fm_gm_mini',
      name: 'FM/GM 紧凑版',
      fileName: 'FM_GM_SoundFont_mini.sf2',
      desc: '完整 GM，FM 合成味道，复古游戏机听感，兼容 GS/XG/GM2 别名。',
      size: 14337918,
      license: 'GPL-3.0',
      minSize: 9000000,
      fromRepo: null,
      repoFile: null,
      bundledPath: null,
      category: '通用音色库',
      urls: ['https://cdn.jsdelivr.net/gh/zeittresor/opensoundfont@main/FM_GM_SoundFont_v0_2_1_mini.sf2'],
    },
    {
      id: 'giga_fm_gm',
      name: 'GIGA FM GM',
      fileName: 'giga-hq-fm-gm.sf2',
      desc: '完整 GM，FM 合成味道更重，复古游戏机听感。',
      size: 20575222,
      license: 'CC BY 4.0',
      minSize: 13000000,
      fromRepo: null,
      repoFile: null,
      bundledPath: null,
      category: '通用音色库',
      slow: true,
      urls: ['https://smpldsnds.github.io/soundfonts/soundfonts/giga-hq-fm-gm.sf2'],
    },
    {
      id: 'yamaha_grand',
      name: '雅马哈 C5 三角钢琴',
      fileName: 'yamaha-grand-lite.sf2',
      desc: '单独强化的钢琴音色，弹钢琴曲首选。',
      size: 21782810,
      license: 'GPL-3.0',
      minSize: 14000000,
      fromRepo: null,
      repoFile: null,
      bundledPath: null,
      category: '单音色强化',
      slow: true,
      urls: ['https://smpldsnds.github.io/soundfonts/soundfonts/yamaha-grand-lite.sf2'],
    },
    {
      id: 'galaxy_ep',
      name: 'Galaxy 电钢琴',
      fileName: 'galaxy-electric-pianos.sf2',
      desc: '电钢琴合集，适合流行与爵士。',
      size: 30299302,
      license: 'GPL-3.0',
      minSize: 19000000,
      fromRepo: null,
      repoFile: null,
      bundledPath: null,
      category: '单音色强化',
      slow: true,
      urls: ['https://smpldsnds.github.io/soundfonts/soundfonts/galaxy-electric-pianos.sf2'],
    },
    {
      id: 'supersaw',
      name: 'Supersaw 合成音色',
      fileName: 'supersaw-collection.sf2',
      desc: '60 个锯齿波音色，电子舞曲风格。',
      size: 56358642,
      license: 'GPL-3.0',
      minSize: 35000000,
      fromRepo: null,
      repoFile: null,
      bundledPath: null,
      category: '合成与电子',
      slow: true,
      urls: ['https://smpldsnds.github.io/soundfonts/soundfonts/supersaw-collection.sf2'],
    },
    {
      id: 'florestan',
      name: 'Florestan 轻量 GM',
      fileName: 'florestan-subset.sf2',
      desc: '约 0.5MB 的极简 GM 子集，秒下秒加载，适合快速试听。',
      size: 531786,
      license: '公共素材',
      minSize: 330000,
      fromRepo: null,
      repoFile: null,
      bundledPath: null,
      category: '轻量音色库',
      urls: ['https://cdn.jsdelivr.net/gh/schellingb/TinySoundFont@master/examples/florestan-subset.sf2'],
    },
    {
      id: 'vintage_dreams',
      name: 'Vintage Dreams Waves',
      fileName: 'VintageDreamsWaves-v2.sf2',
      desc: '约 0.3MB 的复古合成波形，怀旧电子音色。',
      size: 314640,
      license: '公共素材',
      minSize: 200000,
      fromRepo: null,
      repoFile: null,
      bundledPath: null,
      category: '轻量音色库',
      urls: ['https://cdn.jsdelivr.net/gh/FluidSynth/fluidsynth@master/sf2/VintageDreamsWaves-v2.sf2'],
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
  // 仓库内的目标文件名：优先显式 fileName（与手机端同名，便于跨端对应），
  // 其次 repoFile，最后从显示名派生
  function sfFileName(item) {
    if (item.fileName) return item.fileName;
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
        manual: !!it.manual, officialUrl: it.officialUrl || '',
        path: p,
        sources: (githubRawCandidates(it).length ? ['github'] : []) ,
        category: it.category || '内置精选',
        slow: !!it.slow,
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
    // 许可受限音色（如 Timbres of Heaven）：不提供自动下载，引导官网获取后手动导入
    if (it.manual) return { ok: false, manual: true, officialUrl: it.officialUrl || '', error: '该音色受作者许可条款限制，不提供自动下载。请前往官网下载并解压，再通过「导入 .sf2 音色」导入。' };
    const win = BrowserWindow.fromWebContents(_e.sender);
    const send = (p) => { if (win && !win.isDestroyed()) win.webContents.send('sf-workshop:progress', p); };
    // 已存在完整 → 直接返回
    const cur = await statFile(localFilePath(it));
    if (cur >= it.minSize) { send({ id, received: cur, total: cur, percent: 100, done: true }); return { ok: true, existed: true }; }
    fs.mkdirSync(sfDir(), { recursive: true });
    const out = localFilePath(it);
    // 候选 URL 列表：仓库 raw 镜像 + 官方源（fallback）
    const candidates = [...githubRawCandidates(it), ...(it.urls || [])].filter(Boolean);

    // 健壮下载：多源轮换 + 断点续传（.part 保留跨轮次/跨调用）+ 停滞看门狗
    //  - STALL_MS 内没有任何字节到达 → 取消当前流，换下一个源（或同源 Range 续传）
    //  - 416（Range 越界，.part 过期/损坏）→ 丢弃 .part 重下
    //  - 用户取消走 ctrl.abort()（isUserAbort 标记），与停滞中止区分
    const STALL_MS = 25000;
    const MAX_ROUNDS = 10;
    const entry = { ctrl: null, isUserAbort: false };
    _aborts.set(id, entry);
    let ws = null, lastErr = null;

    const sendProg = (received, expectTotal, done, error) => {
      send({ id, received, total: expectTotal || (it.size * 1.2), percent: done ? 100 : (expectTotal ? Math.min(99, Math.round(received / expectTotal * 100)) : 99), done: !!done, error: error || '' });
    };

    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const url = candidates[round % candidates.length];
        const ctrl = new AbortController();
        entry.ctrl = ctrl;
        let received = 0, expectTotal = 0;
        try {
          const have = await statFile(out + '.part');
          const headers = { 'user-agent': 'FuFumidi' };
          if (have > 0) headers['range'] = 'bytes=' + have + '-';
          const r = await net.fetch(url, { headers, signal: ctrl.signal });
          if (r.status === 416) { // .part 越界（过期/损坏）→ 丢弃重下
            try { fs.rmSync(out + '.part', { force: true }); } catch (_) {}
            throw new Error('断点越界已重置');
          }
          if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
          const clen = parseInt(r.headers.get('content-length') || '0', 10);
          const resumable = r.status === 206 && have > 0;
          if (!resumable && have > 0) { try { fs.rmSync(out + '.part', { force: true }); } catch (_) {} } // 全量重下
          received = resumable ? have : 0;
          expectTotal = clen ? received + clen : 0;
          ws = fs.createWriteStream(out + '.part', { flags: resumable ? 'a' : 'w' });
          ws.on('error', () => {});
          const reader = r.body.getReader();
          let lastData = Date.now();
          const watchdog = setInterval(() => {
            if (Date.now() - lastData > STALL_MS) {
              try { reader.cancel('stalled'); } catch (_) {}
              try { ctrl.abort(); } catch (_) {} // 兜底：流不响应 cancel 时强制中断
            }
          }, 3000);
          let got = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              lastData = Date.now();
              got += value.length;
              received = (resumable ? have : 0) + got;
              sendProg(received, expectTotal, false);
              await new Promise((res2, rej2) => ws.write(Buffer.from(value), err => (err ? rej2(err) : res2())));
            }
          } finally { clearInterval(watchdog); }
          await new Promise((res2, rej2) => ws.end(err => (err ? rej2(err) : res2())));
          const st = await fs.promises.stat(out + '.part');
          if (st.size < it.minSize) { lastErr = new Error('文件不完整（' + st.size + ' < ' + it.minSize + '）'); sendProg(st.size, it.size, false, lastErr.message); continue; }
          await fs.promises.rename(out + '.part', out);
          const fin = await statFile(out);
          sendProg(fin, fin, true);
          return { ok: true, path: out, size: fin };
        } catch (e) {
          lastErr = e;
          try { if (ws) ws.destroy(); } catch (_) {}
          ws = null;
          if (entry.isUserAbort) return { ok: false, cancelled: true, error: '已取消' };
          const have = await statFile(out + '.part');
          sendProg(have, it.size, false, '第 ' + (round + 1) + ' 轮失败（' + ((e && e.message) || e) + '），自动换源/续传…');
        }
      }
      // 全部轮次失败：.part 保留，用户重试可续传
      const have = await statFile(out + '.part');
      const tail = have > 0 ? '。已有 ' + Math.round(have / 1048576) + 'MB 断点，再次点击下载将从断点继续。' : '。也可在「我的音色」手动导入。';
      return { ok: false, error: '自动下载失败（已多源轮换重试 ' + MAX_ROUNDS + ' 轮）：' + ((lastErr && lastErr.message) || '网络不可达') + tail };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      _aborts.delete(id);
    }
  });

  ipcMain.handle('sf-workshop:cancel', async (_e, id) => {
    try { const c = _aborts.get(id); if (c) { c.isUserAbort = true; c.ctrl.abort(); } } catch (e) {}
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