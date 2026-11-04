#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! FuFumidi Tauri 真正外壳（M1）。
//!
//! 边界（ADR-0002）：
//! - Rust：窗口/系统集成/host 业务/IPC 宿主；
//! - Python：**只做模型推理**，由 Rust 启动并管理，模型格式/路径不变；
//! - UI：现有 Vue renderer/dist 直接加载（frontend/src/bridge/tauri.js）。
//!
//! T-115 纵切（本文件）：app_version / load_settings / save_settings / db_kv_get / db_kv_set /
//! list_midi_files / read_binary / save_binary + host_info / python_selfcheck / ping。

use rusqlite::{params, Connection, OptionalExtension};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|p| p.to_path_buf())
}

/// 开发树根：**只在 debug 构建里用**。release 安装版必须只认 exe 旁/资源目录，
/// 否则开发机上的 CARGO_MANIFEST_DIR 会掩盖打包漏文件的问题（实测踩过）。
fn dev_root() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../").canonicalize()
            .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR"))))
    } else {
        None
    }
}

fn data_dir() -> PathBuf {
    if let Ok(p) = std::env::var("FUFUMIDI_DATA_ROOT") {
        if !p.trim().is_empty() {
            let pb = PathBuf::from(p);
            let _ = std::fs::create_dir_all(&pb);
            return pb;
        }
    }
    // 与 Electron 版数据根对齐：安装目录旁的 FuFumidiData（存在则用），否则 %APPDATA%/FuFumidi/FuFumidiData。
    if let Some(d) = exe_dir() {
        for c in [d.join("../FuFumidiData"), d.join("FuFumidiData")] {
            if c.is_dir() {
                let _ = std::fs::create_dir_all(&c);
                return c;
            }
        }
    }
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let pb = base.join("FuFumidi").join("FuFumidiData");
    let _ = std::fs::create_dir_all(&pb);
    pb
}

fn models_dir() -> PathBuf { data_dir().join("models") }

fn dir_size(p: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(p) else { return 0 };
    let mut total = 0u64;
    for e in rd.flatten() {
        let path = e.path();
        if path.is_dir() { total += dir_size(&path); }
        else if let Ok(m) = e.metadata() { total += m.len(); }
    }
    total
}

fn push_model(items: &mut Vec<serde_json::Value>, id: &str, name: &str, kind: &str, path: PathBuf, min_size: u64, note: &str) {
    let (exists, size) = if path.is_dir() {
        let s = dir_size(&path);
        (s >= min_size && s > 0, s)
    } else if let Ok(m) = std::fs::metadata(&path) {
        (m.len() >= min_size && m.len() > 0, m.len())
    } else {
        (false, 0)
    };
    items.push(serde_json::json!({
        "id": id, "name": name, "kind": kind, "path": path.display().to_string(),
        "size": size, "exists": exists, "downloadable": true, "note": note,
        "arch": "", "use": "", "runtime": ""
    }));
}

fn bundled_models_dir() -> Option<PathBuf> {
    let mut cands = Vec::new();
    if let Some(d) = dev_root() { cands.push(d.join("resources/models")); }
    if let Some(d) = exe_dir() {
        cands.push(d.join("models"));
        cands.push(d.join("resources/models"));
        cands.push(d.join("../resources/models"));
        cands.push(d.join("../models"));
    }
    cands.into_iter().find(|p| p.is_dir())
}

/// 模型列表（T-115/T-117 过渡实现）：核心条目 + 分离模型，占位字段与 Electron model:list 对齐。
/// 完整目录仍以 main/models.js 为准；这里保证 UI 能拿到 id/exists/kind，不再一律空态。
#[tauri::command]
fn model_list() -> Vec<serde_json::Value> {
    let dir = models_dir();
    let mut items = Vec::new();
    let basic_path = if dir.join("basic_pitch_quant.onnx").exists() {
        dir.join("basic_pitch_quant.onnx")
    } else if let Some(b) = bundled_models_dir() {
        b.join("basic_pitch_quant.onnx")
    } else {
        dir.join("basic_pitch_quant.onnx")
    };
    push_model(&mut items, "basic_pitch", "通用转录（int8 量化）", "transcribe", basic_path, 1000, "basic-pitch ONNX int8");
    push_model(&mut items, "piano_transcription", "钢琴转录模型", "transcribe", dir.join("piano_transcription/note_F1=0.9677_pedal_F1=0.9186.pth"), 1_000_000, "piano CRNN");
    push_model(&mut items, "hft_transformer", "hFT-Transformer", "transcribe", dir.join("hft_transformer"), 1_000_000, "Sony ISMIR2023");
    push_model(&mut items, "muscriptor_small", "MuScriptor Small", "transcribe", dir.join("muscriptor/small/model.safetensors"), 10_000_000, "103M");
    push_model(&mut items, "muscriptor_medium", "MuScriptor Medium", "transcribe", dir.join("muscriptor/medium/model.safetensors"), 100_000_000, "307M");
    push_model(&mut items, "muscriptor_large", "MuScriptor Large", "transcribe", dir.join("muscriptor/large/model.safetensors"), 500_000_000, "1.4B");
    push_model(&mut items, "yourmt3", "YourMT3+", "transcribe", dir.join("yourmt3"), 1_000_000, "YPTF");
    push_model(&mut items, "miros", "MIROS", "transcribe", dir.join("miros"), 1_000_000, "AMT 2025");
    push_model(&mut items, "aria_amt", "Aria-AMT", "transcribe", dir.join("aria_amt"), 1_000_000, "Whisper-style piano");
    push_model(&mut items, "beat_this", "Beat This!", "transcribe", dir.join("hub/checkpoints/beat_this-final0.ckpt"), 100_000, "beat grid");
    let tagger = if dir.join("audio-tagger").is_dir() { dir.join("audio-tagger") }
        else if let Some(b) = bundled_models_dir() { b.join("audio-tagger") }
        else { dir.join("audio-tagger") };
    push_model(&mut items, "audio_tagger", "Audio Tagger / CED", "transcribe", tagger, 100_000, "instrument tags");
    push_model(&mut items, "hnsep", "hnsep (Worldline v11)", "transcribe", dir.join("hnsep"), 100_000, "harmonic separation");
    push_model(&mut items, "htdemucs4_6stems", "HTDemucs4 6stems", "separate", dir.join("multi/htdemucs4_6stems"), 1_000_000, "6-stem separation");
    items
}

fn data_root_overridden() -> bool {
    std::env::var("FUFUMIDI_DATA_ROOT").map(|p| !p.trim().is_empty()).unwrap_or(false)
}

fn legacy_dir() -> Option<PathBuf> {
    std::env::var("APPDATA").ok().map(|a| PathBuf::from(a).join("FuFumidi").join("fufumidi"))
}

/// 设置文件：显式 env → 旧 Electron 位置的 settings.json（双构建共享）→ 当前数据根。
fn settings_path() -> PathBuf {
    if let Ok(p) = std::env::var("FUFUMIDI_SETTINGS_FILE") {
        if !p.trim().is_empty() { return PathBuf::from(p); }
    }
    if !data_root_overridden() {
        if let Some(d) = legacy_dir() {
            let p = d.join("settings.json");
            if p.exists() { return p; }
        }
    }
    data_dir().join("settings.json")
}

/// 数据库：显式 env → 旧 Electron 的 fufumidi.sqlite（双构建共享）→ 当前数据根。
fn db_path() -> PathBuf {
    if let Ok(p) = std::env::var("FUFUMIDI_DB_FILE") {
        if !p.trim().is_empty() { return PathBuf::from(p); }
    }
    if !data_root_overridden() {
        if let Some(d) = legacy_dir() {
            let p = d.join("fufumidi.sqlite");
            if p.exists() { return p; }
        }
    }
    data_dir().join("fufumidi.sqlite")
}

fn open_db() -> Result<Connection, String> {
    let p = db_path();
    if let Some(parent) = p.parent() { let _ = std::fs::create_dir_all(parent); }
    let conn = Connection::open(&p).map_err(|e| e.to_string())?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(2000));
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);\
         CREATE TABLE IF NOT EXISTS songs (id TEXT PRIMARY KEY, name TEXT, data TEXT, meta TEXT, updated_at INTEGER);\
         CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, name TEXT, song_ids TEXT);",
    ).map_err(|e| e.to_string())?;
    Ok(conn)
}

/// 查找 Python：显式 env > 安装版 resources/python > 开发树 resources/python。
fn python_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("FUFUMIDI_PYTHON") {
        let pb = PathBuf::from(p);
        if pb.exists() { return Some(pb); }
    }
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Some(d) = dev_root() {
        cands.push(d.join("resources/python/python.exe"));
    }
    if let Some(d) = exe_dir() {
        cands.push(d.join("python/python.exe"));
        cands.push(d.join("resources/python/python.exe"));
        cands.push(d.join("../resources/python/python.exe"));
    }
    cands.into_iter().find(|p| p.exists())
}

fn renderer_dir() -> PathBuf {
    if let Some(d) = dev_root() { d.join("renderer/dist") }
    else { exe_dir().unwrap_or_default().join("renderer/dist") }
}

fn host_info_json() -> serde_json::Value {
    let py = python_path();
    let renderer = renderer_dir();
    let renderer_on_disk = renderer.join("index.html").exists();
    let embedded = !cfg!(debug_assertions) && !renderer_on_disk;
    serde_json::json!({
        "ok": true,
        "product": "FuFumidi",
        "version": env!("CARGO_PKG_VERSION"),
        "mode": if cfg!(debug_assertions) { "debug" } else { "release" },
        "dataDir": data_dir().display().to_string(),
        "python": py.as_ref().map(|p| p.display().to_string()),
        "pythonExists": py.as_ref().map(|p| p.exists()).unwrap_or(false),
        "renderer": if embedded { "<embedded>".to_string() } else { renderer.display().to_string() },
        "rendererExists": renderer_on_disk || embedded,
    })
}

fn tail(s: &str, n: usize) -> String {
    let v: Vec<char> = s.chars().collect();
    v[v.len().saturating_sub(n)..].iter().collect()
}

fn read_json(path: &Path) -> serde_json::Value {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or(serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    }
}

fn write_json(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
fn host_info() -> serde_json::Value { host_info_json() }

#[tauri::command]
fn app_version() -> String { env!("CARGO_PKG_VERSION").to_string() }

#[tauri::command]
fn ping(payload: Option<serde_json::Value>) -> serde_json::Value {
    serde_json::json!({ "ok": true, "pong": true, "echo": payload.unwrap_or(serde_json::Value::Null) })
}

/// Python 只做推理：这里只验证解释器可启动，不替换模型/参数。
#[tauri::command]
fn python_selfcheck() -> serde_json::Value {
    let Some(py) = python_path() else {
        return serde_json::json!({ "ok": false, "error": "python runtime not found（检查 resources/python 或 FUFUMIDI_PYTHON）" });
    };
    match Command::new(&py).args(["-c", "import sys; print(sys.version.split()[0])"]).output() {
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
fn load_settings() -> serde_json::Value {
    read_json(&settings_path())
}

#[tauri::command]
fn save_settings(s: serde_json::Value) -> serde_json::Value {
    match write_json(&settings_path(), &s) {
        Ok(_) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
fn db_kv_get(key: String) -> serde_json::Value {
    let Ok(conn) = open_db() else { return serde_json::Value::Null };
    let raw: Option<String> = conn.query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| r.get(0)).optional().unwrap_or(None);
    match raw {
        Some(s) => serde_json::from_str(&s).unwrap_or(serde_json::Value::String(s)),
        None => serde_json::Value::Null,
    }
}

#[tauri::command]
fn db_kv_set(key: String, value: serde_json::Value) -> serde_json::Value {
    let Ok(conn) = open_db() else { return serde_json::json!({ "ok": false, "error": "db open failed" }) };
    let raw = serde_json::to_string(&value).unwrap_or_else(|_| "null".to_string());
    match conn.execute("INSERT INTO kv(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, raw]) {
        Ok(_) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

fn soundfont_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(d) = dev_root() { dirs.push(d.join("renderer/vendor/soundfonts")); }
    if let Some(d) = exe_dir() {
        dirs.push(d.join("soundfonts"));
        dirs.push(d.join("resources/soundfonts"));
        dirs.push(d.join("../resources/soundfonts"));
        dirs.push(d.join("../renderer/vendor/soundfonts"));
        dirs.push(d.join("../soundfonts"));
    }
    dirs.push(data_dir().join("soundfonts"));
    dirs
}

#[tauri::command]
fn soundfont_list() -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for dir in soundfont_dirs() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let Some(ext) = p.extension().and_then(|x| x.to_str()) else { continue };
            let ext = ext.to_ascii_lowercase();
            if ext != "sf2" && ext != "sf3" { continue; }
            let id = p.file_name().and_then(|x| x.to_str()).unwrap_or("").to_string();
            let name = p.file_stem().and_then(|x| x.to_str()).unwrap_or("").to_string();
            out.push(serde_json::json!({ "id": id, "name": name, "path": p.display().to_string() }));
        }
    }
    out
}

/// 依赖检查：Python 只做解释器/依赖自检（不是推理），返回 ###RESULT 里的 groups。
#[tauri::command]
fn dep_check() -> serde_json::Value {
    let Some(py) = python_path() else { return serde_json::json!({ "ok": false, "error": "python runtime not found" }); };
    let Some(eng) = engine_dir() else { return serde_json::json!({ "ok": false, "error": "engine directory not found" }); };
    let out = match Command::new(&py).current_dir(&eng).args(["deps.py", "check"]).output() {
        Ok(o) => o,
        Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let payload = stdout.lines().find_map(|l| l.trim().strip_prefix("###RESULT ").and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok()));
    match payload {
        Some(v) => serde_json::json!({ "ok": true, "result": v }),
        None => serde_json::json!({ "ok": false, "error": "deps.py produced no ###RESULT", "raw": tail(&String::from_utf8_lossy(&out.stderr), 400) }),
    }
}

#[tauri::command]
fn diag_export() -> serde_json::Value {
    let py = python_selfcheck();
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = data_dir().join(format!("diagnostics-{stamp}.json"));
    let payload = serde_json::json!({
        "generatedAt": stamp,
        "host": host_info_json(),
        "python": py,
        "models": model_list().into_iter().filter(|m| m.get("exists").and_then(|v| v.as_bool()).unwrap_or(false)).count(),
        "soundfonts": soundfont_list().len(),
        "dataDir": data_dir().display().to_string(),
    });
    match std::fs::write(&path, serde_json::to_string_pretty(&payload).unwrap_or_default()) {
        Ok(_) => serde_json::json!({ "ok": true, "path": path.display().to_string() }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command]
fn notify(_title: Option<String>, _body: Option<String>) -> serde_json::Value {
    // 系统通知插件尚未接入；命令先返回成功，避免 UI 报错（不伪造通知行为）。
    serde_json::json!({ "ok": true, "delivered": false })
}

#[tauri::command]
fn open_output(p: String) -> serde_json::Value {
    if p.trim().is_empty() || !Path::new(&p).exists() {
        return serde_json::json!({ "ok": false, "error": "path not found" });
    }
    #[cfg(target_os = "windows")]
    {
        match Command::new("explorer").arg(&p).spawn() {
            Ok(_) => serde_json::json!({ "ok": true }),
            Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
        }
    }
    #[cfg(not(target_os = "windows"))]
    { serde_json::json!({ "ok": false, "error": "unsupported platform" }) }
}

#[tauri::command]
fn open_external(url: String) -> serde_json::Value {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return serde_json::json!({ "ok": false, "error": "unsupported scheme" });
    }
    #[cfg(target_os = "windows")]
    {
        match Command::new("cmd").args(["/C", "start", "", u]).spawn() {
            Ok(_) => serde_json::json!({ "ok": true }),
            Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
        }
    }
    #[cfg(not(target_os = "windows"))]
    { serde_json::json!({ "ok": false, "error": "unsupported platform" }) }
}

fn presets_path() -> PathBuf { data_dir().join("presets.json") }

fn builtin_presets_json() -> serde_json::Value {
    serde_json::from_str(include_str!("builtin_presets.json")).unwrap_or_else(|_| serde_json::json!({ "presets": {}, "model_defaults": {} }))
}

fn preset_names(p: &serde_json::Value) -> Vec<String> {
    p.get("presets").and_then(|v| v.as_object()).map(|o| o.keys().cloned().collect()).unwrap_or_default()
}

#[tauri::command]
fn presets_list() -> serde_json::Value {
    let builtin = builtin_presets_json();
    let data = read_json(&presets_path());
    let hidden: Vec<String> = data.get("hidden_builtins").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
    let mut presets = serde_json::Map::new();
    if let Some(b) = builtin.get("presets").and_then(|v| v.as_object()) {
        for (k, v) in b {
            if !hidden.contains(k) { presets.insert(k.clone(), v.clone()); }
        }
    }
    if let Some(u) = data.get("presets").and_then(|v| v.as_object()) {
        for (k, v) in u { presets.insert(k.clone(), v.clone()); }
    }
    let mut last = data.get("last_used").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if !presets.contains_key(&last) { last.clear(); }
    let names: Vec<String> = presets.keys().cloned().collect();
    let model_defaults = builtin.get("model_defaults").cloned().unwrap_or_else(|| serde_json::json!({}));
    let model_preset = data.get("model_preset").cloned().unwrap_or_else(|| serde_json::json!({}));
    serde_json::json!({
        "ok": true, "presets": presets, "last_used": last, "builtins": names,
        "model_defaults": model_defaults, "model_preset": model_preset,
    })
}

fn preset_builtin_name(name: &str) -> bool {
    builtin_presets_json().get("presets").and_then(|v| v.as_object()).map(|o| o.contains_key(name)).unwrap_or(false)
}

#[tauri::command]
fn presets_save(req: serde_json::Value) -> serde_json::Value {
    let name = req.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if name.is_empty() { return serde_json::json!({ "ok": false, "error": "empty name" }); }
    let mode = req.get("mode").cloned().unwrap_or(serde_json::json!("universal"));
    let params = req.get("params").cloned().unwrap_or_else(|| serde_json::json!({}));
    let mut data = read_json(&presets_path());
    if !data.is_object() { data = serde_json::json!({}); }
    let obj = data.as_object_mut().unwrap();
    let presets = obj.entry("presets").or_insert_with(|| serde_json::json!({}));
    if !presets.is_object() { *presets = serde_json::json!({}); }
    presets.as_object_mut().unwrap().insert(name.clone(), serde_json::json!({ "mode": mode, "params": params }));
    obj.insert("last_used".to_string(), serde_json::json!(name));
    match write_json(&presets_path(), &data) {
        Ok(_) => serde_json::json!({ "ok": true, "saved": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
fn presets_delete(name: String) -> serde_json::Value {
    let name = name.trim().to_string();
    if name.is_empty() { return serde_json::json!({ "ok": false, "deleted": false }); }
    let mut data = read_json(&presets_path());
    if !data.is_object() { data = serde_json::json!({}); }
    let builtin = preset_builtin_name(&name);
    let mut deleted = false;
    if builtin {
        let obj = data.as_object_mut().unwrap();
        let hidden = obj.entry("hidden_builtins").or_insert_with(|| serde_json::json!([]));
        let arr = hidden.as_array_mut().unwrap();
        if !arr.iter().any(|x| x.as_str() == Some(name.as_str())) { arr.push(serde_json::json!(name)); }
        if let Some(p) = obj.get_mut("presets").and_then(|v| v.as_object_mut()) { p.remove(&name); }
        deleted = true;
    } else if let Some(p) = data.get_mut("presets").and_then(|v| v.as_object_mut()) {
        deleted = p.remove(&name).is_some();
    }
    if let Some(order) = data.get_mut("order").and_then(|v| v.as_array_mut()) { order.retain(|x| x.as_str() != Some(name.as_str())); }
    if let Some(m) = data.get_mut("model_preset").and_then(|v| v.as_object_mut()) { m.retain(|_k, v| v.as_str() != Some(name.as_str())); }
    let _ = write_json(&presets_path(), &data);
    serde_json::json!({ "ok": true, "deleted": deleted })
}

#[tauri::command]
fn presets_last_used(name: String) -> serde_json::Value {
    let mut data = read_json(&presets_path());
    if !data.is_object() { data = serde_json::json!({}); }
    data.as_object_mut().unwrap().insert("last_used".to_string(), serde_json::json!(name));
    let _ = write_json(&presets_path(), &data);
    serde_json::json!({ "ok": true })
}

#[tauri::command]
fn presets_set_model(key: String, name: String) -> serde_json::Value {
    let mut data = read_json(&presets_path());
    if !data.is_object() { data = serde_json::json!({}); }
    let m = data.as_object_mut().unwrap().entry("model_preset").or_insert_with(|| serde_json::json!({}));
    if !m.is_object() { *m = serde_json::json!({}); }
    let map = m.as_object_mut().unwrap();
    if name.trim().is_empty() { map.remove(&key); } else { map.insert(key, serde_json::json!(name.trim())); }
    let _ = write_json(&presets_path(), &data);
    let mp = data.get("model_preset").cloned().unwrap_or_else(|| serde_json::json!({}));
    serde_json::json!({ "ok": true, "saved": true, "model_preset": mp })
}

fn presets_reorder_impl(name: String, target: usize) -> serde_json::Value {
    let mut data = read_json(&presets_path());
    if !data.is_object() { data = serde_json::json!({}); }
    let mut names = {
        let list = presets_list();
        preset_names(&list)
    };
    if let Some(pos) = names.iter().position(|x| x == &name) { names.remove(pos); }
    let idx = target.min(names.len());
    names.insert(idx, name);
    data.as_object_mut().unwrap().insert("order".to_string(), serde_json::json!(names));
    let _ = write_json(&presets_path(), &data);
    let data = read_json(&presets_path());
    let order = data.get("order").cloned().unwrap_or_else(|| serde_json::json!([]));
    serde_json::json!({ "ok": true, "order": order })
}

#[tauri::command]
fn presets_reorder(name: String, delta: i64) -> serde_json::Value {
    let names = preset_names(&presets_list());
    let cur = names.iter().position(|x| x == &name).unwrap_or(0) as i64;
    let target = (cur + delta).max(0) as usize;
    presets_reorder_impl(name, target)
}

#[tauri::command]
fn presets_reorder_to(name: String, index: i64) -> serde_json::Value {
    presets_reorder_impl(name, index.max(0) as usize)
}

#[tauri::command]
fn presets_restore() -> serde_json::Value {
    let mut data = read_json(&presets_path());
    if !data.is_object() { data = serde_json::json!({}); }
    let obj = data.as_object_mut().unwrap();
    obj.insert("hidden_builtins".to_string(), serde_json::json!([]));
    obj.insert("order".to_string(), serde_json::Value::Null);
    match write_json(&presets_path(), &data) {
        Ok(_) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

fn midi_root() -> PathBuf { data_dir().join("midi") }

/// 与 Electron library:checkMidi 同语义：只认数据根 midi/ 内、非空文件；丢失的返回给前端重建。
fn check_midi_items(items: &[serde_json::Value], root: &Path) -> serde_json::Value {
    let root_canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut missing = Vec::new();
    for it in items {
        let id = it.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if id.is_empty() { continue; }
        let name = it.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let p = it.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let mut exists = false;
        if !p.is_empty() {
            if let Ok(c) = PathBuf::from(p).canonicalize() {
                if c.starts_with(&root_canon) {
                    if let Ok(m) = std::fs::metadata(&c) {
                        exists = m.is_file() && m.len() > 0;
                    }
                }
            }
        }
        if !exists { missing.push(serde_json::json!({ "id": id, "name": name })); }
    }
    serde_json::json!({ "ok": true, "missing": missing, "root": root.display().to_string() })
}

#[tauri::command]
fn check_midi(items: Vec<serde_json::Value>) -> serde_json::Value {
    check_midi_items(&items, &midi_root())
}

#[tauri::command]
fn db_status() -> serde_json::Value {
    let counts = open_db().ok().map(|conn| {
        let songs: i64 = conn.query_row("SELECT COUNT(*) FROM songs", [], |r| r.get(0)).unwrap_or(0);
        let playlists: i64 = conn.query_row("SELECT COUNT(*) FROM playlists", [], |r| r.get(0)).unwrap_or(0);
        (songs, playlists)
    });
    let (songs, playlists) = counts.unwrap_or((0, 0));
    serde_json::json!({
        "ok": true,
        "kind": "sqlite",
        "db": db_path().display().to_string(),
        "dataDir": data_dir().display().to_string(),
        "songs": songs,
        "playlists": playlists,
    })
}

#[tauri::command]
fn db_songs_list() -> Vec<serde_json::Value> {
    let Ok(conn) = open_db() else { return Vec::new() };
    let Ok(mut stmt) = conn.prepare("SELECT data FROM songs ORDER BY updated_at DESC") else { return Vec::new() };
    let rows = stmt.query_map([], |r| r.get::<_, String>(0));
    match rows {
        Ok(it) => it.flatten().filter_map(|s| serde_json::from_str::<serde_json::Value>(&s).ok()).collect(),
        Err(_) => Vec::new(),
    }
}

#[tauri::command]
fn db_songs_put(item: serde_json::Value) -> bool {
    let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if id.is_empty() { return false; }
    let Ok(conn) = open_db() else { return false };
    let data = serde_json::to_string(&item).unwrap_or_else(|_| "{}".to_string());
    let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let meta = item.get("meta").cloned().unwrap_or_else(|| serde_json::json!({})).to_string();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    conn.execute(
        "INSERT INTO songs(id,name,data,meta,updated_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data,meta=excluded.meta,updated_at=excluded.updated_at",
        params![id, name, data, meta, now],
    ).is_ok()
}

#[tauri::command]
fn db_songs_delete(id: String) -> bool {
    open_db().map(|conn| conn.execute("DELETE FROM songs WHERE id = ?1", params![id]).is_ok()).unwrap_or(false)
}

#[tauri::command]
fn db_playlists_list() -> Vec<serde_json::Value> {
    let Ok(conn) = open_db() else { return Vec::new() };
    let Ok(mut stmt) = conn.prepare("SELECT id,name,song_ids FROM playlists") else { return Vec::new() };
    let rows = stmt.query_map([], |r| {
        let id: String = r.get(0)?;
        let name: String = r.get(1).unwrap_or_default();
        let ids: String = r.get(2).unwrap_or_else(|_| "[]".to_string());
        Ok(serde_json::json!({ "id": id, "name": name, "songIds": serde_json::from_str::<serde_json::Value>(&ids).unwrap_or_else(|_| serde_json::json!([])) }))
    });
    match rows { Ok(it) => it.flatten().collect(), Err(_) => Vec::new() }
}

#[tauri::command]
fn db_playlists_put(item: serde_json::Value) -> bool {
    let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if id.is_empty() { return false; }
    let Ok(conn) = open_db() else { return false };
    let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let ids = item.get("songIds").cloned().unwrap_or_else(|| serde_json::json!([])).to_string();
    conn.execute(
        "INSERT INTO playlists(id,name,song_ids) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET name=excluded.name,song_ids=excluded.song_ids",
        params![id, name, ids],
    ).is_ok()
}

#[tauri::command]
fn list_midi_files(dir: String) -> Vec<String> {
    fn walk(d: &Path, out: &mut Vec<String>, depth: usize) {
        if out.len() >= 2000 || depth > 8 { return; }
        let Ok(rd) = std::fs::read_dir(d) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out, depth + 1);
            } else if let Some(ext) = p.extension().and_then(|x| x.to_str()) {
                let ext = ext.to_ascii_lowercase();
                if ext == "mid" || ext == "midi" || ext == "kar" || ext == "rmi" {
                    out.push(p.display().to_string());
                    if out.len() >= 2000 { return; }
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(Path::new(&dir), &mut out, 0);
    out
}

fn engine_dir() -> Option<PathBuf> {
    let mut cands = Vec::new();
    if let Some(d) = dev_root() { cands.push(d.join("engine")); }
    if let Some(d) = exe_dir() {
        cands.push(d.join("resources/engine"));
        cands.push(d.join("../resources/engine"));
        cands.push(d.join("engine"));
        cands.push(d.join("../engine"));
    }
    cands.into_iter().find(|p| p.join("music2midi.py").exists())
}

/// T-118 第一步：Rust 启动 Python 推理进程做一次真实 probe（不是 mock）。
/// 返回耗时 + Python 版本 + probe JSON（stdout 最后一段 JSON）。模型/参数契约不变。
#[tauri::command]
fn engine_probe() -> serde_json::Value {
    let Some(py) = python_path() else {
        return serde_json::json!({ "ok": false, "error": "python runtime not found" });
    };
    let Some(eng) = engine_dir() else {
        return serde_json::json!({ "ok": false, "error": "engine/music2midi.py not found" });
    };
    let started = std::time::Instant::now();
    let out = match Command::new(&py)
        .current_dir(&eng)
        .env("FUFUMIDI_DATA_DIR", data_dir())
        .env("FUFUMIDI_MODELS_DIR", models_dir())
        .env("TORCH_HOME", models_dir())
        .envs(bundled_models_dir().map(|p| ("FUFUMIDI_MODELS_BUNDLED_DIR", p)).into_iter().collect::<std::collections::HashMap<_, _>>())
        .args(["music2midi.py", "probe"])
        .output()
    {
        Ok(o) => o,
        Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }),
    };
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let probe = stdout
        .find('{')
        .and_then(|i| serde_json::from_str::<serde_json::Value>(&stdout[i..]).ok());
    serde_json::json!({
        "ok": out.status.success() && probe.is_some(),
        "python": py.display().to_string(),
        "engine": eng.display().to_string(),
        "elapsedMs": elapsed_ms,
        "probe": probe,
        "stderrTail": stderr.chars().rev().take(400).collect::<String>().chars().rev().collect::<String>(),
    })
}

#[tauri::command]
fn read_binary(p: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&p)
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn save_binary(opts: serde_json::Value) -> serde_json::Value {
    let path = opts.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if path.is_empty() {
        return serde_json::json!({ "ok": false, "error": "missing path" });
    }
    let bytes: Vec<u8> = match opts.get("bytes") {
        Some(serde_json::Value::Array(a)) => a.iter().map(|x| x.as_u64().unwrap_or(0) as u8).collect(),
        Some(serde_json::Value::String(s)) => s.as_bytes().to_vec(),
        _ => return serde_json::json!({ "ok": false, "error": "missing bytes" }),
    };
    match std::fs::write(&path, bytes) {
        Ok(_) => serde_json::json!({ "ok": true, "path": path }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

/* ---------------- T-118：常驻 Python 推理 worker（stdin JSON / stdout ###LOG|###PROG|###RESULT） ---------------- */

struct Worker {
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
    seq: u64,
}

struct WorkerState(Arc<Mutex<Option<Worker>>>, Arc<AtomicBool>, Arc<AtomicU32>);

fn pause_file() -> PathBuf { data_dir().join("engine.pause") }

fn file_path_string(p: tauri_plugin_dialog::FilePath) -> Option<String> {
    p.into_path().ok().map(|x| x.display().to_string())
}

#[tauri::command]
fn pick_file(app: AppHandle, opts: Option<serde_json::Value>) -> Option<String> {
    let mut b = app.dialog().file();
    if let Some(o) = opts.as_ref().and_then(|v| v.as_object()) {
        if let Some(t) = o.get("title").and_then(|v| v.as_str()) { if !t.is_empty() { b = b.set_title(t); } }
        if let Some(p) = o.get("defaultPath").and_then(|v| v.as_str()) { if !p.is_empty() { b = b.set_directory(p); } }
        if let Some(filters) = o.get("filters").and_then(|v| v.as_array()) {
            for f in filters {
                let name = f.get("name").and_then(|v| v.as_str()).unwrap_or("Files");
                let exts: Vec<String> = f.get("extensions").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.trim_start_matches('.').to_string())).collect()).unwrap_or_default();
                if !exts.is_empty() {
                    let refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
                    b = b.add_filter(name, &refs);
                }
            }
        }
    }
    b.blocking_pick_file().and_then(file_path_string)
}

#[tauri::command]
fn pick_directory(app: AppHandle) -> Option<String> {
    app.dialog().file().blocking_pick_folder().and_then(file_path_string)
}

#[tauri::command]
fn pick_audio(app: AppHandle) -> Option<String> {
    app.dialog().file().add_filter("Audio", &["mp3", "wav", "flac", "ogg", "m4a", "aac", "wma", "aiff", "aif", "opus", "mp4", "mkv", "webm"]).blocking_pick_file().and_then(file_path_string)
}

#[tauri::command]
fn pick_audio_files(app: AppHandle) -> Option<Vec<String>> {
    app.dialog().file().add_filter("Audio", &["mp3", "wav", "flac", "ogg", "m4a", "aac", "wma", "aiff", "aif", "opus", "mp4", "mkv", "webm"]).blocking_pick_files().map(|v| v.into_iter().filter_map(file_path_string).collect())
}

#[tauri::command]
fn pick_image(app: AppHandle) -> Option<String> {
    app.dialog().file().add_filter("Images", &["png", "jpg", "jpeg", "webp", "gif", "bmp"]).blocking_pick_file().and_then(file_path_string)
}

#[tauri::command]
fn pick_music_xml(app: AppHandle) -> Option<String> {
    app.dialog().file().add_filter("MusicXML", &["xml", "mxl", "musicxml"]).blocking_pick_file().and_then(file_path_string)
}

fn spawn_worker() -> Result<Worker, String> {
    let py = python_path().ok_or("python runtime not found")?;
    let eng = engine_dir().ok_or("engine/music2midi.py not found")?;
    let mut child = Command::new(&py)
        .current_dir(&eng)
        .args(["music2midi.py", "worker"])
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .env("FUFUMIDI_PAUSE_FILE", pause_file())
        .env("FUFUMIDI_DATA_DIR", data_dir())
        .env("FUFUMIDI_MODELS_DIR", models_dir())
        .env("TORCH_HOME", models_dir())
        .envs(bundled_models_dir().map(|p| ("FUFUMIDI_MODELS_BUNDLED_DIR", p)).into_iter().collect::<std::collections::HashMap<_, _>>())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdin = child.stdin.take().ok_or("worker stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("worker stdout unavailable")?;
    Ok(Worker { child, stdin, reader: BufReader::new(stdout), seq: 0 })
}

fn stop_worker(state: &Arc<Mutex<Option<Worker>>>) {
    if let Ok(mut g) = state.lock() {
        if let Some(mut w) = g.take() {
            let _ = w.stdin.write_all(b"{\"cmd\":\"exit\"}\n");
            let _ = w.stdin.flush();
            let _ = w.child.kill();
        }
    }
}

/// 把一次转录请求交给常驻 worker。模型/参数契约与 Electron 路径一致（req 原样转发）。
/// 进度/日志通过 Tauri 事件 engine:log / engine:progress 推给前端。
fn run_convert(state: Arc<Mutex<Option<Worker>>>, cancel: Arc<AtomicBool>, pid_slot: Arc<AtomicU32>, app: AppHandle, req: serde_json::Value) -> serde_json::Value {
    let started = std::time::Instant::now();
    cancel.store(false, Ordering::SeqCst);
    let mut guard = match state.lock() {
        Ok(g) => g,
        Err(_) => return serde_json::json!({ "ok": false, "error": "worker state poisoned" }),
    };
    if guard.is_none() {
        match spawn_worker() {
            Ok(w) => *guard = Some(w),
            Err(e) => return serde_json::json!({ "ok": false, "error": e }),
        }
    }
    let w = guard.as_mut().unwrap();
    pid_slot.store(w.child.id(), Ordering::SeqCst);
    if let Ok(Some(_)) = w.child.try_wait() {
        *guard = None;
        return serde_json::json!({ "ok": false, "error": "engine worker exited; retry restarts it" });
    }
    w.seq += 1;
    let id = w.seq;
    let mut payload = req;
    if let Some(o) = payload.as_object_mut() {
        o.insert("_id".to_string(), serde_json::json!(id));
    }
    let line = format!("{}\n", payload);
    if let Err(e) = w.stdin.write_all(line.as_bytes()).and_then(|_| w.stdin.flush()) {
        *guard = None;
        return serde_json::json!({ "ok": false, "error": format!("worker write failed: {e}") });
    }
    let mut logs: Vec<String> = Vec::new();
    loop {
        let mut buf = String::new();
        match w.reader.read_line(&mut buf) {
            Ok(0) => {
                let _ = w.child.kill();
                *guard = None;
                pid_slot.store(0, Ordering::SeqCst);
                if cancel.load(Ordering::SeqCst) {
                    return serde_json::json!({ "ok": false, "canceled": true, "error": "canceled" });
                }
                return serde_json::json!({ "ok": false, "error": "engine worker closed" });
            }
            Ok(_) => {}
            Err(e) => {
                *guard = None;
                return serde_json::json!({ "ok": false, "error": format!("worker read failed: {e}") });
            }
        }
        let t = buf.trim();
        if t.is_empty() { continue; }
        if cancel.load(Ordering::SeqCst) {
            let _ = w.child.kill();
            *guard = None;
            pid_slot.store(0, Ordering::SeqCst);
            return serde_json::json!({ "ok": false, "canceled": true, "error": "canceled" });
        }
        if let Some(rest) = t.strip_prefix("###RESULT ") {
            if let Ok(mut r) = serde_json::from_str::<serde_json::Value>(rest) {
                let rid = r.get("_id").and_then(|v| v.as_u64()).or_else(|| r.get("id").and_then(|v| v.as_u64()));
                if rid == Some(id) {
                    if let Some(o) = r.as_object_mut() {
                        o.insert("elapsedMs".to_string(), serde_json::json!(started.elapsed().as_millis() as u64));
                        o.insert("workerSeq".to_string(), serde_json::json!(id));
                        o.insert("logLines".to_string(), serde_json::json!(logs.len()));
                    }
                    return r;
                }
            }
            continue;
        }
        if let Some(rest) = t.strip_prefix("###LOG ") {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(rest) {
                let s = v.get("line").and_then(|x| x.as_str()).unwrap_or("").to_string();
                if logs.len() < 200 { logs.push(s.clone()); }
                let _ = app.emit("engine:log", serde_json::json!({ "id": id, "line": s }));
            }
            continue;
        }
        if let Some(rest) = t.strip_prefix("###PROG ") {
            if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(rest) {
                if let Some(o) = v.as_object_mut() { o.insert("id".to_string(), serde_json::json!(id)); }
                let _ = app.emit("engine:progress", v);
            }
            continue;
        }
        if logs.len() < 200 { logs.push(t.to_string()); }
    }
}

#[tauri::command]
async fn convert(state: State<'_, WorkerState>, app: AppHandle, req: serde_json::Value) -> Result<serde_json::Value, String> {
    let arc = state.0.clone();
    let cancel = state.1.clone();
    let pid = state.2.clone();
    tauri::async_runtime::spawn_blocking(move || run_convert(arc, cancel, pid, app, req))
        .await
        .map_err(|e| e.to_string())
}

/// 暂停/继续：引擎 pause_gate 监听文件是否存在；继续后从原处接着跑（不改协议）。
#[tauri::command]
fn set_transcribe_pause(on: bool) -> serde_json::Value {
    let f = pause_file();
    if on {
        match std::fs::write(&f, b"1") {
            Ok(_) => serde_json::json!({ "ok": true, "paused": true, "file": f.display().to_string() }),
            Err(e) => serde_json::json!({ "ok": false, "paused": false, "error": e.to_string() }),
        }
    } else {
        let _ = std::fs::remove_file(&f);
        serde_json::json!({ "ok": true, "paused": false, "file": f.display().to_string() })
    }
}

/// 取消当前转录：置标志 + taskkill 掉 worker；阻塞中的读会返回 EOF，convert 识别为 canceled。
/// 下一次 convert 会重新拉起 worker（模型冷启动由用户可见日志承担）。
#[tauri::command]
fn cancel(state: State<'_, WorkerState>, id: Option<String>) -> serde_json::Value {
    state.1.store(true, Ordering::SeqCst);
    let pid = state.2.load(Ordering::SeqCst);
    if pid == 0 {
        return serde_json::json!({ "ok": false, "canceled": false, "error": "no running worker", "id": id });
    }
    #[cfg(target_os = "windows")]
    {
        match Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output() {
            Ok(_) => serde_json::json!({ "ok": true, "canceled": true, "pid": pid, "id": id }),
            Err(e) => serde_json::json!({ "ok": false, "canceled": false, "error": e.to_string(), "id": id }),
        }
    }
    #[cfg(not(target_os = "windows"))]
    { serde_json::json!({ "ok": false, "canceled": false, "error": "unsupported platform", "id": id }) }
}

#[tauri::command]
fn engine_worker_status(state: State<'_, WorkerState>) -> serde_json::Value {
    let mut g = match state.0.lock() {
        Ok(g) => g,
        Err(_) => return serde_json::json!({ "ok": false, "error": "worker state poisoned" }),
    };
    match g.as_mut() {
        Some(w) => {
            let alive = w.child.try_wait().map(|s| s.is_none()).unwrap_or(false);
            serde_json::json!({ "ok": true, "running": alive, "pid": w.child.id(), "seq": w.seq })
        }
        None => serde_json::json!({ "ok": true, "running": false, "seq": 0 }),
    }
}

fn main() {
    if std::env::args().any(|a| a == "--self-check") {
        println!("{}", serde_json::to_string_pretty(&host_info_json()).unwrap_or_default());
        return;
    }
    let state = WorkerState(Arc::new(Mutex::new(None)), Arc::new(AtomicBool::new(false)), Arc::new(AtomicU32::new(0)));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            host_info, app_version, ping, python_selfcheck, engine_probe,
            load_settings, save_settings, db_kv_get, db_kv_set,
            db_status, db_songs_list, db_songs_put, db_songs_delete, db_playlists_list, db_playlists_put, check_midi, model_list,
            soundfont_list, dep_check, diag_export, notify, open_output, open_external,
            presets_list, presets_save, presets_delete, presets_last_used, presets_set_model,
            presets_reorder, presets_reorder_to, presets_restore,
            pick_file, pick_directory, pick_audio, pick_audio_files, pick_image, pick_music_xml,
            list_midi_files, read_binary, save_binary,
            convert, cancel, set_transcribe_pause, engine_worker_status
        ])
        .setup(|_app| {
            println!("[fufumidi-shell] {}", serde_json::to_string(&host_info_json()).unwrap_or_default());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building FuFumidi Tauri shell");
    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(st) = app_handle.try_state::<WorkerState>() {
                stop_worker(&st.0);
            }
        }
    });
}

#[cfg(test)]
mod check_midi_tests {
    use super::check_midi_items;

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("fufumidi-checkmidi-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn missing_and_present_items() {
        let root = tmpdir("shape");
        let good = root.join("a.mid");
        std::fs::write(&good, b"MThd").unwrap();
        let outside = std::env::temp_dir().join(format!("fufumidi-outside-{}.mid", std::process::id()));
        std::fs::write(&outside, b"MThd").unwrap();
        let items = vec![
            serde_json::json!({ "id": "a", "name": "A", "path": good.display().to_string() }),
            serde_json::json!({ "id": "b", "name": "B", "path": root.join("nope.mid").display().to_string() }),
            serde_json::json!({ "id": "c", "name": "C", "path": outside.display().to_string() }),
        ];
        let v = check_midi_items(&items, &root);
        assert_eq!(v["ok"], true);
        let missing = v["missing"].as_array().unwrap();
        assert_eq!(missing.len(), 2);
        assert!(missing.iter().any(|x| x["id"] == "b"));
        assert!(missing.iter().any(|x| x["id"] == "c"), "outside root is missing");
        let _ = std::fs::remove_file(outside);
        let _ = std::fs::remove_dir_all(root);
    }
}
