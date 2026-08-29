// 诊断服务：运行期依赖检查 / 安装 / 诊断包导出 —— 移植自 main/diagnostics.js
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::engine::run_engine_script;

// 依赖检查：python deps.py check
#[tauri::command]
pub fn dep_check(app: AppHandle) -> Value {
    let r = run_engine_script(&app, "deps.py", &["check".to_string()]);
    json!({
        "ok": r["ok"].as_bool().unwrap_or(false),
        "result": r["result"].clone(),
        "raw": r["out"].as_str().unwrap_or("").to_string(),
    })
}

#[tauri::command]
pub fn dep_install(app: AppHandle, group: Option<String>) -> Value {
    let g = group.unwrap_or_else(|| "all".into());
    let r = run_engine_script(&app, "deps.py", &["install".to_string(), "--group".to_string(), g]);
    json!({
        "ok": r["ok"].as_bool().unwrap_or(false),
        "result": r["result"].clone(),
        "raw": r["out"].as_str().unwrap_or("").to_string(),
    })
}

// 诊断包导出：python diag.py -o <path>
#[tauri::command]
pub async fn diag_export(app: AppHandle, window: tauri::WebviewWindow) -> Value {
    let saved = window
        .dialog()
        .file()
        .add_filter("ZIP", &["zip"])
        .set_file_name("fufumidi-diagnostic.zip")
        .blocking_save_file();
    let out_path = match saved.and_then(|f| f.into_path().ok()) {
        Some(p) => p,
        None => return json!({ "ok": false, "canceled": true }),
    };
    let out = out_path.to_string_lossy().to_string();
    let r = run_engine_script(&app, "diag.py", &["-o".to_string(), out.clone()]);
    if r["ok"].as_bool().unwrap_or(false) {
        json!({ "ok": true, "path": out })
    } else {
        let err = r["err"].as_str().unwrap_or("").to_string();
        json!({ "ok": false, "path": out, "error": err })
    }
}
