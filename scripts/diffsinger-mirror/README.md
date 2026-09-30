# DiffSinger 组件双源分发(GitHub + CNB)

本目录是 FuFumidi **DiffSinger 可选模块**的组件分发清单与发布说明。

应用内下载逻辑(`main/diffsinger.js`)按 `settings.download_source` 选择线路:

| 偏好 | 候选顺序 |
|---|---|
| 自动 / 国内(CNB) | ① CNB 镜像仓库 Release 资产 → ② GitHub 自有仓库(+加速镜像) → ③ openvpi 官方 Release |
| 全球(GitHub) | ① GitHub 自有仓库(+加速镜像) → ② openvpi 官方 Release → ③ CNB 镜像仓库 |

任何一轮失败自动换源 + 断点续传,用户无感。

## 仓库

- **GitHub**:`FuFuCloud-mirror/DiffSinger`(公开仓库)
- **CNB**:`FuFuCloud-mirror/DiffSinger`(公开仓库;CNB Release 资产走对象存储,单文件 1.5GB 内可用)

两个平台同名。Release tag 命名:`vocoder-<版本>`(如 `vocoder-2024.02`),资产文件名与上游保持一致。

## 首次建仓

1. **GitHub**:在 `FuFuCloud-mirror` 组织下新建公开仓库 `DiffSinger`,初始化 README(可拷贝本文件 + `manifest.json`)。
2. **CNB**:在 cnb.cool 的 `FuFuCloud-mirror` 团队下新建同名公开仓库(空仓库即可,Release 资产不依赖 git 树)。

## 发布 / 更新组件

组件清单见 `manifest.json`。当前只有一个组件(通用声码器):

```powershell
# 0) 准备 CNB 令牌(只从环境变量读)
$env:CNB_TOKEN = '<CNB 访问令牌>'

# 1) 下载上游声码器(openvpi 官方 Release,已验证直链)
$zip = 'nsf_hifigan_44.1k_hop512_128bin_2024.02.zip'
Invoke-WebRequest "https://github.com/openvpi/vocoders/releases/download/nsf-hifigan-44.1k-hop512-128bin-2024.02/$zip" -OutFile $zip

# 2) 传到 GitHub 自有仓库(release tag = vocoder-2024.02)
#    需要 gh CLI 已认证;没有 gh 也可在网页端上传
gh release create vocoder-2024.02 $zip --repo FuFuCloud-mirror/DiffSinger --title "NSF-HiFiGAN vocoder 2024.02" --notes "Mirrored from openvpi/vocoders (CC BY-NC-SA 4.0)."

# 3) 镜像到 CNB(复用项目现有脚本:GitHub Release 资产 → CNB Release 资产,幂等)
node scripts/mirror-to-cnb.mjs release `
  --repo FuFuCloud-mirror/DiffSinger --tag vocoder-2024.02 `
  --dst-repo FuFuCloud-mirror/DiffSinger --dst-tag vocoder-2024.02
```

完成后国内源地址即:
`https://cnb.cool/FuFuCloud-mirror/DiffSinger/-/releases/download/vocoder-2024.02/nsf_hifigan_44.1k_hop512_128bin_2024.02.zip`
(与 `main/download-source.js` 的 `cnbRepoReleaseUrl()` 拼接规则一致。)

## 合规红线(务必遵守)

- **可镜像**:openvpi 社区声码器(CC BY-NC-SA 4.0 明确允许再分发,随包保留许可证与署名)。
- **不可镜像**:第三方声库模型权重。例如 Ria 的许可证是白名单条款,只授权「输出音频」的传播,
  **未授权模型权重再分发**——因此 Ria 只走作者 GitHub 源(经加速镜像),不做 CNB 镜像。
  新增公开声库条目时,先确认作者授权条款是否允许再分发,再在 `manifest.json` 标 `mirror: true/false`。

## 代码侧同步点

- `main/download-source.js` → `CNB_MIRROR_REPOS.diffsinger`(镜像仓库注册)
- `main/diffsinger.js` → `VOCODER_SPEC`(ghUrl = 自有仓库,cnb = 镜像仓库,fallback = 官方上游)
- `manifest.json` → 人工维护的组件清单(将来可做下载前 sha256 校验)
