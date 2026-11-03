#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! FuFumidi Tauri 2 可行性 POC —— 最小外壳 + 双 command 往返 + 证据落盘。
//! 证据文件：<crate>/ipc-smoke.log（由 Rust 侧追加，JS 无法伪造，用来证明 webview 真的跑起来了）

use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};

static CALLS: AtomicUsize = AtomicUsize::new(0);

fn poc_log(tag: &str, body: &str) {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/ipc-smoke.log");
    let line = format!(
        "{{\"t\":\"{}\",\"tag\":\"{}\",\"body\":{}}}",
        chrono_like_now(),
        tag,
        body
    );
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

// 不引入 chrono：只需要"相对可信"的时间戳，用系统时间秒数即可
fn chrono_like_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// POC 命令 1：无参调用，验证 command 往返
#[tauri::command]
fn poc_ping() -> String {
    poc_log("ping", "\"pong\"");
    "pong-from-rust".to_string()
}

/// POC 命令 2：带参 + 结构化返回，验证 serde 序列化边界
#[tauri::command]
fn poc_echo(payload: serde_json::Value) -> serde_json::Value {
    let n = CALLS.fetch_add(1, Ordering::SeqCst) + 1;
    let raw = serde_json::to_string(&payload).unwrap_or_else(|_| "null".to_string());
    poc_log("echo", &format!("{{\"call\":{},\"payload\":{}}}", n, raw));
    serde_json::json!({
        "ok": true,
        "received": payload,
        "callCount": n,
    })
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![poc_ping, poc_echo])
        .setup(|app| {
            // 仅用于 POC 测量：加载"真实 renderer/dist"时，把 `window.fuBridge` 的存在性写进窗口标题，
            // 让外部探测脚本（window-probe.ps1 读 MainWindowTitle）能拿到结果。
            // 设 POC_PROBE_BRIDGE=1 才启用，正常跑 POC 页面时无副作用。
            if std::env::var("POC_PROBE_BRIDGE").is_ok() {
                use tauri::Manager;
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(2500));
                    if let Some(w) = handle.get_webview_window("main") {
                        // 把测量结果通过我们自己的 command 写回 ipc-smoke.log（document.title 不会同步到原生标题栏）
                        let js = r#"try {
                            window.__TAURI__.core.invoke('poc_echo', { payload: {
                              probe: 'renderer-dist',
                              fuBridge: typeof window.fuBridge,
                              tauriGlobal: typeof window.__TAURI__,
                              appChildren: (document.getElementById('app') || { childElementCount: -1 }).childElementCount,
                              title: document.title,
                              href: location.href
                            }});
                          } catch (e) { console.error(e); }"#;
                        let _ = w.eval(js);
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri-poc");
}