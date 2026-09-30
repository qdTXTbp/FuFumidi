# DiffSinger 声库目录同步

「资源中心 → 模型管理 → DiffSinger」板块的声库清单来源与维护方式。

## 数据来源

- 仓库：[ModelScope `aihobbyist/ACG-DiffSinger-VoiceDB`](https://www.modelscope.cn/models/aihobbyist/ACG-DiffSinger-VoiceDB)
- 作者：**@红血球AE3803**
- 许可：**CC-BY-NC-4.0**（非商用；训练语音版权归对应游戏公司，仅供二次创作，严禁倒卖与商用）
- 覆盖：**原神** + **崩坏：星穹铁道**

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `sync.mjs` | 同步脚本：从 ModelScope 官方 API 抽取完整文件清单，生成静态目录模块 |
| `repo-files.snapshot.json` | 上游文件清单快照（离线兜底 + 差异比对） |
| `../../main/diffsinger-ms-catalog.js` | **自动生成**的目录数据模块（唯一数据源，勿手工编辑） |

## 用法

```bash
# 从官方 API 重新抓取并生成（推荐，需联网）
node scripts/diffsinger-ms/sync.mjs

# 用本地快照离线生成
node scripts/diffsinger-ms/sync.mjs --offline

# 只校验现有清单是否与上游一致（退出码 2 表示不一致）
node scripts/diffsinger-ms/sync.mjs --check
```

## 设计要点

1. **完整列出、不遗漏、不截断**
   脚本递归遍历仓库全部目录（深度 ≤ 6，带重试），把所有 `.zip` 逐个抽入目录，按
   `作品 → 分类 → 角色` 三级结构组织。当前共 **171** 条（可用 163 / 占位 8）。

2. **占位文件识别**
   上游部分条目标记为 134 字节占位（如「原神/纳塔」下 8 个），脚本以
   `PLACEHOLDER_MAX_BYTES`（64 KB）阈值自动标记 `placeholder: true`，
   UI 展示为「待发布」并禁用下载，避免用户下到无效文件。

3. **全球同源下载**
   每个条目的 `url` 由 `msFileUrl()` 生成，格式固定为：

   ```
   https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=<URL编码的相对路径>
   ```

   该地址为 ModelScope 官方直连（302 跳转到官方 CDN），不做任何镜像替换、
   不改 host、不加代理参数，保证全球用户内容、下载地址与下载结果一致。

4. **可维护性**
   上游仓库更新后重新运行 `sync.mjs` 即可刷新清单，无需改动任何 UI 代码；
   `--check` 可用于 CI 中检测清单是否滞后于上游。

## 回归验证

生成后建议抽样校验下载地址仍可解析（应返回 `206` 且 ZIP 魔数为 `504b0304`）：

```bash
node -e "const c=require('./main/diffsinger-ms-catalog.js');const m=c.BY_PATH.get('原神/蒙德城/丽莎.zip');fetch(m.url,{headers:{Range:'bytes=0-3','User-Agent':'Mozilla/5.0'}}).then(r=>r.arrayBuffer()).then(b=>console.log(r.status,Buffer.from(b).toString('hex')))"
```
