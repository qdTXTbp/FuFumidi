好的，这是一份可直接使用的 **GitHub 主分支代码提交与合并规范**，适用于您当前项目（3.1.1 及后续版本）。您可根据团队实际情况微调。

---

# 代码提交与合并规范（GitHub 主分支）

**版本**：v1.0  
**适用仓库**：FuFumidi / Midi 工具项目  
**生效日期**：2026-08-28  

---

## 1. 目的
- 保证 `main`（或 `master`）分支始终处于**可发布**的稳定状态。
- 降低因直接推送引发的回归风险。
- 保留清晰的版本历史，便于追溯与回滚。

---

## 2. 分支模型
- **主分支**：`main` – 仅接受合并，**禁止直接 push**。
- **开发/功能分支**：`feature/xxx`、`fix/xxx` – 从 `main` 切出，完成后通过 Pull Request（PR）合并回 `main`。
- **热修复分支**：`hotfix/xxx` – 同样走 PR，但可加速审查流程（紧急时由负责人特批）。

---

## 3. 提交信息格式
采用 **Conventional Commits** 风格，便于生成 Changelog：

```
<类型>(范围): 简短描述

[可选详细说明]
[关联 Issue #编号]
```

**类型**：
- `feat` – 新功能
- `fix` – 修复 Bug
- `docs` – 文档更新
- `style` – 代码格式（不影响逻辑）
- `refactor` – 重构
- `perf` – 性能优化
- `test` – 测试相关
- `chore` – 构建/工具变动

**示例**：
```
feat(model): 支持本地压缩包导入

- 新增 model:importLocal 事件
- 支持 zip/7z/tar/tar.gz
- 资源中心增加导入按钮

Closes #42
```

---

## 4. Pull Request 流程
### 4.1 创建 PR
- 标题采用 `<类型>: <描述>`，如 `feat(download): 多源并行下载优化`。
- 描述中说明**改动内容**、**测试结果**、**是否破坏兼容性**。
- 指定至少一名审查者（Reviewer）。

### 4.2 审查要求
- **代码审查**：检查逻辑正确性、性能、错误处理。
- **自动化检查**（CI）：必须通过 lint、单元测试、构建。
- **功能验证**：若涉及 UI 或模型操作，需附带截图或录屏（测试环境）。

### 4.3 合并方式
- **推荐**：使用 **Squash and merge**，将 PR 中所有提交压缩为一个，保持主分支历史线性、干净。
- **例外**：当 PR 包含多个独立逻辑提交（如功能 + 修复 + 文档），可使用 **Rebase and merge**，保留每个提交的原子性，但需确保每个提交都能独立通过测试。

**禁止**使用 “Create a merge commit” 除非有特殊理由（如需要保留并行分支历史）。

---

## 5. 标签（Tag）规范
每次合并到 `main` 后，如果该版本**对外发布**（即提供给用户或部署），必须打标签：

```bash
git tag -a v<主>.<次>.<补丁> -m "版本说明"
git push origin v<主>.<次>.<补丁>
```

- 版本号遵循 **语义化版本**（SemVer）：  
  - 主版本号：不兼容的 API 变更  
  - 次版本号：向下兼容的功能新增  
  - 补丁号：向下兼容的问题修复  
- 标签说明应简要列出本次更新主要亮点（可引用 PR 标题）。

---

## 6. 回滚（Rollback）策略
- 若合并后发现问题，立即由负责人评估是否回滚：
  - **硬回滚**：`git revert <merge-commit>` 生成反向提交，保留历史。
  - **软回滚**：若未推送至生产，可重置主分支并强制推送（需团队通知，谨慎使用）。

---

## 7. 权限与责任
- **主分支写权限**：仅限项目负责人（Lead）和核心维护者。
- **普通开发者**：无权直接 push，只能通过 PR 提交。
- **审查者**：需在 24 小时内响应 PR（工作日），紧急情况可加速。

---

## 8. 示例工作流（以 3.1.1 更新为例）

1. 开发者切分支：`git checkout -b feature/download-optimize`
2. 开发并提交：  
   `feat(download): 自动测速和多源并行下载`  
   `feat(model): 支持本地导入压缩包`
3. 推送分支，开 PR，标题 `feat: 下载优化及本地导入（3.1.1）`
4. 审查通过，CI 全绿，合并（Squash）进 `main`
5. 打标签：`git tag -a v3.1.1 -m "下载优化及本地模型导入"`
6. 推送标签，触发构建/发布流程。

---

## 9. 例外情况
- **紧急热修**（如阻塞性崩溃）：可直接在 `main` 上开 `hotfix` 分支，PR 可放宽审查人数（至少 1 人批准），但仍须通过 CI。
- **实验性功能**：可长期保留独立分支，不急于合并，待成熟后再走 PR。

---

## 10. 违规处理
- 未经 PR 直接 push `main` 的，由责任人负责修复并记录，重复发生将收回写权限。

---

## 11. 发布上传流程（Release）

**原则：先提交代码，再上传安装包。所有对外发布必须按以下顺序执行，禁止先上传后补提交。**

### 11.1 发布前检查
- 确认代码已提交并推送到对应分支（`main` / `feature/xxx`）。
- 确认版本号已同步更新：根 `package.json`、`frontend/package.json`。
- 确认本机 `npm run build`、`npm run build:ui` 通过。
- 确认 `electron-builder` 配置中的 `extraResources` 路径有效。

### 11.2 提交与标签
1. 使用 Conventional Commits 提交本次改动。
2. 如果是对外发布版本，必须打标签：
   ```bash
   git tag -a v<主>.<次>.<补丁> -m "版本说明"
   git push origin v<主>.<次>.<补丁>
   ```
3. 标签推送成功后才允许构建安装包与上传 Release。

### 11.3 构建安装包
- 使用 `electron-builder` 生成 NSIS 安装包：
  ```bash
  npx electron-builder --win nsis --x64 --publish never
  ```
- 产物：`release\FuFumidi Setup <版本>.exe` 与 `.blockmap`。
- 安装包命名统一为：`FuFumidi-Setup-<版本>.exe`。

### 11.4 上传 Release 要求
1. 在 GitHub 创建/更新 Release：
   - Tag：`v<版本>`
   - 目标分支：本次发布代码所在分支
   - 标题：`FuFumidi <版本>`
   - 简介：**必须使用 UTF-8 中文，严禁出现乱码**；可用 Markdown 列出更新、修复、依赖说明。
2. 上传资产使用 `uploads.github.com`：
   - `FuFumidi-Setup-<版本>.exe`
   - `FuFumidi-Setup-<版本>.exe.blockmap`
3. 上传后核对：
   - 资产名称、大小与本地一致。
   - 资产状态为 `uploaded`。
   - Release 简介在 GitHub 页面显示正常（无乱码）。

### 11.5 禁止事项
- **禁止**在未提交代码前上传安装包。
- **禁止**直接 push `main`（必须走 PR，见第 2 节）。
- **禁止**在 Release 简介中使用非 UTF-8 编码，或包含乱码字符。
- **禁止**上传与本地 SHA256 不一致的安装包。

### 11.6 Release 简介乱码原因与注意事项

**问题现象**：GitHub Release 页面简介中的中文变成类似 `绂荤嚎 MIDI` 的乱码。

**根本原因**：
- 通过 PowerShell `Invoke-RestMethod` 直接构造 JSON 时，PowerShell 可能按系统 ANSI/GBK 编码发送中文；GitHub 按 UTF-8 解析时就会显示乱码。
- 或使用了非 UTF-8 的本地文本文件作为请求体，未显式指定 `charset=utf-8`。

**注意事项 / 正确做法**：
1. **永远使用 UTF-8 作为 Release 简介编码**。
2. 推荐流程：新建一个 UTF-8 编码的 JSON 文件（`{ "name": "...", "body": "..." }`），再用 `curl` 以二进制文件方式提交：
   ```bash
   curl -X PATCH \
     -H "Authorization: token <TOKEN>" \
     -H "Content-Type: application/json; charset=utf-8" \
     --data-binary "@release-body.json" \
     https://api.github.com/repos/<owner>/<repo>/releases/<release_id>
   ```
3. 不要直接依赖 PowerShell 控制台编码写中文；若必须用 `Invoke-RestMethod`，请先将 JSON 写入 UTF-8 文件或使用 UTF-8 字节数组。
4. 上传后立即在 GitHub 页面检查简介中文是否正常；发现乱码立刻用 UTF-8 JSON 重新 PATCH。
5. 建议在 Release 简介中只用标准 Markdown + 纯中文/英文，避免特殊字符被编码破坏。

---

## 12. CI 自动化测试与主分支合并

**强制规则：所有更改（Pull Request）和安装包必须先通过 CI 自动化测试，才能合并到主分支。**

### 12.1 CI 检查内容
- 前端构建：`npm --prefix frontend run build`
- Python 语法检查：`python -m py_compile engine/*.py`
- 预设模块加载：`python -c "import presets"`
- UI 测试：`npm run test:ui`
- 插件沙箱测试：`npm run test:plugin`
- 全量 asar 打包：`node build.js full`，并检查关键文件存在。

### 12.2 安装包 CI
- 推送 **v 版本标签** 时触发 `package` 任务。
- 构建 NSIS 安装包并上传为 Actions artifact。
- 安装包必须与本地 `FuFumidi-Setup-<版本>.exe` 一致，并且通过 CI 后才能用于 Release。

### 12.3 分支保护
- `master` / `main` 已启用分支保护：
  - 必须通过 Pull Request 合并
  - 至少 1 个批准
  - 必须通过 **`CI / test`** 状态检查
  - 禁止强制推送、禁止删除分支
- 管理员可绕过保护（`enforce_admins: false`），但应遵守“先 CI 后合并”原则。

### 12.4 禁止事项
- **禁止**在 CI 未通过时合并到主分支。
- **禁止**跳过 CI 直接推送安装包到 GitHub Release。

---

本规范自发布之日起执行，如有疑问请及时与项目负责人沟通。  
（建议将本文件存放于仓库根目录 `.github/CODING_GUIDELINES.md` 或 `docs/` 下）