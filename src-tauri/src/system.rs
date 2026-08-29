// 系统服务：打开输出位置 / 文件关联 / 完整性检查 / 编辑指南 —— 移植自 main/system-ipc.js + settings-ipc.js
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::settings;

fn user_data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("fufumidi")
}

// 打开输出位置：文件存在 → 资源管理器定位；否则打开所在目录，再兜底下载目录
#[tauri::command]
pub async fn open_output(app: AppHandle, p: Option<String>) -> Value {
    let (some_file, some_dir) = match &p {
        Some(p) if !p.is_empty() => {
            let pb = PathBuf::from(p);
            let file = pb.is_file();
            let dir = if file {
                pb.parent().map(|d| d.to_path_buf())
            } else if pb.is_dir() {
                Some(pb.clone())
            } else {
                None
            };
            (file, dir)
        }
        _ => (false, None),
    };
    // 文件 → explorer /select
    if some_file {
        if let Some(p) = &p {
            let _ = std::process::Command::new("explorer.exe")
                .arg(format!("/select,{}", p))
                .spawn();
            return json!({ "ok": true });
        }
    }
    // 目录存在 → explorer 打开
    if let Some(dir) = some_dir {
        if dir.exists() {
            let _ = std::process::Command::new("explorer.exe")
                .arg(dir.to_string_lossy().to_string())
                .spawn();
            return json!({ "ok": true });
        }
    }
    // 兜底：用户下载目录
    if let Ok(dl) = app.path().download_dir() {
        let _ = std::process::Command::new("explorer.exe")
            .arg(dl.to_string_lossy().to_string())
            .spawn();
    }
    json!({ "ok": true })
}

// 完整性检查：校验 settings 文件存在且可解析、plugins 目录存在（轻量版）
#[tauri::command]
pub fn check_integrity(app: AppHandle) -> Value {
    let base = user_data_dir(&app);
    let mut issues: Vec<Value> = Vec::new();
    let sp = base.join("settings.json");
    if !sp.exists() {
        settings::init(&app);
    } else if serde_json::from_str::<Value>(&fs::read_to_string(&sp).unwrap_or_default()).is_err() {
        issues.push(json!({ "id": "settings_corrupt", "message": "settings.json 解析失败" }));
    }
    let plugins_dir = base.join("plugins");
    if !plugins_dir.exists() {
        let _ = fs::create_dir_all(&plugins_dir);
    }
    json!({ "ok": issues.is_empty(), "issues": issues })
}

#[derive(serde::Deserialize)]
pub struct RepairReq {
    ids: Option<Vec<String>>,
}

// 修复完整性：目前仅重建缺失文件
#[tauri::command]
pub fn repair_integrity(app: AppHandle, req: RepairReq) -> Value {
    let ids = req.ids.unwrap_or_default();
    let mut results = Vec::new();
    for id in &ids {
        if id == "settings_corrupt" {
            let sp = user_data_dir(&app).join("settings.json");
            let _ = fs::remove_file(&sp);
            settings::init(&app);
            results.push(json!({ "id": id, "ok": true }));
        } else {
            results.push(json!({ "id": id, "ok": false, "error": "unknown issue" }));
        }
    }
    json!({ "ok": true, "results": results })
}

// MIDI 文件关联：reg.exe 写 HKCU ProgID（仅 Windows）
#[tauri::command]
pub fn file_assoc(app: AppHandle, enabled: bool) -> Value {
    if std::env::consts::OS != "windows" {
        return json!({ "ok": false, "reason": "unsupported" });
    }
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let prog_id = "FuFumidi.MIDI";
    let hkcu = "HKCU\\Software\\Classes";
    let run = |args: &[&str]| -> bool {
        std::process::Command::new("reg.exe")
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    };
    if enabled {
        run(&["add", &format!("{}\\{}\\shell\\open\\command", hkcu, prog_id), "/ve", "/d", &format!("\"{}\" \"%1\"", exe), "/f"]);
        run(&["add", &format!("{}\\{}\\DefaultIcon", hkcu, prog_id), "/ve", "/d", &format!("\"{}\",0", exe), "/f"]);
        run(&["add", &format!("{}\\.mid", hkcu), "/ve", "/d", prog_id, "/f"]);
        run(&["add", &format!("{}\\.midi", hkcu), "/ve", "/d", prog_id, "/f"]);
    } else {
        run(&["delete", &format!("{}\\.mid", hkcu), "/f"]);
        run(&["delete", &format!("{}\\.midi", hkcu), "/f"]);
        run(&["delete", &format!("{}\\{}", hkcu, prog_id), "/f"]);
    }
    json!({ "ok": true })
}

// 打开编辑指南（Tauri 版：打开前端内置页面路径）
#[tauri::command]
pub fn open_edit_guide(app: AppHandle) -> Value {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("renderer").join("edit-guide.html");
        if p.exists() {
            let _ = std::process::Command::new("cmd.exe")
                .args(["/C", "start", "", &p.to_string_lossy().to_string()])
                .spawn();
            return json!({ "ok": true });
        }
    }
    json!({ "ok": true })
}

// 通用事件通知（前端 app:event → 插件钩子，Tauri 阶段记录即可）
#[tauri::command]
pub fn notify(app: AppHandle, ev: String, payload: Option<Value>) -> Value {
    let _ = (app, ev, payload);
    json!({ "ok": true })
}
