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
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
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
fn notify(ev: Option<String>, payload: Option<serde_json::Value>) -> serde_json::Value {
    // 系统通知插件尚未接入；命令先返回成功，避免 UI 报错（不伪造通知行为）。
    let _ = (ev, payload);
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

fn refine_args(req: &serde_json::Value, out: &str) -> Vec<String> {
    let mut args = vec!["refine".to_string(), "--audio".into(), req.get("audio").and_then(|v| v.as_str()).unwrap_or("").into(), "--midi".into(), req.get("midi").and_then(|v| v.as_str()).unwrap_or("").into(), "-o".into(), out.to_string()];
    if let Some(m) = req.get("mode").and_then(|v| v.as_str()) { if !m.is_empty() { args.push("--mode".into()); args.push(m.to_string()); } }
    if let Some(b) = req.get("stemBalance") { args.push("--stem-balance".into()); args.push(if b.as_bool().unwrap_or(false) { "on" } else { "off" }.into()); }
    for (key, flag) in [("onsetWin", "--onset-win"), ("offsetWin", "--offset-win"), ("velStrength", "--vel-strength"), ("minNoteMs", "--min-note-ms")] {
        if let Some(v) = req.get(key) { if let Some(n) = v.as_f64() { args.push(flag.into()); args.push(n.to_string()); } }
    }
    for (key, flag) in [("pitchCheck", "--pitch-check"), ("quantize", "--quantize")] {
        if let Some(b) = req.get(key).and_then(|v| v.as_bool()) { args.push(flag.into()); args.push(if b { "on" } else { "off" }.into()); }
    }
    args
}

fn run_refine(app: AppHandle, req: serde_json::Value) -> serde_json::Value {
    let audio = req.get("audio").and_then(|v| v.as_str()).unwrap_or("");
    let midi = req.get("midi").and_then(|v| v.as_str()).unwrap_or("");
    if audio.is_empty() || midi.is_empty() || !Path::new(audio).is_file() || !Path::new(midi).is_file() {
        return serde_json::json!({ "ok": false, "error": "缺少输入：需要原始音频与转录 MIDI 路径" });
    }
    let id = req.get("id").cloned().unwrap_or(serde_json::Value::Null);
    let out = if let Some(o) = req.get("out").and_then(|v| v.as_str()) { if !o.trim().is_empty() { o.to_string() } else { String::new() } } else { String::new() };
    let out = if out.is_empty() {
        let base = Path::new(midi).file_stem().and_then(|x| x.to_str()).unwrap_or("refined");
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        data_dir().join("temp").join("fufumidi").join(format!("{base}_refined_{ts}.mid")).display().to_string()
    } else { out };
    if let Some(parent) = Path::new(&out).parent() { let _ = std::fs::create_dir_all(parent); }
    let Some(py) = python_path() else { return serde_json::json!({ "ok": false, "error": "python runtime not found" }); };
    let Some(eng) = engine_dir() else { return serde_json::json!({ "ok": false, "error": "engine not found" }); };
    let script = eng.join("smart_midi.py");
    if !script.exists() { return serde_json::json!({ "ok": false, "error": "smart_midi.py not found" }); }
    let mut child = match Command::new(&py).current_dir(&eng).arg(&script).args(refine_args(&req, &out)).env("PYTHONIOENCODING", "utf-8").stdout(Stdio::piped()).stderr(Stdio::piped()).creation_flags(0x08000000).spawn() {
        Ok(c) => c, Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }),
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let err_thread = stderr.map(|s| std::thread::spawn(move || { let mut buf = String::new(); let _ = BufReader::new(s).read_to_string(&mut buf); buf }));
    let mut result: Option<serde_json::Value> = None;
    if let Some(stdout) = stdout {
        for line in BufReader::new(stdout).lines().flatten() {
            if let Some(rest) = line.strip_prefix("###RESULT ") { if let Ok(v) = serde_json::from_str::<serde_json::Value>(rest) { result = Some(v); } }
            let _ = app.emit("engine:refine:log", serde_json::json!({ "id": id, "line": line }));
        }
    }
    let status = child.wait();
    let ok = status.map(|s| s.success()).unwrap_or(false);
    let err_text = err_thread.and_then(|t| t.join().ok()).unwrap_or_default();
    let err_tail: String = err_text.chars().rev().take(400).collect::<String>().chars().rev().collect();
    match result {
        Some(mut v) => { v["ok"] = serde_json::json!(ok && v.get("ok").and_then(|x| x.as_bool()).unwrap_or(true)); v["out"] = serde_json::json!(out); if !ok { v["error"] = serde_json::json!(err_tail); } v }
        None => serde_json::json!({ "ok": ok, "out": out, "error": if ok { "" } else { err_tail.as_str() } }),
    }
}

#[tauri::command]
async fn refine(app: AppHandle, req: serde_json::Value) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_refine(app, req)).await.map_err(|e| e.to_string())
}


fn doc_source(kind: &str) -> Option<PathBuf> {
    let name = if kind == "plugin" { "plugin-dev.html" } else { "edit-guide.html" };
    let rel = if kind == "plugin" { Path::new("plugins").join(name) } else { Path::new("renderer").join(name) };
    if let Some(d) = dev_root() { let p = d.join(&rel); if p.is_file() { return Some(p); } }
    if let Some(d) = exe_dir() { for base in [d.join("resources/docs"), d.join("docs")] { let p = base.join(name); if p.is_file() { return Some(p); } } }
    None
}

fn doc_copy_to_temp(src: &Path, name: &str) -> Result<PathBuf, String> {
    let dir = data_dir().join("temp").join("FuFumidi-doc");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dst = dir.join(name);
    std::fs::copy(src, &dst).map_err(|e| e.to_string())?;
    Ok(dst)
}

fn open_doc(kind: &str) -> serde_json::Value {
    let Some(src) = doc_source(kind) else { return serde_json::json!({ "ok": false, "error": "doc not found" }); };
    let name = if kind == "plugin" { "plugin-dev.html" } else { "edit-guide.html" };
    let dst = match doc_copy_to_temp(&src, name) { Ok(p) => p, Err(e) => return serde_json::json!({ "ok": false, "error": e }) };
    #[cfg(target_os = "windows")]
    { let _ = Command::new("cmd").args(["/C", "start", "", &dst.display().to_string()]).creation_flags(0x08000000).spawn(); }
    serde_json::json!({ "ok": true, "path": dst.display().to_string() })
}

#[tauri::command]
fn plugins_open_docs() -> serde_json::Value { open_doc("plugin") }

#[tauri::command]
fn open_edit_guide() -> serde_json::Value { open_doc("edit") }


fn model_artifact_path(root: &Path, id: &str) -> Option<PathBuf> {
    let rel: &str = match id {
        "basic_pitch" => "basic_pitch_quant.onnx",
        "piano_transcription" => "piano_transcription/note_F1=0.9677_pedal_F1=0.9186.pth",
        "hft_transformer" => "hft_transformer",
        "muscriptor_small" => "muscriptor/small",
        "muscriptor_medium" => "muscriptor/medium",
        "muscriptor_large" => "muscriptor/large",
        "yourmt3" => "yourmt3",
        "miros" => "miros",
        "aria_amt" => "aria_amt",
        "beat_this" => "hub/checkpoints/beat_this-final0.ckpt",
        "audio_tagger" => "audio-tagger",
        "hnsep" => "hnsep",
        "htdemucs4_6stems" => "multi/htdemucs4_6stems",
        _ => return None,
    };
    Some(root.join(rel))
}

fn model_delete_at(root: &Path, id: &str) -> serde_json::Value {
    if id.starts_with("rvc:") { return serde_json::json!({ "ok": false, "error": "RVC 模型删除尚未迁移" }); }
    let Some(p) = model_artifact_path(root, id) else { return serde_json::json!({ "ok": false, "error": "not found" }); };
    if !p.exists() { return serde_json::json!({ "ok": false, "error": "not found" }); }
    let res = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
    if let Err(e) = res { return serde_json::json!({ "ok": false, "error": e.to_string() }); }
    for suffix in [".oudep", ".parts", ".tmp", ".part"] { let _ = std::fs::remove_file(format!("{}{suffix}", p.display())); }
    serde_json::json!({ "ok": true })
}

#[tauri::command]
fn model_delete(id: String) -> serde_json::Value { model_delete_at(&models_dir(), &id) }


fn sf_dir() -> PathBuf { data_dir().join("soundfonts") }

fn sf_bundled_dir() -> Option<PathBuf> {
    if let Some(d) = dev_root() { let p = d.join("renderer/vendor/soundfonts"); if p.is_dir() { return Some(p); } }
    if let Some(d) = exe_dir() { for p in [d.join("resources/soundfonts"), d.join("soundfonts")] { if p.is_dir() { return Some(p); } } }
    None
}

fn sf_safe_name(name: &str) -> String {
    let base: String = name.chars().map(|c| match c { '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_', c if (c as u32) < 32 => '_', c => c }).collect();
    let t = base.trim(); if t.is_empty() { "soundfont.sf2".to_string() } else { t.to_string() }
}

fn sf_file_name(it: &serde_json::Value) -> String {
    if let Some(s) = it.get("fileName").and_then(|v| v.as_str()) { if !s.is_empty() { return s.to_string(); } }
    if let Some(s) = it.get("repoFile").and_then(|v| v.as_str()) { if !s.is_empty() { return s.to_string(); } }
    let name = it.get("name").and_then(|v| v.as_str()).unwrap_or("soundfont");
    format!("{}.sf2", sf_safe_name(name))
}

fn sf_registry() -> Vec<serde_json::Value> {
    serde_json::from_str::<Vec<serde_json::Value>>(include_str!("soundfont_registry.json")).unwrap_or_default()
}

fn sf_workshop_list_at(root: &Path, bundled: Option<&Path>) -> serde_json::Value {
    let _ = std::fs::create_dir_all(root);
    let mut registry = Vec::new();
    let mut curated: Vec<PathBuf> = Vec::new();
    for it in sf_registry() {
        let bundled_path = it.get("bundledPath").and_then(|v| v.as_str()).unwrap_or("");
        let p = if !bundled_path.is_empty() {
            match bundled { Some(b) => b.join(Path::new(bundled_path).file_name().and_then(|x| x.to_str()).unwrap_or("")), None => PathBuf::new() }
        } else { root.join(sf_file_name(&it)) };
        if !p.as_os_str().is_empty() { curated.push(p.clone()); }
        let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        let min = it.get("minSize").and_then(|v| v.as_u64()).unwrap_or(0);
        let max = it.get("maxSize").and_then(|v| v.as_u64()).unwrap_or(u64::MAX);
        let complete = size >= min && size <= max;
        let builtin = !bundled_path.is_empty() && complete;
        let mut o = it.clone();
        if let Some(m) = o.as_object_mut() {
            m.insert("size".into(), serde_json::json!(size));
            m.insert("expected".into(), it.get("size").cloned().unwrap_or(serde_json::json!(0)));
            m.insert("downloaded".into(), serde_json::json!(complete));
            m.insert("builtin".into(), serde_json::json!(builtin));
            m.insert("source".into(), serde_json::json!(if builtin { "builtin" } else if complete { "downloaded" } else { "curated" }));
            m.insert("stale".into(), serde_json::json!(size > 0 && !complete));
            m.insert("manual".into(), it.get("manual").cloned().unwrap_or(serde_json::json!(false)));
            m.insert("officialUrl".into(), it.get("officialUrl").cloned().unwrap_or(serde_json::json!("")));
            m.insert("path".into(), serde_json::json!(p.display().to_string()));
            m.insert("sources".into(), serde_json::json!([]));
            m.insert("category".into(), it.get("category").cloned().unwrap_or(serde_json::json!("内置精选")));
            m.insert("slow".into(), it.get("slow").cloned().unwrap_or(serde_json::json!(false)));
            m.insert("overLimit".into(), it.get("overLimit").cloned().unwrap_or(serde_json::json!(false)));
        }
        registry.push(o);
    }
    let mut customs = Vec::new();
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_file() { continue; }
            let name = p.file_name().and_then(|x| x.to_str()).unwrap_or("").to_string();
            if name.ends_with(".conv.sf2") || !(name.to_ascii_lowercase().ends_with(".sf2") || name.to_ascii_lowercase().ends_with(".sf3")) { continue; }
            if curated.iter().any(|c| c == &p) { continue; }
            let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            customs.push(serde_json::json!({ "id": format!("custom:{name}"), "name": Path::new(&name).file_stem().and_then(|x| x.to_str()).unwrap_or(""), "desc": "用户导入的音色库", "size": size, "downloaded": size > 0, "builtin": false, "source": "imported", "category": "我的音色", "custom": true, "path": p.display().to_string(), "overLimit": false }));
        }
    }
    customs.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    serde_json::json!({ "registry": registry, "customs": customs, "dir": root.display().to_string() })
}

#[tauri::command]
fn sf_workshop_list() -> serde_json::Value { sf_workshop_list_at(&sf_dir(), sf_bundled_dir().as_deref()) }

fn sf_workshop_import_at(root: &Path, src: &str) -> serde_json::Value {
    let p = Path::new(src);
    if !p.is_file() { return serde_json::json!({ "ok": false, "canceled": true }); }
    let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext != "sf2" && ext != "sf3" { return serde_json::json!({ "ok": false, "error": "只支持 SF2/SF3" }); }
    let name = p.file_name().and_then(|x| x.to_str()).unwrap_or("soundfont.sf2");
    let _ = std::fs::create_dir_all(root);
    let dst = root.join(name);
    if let Err(e) = std::fs::copy(p, &dst) { return serde_json::json!({ "ok": false, "error": e.to_string() }); }
    serde_json::json!({ "ok": true, "path": dst.display().to_string(), "name": name })
}

#[tauri::command]
fn sf_workshop_import(app: AppHandle) -> serde_json::Value {
    let picked = app.dialog().file().set_title("导入音色库").add_filter("SoundFont (SF2/SF3)", &["sf2", "sf3"]).blocking_pick_file();
    match picked.and_then(file_path_string) { Some(p) => sf_workshop_import_at(&sf_dir(), &p), None => serde_json::json!({ "ok": false, "canceled": true }) }
}

fn sf_workshop_delete_at(root: &Path, id: &str) -> serde_json::Value {
    let p = if let Some(name) = id.strip_prefix("custom:") {
        if name.contains('/') || name.contains('\\') || name == "." || name == ".." { return serde_json::json!({ "ok": false, "error": "not found" }); }
        root.join(name)
    } else {
        let Some(it) = sf_registry().into_iter().find(|x| x["id"].as_str() == Some(id)) else { return serde_json::json!({ "ok": false, "error": "not found" }); };
        root.join(sf_file_name(&it))
    };
    if !p.is_file() { return serde_json::json!({ "ok": false, "error": "not found" }); }
    match std::fs::remove_file(&p) { Ok(_) => serde_json::json!({ "ok": true }), Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }) }
}

#[tauri::command]
fn sf_workshop_delete(id: String) -> serde_json::Value { sf_workshop_delete_at(&sf_dir(), &id) }

#[tauri::command]
fn sf_workshop_open_dir() -> serde_json::Value {
    let d = sf_dir(); let _ = std::fs::create_dir_all(&d);
    #[cfg(target_os = "windows")]
    { let _ = Command::new("explorer").arg(&d).creation_flags(0x08000000).spawn(); }
    serde_json::json!({ "ok": true, "dir": d.display().to_string() })
}


fn plugin_dirs(settings: &serde_json::Value) -> Vec<String> {
    let mut dirs: Vec<String> = Vec::new();
    if let Some(a) = settings.get("plugin.dirs").and_then(|v| v.as_array()) { for v in a { if let Some(s) = v.as_str() { if !s.trim().is_empty() { dirs.push(s.to_string()); } } } }
    if let Ok(env) = std::env::var("FUFUMIDI_PLUGIN_DIRS") { for s in env.split(';') { if !s.trim().is_empty() { dirs.push(s.trim().to_string()); } } }
    if dirs.is_empty() { let d = data_dir().join("plugins"); let _ = std::fs::create_dir_all(&d); dirs.push(d.display().to_string()); }
    dirs
}

fn plugins_from_output(stdout: &str, enabled: &[String]) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for line in stdout.lines().rev() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) {
            if let Some(arr) = v.get("plugins").and_then(|x| x.as_array()) {
                for p in arr {
                    let mut o = p.clone();
                    let id = o.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    if let Some(m) = o.as_object_mut() { m.insert("enabled".into(), serde_json::json!(enabled.iter().any(|e| e == &id))); }
                    out.push(o);
                }
                break;
            }
        }
    }
    out
}

fn run_plugins_list() -> Vec<serde_json::Value> {
    let settings = read_json(&settings_path());
    let enabled: Vec<String> = settings.get("plugins_enabled").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
    let Some(py) = python_path() else { return Vec::new(); };
    let Some(engine) = engine_dir() else { return Vec::new(); };
    let script = engine.join("plugin_render.py");
    if !script.exists() { return Vec::new(); }
    let mut cmd = Command::new(&py);
    cmd.arg(&script).arg("list");
    for d in plugin_dirs(&settings) { cmd.arg("--dir").arg(d); }
    match cmd.creation_flags(0x08000000).output() {
        Ok(o) => plugins_from_output(&String::from_utf8_lossy(&o.stdout), &enabled),
        Err(_) => Vec::new(),
    }
}

#[tauri::command]
fn plugins_list() -> Vec<serde_json::Value> { run_plugins_list() }

#[tauri::command]
fn plugins_rescan() -> Vec<serde_json::Value> { run_plugins_list() }

fn plugins_set_enabled_at(settings_path: &Path, id: &str, enabled: bool) -> serde_json::Value {
    let mut s = read_json(settings_path);
    let mut list: Vec<String> = s.get("plugins_enabled").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|x| x.to_string())).collect()).unwrap_or_default();
    list.retain(|x| x != id);
    if enabled { list.push(id.to_string()); }
    s["plugins_enabled"] = serde_json::json!(list);
    match write_json(settings_path, &s) { Ok(_) => serde_json::json!({ "ok": true, "enabled": enabled }), Err(e) => serde_json::json!({ "ok": false, "error": e }) }
}

#[tauri::command]
fn plugins_set_enabled(id: String, enabled: bool) -> serde_json::Value { plugins_set_enabled_at(&settings_path(), &id, enabled) }

#[tauri::command]
fn plugins_open_dir() -> serde_json::Value {
    let d = data_dir().join("plugins");
    let _ = std::fs::create_dir_all(&d);
    #[cfg(target_os = "windows")]
    { let _ = Command::new("explorer").arg(&d).creation_flags(0x08000000).spawn(); }
    serde_json::json!({ "ok": true, "dir": d.display().to_string() })
}


fn wallpaper_set_desktop_plan(path: &str) -> Vec<Vec<String>> {
    let key = "HKCU\\Control Panel\\Desktop";
    vec![
        vec!["add".into(), key.into(), "/v".into(), "Wallpaper".into(), "/t".into(), "REG_SZ".into(), "/d".into(), path.into(), "/f".into()],
        vec!["add".into(), key.into(), "/v".into(), "WallpaperStyle".into(), "/t".into(), "REG_SZ".into(), "/d".into(), "10".into(), "/f".into()],
        vec!["add".into(), key.into(), "/v".into(), "TileWallpaper".into(), "/t".into(), "REG_SZ".into(), "/d".into(), "0".into(), "/f".into()],
    ]
}

#[tauri::command]
fn wallpaper_set_desktop(path: String) -> serde_json::Value {
    let p = Path::new(&path);
    if !p.is_file() { return serde_json::json!({ "ok": false, "error": "文件不存在" }); }
    let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "bmp" | "webp") { return serde_json::json!({ "ok": false, "error": "只支持静态图片" }); }
    #[cfg(target_os = "windows")]
    {
        for args in wallpaper_set_desktop_plan(&path) {
            let _ = Command::new("reg.exe").args(&args).creation_flags(0x08000000).output();
        }
        let _ = Command::new("rundll32.exe").args(["user32.dll,UpdatePerUserSystemParameters"]).creation_flags(0x08000000).output();
        serde_json::json!({ "ok": true })
    }
    #[cfg(not(target_os = "windows"))]
    { serde_json::json!({ "ok": false, "error": "unsupported platform" }) }
}


fn gpu_root() -> PathBuf { data_dir().join("gpu-enhancements") }

fn gpu_installed_kinds_at(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for k in ["cuda", "rocm", "xpu"] {
        if root.join(k).is_dir() { out.push(k.to_string()); }
    }
    out
}

fn current_python_minor() -> String {
    let Some(py) = python_path() else { return String::new(); };
    let out = Command::new(&py).args(["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"]).creation_flags(0x08000000).output();
    out.ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}

fn gpu_status_at(root: &Path) -> serde_json::Value {
    let kinds = gpu_installed_kinds_at(root);
    let py = current_python_minor();
    let rocm_ok = py == "3.12";
    serde_json::json!({
        "ok": true, "isolated": true, "paths": kinds.iter().map(|k| root.join(k).display().to_string()).collect::<Vec<_>>(),
        "kinds": kinds, "currentPython": py.clone(),
        "cuda": kinds.iter().any(|k| k == "cuda"), "rocm": kinds.iter().any(|k| k == "rocm"), "xpu": kinds.iter().any(|k| k == "xpu"),
        "cudaActive": true, "rocmActive": rocm_ok, "xpuActive": true,
        "needsPython312": kinds.iter().any(|k| k == "rocm") && !rocm_ok,
        "canPython312": py == "3.12"
    })
}

#[tauri::command]
fn gpu_status() -> serde_json::Value { gpu_status_at(&gpu_root()) }

fn gpu_uninstall_at(root: &Path, kind: &str) -> serde_json::Value {
    let k = kind.to_ascii_lowercase();
    if !matches!(k.as_str(), "cuda" | "rocm" | "xpu") { return serde_json::json!({ "ok": false, "error": "未知的增强包类型" }); }
    let dir = root.join(&k);
    let existed = dir.is_dir();
    if existed {
        if let Err(e) = std::fs::remove_dir_all(&dir) { return serde_json::json!({ "ok": false, "error": e.to_string() }); }
    }
    serde_json::json!({ "ok": true, "removed": existed, "restored": false })
}

#[tauri::command]
fn gpu_uninstall(kind: String) -> serde_json::Value { gpu_uninstall_at(&gpu_root(), &kind) }


fn file_assoc_icon() -> String {
    if let Some(d) = dev_root() {
        let ico = d.join("build/icon.ico");
        if ico.exists() { return format!("\"{}\"", ico.display()); }
    }
    let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
    format!("\"{exe}\"")
}

fn file_assoc_plan(enabled: bool) -> Vec<Vec<String>> {
    let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
    let prog = "FuFumidi.MIDI";
    let hkcu = "HKCU\\Software\\Classes";
    if enabled {
        vec![
            vec!["add".into(), format!("{hkcu}\\{prog}\\shell\\open\\command"), "/ve".into(), "/d".into(), format!("\"{exe}\" \"%1\""), "/f".into()],
            vec!["add".into(), format!("{hkcu}\\{prog}\\DefaultIcon"), "/ve".into(), "/d".into(), file_assoc_icon(), "/f".into()],
            vec!["add".into(), format!("{hkcu}\\.mid"), "/ve".into(), "/d".into(), prog.into(), "/f".into()],
            vec!["add".into(), format!("{hkcu}\\.midi"), "/ve".into(), "/d".into(), prog.into(), "/f".into()],
        ]
    } else {
        vec![
            vec!["delete".into(), format!("{hkcu}\\.mid"), "/f".into()],
            vec!["delete".into(), format!("{hkcu}\\.midi"), "/f".into()],
            vec!["delete".into(), format!("{hkcu}\\{prog}"), "/f".into()],
        ]
    }
}

#[tauri::command]
fn file_assoc(enabled: bool) -> serde_json::Value {
    #[cfg(target_os = "windows")]
    {
        let mut failed = 0;
        for args in file_assoc_plan(enabled) {
            match Command::new("reg.exe").args(&args).creation_flags(0x08000000).output() {
                Ok(o) if o.status.success() => {}
                _ => failed += 1,
            }
        }
        if failed == 0 { serde_json::json!({ "ok": true, "enabled": enabled }) }
        else { serde_json::json!({ "ok": false, "enabled": enabled, "error": format!("{failed} registry commands failed") }) }
    }
    #[cfg(not(target_os = "windows"))]
    { serde_json::json!({ "ok": false, "reason": "unsupported" }) }
}


fn wallpaper_scan_folder_at(dir: &Path) -> serde_json::Value {
    if !dir.is_dir() { return serde_json::json!({ "ok": false, "error": "文件夹不存在" }); }
    let mut out: Vec<serde_json::Value> = Vec::new();
    fn walk(d: &Path, out: &mut Vec<serde_json::Value>, depth: usize) {
        if out.len() >= 600 || depth > 3 { return; }
        let Ok(rd) = std::fs::read_dir(d) else { return };
        for e in rd.flatten() {
            if out.len() >= 600 { return; }
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') { continue; }
            let p = e.path();
            if p.is_dir() { walk(&p, out, depth + 1); continue; }
            if !p.is_file() { continue; }
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
            let kind = if matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp" | "avif" | "gif" | "bmp") { "image" } else if matches!(ext.as_str(), "mp4" | "webm" | "mov" | "mkv") { "video" } else { "" };
            if kind.is_empty() { continue; }
            let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            if size == 0 { continue; }
            out.push(serde_json::json!({ "path": p.display().to_string(), "name": name, "kind": kind, "size": size }));
        }
    }
    walk(dir, &mut out, 0);
    out.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    serde_json::json!({ "ok": true, "list": out })
}

#[tauri::command]
fn wallpaper_scan_folder(dir: String) -> serde_json::Value { wallpaper_scan_folder_at(Path::new(&dir)) }


fn wallpaper_dir() -> PathBuf { legacy_dir().unwrap_or_else(data_dir).join("wallpapers") }

fn wallpaper_list_at(dir: &Path) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_file() { continue; }
        let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
        if !matches!(ext.as_str(), "mp4" | "webm" | "mov") { continue; }
        let ok = std::fs::metadata(&p).map(|m| m.len() > 0).unwrap_or(false);
        let marker = PathBuf::from(format!("{}.ok", p.display()));
        if !ok || !marker.exists() { continue; }
        let name = p.file_name().and_then(|x| x.to_str()).unwrap_or("").to_string();
        out.push(serde_json::json!({ "name": name, "video": p.display().to_string(), "thumb": "", "local": true }));
    }
    out.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    out
}

fn wallpaper_add_local_at(dir: &Path, src_path: &str) -> serde_json::Value {
    let src = Path::new(src_path);
    if !src.is_file() { return serde_json::json!({ "ok": false, "error": "文件不存在" }); }
    let ext = src.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(ext.as_str(), "mp4" | "webm" | "mov") { return serde_json::json!({ "ok": false, "error": "只支持 mp4/webm/mov" }); }
    let mut name = src.file_name().and_then(|x| x.to_str()).unwrap_or("wallpaper.mp4").to_string();
    if name.chars().count() > 120 { name = name.chars().rev().take(120).collect::<String>().chars().rev().collect(); }
    let _ = std::fs::create_dir_all(dir);
    let dest = dir.join(&name);
    if std::fs::copy(src, &dest).is_err() { return serde_json::json!({ "ok": false, "error": "复制失败" }); }
    let _ = std::fs::write(format!("{}.ok", dest.display()), b"1");
    serde_json::json!({ "ok": true, "name": name, "video": dest.display().to_string() })
}

fn wallpaper_remove_local_at(dir: &Path, name: &str) -> serde_json::Value {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return serde_json::json!({ "ok": false, "error": "非法文件名" });
    }
    let p = dir.join(name);
    if !p.is_file() { return serde_json::json!({ "ok": false, "error": "不存在" }); }
    let _ = std::fs::remove_file(&p);
    let _ = std::fs::remove_file(format!("{}.ok", p.display()));
    let thumb = dir.join(Path::new(name).with_extension("jpg"));
    let _ = std::fs::remove_file(thumb);
    serde_json::json!({ "ok": true, "removed": true })
}

#[tauri::command]
fn wallpaper_list() -> Vec<serde_json::Value> { wallpaper_list_at(&wallpaper_dir()) }

#[tauri::command]
fn wallpaper_add_local(src_path: String) -> serde_json::Value { wallpaper_add_local_at(&wallpaper_dir(), &src_path) }

#[tauri::command]
fn wallpaper_remove_local(name: String) -> serde_json::Value { wallpaper_remove_local_at(&wallpaper_dir(), &name) }


fn usermeta_path() -> PathBuf { data_dir().join("usermeta.json") }

fn usermeta_blank() -> serde_json::Value { serde_json::json!({ "schema_version": 1, "items": {} }) }

fn usermeta_load_at(root: &Path) -> serde_json::Value {
    let p = root.join("usermeta.json");
    let Ok(raw) = std::fs::read_to_string(&p) else { return usermeta_blank(); };
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(mut v) if v.is_object() => {
            if !v.get("items").map(|x| x.is_object()).unwrap_or(false) { v["items"] = serde_json::json!({}); }
            v["schema_version"] = serde_json::json!(1);
            v
        }
        _ => {
            let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let _ = std::fs::rename(&p, root.join(format!("usermeta.corrupt-{ts}.json")));
            usermeta_blank()
        }
    }
}

fn usermeta_save_at(root: &Path, data: &serde_json::Value) -> bool {
    let p = root.join("usermeta.json");
    let _ = std::fs::create_dir_all(root);
    let tmp = p.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(data).unwrap_or_else(|_| "{}".to_string());
    if std::fs::write(&tmp, text).is_err() { return false; }
    std::fs::rename(&tmp, &p).is_ok()
}

fn usermeta_clean(item: &serde_json::Value) -> serde_json::Value {
    let mut o = serde_json::Map::new();
    for f in ["name", "author", "source", "category"] {
        if let Some(s) = item.get(f).and_then(|v| v.as_str()) { let t = s.trim(); if !t.is_empty() { o.insert(f.to_string(), serde_json::json!(t)); } }
    }
    if let Some(tags) = item.get("tags").and_then(|v| v.as_array()) {
        let mut seen = std::collections::BTreeSet::new();
        let mut out = Vec::new();
        for t in tags { let s = t.as_str().unwrap_or("").trim(); if !s.is_empty() && seen.insert(s.to_string()) { out.push(serde_json::json!(s)); } }
        if !out.is_empty() { o.insert("tags".to_string(), serde_json::json!(out)); }
    }
    if let Some(n) = item.get("order").and_then(|v| v.as_i64()) { o.insert("order".to_string(), serde_json::json!(n)); }
    if item.get("pinned").and_then(|v| v.as_bool()) == Some(true) { o.insert("pinned".to_string(), serde_json::json!(true)); }
    serde_json::Value::Object(o)
}

fn usermeta_valid(kind: &str, id: &str) -> bool {
    matches!(kind, "model" | "utau" | "ds" | "sf" | "voice" | "rvc") && !id.trim().is_empty()
}

fn usermeta_set_at(root: &Path, kind: &str, id: &str, patch: &serde_json::Value) -> serde_json::Value {
    if !usermeta_valid(kind, id) { return serde_json::json!({ "ok": false, "error": "非法的 kind/id" }); }
    let mut data = usermeta_load_at(root);
    let key = format!("{kind}:{id}");
    let mut merged = data["items"].get(&key).cloned().unwrap_or(serde_json::json!({}));
    if let (Some(dst), Some(src)) = (merged.as_object_mut(), patch.as_object()) { for (k, v) in src { dst.insert(k.clone(), v.clone()); } }
    let next = usermeta_clean(&merged);
    if next.as_object().map(|o| o.is_empty()).unwrap_or(true) { data["items"].as_object_mut().map(|o| o.remove(&key)); }
    else { data["items"][&key] = next.clone(); }
    if !usermeta_save_at(root, &data) { return serde_json::json!({ "ok": false, "error": "写入失败" }); }
    serde_json::json!({ "ok": true, "item": next })
}

fn usermeta_remove_at(root: &Path, kind: &str, id: &str) -> serde_json::Value {
    if !usermeta_valid(kind, id) { return serde_json::json!({ "ok": false, "error": "非法的 kind/id" }); }
    let mut data = usermeta_load_at(root);
    data["items"].as_object_mut().map(|o| o.remove(&format!("{kind}:{id}")));
    if !usermeta_save_at(root, &data) { return serde_json::json!({ "ok": false, "error": "写入失败" }); }
    serde_json::json!({ "ok": true })
}

fn usermeta_reorder_at(root: &Path, kind: &str, ids: &[String]) -> serde_json::Value {
    if !matches!(kind, "model" | "utau" | "ds" | "sf" | "voice" | "rvc") { return serde_json::json!({ "ok": false, "error": "非法入参" }); }
    let mut data = usermeta_load_at(root);
    for (i, id) in ids.iter().enumerate() {
        if id.trim().is_empty() { continue; }
        let key = format!("{kind}:{id}");
        let mut merged = data["items"].get(&key).cloned().unwrap_or(serde_json::json!({}));
        merged["order"] = serde_json::json!(i as i64 + 1);
        let next = usermeta_clean(&merged);
        data["items"][&key] = next;
    }
    if !usermeta_save_at(root, &data) { return serde_json::json!({ "ok": false, "error": "写入失败" }); }
    serde_json::json!({ "ok": true })
}

#[tauri::command]
fn usermeta_list() -> serde_json::Value { let d = usermeta_load_at(&data_dir()); serde_json::json!({ "ok": true, "items": d["items"], "path": usermeta_path().display().to_string() }) }

#[tauri::command]
fn usermeta_set(kind: String, id: String, patch: serde_json::Value) -> serde_json::Value { usermeta_set_at(&data_dir(), &kind, &id, &patch) }

#[tauri::command]
fn usermeta_remove(kind: String, id: String) -> serde_json::Value { usermeta_remove_at(&data_dir(), &kind, &id) }

#[tauri::command]
fn usermeta_reorder(kind: String, ids: Vec<String>) -> serde_json::Value { usermeta_reorder_at(&data_dir(), &kind, &ids) }

#[tauri::command]
fn usermeta_pin(kind: String, id: String, pinned: bool) -> serde_json::Value { usermeta_set_at(&data_dir(), &kind, &id, &serde_json::json!({ "pinned": pinned })) }


fn sanitize_midi_base(name: &str) -> String {
    let mut stem = name;
    if let Some((s, e)) = name.rsplit_once('.') {
        if !e.contains('/') && !e.contains('\\') { stem = s; }
    }
    let mut base: String = stem.chars().map(|c| match c {
        '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
        c if (c as u32) < 32 => '_',
        c => c,
    }).collect();
    base = base.split_whitespace().collect::<Vec<_>>().join(" ");
    base = base.trim_end_matches(|c: char| c == '.' || c == ' ').to_string();
    if base.is_empty() { base = "untitled".to_string(); }
    if base.chars().count() > 120 { base = base.chars().take(120).collect(); }
    base
}

fn write_midi_at(root: &Path, opts: &serde_json::Value) -> serde_json::Value {
    let bytes: Vec<u8> = opts.get("bytes").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as u8)).collect()).unwrap_or_default();
    if bytes.is_empty() { return serde_json::json!({ "ok": false, "error": "曲目字节为空" }); }
    let _ = std::fs::create_dir_all(root);
    let root_canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let prev = opts.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if !prev.is_empty() {
        if let Ok(c) = PathBuf::from(prev).canonicalize() {
            if c.starts_with(&root_canon) && std::fs::read(&c).ok().as_deref() == Some(bytes.as_slice()) {
                return serde_json::json!({ "ok": true, "path": c.display().to_string(), "existed": true });
            }
        }
    }
    let base = sanitize_midi_base(opts.get("name").and_then(|v| v.as_str()).unwrap_or("untitled"));
    let same = root.join(format!("{base}.mid"));
    if std::fs::read(&same).ok().as_deref() == Some(bytes.as_slice()) {
        return serde_json::json!({ "ok": true, "path": same.display().to_string(), "existed": true });
    }
    let mut target = if !prev.is_empty() { PathBuf::from(prev) } else if same.exists() { same.clone() } else { same.clone() };
    if !prev.is_empty() && !target.starts_with(&root_canon) { target = same.clone(); }
    if target == same && same.exists() {
        let mut n = 2;
        loop {
            let cand = root.join(format!("{base} ({n}).mid"));
            if !cand.exists() { target = cand; break; }
            n += 1;
            if n > 9999 { return serde_json::json!({ "ok": false, "error": "文件名冲突过多" }); }
        }
    }
    if let Some(parent) = target.parent() { let _ = std::fs::create_dir_all(parent); }
    match std::fs::write(&target, &bytes) {
        Ok(_) => serde_json::json!({ "ok": true, "path": target.display().to_string(), "existed": false }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command]
fn write_midi(opts: serde_json::Value) -> serde_json::Value { write_midi_at(&midi_root(), &opts) }

#[tauri::command]
fn write_binary(p: String, data: serde_json::Value) -> serde_json::Value {
    let bytes: Vec<u8> = data.as_array().map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as u8)).collect()).unwrap_or_default();
    if bytes.is_empty() { return serde_json::json!({ "ok": false, "error": "empty data" }); }
    if let Some(parent) = Path::new(&p).parent() { let _ = std::fs::create_dir_all(parent); }
    match std::fs::write(&p, &bytes) { Ok(_) => serde_json::json!({ "ok": true, "path": p }), Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }) }
}


fn integrity_check_at(settings: &Path) -> serde_json::Value {
    let mut issues = Vec::new();
    if !settings.exists() {
        issues.push(serde_json::json!({ "id": "settings-missing", "severity": "warn", "canRepair": true, "path": settings.display().to_string() }));
    } else {
        match std::fs::read_to_string(settings).ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()) {
            Some(_) => {}
            None => issues.push(serde_json::json!({ "id": "settings-corrupt", "severity": "warn", "canRepair": true, "path": settings.display().to_string() })),
        }
    }
    serde_json::json!({ "ok": issues.is_empty(), "issues": issues })
}

fn integrity_repair_at(settings: &Path, ids: &[String]) -> serde_json::Value {
    let mut results = Vec::new();
    let mut backup: Option<String> = None;
    for id in ids {
        if id == "settings-missing" || id == "settings-corrupt" {
            if settings.exists() {
                let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                let bak = settings.with_file_name(format!("{}.bak-{ts}", settings.file_name().and_then(|x| x.to_str()).unwrap_or("settings.json")));
                if std::fs::copy(settings, &bak).is_ok() { backup = Some(bak.display().to_string()); }
            }
            if let Some(parent) = settings.parent() { let _ = std::fs::create_dir_all(parent); }
            match std::fs::write(settings, "{}") {
                Ok(_) => results.push(serde_json::json!({ "id": id, "ok": true, "action": "recreated", "backup": backup })),
                Err(e) => results.push(serde_json::json!({ "id": id, "ok": false, "error": e.to_string() })),
            }
        } else {
            results.push(serde_json::json!({ "id": id, "ok": false, "error": "unsupported issue in Tauri shell" }));
        }
    }
    serde_json::json!({ "ok": results.iter().all(|r| r["ok"] == true), "results": results })
}

#[tauri::command]
fn check_integrity() -> serde_json::Value { integrity_check_at(&settings_path()) }

#[tauri::command]
fn repair_integrity(ids: Vec<String>) -> serde_json::Value { integrity_repair_at(&settings_path(), &ids) }


fn clear_user_data_at(root: &Path, scopes: &[String]) -> serde_json::Value {
    let has = |s: &str| scopes.iter().any(|x| x == s);
    let mut done: Vec<String> = Vec::new();
    let rm = |p: &Path| { let _ = std::fs::remove_dir_all(p); };
    if has("models") { rm(&root.join("models")); done.push("models".to_string()); }
    if has("soundfonts") { rm(&root.join("soundfonts")); done.push("soundfonts".to_string()); }
    if has("deps") {
        for d in ["gpu-enhancements", "cache", "pip-cache"] { rm(&root.join(d)); }
        done.push("deps".to_string());
    }
    if has("playdata") { done.push("playdata".to_string()); }
    let need_restart = done.iter().any(|x| x == "models" || x == "deps");
    serde_json::json!({ "ok": true, "done": done, "needRestart": need_restart })
}

#[tauri::command]
fn clear_user_data(scopes: Option<Vec<String>>) -> serde_json::Value {
    let list = scopes.unwrap_or_else(|| vec!["models".into(), "soundfonts".into(), "deps".into(), "playdata".into()]);
    clear_user_data_at(&data_dir(), &list)
}


fn detect_model_dest(archive: &Path, files: &[String]) -> Option<String> {
    let joined = files.join("\n").replace('\\', "/").to_ascii_lowercase();
    for (needle, dest) in [
        ("muscriptor/small/", "muscriptor/small"), ("muscriptor/medium/", "muscriptor/medium"),
        ("muscriptor/large/", "muscriptor/large"), ("aria_amt/", "aria_amt"),
        ("piano_transcription/", "piano_transcription"),
    ] {
        if joined.contains(needle) { return Some(dest.to_string()); }
    }
    let n = archive.file_name().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
    for (needle, dest) in [
        ("muscriptor_small", "muscriptor/small"), ("muscriptor-small", "muscriptor/small"),
        ("muscriptor_medium", "muscriptor/medium"), ("muscriptor-medium", "muscriptor/medium"),
        ("muscriptor_large", "muscriptor/large"), ("muscriptor-large", "muscriptor/large"),
        ("aria_amt", "aria_amt"), ("aria-amt", "aria_amt"),
        ("piano_transcription", "piano_transcription"), ("piano-transcription", "piano_transcription"),
    ] {
        if n.contains(needle) { return Some(dest.to_string()); }
    }
    None
}

fn find_model_source_dir(root: &Path, dest: &str) -> PathBuf {
    let last = dest.rsplit('/').next().unwrap_or(dest);
    let first = dest.split('/').next().unwrap_or(dest);
    let mut dirs: Vec<PathBuf> = Vec::new();
    fn walk(d: &Path, out: &mut Vec<PathBuf>, depth: usize) {
        if depth > 8 { return; }
        let Ok(rd) = std::fs::read_dir(d) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() { out.push(p.clone()); walk(&p, out, depth + 1); }
        }
    }
    walk(root, &mut dirs, 0);
    for d in &dirs {
        let rel = d.strip_prefix(root).unwrap_or(d).to_string_lossy().replace('\\', "/");
        if rel.eq_ignore_ascii_case(dest) { return d.clone(); }
    }
    for d in &dirs {
        let name = d.file_name().and_then(|x| x.to_str()).unwrap_or("");
        if name.eq_ignore_ascii_case(last) && d.to_string_lossy().to_ascii_lowercase().contains(&first.to_ascii_lowercase()) { return d.clone(); }
    }
    for d in &dirs {
        let name = d.file_name().and_then(|x| x.to_str()).unwrap_or("");
        if name.eq_ignore_ascii_case(last) { return d.clone(); }
    }
    root.to_path_buf()
}

fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<u64> {
    let mut total = 0u64;
    std::fs::create_dir_all(dst)?;
    fn walk(src: &Path, dst: &Path, total: &mut u64, depth: usize) -> std::io::Result<()> {
        if depth > 12 { return Ok(()); }
        for e in std::fs::read_dir(src)?.flatten() {
            let p = e.path();
            let rel = p.strip_prefix(src).unwrap_or(&p).to_path_buf();
            let out = dst.join(rel);
            if p.is_dir() { std::fs::create_dir_all(&out)?; walk(&p, &out, total, depth + 1)?; }
            else if p.is_file() { std::fs::copy(&p, &out)?; *total += std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0); }
        }
        Ok(())
    }
    walk(src, dst, &mut total, 0)?;
    Ok(total)
}

fn model_import_local_at(archive: &Path, models_root: &Path) -> serde_json::Value {
    let ext = archive.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext != "zip" { return serde_json::json!({ "ok": false, "error": "Tauri 目前只支持 .zip 模型压缩包（7z/tar 仍走 Electron）" }); }
    let uniq = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("fufumidi-model-import-{}-{uniq}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let _ = std::fs::create_dir_all(&tmp);
    let result = (|| -> Result<serde_json::Value, String> {
        let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        if zip.len() > 4096 { return Err("压缩包条目过多".to_string()); }
        let mut total: u64 = 0;
        let mut names: Vec<String> = Vec::new();
        for i in 0..zip.len() {
            let mut e = zip.by_index(i).map_err(|e| e.to_string())?;
            let name = e.name().replace('\\', "/");
            if name.contains("..") || name.starts_with('/') || name.is_empty() { continue; }
            total += e.size();
            if total > 8 * 1024 * 1024 * 1024 { return Err("压缩包解压后过大（>8GB）".to_string()); }
            let dest = tmp.join(&name);
            if e.is_dir() { let _ = std::fs::create_dir_all(&dest); continue; }
            if let Some(parent) = dest.parent() { let _ = std::fs::create_dir_all(parent); }
            let mut out = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
            std::io::copy(&mut e, &mut out).map_err(|e| e.to_string())?;
            names.push(name);
        }
        let dest = detect_model_dest(archive, &names).ok_or_else(|| "无法识别压缩包中的模型类型（MuScriptor / Aria-AMT / 钢琴模型）".to_string())?;
        let src_dir = find_model_source_dir(&tmp, &dest);
        let dest_dir = models_root.join(&dest);
        let _ = std::fs::remove_dir_all(&dest_dir);
        let size = copy_tree(&src_dir, &dest_dir).map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "ok": true, "path": dest_dir.display().to_string(), "size": size, "model": dest }))
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    match result { Ok(v) => v, Err(e) => serde_json::json!({ "ok": false, "error": e }) }
}

#[tauri::command]
fn pick_model_archive(app: AppHandle) -> Option<String> {
    let picked = app.dialog().file().set_title("选择本地模型压缩包").add_filter("模型压缩包", &["zip"]).blocking_pick_file();
    picked.and_then(|p| p.into_path().ok()).map(|p| p.display().to_string())
}

#[tauri::command]
fn model_import_local(file_path: String) -> serde_json::Value {
    model_import_local_at(Path::new(&file_path), &data_dir().join("models"))
}


fn parse_health_json(stdout: &str) -> Option<serde_json::Value> {
    let t = stdout.trim();
    if t.is_empty() { return None; }
    // health.py 用 ###RESULT {json} 协议输出；也接受纯 JSON/最后一行 JSON。
    let strip = |s: &str| s.trim().strip_prefix("###RESULT ").unwrap_or(s.trim()).to_string();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&strip(t)) { return Some(v); }
    for line in t.lines().rev() {
        let c = strip(line);
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&c) { return Some(v); }
    }
    None
}

#[tauri::command]
fn diag_health() -> serde_json::Value {
    let Some(py) = python_path() else { return serde_json::json!({ "ok": false, "error": "python runtime not found" }); };
    let Some(engine) = engine_dir() else { return serde_json::json!({ "ok": false, "error": "engine not found" }); };
    let script = engine.join("health.py");
    if !script.exists() { return serde_json::json!({ "ok": false, "error": "health.py not found" }); }
    match Command::new(&py).arg(&script).arg("--json").env("PYTHONIOENCODING", "utf-8").output() {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let report = parse_health_json(&stdout);
            let ok = out.status.success() && report.is_some();
            serde_json::json!({ "ok": ok, "report": report, "error": if ok { serde_json::Value::Null } else { serde_json::json!(stderr.chars().rev().take(600).collect::<String>().chars().rev().collect::<String>()) }, "raw": stdout.chars().rev().take(2000).collect::<String>().chars().rev().collect::<String>() })
        }
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}


fn autostart_value() -> String {
    let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
    format!("\"{exe}\"")
}

#[tauri::command]
fn autostart_get() -> serde_json::Value {
    #[cfg(target_os = "windows")]
    {
        let out = std::process::Command::new("reg").args(["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "FuFumidi"]).creation_flags(0x08000000).output();
        match out {
            Ok(o) => { let text = String::from_utf8_lossy(&o.stdout); serde_json::json!({ "ok": true, "openAtLogin": o.status.success() && text.contains("FuFumidi") }) }
            Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
        }
    }
    #[cfg(not(target_os = "windows"))]
    { serde_json::json!({ "ok": false, "error": "unsupported platform" }) }
}

#[tauri::command]
fn autostart_set(open: bool) -> serde_json::Value {
    #[cfg(target_os = "windows")]
    {
        let key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        let out = if open {
            std::process::Command::new("reg").args(["add", key, "/v", "FuFumidi", "/t", "REG_SZ", "/d", &autostart_value(), "/f"]).creation_flags(0x08000000).output()
        } else {
            std::process::Command::new("reg").args(["delete", key, "/v", "FuFumidi", "/f"]).creation_flags(0x08000000).output()
        };
        match out {
            Ok(o) if o.status.success() => autostart_get(),
            Ok(o) => serde_json::json!({ "ok": false, "error": String::from_utf8_lossy(&o.stderr) }),
            Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
        }
    }
    #[cfg(not(target_os = "windows"))]
    { serde_json::json!({ "ok": false, "error": "unsupported platform" }) }
}


fn write_dawproject_at(target: &Path, files: &[serde_json::Value]) -> serde_json::Value {
    if files.is_empty() { return serde_json::json!({ "ok": false, "error": "没有可导出的内容" }); }
    if files.len() > 200 { return serde_json::json!({ "ok": false, "error": "文件过多（>200）" }); }
    let mut items: Vec<(String, String)> = Vec::new();
    for f in files {
        let name = f.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let data = f.get("data").and_then(|v| v.as_str()).unwrap_or("");
        let clean = name.replace('\\', "/");
        if clean.is_empty() || clean.contains("..") || clean.starts_with('/') { continue; }
        items.push((clean, data.to_string()));
    }
    if items.is_empty() { return serde_json::json!({ "ok": false, "error": "没有可导出的文件" }); }
    if let Some(parent) = target.parent() { let _ = std::fs::create_dir_all(parent); }
    let file = match std::fs::File::create(target) { Ok(f) => f, Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }) };
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default();
    for (name, data) in &items {
        if let Err(e) = zip.start_file(name, opts) { return serde_json::json!({ "ok": false, "error": e.to_string() }); }
        if let Err(e) = zip.write_all(data.as_bytes()) { return serde_json::json!({ "ok": false, "error": e.to_string() }); }
    }
    if let Err(e) = zip.finish() { return serde_json::json!({ "ok": false, "error": e.to_string() }); }
    let bytes = std::fs::metadata(target).map(|m| m.len()).unwrap_or(0);
    serde_json::json!({ "ok": true, "filePath": target.display().to_string(), "bytes": bytes, "files": items.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>() })
}

#[tauri::command]
fn export_dawproject(app: AppHandle, payload: serde_json::Value) -> serde_json::Value {
    let files = payload.get("files").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let suggested = payload.get("suggestedName").and_then(|v| v.as_str()).unwrap_or("project.dawproject");
    let name = if suggested.to_ascii_lowercase().ends_with(".dawproject") { suggested.to_string() } else { format!("{suggested}.dawproject") };
    let mut target = payload.get("filePath").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if target.is_empty() {
        let picked = app.dialog().file().set_title("导出 DAWproject").set_file_name(&name).add_filter("DAWproject", &["dawproject"]).blocking_save_file();
        target = match picked.and_then(|p| p.into_path().ok()) { Some(p) => p.display().to_string(), None => return serde_json::json!({ "ok": false, "canceled": true }) };
    }
    write_dawproject_at(Path::new(&target), &files)
}


fn cover_data_url(bytes: &[u8], ext: &str) -> serde_json::Value {
    if bytes.len() > 6 * 1024 * 1024 { return serde_json::json!({ "ok": false, "error": "图片过大（>6MB）" }); }
    let e = ext.trim_start_matches('.').to_ascii_lowercase();
    let mime = if e == "jpg" { "jpeg" } else { e.as_str() };
    let ok = matches!(mime, "png" | "jpeg" | "webp" | "bmp");
    if !ok { return serde_json::json!({ "ok": false, "error": "unsupported image type" }); }
    serde_json::json!({ "ok": true, "dataUrl": format!("data:image/{mime};base64,{}", base64_encode(bytes)) })
}

#[tauri::command]
fn pick_cover(app: AppHandle) -> serde_json::Value {
    let picked = app.dialog().file().set_title("选择封面图片").add_filter("图片", &["png", "jpg", "jpeg", "webp", "bmp"]).blocking_pick_file();
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return serde_json::json!({ "ok": false, "canceled": true }); };
    let Ok(bytes) = std::fs::read(&path) else { return serde_json::json!({ "ok": false, "error": "read failed" }); };
    let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("png");
    cover_data_url(&bytes, ext)
}


fn write_stems_zip_at(target: &Path, files: &[serde_json::Value], suggested: &str) -> serde_json::Value {
    if files.is_empty() { return serde_json::json!({ "ok": false, "error": "没有可打包的分轨文件" }); }
    if files.len() > 100 { return serde_json::json!({ "ok": false, "error": "分轨数量过多（>100）" }); }
    let mut items: Vec<(String, Vec<u8>)> = Vec::new();
    let mut total = 0usize;
    for f in files {
        let name = f.get("name").and_then(|v| v.as_str()).unwrap_or("stem");
        let ext = f.get("ext").and_then(|v| v.as_str()).unwrap_or("wav");
        let bytes: Vec<u8> = f.get("bytes").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as u8)).collect()).unwrap_or_default();
        if bytes.is_empty() { continue; }
        total += bytes.len();
        if total > 2 * 1024 * 1024 * 1024 { return serde_json::json!({ "ok": false, "error": "分轨总大小超过 2GB" }); }
        items.push((sanitize_export_name(name, ext), bytes));
    }
    if items.is_empty() { return serde_json::json!({ "ok": false, "error": "没有可打包的音频数据" }); }
    let target = if target.as_os_str().is_empty() { Path::new(suggested) } else { target };
    if let Some(parent) = target.parent() { let _ = std::fs::create_dir_all(parent); }
    let file = match std::fs::File::create(target) { Ok(f) => f, Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }) };
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default();
    for (name, bytes) in &items {
        if let Err(e) = zip.start_file(name, opts) { return serde_json::json!({ "ok": false, "error": e.to_string() }); }
        if let Err(e) = zip.write_all(bytes) { return serde_json::json!({ "ok": false, "error": e.to_string() }); }
    }
    if let Err(e) = zip.finish() { return serde_json::json!({ "ok": false, "error": e.to_string() }); }
    serde_json::json!({ "ok": true, "path": target.display().to_string(), "count": items.len(), "bytes": total })
}

#[tauri::command]
fn export_stems_zip(app: AppHandle, payload: serde_json::Value) -> serde_json::Value {
    let files = payload.get("files").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let suggested = sanitize_export_name(payload.get("suggestedName").and_then(|v| v.as_str()).unwrap_or("stems"), "zip");
    let mut target = payload.get("targetPath").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if target.is_empty() {
        let picked = app.dialog().file().set_title("分轨打包导出").set_file_name(&suggested).add_filter("ZIP", &["zip"]).blocking_save_file();
        target = match picked.and_then(|p| p.into_path().ok()) { Some(p) => p.display().to_string(), None => return serde_json::json!({ "ok": false, "canceled": true }) };
    }
    write_stems_zip_at(Path::new(&target), &files, &suggested)
}


fn unix_to_iso(ts: u64) -> String {
    let days = (ts / 86400) as i64;
    let secs = (ts % 86400) as u64;
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    if m <= 2 { y += 1; }
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z", y, m, d, secs / 3600, (secs % 3600) / 60, secs % 60)
}
fn sanitize_export_name(name: &str, ext: &str) -> String {
    let mut stem0 = name;
    if let Some((s, e)) = name.rsplit_once('.') {
        if !e.contains('/') && !e.contains('\\') { stem0 = s; }
    }
    let mut base: String = stem0.chars().map(|c| match c {
        '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
        c if (c as u32) < 32 => '_',
        c => c,
    }).collect();
    base = base.split_whitespace().collect::<Vec<_>>().join(" ");
    base = base.trim_end_matches(|c: char| c == '.' || c == ' ').to_string();
    if base.is_empty() { base = "export".to_string(); }
    if base.chars().count() > 120 { base = base.chars().take(120).collect(); }
    let e: String = ext.trim_start_matches('.').chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let e = if e.is_empty() { "wav".to_string() } else { e.to_ascii_lowercase() };
    format!("{base}.{e}")
}

fn write_export_at(dir: &Path, name: &str, ext: &str, bytes: &[u8], meta: &serde_json::Value, app_version: &str) -> serde_json::Value {
    if bytes.is_empty() { return serde_json::json!({ "ok": false, "error": "没有可导出的音频数据" }); }
    let _ = std::fs::create_dir_all(dir);
    let file_name = sanitize_export_name(name, ext);
    let target = dir.join(&file_name);
    let tmp = target.with_extension(format!("{}.tmp", target.extension().and_then(|x| x.to_str()).unwrap_or("tmp")));
    if let Err(e) = std::fs::write(&tmp, bytes) { return serde_json::json!({ "ok": false, "error": e.to_string() }); }
    if let Err(e) = std::fs::rename(&tmp, &target) { let _ = std::fs::remove_file(&tmp); return serde_json::json!({ "ok": false, "error": e.to_string() }); }
    let mut hasher = Sha256::new(); hasher.update(bytes); let hash = format!("{:x}", hasher.finalize());
    let base = target.file_stem().and_then(|x| x.to_str()).unwrap_or("export");
    let manifest_path = dir.join(format!("{base}.manifest.json"));
    let manifest = serde_json::json!({
        "format": "fufumidi-export", "version": 1,
        "createdAt": unix_to_iso(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)),
        "file": { "name": file_name, "size": bytes.len(), "sha256": hash, "path": target.display().to_string() },
        "audio": {
            "format": meta.get("format").and_then(|v| v.as_str()).unwrap_or("wav"),
            "bitDepth": meta.get("bitDepth").cloned().unwrap_or(serde_json::json!(16)),
            "sampleRate": meta.get("sampleRate").cloned().unwrap_or(serde_json::json!(44100)),
            "channels": meta.get("channels").cloned().unwrap_or(serde_json::json!(2)),
            "durationSec": meta.get("durationSec").cloned().unwrap_or(serde_json::Value::Null),
            "lufs": meta.get("lufs").cloned().unwrap_or(serde_json::Value::Null),
            "peakDb": meta.get("peakDb").cloned().unwrap_or(serde_json::Value::Null),
            "targetLufs": meta.get("targetLufs").cloned().unwrap_or(serde_json::Value::Null)
        },
        "source": { "name": meta.get("sourceName").and_then(|v| v.as_str()).unwrap_or(""), "app": app_version }
    });
    let tmpm = manifest_path.with_extension("manifest.json.tmp");
    let text = serde_json::to_string_pretty(&manifest).unwrap_or_else(|_| "{}".to_string());
    if let Err(e) = std::fs::write(&tmpm, &text) { return serde_json::json!({ "ok": false, "error": e.to_string() }); }
    if let Err(e) = std::fs::rename(&tmpm, &manifest_path) { let _ = std::fs::remove_file(&tmpm); return serde_json::json!({ "ok": false, "error": e.to_string() }); }
    serde_json::json!({ "ok": true, "path": target.display().to_string(), "manifestPath": manifest_path.display().to_string(), "manifest": manifest })
}

#[tauri::command]
fn export_audio(app: AppHandle, payload: serde_json::Value) -> serde_json::Value {
    let bytes: Vec<u8> = payload.get("bytes").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as u8)).collect()).unwrap_or_default();
    if bytes.is_empty() { return serde_json::json!({ "ok": false, "error": "没有可导出的音频数据" }); }
    let ext = payload.get("ext").and_then(|v| v.as_str()).unwrap_or("wav");
    let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("export");
    let mut target = payload.get("targetPath").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if target.is_empty() {
        let picked = app.dialog().file().set_title("导出音频").set_file_name(sanitize_export_name(name, ext)).add_filter("音频", &[ext.trim_start_matches('.')]).blocking_save_file();
        target = match picked.and_then(|p| p.into_path().ok()) { Some(p) => p.display().to_string(), None => return serde_json::json!({ "ok": false, "canceled": true }) };
    }
    let tp = PathBuf::from(&target);
    let dir = tp.parent().map(|x| x.to_path_buf()).unwrap_or_else(data_dir);
    let stem = tp.file_stem().and_then(|x| x.to_str()).unwrap_or(name);
    let meta = payload.clone();
    write_export_at(&dir, stem, ext, &bytes, &meta, env!("CARGO_PKG_VERSION"))
}


fn mp4_boxes(b: &[u8], start: usize, end: usize, depth: usize, f: &mut dyn FnMut(&[u8], &[u8])) {
    if depth > 8 { return; }
    let mut i = start;
    while i + 8 <= end {
        let mut size = u32::from_be_bytes([b[i], b[i+1], b[i+2], b[i+3]]) as usize;
        let typ = &b[i+4..i+8];
        let mut hdr = 8usize;
        if size == 1 { if i + 16 > end { break; } size = u64::from_be_bytes([b[i+8],b[i+9],b[i+10],b[i+11],b[i+12],b[i+13],b[i+14],b[i+15]]) as usize; hdr = 16; }
        if size == 0 { size = end - i; }
        if size < hdr || i + size > end { break; }
        let body = &b[i+hdr..i+size];
        f(typ, body);
        if typ == b"moov" || typ == b"trak" || typ == b"mdia" || typ == b"minf" || typ == b"stbl" {
            mp4_boxes(b, i + hdr, i + size, depth + 1, f);
        }
        i += size;
    }
}

fn mp4_duration(b: &[u8]) -> Option<f64> {
    let mut found: Option<f64> = None;
    mp4_boxes(b, 0, b.len(), 0, &mut |typ, body| {
        if typ != b"mvhd" || body.len() < 20 { return; }
        let ver = body[0];
        if ver == 1 {
            if body.len() >= 32 {
                let ts = u32::from_be_bytes([body[20],body[21],body[22],body[23]]);
                let dur = u64::from_be_bytes([body[24],body[25],body[26],body[27],body[28],body[29],body[30],body[31]]);
                if ts > 0 { found = Some(dur as f64 / ts as f64); }
            }
        } else if body.len() >= 20 {
            let ts = u32::from_be_bytes([body[12],body[13],body[14],body[15]]);
            let dur = u32::from_be_bytes([body[16],body[17],body[18],body[19]]);
            if ts > 0 { found = Some(dur as f64 / ts as f64); }
        }
    });
    found
}
fn audio_duration_at(p: &str) -> serde_json::Value {
    let path = Path::new(p);
    let Ok(meta) = std::fs::metadata(path) else { return serde_json::json!({ "ok": false, "error": "not found" }); };
    if !meta.is_file() { return serde_json::json!({ "ok": false, "error": "not a file" }); }
    let Ok(mut f) = std::fs::File::open(path) else { return serde_json::json!({ "ok": false, "error": "open failed" }); };
    let mut head = vec![0u8; 65536.min(meta.len() as usize)];
    let n = f.read(&mut head).unwrap_or(0); head.truncate(n);
    let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
    let secs: Option<f64> = match ext.as_str() {
        "wav" | "wave" => wav_duration(&head),
        "flac" => flac_duration(&head),
        "m4a" | "mp4" | "m4b" => mp4_duration(&head),
        "mp3" => mp3_duration(path),
        _ => None,
    };
    match secs {
        Some(s) if s > 0.0 => serde_json::json!({ "ok": true, "seconds": s }),
        Some(s) => serde_json::json!({ "ok": true, "seconds": s }),
        None => serde_json::json!({ "ok": false, "error": "unsupported or invalid audio" }),
    }
}

fn wav_duration(b: &[u8]) -> Option<f64> {
    if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" { return None; }
    let mut i = 12usize;
    let mut byte_rate = 0u32;
    let mut data_size = None;
    while i + 8 <= b.len() {
        let id = &b[i..i + 4];
        let size = u32::from_le_bytes([b[i+4], b[i+5], b[i+6], b[i+7]]) as usize;
        let body = i + 8;
        if id == b"fmt " && body + 16 <= b.len() {
            byte_rate = u32::from_le_bytes([b[body+8], b[body+9], b[body+10], b[body+11]]);
        } else if id == b"data" {
            data_size = Some(size as u64);
            break;
        }
        i = body.saturating_add(size).saturating_add(size % 2);
    }
    let ds = data_size?;
    if byte_rate == 0 { return None; }
    Some(ds as f64 / byte_rate as f64)
}

fn flac_duration(b: &[u8]) -> Option<f64> {
    if b.len() < 42 || &b[0..4] != b"fLaC" { return None; }
    let mut i = 4usize;
    while i + 4 <= b.len() {
        let header = b[i];
        let typ = header & 0x7f;
        let last = header & 0x80 != 0;
        let len = ((b[i+1] as usize) << 16) | ((b[i+2] as usize) << 8) | b[i+3] as usize;
        let body = i + 4;
        if typ == 0 && len >= 34 && body + 34 <= b.len() {
            let s = body + 10;
            let packed = u64::from_be_bytes([b[s], b[s+1], b[s+2], b[s+3], b[s+4], b[s+5], b[s+6], b[s+7]]);
            let sample_rate = ((packed >> 44) & 0xfffff) as u32;
            let total = packed & 0xfffffffff;
            if sample_rate == 0 || total == 0 { return None; }
            return Some(total as f64 / sample_rate as f64);
        }
        if last { break; }
        i = body.saturating_add(len);
    }
    None
}

fn mp3_bitrate(version: u8, index: usize) -> u32 {
    const V1L3: [u32; 15] = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const V2L3: [u32; 15] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    let i = index.min(14);
    if version == 3 { V1L3[i] } else { V2L3[i] }
}

fn mp3_duration(path: &Path) -> Option<f64> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut data = Vec::new();
    f.read_to_end(&mut data).ok()?;
    let mut i = 0usize;
    if data.len() >= 10 && &data[0..3] == b"ID3" {
        let size = (((data[6] & 0x7f) as usize) << 21) | (((data[7] & 0x7f) as usize) << 14) | (((data[8] & 0x7f) as usize) << 7) | (data[9] & 0x7f) as usize;
        i = 10 + size;
    }
    let mut total = 0.0f64;
    let mut frames = 0usize;
    while i + 4 <= data.len() && frames < 2_000_000 {
        if data[i] != 0xff || (data[i+1] & 0xe0) != 0xe0 { i += 1; continue; }
        let b1 = data[i+1]; let b2 = data[i+2];
        let version = (b1 >> 3) & 0x03;
        let layer = (b1 >> 1) & 0x03;
        if layer != 1 || version == 1 { i += 1; continue; }
        let br_idx = ((b2 >> 4) & 0x0f) as usize;
        let sr_idx = ((b2 >> 2) & 0x03) as usize;
        if br_idx == 0 || br_idx == 15 || sr_idx == 3 { i += 1; continue; }
        let sr = match (version, sr_idx) {
            (3, 0) => 44100, (3, 1) => 48000, (3, 2) => 32000,
            (2, 0) => 22050, (2, 1) => 24000, (2, 2) => 16000,
            (0, 0) => 11025, (0, 1) => 12000, (0, 2) => 8000,
            _ => { i += 1; continue; }
        };
        let br = mp3_bitrate(version, br_idx);
        if br == 0 { i += 1; continue; }
        let pad = ((b2 >> 1) & 1) as usize;
        let samples = if version == 3 { 1152.0 } else { 576.0 };
        total += samples / sr as f64;
        let len = if version == 3 { (144 * br as usize * 1000 / sr as usize) + pad } else { (72 * br as usize * 1000 / sr as usize) + pad };
        if len < 4 { i += 1; continue; }
        frames += 1;
        i = i.saturating_add(len);
    }
    if frames == 0 { None } else { Some(total) }
}

#[tauri::command]
fn audio_duration(p: String) -> serde_json::Value { audio_duration_at(&p) }


fn storage_areas(root: &Path) -> Vec<(&'static str, &'static str, &'static str, PathBuf)> {
    vec![
        ("models", "转录/分离模型", "asset", root.join("models")),
        ("soundfonts", "音色库", "asset", root.join("soundfonts")),
        ("voicebanks", "UTAU 声库", "asset", root.join("voicebanks")),
        ("diffsinger", "DiffSinger 运行时", "asset", root.join("diffsinger")),
        ("diffsingerVoicebanks", "DiffSinger 声库", "asset", root.join("diffsinger-voicebanks")),
        ("gpuEnhancements", "GPU 增强包", "asset", root.join("gpu-enhancements")),
        ("cache", "缓存（可重建）", "safe", root.join("cache")),
        ("temp", "临时文件", "safe", root.join("temp")),
        ("logs", "日志", "safe", root.join("logs")),
        ("midi", "曲库（永不清）", "protected", root.join("midi")),
    ]
}

fn storage_report_at(root: &Path) -> serde_json::Value {
    let mut out = Vec::new();
    let mut total = 0u64;
    for (id, label, kind, dir) in storage_areas(root) {
        let exists = dir.is_dir();
        let (bytes, files) = if exists { let (b, f) = dir_bytes_files(&dir); (b, f) } else { (0u64, 0u64) };
        total += bytes;
        out.push(serde_json::json!({ "id": id, "label": label, "path": dir.display().to_string(), "kind": kind, "safe": kind == "safe", "protected": kind == "protected", "exists": exists, "bytes": bytes, "files": files }));
    }
    serde_json::json!({ "areas": out, "totalBytes": total, "updatedAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) })
}

fn dir_bytes_files(dir: &Path) -> (u64, u64) {
    let mut bytes = 0u64;
    let mut files = 0u64;
    fn walk(d: &Path, bytes: &mut u64, files: &mut u64, depth: usize) {
        if depth > 12 { return; }
        let Ok(rd) = std::fs::read_dir(d) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() { walk(&p, bytes, files, depth + 1); }
            else if let Ok(m) = p.metadata() { if m.is_file() { *bytes += m.len(); *files += 1; } }
        }
    }
    walk(dir, &mut bytes, &mut files, 0);
    (bytes, files)
}

fn clear_dir(dir: &Path) -> (u64, u64) {
    let mut bytes = 0u64;
    let mut removed = 0u64;
    let Ok(rd) = std::fs::read_dir(dir) else { return (0, 0) };
    for e in rd.flatten() {
        let p = e.path();
        let (b, _f) = if p.is_dir() { dir_bytes_files(&p) } else { (p.metadata().map(|m| m.len()).unwrap_or(0), 1) };
        let ok = if p.is_dir() { std::fs::remove_dir_all(&p).is_ok() } else { std::fs::remove_file(&p).is_ok() };
        if ok { bytes += b; removed += 1; }
    }
    (bytes, removed)
}

fn prune_logs(dir: &Path, keep: usize) -> (u64, u64) {
    let Ok(rd) = std::fs::read_dir(dir) else { return (0, 0) };
    let mut rows: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_file() { continue; }
        let m = p.metadata().ok();
        let size = m.as_ref().map(|x| x.len()).unwrap_or(0);
        let mtime = m.and_then(|x| x.modified().ok()).unwrap_or(std::time::UNIX_EPOCH);
        rows.push((mtime, size, p));
    }
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    let mut bytes = 0u64;
    let mut removed = 0u64;
    for (_, size, p) in rows.into_iter().skip(keep) {
        if std::fs::remove_file(&p).is_ok() { bytes += size; removed += 1; }
    }
    (bytes, removed)
}

fn storage_cleanup_at(root: &Path, include_assets: bool) -> serde_json::Value {
    let mut freed = 0u64;
    let mut removed: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    for (id, _label, kind, dir) in storage_areas(root) {
        if kind == "protected" { continue; }
        if kind == "asset" && !include_assets { continue; }
        if !dir.is_dir() { continue; }
        if id == "logs" {
            let (b, _n) = prune_logs(&dir, 5);
            if b > 0 { freed += b; removed.push(id.to_string()); }
            continue;
        }
        let (b, n) = clear_dir(&dir);
        if n > 0 { freed += b; removed.push(id.to_string()); }
        if !dir.exists() { errors.push(format!("{id}: directory removed unexpectedly")); }
    }
    serde_json::json!({ "ok": true, "freedBytes": freed, "removed": removed, "errors": errors, "includeAssets": include_assets })
}

#[tauri::command]
fn storage_report() -> serde_json::Value { storage_report_at(&data_dir()) }

#[tauri::command]
fn storage_cleanup(payload: Option<serde_json::Value>) -> serde_json::Value {
    let include = payload.and_then(|p| p.get("includeAssets").and_then(|v| v.as_bool())).unwrap_or(false);
    storage_cleanup_at(&data_dir(), include)
}


fn safe_asset_id(id: &str) -> bool {
    (1..=64).contains(&id.chars().count()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn asset_ext(name: &str) -> String {
    let ext = Path::new(name).extension().and_then(|x| x.to_str()).unwrap_or("");
    let clean: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).take(12).collect();
    if clean.is_empty() { "".to_string() } else { format!(".{}", clean.to_ascii_lowercase()) }
}

fn project_cache_dir(base: &Path, file: &Path) -> PathBuf {
    let stem = file.file_stem().and_then(|x| x.to_str()).unwrap_or("project");
    let mut h: u64 = 0xcbf29ce484222325;
    for b in file.display().to_string().as_bytes() { h ^= *b as u64; h = h.wrapping_mul(0x100000001b3); }
    base.join(format!("{stem}-{h:016x}"))
}

fn project_save_to(target: &Path, json: &serde_json::Value, assets: &[serde_json::Value]) -> serde_json::Value {
    if let Some(parent) = target.parent() { let _ = std::fs::create_dir_all(parent); }
    let file = match std::fs::File::create(target) { Ok(f) => f, Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }) };
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default();
    if let Err(e) = zip.start_file("project.json", opts) { return serde_json::json!({ "ok": false, "error": e.to_string() }); }
    let text = serde_json::to_string_pretty(json).unwrap_or_else(|_| "{}".to_string());
    if let Err(e) = zip.write_all(text.as_bytes()) { return serde_json::json!({ "ok": false, "error": e.to_string() }); }
    let mut missing: Vec<String> = Vec::new();
    for a in assets {
        let id = a.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let name = a.get("fileName").and_then(|v| v.as_str()).unwrap_or("asset");
        if !safe_asset_id(id) { missing.push(name.to_string()); continue; }
        let src = a.get("srcPath").and_then(|v| v.as_str()).unwrap_or("");
        if src.is_empty() || !Path::new(src).is_file() { missing.push(name.to_string()); continue; }
        let bytes = match std::fs::read(src) { Ok(b) => b, Err(_) => { missing.push(name.to_string()); continue; } };
        let entry = format!("files/{}{}", id, asset_ext(name));
        if let Err(e) = zip.start_file(entry, opts) { return serde_json::json!({ "ok": false, "error": e.to_string() }); }
        if let Err(e) = zip.write_all(&bytes) { return serde_json::json!({ "ok": false, "error": e.to_string() }); }
    }
    if let Err(e) = zip.finish() { return serde_json::json!({ "ok": false, "error": e.to_string() }); }
    serde_json::json!({ "ok": true, "filePath": target.display().to_string(), "missing": missing })
}

fn project_open_from_at(target: &Path, cache_base: &Path) -> serde_json::Value {
    let file = match std::fs::File::open(target) { Ok(f) => f, Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }) };
    let mut zip = match zip::ZipArchive::new(file) { Ok(z) => z, Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }) };
    if zip.len() > 4096 { return serde_json::json!({ "ok": false, "error": "too many entries" }); }
    let mut total: u64 = 0;
    for i in 0..zip.len() {
        if let Ok(e) = zip.by_index(i) { total += e.size(); }
        if total > 4 * 1024 * 1024 * 1024 { return serde_json::json!({ "ok": false, "error": "project too large" }); }
    }
    let json: serde_json::Value;
    {
        let mut entry = match zip.by_name("project.json") { Ok(e) => e, Err(_) => return serde_json::json!({ "ok": false, "error": "missing project.json" }) };
        let mut text = String::new();
        if entry.read_to_string(&mut text).is_err() { return serde_json::json!({ "ok": false, "error": "project.json unreadable" }); }
        json = match serde_json::from_str(&text) { Ok(j) => j, Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }) };
    }
    let dir = project_cache_dir(cache_base, target);
    let _ = std::fs::create_dir_all(&dir);
    let allowed: std::collections::BTreeSet<String> = json.get("assets").and_then(|v| v.as_object()).map(|o| o.keys().filter(|k| safe_asset_id(k)).map(|k| k.to_ascii_lowercase()).collect()).unwrap_or_default();
    let mut resolved = serde_json::Map::new();
    for i in 0..zip.len() {
        let mut entry = match zip.by_index(i) { Ok(e) => e, Err(_) => continue };
        let name = entry.name().replace('\\', "/");
        if name.contains("..") || name.starts_with('/') { continue; }
        let Some(rest) = name.strip_prefix("files/") else { continue; };
        let (id, ext) = match rest.find('.') { Some(pos) => (&rest[..pos], &rest[pos..]), None => (rest, "") };
        if !safe_asset_id(id) || !allowed.contains(&id.to_ascii_lowercase()) { continue; }
        let clean_ext: String = ext.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '.').collect();
        let dest = dir.join(format!("{id}{clean_ext}"));
        let mut out = match std::fs::File::create(&dest) { Ok(f) => f, Err(_) => continue };
        if std::io::copy(&mut entry, &mut out).is_ok() { resolved.insert(id.to_string(), serde_json::json!(dest.display().to_string())); }
    }
    serde_json::json!({ "ok": true, "filePath": target.display().to_string(), "json": json, "resolved": resolved, "cacheDir": dir.display().to_string() })
}

#[tauri::command]
fn project_save(app: AppHandle, payload: serde_json::Value) -> serde_json::Value {
    let json = payload.get("json").cloned().unwrap_or(serde_json::Value::Null);
    if !json.is_object() { return serde_json::json!({ "ok": false, "error": "没有可保存的工程数据" }); }
    let mut target = payload.get("filePath").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if target.is_empty() {
        let suggest = payload.get("suggestName").and_then(|v| v.as_str()).unwrap_or("untitled");
        let picked = app.dialog().file().set_title("保存工程").set_file_name(format!("{suggest}.fufumidi")).add_filter("FuFumidi 工程", &["fufumidi"]).blocking_save_file();
        target = match picked.and_then(|p| p.into_path().ok()) { Some(p) => p.display().to_string(), None => return serde_json::json!({ "ok": false, "cancelled": true }) };
    }
    if !target.to_ascii_lowercase().ends_with(".fufumidi") { target.push_str(".fufumidi"); }
    let assets = payload.get("assets").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    project_save_to(Path::new(&target), &json, &assets)
}

#[tauri::command]
fn project_open(app: AppHandle, file_path: Option<String>) -> serde_json::Value {
    let mut target = file_path.unwrap_or_default();
    if target.is_empty() {
        let picked = app.dialog().file().set_title("打开工程").add_filter("FuFumidi 工程", &["fufumidi"]).blocking_pick_file();
        target = match picked.and_then(|p| p.into_path().ok()) { Some(p) => p.display().to_string(), None => return serde_json::json!({ "ok": false, "cancelled": true }) };
    }
    project_open_from_at(Path::new(&target), &data_dir().join("cache").join("project-assets"))
}




fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], if chunk.len() > 1 { chunk[1] } else { 0 }, if chunk.len() > 2 { chunk[2] } else { 0 }];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

fn read_sidecar_lyrics_at(file_path: &str) -> serde_json::Value {
    let path = Path::new(file_path);
    let dir = match path.parent() { Some(d) => d, None => return serde_json::json!({ "ok": false, "error": "no path" }) };
    let stem = path.file_stem().and_then(|x| x.to_str()).unwrap_or("");
    for name in [format!("{stem}.lrc"), format!("{stem}.LRC")] {
        let cand = dir.join(name);
        if let Ok(bytes) = std::fs::read(&cand) {
            return serde_json::json!({ "ok": true, "path": cand.display().to_string(), "b64": base64_encode(&bytes), "bytes": bytes.len() });
        }
    }
    serde_json::json!({ "ok": false, "error": "not found" })
}

#[tauri::command]
fn read_sidecar_lyrics(file_path: String) -> serde_json::Value { read_sidecar_lyrics_at(&file_path) }

fn reveal_target(p: &str) -> (String, bool) {
    if !p.trim().is_empty() && in_midi_root(p) && Path::new(p).exists() {
        return (p.to_string(), false);
    }
    (midi_root().display().to_string(), true)
}

fn copy_asset_files(src: &str, dest: &str) -> serde_json::Value {
    if src.is_empty() || dest.is_empty() { return serde_json::json!({ "ok": false, "error": "missing src/dest" }); }
    if !Path::new(src).exists() { return serde_json::json!({ "ok": false, "error": "source not found" }); }
    if let Some(parent) = Path::new(dest).parent() { let _ = std::fs::create_dir_all(parent); }
    match std::fs::copy(src, dest) {
        Ok(_) => serde_json::json!({ "ok": true, "savedTo": dest }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command]
fn copy_asset(src: String, dest: String) -> serde_json::Value { copy_asset_files(&src, &dest) }

#[tauri::command]
fn open_folder(p: String) -> serde_json::Value {
    let target = PathBuf::from(&p);
    if !target.is_dir() { return serde_json::json!({ "ok": false, "error": "not a directory" }); }
    #[cfg(target_os = "windows")]
    {
        match std::process::Command::new("explorer").arg(&target).spawn() {
            Ok(_) => serde_json::json!({ "ok": true, "path": target.display().to_string() }),
            Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
        }
    }
    #[cfg(not(target_os = "windows"))]
    { serde_json::json!({ "ok": false, "error": "unsupported platform" }) }
}

#[tauri::command]
fn reveal_midi(p: Option<String>) -> serde_json::Value {
    let (target, fell_back) = reveal_target(p.as_deref().unwrap_or(""));
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("explorer");
        if !fell_back { cmd.arg("/select,").arg(&target); } else { cmd.arg(&target); }
        match cmd.spawn() {
            Ok(_) => serde_json::json!({ "ok": true, "path": target, "fellBackToDir": fell_back }),
            Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
        }
    }
    #[cfg(not(target_os = "windows"))]
    { serde_json::json!({ "ok": false, "error": "unsupported platform" }) }
}


fn autosave_safe_id(doc_id: &str) -> String {
    let ok = (1..=120).contains(&doc_id.chars().count())
        && doc_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-');
    if ok { return doc_id.to_string(); }
    let mut h: u64 = 0xcbf29ce484222325;
    for b in doc_id.as_bytes() { h ^= *b as u64; h = h.wrapping_mul(0x100000001b3); }
    format!("h_{h:016x}")
}

fn autosave_write_at(root: &Path, doc_id: &str, model: &serde_json::Value, meta: &serde_json::Value) -> serde_json::Value {
    let dir = root.join("autosave");
    let _ = std::fs::create_dir_all(&dir);
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let payload = serde_json::json!({
        "format": "fufumidi-autosave", "version": 1, "docId": doc_id, "ts": ts,
        "meta": meta, "data": model
    });
    let text = match serde_json::to_string(&payload) { Ok(s) => s, Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }) };
    let bytes = text.len();
    if bytes > 32 * 1024 * 1024 { return serde_json::json!({ "ok": false, "error": "draft too large" }); }
    let file = dir.join(format!("{}.json", autosave_safe_id(doc_id)));
    let tmp = file.with_extension("json.tmp");
    if let Err(e) = std::fs::write(&tmp, &text) { return serde_json::json!({ "ok": false, "error": e.to_string() }); }
    match std::fs::rename(&tmp, &file) {
        Ok(_) => serde_json::json!({ "ok": true, "path": file.display().to_string(), "ts": ts, "bytes": bytes }),
        Err(e) => { let _ = std::fs::remove_file(&tmp); serde_json::json!({ "ok": false, "error": e.to_string() }) }
    }
}

fn autosave_entries_at(root: &Path) -> Vec<serde_json::Value> {
    let dir = root.join("autosave");
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(&dir) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_file() || p.extension().and_then(|x| x.to_str()) != Some("json") { continue; }
        let Ok(raw) = std::fs::read_to_string(&p) else { continue };
        let Ok(j) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
        if j.get("format").and_then(|v| v.as_str()) != Some("fufumidi-autosave") { continue; }
        let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        out.push(serde_json::json!({ "docId": j.get("docId").cloned().unwrap_or(serde_json::json!("")), "id": p.file_stem().and_then(|x| x.to_str()).unwrap_or(""), "ts": j.get("ts").cloned().unwrap_or(serde_json::json!(0)), "meta": j.get("meta").cloned().unwrap_or(serde_json::json!({})), "bytes": size, "path": p.display().to_string() }));
    }
    out.sort_by(|a, b| b["ts"].as_u64().unwrap_or(0).cmp(&a["ts"].as_u64().unwrap_or(0)));
    out
}

fn autosave_read_at(root: &Path, doc_id: &str) -> serde_json::Value {
    for entry in autosave_entries_at(root) {
        if entry["docId"].as_str() != Some(doc_id) { continue; }
        let path = entry["path"].as_str().unwrap_or("");
        let Ok(raw) = std::fs::read_to_string(path) else { continue };
        let Ok(j) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
        return serde_json::json!({ "ok": true, "docId": doc_id, "ts": j.get("ts").cloned().unwrap_or(serde_json::json!(0)), "meta": j.get("meta").cloned().unwrap_or(serde_json::json!({})), "data": j.get("data").cloned().unwrap_or(serde_json::Value::Null), "path": path });
    }
    serde_json::json!({ "ok": false, "error": "not found" })
}

#[tauri::command]
fn autosave_write(payload: serde_json::Value) -> serde_json::Value {
    let doc_id = payload.get("docId").and_then(|v| v.as_str()).unwrap_or("");
    if doc_id.is_empty() { return serde_json::json!({ "ok": false, "error": "missing docId" }); }
    let model = payload.get("model").cloned().unwrap_or(serde_json::Value::Null);
    let meta = payload.get("meta").cloned().unwrap_or_else(|| serde_json::json!({}));
    autosave_write_at(&data_dir().join("temp"), doc_id, &model, &meta)
}

#[tauri::command]
fn autosave_list() -> Vec<serde_json::Value> { autosave_entries_at(&data_dir().join("temp")) }

#[tauri::command]
fn autosave_read(doc_id: String) -> serde_json::Value { autosave_read_at(&data_dir().join("temp"), &doc_id) }

fn autosave_clear_at(root: &Path, doc_id: &str) -> serde_json::Value {
    let mut removed = false;
    for entry in autosave_entries_at(root) {
        if entry["docId"].as_str() == Some(doc_id) {
            if let Some(p) = entry["path"].as_str() { if std::fs::remove_file(p).is_ok() { removed = true; } }
        }
    }
    serde_json::json!({ "ok": true, "removed": removed })
}

#[tauri::command]
fn autosave_clear(doc_id: String) -> serde_json::Value {
    autosave_clear_at(&data_dir().join("temp"), &doc_id)
}


fn desktop_dir() -> Option<PathBuf> {
    let base = std::env::var("USERPROFILE").ok().map(PathBuf::from)?;
    let one = base.join("Desktop");
    if one.is_dir() { return Some(one); }
    let od = base.join("OneDrive").join("Desktop");
    if od.is_dir() { return Some(od); }
    Some(one)
}

/// 与 Electron wallpaper:defaults 同语义：桌面上的视频，最多 4 个，按名称排序。
fn desktop_video_files(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_file() { continue; }
        if let Some(ext) = p.extension().and_then(|x| x.to_str()) {
            let ext = ext.to_ascii_lowercase();
            if ext == "mp4" || ext == "webm" || ext == "mov" { out.push(p.display().to_string()); }
        }
    }
    out.sort();
    out.truncate(4);
    out
}

fn data_root_entry(root: &Path, key: &str, label: &str) -> serde_json::Value {
    let dir = root.join(key);
    let exists = dir.is_dir();
    let size = if exists { dir_size(&dir) } else { 0 };
    serde_json::json!({
        "key": key, "label": label, "dir": dir.display().to_string(), "exists": exists,
        "legacyDir": serde_json::Value::Null, "pending": false, "conflict": false,
        "size": size, "sizePartial": false
    })
}

fn data_root_overview(root: &Path) -> serde_json::Value {
    let defs = [
        ("models", "模型权重"), ("gpu-enhancements", "GPU 增强包"), ("soundfonts", "音色库"),
        ("voicebanks", "UTAU 声库"), ("diffsinger", "DiffSinger 组件"),
        ("diffsinger-voicebanks", "DiffSinger 声库"), ("midi", "MIDI 曲库文件"),
        ("cache", "第三方缓存"), ("temp", "中间产物"),
    ];
    let entries: Vec<serde_json::Value> = defs.iter().map(|(k, l)| data_root_entry(root, k, l)).collect();
    serde_json::json!({
        "ok": true, "root": root.display().to_string(), "reason": "tauri-data-root",
        "from": "FUFUMIDI_DATA_ROOT/默认安装目录旁", "entries": entries, "migration": serde_json::Value::Null
    })
}

fn clamp_zoom(f: f64) -> f64 {
    if !f.is_finite() { return 1.0; }
    (f * 100.0).round().clamp(50.0, 300.0) / 100.0
}

#[tauri::command]
fn get_zoom_factor(state: State<'_, ZoomState>) -> serde_json::Value {
    let f = *state.0.lock().unwrap_or_else(|e| e.into_inner());
    serde_json::json!({ "ok": true, "factor": f })
}

#[tauri::command]
fn set_zoom_factor(window: tauri::WebviewWindow, state: State<'_, ZoomState>, f: f64) -> serde_json::Value {
    let factor = clamp_zoom(f);
    match window.set_zoom(factor) {
        Ok(_) => {
            *state.0.lock().unwrap_or_else(|e| e.into_inner()) = factor;
            serde_json::json!({ "ok": true, "factor": factor })
        }
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string(), "factor": factor }),
    }
}

#[tauri::command]
fn set_full_screen(window: tauri::WebviewWindow, on: bool) -> serde_json::Value {
    match window.set_fullscreen(on) {
        Ok(_) => serde_json::json!({ "ok": true, "fullscreen": on }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command]
fn data_root() -> serde_json::Value { data_root_overview(&data_dir()) }

#[tauri::command]
fn open_data_root(sub: Option<String>) -> serde_json::Value {
    let root = data_dir();
    let sub = sub.unwrap_or_default();
    let mut target = root.clone();
    if !sub.is_empty() && !sub.contains('/') && !sub.contains('\\') && sub != "." && sub != ".." {
        let cand = root.join(&sub);
        if cand.exists() { target = cand; }
    }
    #[cfg(target_os = "windows")]
    {
        match Command::new("explorer").arg(&target).spawn() {
            Ok(_) => serde_json::json!({ "ok": true, "dir": target.display().to_string() }),
            Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
        }
    }
    #[cfg(not(target_os = "windows"))]
    { serde_json::json!({ "ok": false, "error": "unsupported platform" }) }
}

fn clean_temp_dir(dir: &Path) -> u64 {
    let mut freed = 0u64;
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    for e in rd.flatten() {
        let p = e.path();
        let sz = if p.is_dir() { dir_size(&p) } else { e.metadata().map(|m| m.len()).unwrap_or(0) };
        if p.is_dir() { let _ = std::fs::remove_dir_all(&p); } else { let _ = std::fs::remove_file(&p); }
        freed += sz;
    }
    freed
}

#[tauri::command]
fn clean_temp() -> serde_json::Value {
    let dir = data_dir().join("temp");
    let _ = std::fs::create_dir_all(&dir);
    let freed = clean_temp_dir(&dir);
    serde_json::json!({ "ok": true, "freed": freed, "dir": dir.display().to_string() })
}

#[tauri::command]
fn wallpaper_defaults() -> serde_json::Value {
    match desktop_dir() {
        Some(d) => serde_json::json!({ "ok": true, "files": desktop_video_files(&d) }),
        None => serde_json::json!({ "ok": false, "files": [] }),
    }
}

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

fn in_midi_root(p: &str) -> bool {
    let root = midi_root();
    let root_canon = root.canonicalize().unwrap_or(root);
    match PathBuf::from(p).canonicalize() {
        Ok(c) => c.starts_with(&root_canon),
        Err(_) => false,
    }
}

fn top_level_midi_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_file() { continue; }
        if let Some(ext) = p.extension().and_then(|x| x.to_str()) {
            let e = ext.to_ascii_lowercase();
            if e == "mid" || e == "midi" { out.push(p); }
        }
    }
    out.sort();
    out
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes { h ^= *b as u64; h = h.wrapping_mul(0x100000001b3); }
    h
}

fn verify_midi_at(dir: &Path) -> serde_json::Value {
    let files = top_level_midi_files(dir);
    let mut rows = Vec::new();
    let mut bad = Vec::new();
    let mut total_notes = 0usize;
    let mut total_bytes = 0u64;
    for p in files {
        let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        total_bytes += size;
        let row = match std::fs::read(&p) {
            Ok(bytes) => match fufumidi_core::parse_smf(&bytes) {
                Ok(smf) => match fufumidi_core::analyze_file(&smf) {
                    Ok(st) => {
                        total_notes += st.notes;
                        serde_json::json!({
                            "file": p.display().to_string(), "ok": true, "error": "", "size": size,
                            "format": st.format, "tracks": st.tracks, "notes": st.notes, "bpm": st.bpm,
                            "minMidi": st.min_midi, "maxMidi": st.max_midi, "avgVel": st.avg_vel
                        })
                    }
                    Err(e) => serde_json::json!({ "file": p.display().to_string(), "ok": false, "error": e.to_string(), "size": size }),
                },
                Err(e) => serde_json::json!({ "file": p.display().to_string(), "ok": false, "error": e.to_string(), "size": size }),
            },
            Err(e) => serde_json::json!({ "file": p.display().to_string(), "ok": false, "error": e.to_string(), "size": size }),
        };
        if row.get("ok").and_then(|v| v.as_bool()) != Some(true) { bad.push(row.clone()); }
        rows.push(row);
    }
    serde_json::json!({
        "ok": true, "engine": "rust", "dir": dir.display().to_string(),
        "count": rows.len(), "badCount": bad.len(), "totalNotes": total_notes,
        "totalBytes": total_bytes, "files": rows, "bad": bad
    })
}

fn dupe_midi_at(dir: &Path) -> serde_json::Value {
    let mut rows = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return serde_json::json!({ "ok": true, "engine": "rust", "dir": dir.display().to_string(), "count": 0, "dupeGroups": 0, "dupeFiles": 0, "groups": [] });
    };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_file() { continue; }
        let Some(ext) = p.extension().and_then(|x| x.to_str()) else { continue };
        let ext = ext.to_ascii_lowercase();
        if !matches!(ext.as_str(), "mid" | "midi" | "sf2" | "sf3" | "wav" | "mp3" | "flac") { continue; }
        if let Ok(bytes) = std::fs::read(&p) {
            rows.push((p.display().to_string(), fnv1a(&bytes), bytes.len()));
        }
    }
    let mut map: std::collections::BTreeMap<(u64, usize), Vec<serde_json::Value>> = std::collections::BTreeMap::new();
    for (file, hash, size) in &rows {
        map.entry((*hash, *size)).or_default().push(serde_json::json!({ "file": file, "size": size }));
    }
    let groups: Vec<serde_json::Value> = map.into_values().filter(|g| g.len() > 1).map(serde_json::Value::Array).collect();
    let dupe_files = groups.iter().map(|g| g.as_array().map(|a| a.len().saturating_sub(1)).unwrap_or(0)).sum::<usize>();
    serde_json::json!({
        "ok": true, "engine": "rust", "dir": dir.display().to_string(), "count": rows.len(),
        "dupeGroups": groups.len(), "dupeFiles": dupe_files, "groups": groups
    })
}

fn has_midi_at(root: &Path, p: &str) -> serde_json::Value {
    let root_canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let ok = PathBuf::from(p).canonicalize().map(|c| {
        c.starts_with(&root_canon) && std::fs::metadata(&c).map(|m| m.is_file() && m.len() > 0).unwrap_or(false)
    }).unwrap_or(false);
    let size = if ok { std::fs::metadata(p).map(|m| m.len()).unwrap_or(0) } else { 0 };
    serde_json::json!({ "ok": true, "exists": ok, "size": size })
}

#[tauri::command]
fn has_midi(p: String) -> serde_json::Value {
    if p.trim().is_empty() { return serde_json::json!({ "ok": true, "exists": false, "size": 0 }); }
    has_midi_at(&midi_root(), &p)
}

#[tauri::command]
fn verify_midi() -> serde_json::Value { verify_midi_at(&midi_root()) }

#[tauri::command]
fn dupe_midi() -> serde_json::Value { dupe_midi_at(&midi_root()) }

#[tauri::command]
fn delete_midi(p: String) -> serde_json::Value {
    if p.trim().is_empty() { return serde_json::json!({ "ok": true, "deleted": false }); }
    if !in_midi_root(&p) { return serde_json::json!({ "ok": false, "error": "只能删除曲库目录内的文件" }); }
    if !Path::new(&p).exists() { return serde_json::json!({ "ok": true, "deleted": false }); }
    match std::fs::remove_file(&p) {
        Ok(_) => serde_json::json!({ "ok": true, "deleted": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

fn sanitize_rename(base: &str) -> String {
    let mut s = base.to_string();
    for ch in ['\\', '/', ':', '*', '?', '"', '<', '>', '|'] { s = s.replace(ch, " "); }
    s = s.replace(['\r', '\n', '\t'], " ");
    s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    s = s.trim_end_matches(|c: char| c == '.' || c == ' ').trim().to_string();
    if s.chars().count() > 120 { s = s.chars().take(120).collect(); }
    s
}

#[tauri::command]
fn rename_midi(p: String, new_name: String) -> serde_json::Value {
    let src = PathBuf::from(&p);
    if !src.is_file() { return serde_json::json!({ "ok": false, "error": "文件不存在" }); }
    if !in_midi_root(&p) { return serde_json::json!({ "ok": false, "error": "只能重命名曲库目录内的文件" }); }
    let dir = src.parent().map(|x| x.to_path_buf()).unwrap_or_else(midi_root);
    let ext = src.extension().and_then(|x| x.to_str()).map(|x| format!(".{x}")).unwrap_or_else(|| ".mid".to_string());
    let base = sanitize_rename(&new_name);
    if base.is_empty() { return serde_json::json!({ "ok": false, "error": "名字不能为空" }); }
    let src_canon = src.canonicalize().unwrap_or(src.clone());
    let mut dst = dir.join(format!("{base}{ext}"));
    let mut n = 2;
    while dst.exists() {
        let dst_canon = dst.canonicalize().unwrap_or(dst.clone());
        if dst_canon == src_canon {
            return serde_json::json!({ "ok": true, "path": src.display().to_string(), "renamed": false });
        }
        dst = dir.join(format!("{base} ({n}){ext}"));
        n += 1;
    }
    match std::fs::rename(&src, &dst) {
        Ok(_) => serde_json::json!({ "ok": true, "path": dst.display().to_string(), "renamed": true, "from": p }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
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
fn db_playlists_delete(id: String) -> bool {
    open_db().map(|conn| conn.execute("DELETE FROM playlists WHERE id = ?1", params![id]).is_ok()).unwrap_or(false)
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

fn is_audio_ext(ext: &str) -> bool {
    matches!(ext.to_ascii_lowercase().as_str(),
        "mp3" | "wav" | "flac" | "m4a" | "aac" | "ogg" | "oga" | "opus" | "wma"
        | "mp4" | "mkv" | "avi" | "mov" | "webm" | "aiff" | "aif" | "au" | "snd"
        | "caf" | "m4v" | "m4s" | "ts" | "mpg" | "mpeg" | "flv" | "3gp" | "amr" | "mka")
}

fn walk_audio_files(dir: &Path) -> Vec<String> {
    fn walk(d: &Path, out: &mut Vec<String>, depth: usize) {
        if out.len() >= 2000 || depth > 8 { return; }
        let Ok(rd) = std::fs::read_dir(d) else { return };
        for e in rd.flatten() {
            if out.len() >= 2000 { return; }
            let p = e.path();
            if p.is_dir() { walk(&p, out, depth + 1); }
            else if p.is_file() {
                if let Some(ext) = p.extension().and_then(|x| x.to_str()) {
                    if is_audio_ext(ext) { out.push(p.display().to_string()); }
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, &mut out, 0);
    out.sort();
    out
}

#[tauri::command]
fn list_audio_files(dir: String) -> Vec<String> {
    if dir.trim().is_empty() { return Vec::new(); }
    walk_audio_files(Path::new(&dir))
}

fn library_stats_of(dir: &Path) -> (u64, u64) {
    let mut count = 0u64;
    let mut bytes = 0u64;
    let Ok(rd) = std::fs::read_dir(dir) else { return (0, 0) };
    for e in rd.flatten() {
        if let Ok(m) = e.metadata() {
            if m.is_file() { count += 1; bytes += m.len(); }
        }
    }
    (count, bytes)
}

#[tauri::command]
fn library_stats() -> serde_json::Value {
    let dir = midi_root();
    let (count, bytes) = library_stats_of(&dir);
    serde_json::json!({ "ok": true, "dir": dir.display().to_string(), "count": count, "bytes": bytes })
}

#[tauri::command]
fn read_soundfont(p: String) -> Result<tauri::ipc::Response, String> {
    let path = Path::new(&p);
    let m = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if !m.is_file() { return Err("not a file".to_string()); }
    if m.len() > 512 * 1024 * 1024 { return Err("soundfont too large".to_string()); }
    std::fs::read(path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
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

fn save_binary_bytes(opts: &serde_json::Value) -> Vec<u8> {
    for key in ["data", "bytes"] {
        match opts.get(key) {
            Some(serde_json::Value::Array(a)) => return a.iter().map(|x| x.as_u64().unwrap_or(0) as u8).collect(),
            Some(serde_json::Value::String(s)) => return s.as_bytes().to_vec(),
            _ => {}
        }
    }
    Vec::new()
}

#[tauri::command]
fn save_binary(app: AppHandle, opts: serde_json::Value) -> serde_json::Value {
    let bytes = save_binary_bytes(&opts);
    if bytes.is_empty() { return serde_json::json!({ "ok": false, "canceled": false, "error": "missing bytes" }); }
    let name = opts.get("name").and_then(|v| v.as_str()).unwrap_or("download.bin");
    let mut path = opts.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if path.is_empty() {
        let ext = Path::new(name).extension().and_then(|x| x.to_str()).unwrap_or("");
        let filter = if ext.eq_ignore_ascii_case("wav") { "WAV 音频" } else if ext.eq_ignore_ascii_case("mid") || ext.eq_ignore_ascii_case("midi") { "MIDI 音频" } else { "文件" };
        let exts: &[&str] = if ext.is_empty() { &["*"] } else { &[ext] };
        let picked = app.dialog().file().set_title("保存文件").set_file_name(name).add_filter(filter, exts).blocking_save_file();
        path = match picked.and_then(file_path_string) { Some(p) => p, None => return serde_json::json!({ "ok": false, "canceled": true }) };
    }
    if let Some(parent) = Path::new(&path).parent() { let _ = std::fs::create_dir_all(parent); }
    match std::fs::write(&path, &bytes) {
        Ok(_) => serde_json::json!({ "ok": true, "path": path }),
        Err(e) => serde_json::json!({ "ok": false, "canceled": false, "error": e.to_string() }),
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
struct ZoomState(Arc<Mutex<f64>>);

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
fn probe() -> serde_json::Value { engine_probe() }

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
    let zoom_state = ZoomState(Arc::new(Mutex::new(1.0)));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .manage(zoom_state)
        .invoke_handler(tauri::generate_handler![
            host_info, app_version, ping, python_selfcheck, engine_probe,
            load_settings, save_settings, db_kv_get, db_kv_set,
            db_status, db_songs_list, db_songs_put, db_songs_delete, db_playlists_list, db_playlists_put, db_playlists_delete, check_midi, has_midi, verify_midi, dupe_midi, delete_midi, rename_midi, wallpaper_defaults, data_root, open_data_root, clean_temp, get_zoom_factor, set_zoom_factor, set_full_screen, autosave_write, autosave_list, autosave_read, autosave_clear, read_sidecar_lyrics, reveal_midi, copy_asset, open_folder, project_save, project_open, storage_report, storage_cleanup, audio_duration, export_audio, export_stems_zip, pick_cover, export_dawproject, autostart_get, autostart_set, diag_health, pick_model_archive, model_import_local, clear_user_data, check_integrity, repair_integrity, write_midi, write_binary, usermeta_list, usermeta_set, usermeta_remove, usermeta_reorder, usermeta_pin, wallpaper_list, wallpaper_add_local, wallpaper_remove_local, wallpaper_scan_folder, file_assoc, wallpaper_set_desktop, gpu_status, gpu_uninstall, plugins_list, plugins_rescan, plugins_set_enabled, plugins_open_dir, plugins_open_docs, open_edit_guide, sf_workshop_list, sf_workshop_import, sf_workshop_delete, sf_workshop_open_dir, model_list,
            soundfont_list, dep_check, diag_export, notify, open_output, open_external,
            presets_list, presets_save, presets_delete, presets_last_used, presets_set_model,
            presets_reorder, presets_reorder_to, presets_restore,
            pick_file, pick_directory, pick_audio, pick_audio_files, pick_image, pick_music_xml,
            list_midi_files, list_audio_files, library_stats, read_soundfont, read_binary, save_binary,
            convert, probe, refine, cancel, set_transcribe_pause, engine_worker_status
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
    use std::io::{Read, Write};
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("fufumidi-checkmidi-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn save_binary_bytes_parsing() {
        assert_eq!(super::save_binary_bytes(&serde_json::json!({ "data": [1,2] })), vec![1,2]);
        assert_eq!(super::save_binary_bytes(&serde_json::json!({ "bytes": "ab" })), b"ab".to_vec());
        assert!(super::save_binary_bytes(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn wallpaper_set_desktop_plan() {
        let plan = super::wallpaper_set_desktop_plan("C:\\wall\\a.jpg");
        assert_eq!(plan.len(), 3);
        assert_eq!(plan[0][0], "add");
        assert!(plan[0].join(" ").contains("Wallpaper"));
        assert!(plan[0].join(" ").contains("C:\\wall\\a.jpg"));
        assert_eq!(super::wallpaper_set_desktop("C:\\definitely-missing.jpg".into())["ok"], false);
    }

    #[test]
    fn refine_args_shape() {
        let req = serde_json::json!({ "audio": "a.wav", "midi": "m.mid", "mode": "vocal", "stemBalance": true, "onsetWin": 0.1, "pitchCheck": true, "quantize": false });
        let args = super::refine_args(&req, "out.mid");
        let joined = args.join(" ");
        assert!(joined.contains("refine --audio a.wav --midi m.mid -o out.mid"));
        assert!(joined.contains("--mode vocal"));
        assert!(joined.contains("--stem-balance on"));
        assert!(joined.contains("--onset-win 0.1"));
        assert!(joined.contains("--pitch-check on"));
        assert!(joined.contains("--quantize off"));
    }

    #[test]
    fn doc_sources_exist() {
        assert!(super::doc_source("plugin").is_some());
        assert!(super::doc_source("edit").is_some());
    }

    #[test]
    fn model_delete_paths() {
        let root = tmpdir("model-delete");
        std::fs::create_dir_all(root.join("muscriptor/small")).unwrap();
        std::fs::write(root.join("muscriptor/small/model.safetensors"), b"m").unwrap();
        assert_eq!(super::model_delete_at(&root, "muscriptor_small")["ok"], true);
        assert!(!root.join("muscriptor/small").exists());
        assert_eq!(super::model_delete_at(&root, "nope")["ok"], false);
        assert_eq!(super::model_delete_at(&root, "rvc:x")["ok"], false);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn model_import_zip_traversal_and_stems_limit() {
        let root = tmpdir("model-security");
        let archive = root.join("muscriptor_small.zip");
        {
            let f = std::fs::File::create(&archive).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("../evil.onnx", opts).unwrap();
            w.write_all(b"evil").unwrap();
            w.start_file("muscriptor/small/w.onnx", opts).unwrap();
            w.write_all(b"ok").unwrap();
            w.finish().unwrap();
        }
        let models = root.join("models");
        let r = super::model_import_local_at(&archive, &models);
        assert_eq!(r["ok"], true);
        assert!(!root.join("evil.onnx").exists());
        assert!(models.join("muscriptor/small/w.onnx").exists());
        let too_many: Vec<serde_json::Value> = (0..101).map(|_| serde_json::json!({ "name": "a", "ext": "wav", "bytes": [1] })).collect();
        let z = root.join("many.zip");
        assert_eq!(super::write_stems_zip_at(&z, &too_many, "many.zip")["ok"], false);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn soundfont_workshop_list() {
        let root = tmpdir("sf-root");
        let bundled = tmpdir("sf-bundled");
        let f = std::fs::File::create(bundled.join("GeneralUser.sf2")).unwrap();
        f.set_len(26_000_000).unwrap();
        std::fs::write(root.join("custom.sf2"), b"sf2").unwrap();
        let r = super::sf_workshop_list_at(&root, Some(&bundled));
        assert_eq!(r["registry"].as_array().unwrap().len(), 20);
        let gu = r["registry"].as_array().unwrap().iter().find(|x| x["id"] == "generaluser_gs").unwrap();
        assert_eq!(gu["source"], "builtin");
        assert_eq!(gu["downloaded"], true);
        assert_eq!(r["customs"].as_array().unwrap().len(), 1);
        let src = bundled.join("imported.sf2");
        std::fs::write(&src, b"sf2").unwrap();
        let imp = super::sf_workshop_import_at(&root, src.to_str().unwrap());
        assert_eq!(imp["ok"], true);
        assert_eq!(super::sf_workshop_delete_at(&root, "custom:imported.sf2")["ok"], true);
        assert!(!root.join("imported.sf2").exists());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(bundled);
    }

    #[test]
    fn plugins_parse_and_enable() {
        let fixture = "{\"ok\": true, \"plugins\": [{\"id\": \"a\"}, {\"id\": \"b\"}]}";
        let list = super::plugins_from_output(fixture, &["a".to_string()]);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["enabled"], true);
        assert_eq!(list[1]["enabled"], false);
        let root = tmpdir("plugins-settings");
        let sp = root.join("settings.json");
        std::fs::write(&sp, "{}").unwrap();
        assert_eq!(super::plugins_set_enabled_at(&sp, "a", true)["ok"], true);
        let s: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&sp).unwrap()).unwrap();
        assert_eq!(s["plugins_enabled"][0], "a");
        assert_eq!(super::plugins_set_enabled_at(&sp, "a", false)["ok"], true);
        let s2: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&sp).unwrap()).unwrap();
        assert_eq!(s2["plugins_enabled"].as_array().unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn gpu_status_and_uninstall() {
        let root = tmpdir("gpu");
        std::fs::create_dir_all(root.join("cuda")).unwrap();
        let st = super::gpu_status_at(&root);
        assert_eq!(st["ok"], true);
        assert_eq!(st["kinds"].as_array().unwrap().len(), 1);
        assert_eq!(st["kinds"][0], "cuda");
        assert_eq!(st["cuda"], true);
        assert_eq!(super::gpu_uninstall_at(&root, "cuda")["removed"], true);
        assert!(!root.join("cuda").exists());
        assert_eq!(super::gpu_uninstall_at(&root, "nope")["ok"], false);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn file_assoc_plan_shape() {
        let on = super::file_assoc_plan(true);
        assert_eq!(on.len(), 4);
        assert!(on[0].join(" ").contains("FuFumidi.MIDI"));
        assert!(on.iter().any(|a| a.iter().any(|x| x.contains(".mid"))));
        let off = super::file_assoc_plan(false);
        assert_eq!(off.len(), 3);
        assert_eq!(off[0][0], "delete");
        assert!(super::file_assoc_icon().ends_with('"'));
    }

    #[test]
    fn wallpaper_scan_folder() {
        let root = tmpdir("wallpaper-scan");
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(root.join("a.jpg"), b"img").unwrap();
        std::fs::write(sub.join("b.mp4"), b"vid").unwrap();
        std::fs::write(root.join("c.txt"), b"x").unwrap();
        std::fs::write(root.join("zero.mp4"), b"").unwrap();
        let r = super::wallpaper_scan_folder_at(&root);
        assert_eq!(r["ok"], true);
        let list = r["list"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["name"], "a.jpg");
        assert_eq!(list[1]["kind"], "video");
        assert_eq!(super::wallpaper_scan_folder_at(&root.join("none"))["ok"], false);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn wallpaper_local_roundtrip() {
        let root = tmpdir("wallpaper-local");
        let src = root.join("src.mp4");
        std::fs::write(&src, b"video").unwrap();
        let dir = root.join("wallpapers");
        let a = super::wallpaper_add_local_at(&dir, src.to_str().unwrap());
        assert_eq!(a["ok"], true);
        assert_eq!(a["name"], "src.mp4");
        let list = super::wallpaper_list_at(&dir);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["local"], true);
        assert_eq!(super::wallpaper_remove_local_at(&dir, "../src.mp4")["ok"], false);
        assert_eq!(super::wallpaper_remove_local_at(&dir, "src.mp4")["removed"], true);
        assert!(super::wallpaper_list_at(&dir).is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn usermeta_roundtrip() {
        let root = tmpdir("usermeta");
        let r = super::usermeta_set_at(&root, "model", "m1", &serde_json::json!({ "name": " X ", "tags": ["a", "a", ""], "pinned": true, "order": 2 }));
        assert_eq!(r["ok"], true);
        assert_eq!(r["item"]["name"], "X");
        assert_eq!(r["item"]["tags"].as_array().unwrap().len(), 1);
        let list = super::usermeta_load_at(&root);
        assert_eq!(list["items"]["model:m1"]["pinned"], true);
        assert_eq!(super::usermeta_reorder_at(&root, "model", &["m1".to_string()])["ok"], true);
        assert_eq!(super::usermeta_load_at(&root)["items"]["model:m1"]["order"], 1);
        assert_eq!(super::usermeta_set_at(&root, "model", "m1", &serde_json::json!({ "pinned": false }))["ok"], true);
        assert!(super::usermeta_load_at(&root)["items"]["model:m1"].get("pinned").is_none());
        assert_eq!(super::usermeta_remove_at(&root, "model", "m1")["ok"], true);
        std::fs::write(root.join("usermeta.json"), "bad json").unwrap();
        let list2 = super::usermeta_load_at(&root);
        assert_eq!(list2["items"].as_object().unwrap().len(), 0);
        assert!(std::fs::read_dir(&root).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().contains("usermeta.corrupt-")));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn write_midi_and_binary() {
        let root = tmpdir("write-midi");
        let a = super::write_midi_at(&root, &serde_json::json!({ "name": "a:b", "bytes": [1,2,3] }));
        assert_eq!(a["ok"], true);
        assert_eq!(std::fs::read(a["path"].as_str().unwrap()).unwrap(), vec![1,2,3]);
        let same = super::write_midi_at(&root, &serde_json::json!({ "name": "a:b", "bytes": [1,2,3] }));
        assert_eq!(same["existed"], true);
        let diff = super::write_midi_at(&root, &serde_json::json!({ "name": "a:b", "bytes": [4] }));
        assert_eq!(diff["existed"], false);
        assert!(diff["path"].as_str().unwrap().contains("a_b (2).mid"));
        let bin = root.join("out/raw.wav");
        let w = super::write_binary(bin.display().to_string(), serde_json::json!([82,73]));
        assert_eq!(w["ok"], true);
        assert_eq!(std::fs::read(&bin).unwrap(), vec![82,73]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn integrity_check_and_repair() {
        let root = tmpdir("integrity");
        let settings = root.join("settings.json");
        let c = super::integrity_check_at(&settings);
        assert_eq!(c["ok"], false);
        assert_eq!(c["issues"][0]["id"], "settings-missing");
        let r = super::integrity_repair_at(&settings, &["settings-missing".to_string()]);
        assert_eq!(r["ok"], true);
        assert_eq!(std::fs::read_to_string(&settings).unwrap(), "{}");
        std::fs::write(&settings, "not json").unwrap();
        let c2 = super::integrity_check_at(&settings);
        assert_eq!(c2["issues"][0]["id"], "settings-corrupt");
        let r2 = super::integrity_repair_at(&settings, &["settings-corrupt".to_string()]);
        assert_eq!(r2["ok"], true);
        assert_eq!(r2["results"][0]["action"], "recreated");
        assert!(r2["results"][0]["backup"].as_str().is_some());
        assert!(serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(&settings).unwrap()).is_ok());
        assert_eq!(super::integrity_check_at(&settings)["ok"], true);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn clear_user_data_scopes() {
        let root = tmpdir("clear-user-data");
        for d in ["models", "soundfonts", "cache", "midi"] { std::fs::create_dir_all(root.join(d)).unwrap(); }
        std::fs::write(root.join("models/m.bin"), b"m").unwrap();
        std::fs::write(root.join("soundfonts/s.sf2"), b"s").unwrap();
        std::fs::write(root.join("cache/c.bin"), b"c").unwrap();
        std::fs::write(root.join("midi/keep.mid"), b"k").unwrap();
        std::fs::write(root.join("settings.json"), b"{}").unwrap();
        let r = super::clear_user_data_at(&root, &["models".to_string()]);
        assert_eq!(r["ok"], true);
        assert_eq!(r["needRestart"], true);
        assert!(!root.join("models").exists());
        assert!(root.join("soundfonts/s.sf2").exists());
        let r2 = super::clear_user_data_at(&root, &["soundfonts".to_string(), "deps".to_string(), "playdata".to_string()]);
        assert_eq!(r2["done"].as_array().unwrap().len(), 3);
        assert!(!root.join("soundfonts").exists());
        assert!(!root.join("cache").exists());
        assert!(root.join("midi/keep.mid").exists(), "midi preserved");
        assert!(root.join("settings.json").exists(), "settings preserved");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn model_import_zip() {
        let root = tmpdir("model-import");
        let archive = root.join("muscriptor_small.zip");
        {
            let f = std::fs::File::create(&archive).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("muscriptor/small/weights.onnx", opts).unwrap();
            w.write_all(b"weights").unwrap();
            w.finish().unwrap();
        }
        let models = root.join("models");
        let r = super::model_import_local_at(&archive, &models);
        assert_eq!(r["ok"], true, "{}", r);
        assert_eq!(r["model"], "muscriptor/small");
        assert_eq!(std::fs::read(models.join("muscriptor/small/weights.onnx")).unwrap(), b"weights");
        let bad = root.join("x.7z");
        std::fs::write(&bad, b"x").unwrap();
        assert_eq!(super::model_import_local_at(&bad, &models)["ok"], false);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn health_json_parsing() {
        let v = super::parse_health_json("{\n  \"ok\": true,\n  \"report\": {\"report_text\": \"x\"}\n}").unwrap();
        assert_eq!(v["report"]["report_text"], "x");
        assert_eq!(super::parse_health_json("noise\n{\"ok\":false}\n").unwrap()["ok"], false);
        assert!(super::parse_health_json("   ").is_none());
        let p = super::parse_health_json("###RESULT {\"ok\": true, \"report\": {\"report_text\": \"real\"}}").unwrap();
        assert_eq!(p["report"]["report_text"], "real");
    }

    #[test]
    #[ignore]
    fn real_health_command_smoke() {
        let r = super::diag_health();
        assert_eq!(r["ok"], true, "real health command failed: {}", r);
        assert!(r["report"].is_object());
    }

    #[test]
    fn autostart_value_and_status() {
        let v = super::autostart_value();
        assert!(v.starts_with('"') && v.ends_with('"'));
        let st = super::autostart_get();
        assert_eq!(st["ok"], true);
        assert!(st["openAtLogin"].is_boolean());
    }

    #[test]
    fn dawproject_zip_roundtrip() {
        let root = tmpdir("dawproject");
        let target = root.join("song.dawproject");
        let files = vec![
            serde_json::json!({ "name": "project.xml", "data": "<Project/>" }),
            serde_json::json!({ "name": "metadata.xml", "data": "<Meta/>" }),
            serde_json::json!({ "name": "../evil.xml", "data": "x" }),
        ];
        let r = super::write_dawproject_at(&target, &files);
        assert_eq!(r["ok"], true);
        assert_eq!(r["files"].as_array().unwrap().len(), 2, "traversal skipped");
        let f = std::fs::File::open(&target).unwrap();
        let mut z = zip::ZipArchive::new(f).unwrap();
        let mut e = z.by_name("project.xml").unwrap();
        let mut buf = String::new(); e.read_to_string(&mut buf).unwrap();
        assert_eq!(buf, "<Project/>");
        assert_eq!(super::write_dawproject_at(&target, &[])["ok"], false);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn cover_data_urls() {
        let r = super::cover_data_url(b"abc", "jpg");
        assert_eq!(r["ok"], true);
        assert_eq!(r["dataUrl"], "data:image/jpeg;base64,YWJj");
        assert_eq!(super::cover_data_url(b"x", "gif")["ok"], false);
        let big = vec![0u8; 6 * 1024 * 1024 + 1];
        assert_eq!(super::cover_data_url(&big, "png")["ok"], false);
    }

    #[test]
    fn stems_zip_roundtrip() {
        let root = tmpdir("stems-zip");
        let target = root.join("stems.zip");
        let files = vec![
            serde_json::json!({ "name": "a:b", "ext": "wav", "bytes": [1,2,3] }),
            serde_json::json!({ "name": "b", "ext": "mp3", "bytes": [4] }),
        ];
        let r = super::write_stems_zip_at(&target, &files, "stems.zip");
        assert_eq!(r["ok"], true);
        assert_eq!(r["count"], 2);
        let f = std::fs::File::open(&target).unwrap();
        let mut z = zip::ZipArchive::new(f).unwrap();
        assert_eq!(z.len(), 2);
        let mut e = z.by_name("a_b.wav").unwrap();
        let mut buf = Vec::new(); e.read_to_end(&mut buf).unwrap();
        assert_eq!(buf, vec![1,2,3]);
        assert_eq!(super::write_stems_zip_at(&target, &[], "stems.zip")["ok"], false);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn export_audio_writes_manifest() {
        let root = tmpdir("export-audio");
        let bytes = vec![82u8, 73, 70, 70, 1, 2];
        let meta = serde_json::json!({ "format": "wav", "sampleRate": 48000, "channels": 2, "durationSec": 1.5 });
        let r = super::write_export_at(&root, "mix", "wav", &bytes, &meta, "test");
        assert_eq!(r["ok"], true);
        let p = r["path"].as_str().unwrap();
        assert_eq!(std::fs::read(p).unwrap(), bytes);
        let mp = r["manifestPath"].as_str().unwrap();
        let m: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(mp).unwrap()).unwrap();
        assert_eq!(m["format"], "fufumidi-export");
        assert_eq!(m["file"]["sha256"].as_str().unwrap().len(), 64);
        assert!(m["createdAt"].as_str().unwrap().ends_with("Z"));
        assert_eq!(super::unix_to_iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(super::unix_to_iso(1700000000), "2023-11-14T22:13:20.000Z");
        assert_eq!(m["audio"]["sampleRate"], 48000);
        assert_eq!(super::sanitize_export_name("a:b/c", "wav"), "a_b_c.wav");
        assert_eq!(super::write_export_at(&root, "empty", "wav", &[], &meta, "test")["ok"], false);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn audio_duration_m4a() {
        let root = tmpdir("audio-m4a");
        let f = root.join("clip.m4a");
        let mut b: Vec<u8> = Vec::new();
        b.extend_from_slice(&16u32.to_be_bytes()); b.extend_from_slice(b"ftyp"); b.extend_from_slice(b"M4A "); b.extend_from_slice(&[0,0,0,0]);
        let mut mvhd: Vec<u8> = Vec::new();
        mvhd.extend_from_slice(&[0,0,0,0]);
        mvhd.extend_from_slice(&[0,0,0,0]); mvhd.extend_from_slice(&[0,0,0,0]);
        mvhd.extend_from_slice(&1000u32.to_be_bytes());
        mvhd.extend_from_slice(&2000u32.to_be_bytes());
        b.extend_from_slice(&((8 + mvhd.len()) as u32).to_be_bytes()); b.extend_from_slice(b"mvhd"); b.extend_from_slice(&mvhd);
        let size = b.len() as u32 + 8;
        // 包一层 moov（需要把 mvhd 放进 moov：重建）
        let mut mvhd_box = Vec::new(); mvhd_box.extend_from_slice(&((8 + mvhd.len()) as u32).to_be_bytes()); mvhd_box.extend_from_slice(b"mvhd"); mvhd_box.extend_from_slice(&mvhd);
        let mut out: Vec<u8> = Vec::new();
        out.extend_from_slice(&16u32.to_be_bytes()); out.extend_from_slice(b"ftyp"); out.extend_from_slice(b"M4A "); out.extend_from_slice(&[0,0,0,0]);
        out.extend_from_slice(&((8 + mvhd_box.len()) as u32).to_be_bytes()); out.extend_from_slice(b"moov"); out.extend_from_slice(&mvhd_box);
        std::fs::write(&f, &out).unwrap();
        let r = super::audio_duration_at(f.to_str().unwrap());
        assert_eq!(r["ok"], true, "{}", r);
        assert!((r["seconds"].as_f64().unwrap() - 2.0).abs() < 0.001);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn audio_duration_wav_and_flac() {
        let root = tmpdir("audio-duration");
        let wav = root.join("one.wav");
        let mut b: Vec<u8> = Vec::new();
        b.extend_from_slice(b"RIFF"); b.extend_from_slice(&8036u32.to_le_bytes()); b.extend_from_slice(b"WAVE");
        b.extend_from_slice(b"fmt "); b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes()); b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&8000u32.to_le_bytes()); b.extend_from_slice(&8000u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes()); b.extend_from_slice(&8u16.to_le_bytes());
        b.extend_from_slice(b"data"); b.extend_from_slice(&8000u32.to_le_bytes());
        b.resize(b.len() + 8000, 128);
        std::fs::write(&wav, &b).unwrap();
        let r = super::audio_duration_at(wav.to_str().unwrap());
        assert_eq!(r["ok"], true);
        assert!((r["seconds"].as_f64().unwrap() - 1.0).abs() < 0.001);
        let flac = root.join("one.flac");
        let mut fb: Vec<u8> = Vec::new();
        fb.extend_from_slice(b"fLaC");
        fb.push(0x80); fb.extend_from_slice(&[0, 0, 34]);
        fb.extend_from_slice(&[0u8; 10]);
        let packed: u64 = ((44100u64) << 44) | ((2u64 - 1) << 41) | ((16u64 - 1) << 36) | 44100u64;
        fb.extend_from_slice(&packed.to_be_bytes());
        fb.extend_from_slice(&[0u8; 16]); // STREAMINFO MD5
        std::fs::write(&flac, &fb).unwrap();
        let r2 = super::audio_duration_at(flac.to_str().unwrap());
        assert_eq!(r2["ok"], true);
        assert!((r2["seconds"].as_f64().unwrap() - 1.0).abs() < 0.001);
        let mp3 = root.join("frames.mp3");
        let mut mb: Vec<u8> = Vec::new();
        for _ in 0..100 {
            mb.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]); // MPEG1 L3 128k 44.1k, frame=417
            mb.resize(mb.len() + 413, 0);
        }
        std::fs::write(&mp3, &mb).unwrap();
        let r3 = super::audio_duration_at(mp3.to_str().unwrap());
        assert_eq!(r3["ok"], true);
        assert!((r3["seconds"].as_f64().unwrap() - 2.6122).abs() < 0.02, "100 frames ~2.61s");
        let bad = root.join("bad.mp3");
        std::fs::write(&bad, b"not audio").unwrap();
        assert_eq!(super::audio_duration_at(bad.to_str().unwrap())["ok"], false);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn storage_report_and_cleanup() {
        let root = tmpdir("storage");
        for d in ["cache", "temp", "models", "midi", "logs"] { std::fs::create_dir_all(root.join(d)).unwrap(); }
        std::fs::write(root.join("cache/a.bin"), b"1234").unwrap();
        std::fs::write(root.join("temp/b.bin"), b"12").unwrap();
        std::fs::write(root.join("models/m.bin"), b"123").unwrap();
        std::fs::write(root.join("midi/song.mid"), b"x").unwrap();
        for i in 0..7 { std::fs::write(root.join(format!("logs/l{i}.log")), b"z").unwrap(); }
        let rep = super::storage_report_at(&root);
        assert_eq!(rep["areas"].as_array().unwrap().len(), 10);
        assert_eq!(rep["totalBytes"], 17);
        let clean = super::storage_cleanup_at(&root, false);
        assert_eq!(clean["ok"], true);
        assert_eq!(clean["freedBytes"], 8, "cache 4 + temp 2 + 2 old logs");
        assert!(root.join("models/m.bin").exists(), "assets kept by default");
        assert!(root.join("midi/song.mid").exists(), "midi is protected");
        assert_eq!(std::fs::read_dir(root.join("logs")).unwrap().count(), 5, "keep latest 5");
        std::fs::write(root.join("models/m2.bin"), b"12").unwrap();
        let clean2 = super::storage_cleanup_at(&root, true);
        assert_eq!(clean2["freedBytes"], 5);
        assert!(!root.join("models/m2.bin").exists());
        assert!(root.join("midi/song.mid").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn project_zip_roundtrip() {
        let root = tmpdir("project-zip");
        let asset = root.join("track.wav");
        std::fs::write(&asset, b"RIFFdata").unwrap();
        let target = root.join("song.fufumidi");
        let json = serde_json::json!({ "assets": { "a1": { "name": "track.wav" } }, "tracks": [] });
        let assets = vec![serde_json::json!({ "id": "a1", "fileName": "track.wav", "srcPath": asset.display().to_string() }), serde_json::json!({ "id": "bad id", "fileName": "x.wav", "srcPath": asset.display().to_string() })];
        let saved = super::project_save_to(&target, &json, &assets);
        assert_eq!(saved["ok"], true);
        assert_eq!(saved["missing"].as_array().unwrap().len(), 1, "bad id reported");
        assert!(target.exists());
        let cache = root.join("cache");
        let opened = super::project_open_from_at(&target, &cache);
        assert_eq!(opened["ok"], true);
        assert_eq!(opened["json"]["assets"]["a1"]["name"], "track.wav");
        let p = opened["resolved"]["a1"].as_str().unwrap();
        assert_eq!(std::fs::read(p).unwrap(), b"RIFFdata");
        let no = super::project_open_from_at(&root.join("nope.fufumidi"), &cache);
        assert_eq!(no["ok"], false);
        // 恶意包：路径穿越条目必须被忽略，只有白名单资产被解出
        let badzip = root.join("bad.fufumidi");
        {
            let f = std::fs::File::create(&badzip).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("project.json", opts).unwrap();
            w.write_all(br#"{"assets":{"a1":{}}}"#).unwrap();
            w.start_file("../evil.txt", opts).unwrap();
            w.write_all(b"evil").unwrap();
            w.start_file("files/a1.wav", opts).unwrap();
            w.write_all(b"ok").unwrap();
            w.finish().unwrap();
        }
        let opened2 = super::project_open_from_at(&badzip, &cache);
        assert_eq!(opened2["ok"], true);
        assert!(opened2["resolved"]["a1"].as_str().is_some());
        assert_eq!(opened2["resolved"].as_object().unwrap().len(), 1, "only whitelisted asset is resolved");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn copy_asset_roundtrip() {
        let root = tmpdir("copy-asset");
        let src = root.join("src.wav");
        std::fs::write(&src, b"1234").unwrap();
        let dest = root.join("sub/dest.wav");
        let r = super::copy_asset_files(src.to_str().unwrap(), dest.to_str().unwrap());
        assert_eq!(r["ok"], true);
        assert_eq!(std::fs::read(&dest).unwrap(), b"1234");
        let bad = super::copy_asset_files(root.join("none").to_str().unwrap(), dest.to_str().unwrap());
        assert_eq!(bad["ok"], false);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn lyrics_and_reveal_target() {
        assert_eq!(super::base64_encode(b"hello"), "aGVsbG8=");
        assert_eq!(super::base64_encode(b""), "");
        let root = tmpdir("lyrics");
        std::fs::write(root.join("song.mid"), b"MThd").unwrap();
        std::fs::write(root.join("song.lrc"), "[00:01.00]hi").unwrap();
        let r = super::read_sidecar_lyrics_at(root.join("song.mid").to_str().unwrap());
        assert_eq!(r["ok"], true);
        assert!(r["path"].as_str().unwrap().ends_with("song.lrc"));
        assert!(r["b64"].as_str().unwrap().len() > 4);
        assert_eq!(r["bytes"], 12);
        assert_eq!(super::read_sidecar_lyrics_at(root.join("none.mid").to_str().unwrap())["ok"], false);
        let (t, fb) = super::reveal_target("");
        assert_eq!(fb, true);
        assert!(!t.is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn autosave_roundtrip() {
        let root = tmpdir("autosave");
        let w = super::autosave_write_at(&root, "doc/unsafe id", &serde_json::json!({ "v": 1 }), &serde_json::json!({ "name": "draft" }));
        assert_eq!(w["ok"], true);
        assert!(w["bytes"].as_u64().unwrap() > 0);
        let list = super::autosave_entries_at(&root);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["docId"], "doc/unsafe id");
        assert_eq!(list[0]["meta"]["name"], "draft");
        let r = super::autosave_read_at(&root, "doc/unsafe id");
        assert_eq!(r["ok"], true);
        assert_eq!(r["data"]["v"], 1);
        assert_eq!(super::autosave_read_at(&root, "missing")["ok"], false);
        let c = super::autosave_clear_at(&root, "doc/unsafe id");
        assert_eq!(c["removed"], true);
        assert!(super::autosave_entries_at(&root).is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn zoom_clamp() {
        assert_eq!(super::clamp_zoom(1.0), 1.0);
        assert_eq!(super::clamp_zoom(0.1), 0.5);
        assert_eq!(super::clamp_zoom(9.0), 3.0);
        assert_eq!(super::clamp_zoom(f64::NAN), 1.0);
        assert_eq!(super::clamp_zoom(1.234), 1.23);
    }

    #[test]
    fn verify_and_dupe_midi() {
        let root = tmpdir("verify-dupe");
        // 合法 SMF（format 0 / 480 tick / 1 个 C4 音符）
        let midi: Vec<u8> = vec![77,84,104,100,0,0,0,6,0,0,0,1,1,224,77,84,114,107,0,0,0,21,0,255,3,1,84,0,192,0,0,144,60,100,131,96,128,60,64,0,255,47,0];
        std::fs::write(root.join("a.mid"), &midi).unwrap();
        std::fs::write(root.join("b.mid"), &midi).unwrap();
        std::fs::write(root.join("bad.mid"), b"not midi").unwrap();
        std::fs::write(root.join("x.txt"), b"same").unwrap();
        let v = super::verify_midi_at(&root);
        assert_eq!(v["ok"], true);
        assert_eq!(v["engine"], "rust");
        assert_eq!(v["count"], 3);
        assert_eq!(v["badCount"], 1);
        assert_eq!(v["totalNotes"], 2);
        let bad = v["bad"].as_array().unwrap();
        assert_eq!(bad.len(), 1);
        assert!(bad[0]["file"].as_str().unwrap().ends_with("bad.mid"));
        let d = super::dupe_midi_at(&root);
        assert_eq!(d["dupeGroups"], 1);
        assert_eq!(d["dupeFiles"], 1);
        let g = d["groups"][0].as_array().unwrap();
        assert_eq!(g.len(), 2);
        let has = super::has_midi_at(&root, root.join("a.mid").to_str().unwrap());
        assert_eq!(has["exists"], true);
        let outside = super::has_midi_at(&root, root.join("x.txt").to_str().unwrap());
        assert_eq!(outside["exists"], true, "hasMidi only checks existence/size, extension is not constrained");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn data_root_overview_and_clean_temp() {
        let root = tmpdir("data-root");
        std::fs::create_dir_all(root.join("temp/sub")).unwrap();
        std::fs::write(root.join("temp/a.bin"), b"1234").unwrap();
        std::fs::write(root.join("temp/sub/b.bin"), b"12").unwrap();
        std::fs::create_dir_all(root.join("models")).unwrap();
        std::fs::write(root.join("models/x"), b"x").unwrap();
        let v = super::data_root_overview(&root);
        assert_eq!(v["ok"], true);
        assert_eq!(v["entries"].as_array().unwrap().len(), 9);
        let temp = v["entries"].as_array().unwrap().iter().find(|e| e["key"] == "temp").unwrap();
        assert_eq!(temp["size"], 6);
        let freed = super::clean_temp_dir(&root.join("temp"));
        assert_eq!(freed, 6);
        assert!(!root.join("temp/a.bin").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn playlist_crud_roundtrip() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = tmpdir("playlist-crud");
        std::env::set_var("FUFUMIDI_DATA_ROOT", &root);
        assert_eq!(super::db_playlists_put(serde_json::json!({ "id": "p1", "name": "PL", "songIds": ["a"] })), true);
        let list = super::db_playlists_list();
        assert!(list.iter().any(|p| p["id"] == "p1" && p["songIds"][0] == "a"));
        assert_eq!(super::db_playlists_delete("p1".to_string()), true);
        assert!(!super::db_playlists_list().iter().any(|p| p["id"] == "p1"));
        std::env::remove_var("FUFUMIDI_DATA_ROOT");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn audio_scan_and_library_stats() {
        let root = tmpdir("audio-scan");
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(root.join("a.wav"), b"1234").unwrap();
        std::fs::write(root.join("b.txt"), b"x").unwrap();
        std::fs::write(sub.join("c.mp3"), b"12").unwrap();
        let files = super::walk_audio_files(&root);
        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|f| f.ends_with("a.wav")));
        assert!(files.iter().any(|f| f.ends_with("c.mp3")));
        let (count, bytes) = super::library_stats_of(&root);
        assert_eq!(count, 2);
        assert_eq!(bytes, 5);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn delete_rename_roundtrip() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = tmpdir("library-ops");
        std::env::set_var("FUFUMIDI_DATA_ROOT", &root);
        let midi = root.join("midi");
        std::fs::create_dir_all(&midi).unwrap();
        let a = midi.join("a.mid");
        std::fs::write(&a, b"MThd").unwrap();
        let renamed = super::rename_midi(a.display().to_string(), "新 名".to_string());
        assert_eq!(renamed["ok"], true);
        let rp = std::path::PathBuf::from(renamed["path"].as_str().unwrap());
        assert!(rp.exists());
        assert!(rp.file_name().unwrap().to_string_lossy().contains("新 名"));
        let dup = super::rename_midi(rp.display().to_string(), "新 名".to_string());
        assert_eq!(dup["renamed"], false, "同名不重复改名");
        let outside = root.join("outside.mid");
        std::fs::write(&outside, b"MThd").unwrap();
        assert_eq!(super::delete_midi(outside.display().to_string())["ok"], false);
        assert_eq!(super::delete_midi(rp.display().to_string())["deleted"], true);
        assert!(!rp.exists());
        std::env::remove_var("FUFUMIDI_DATA_ROOT");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn sanitize_rename_names() {
        assert_eq!(super::sanitize_rename("  a:b/c*?  "), "a b c");
        assert_eq!(super::sanitize_rename("name."), "name");
        assert_eq!(super::sanitize_rename("   "), "");
        let long = "x".repeat(200);
        assert_eq!(super::sanitize_rename(&long).chars().count(), 120);
    }

    #[test]
    fn desktop_videos_sorted_truncated() {
        let root = tmpdir("wallpaper");
        for name in ["b.mp4", "a.webm", "c.mov", "d.txt", "e.mp4", "f.mp4", "g.mp4"] {
            std::fs::write(root.join(name), b"x").unwrap();
        }
        let v = super::desktop_video_files(&root);
        assert_eq!(v.len(), 4);
        assert!(v[0].ends_with("a.webm"));
        assert!(v[3].ends_with("d.txt") == false);
        let _ = std::fs::remove_dir_all(root);
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
