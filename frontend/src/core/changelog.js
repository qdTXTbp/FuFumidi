// 内置更新日志：用于「更新完成后首次启动」弹窗展示。
// 版本号（不带 v）→ 该版本要点列表；发布新版本时在此追加即可。
// 若内置缺失某个版本，前端会尝试经主进程 update:notes 拉取 GitHub release 说明补充。
const CHANGELOG = {
  '3.1.16': [
    '改进：更新改为增量更新器方案——启动检查发现新版本后拉起 kachina 增量更新器（FuFumidi.update.exe），差分下载只拉改动部分并显示进度，完成后自动重启，不再重下数百 MB 完整安装包',
    '修复：一键修复/自动更新安装中途中止「进程未关闭」——应用先自我退出，守护脚本等主程序完全退出后再运行安装器，可完整走完修复流程',
    '修复：完整性检查 core 误报——增加 asar 文件头校验与 statSync 重试，规避安装器替换文件瞬间的 ENOENT/半写误报',
    '修复：覆盖安装仍提示「进程未关闭」——安装器在安装前强杀 FuFumidi 完整进程树（含引擎 python 子进程），不再被残留进程占用而中止',
  ],
  '3.1.15': [
    '修复：UTAU 自制音库导出——仅录音（未上传音频）时也可显示片段列表与「导出音源」按钮，正常导出 oto.ini + wav 声库',
  ],
  '3.1.14': [
    '修复：一键修复真正生效——核心文件损坏（core-corrupt/core-missing）点击「一键修复」自动下载安装包并静默重装恢复',
  ],
  '3.1.13': [
    '修复：更新流程重构——由主进程预下载完整离线安装包（多镜像+大小校验）后再本地静默安装，下载中关闭/中断不再损坏已安装工具',
    '更新下载进度在应用内可见（每 5% + 完成提示），下载失败明确提示「当前安装未受影响」',
  ],
  '3.1.12': [
    '修复：升级时镜像链接不稳定导致工具损坏——更新器多镜像源（ghfast/gh-proxy/ghproxy.net/GitHub 官方），启动更新前自动探测可用源',
    '修复：更新后守护重启前校验核心文件完整性，损坏时不再启动残缺程序；应用启动完整性检查新增 app.asar 自检，损坏时明确提示重装',
    '修复：GPU 安装通知条存在时仍可重复触发安装（防重入 + 安装中禁用按钮 + 安装中禁止关闭通知条）',
  ],
  '3.1.11': [
    'GPU 加速包安装走国内加速：CUDA（cu128）pip 源链阿里云 → 上海交大 → 官方自动回退，预打包增强包下载补充 gh.jasonzeng.dev 加速',
    '新增 GPU 安装常驻通知条：任意页面可见安装进度/当前步骤，完成后展示成功或失败结果（点击跳转设置 → GPU，可手动关闭）',
  ],
  '3.1.10': [
    '更新完成后首次启动自动展示更新内容弹窗（对比上次版本，展示从旧版到当前的全部更新日志）',
    'UTAU 钢琴卷帘支持导入 MIDI 基底旋律：从文件或从曲库选一首 MIDI，自动转成音符（跳过鼓轨、读取 BPM），双击音符即可修改唱音',
    '资源中心新增转录模型运行时一键安装：MuScriptor / Aria-AMT / Transkun 依赖组，模型文件列表直接显示「缺运行时包 + 一键安装」',
    'GPU 一键加速完善：CUDA 增强包安装后自动自检，覆盖 Blackwell（RTX 50 系，CUDA 12.8 / cu128），失败给出驱动更新等明确指引',
    'MuScriptor 转录显式使用 CUDA（装好 GPU 增强包后自动生效），日志明确显示 GPU / CPU 推理',
    '修复：右键菜单导致 UTAU 钢琴卷帘整体消失的渲染崩溃',
    '修复：MuScriptor 模型下载后仍报 No module named "muscriptor"（运行时随安装包内置）',
  ],
  '3.1.9': [
    '新增 UTAU 歌声合成工作台：声库制作（上传切分/录音 + oto.ini 可视化标注）、曲谱钢琴卷帘编辑器、导入现成 .zip 声库、调声与渲染',
    '钢琴卷帘编辑器：画笔/选择工具、网格吸附、缩放、播放走带；框选多选、撤销/重做、复制/剪切/粘贴/重复、全选；拖拽画音、左右缘调时长、Alt 拖拽复制、方向键微调、右键菜单',
    '修复：右键菜单导致钢琴卷帘整体消失的渲染崩溃',
    '修复：MuScriptor 模型下载后仍报 No module named "muscriptor"（运行时包已随安装包内置）',
    '修复：MuScriptor 缺模型时报晦涩 HF 错误，改为清晰提示并列已就绪规格',
    '修复：模型切换失效（worker 未透传 model/model_size）与网页版参数预设「应用无效」',
  ],
  '3.1.8': [
    '修复：设置页「长→短」标签切换无动画（高度补间改用自然高度测量）',
    '补齐 5 处弹窗退场动画：混音台 / 批量替换歌词 / 乐谱分页预览 / 乐谱分屏 / 检查结果 / 参数预设管理',
  ],
  '3.1.7': [
    '修复：视频导出背景音乐曲速异常（音频按导出范围切片渲染，不再被截断变快）',
    '修复：瀑布 / 频谱时间轴与画面、音频对齐',
  ],
  '3.1.6': [
    '修复：转录后的 MIDI 关闭重开后无法播放（解析失败多来源回退：内存 → IndexedDB → SQLite）',
    '修复：桌面版视频导出黑屏（离屏画布挂载 DOM 进合成管线）',
  ],
  '3.1.5': [
    '全局 Web 弹窗统一（confirm/alert/prompt），设置/资源/侧边栏弹窗与编辑器、转换页退场动画',
    '下载健壮性：分卷原子合并、断点续传、防误判已就绪、避免 EPERM 崩溃',
    '转录页显示所用模型并标注已下载状态',
  ],
  '3.1.4': [
    '修复：歌单丢失（localStorage 优先 + SQLite 写队列 + 退出冲刷落盘）',
    '删除确认等弹窗全屏居中；安装包内嵌 kachina 更新器，自动更新链路完整',
    'MuScriptor（Small/Medium/Large）GitHub 镜像分卷下载，无需 HF Token',
  ],
  '3.1.3': [
    '歌单与歌曲管理 UX 重构：应用内弹窗替代浏览器原生提示、侧栏搜索、删除确认、显示时长',
    '播放上一首/下一首跟随当前歌单顺序；重复内容导入自动跳过并提示',
  ],
  '3.1.2': [
    '模型下载改造：多源自动测速 + 并行分卷下载 + SHA-256 校验',
    'MuScriptor 本地权重加载，转录完全离线；修复 CUDA 12.8 / Blackwell GPU 加速',
  ],
  '3.1.1': [
    'MuScriptor 模型下载：自动测速 + 多源并行分卷下载',
    '资源中心支持本地压缩包导入模型；深色主题细节适配',
  ],
  '3.1.0': [
    '资源中心：Python 依赖 / 模型运行时 / 模型文件 / 诊断与配置',
    '多引擎转录模型：MuScriptor、Aria-AMT、Transkun、piano_transcription',
    'GPU 一键加速（NVIDIA→CUDA / AMD·Intel→DirectML，支持 RTX 50 系 Blackwell）',
    '深浅色模式切换、动态壁纸库、侧边栏交互与全组件毛玻璃动效',
  ],
};

function verNum(v) {
  const m = String(v || '').replace(/^v/i, '').split('.').map(x => parseInt(x, 10) || 0);
  return ((m[0] || 0) * 1000000) + ((m[1] || 0) * 1000) + (m[2] || 0);
}

// 收集 (from, to] 区间内的内置 changelog 条目，按版本从旧到新排序
// from 传 0 表示全部（首次启动）
export function getBuiltinChangeLogs(from = 0, to = 999999) {
  const f = typeof from === 'number' ? from : verNum(from);
  const t = typeof to === 'number' ? to : verNum(to);
  const out = [];
  for (const ver of Object.keys(CHANGELOG)) {
    const n = verNum(ver);
    if (n > f && n <= t) out.push({ ver, items: CHANGELOG[ver] });
  }
  out.sort((a, b) => verNum(a.ver) - verNum(b.ver));
  return out;
}

// 远端补充：主进程按 tag 拉取 release 说明，解析为要点列表（失败返回 null）
export async function fetchRemoteChangeLog(ver) {
  try {
    const b = window.fuBridge;
    if (!b || typeof b.updateNotes !== 'function') return null;
    const r = await b.updateNotes('v' + String(ver).replace(/^v/i, ''));
    if (!r || !r.ok || !r.body) return null;
    const items = String(r.body)
      .split('\n')
      .map(x => x.replace(/^[-*•]\s*/, '').trim())
      .filter(x => x && !/^(#|==|----)/.test(x))
      .slice(0, 40);
    return items.length ? { ver, items } : null;
  } catch (e) { return null; }
}
