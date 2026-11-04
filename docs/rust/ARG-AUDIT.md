# Tauri 参数契约审计（静态）

> 由 node scripts/tauri/arg-audit.mjs --write 生成；只解析源码，不启动窗口。
> 启发式：多行/嵌套对象参数可能有误报。

| 指标 | 数值 |
|---|---:|
| Rust command | 96 |
| bridge call | 128 |
| 参数不一致 | 39 |

## 不一致列表

- file_assoc（Rust 未找到命令）
  - bridge 多参数: enabled
- pick_file
  - bridge 多参数: filters
- sf_workshop_list（Rust 未找到命令）
- sf_workshop_download（Rust 未找到命令）
  - bridge 多参数: id
- sf_workshop_cancel（Rust 未找到命令）
  - bridge 多参数: id
- sf_workshop_import（Rust 未找到命令）
- sf_workshop_delete（Rust 未找到命令）
  - bridge 多参数: id
- sf_workshop_open_dir（Rust 未找到命令）
- probe（Rust 未找到命令）
- refine（Rust 未找到命令）
  - bridge 多参数: req
- model_download（Rust 未找到命令）
  - bridge 多参数: req
- model_cancel（Rust 未找到命令）
  - bridge 多参数: id
- model_pause（Rust 未找到命令）
  - bridge 多参数: id
- model_delete（Rust 未找到命令）
  - bridge 多参数: id
- dep_install（Rust 未找到命令）
  - bridge 多参数: group
- export_score_png_zip（Rust 未找到命令）
  - bridge 多参数: opts
- export_score_pdf（Rust 未找到命令）
- transcode_video（Rust 未找到命令）
  - bridge 多参数: opts
- open_edit_guide（Rust 未找到命令）
- update_list（Rust 未找到命令）
- launch_updater（Rust 未找到命令）
  - bridge 多参数: channel
- check_update（Rust 未找到命令）
  - bridge 多参数: channel
- update_notes（Rust 未找到命令）
  - bridge 多参数: tag
- update_download（Rust 未找到命令）
  - bridge 多参数: url, channel, name, size
- update_open（Rust 未找到命令）
  - bridge 多参数: p
- gpu_status（Rust 未找到命令）
- gpu_uninstall（Rust 未找到命令）
  - bridge 多参数: kind
- gpu_list_packages（Rust 未找到命令）
- gpu_package_url（Rust 未找到命令）
  - bridge 多参数: kind
- gpu_download_package（Rust 未找到命令）
  - bridge 多参数: opts
- gpu_import_local（Rust 未找到命令）
  - bridge 多参数: req
- gpu_install_auto（Rust 未找到命令）
- plugins_list（Rust 未找到命令）
- plugins_set_enabled（Rust 未找到命令）
  - bridge 多参数: id, enabled
- plugins_invoke（Rust 未找到命令）
  - bridge 多参数: id, cmd, payload
- plugins_rescan（Rust 未找到命令）
- plugins_open_docs（Rust 未找到命令）
- plugins_open_dir（Rust 未找到命令）
- wallpaper_download（Rust 未找到命令）
  - bridge 多参数: url, name

## 说明

Rust 端注入参数（AppHandle/State/WebviewWindow）已排除；无参 call 不列出。
