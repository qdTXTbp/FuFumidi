// 进程工具：统一为外部命令执行设置 Windows 隐藏窗口标志（CREATE_NO_WINDOW）。
// Electron 侧用 spawn({ windowsHide: true }) 达成同样效果，Tauri 移植时漏掉了，
// 导致每次 curl/python/powershell/taskkill 等都会弹出黑色控制台窗口。
use std::process::Command;

/// 创建一个不会在 Windows 上弹出控制台窗口的命令。
pub fn cmd(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 0x08000000 = CREATE_NO_WINDOW：子进程不生成控制台窗口
        c.creation_flags(0x08000000);
    }
    c
}
