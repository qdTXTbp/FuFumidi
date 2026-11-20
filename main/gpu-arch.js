// ============================================================
// GPU 架构覆盖表（ROCm 侧）
// ============================================================
// 为什么需要它：`torch.version.hip` 非空只证明「装的是 ROCm 版 torch」，
// 不证明「这颗卡的 kernel 在这个包里」。ROCm on Windows 的 SDK 轮子是**按架构**发的。
//
// 当前使用的 rocm_sdk_libraries_custom-7.2.0 实测只含 7 个 gfx（扫 wheel 得到的 kernel 目录）：
//   gfx1201 / gfx1200（RX 9000）、gfx1101 / gfx1100 / gfx1102（RX 7000）、
//   gfx1150 / gfx1151（Radeon 800M 系核显）
// RX 6000（gfx1030-1034）、RX 5000（gfx1010-1012）、Raphael 核显（gfx1036）、
// 740M-780M（gfx1103）都不在里面 —— 与 AMD 的 Windows PyTorch 兼容表一致。
// 参考实现：FlowHMR-Windows 用 AMD TheRock 的 Windows 架构包补上 RX 5000/6000 与老核显。
//
// ★ 这张表只用于「提示与诊断」，**不能替代真实算子校验**：
//   算子跑通说明 kernel 确实在（表可能滞后）；算子跑不通时，这张表用来说明原因。
// ★ 更新 ROCm 包后请重新扫 wheel，不要凭记忆改：
//   python -c "import zipfile,re,sys;z=zipfile.ZipFile(sys.argv[1]);print(sorted({m for n in z.namelist() for m in re.findall(r'gfx[0-9a-f]{3,4}',n)}))" <wheel>
// ============================================================
'use strict';

/** rocm_sdk_libraries_custom-7.2.0 实测覆盖的 gfx 架构（顺序 = 新 → 旧） */
const ROCM_GFX_72 = Object.freeze([
  'gfx1201', 'gfx1200',
  'gfx1101', 'gfx1100', 'gfx1102',
  'gfx1150', 'gfx1151',
]);

/** 显卡系列说明（仅用于提示；未知返回空串，不猜） */
const GFX_SERIES = Object.freeze({
  gfx1200: 'Radeon RX 9000 系列', gfx1201: 'Radeon RX 9000 系列',
  gfx1100: 'Radeon RX 7900', gfx1101: 'Radeon RX 7800/7700', gfx1102: 'Radeon RX 7600',
  gfx1030: 'Radeon RX 6800/6900', gfx1031: 'Radeon RX 6700/6750',
  gfx1032: 'Radeon RX 6600/6650', gfx1034: 'Radeon RX 6400/6500',
  gfx1010: 'Radeon RX 5700/5600', gfx1012: 'Radeon RX 5500/5300',
  gfx1036: 'Raphael 核显（Ryzen 7000 桌面）',
  gfx1103: 'Radeon 740M/760M/780M',
  gfx1150: 'Radeon 880M/890M', gfx1151: 'Radeon 8040S-8065S',
  gfx1152: 'Radeon 820M/840M/860M（部分）', gfx1153: 'Radeon 820M/840M/860M（部分）',
});

/** 从 gcnArchName（如 'gfx1100:sramecc+:xnack-'）取出架构名；拿不到返回 '' */
function normalizeGfx(v) {
  const m = /gfx[0-9a-f]{3,4}/i.exec(String(v == null ? '' : v));
  return m ? m[0].toLowerCase() : '';
}

/** 是否在覆盖表里。信息不足返回 **null**（未知），不要当成 false。 */
function rocmGfxSupported(gfx, list) {
  const g = normalizeGfx(gfx);
  if (!g) return null;
  return (list || ROCM_GFX_72).indexOf(g) >= 0;
}

/** 给用户看的说明（算子校验失败时拼进错误里） */
function rocmGfxHint(gfx, list) {
  const g = normalizeGfx(gfx);
  if (!g) return '未能读取显卡架构（gcnArchName 为空）';
  const series = GFX_SERIES[g] || '';
  const known = series ? (series + '（' + g + '）') : g;
  if (rocmGfxSupported(g, list) === true) {
    return known + ' 在当前 ROCm 包的支持列表里，但算子校验未通过';
  }
  return known + ' 不在当前 ROCm 7.2 包支持的架构里（支持：'
    + (list || ROCM_GFX_72).join(' / ') + '）。'
    + 'RX 5000/6000 等较老架构需要 AMD TheRock 的 Windows 架构包，目前尚未提供；可先改用 CPU 转录。';
}

module.exports = { ROCM_GFX_72, GFX_SERIES, normalizeGfx, rocmGfxSupported, rocmGfxHint };
