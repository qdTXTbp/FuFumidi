// 插件服务：清单扫描 / 启停 / 重扫 / 打开目录 —— 移植自 main/plugins.js（简化版，不含沙箱执行）
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::settings;

fn plugins_user_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("fufumidi")
        .join("plugins")
}

fn scan_dir(app: &AppHandle, dir: &Path, out: &mut Vec<Value>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let manifest_path = p.join("plugin.json");
            if !manifest_path.exists() {
                continue;
            }
            let meta = fs::read_to_string(&manifest_path)
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok());
            let meta = meta.unwrap_or_else(|| json!({}));
            let id = meta["id"].as_str().map(|s| s.to_string()).unwrap_or_else(|| {
                p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
            });
            let enabled = enabled_state(app, &id);
            out.push(json!({
                "id": id,
                "name": meta["name"].as_str().unwrap_or(&id),
                "version": meta["version"].as_str().unwrap_or(""),
                "description": meta["description"].as_str().unwrap_or(""),
                "commands": meta["commands"].as_array().cloned().unwrap_or_default(),
                "entry": meta["entry"].as_str().unwrap_or("index.js"),
                "enabled": enabled,
                "builtin": dir.starts_with("plugins"),
            }));
        }
    }
}

// 插件启停状态存于 settings.plugins_enabled
fn enabled_state(app: &AppHandle, id: &str) -> bool {
    let s = settings::read_settings(app);
    s["plugins_enabled"]
        .as_array()
        .map(|a| a.iter().any(|v| v.as_str() == Some(id)))
        .unwrap_or(false)
}

fn set_enabled_state(app: &AppHandle, id: &str, enabled: bool) {
    let s = settings::read_settings(app);
    let mut list: Vec<String> = s["plugins_enabled"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(|x| x.to_string())).collect())
        .unwrap_or_default();
    list.retain(|x| x != id);
    if enabled {
        list.push(id.to_string());
    }
    settings::save_settings(app.clone(), json!({ "plugins_enabled": list }));
}

fn all_plugins(app: &AppHandle) -> Vec<Value> {
    let mut out = Vec::new();
    // 用户插件目录
    let user_dir = plugins_user_dir(app);
    let _ = fs::create_dir_all(&user_dir);
    scan_dir(app, &user_dir, &mut out);
    // 内置插件目录（开发模式 / 打包后 resources）
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        roots.push(res.join("plugins"));
    }
    roots.push(PathBuf::from("plugins"));
    for r in roots {
        if r.exists() {
            scan_dir(app, &r, &mut out);
        }
    }
    out
}

#[tauri::command]
pub fn plugins_list(app: AppHandle) -> Vec<Value> {
    all_plugins(&app)
}

#[tauri::command]
pub fn plugins_set_enabled(app: AppHandle, id: String, enabled: bool) -> Value {
    set_enabled_state(&app, &id, enabled);
    json!({ "ok": true })
}

#[tauri::command]
pub fn plugins_rescan(app: AppHandle) -> Vec<Value> {
    all_plugins(&app)
}

// 插件 invoke：简化版——Tauri 阶段暂不支持沙箱执行，返回提示
#[tauri::command]
pub fn plugins_invoke(app: AppHandle, id: String, cmd: String, payload: Option<Value>) -> Value {
    json!({
        "ok": false,
        "error": format!("插件「{}」的命令 {} 暂不可用（Tauri 版插件沙箱待移植）", id, cmd),
        "cmd": cmd,
        "payload": payload,
    })
}

#[tauri::command]
pub fn plugins_open_dir(app: AppHandle) -> Value {
    let dir = plugins_user_dir(&app);
    let _ = fs::create_dir_all(&dir);
    let _ = std::process::Command::new("explorer.exe")
        .arg(dir.to_string_lossy().to_string())
        .spawn();
    json!({ "ok": true })
}

#[tauri::command]
pub fn plugins_open_docs(app: AppHandle) -> Value {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("plugins").join("plugin-dev.html"));
    }
    candidates.push(PathBuf::from("plugins/plugin-dev.html"));
    for p in &candidates {
        if p.exists() {
            let _ = std::process::Command::new("cmd.exe")
                .args(["/C", "start", "", &p.to_string_lossy().to_string()])
                .spawn();
            return json!({ "ok": true, "path": p.to_string_lossy() });
        }
    }
    json!({ "ok": false, "path": candidates[0].to_string_lossy() })
}
