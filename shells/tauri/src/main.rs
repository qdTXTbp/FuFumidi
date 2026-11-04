#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! FuFumidi Tauri 真正外壳（M1 第一步）。
//!
//! 边界（ADR-0002）：
//! - Rust：窗口/系统集成/host 业务/IPC 宿主；后续替换 main/*.js；
//! - Python：**只做模型推理**，由 Rust 启动并管理，模型格式/路径不变；
//! - UI：现有 Vue renderer/dist 直接加载（bridge 仍是 frontend/src/bridge/tauri.js）。
//!
//! 目前只提供 host 自检与最小 command；IPC 迁移从 T-115 纵切开始，逐条替换。

use std::path::{Path, PathBuf};
use std::process::Command;

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|p| p.to_path_buf())
}

fn repo_root_from_manifest() -> PathBuf {
    // shells/tauri -> repo root
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../").canonicalize().unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

/// 查找 Python：显式 env > 安装版 resources/python > 开发树 resources/python。
fn python_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("FUFUMIDI_PYTHON") {
        let pb = PathBuf::from(p);
        if pb.exists() { return Some(pb); }
    }
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Some(d) = exe_dir() {
        cands.push(d.join("python/python.exe"));
        cands.push(d.join("../resources/python/python.exe"));
        cands.push(d.join("resources/python/python.exe"));
    }
    cands.push(repo_root_from_manifest().join("resources/python/python.exe"));
    cands.into_iter().find(|p| p.exists())
}

fn renderer_dir() -> PathBuf {
    repo_root_from_manifest().join("renderer/dist")
}

fn host_info_json() -> serde_json::Value {
    let py = python_path();
    let renderer = renderer_dir();
    serde_json::json!({
        "ok": true,
        "product": "FuFumidi",
        "version": env!("CARGO_PKG_VERSION"),
        "mode": if cfg!(debug_assertions) { "debug" } else { "release" },
        "python": py.as_ref().map(|p| p.display().to_string()),
        "pythonExists": py.as_ref().map(|p| p.exists()).unwrap_or(false),
        "renderer": renderer.display().to_string(),
        "rendererExists": renderer.join("index.html").exists(),
    })
}

#[tauri::command]
fn host_info() -> serde_json::Value {
    host_info_json()
}

/// Python 只做推理：这里只验证解释器可启动，不做任何模型/参数替换。
#[tauri::command]
fn python_selfcheck() -> serde_json::Value {
    let Some(py) = python_path() else {
        return serde_json::json!({ "ok": false, "error": "python runtime not found（检查 resources/python 或 FUFUMIDI_PYTHON）" });
    };
    match Command::new(&py)
        .args(["-c", "import sys; print(sys.version.split()[0])"])
        .output()
    {
        Ok(out) => serde_json::json!({
            "ok": out.status.success(),
            "python": py.display().to_string(),
            "version": String::from_utf8_lossy(&out.stdout).trim(),
            "stderr": String::from_utf8_lossy(&out.stderr).trim(),
        }),
        Err(e) => serde_json::json!({ "ok": false, "python": py.display().to_string(), "error": e.to_string() }),
    }
}

#[tauri::command]
fn ping(payload: Option<serde_json::Value>) -> serde_json::Value {
    serde_json::json!({ "ok": true, "pong": true, "echo": payload.unwrap_or(serde_json::Value::Null) })
}

fn main() {
    if std::env::args().any(|a| a == "--self-check") {
        println!("{}", serde_json::to_string_pretty(&host_info_json()).unwrap_or_default());
        return;
    }
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![host_info, python_selfcheck, ping])
        .setup(|_app| {
            let info = host_info_json();
            println!("[fufumidi-shell] {}", serde_json::to_string(&info).unwrap_or_default());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running FuFumidi Tauri shell");
}
