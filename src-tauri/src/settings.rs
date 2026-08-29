// 设置持久化（settings.json，userData/fufumidi 目录）——移植自 main/settings.js
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const DEFAULT_SETTINGS: &str = r#"{
  "theme": "fufu",
  "accent": "",
  "ui_mode": "light",
  "font_size": "standard",
  "density": "comfortable",
  "perf_mode": "quality",
  "engine_path": "",
  "engine_mode": "universal",
  "output_dir": "",
  "guide_done": false,
  "advanced_mode": false,
  "custom_wallpaper": "",
  "wallpaper_prompt_done": false,
  "wallpaper_enabled": false,
  "transcribe_params": {},
  "plugins_enabled": [],
  "lang": "zh",
  "hf_token": ""
}"#;

pub fn settings_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("fufumidi");
    dir.join("settings.json")
}

pub fn init(app: &AppHandle) {
    let p = settings_path(app);
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if !p.exists() {
        let _ = fs::write(&p, DEFAULT_SETTINGS);
    }
}

pub fn read_settings(app: &AppHandle) -> Value {
    let p = settings_path(app);
    let raw = fs::read_to_string(&p).unwrap_or_default();
    match serde_json::from_str::<Value>(&raw) {
        Ok(v) => {
            // 与默认值合并，缺字段用默认
            let def: Value = serde_json::from_str(DEFAULT_SETTINGS).unwrap_or(Value::Null);
            if let (Value::Object(mut m), Value::Object(d)) = (v, def) {
                for (k, dv) in d {
                    m.entry(k).or_insert(dv);
                }
                Value::Object(m)
            } else {
                json!({})
            }
        }
        Err(_) => {
            let def: Value = serde_json::from_str(DEFAULT_SETTINGS).unwrap_or(Value::Null);
            def
        }
    }
}

fn write_settings(app: &AppHandle, s: &Value) {
    let p = settings_path(app);
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(s) = serde_json::to_string_pretty(s) {
        let _ = fs::write(&p, s);
    }
}

// 命令：加载设置
#[tauri::command]
pub fn load_settings(app: AppHandle) -> Value {
    read_settings(&app)
}

// 命令：保存设置（浅合并）
#[tauri::command]
pub fn save_settings(app: AppHandle, s: Value) -> Value {
    let cur = read_settings(&app);
    let merged = merge_json(cur, s);
    write_settings(&app, &merged);
    json!({ "ok": true, "settings": read_settings(&app) })
}

fn merge_json(a: Value, b: Value) -> Value {
    match (a, b) {
        (Value::Object(mut m1), Value::Object(m2)) => {
            for (k, v2) in m2 {
                match m1.get(&k) {
                    Some(Value::Object(_)) if v2.is_object() => {
                        let merged = merge_json(m1.remove(&k).unwrap(), v2);
                        m1.insert(k, merged);
                    }
                    _ => {
                        m1.insert(k, v2);
                    }
                }
            }
            Value::Object(m1)
        }
        (_, b) => b,
    }
}
