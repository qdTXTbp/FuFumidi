// ============================================================
// 主进程模型服务：模型注册表、下载/暂停/取消、目录监听
// ============================================================
'use strict';

const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const Paths = require('./paths');
const { safeExtractAllTo } = require('./zip-safe');
const MSST_CATALOG = require('./models-msst-catalog');
const SepCommon = require('./separate-common');
const DS = require('./download-source');
const createFastDownload = require('./fast-download');
const SVC = require('./svc');

function registerModelsIpc({ ipcMain, BrowserWindow, app, path, fs, net, modelsDir, engineDir, sha256File, readSettings, resolvePython }) {
  const _folderWatchers = new Map();

  // 本模块不再自带下载器：所有「取文件字节」的活统一交给 main/fast-download.js
  //（多源测速 / 分段并发 / 多文件并发 / 断点续传 / 停滞看门狗 / 低速轮换 / 完整性校验）。
  // 规范见 docs/DOWNLOADS.md —— 新增下载点必须走 FastDL，不许再写 fetch+写盘循环。

  // 内置模型注册表：本地模型清单 + 缺失模型官方源一键下载（带进度/取消）
  // 条目字段：
  //   url       单文件直链（可选，自动叠加 gh 镜像回退）
  //   repo      HuggingFace 仓库（type='hf'，走 HF 官方 / hf-mirror 双渠道，整仓递归下载）
  //   dest      本地相对路径（文件或目录）
  // 清除断链占位：安装器更新会整体替换 resources/models，指向旧内置模型的 junction
  // 目标随之消失，残留断链让 mkdir/statSync 报 ENOENT（「模型下载损坏 / 无法下载」的根因）。
  // 下载前对 modelsDir 顶层子项做一次清理，保证目标路径可正常创建。
  function healBrokenModelLinks() {
    try {
      const root = modelsDir();
      for (const name of fs.readdirSync(root)) {
        const p = path.join(root, name);
        let st = null;
        try { st = fs.statSync(p); } catch (_) {}
        if (!st) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
      }
    } catch (_) {}
  }
  const MODEL_REGISTRY = {
    piano_transcription: {
      id: 'piano_transcription',
      name: '钢琴转录模型',
      note: 'piano-transcription CRNN（含踏板检测）· 约 166 MB',
      kind: 'transcribe',
      arch: 'Piano-Transformer',
      use: '钢琴转录：和弦、旋律与踏板落音，适合纯钢琴曲快速转 MIDI',
      dest: path.join('piano_transcription', 'note_F1=0.9677_pedal_F1=0.9186.pth'),
      url: 'https://zenodo.org/record/4034264/files/CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth?download=1',
      minSize: 1.6e8,
      downloadable: true,
      runtime: 'piano',
    },
    // 通用多乐器转录（Kyutai MuScriptor，默认不随 Release 分发，需到资源中心下载）
    // 注意：MuScriptor 权重经 monologue82/Models 仓库分卷分发（gh.jasonzeng.dev 加速 + 多镜像回退，
    // 25MB part 并行下载 → 合并 → SHA256 校验），无需 HuggingFace 授权。
    muscriptor_small: {
      id: 'muscriptor_small',
      name: 'MuScriptor Small',
      note: '多乐器转录 · 103M 参数 · 约 400 MB · GitHub 镜像分卷下载',
      kind: 'transcribe',
      arch: 'MuScriptor',
      use: '通用多乐器转录：103M 参数，轻量快速，适合快速出草稿',
      type: 'ghsplit',
      sizeKey: 'small',
      repo: 'monologue82/Models',
      dest: path.join('muscriptor', 'small'),
      minSize: 5e7,
      downloadable: true,
      runtime: 'muscriptor',
    },
    muscriptor_medium: {
      id: 'muscriptor_medium',
      name: 'MuScriptor Medium',
      note: '多乐器转录 · 307M 参数（推荐）· 约 1.2 GB · GitHub 镜像分卷下载',
      kind: 'transcribe',
      arch: 'MuScriptor',
      use: '通用多乐器转录：307M 参数，精度与速度均衡（推荐）',
      type: 'ghsplit',
      sizeKey: 'medium',
      repo: 'monologue82/Models',
      dest: path.join('muscriptor', 'medium'),
      minSize: 2e8,
      downloadable: true,
      runtime: 'muscriptor',
    },
    muscriptor_large: {
      id: 'muscriptor_large',
      name: 'MuScriptor Large',
      note: '多乐器转录 · 1.4B 参数 · 约 5.2 GB · GitHub 镜像分卷下载',
      kind: 'transcribe',
      arch: 'MuScriptor',
      use: '通用多乐器转录：1.4B 参数，多轨精准，适合复杂编曲',
      type: 'ghsplit',
      sizeKey: 'large',
      repo: 'monologue82/Models',
      dest: path.join('muscriptor', 'large'),
      minSize: 9e8,
      downloadable: true,
      runtime: 'muscriptor',
    },
    // 节拍网格检测（Beat This!）：MuScriptor 转录做音符时值对齐的可选前处理权重。
    // 原版经 torch.hub 从 JKU 云盘下载并缓存到系统 ~/.cache/torch（可能截断/联网失败/落外部盘），
    // 这里纳入资源中心，走国内/多源回退下载，落到软件 models 目录内的 hub/checkpoints 供 torch.hub 复用。
    beat_this: {
      id: 'beat_this',
      name: '节拍网格检测（Beat This!）',
      note: 'MuScriptor 转录时值对齐 · final0 · 约 81 MB · 多源并行加速下载',
      kind: 'transcribe',
      arch: 'BeatThis',
      use: 'MuScriptor 转录可选前置：节拍网格检测，提升音符时值 / 对齐（未下载或失败时自动跳过）',
      dest: path.join('hub', 'checkpoints', 'beat_this-final0.ckpt'),
      url: 'https://raw.githubusercontent.com/monologue82/Models/main/beat_this/beat_this-final0.ckpt',
      // 完整性校验（对已验证可用的 final0 权重计算）：分段并行下载后校验，防止镜像返回
      // 截断/被改写的文件被当成模型装进本地
      sha256: '8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331',
      minSize: 7e7,
      downloadable: true,
      runtime: 'muscriptor',
    },
    // 钢琴转录（EleutherAI Aria-AMT）
    aria_amt: {
      id: 'aria_amt',
      name: 'Aria-AMT 钢琴',
      note: 'EleutherAI · 钢琴转录（Apache-2.0）· 约 680 MB',
      kind: 'transcribe',
      arch: 'Aria-AMT',
      use: '钢琴转录：Aria-AMT 强化模型，和弦与演奏细节更准',
      type: 'hf',
      repo: 'AEmotionStudio/aria-amt-models',
      dest: path.join('aria_amt'),
      // 主体权重 426MB 已镜像到 CNB（Release 资产）：
      // huggingface.co 在国内连不通、hf-mirror.com 实测只有 2~3MB/s，
      // 而同一文件走 CNB 可达 20MB/s 以上。命中这条就直接取国内源，失败自动回落 HF 渠道。
      // 注意 CNB 的 git raw 上限 100MiB，426MB 只能走 Release 资产通道。
      cnbMirror: { tag: 'models-extra-v1', files: ['piano-medium-double-1.0.safetensors'] },
      minSize: 1e8,
      downloadable: true,
      runtime: 'aria',
    },
    // Worldline v11（R1.1）的谐波/噪声分离模型。
    // ★ 它是 `.oudep` —— **内容就是 zip**（实测前 4 字节 50 4B 03 04：hnsep.yaml + model.onnx
    //   + oudep.yaml + LICENSE）。所以走 `unpack`：下到 <dest>.oudep → 校验 sha256 →
    //   解包进 dest → 删掉压缩包。落点**必须**与引擎侧一致
    //   （engine/singing/openutau/hnsep.py 的 PACKAGE_DIR_REL = hnsep/hnsep_240512），
    //   否则会出现「下载完了 v11 还说没装」—— 这种不一致**不报错**，最难查。
    //   kind 用 'tuning'：★ 2026-10-14 按用户要求，资源中心改成两级分类 ——
    //   顶层「调教」下面再分 声库 / 音色 / 调教模型。hnsep 只在调教渲染时用得到，
    //   放「人声分离」会让用户去错地方找（那也是它一开始的归属，已按用户意见修正）。
    hnsep_240512: {
      id: 'hnsep_240512',
      name: 'hnsep 谐波分离（Worldline v11）',
      note: '约 52 MB · MIT（tsurumeso/vocal-remover）',
      kind: 'tuning',
      arch: 'Hnsep ONNX（STFT 复数掩码）',
      use: '把原音拆成「谐波 + 噪声」两路，气声与辅音更真。只有「轨道渲染器」选 Worldline v11 时才用得到；没装时 v11 会给出明确报错。',
      dest: path.join('hnsep', 'hnsep_240512'),
      unpack: true,
      unpackMarker: 'hnsep.yaml',
      url: 'https://cnb.cool/FuFuCloud-mirror/Models/-/releases/download/hnsep-v1/hnsep_240512.oudep',
      sha256: '8f8c1046d0cacd40363e6f71d48bc1663e06a01d4625af0569055648d771ff92',
      size: 54934878,
      minSize: 5e7,
      downloadable: true,
      runtime: 'worldline-r11',
    },
  };
  // ===================== MSST 分离模型清单（动态） =====================
  // 数据源：monologue82/Models 仓库 manifest.json（vocal/multi/single/vr 全部分类）+ 本地目录（models-msst-catalog.js，
  // 简介与 model_viewer.html 逐条一致）。manifest 首次拉取后缓存到 modelsDir/msst-manifest.json，离线可复用。
  const _msstRegistry = {};
  // 自有 Models 仓库：GitHub 上游 + CNB 整树镜像（两者路径结构一致，只换前缀）
  const MODELS_GH_REPO = 'monologue82/Models';
  const MODELS_CNB_REPO = DS.CNB_MIRROR_REPOS.models;
  const GH_RAW_PREFIXES = [
    'https://gh.jasonzeng.dev/https://raw.githubusercontent.com',
    'https://raw.githubusercontent.com',
    'https://ghfast.top/https://raw.githubusercontent.com',
    'https://gh-proxy.com/https://raw.githubusercontent.com',
  ];
  /** 同一文件在「CNB 镜像 / GitHub 各加速前缀」下的候选地址，按下载源偏好排序 */
  function modelSrcUrls(relPath, ref = 'main') {
    const gh = GH_RAW_PREFIXES.map((h) => `${h}/${MODELS_GH_REPO}/${ref}/${relPath}`);
    const cnb = DS.cnbRepoRawUrl(MODELS_CNB_REPO, ref, relPath);
    return DS.orderUrls(cnb, gh, DS.sourceOf(readSettings()));
  }
  function inferMsstArch(name) {
    const n = String(name || '').toLowerCase();
    // ★ .pth/.pt 一律是 UVR(VR) 格式，**必须先判扩展名**：否则 "5_HP-Karaoke-UVR.pth"
    //   会被下面的 karaoke 分支吃掉、判成 Mel-Band Roformer，于是要求一份根本不存在、
    //   仓库里也没有的 .yaml（实测：这类模型白白被标成"缺配置"）。
    if (n.endsWith('.pth') || n.endsWith('.pt')) return 'UVR-VR';
    if (n.includes('mbr') || n.includes('reverb')) return n.includes('bs_') ? 'BS-Roformer' : 'Mel-Band Roformer';
    if (n.includes('mdx23c')) return 'MDX23C';
    if (n.includes('htdemucs') || n.includes('demucs')) return 'HTDemucs';
    if (n.includes('scnet')) return 'SCNet';
    if (n.includes('swin')) return 'Swin-UperNet';
    if (n.includes('apollo')) return 'Apollo';
    if (n.includes('segm')) return 'Segmentation';
    if (n.includes('bandit')) return 'Bandit';
    if (n.includes('drumsep')) return 'DrumSep';
    if (n.includes('bass')) return 'HTDemucs-FT Bass';
    if (n.includes('drums')) return 'HTDemucs-FT Drums';
    if (n.includes('vocals_official') || n.includes('vocals_htdemucs')) return 'HTDemucs Vocals';
    if (n.includes('roformer')) {
      // bs_roformer / bs-roformer / mel_band_roformer 等；按名称区分 Mel-Band 与 BS
      return (n.includes('mel') || n.includes('karaoke') || n.includes('band')) ? 'Mel-Band Roformer' : 'BS-Roformer';
    }
    if (n.includes('mel') || n.includes('v1e') || n.includes('beta5') || n.includes('crowd') || n.includes('karaoke')) return 'Mel-Band Roformer';
    if (n.endsWith('.pth')) return 'UVR-VR';
    return 'MSST';
  }
  function msstKind(cat) { return (cat === 'vocal' || cat === 'multi') ? 'separate' : 'other'; }
  /** 模型用途标注：把"这个模型到底能干什么/不能干什么"写清楚。
   *  2026-10-17 用户反馈：选 UVR-DeNoise / denoise_* 去现场录音，结果 clean 和原音一样 ——
   *  因为降噪模型只针对**稳态噪声**（底噪/嘶声/电流声），并不去观众声/混响，也不是人声分离。 */
  function sepUsageOf(file, cat) {
    const n = String(file || '').toLowerCase();
    if (n.includes('denoise')) {
      return { label: '降噪（仅稳态噪声：底噪 / 嘶声 / 电流声）',
        notFor: '不能去除现场观众声、混响或回声；也不会分离人声/伴奏' };
    }
    if (n.includes('dereverb') || n.includes('de_big_reverb') || n.includes('reverb')) {
      return { label: '去混响 / 去回声（场馆、房间混响）',
        notFor: '不分离人声与伴奏；也不是降噪（底噪请用 denoise 模型）' };
    }
    if (n.includes('crowd')) {
      return { label: '人群声分离（提取 / 去除现场观众声）',
        notFor: '不是通用降噪，也不分离人声与伴奏' };
    }
    if (n.includes('karaoke')) {
      return { label: '卡拉OK（去人声、出伴奏）', notFor: '' };
    }
    if (n.includes('drumsep') || n.includes('drum')) {
      return { label: '鼓组分离（单独提取鼓）', notFor: '' };
    }
    if (cat === 'multi') {
      return { label: '多音轨分离（人声 / 鼓 / 贝斯 / 其他等）', notFor: '' };
    }
    if (cat === 'vr') {
      if (n.includes('vocal') || n.includes('hp-uvr')) return { label: '人声分离（UVR 系列：出人声 / 伴奏）', notFor: '' };
      return { label: 'UVR 系列：人声 / 伴奏分离', notFor: '' };
    }
    if (n.includes('inst_v') || n.includes('instrumental') || n.includes('_inst.')) {
      return { label: '提取伴奏（乐器轨）', notFor: '' };
    }
    if (cat === 'vocal') {
      return { label: '人声 / 伴奏分离（出人声与伴奏两轨）', notFor: '' };
    }
    if (cat === 'single') {
      return { label: '单轨处理模型（只出一轨：干净声 / 目标声）', notFor: '' };
    }
    return { label: '音频分离', notFor: '' };
  }
  async function ensureMsstModels() {
    let manifest = null;
    const manifestFile = path.join(modelsDir(), 'msst-manifest.json');
    for (const u of modelSrcUrls('manifest.json')) {
      try {
        const r = await net.fetch(u, { headers: { 'user-agent': 'FuFumidi' } });
        if (r.ok) { manifest = await r.json(); break; }
      } catch (e) {}
    }
    if (!manifest) {
      try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (e) {}
    } else {
      try { fs.writeFileSync(manifestFile, JSON.stringify(manifest), 'utf8'); } catch (e) {}
    }
    // 幂等重建注册表
    for (const k of Object.keys(_msstRegistry)) delete _msstRegistry[k];
    if (manifest && typeof manifest === 'object') {
      for (const cat of ['vocal', 'multi', 'single', 'vr']) {
        const seg = manifest[cat];
        if (!seg || typeof seg !== 'object') continue;
        for (const key of Object.keys(seg)) {
          const meta = seg[key] || {};
          const file = meta.model;
          const hit = file ? MSST_CATALOG.find(x => x[0] === file) : null;
          const desc = hit ? hit[1] : (meta.note || '');
          const catOf = hit ? hit[2] : cat;
          _msstRegistry[key] = {
            id: key,
            name: file ? String(file).replace(/\.[^.]+$/, '') : key,
            note: desc, use: desc, arch: inferMsstArch(file || key), best: hit ? (hit[3] || null) : null,
            ...sepUsageOf(file || key, catOf),
            kind: msstKind(catOf), type: 'ghsplit', splitCat: catOf, sizeKey: key,
            outName: file, repo: 'monologue82/Models', dest: path.join(catOf, key),
            minSize: Math.max(1, Math.floor((meta.size || 0) * 0.9)),
            size: meta.size || 0,
            parts: meta.parts, sha256: meta.sha256, downloadable: true, runtime: 'separate',
          };
        }
      }
    }
  }
  // HuggingFace 渠道：官方 / hf-mirror
  const HF_HOSTS = { huggingface: 'huggingface.co', 'hf-mirror': 'hf-mirror.com' };
  const _modelCancels = new Set();
  const _modelAborts = new Map();
  const _modelPause = new Set();
  // 进行中的下载集合：即便页面关闭/切换也保持，模型清单可据此标记「下载中」
  const _activeDownloads = new Set();
  // 统一高速下载器（规范入口，见 docs/DOWNLOADS.md）
  const FastDL = createFastDownload({ net, fs, path });
  /** 取消 / 暂停的统一契约：FastDL 每读一块都会问一次，用户点了就立刻停 */
  const guardOf = (id) => ({ get aborted() { return _modelCancels.has(id) || _modelPause.has(id); } });

  ipcMain.handle('model:list', async () => {
    const dir = modelsDir();
    const items = [];
    // ★ 兜底：清单里任何一处抛都会让界面显示「模型全没了」（renderer 拿到 reject 就当空数组）。
    //   条目本身出问题只该跳过它自己 —— 所以整个收集过程包在 try 里，有多少返回多少。
    const guard = (fn) => { try { return fn(); } catch (e) { try { console.warn('[models] 列条目失败:', e && e.message); } catch (_) {} } };
    try { await ensureMsstModels(); } catch (e) {}
    // ★ 「已下载但跑不动」的**唯一判据处**：与 main/separate-common.js 同一份逻辑，
    //   界面里不许再另写一套。MSST 模型走下面第二个循环，两处都必须带上这个字段 ——
    //   漏一处就会出现「列表里显示已下载、一点就报缺少配置文件」（实测踩过）。
    const sepUsable = (m) => {
      if (!m || m.type !== 'ghsplit') return null;
      try {
        const r = resolveSeparateModel(m.id);
        if (!r) return null;
        // 缺配置与"有没有下载"无关 —— 仓库里就没有它的 .yaml，下完也用不了，必须先说清楚
        if (SepCommon.archNeedsConfig(r.arch) && !r.configPath) {
          // roformer 两族的配置引擎能自己从权重推出来（生成后跑一次前向校验）→ 仍算可用
          if (SepCommon.archSelfConfigurable(r.arch)) return { ready: true, why: '', auto: true };
          return { ready: false, why: r.exists ? '缺少配置文件' : '缺少配置文件（下载后也用不了）' };
        }
        if (!r.exists) return { ready: false, why: '未下载' };
        return { ready: true, why: '' };
      } catch (e) { return null; }
    };
    const push = (name, p, note, extra) => {
      try {
        const st = fs.statSync(p);
        items.push(Object.assign({ name, path: p, size: st.size, exists: true, note: note || '' }, extra || {}));
      } catch (e) { items.push(Object.assign({ name, path: p, size: 0, exists: false, note: note || '' }, extra || {})); }
    };
    push('通用转录（int8 量化）', path.join(dir, 'basic_pitch_quant.onnx'), 'basic-pitch ONNX int8 量化模型（CPU 加速）', { id: 'basic_pitch', kind: 'transcribe', arch: 'Basic-Pitch ONNX (int8)', use: '通用多乐器转录：音频转旋律落音，int8 量化 CPU 极速', downloadable: false });
    const pt = MODEL_REGISTRY.piano_transcription;
    push(pt.name, path.join(dir, pt.dest), pt.note, { id: pt.id, kind: pt.kind, arch: pt.arch, use: pt.use, downloadable: true, active: _activeDownloads.has(pt.id), runtime: pt.runtime });
    // 扩展模型（MuScriptor / Aria-AMT 等）：整目录检查
    for (const k of Object.keys(MODEL_REGISTRY)) {
      if (k === 'piano_transcription') continue;
      const m = MODEL_REGISTRY[k];
      // ★ 外部门户没有本地落点（没有 dest）——这里必须跳过：
      //   path.join(dir, undefined) 会直接抛，而它在 try 之外，**整份模型清单会变成空的**
      //   （实测：资源中心 6 个分类的计数全变成 0）。它们单独在下面 push。
      if (m.type === 'link') continue;
      if (!m.dest) continue;   // 没有落点的条目（历史遗留）直接跳过，不许拖垮整份清单
      const dest = path.join(dir, m.dest);
      // 目录总大小（排除临时隐藏目录，如 .parts），用于展示
      const dirSize = (() => { try { let s = 0; const walk = (p) => { const st = fs.statSync(p); if (st.isFile()) s += st.size; else for (const f of fs.readdirSync(p)) { if (f === '.parts') continue; walk(path.join(p, f)); } }; walk(dest); return s; } catch (e) { return 0; } })();
      let exists = false, size = 0;
      if (m.type === 'ghsplit') {
        // 分卷下载：以最终合并产物为准，避免下载中的 .parts 被误判为「已就绪」
        const finalFile = path.join(dest, m.splitCat ? (m.outName || '') : 'model.safetensors');
        if (fs.existsSync(finalFile)) { size = fs.statSync(finalFile).size; exists = size >= m.minSize; }
      } else if (m.type === 'link') {
        // 外部门户：没有本地落点，永远显示「未安装」，卡片上给「打开来源」
        exists = false; size = 0;
      } else {
        exists = dirSize >= m.minSize; size = dirSize;
      }
      // 音频处理（分离）「能不能真跑起来」：面板必须看得见「已下载但缺配置」这类模型 ——
      // 否则用户选中它、点了开始才在引擎里炸出「该模型缺少配置文件」（实测 UVR 家族就撞过）。
      // 判据与 main/separate-common.js 完全同一份，不在界面里另写一套。
      const sepInfo = sepUsable(m);
      items.push({
        id: m.id, name: m.name, path: dest, size, exists, active: _activeDownloads.has(m.id),
        downloadable: true, note: m.note, kind: m.kind, arch: m.arch, use: m.use, type: m.type, repo: m.repo, gated: !!m.gated, runtime: m.runtime,
        // sepReady/sepWhy 是转录页的加速状态徽章在读的（b749152），GSV 的 group 已随路线删除
        sepReady: sepInfo ? sepInfo.ready : undefined, sepWhy: sepInfo ? sepInfo.why : undefined,        url: m.url || undefined, external: !!m.external,
      });
    }
    // 翻唱模型（用户导入的 SVC 模型，见 main/svc.js）：不下载、不更新，只列出与删除
    for (const m of SVC.list()) {
      items.push({
        id: 'svc:' + m.id, name: m.name, path: m.dir, size: m.size || 0, exists: true,
        downloadable: false, kind: 'svc', arch: SVC.archLabel(m), use: SVC.useLabel(m),
        note: SVC.noteLabel(m), type: 'svc', imported: true,
        engine: m.engine, version: m.version || '', sr: m.sr || 0,
      });
    }
    // MSST 分离模型（动态注册的全部分类）
    for (const k of Object.keys(_msstRegistry)) {
      const m = _msstRegistry[k];
      if (!m || !m.dest) continue;
      const dest = path.join(dir, m.dest);
      const finalFile = path.join(dest, m.outName || '');
      let size = 0, exists = false;
      if (fs.existsSync(finalFile)) { size = fs.statSync(finalFile).size; exists = size >= m.minSize; }
      else { size = m.size || 0; }  // 未下载时展示清单总大小
      const sepInfo = sepUsable(m);
      items.push({
        id: m.id, name: m.name, path: dest, size, exists, active: _activeDownloads.has(m.id),
        downloadable: true, note: m.note, kind: m.kind, arch: m.arch, use: m.use,
        type: m.type, repo: m.repo, runtime: m.runtime, parts: m.parts, group: 'msst', best: m.best || null,
        useLabel: m.label || '', useNotFor: m.notFor || '',
        sepReady: sepInfo ? sepInfo.ready : undefined, sepWhy: sepInfo ? sepInfo.why : undefined,
        sepAuto: sepInfo ? !!sepInfo.auto : undefined,
      });
    }
    return items;
  });
  // 本地导入 GPT-SoVITS 音色：社区音色绝大多数**没有稳定直链**（见 main/gpt-sovits.js 的 EXTERNAL），
  // 本地导入才是它们的主入口。拷进 <模型目录>/gpt-sovits/voices/<目录名>/，与一键下载两条路并存。
  ipcMain.handle('model:importGsvVoice', async (_e, directPath) => {
    try {
      const { dialog } = require('electron');
      let src = directPath;
      if (!src || !fs.existsSync(src)) {
        const r = await dialog.showOpenDialog({
          properties: ['openDirectory'],
          title: '选择 GPT-SoVITS 音色目录（需含 gpt.ckpt 与 sovits.pth）',
        });
        if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
        src = r.filePaths[0];
      }
      if (!fs.statSync(src).isDirectory()) return { ok: false, error: '请选择一个目录（音色包先解压）' };
      const files = fs.readdirSync(src);
      const hasCkpt = files.some((f) => /\.ckpt$/i.test(f));
      const hasPth = files.some((f) => /\.pth$/i.test(f));
      if (!hasCkpt || !hasPth) {
        return { ok: false, error: '这个目录里没有同时找到 .ckpt 与 .pth —— 音色包至少要有这两样（参考音可选）' };
      }
      const name = path.basename(src).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || ('voice_' + Date.now());
      const destDir = path.join(modelsDir(), 'gpt-sovits', 'voices', name);
      if (fs.existsSync(destDir)) return { ok: false, error: '已存在同名音色：' + name };
      fs.mkdirSync(destDir, { recursive: true });
      let n = 0;
      for (const f of files) {
        const s = path.join(src, f);
        try { if (fs.statSync(s).isFile()) { fs.copyFileSync(s, path.join(destDir, f)); n++; } } catch (e) {}
      }
      return { ok: true, name, dir: destDir, files: n };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('model:cancel', async (_e, id) => {
    if (id) { _modelCancels.add(id); try { const c = _modelAborts.get(id); if (c) c.abort(); } catch (e) {} }
    return { ok: true };
  });
  ipcMain.handle('model:delete', async (_e, id) => {
    try {
      // 翻唱模型（用户导入的 SVC 模型）：只删它自己那个目录，不动别的
      if (String(id || '').startsWith('svc:')) return SVC.remove(String(id).slice(4));
      let p = null;
      if (MODEL_REGISTRY[id]) p = path.join(modelsDir(), MODEL_REGISTRY[id].dest);
      else if (_msstRegistry[id]) p = path.join(modelsDir(), _msstRegistry[id].dest);
      if (!p || !fs.existsSync(p)) return { ok: false, error: 'not found' };
      // 目录型（MuScriptor/Aria 分卷或整仓）按目录递归删除；单文件直接删
      const st = fs.statSync(p);
      if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
      // 一并清理可能存在的临时内容
      try { fs.rmSync(p + '.tmp', { recursive: true, force: true }); } catch (_) {}
      try { fs.rmSync(p + '.part', { recursive: true, force: true }); } catch (_) {}
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  // 本地模型压缩包导入：自动识别 MuScriptor Small/Medium/Large、Aria-AMT、钢琴模型等
  const MODEL_DEST_MATCHERS = [
    { re: /muscriptor[\\/]small[\\/]/i, dest: 'muscriptor/small' },
    { re: /muscriptor[\\/]medium[\\/]/i, dest: 'muscriptor/medium' },
    { re: /muscriptor[\\/]large[\\/]/i, dest: 'muscriptor/large' },
    { re: /aria_amt[\\/]/i, dest: 'aria_amt' },
    { re: /piano_transcription[\\/]/i, dest: 'piano_transcription' },
  ];
  function walkFiles(dir, out = []) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walkFiles(p, out);
      else out.push(p);
    }
    return out;
  }
  // 分卷压缩包：把 .001/.002 等按顺序拼接回单文件（7z 分卷 zip/7z 均适用）
  async function combineSplitArchive(firstPart, outFile) {
    const dir = path.dirname(firstPart);
    const base = path.basename(firstPart).replace(/\.\d{3,}$/, '');
    const parts = [];
    for (let i = 1; ; i++) {
      const p = path.join(dir, base + '.' + String(i).padStart(3, '0'));
      if (fs.existsSync(p)) parts.push(p);
      else break;
    }
    if (parts.length < 2) return firstPart;
    const ws = fs.createWriteStream(outFile);
    for (const p of parts) {
      await new Promise((res, rej) => {
        const rs = fs.createReadStream(p);
        rs.on('error', rej);
        rs.on('end', res);
        rs.pipe(ws, { end: false });
      });
    }
    await new Promise((res, rej) => ws.end(err => err ? rej(err) : res()));
    return outFile;
  }
  function extractLocalArchive(file, outDir) {
    const ext = path.extname(file).toLowerCase();
    // ★ `.oudep` 是 OpenUTAU 的依赖包扩展名，**内容就是 zip**（实测前 4 字节 50 4B 03 04），
    //   所以按 zip 走同一套安全解包；单独列出来是因为用户在资源中心拿到的就是这个名字。
    if (ext === '.zip' || ext === '.oudep') {
      const zip = new AdmZip(file);
      const _zsafe = safeExtractAllTo(zip, outDir);

      if (!_zsafe.ok) throw new Error('压缩包安全校验未通过：' + _zsafe.error);
      return;
    }
    if (ext === '.7z') {
      const exe = (() => { try { return process.env.SEVENZIP || '7z'; } catch (e) { return '7z'; } })();
      return new Promise((resolve, reject) => {
        const p = spawn(exe, ['x', '-y', '-o' + outDir, file], { stdio: 'ignore', windowsHide: true });
        p.on('error', reject);
        p.on('close', code => code === 0 ? resolve() : reject(new Error('7z 解压失败，请确认系统已安装 7-Zip 或在 PATH 中')));
      });
    }
    if (ext === '.tar' || ext === '.gz' || ext === '.tgz' || ext === '.tar.gz' || ext === '.txz' || ext === '.tar.xz') {
      const args = ext === '.gz' || ext === '.tgz' || ext === '.tar.gz'
        ? ['-xzf', file, '-C', outDir]
        : ['-xf', file, '-C', outDir];
      return new Promise((resolve, reject) => {
        const p = spawn('tar', args, { stdio: 'ignore', windowsHide: true });
        p.on('error', reject);
        p.on('close', code => code === 0 ? resolve() : reject(new Error('tar 解压失败')));
      });
    }
    throw new Error('仅支持 .zip / .7z / .tar / .tar.gz 模型压缩包');
  }
  function detectModelDest(extractedDir, archiveName) {
    const files = walkFiles(extractedDir);
    for (const m of MODEL_DEST_MATCHERS) {
      if (files.some(f => m.re.test(f))) return m.dest;
    }
    const n = String(archiveName || '').toLowerCase();
    if (n.includes('muscriptor_small') || n.includes('muscriptor-small') || n.includes('muscriptor small')) return 'muscriptor/small';
    if (n.includes('muscriptor_medium') || n.includes('muscriptor-medium') || n.includes('muscriptor medium')) return 'muscriptor/medium';
    if (n.includes('muscriptor_large') || n.includes('muscriptor-large') || n.includes('muscriptor large')) return 'muscriptor/large';
    if (n.includes('aria_amt')) return 'aria_amt';
    if (n.includes('piano_transcription') || n.includes('piano transcription')) return 'piano_transcription';
    return null;
  }
  function findModelSourceDir(root, dest) {
    const parts = dest.split('/');
    const last = parts[parts.length - 1];
    const dirs = [];
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!f.isDirectory()) continue;
        const p = path.join(dir, f.name);
        dirs.push(p);
        walk(p);
      }
    };
    walk(root);
    // 优先匹配完整路径（muscriptor/small 等）；退而求其次匹配目录名
    for (const d of dirs) {
      const rel = path.relative(root, d).split(path.sep).join('/');
      if (rel.toLowerCase() === dest.toLowerCase()) return d;
    }
    for (const d of dirs) {
      if (path.basename(d).toLowerCase() === last.toLowerCase() && d.toLowerCase().includes(parts[0].toLowerCase())) return d;
    }
    for (const d of dirs) {
      if (path.basename(d).toLowerCase() === last.toLowerCase()) return d;
    }
    return root;
  }
  ipcMain.handle('model:importLocal', async (_e, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: '压缩包不存在' };
      const ext = path.extname(filePath).toLowerCase();
      const splitMatch = filePath.match(/\.(zip|7z|tar|gz|tgz|txz)\.[0-9]{3,}$/i);
      const isSplit = !!splitMatch;
      const validExt = isSplit ? '.' + splitMatch[1].toLowerCase() : ext;
      if (!['.zip', '.7z', '.tar', '.gz', '.tgz', '.tar.gz', '.txz', '.tar.xz'].includes(validExt)) return { ok: false, error: '不支持的压缩包格式' };
      const tmp = path.join(Paths.tempDir(), 'fufumidi-model-import-' + Date.now());
      fs.mkdirSync(tmp, { recursive: true });
      try {
        let archiveFile = filePath;
        if (isSplit) {
          const combinedName = path.join(tmp, 'combined' + validExt);
          archiveFile = await combineSplitArchive(filePath, combinedName);
        }
        await extractLocalArchive(archiveFile, tmp);
        const dest = detectModelDest(tmp, path.basename(filePath));
        if (!dest) return { ok: false, error: '无法识别压缩包中的模型类型（MuScriptor / Aria-AMT / 钢琴模型）' };
        const srcDir = findModelSourceDir(tmp, dest);
        const destDir = path.join(modelsDir(), dest);
        fs.mkdirSync(destDir, { recursive: true });
        fs.rmSync(destDir, { recursive: true, force: true });
        fs.mkdirSync(destDir, { recursive: true });
        // 复制模型文件（不含隐藏文件/临时解压目录）
        const files = walkFiles(srcDir);
        let totalSize = 0;
        for (const f of files) {
          const rel = path.relative(srcDir, f);
          const out = path.join(destDir, rel);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.copyFileSync(f, out);
          totalSize += fs.statSync(out).size;
        }
        return { ok: true, path: destDir, size: totalSize, model: dest };
      } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
      }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle('folder:setWatch', (_e, dir, enabled) => {
    try {
      const win = BrowserWindow.fromWebContents(_e.sender);
      const key = win ? win.id : 0;
      if (_folderWatchers.has(key)) { try { _folderWatchers.get(key).close(); } catch (e) {} _folderWatchers.delete(key); }
      if (!enabled || !dir || !fs.existsSync(dir)) return { ok: true };
      const exts = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma', '.mp4', '.mkv', '.avi', '.mov', '.webm']);
      let timer = null;
      const w = fs.watch(dir, { persistent: false }, (_ev, filename) => {
        if (!filename) return;
        const full = path.join(dir, filename.toString());
        if (exts.has(path.extname(full).toLowerCase())) {
          clearTimeout(timer);
          timer = setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.send('folder-watch:file', full); }, 300);
        }
      });
      _folderWatchers.set(key, w);
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('model:pause', async (_e, id) => {
    if (id) { _modelPause.add(id); try { const c = _modelAborts.get(id); if (c) c.abort(); } catch (e) {} }
    return { ok: true };
  });
  // HuggingFace 整仓下载（MuScriptor / Aria-AMT）。
  // 官方 huggingface.co 在国内常遇网关错误（502/5xx），逐请求按「CNB 镜像 → 官方 → hf-mirror」回退；
  // 401/403（授权类）、取消/暂停不回退。
  // 文件字节一律交给 FastDL.downloadMany —— 多文件并发 + 断点续传 + 每文件大小校验，
  // 不再自己写「单文件单连接、逐个串行」的循环（那是整仓下载慢的主因）。
  async function downloadHfRepo(spec, channel, win, ctrl, token) {
    // 渠道序列：用户显式指定则优先该渠道，官方失败自动落到 hf-mirror
    const hosts = channel && HF_HOSTS[channel] && HF_HOSTS[channel] !== HF_HOSTS.huggingface
      ? [HF_HOSTS[channel], HF_HOSTS.huggingface, HF_HOSTS['hf-mirror']]
      : [HF_HOSTS.huggingface, HF_HOSTS['hf-mirror']];
    const destDir = path.join(modelsDir(), spec.dest);
    fs.mkdirSync(destDir, { recursive: true });
    const auth = {};
    if (token) auth.Authorization = 'Bearer ' + token;
    const headers = { 'user-agent': 'FuFumidi', ...auth };
    const isAuthErr = (code) => code === 401 || code === 403;
    // gated 模型未带 Token 时直接给出明确指引，避免下载到一半才 401
    if (spec.gated && !token) throw new Error('该模型需要 HuggingFace 授权：请先在 huggingface.co/' + spec.repo + ' 页面接受许可协议，并在上方填写 HF Token（huggingface.co/settings/tokens 创建）');
    // 该 HF 仓库文件是否已有 CNB 镜像（spec.cnbMirror，见 Aria-AMT 条目）；有则给出 Release 资产直链。
    // 这些仓库的文件普遍 >100MiB，超过 CNB 的 git raw 上限，所以一律走 Release 资产通道。
    const cnbMirrorUrl = (rel) => {
      const m = spec && spec.cnbMirror;
      if (!m || !m.tag || !Array.isArray(m.files) || !m.files.includes(rel)) return null;
      return DS.cnbRepoReleaseUrl(DS.CNB_MIRROR_REPOS.fufumidi, m.tag, path.basename(rel));
    };
    // 带渠道回退的 fetch：成功返回 {res, url}；全渠道失败抛最后错误
    const fetchFallback = async (pathAndQuery, authHints, extraUrls) => {
      let lastErr = null;
      // ① 优先试镜像（CNB）。这条不套 HF 的授权语义 —— 它本就在境外渠道之外，
      //    任何失败（含 403）都只表示「这条不通」，继续走下面的 HF 渠道即可。
      //    实测：huggingface.co 在本机连不通、hf-mirror.com 只有 2~3MB/s，
      //    而同文件走 CNB 可到 20MB/s 以上，所以镜像必须排在最前。
      for (const url of (extraUrls || [])) {
        if (_modelCancels.has(spec.id)) throw new Error('canceled');
        if (_modelPause.has(spec.id)) throw new Error('paused');
        try {
          const r = await net.fetch(url, { headers, signal: ctrl.signal });
          if (r.ok) return { res: r, url };
          lastErr = new Error('HTTP ' + r.status);
        } catch (e) { lastErr = e; }
      }
      // ② HuggingFace 渠道：官方 → hf-mirror
      for (const host of hosts) {
        if (_modelCancels.has(spec.id)) throw new Error('canceled');
        if (_modelPause.has(spec.id)) throw new Error('paused');
        try {
          const r = await net.fetch(`https://${host}${pathAndQuery}`, { headers, signal: ctrl.signal });
          if (r.ok) return { res: r, url: `https://${host}${pathAndQuery}` };
          // 授权错误：mirror 同样无权限，直接抛不折腾
          if (isAuthErr(r.status)) throw new Error(authHints + ' HTTP ' + r.status);
          lastErr = new Error('HTTP ' + r.status);
        } catch (e) { lastErr = e; if (isAuthErr(parseInt(String(e && e.status || ''), 10))) throw e; }
      }
      throw lastErr || new Error('所有 HF 渠道均失败');
    };
    const treeRes = await fetchFallback(`/api/models/${spec.repo}/tree/main?recursive=true`, 'HF API');
    const tree = await treeRes.res.json();
    const files = (tree || []).filter(f => f.type === 'file' && !/^\./.test(path.basename(f.path)));
    if (!files.length) throw new Error('仓库文件列表为空');
    // 每个文件一组候选地址：CNB 镜像（若有）打头，其余按 HF 渠道顺序；FastDL 会实测选最快的
    const items = files.map((f) => {
      const rel = f.path;
      const enc = rel.split('/').map(encodeURIComponent).join('/');
      const cnb = cnbMirrorUrl(rel);
      const urls = [
        ...(cnb ? [cnb] : []),
        ...hosts.map((h) => 'https://' + h + '/' + spec.repo + '/resolve/main/' + enc),
      ];
      // 注意：**不**用 HF 清单里的 f.size 当 expectSize —— LFS 文件报的是指针大小还是实体大小
      // 各端点不一致，猜错会让本来能下的模型直接判失败。完整性交给两道更可靠的关卡：
      // downloadFast 内部比对响应 content-length，外层再校验整仓总大小 >= spec.minSize。
      return { urls, dest: path.join(destDir, rel), expectSize: 0, minSize: 1024, label: rel };
    });
    const totalKnown = items.reduce((s, it) => s + (it.expectSize || 0), 0);
    FastDL.checkDiskSpace(path.join(destDir, 'placeholder'), totalKnown || spec.minSize || 0);
    await FastDL.downloadMany(items, {
      concurrency: 3,
      headers,
      ctrl,
      isUserAbort: guardOf(spec.id),
      onProgress: (p) => {
        if (!win || win.isDestroyed()) return;
        win.webContents.send('model:progress', {
          id: spec.id, received: p.bytesDone, total: p.bytesTotal || totalKnown,
          percent: p.overallPercent, done: false, speed: p.speed || 0,
          text: p.label ? ('正在下载 ' + p.label + '（已完成 ' + p.doneCount + '/' + p.count + '）') : '',
        });
      },
    });
    let size = 0;
    const walk = (p) => { const st = fs.statSync(p); if (st.isFile()) size += st.size; else for (const f of fs.readdirSync(p)) walk(path.join(p, f)); };
    walk(destDir);
    if (size < spec.minSize) throw new Error('下载文件不完整：' + size + ' bytes');
    // ★ 音频处理（MSST）模型：**下载完就把配置备齐**（用户 2026-10-15 的决定 ——
    //   配置文件不内置到工具里，改成下载时从上游取 / 现场生成）。失败不阻断下载：
    //   分离前还有一次自愈（engine:separate 会 await ensureSepConfig），界面也会提示缺配置。
    try {
      const mm = _msstRegistry[spec.id];
      if (mm) {
        const got = await ensureSepConfig(spec.id, (t) => {
          if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id: spec.id, text: t, received: size, total: size, percent: 99, done: false, speed: 0 });
        });
        if (got && win && !win.isDestroyed()) {
          win.webContents.send('model:progress', { id: spec.id, text: '配置就绪（' + got.from + '）', received: size, total: size, percent: 100, done: true, speed: 0 });
          return { ok: true, path: destDir, size, config: got.path, configFrom: got.from };
        }
      }
    } catch (e) {}
    if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id: spec.id, received: size, total: size, percent: 100, done: true, speed: 0 });
    return { ok: true, path: destDir, size };
  }


  /** 由原始 URL 推导候选下载源（自有 Models 仓库优先 CNB 镜像；GitHub 走加速镜像，其它源原样） */
  function mirrorUrls(spec) {
    const raw = String(spec.url || '');
    const out = [];
    if (Array.isArray(spec.mirrors)) out.push(...spec.mirrors);
    if (!raw) return [...new Set(out.filter(Boolean))];
    if (/^https:\/\/(raw\.githubusercontent\.com|github\.com)\//i.test(raw)) {
      const gh = [raw];
      for (const p of [
        'https://gh.jasonzeng.dev/',   // 与分卷下载同一个加速入口，国内通常最快
        'https://ghfast.top/',
        'https://gh-proxy.com/',
        'https://ghproxy.net/',
        'https://hub.gitmirror.com/',
        'https://raw.gitmirror.com/',
      ]) gh.push(p + raw);
      // 自有 Models 仓库的文件 → 追加 CNB 整树镜像，并按下载源偏好排到最前 / 最后
      const m = raw.match(/^https:\/\/raw\.githubusercontent\.com\/monologue82\/Models\/main\/(.+)$/i);
      const cnb = m ? DS.cnbRepoRawUrl(MODELS_CNB_REPO, 'main', m[1]) : null;
      out.push(...DS.orderUrls(cnb, gh, DS.sourceOf(readSettings())));
      return [...new Set(out.filter(Boolean))];
    }
    out.push(raw);
    return [...new Set(out.filter(Boolean))];
  }

  // 测速（rankMirrors）、长度探测（remoteSize）、单文件高速下载（downloadSingleFast）
  // 都已收敛进 main/fast-download.js：本文件只保留「候选地址怎么拼」（mirrorUrls）。

  // GitHub Models 仓库分卷下载（MuScriptor / MSST 分离模型 / VR 等所有 gsplit 条目）
  // 流程：清单 → 复用校验过的分卷 → 一次测速 → 并发下载缺失分卷 → 合并 → 大小 + SHA256 校验
  // 三条硬要求，全部来自实测踩坑：
  //   ① 每卷的期望字节数是**推导**出来的（仓库固定 25 MiB 切片、末卷为余数，见 fast-download.js）。
  //      长度不符的分卷一律删掉重下，绝不复用 —— 复用半截分卷会让 SHA 校验在 100% 处失败并无限重来。
  //   ② 合并前先校验「每卷字节数」（downloadMany 用 expectSize 做），合并后再校验「总大小 == 清单 size」，
  //      最后才算 SHA256 —— 让错误在最早、最便宜的地方暴露。
  //   ③ SHA256 失败 = 分卷整体不可信 → 连 .parts 一起丢弃重下；只删成品文件会让用户永远卡在同一处失败。
  async function downloadSplitRepo(spec, win, ctrl) {
    const _cat = spec.splitCat || 'muscriptor';   // 分卷仓库分类：muscriptor / vocal / multi / single / vr
    const base = _cat + '/' + spec.sizeKey;       // 仓库内相对路径（ref 由 modelSrcUrls 统一处理）
    const headers = { 'user-agent': 'FuFumidi' };
    // 1) 分卷清单（manifest.json）：parts 数 / 总大小 / SHA256
    let manifest = null;
    for (const u of modelSrcUrls('manifest.json')) {
      try {
        const r = await net.fetch(u, { headers, signal: ctrl.signal });
        if (r.ok) { manifest = await r.json(); break; }
      } catch (e) {}
    }
    const meta = manifest && manifest[_cat] && manifest[_cat][spec.sizeKey];
    if (!meta || !meta.parts) throw new Error('分卷清单获取失败：请确认 Models 仓库已发布 ' + spec.sizeKey + ' 分卷（manifest.json）');
    const parts = parseInt(meta.parts, 10) || 0;
    if (!parts) throw new Error('分卷清单缺少 parts');
    const model = meta.model || 'model.safetensors';
    const total = meta.size || 0;
    const destDir = path.join(modelsDir(), spec.dest);
    fs.mkdirSync(destDir, { recursive: true });
    const outFile = path.join(destDir, model);
    const partName = (i) => model + '.part' + String(i).padStart(2, '0');
    const partUrls = (name) => modelSrcUrls(base + '/' + name);
    const sendP = (p) => { if (win && !win.isDestroyed()) win.webContents.send('model:progress', Object.assign({ id: spec.id }, p)); };
    // 2) 已存在且完整 → 直接返回（避免重复下载）
    if (fs.existsSync(outFile)) {
      const sz = fs.statSync(outFile).size;
      if (sz >= (spec.minSize || 0)) { sendP({ received: sz, total: sz, percent: 100, done: true }); return { ok: true, path: destDir, size: sz, existed: true }; }
      try { fs.rmSync(outFile, { force: true }); } catch (_) {}   // 上次中断残留的半成品
    }
    try { fs.rmSync(outFile + '.tmp', { force: true }); } catch (_) {}
    const partsDir = path.join(destDir, '.parts');
    fs.mkdirSync(partsDir, { recursive: true });
    // 3) 期望字节数（固定 25 MiB 切片；清单不自洽时退化成「只校验总大小」）
    const layoutOk = FastDL.partsLayoutOk(total, parts);
    const expectBytes = (i) => (layoutOk ? FastDL.expectedPartSize(total, parts, i) : 0);
    // 4) 复用「已下完且长度正确」的分卷；长度不对的一律删掉重下
    const jobs = [];
    let reuseBytes = 0, needBytes = 0;
    for (let i = 1; i <= parts; i++) {
      const dest = path.join(partsDir, partName(i));
      const want = expectBytes(i);
      let have = 0;
      try { have = fs.statSync(dest).size; } catch (_) {}
      if (have > 0 && (!want || have === want)) { reuseBytes += have; continue; }
      if (have > 0) { try { fs.rmSync(dest, { force: true }); } catch (_) {} }
      jobs.push({ urls: partUrls(partName(i)), dest, expectSize: want, minSize: 1024, label: partName(i), singleStream: true });
      needBytes += want || (total ? Math.ceil(total / parts) : 0);
    }
    // 5) 磁盘预检：分卷 + 合并临时文件（不够就在动手前报，别等到 90%）
    FastDL.checkDiskSpace(outFile, (needBytes || total) * 2 + 64 * 1024 * 1024);
    // 6) 只测速一次，其余分卷复用同一份源顺序（省掉每卷一次测速）
    let hostRank = [];
    try { hostRank = FastDL.hostRankOf(await FastDL.rankMirrors(partUrls(partName(1)), ctrl)); } catch (_) {}
    const partsConcurrency = Math.min(FastDL.PARTS_CONCURRENCY, Math.max(1, jobs.length));
    const denom = total || (reuseBytes + needBytes);
    sendP({
      received: reuseBytes, total: denom, percent: denom ? Math.min(99, Math.round(reuseBytes / denom * 100)) : 0, done: false, speed: 0,
      text: '共 ' + parts + ' 个分卷（已就绪 ' + (parts - jobs.length) + ' 个）· 并行 ' + partsConcurrency + ' 路',
    });
    // 7) 并发下载缺失分卷（每卷一个连接；CNB 的 git raw 不支持 Range，提速只能靠多卷并行）
    if (jobs.length) {
      let spT = 0, spB = 0, spSpeed = 0;
      const speedOf = (received) => {
        const now = Date.now();
        if (!spT) { spT = now; spB = received; return 0; }
        if (now - spT >= 500) { spSpeed = ((received - spB) / (now - spT)) * 1000; spT = now; spB = received; }
        return spSpeed;
      };
      await FastDL.downloadMany(jobs, {
        concurrency: partsConcurrency,
        hostRank,
        headers,
        ctrl,
        isUserAbort: guardOf(spec.id),
        onProgress: (p) => {
          const received = reuseBytes + (p.bytesDone || 0);
          const pct = denom ? Math.min(99, Math.round(received / denom * 100)) : Math.round(((p.doneCount || 0) / Math.max(1, p.count)) * 100);
          sendP({
            received, total: denom, percent: pct, done: false, speed: speedOf(received),
            text: '分卷 ' + Math.min(p.count, (p.doneCount || 0) + 1) + '/' + p.count + ' · 并行 ' + partsConcurrency + ' 路',
          });
        },
      });
    }
    // 8) 按序合并（先写临时文件再原子重命名，中断不会留下半成品最终文件）
    const tmpOut = outFile + '.tmp';
    try { fs.rmSync(tmpOut, { force: true }); } catch (_) {}
    const ws = fs.createWriteStream(tmpOut);
    ws.on('error', () => {});   // 消费 'error'，防 EPERM 等未捕获异常打崩主进程
    for (let i = 1; i <= parts; i++) {
      const p = path.join(partsDir, partName(i));
      if (!fs.existsSync(p)) throw new Error('分卷缺失：' + partName(i));
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(p);
        rs.on('error', reject);
        rs.pipe(ws, { end: false });
        rs.on('end', resolve);
      });
    }
    await new Promise((res2, rej2) => ws.end((err) => (err ? rej2(err) : res2())));
    const size = fs.statSync(tmpOut).size;
    if (total && size !== total) {
      try { fs.rmSync(tmpOut, { force: true }); } catch (_) {}
      throw new Error('合并后大小不符：' + size + '/' + total + '（分卷不完整，已丢弃半成品；重试只补缺的卷）');
    }
    // 9) SHA256：失败说明分卷整体不可信 → 连 .parts 一起丢弃，避免「每次都卡在同一处」
    if (meta.sha256) {
      const hash = await sha256File(tmpOut);
      if (hash !== meta.sha256) {
        try { fs.rmSync(tmpOut, { force: true }); } catch (_) {}
        try { fs.rmSync(partsDir, { recursive: true, force: true }); } catch (_) {}
        try { fs.rmSync(outFile, { force: true }); } catch (_) {}
        throw new Error('SHA256 校验失败：' + String(hash).slice(0, 12) + '…（已丢弃全部分卷，重试会重新下载；反复失败请换下载源）');
      }
    }
    try { fs.rmSync(outFile, { force: true }); } catch (_) {}
    fs.renameSync(tmpOut, outFile);
    const finalSize = fs.statSync(outFile).size;
    if (finalSize < (spec.minSize || 0)) throw new Error('下载文件不完整：' + finalSize + ' bytes');
    // 10) MuScriptor 规格：合并完成后补齐 config.json。
    //     muscriptor 依赖权重旁的 config.json 确定模型架构；本地路径无法识别规格时
    //     会默认按 large 构建 → 与 small/medium 权重 state_dict 尺寸不匹配报错。
    if (spec.id && spec.id.startsWith('muscriptor_')) {
      const muscriptorConfigs = {
        small: { dim: 768, num_heads: 12, num_layers: 14, card: 1393 },
        medium: { dim: 1024, num_heads: 16, num_layers: 24, card: 1395 },
        large: { dim: 1536, num_heads: 24, num_layers: 48, card: 1395 },
      };
      const cfg = muscriptorConfigs[spec.sizeKey];
      if (cfg) {
        try { fs.writeFileSync(path.join(destDir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8'); } catch (e) {}
      }
    }
    try { fs.rmSync(partsDir, { recursive: true, force: true }); } catch (_) {}
    sendP({ received: finalSize, total: finalSize, percent: 100, done: true, speed: 0 });
    return { ok: true, path: destDir, size: finalSize };
  }

  ipcMain.handle('model:download', async (evt, id, channel) => {
    const spec = MODEL_REGISTRY[id] || _msstRegistry[id];
    if (!spec || !spec.downloadable) return { ok: false, error: 'unknown model: ' + id };
    healBrokenModelLinks(); // 清除断链（junction 目标被安装器替换后残留），否则 mkdir ENOENT
    const win = BrowserWindow.fromWebContents(evt.sender);
    // 同一模型已在下载中：阻止重复开启（页面切换/刷新后再进入也不会开第二份）
    if (_activeDownloads.has(id)) return { ok: false, error: '模型下载已在进行中，请稍候', active: true };
    _activeDownloads.add(id);
    // HuggingFace 整仓下载（MuScriptor / Aria-AMT）
    if (spec.type === 'hf') {
      const destDir = path.join(modelsDir(), spec.dest);
      const curSize = fs.existsSync(destDir) ? (() => { try { let s = 0; const walk = (p) => { const st = fs.statSync(p); if (st.isFile()) s += st.size; else for (const f of fs.readdirSync(p)) walk(path.join(p, f)); }; walk(destDir); return s; } catch (e) { return 0; } })() : 0;
      if (curSize >= spec.minSize) {
        _activeDownloads.delete(id);
        if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, received: curSize, total: curSize, percent: 100, done: true });
        return { ok: true, path: destDir, size: curSize, existed: true };
      }
      _modelCancels.delete(id); _modelPause.delete(id);
      const ctrl = new AbortController(); _modelAborts.set(id, ctrl);
      const hfToken = (readSettings && readSettings().hf_token) || '';
      try {
        return await downloadHfRepo(spec, channel || 'huggingface', win, ctrl, hfToken);
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, error: msg, canceled: _modelCancels.has(id), paused: _modelPause.has(id) });
        return { ok: false, error: msg, canceled: _modelCancels.has(id), paused: _modelPause.has(id) };
      } finally {
        _modelAborts.delete(id);
        _modelCancels.delete(id); _modelPause.delete(id); _activeDownloads.delete(id);
      }
    }
    // GitHub Models 仓库分卷下载（MuScriptor）
    if (spec.type === 'ghsplit') {
      const destDir = path.join(modelsDir(), spec.dest);
      const curSize = fs.existsSync(destDir) ? (() => { try { let s = 0; const walk = (p) => { const st = fs.statSync(p); if (st.isFile()) s += st.size; else for (const f of fs.readdirSync(p)) walk(path.join(p, f)); }; walk(destDir); return s; } catch (e) { return 0; } })() : 0;
      if (curSize >= spec.minSize) {
        _activeDownloads.delete(id);
        if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, received: curSize, total: curSize, percent: 100, done: true });
        return { ok: true, path: destDir, size: curSize, existed: true };
      }
      _modelCancels.delete(id); _modelPause.delete(id);
      const ctrl = new AbortController(); _modelAborts.set(id, ctrl);
      try {
        return await downloadSplitRepo(spec, win, ctrl);
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, error: msg, canceled: _modelCancels.has(id), paused: _modelPause.has(id) });
        return { ok: false, error: msg, canceled: _modelCancels.has(id), paused: _modelPause.has(id) };
      } finally {
        _modelAborts.delete(id);
        _modelCancels.delete(id); _modelPause.delete(id); _activeDownloads.delete(id);
      }
    }
    // ---- 解包型（.oudep：下下来是压缩包，要解开才算装好）----
    //    与单文件分支的区别：dest 是**目录**，压缩包是临时的，装好的判据是 unpackMarker。
    if (spec.unpack) {
      const destDir = path.join(modelsDir(), spec.dest);
      const marker = path.join(destDir, spec.unpackMarker || '');
      if (spec.unpackMarker && fs.existsSync(marker)) {
        _activeDownloads.delete(id);
        if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, percent: 100, done: true });
        return { ok: true, path: destDir, existed: true };
      }
      _modelCancels.delete(id); _modelPause.delete(id);
      const uctrl = new AbortController(); _modelAborts.set(id, uctrl);
      const archive = destDir + '.oudep';   // 解包后删掉，不留双份
      try {
        fs.mkdirSync(destDir, { recursive: true });
        const urls = mirrorUrls(spec);
        if (!urls.length) throw new Error('该模型没有可用的下载地址');
        FastDL.checkDiskSpace(archive, spec.size || spec.minSize || 0);
        const r = await FastDL.downloadFast({
          urls,
          dest: archive,
          minSize: spec.minSize,
          headers: { 'user-agent': 'FuFumidi' },
          isUserAbort: guardOf(id),
          ctrl: uctrl,
          expectSize: spec.size || 0,
          label: spec.name || id,
          onProgress: (p) => {
            if (!win || win.isDestroyed()) return;
            win.webContents.send('model:progress', {
              id, received: p.received || 0, total: p.total || spec.size || 0,
              percent: p.percent || 0, done: !!p.done, speed: p.speed || 0,
              segmented: p.segmented || 1, text: p.text || '',
            });
          },
        });
        if (spec.sha256) {
          const hash = await sha256File(archive);
          if (hash !== spec.sha256) {
            try { fs.rmSync(archive, { force: true }); } catch (_) {}
            try { FastDL.cleanSegments(archive); } catch (_) {}
            throw new Error('SHA256 校验失败：' + hash + '（文件已丢弃，请重试或换源）');
          }
        }
        extractLocalArchive(archive, destDir);
        try { fs.rmSync(archive, { force: true }); } catch (_) {}
        try { FastDL.cleanSegments(archive); } catch (_) {}
        if (spec.unpackMarker && !fs.existsSync(marker)) {
          throw new Error('解包后没找到 ' + spec.unpackMarker + '（包结构不对，请重试或换源）');
        }
        if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, received: r.size, total: r.size, percent: 100, done: true, speed: 0 });
        return { ok: true, path: destDir, size: r.size, unpacked: true };
      } catch (e) {
        const rawMsg = String((e && e.message) || e);
        const paused = _modelPause.has(id);
        const canceled = _modelCancels.has(id);
        const msg = (e && e.cancelled) || /aborted/i.test(rawMsg)
          ? (paused ? '已暂停（断点已保留，继续时会接着下）' : '下载中断（断点已保留，可稍后重试续传）')
          : rawMsg;
        console.log('[model] 解包型下载失败：' + rawMsg);
        if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, error: msg, canceled, paused });
        return { ok: false, error: msg, canceled, paused };
      } finally {
        _modelCancels.delete(id); _modelAborts.delete(id); _modelPause.delete(id); _activeDownloads.delete(id);
      }
    }

    const dest = path.join(modelsDir(), spec.dest);
    if (fs.existsSync(dest) && fs.statSync(dest).size >= spec.minSize) {
      _activeDownloads.delete(id);
      if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, received: fs.statSync(dest).size, total: fs.statSync(dest).size, percent: 100, done: true });
      return { ok: true, path: dest, size: fs.statSync(dest).size, existed: true };
    }
    _modelCancels.delete(id);
    _modelPause.delete(id);
    const ctrl = new AbortController();
    _modelAborts.set(id, ctrl);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const urls = mirrorUrls(spec);
      if (!urls.length) throw new Error('该模型没有可用的下载地址');
      FastDL.checkDiskSpace(dest, spec.size || spec.minSize || 0);
      // 统一入口：多源测速 + 分段并发 + 断点续传 + 停滞看门狗 + 低速轮换 + 大小校验
      const r = await FastDL.downloadFast({
        urls,
        dest,
        minSize: spec.minSize,
        headers: { 'user-agent': 'FuFumidi' },
        isUserAbort: guardOf(id),
        ctrl,
        expectSize: spec.size || 0,
        label: spec.name || id,
        onProgress: (p) => {
          if (!win || win.isDestroyed()) return;
          win.webContents.send('model:progress', {
            id, received: p.received || 0, total: p.total || spec.size || 0,
            percent: p.percent || 0, done: !!p.done, speed: p.speed || 0,
            segmented: p.segmented || 1, text: p.text || '',
          });
        },
      });
      if (spec.sha256) {
        const hash = await sha256File(dest);
        if (hash !== spec.sha256) {
          try { fs.rmSync(dest, { force: true }); } catch (_) {}
          try { FastDL.cleanSegments(dest); } catch (_) {}
          throw new Error('SHA256 校验失败：' + hash + '（文件已丢弃，请重试或换源）');
        }
      }
      if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, received: r.size, total: r.size, percent: 100, done: true, speed: 0 });
      return { ok: true, path: dest, size: r.size, segments: r.segments };
    } catch (e) {
      const rawMsg = String((e && e.message) || e);
      const paused = _modelPause.has(id);
      const canceled = _modelCancels.has(id);
      const msg = (e && e.cancelled) || /aborted/i.test(rawMsg)
        ? (paused ? '已暂停（断点已保留，继续时会接着下）' : '下载中断（断点已保留，可稍后重试续传）')
        : rawMsg;
      console.log('[model] 单文件下载失败：' + rawMsg);
      if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, error: msg, canceled, paused });
      return { ok: false, error: msg, canceled, paused };
    } finally {
      // 取消 / 暂停不清 .part、不清分段：断点留着，下次点继续就能接着下
      _modelCancels.delete(id);
      _modelAborts.delete(id);
      _modelPause.delete(id);
      _activeDownloads.delete(id);
    }
  });


  function closeAll() {
    for (const w of _folderWatchers.values()) { try { w.close(); } catch {} }
    _folderWatchers.clear();
  }

  /* ------------------------------------------------------------------
   * 音频处理（MSST）模型的**配置**：下载时从上游取并配置好，不内置到工具里
   *
   * 用户 2026-10-15 的决定：「音频处理相关的模型要做到下载时把配置文件也下载和配置好，
   * 而不是直接内置到工具里」。
   *
   * 改前的实情（实测）：
   *   * engine/msst_configs/*.yaml 随应用分发（28 个），而**模型自己的目录里一个 yaml 都没有**
   *     （vocal/big_beta5e、vocal/bs_roformer_large、single/denoise_mel_band_roformer_* 实测）；
   *   * 28 个内置配置里只有 **12 个**能在上游一字不差地找到，其余是改过名字的。
   * 改后：模型下载完成时（以及分离前的自愈）按顺序把配置准备好 ——
   *   ① 模型目录自带的 yaml（HF 仓库随模型带配置的走这条）
   *   ② 共享缓存 <数据根>/models/_configs/（上游 configs/ 整目录拉，约 45 个文件 < 100 KB）
   *   ③ 上游现取（raw 直连 + gh 镜像，按名字精确 / 模糊匹配）
   *   ④ 仍没有 → engine/msst_autoconfig.py 现场生成（模板也从上面这个缓存取，离线可用）
   * 应用目录里的 msst_configs/ 只留 index.json（模型 → 配置名 / 架构的**元数据**），
   * 里面那份 yaml 只在旧安装上被读一次作兜底。
   * ------------------------------------------------------------------ */
  const MSST_CFG_REPOS = [
    { repo: 'ZFTurbo/Music-Source-Separation-Training', dir: 'configs' },
    { repo: 'Sucial/MSST-WebUI', dir: 'configs' },
  ];
  //: 取原始文件的通道。★ 实测（2026-10-15）：这些 yaml 只有 0.5~5 KB，**分段下载会踩坑** ——
  //: gh-proxy 对小文件的 Range 请求返回被截断的内容（561 字节只拿到 334，报「大小不符」），
  //: 所以下面每一条都配 singleStream:true 单流拉；通道顺序按实测可用性排（jsdelivr 是 CDN，最稳）。
  function cfgUrls(repo, dir, name) {
    const p = dir + '/' + encodeURIComponent(name);
    const raw = 'https://raw.githubusercontent.com/' + repo + '/main/' + p;
    return [
      'https://cdn.jsdelivr.net/gh/' + repo + '@main/' + p,
      'https://ghproxy.net/' + raw,
      'https://gh-proxy.com/' + raw,
      'https://ghfast.top/' + raw,
      raw,
    ];
  }
  /** 模型条目：既接受注册表 id（big_beta5e），也接受文件名（big_beta5e.ckpt）——两个调用点都用得上。 */
  function msstEntry(id) {
    if (_msstRegistry[id]) return _msstRegistry[id];
    const s = String(id || '');
    return Object.keys(_msstRegistry).map((k) => _msstRegistry[k])
      .find((x) => x && (x.outName === s || x.id === s)) || null;
  }
  function cfgCacheDir() { return path.join(modelsDir(), '_configs'); }
  /** msst_autoconfig 生成的配置落点（<数据根>/cache/msst_autocfg/） */
  function autocfgDir() {
    try { return path.join(Paths.cacheRoot ? Paths.cacheRoot() : path.join(Paths.dataRoot(), 'cache'), 'msst_autocfg'); }
    catch (e) { return path.join(modelsDir(), '_configs'); }
  }
  const normCfg = (n) => String(n || '').toLowerCase().replace(/\.ya?ml$/, '')
    .replace(/^config[_-]?/, '').replace(/[^a-z0-9]+/g, '');
  function listYml(dir) {
    try { return fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)); } catch (e) { return []; }
  }
  /** 在一个目录里挑配置文件：先按期望名精确，再宽松包含，最后"只有一个就用它"。 */
  function pickYml(dir, want) {
    const files = listYml(dir);
    if (!files.length) return null;
    const w = normCfg(want);
    if (w) {
      const exact = files.find((f) => normCfg(f) === w);
      if (exact) return path.join(dir, exact);
      const loose = files.find((f) => { const n = normCfg(f); return n && (n.includes(w) || w.includes(n)); });
      if (loose) return path.join(dir, loose);
    }
    return files.length === 1 ? path.join(dir, files[0]) : null;
  }
  let _upstreamCfg = null;
  /** 上游 configs/ 目录清单（每个仓库列一次，进程内缓存） */
  async function upstreamCfgList() {
    if (_upstreamCfg) return _upstreamCfg;
    const out = [];
    for (const { repo, dir } of MSST_CFG_REPOS) {
      for (const host of ['https://api.github.com', 'https://gh-proxy.com/https://api.github.com']) {
        try {
          const r = await net.fetch(host + '/repos/' + repo + '/contents/' + dir,
            { headers: { 'user-agent': 'FuFumidi', accept: 'application/vnd.github+json' } });
          if (!r.ok) continue;
          const list = await r.json();
          for (const f of (Array.isArray(list) ? list : [])) {
            if (f.type === 'file' && /\.ya?ml$/i.test(f.name)) {
              out.push({ repo, dir, name: f.name, norm: normCfg(f.name) });
            }
          }
          break;
        } catch (e) {}
      }
    }
    _upstreamCfg = out;
    return out;
  }
  let _cfgFetchLast = { files: 0, failed: [] };
  /** 上游 configs/ 整目录拉到共享缓存（只补缺的；一次不到 100 KB） */
  async function fetchConfigsToCache(onText) {
    const list = await upstreamCfgList();
    _cfgFetchLast = { files: 0, failed: [] };
    if (!list.length) { _cfgFetchLast.failed.push('上游清单为空（api.github.com 没通）'); return 0; }
    const cache = cfgCacheDir();
    try { fs.mkdirSync(cache, { recursive: true }); } catch (e) { _cfgFetchLast.failed.push('建目录失败:' + String(e && e.message || e).slice(0, 80)); return 0; }
    const have = new Set(listYml(cache));
    const items = [];
    for (const f of list) {
      if (have.has(f.name)) continue;
      const dst = path.join(cache, f.name);
      // ★ noProbe + 先清 .part：这些小文件用"探测 + 断点续传"那套会自伤 ——
      //   上一次留下 2727 B 的 .part，续传时按 content-length 再核一次就变成"2727/1147 大小不符"
      //   （实测 42 个只落地 18 个，其余全卡在这一步）。单流、不探测、每次从头拉。
      try { fs.rmSync(dst + '.part', { force: true }); } catch (e) {}
      items.push({
        urls: cfgUrls(f.repo, f.dir, f.name),
        singleStream: true, noProbe: true,
        dest: dst, expectSize: 0, minSize: 32, label: f.name,
      });
    }
    if (items.length) {
      if (onText) onText('下载配置模板 ' + items.length + ' 个…');
      // ★ 为什么这一类**不**走 FastDL（本仓库唯一的下载入口，规范见 docs/DOWNLOADS.md）：
      //   这些配置只有 1~5 KB，FastDL 的「探测 + 断点续传 + 低速轮换」在这条路径上实测会把文件
      //   **截断**：同一 URL「1555 字节只拿到 794」「561 只拿到 334」，报「大小不符」，
      //   轮换 8 轮全失败（42 个只落地 18 个）；而同一个 URL 用 net.fetch 一次就拿到完整的
      //   561/1555 字节，content-length 与字节数一致（net 侧无 content-encoding）。
      //   大文件（模型权重、分卷）仍然全部走 FastDL —— 这里只是「KB 级配置模板」这一类的例外，
      //   已在 docs/DOWNLOADS.md 备案。
      let got = 0;
      const queue = items.slice();
      const one = async (it) => {
        let lastErr = '';
        for (const u of it.urls) {
          try {
            const r = await net.fetch(u, { headers: { 'user-agent': 'FuFumidi' } });
            if (!r.ok) { lastErr = 'HTTP ' + r.status; continue; }
            const buf = Buffer.from(await r.arrayBuffer());
            const clen = Number(r.headers.get('content-length') || 0);
            if (buf.length < 32) { lastErr = '文件过小 ' + buf.length; continue; }
            if (clen && buf.length !== clen) { lastErr = '长度不符 ' + buf.length + '/' + clen; continue; }
            fs.mkdirSync(path.dirname(it.dest), { recursive: true });
            fs.writeFileSync(it.dest, buf);
            got++;
            return true;
          } catch (e) { lastErr = String((e && e.message) || e).slice(0, 70); }
        }
        _cfgFetchLast.failed.push(it.label + ' → ' + (lastErr || '全部通道失败'));
        return false;
      };
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (;;) {
          const it = queue.shift();
          if (!it) return;
          if (onText) onText('下载配置 ' + it.label);
          await one(it);
        }
      }));
    }
    _cfgFetchLast.files = listYml(cache).length;
    return _cfgFetchLast.files;
  }
  /** 让某个 MSST 模型有一份可用的配置；返回 { path, from } 或 null。 */
  async function ensureSepConfig(id, onText) {
    const m = msstEntry(id);
    if (!m || !m.outName || !m.dest) return null;
    const entry = msstConfigIndex()[m.outName] || {};
    const want = entry.config || '';
    const modelDirAbs = path.join(modelsDir(), m.dest);
    let hit = pickYml(modelDirAbs, want);
    if (hit) return { path: hit, from: 'model' };
    hit = pickYml(cfgCacheDir(), want);
    // ③ 我们自己的模型仓库：<分类>/<模型名>/<配置名>
    //   ★ 用户 2026-10-15 的决定：「找方法获取配置文件并放到仓库里，下载时同步下载并配置」——
    //     上游 configs/ 里没有、又推不出结构的模型（如 BS-Roformer_LargeV1），把它那份配置
    //     放在**模型自己的目录**里随模型一起取（不内置进安装包）。文件名与 index.json 对齐。
    if (!hit) {
      const rel = String(m.dest || '').replace(/\\/g, '/') + '/' + (want || (m.outName || 'model').replace(/\.[^.]+$/, '') + '.yaml');
      const dst = path.join(modelDirAbs, want || path.basename(rel));
      //  ★ 走 net.fetch 而不是 FastDL：这是 KB 级 yaml，FastDL 在这类小文件上实测会截断
      //    （见 docs/DOWNLOADS.md 例外二：1555→794、2727→1147）。大文件仍全走 FastDL。
      if (onText) onText('下载模型自带配置 ' + path.basename(rel));
      for (const u of modelSrcUrls(rel)) {
        try {
          const rr = await net.fetch(u, { headers: { 'user-agent': 'FuFumidi' } });
          if (!rr.ok) continue;
          const buf = Buffer.from(await rr.arrayBuffer());
          const clen = Number(rr.headers.get('content-length') || 0);
          if (buf.length < 200 || (clen && buf.length !== clen)) continue;
          fs.writeFileSync(dst, buf);
          break;
        } catch (e) {}
      }
      hit = pickYml(modelDirAbs, want);
      if (hit) return { path: hit, from: 'model-repo' };
      try { fs.rmSync(dst, { force: true }); } catch (_) {}
    }
    if (!hit) {
      await fetchConfigsToCache(onText);
      hit = pickYml(cfgCacheDir(), want);
    }
    if (!hit) {
      // 按上游清单再模糊找一次（本地名与上游名不一致的 16 个走这条）
      const list = await upstreamCfgList();
      const w = normCfg(want);
      const cand = list.find((x) => x.name.toLowerCase() === String(want).toLowerCase())
        || (w ? list.find((x) => x.norm === w) : null)
        || (w ? list.find((x) => x.norm && (x.norm.includes(w) || w.includes(x.norm))) : null);
      if (cand) {
        const dst = path.join(cfgCacheDir(), cand.name);
        try { fs.mkdirSync(cfgCacheDir(), { recursive: true }); } catch (e) {}
        try {
          if (onText) onText('下载配置 ' + cand.name);
          await FastDL.downloadFast({
            urls: cfgUrls(cand.repo, cand.dir, cand.name), singleStream: true,
            dest: dst, expectSize: 0, minSize: 32,
            headers: { 'user-agent': 'FuFumidi' }, label: cand.name,
          });
          hit = pickYml(cfgCacheDir(), want) || dst;
        } catch (e) { try { fs.rmSync(dst, { force: true }); } catch (_) {} }
      }
    }
    if (hit) return { path: hit, from: 'upstream' };
    // 生成（离线也能走）：模板同样从数据根缓存取
    try {
      const py = typeof resolvePython === 'function' ? resolvePython() : '';
      const script = path.join(engineDir(), 'msst_autoconfig.py');
      const model = path.join(modelDirAbs, m.outName);
      if (py && fs.existsSync(script) && fs.existsSync(model)) {
        if (onText) onText('生成配置 ' + (want || m.outName));
        const out = await new Promise((res) => {
          let buf = '';
          const ch = spawn(py, [script, model, m.arch || ''], { windowsHide: true, cwd: engineDir(),
            env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }) });
          ch.stdout.on('data', (d) => { buf += String(d); });
          ch.stderr.on('data', (d) => { buf += String(d); });
          ch.on('close', () => res(buf));
          ch.on('error', () => res(''));
        });
        // msst_autoconfig 把生成的 yaml 写在缓存目录（<数据根>/cache/msst_autocfg/），
        // 这里拷一份**到模型目录**：解析顺序因此只有"模型目录 → 共享缓存"两条，别再散第三处。
        const mm = /RESULT\s+(\S+)/.exec(out || '');
        if (mm && mm[1] && mm[1] !== 'None' && fs.existsSync(mm[1])) {
          const dst = path.join(modelDirAbs, want || path.basename(mm[1]));
          try { fs.copyFileSync(mm[1], dst); } catch (e) {}
          if (fs.existsSync(dst)) return { path: dst, from: 'generated' };
          return { path: mm[1], from: 'generated' };
        }
        hit = pickYml(modelDirAbs, want) || pickYml(autocfgDir(), want);
        if (hit) return { path: hit, from: 'generated' };
      }
    } catch (e) {}
    return null;
  }

  // 音频处理（MSST 分离）：按模型 id 解析 { modelPath, configPath, arch }
  let _msstConfigIndex = null;
  function msstConfigIndex() {
    if (_msstConfigIndex) return _msstConfigIndex;
    try {
      const idxPath = path.join(engineDir(), 'msst_configs', 'index.json');
      _msstConfigIndex = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    } catch (e) { _msstConfigIndex = {}; }
    return _msstConfigIndex;
  }
  function resolveSeparateModel(id) {
    const m = msstEntry(id);
    if (!m || !m.outName || !m.dest) return null;
    const modelPath = path.join(modelsDir(), m.dest, m.outName);
    // ★ configPath 要**先算再判 exists**：否则"还没下载"的模型永远看不出它其实没有配置，
    //   界面就会鼓励用户去下一个下完也跑不起来的模型（实测：single/ 分类里有 50 个这种）。
    const entry = msstConfigIndex()[m.outName];
    let configPath = null;
    // 顺序：① 模型目录自带的 yaml（下载时拉下来的就在这儿）→ ② 数据根共享缓存
    //       → ③ 旧应用内置的那份（只在老安装上存在，新装包里已经不带 yaml 了）
    const dirAbs = path.join(modelsDir(), m.dest);
    configPath = pickYml(dirAbs, entry && entry.config);
    if (!configPath) configPath = pickYml(cfgCacheDir(), entry && entry.config);
    if (!configPath) configPath = pickYml(autocfgDir(), entry && entry.config);   // 现场生成的那份
    if (!configPath && entry && entry.config) {
      const c = path.join(engineDir(), 'msst_configs', entry.config);
      if (fs.existsSync(c)) configPath = c;                                       // 旧安装兜底
    }
    if (!fs.existsSync(modelPath)) return { modelPath, configPath, arch: m.arch, exists: false, error: '模型未下载，请先到模型管理下载' };
    return { modelPath, configPath, arch: m.arch, exists: true };
  }


  // 分离前的自愈入口（task-queue 在构造请求前 await 一次）
  ipcMain.handle('model:ensureConfig', async (_e, id) => {
    try { const r = await ensureSepConfig(id); return r ? { ok: true, ...r } : { ok: false, error: '没有找到可用的配置' }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  return { closeAll, resolveSeparateModel, ensureSepConfig };
}

module.exports = { registerModelsIpc };
