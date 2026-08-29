// 持久化服务：KV / 歌曲 / 播放列表 —— 移植自 main/db.js（JSON 文件模式）
// Tauri 阶段使用 JSON 文件存储（sql.js 依赖后续再移植）
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub struct DbState {
    pub data: Mutex<Value>,
}

impl Default for DbState {
    fn default() -> Self {
        DbState {
            data: Mutex::new(json!({ "kv": {}, "songs": {}, "playlists": {} })),
        }
    }
}

fn db_file(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("fufumidi")
        .join("fufumidi-db.json")
}

fn load(app: &AppHandle, state: &DbState) -> Value {
    let p = db_file(app);
    let mut data = state.data.lock().unwrap();
    if data.get("kv").is_none() {
        let parsed = fs::read_to_string(&p)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok());
        *data = match parsed {
            Some(v) if v.is_object() => v,
            _ => json!({ "kv": {}, "songs": {}, "playlists": {} }),
        };
    }
    data.clone()
}

fn save(app: &AppHandle, state: &DbState, data: &Value) {
    let p = db_file(app);
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(s) = serde_json::to_string(data) {
        let _ = fs::write(&p, s);
    }
}

#[tauri::command]
pub fn db_status(app: AppHandle, state: tauri::State<'_, DbState>) -> Value {
    let p = db_file(&app);
    json!({ "ok": true, "mode": "json", "dbPath": null, "jsonPath": p.to_string_lossy() })
}

#[tauri::command]
pub fn db_kv_get(app: AppHandle, state: tauri::State<'_, DbState>, key: String) -> Value {
    let d = load(&app, &state);
    d["kv"][&key].clone()
}

#[tauri::command]
pub fn db_kv_set(app: AppHandle, state: tauri::State<'_, DbState>, key: String, value: Value) -> bool {
    let mut d = load(&app, &state);
    d["kv"][&key] = value;
    save(&app, &state, &d);
    true
}

#[tauri::command]
pub fn db_songs_list(app: AppHandle, state: tauri::State<'_, DbState>) -> Vec<Value> {
    let d = load(&app, &state);
    let mut out: Vec<Value> = d["songs"]
        .as_object()
        .map(|m| m.values().cloned().collect())
        .unwrap_or_default();
    out.sort_by(|a, b| {
        let ta = a["updated_at"].as_i64().unwrap_or(0);
        let tb = b["updated_at"].as_i64().unwrap_or(0);
        tb.cmp(&ta)
    });
    out
}

#[tauri::command]
pub fn db_songs_put(app: AppHandle, state: tauri::State<'_, DbState>, item: Value) -> bool {
    let id = item["id"].as_str().unwrap_or("").to_string();
    if id.is_empty() {
        return false;
    }
    let mut d = load(&app, &state);
    let mut entry = item.clone();
    if let Value::Object(m) = &mut entry {
        m.entry("updated_at".to_string())
            .or_insert_with(|| json!(chrono_now()));
        m.entry("name".to_string()).or_insert_with(|| {
            item["name"].clone()
        });
        m.entry("meta".to_string()).or_insert_with(|| json!({}));
    }
    d["songs"][&id] = entry;
    save(&app, &state, &d);
    true
}

#[tauri::command]
pub fn db_songs_delete(app: AppHandle, state: tauri::State<'_, DbState>, id: String) -> bool {
    let mut d = load(&app, &state);
    if let Value::Object(m) = &mut d["songs"] {
        m.remove(&id);
    }
    save(&app, &state, &d);
    true
}

#[tauri::command]
pub fn db_playlists_list(app: AppHandle, state: tauri::State<'_, DbState>) -> Vec<Value> {
    let d = load(&app, &state);
    d["playlists"]
        .as_object()
        .map(|m| m.values().cloned().collect())
        .unwrap_or_default()
}

#[tauri::command]
pub fn db_playlists_put(app: AppHandle, state: tauri::State<'_, DbState>, item: Value) -> bool {
    let id = item["id"].as_str().unwrap_or("").to_string();
    if id.is_empty() {
        return false;
    }
    let mut d = load(&app, &state);
    let mut entry = item.clone();
    if let Value::Object(m) = &mut entry {
        m.entry("name".to_string()).or_insert_with(|| {
            item["name"].clone()
        });
        m.entry("songIds".to_string()).or_insert_with(|| json!([]));
    }
    d["playlists"][&id] = entry;
    save(&app, &state, &d);
    true
}

// 时间戳（毫秒）：避免引入 chrono，用系统时间
fn chrono_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
