// 占位实现：当前桌面构建仍以 Electron + window.fuBridge 为主。
// Tauri 迁移未落地前，仅提供兼容空实现，避免前端构建因缺失模块失败。
export function installTauriBridge() {
  // 在 Tauri 环境中这里会注入等价 bridge；Electron 下不执行任何操作。
}
