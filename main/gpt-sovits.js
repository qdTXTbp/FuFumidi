// ============================================================
// GPT-SoVITS 声库（社区微调音色）
// ------------------------------------------------------------
// 一个 GPT-SoVITS 音色 = 两个权重 + 一个参考音：
//   gpt.ckpt     GPT 权重（语义/韵律）≈148MB
//   sovits.pth   SoVITS 权重（音色）    ≈81MB
//   ref.wav      参考音（推理时设定语调/情感，作者通常提供）
// 装到 <数据根>/gpt-sovits/voices/<id>/，并保留原始相对路径。
//
// 下载源：hf-mirror.com 优先（实测本机 huggingface.co 直连不通、hf-mirror 通），
// 再回落 huggingface.co。字节走 main/fast-download.js 的统一入口（规范见 docs/DOWNLOADS.md）。
//
// 说明（实测结论，写在这里免得后来人再走一遍）：
//   本地 vendored 的 GPT-SoVITS 是**纯 TTS**：TTS.run(inputs) 只吃
//   text/ref_audio/prompt_text…；SoVITS 的 infer(ssl, y, text, …) **没有 F0 输入**，
//   音高只能由「参考音频的 mel」驱动。所以要让这些音色**唱指定旋律**，
//   只能逐句拿原唱那一句当参考做重合成（旋律/节奏来自原唱，音色来自本声库）。
// ============================================================
'use strict';

const HF_MIRROR = 'https://hf-mirror.com/';
const HF_DIRECT = 'https://huggingface.co/';

/** 一个音色条目；files 是仓库内相对路径，out 是本地落点（默认与仓库内同名） */
function voice(id, name, repo, dir, note, files, extra) {
  return Object.assign({
    id, name, repo,
    type: 'gsv', runtime: 'gpt-sovits', kind: 'tts',
    dest: 'gpt-sovits/voices/' + id,
    note, files,
    size: files.reduce((s, f) => s + (f.size || 0), 0),
    minSize: Math.floor(files.reduce((s, f) => s + (f.size || 0), 0) * 0.9),
    arch: 'GPT-SoVITS',
    use: 'GPT-SoVITS 社区微调音色：配音/念白；歌声需走「逐句参考重合成」通道',
    downloadable: true,
  }, extra || {});
}

//: 已核对可下载（hf-mirror 上的仓库文件清单实测存在）
const CATALOG = [
  voice('gsv_nene', '草薙宁宁（GPT-SoVITS）', 'shibing624/parrots-gpt-sovits-speaker', 'KusanagiNene',
    '社区微调音色 · 约 230MB · 含参考音',
    [{ path: 'KusanagiNene/gpt.ckpt', size: 155090000 }, { path: 'KusanagiNene/sovits.pth', size: 84900000 },
     { path: 'KusanagiNene/ref.wav', size: 200000 }, { path: 'KusanagiNene/config.json', size: 2000 }]),
  voice('gsv_kuile', 'KuileBlanc（GPT-SoVITS）', 'shibing624/parrots-gpt-sovits-speaker', 'KuileBlanc',
    '社区微调音色 · 约 230MB · 含参考音',
    [{ path: 'KuileBlanc/gpt.ckpt', size: 155090000 }, { path: 'KuileBlanc/sovits.pth', size: 84900000 },
     { path: 'KuileBlanc/ref.wav', size: 200000 }, { path: 'KuileBlanc/config.json', size: 2000 }]),
  voice('gsv_longshouren', 'LongShouRen（GPT-SoVITS）', 'shibing624/parrots-gpt-sovits-speaker', 'LongShouRen',
    '社区微调音色 · 约 230MB · 含参考音',
    [{ path: 'LongShouRen/gpt.ckpt', size: 155090000 }, { path: 'LongShouRen/sovits.pth', size: 84900000 },
     { path: 'LongShouRen/ref.wav', size: 200000 }, { path: 'LongShouRen/config.json', size: 2000 }]),
  // ★ 同一个仓库里其实有 6 个音色 —— 早先只挂了 3 个，用户看到的「下载不全」就是这来的。
  //   清单用 hf-mirror 的 /api/models/<repo>/tree/main?recursive=true 核对过（每个目录都是
  //   gpt.ckpt + sovits.pth + ref.wav 三件套，可直接下载）。
  voice('gsv_maimai', 'MaiMai（GPT-SoVITS）', 'shibing624/parrots-gpt-sovits-speaker', 'MaiMai',
    '社区微调音色 · 约 230MB · 含参考音',
    [{ path: 'MaiMai/gpt.ckpt', size: 155090000 }, { path: 'MaiMai/sovits.pth', size: 84900000 },
     { path: 'MaiMai/ref.wav', size: 700000 }, { path: 'MaiMai/config.json', size: 2000 }]),
  voice('gsv_xingtong', 'XingTong（GPT-SoVITS）', 'shibing624/parrots-gpt-sovits-speaker', 'XingTong',
    '社区微调音色 · 约 230MB · 含参考音',
    [{ path: 'XingTong/gpt.ckpt', size: 155090000 }, { path: 'XingTong/sovits.pth', size: 84900000 },
     { path: 'XingTong/ref.wav', size: 300000 }, { path: 'XingTong/config.json', size: 2000 }]),
  voice('gsv_xuanshen', 'XuanShen（GPT-SoVITS）', 'shibing624/parrots-gpt-sovits-speaker', 'XuanShen',
    '社区微调音色 · 约 230MB · 含参考音',
    [{ path: 'XuanShen/gpt.ckpt', size: 155090000 }, { path: 'XuanShen/sovits.pth', size: 84900000 },
     { path: 'XuanShen/ref.wav', size: 500000 }, { path: 'XuanShen/config.json', size: 2000 }]),
];


//: ★ 只有「门户/网盘/论坛/Spaces」的社区音色：没有稳定直链，**不假装能一键下载**，
//:   但在资源中心里列出来并给一个「打开来源」——否则用户根本不知道有这些地方。
//:   （能自动下载的都进 CATALOG，见上面。）
const EXTERNAL = [
  { id: 'ext_aihobbyist', name: 'AI Hobbyist 交流社区',
    note: '官方文档推荐的模型分享社区（蔚蓝档案 / 明日方舟 等）；需注册后在帖子/网盘取模型',
    url: 'https://www.ai-hobbyist.com/forum.php' },
  { id: 'ext_genshin_space', name: '《原神》全角色（HF Spaces · 白菜工厂1145）',
    note: 'A-L / M-Q / S-Z 三个在线推理 Space，作者同时给度盘与 123 盘下载；在线推理较慢',
    url: 'https://huggingface.co/spaces/baicai1145/Genshin_A-L' },
  { id: 'ext_genshin_pan', name: '《原神》模型网盘（提取码 1145）',
    note: '同上作者的度盘合集；网盘链接需要手动下载后导入音色目录',
    url: 'https://pan.baidu.com/s/1x_THJNAZU-aExdAKfCUdbg?pwd=1145' },
  { id: 'ext_owvoice', name: '《守望先锋》OwVoice',
    note: '守望先锋角色本地语音合成工具（用 GPT-SoVITS 推理），仓库里带音色与参考音',
    url: 'https://github.com/Zed2047/OwVoice' },
  { id: 'ext_paperwitch', name: '《纸上魔法使》全角色（提取码 1234）',
    note: 'B 站分享的合集，走网盘；下载后把 .ckpt/.pth/参考音放进音色目录即可',
    url: 'https://pan.baidu.com/s/1Ml_wwonPP7s6zykC5lIhkw?pwd=1234' },
  { id: 'ext_yumene', name: '《梦限大》全员（提取码 7cen）',
    note: 'B 站分享的合集，走网盘',
    url: 'https://pan.baidu.com/s/1DzzRUCYglmAUMYhG3mgvLA?pwd=7cen' },
  { id: 'ext_gsvi', name: 'GPT-SoVITS 推理特化包 GSVI',
    note: '推理向整合包：角色与参考音选择更省事（第三方项目，非本工具组件）',
    url: 'https://github.com/X-T-E-R/TTS-for-GPT-soVITS' },
  { id: 'ext_liuying', name: 'GPT-SoVITS TTS 模型库（liuying）',
    note: '综合模型仓库，模型放在 Releases 里，需要手动下载',
    url: 'https://github.com/ikun14514/liuying_GPT-SoVITS' },
  { id: 'ext_blog4000', name: '4000+ 角色模型合集（推理特化包博客）',
    note: '涵盖原神 / 星铁 / 崩三 / 绝区零 / 蔚蓝档案 / 明日方舟 / NIKKE 等，持续更新；以网盘为主',
    url: 'https://blog.050905.xyz' },
  { id: 'ext_official', name: '官方 GPT-SoVITS（预训练模型 / 整合包）',
    note: '训练与推理的基础模型（V1/V2/V3/V4）；本工具的运行时就是它',
    url: 'https://huggingface.co/lj1995/GPT-SoVITS/tree/main' },
];

function voicesRoot(dataRoot) { return require('path').join(dataRoot, 'gpt-sovits', 'voices'); }

/** 候选下载地址：hf-mirror 优先（国内直连可用），再回落官方 */
function fileUrls(repo, rel) {
  return [HF_MIRROR + repo + '/resolve/main/' + rel, HF_DIRECT + repo + '/resolve/main/' + rel];
}

/**
 * 下载一个音色（逐文件走统一入口）。
 * @returns {Promise<{ok:boolean, path:string, size:number}>}
 */
async function downloadVoice(spec, destDir, FastDL, { onProgress, ctrl, isUserAbort, headers } = {}) {
  const fs = require('fs');
  const path = require('path');
  const total = spec.size || 0;
  let done = 0;
  const results = [];
  for (const f of spec.files) {
    const out = path.join(destDir, f.path.replace(/^[^/]+\//, '').replace('config.json', 'config.json'));
    const flat = path.join(destDir, path.basename(f.path));
    fs.mkdirSync(path.dirname(flat), { recursive: true });
    if (f.path.endsWith('config.json') || f.path.endsWith('ref.wav')) {
      // 小文件：直接取，不做分段
      const r = await FastDL.downloadFast({
        urls: fileUrls(spec.repo, f.path), dest: flat, minSize: 1, headers,
        isUserAbort, ctrl, singleStream: true, label: path.basename(f.path),
      });
      results.push(flat);
      done += r.size;
    } else {
      const r = await FastDL.downloadFast({
        urls: fileUrls(spec.repo, f.path), dest: flat, minSize: Math.floor((f.size || 1) * 0.85),
        expectSize: 0, headers, isUserAbort, ctrl, label: path.basename(f.path),
        onProgress: (p) => { try { onProgress && onProgress({ received: done + (p.received || 0), total, percent: total ? Math.min(99, Math.round((done + (p.received || 0)) / total * 100)) : 0, speed: p.speed || 0, host: p.host || '' }); } catch (e) {} },
      });
      results.push(flat);
      done += r.size;
      try { onProgress && onProgress({ received: done, total, percent: Math.min(99, Math.round(done / total * 100)), speed: 0, host: r.host }); } catch (e) {}
    }
    void out;
  }
  const sum = results.reduce((s, p) => { try { return s + fs.statSync(p).size; } catch (e) { return s; } }, 0);
  if (sum < spec.minSize) throw new Error('下载不完整：' + sum + ' < ' + spec.minSize);
  return { ok: true, path: destDir, size: sum, files: results };
}

/** 本地是否已就绪（权重齐 + 参考音在） */
function voiceState(spec, destDir) {
  const fs = require('fs');
  const path = require('path');
  let size = 0, have = 0;
  for (const f of spec.files) {
    const p = path.join(destDir, path.basename(f.path));
    try { const st = fs.statSync(p); size += st.size; have += 1; } catch (e) { /* 缺 */ }
  }
  return { exists: have === spec.files.length && size >= spec.minSize, size, files: have };
}

module.exports = { CATALOG, EXTERNAL, voicesRoot, fileUrls, downloadVoice, voiceState, HF_MIRROR, HF_DIRECT };
