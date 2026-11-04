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

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|p| p.to_path_buf())
}

fn repo_root_from_manifest() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
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
    let mut cands = vec![repo_root_from_manifest().join("resources/models")];
    if let Some(d) = exe_dir() {
        cands.push(d.join("../resources/models"));
        cands.push(d.join("resources/models"));
    }
    cands.into_iter().find(|p| p.is_dir())
}

/// 模型列表（T-115/T-117 过渡实现）：核心条目 + 分离模型，占位字段与 Electron model:list 对齐。
/// 完整目录仍以 main/models.js 为准；这里保证 UI 能拿到 id/exists/kind，不再一律空态。
#[tauri::command]
fn model_list() -> Vec<serde_json::Value> {
    let dir = models_dir();
    let mut items = Vec::new();
    push_model(&mut items, "basic_pitch", "通用转录（int8 量化）", "transcribe", dir.join("basic_pitch_quant.onnx"), 1000, "basic-pitch ONNX int8");
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

fn settings_path() -> PathBuf { data_dir().join("settings.json") }
fn kv_path() -> PathBuf { data_dir().join("kv.json") }
fn songs_path() -> PathBuf { data_dir().join("songs.json") }
fn playlists_path() -> PathBuf { data_dir().join("playlists.json") }

fn read_array(path: &Path) -> Vec<serde_json::Value> {
    match std::fs::read_to_string(path) {
        Ok(s) => match serde_json::from_str::<serde_json::Value>(&s) {
            Ok(serde_json::Value::Array(a)) => a,
            _ => Vec::new(),
        },
        Err(_) => Vec::new(),
    }
}

fn write_array(path: &Path, arr: &[serde_json::Value]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    let v = serde_json::Value::Array(arr.to_vec());
    std::fs::write(&tmp, serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn upsert_by_id(path: &Path, item: serde_json::Value) -> bool {
    let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut arr = read_array(path);
    if id.is_empty() {
        arr.push(item);
    } else if let Some(pos) = arr.iter().position(|x| x.get("id").and_then(|v| v.as_str()) == Some(id.as_str())) {
        arr[pos] = item;
    } else {
        arr.push(item);
    }
    write_array(path, &arr).is_ok()
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

fn renderer_dir() -> PathBuf { repo_root_from_manifest().join("renderer/dist") }

fn host_info_json() -> serde_json::Value {
    let py = python_path();
    let renderer = renderer_dir();
    serde_json::json!({
        "ok": true,
        "product": "FuFumidi",
        "version": env!("CARGO_PKG_VERSION"),
        "mode": if cfg!(debug_assertions) { "debug" } else { "release" },
        "dataDir": data_dir().display().to_string(),
        "python": py.as_ref().map(|p| p.display().to_string()),
        "pythonExists": py.as_ref().map(|p| p.exists()).unwrap_or(false),
        "renderer": renderer.display().to_string(),
        "rendererExists": renderer.join("index.html").exists(),
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
    let v = read_json(&kv_path());
    v.get(&key).cloned().unwrap_or(serde_json::Value::Null)
}

#[tauri::command]
fn db_kv_set(key: String, value: serde_json::Value) -> serde_json::Value {
    let mut map: BTreeMap<String, serde_json::Value> = match read_json(&kv_path()) {
        serde_json::Value::Object(o) => o.into_iter().collect(),
        _ => BTreeMap::new(),
    };
    map.insert(key, value);
    let obj = serde_json::Value::Object(map.into_iter().collect());
    match write_json(&kv_path(), &obj) {
        Ok(_) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

fn soundfont_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![repo_root_from_manifest().join("renderer/vendor/soundfonts")];
    if let Some(d) = exe_dir() {
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

#[tauri::command]
fn db_status() -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "kind": "json",
        "dataDir": data_dir().display().to_string(),
        "songs": read_array(&songs_path()).len(),
        "playlists": read_array(&playlists_path()).len(),
    })
}

#[tauri::command]
fn db_songs_list() -> Vec<serde_json::Value> { read_array(&songs_path()) }

#[tauri::command]
fn db_songs_put(item: serde_json::Value) -> bool { upsert_by_id(&songs_path(), item) }

#[tauri::command]
fn db_songs_delete(id: String) -> bool {
    let arr = read_array(&songs_path());
    let next: Vec<serde_json::Value> = arr.into_iter().filter(|x| x.get("id").and_then(|v| v.as_str()) != Some(id.as_str())).collect();
    write_array(&songs_path(), &next).is_ok()
}

#[tauri::command]
fn db_playlists_list() -> Vec<serde_json::Value> { read_array(&playlists_path()) }

#[tauri::command]
fn db_playlists_put(item: serde_json::Value) -> bool { upsert_by_id(&playlists_path(), item) }

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
    let mut cands = vec![repo_root_from_manifest().join("engine")];
    if let Some(d) = exe_dir() {
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

fn spawn_worker() -> Result<Worker, String> {
    let py = python_path().ok_or("python runtime not found")?;
    let eng = engine_dir().ok_or("engine/music2midi.py not found")?;
    let mut child = Command::new(&py)
        .current_dir(&eng)
        .args(["music2midi.py", "worker"])
        .env("PYTHONIOENCODING", "utf-8")
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
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            host_info, app_version, ping, python_selfcheck, engine_probe,
            load_settings, save_settings, db_kv_get, db_kv_set,
            db_status, db_songs_list, db_songs_put, db_songs_delete, db_playlists_list, db_playlists_put, model_list,
            soundfont_list, dep_check, diag_export, notify, open_output, open_external,
            list_midi_files, read_binary, save_binary,
            convert, cancel, engine_worker_status
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
