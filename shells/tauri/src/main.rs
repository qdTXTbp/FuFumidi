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
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

mod worker_pool;
mod stem_workflow;

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

/// Electron 的旧 settings.json（数据根记录在 %APPDATA%/FuFumidi/fufumidi）。
fn legacy_settings_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("FUFUMIDI_SETTINGS_FILE") {
        if !p.trim().is_empty() { return Some(PathBuf::from(p)); }
    }
    std::env::var("APPDATA").ok().map(|a| PathBuf::from(a).join("FuFumidi").join("fufumidi").join("settings.json"))
}

/// 数据根子目录里任意一个有内容，才算「真有数据」。空目录不能认领。
fn has_data_marker(dir: &Path) -> bool {
    if !dir.is_dir() { return false; }
    for sub in ["models", "gpu-enhancements", "soundfonts", "voicebanks", "diffsinger", "diffsinger-voicebanks", "midi", "cache", "temp", "logs"] {
        if let Ok(rd) = std::fs::read_dir(dir.join(sub)) { if rd.flatten().next().is_some() { return true; } }
    }
    dir.join(".fufumidi-ready").is_file() && std::fs::read_dir(dir).map(|mut rd| rd.next().is_some()).unwrap_or(false)
}

/// 从 settings 里的绝对路径反推 FuFumidiData 候选（与 Electron data-root-pick 同思路）。
fn data_root_hints(v: &serde_json::Value, out: &mut Vec<PathBuf>, depth: u32) {
    if depth > 6 || out.len() > 200 { return; }
    match v {
        serde_json::Value::String(s) if Path::new(s).is_absolute() => {
            let p = Path::new(s);
            let mut cur = p.to_path_buf();
            for _ in 0..12 {
                if cur.file_name().and_then(|x| x.to_str()) == Some("FuFumidiData") { out.push(cur.clone()); }
                out.push(cur.join("FuFumidiData"));
                let Some(parent) = cur.parent() else { break; };
                if parent == cur { break; }
                cur = parent.to_path_buf();
            }
        }
        serde_json::Value::Array(a) => for x in a { data_root_hints(x, out, depth + 1); },
        serde_json::Value::Object(o) => for x in o.values() { data_root_hints(x, out, depth + 1); },
        _ => {}
    }
}

/// 数据根选择（纯函数，测试可注入事实）：显式 > 上次使用且有数据 > 安装旁有数据 > 历史提示 > AppData 有数据 > 安装旁新建 > AppData。
fn pick_data_root(explicit: Option<PathBuf>, last: Option<PathBuf>, preferred: Option<PathBuf>, hints: &[PathBuf], user: PathBuf) -> PathBuf {
    if let Some(p) = explicit.filter(|p| p.is_dir()) { return p; }
    if let Some(p) = last.filter(|p| p.is_dir() && has_data_marker(p)) { return p; }
    if let Some(p) = preferred.clone().filter(|p| p.is_dir() && has_data_marker(p)) { return p; }
    for p in hints { if p.is_dir() && has_data_marker(p) { return p.clone(); } }
    if user.is_dir() && has_data_marker(&user) { return user; }
    if let Some(p) = preferred.filter(|p| p.parent().map(|x| x.is_dir()).unwrap_or(false)) { let _ = std::fs::create_dir_all(&p); return p; }
    let _ = std::fs::create_dir_all(&user); user
}

fn data_dir() -> PathBuf {
    if let Ok(p) = std::env::var("FUFUMIDI_DATA_ROOT") {
        if !p.trim().is_empty() {
            let pb = PathBuf::from(p);
            let _ = std::fs::create_dir_all(&pb);
            return pb;
        }
    }
    let settings = legacy_settings_path().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    let configured = settings.as_ref().and_then(|s| s.get("data_root")).and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).map(PathBuf::from);
    let last = settings.as_ref().and_then(|s| s.get("data_root_last")).and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).map(PathBuf::from);
    let mut hints = Vec::new();
    if let Some(s) = &settings { data_root_hints(s, &mut hints, 0); }
    let preferred = exe_dir().map(|d| d.join("../FuFumidiData"));
    let user = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir()).join("FuFumidi").join("FuFumidiData");
    pick_data_root(configured, last, preferred, &hints, user)
}

fn models_dir() -> PathBuf { data_dir().join("models") }

fn dir_size(p: &Path) -> u64 { dir_size_depth(p, 0) }

/// 递归统计目录字节数。**不跟随符号链接**（声库里的链接可能成环），深度上限再兜底；
/// 单个子项读失败只跳过它自己。
fn dir_size_depth(p: &Path, depth: u32) -> u64 {
    if depth > 64 { return 0; }
    let Ok(rd) = std::fs::read_dir(p) else { return 0 };
    let mut total = 0u64;
    for e in rd.flatten() {
        let path = e.path();
        let Ok(md) = std::fs::symlink_metadata(&path) else { continue };
        if md.file_type().is_symlink() { continue; }
        if md.is_dir() { total += dir_size_depth(&path, depth + 1); }
        else { total += md.len(); }
    }
    total
}

fn push_model(items: &mut Vec<serde_json::Value>, id: &str, name: &str, kind: &str, path: PathBuf, min_size: u64, note: &str) {
    // 启动期不能对 33GB 的 models 目录做递归 dir_size：那会让资源中心/转录页
    // 首次打开卡数十秒（实测冷启动的主要卡顿来源之一）。目录型模型只要
    // “目录里至少有一个条目”就算存在；准确体积由资源中心异步统计。
    let (exists, size) = if path.is_dir() {
        let has = std::fs::read_dir(&path).map(|mut rd| rd.next().is_some()).unwrap_or(false);
        (has, 0)
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

/* ---------------- 声库扫描（只读；对齐 main/utau.js:84 / main/diffsinger.js:1261） ---------------- */

/// 读文本文件：读失败返回 None；UTF-8 非法字节用 U+FFFD 替换（与 Node 读 utf8 的行为一致，且绝不 panic）。
fn read_text_lossy(path: &Path) -> Option<String> {
    std::fs::read(path).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// 行首/行尾裁剪：Rust 的 `is_whitespace` 不含 U+FEFF，而 JS 的 `trim()` 含 —— 显式补上，
/// 否则带 UTF-8 BOM 的 character.txt / character.yaml 会被当成没有 name。
fn trim_text_line(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c as u32 == 0xFEFF)
}

/// 声库根判定（对齐 main/utau.js 的 isBankRoot）：三标记任一存在即为声库根。
fn utau_is_bank_root(dir: &Path) -> bool {
    ["character.txt", "character.yaml", "oto.ini"]
        .iter()
        .any(|f| dir.join(f).exists())
}

/// 行首是否为 character.txt 的键（name / 名前，大小写不敏感）；返回键之后的剩余部分。
fn strip_character_txt_key(line: &str) -> Option<&str> {
    // `line[..4]` 只在 4 是字符边界时才安全（避免切在多字节汉字中间 panic）
    if line.len() >= 4 && line.is_char_boundary(4) && line[..4].eq_ignore_ascii_case("name") {
        return Some(&line[4..]);
    }
    line.strip_prefix("名前")
}

/// character.txt 的显示名：首个 `name=` / `名前=` / `name：` 行，值 trim 后非空。
fn utau_name_from_character_txt(text: &str) -> Option<String> {
    for raw in text.lines() {
        let Some(rest) = strip_character_txt_key(trim_text_line(raw)) else { continue };
        let rest = rest.trim_start();
        let Some(value) = rest
            .strip_prefix('=')
            .or_else(|| rest.strip_prefix('：'))
            .or_else(|| rest.strip_prefix(':'))
        else {
            continue;
        };
        let value = value.trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

/// character.yaml 的显示名：首个 `name:` 行（允许缩进，对齐参考正则），去引号后非空。
fn utau_name_from_character_yaml(text: &str) -> Option<String> {
    for raw in text.lines() {
        let line = raw.trim_start_matches(|c: char| c.is_whitespace() || c as u32 == 0xFEFF);
        if !(line.len() >= 4 && line.is_char_boundary(4) && line[..4].eq_ignore_ascii_case("name")) {
            continue;
        }
        let Some(rest) = line[4..].trim_start().strip_prefix(':') else { continue };
        let value = rest.trim();
        if value.is_empty() {
            continue;
        }
        let value = value.trim_matches(|c| c == '"' || c == '\'').trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

/// 显示名：character.yaml 的 name: 覆盖 character.txt 的 name=/名前=（对齐上游 ApplyConfig 顺序），
/// 全空返回空串，由调用方回落目录名。
fn utau_bank_display_name(dir: &Path) -> String {
    let mut name = String::new();
    if let Some(txt) = read_text_lossy(&dir.join("character.txt")) {
        if let Some(n) = utau_name_from_character_txt(&txt) {
            name = n;
        }
    }
    if let Some(yaml) = read_text_lossy(&dir.join("character.yaml")) {
        if let Some(n) = utau_name_from_character_yaml(&yaml) {
            name = n;
        }
    }
    name
}

/// 已导入 UTAU 声库列表（纯函数，root 由调用方给，便于临时目录单测）：
/// **只扫 root 一层**，条目读失败只跳过它自己；root 缺失/不可读返回空列表。
fn utau_list_voicebanks_at(root: &Path) -> serde_json::Value {
    let mut list = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let dir = entry.path();
            // metadata 与 Node statSync 一样跟随符号链接；失败只影响这一条
            let Ok(md) = std::fs::metadata(&dir) else { continue };
            if !md.is_dir() || !utau_is_bank_root(&dir) {
                continue;
            }
            let name = utau_bank_display_name(&dir);
            let name = if name.is_empty() {
                entry.file_name().to_string_lossy().into_owned()
            } else {
                name
            };
            list.push(serde_json::json!({ "name": name, "dir": dir.display().to_string() }));
        }
    }
    serde_json::json!({ "ok": true, "list": list })
}

/// DiffSinger 声库判定：dsconfig.yaml 在根或**下一层**（对齐 findInTree(dir, 'dsconfig.yaml', 1)）。
fn ds_is_voicebank(dir: &Path) -> bool {
    if dir.join("dsconfig.yaml").exists() {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    for entry in entries.flatten() {
        let child = entry.path();
        if child.is_dir() && child.join("dsconfig.yaml").exists() {
            return true;
        }
    }
    false
}

/// 扫描一个声库根：UTAU 侧任意目录都算（对齐 main/diffsinger.js），DiffSinger 侧要有 dsconfig。
/// root 读失败返回空；条目级失败只跳过自己。
fn scan_voicebank_dirs(root: &Path, kind: &str) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else { return out };
    for entry in entries.flatten() {
        let dir = entry.path();
        let Ok(md) = std::fs::metadata(&dir) else { continue };
        if !md.is_dir() {
            continue;
        }
        if kind == "diffsinger" && !ds_is_voicebank(&dir) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        out.push(serde_json::json!({
            "kind": kind,
            "name": name,
            "dir": dir.display().to_string(),
            "size": dir_size(&dir),
            "id": format!("{kind}:{name}"),
        }));
    }
    out
}

/// 统一声库清单（纯函数）：两侧各自独立容错，任一侧目录缺失都不连累另一侧。
fn voicebank_unified_at(utau_root: &Path, ds_root: &Path) -> serde_json::Value {
    let utau = scan_voicebank_dirs(utau_root, "utau");
    let ds = scan_voicebank_dirs(ds_root, "diffsinger");
    let mut list = Vec::with_capacity(utau.len() + ds.len());
    list.extend(utau.iter().cloned());
    list.extend(ds.iter().cloned());
    serde_json::json!({
        "ok": true,
        "list": list,
        "utauRoot": utau_root.display().to_string(),
        "diffsingerRoot": ds_root.display().to_string(),
        "utauCount": utau.len(),
        "diffsingerCount": ds.len(),
    })
}

/// 已导入 UTAU 声库列表（只读；对齐 Electron `utau:listVoicebanks`）。
#[tauri::command]
fn utau_list_voicebanks() -> serde_json::Value {
    utau_list_voicebanks_at(&data_dir().join("voicebanks"))
}

/// 统一声库清单（只读；对齐 Electron `voicebank:unified`）。
#[tauri::command]
fn voicebank_unified() -> serde_json::Value {
    voicebank_unified_at(
        &data_dir().join("voicebanks"),
        &data_dir().join("diffsinger-voicebanks"),
    )
}

/* ---------------- oto.ini 读/写（对齐 main/utau.js:311/333；只允许数据根 voicebanks 内） ---------------- */
const OTO_MAX_BYTES: usize = 8 * 1024 * 1024;

fn oto_err(error: &str) -> serde_json::Value { serde_json::json!({ "ok": false, "error": error }) }

fn oto_path_text(path: &Path) -> String {
    let s = path.display().to_string();
    #[cfg(target_os = "windows")]
    { if let Some(stripped) = s.strip_prefix(r"\\?\") { return stripped.to_string(); } }
    s
}

fn oto_bank_dir(root: &Path, voicebank: Option<&str>) -> Result<PathBuf, &'static str> {
    let Some(v) = voicebank.map(|s| s.trim()).filter(|s| !s.is_empty()) else { return Err("未指定声库目录"); };
    let raw = PathBuf::from(v);
    let target = if raw.is_absolute() { raw } else { root.join(raw) };
    if !target.exists() { return Err("声库目录不存在"); }
    let root_c = root.canonicalize().map_err(|_| "声库目录不存在")?;
    let target_c = target.canonicalize().map_err(|_| "声库目录不存在")?;
    if !target_c.starts_with(&root_c) { return Err("声库目录不在数据根内"); }
    if !target_c.is_dir() { return Err("声库目录不存在"); }
    Ok(target_c)
}

fn oto_b64_encode(data: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(A[((n >> 18) & 63) as usize] as char);
        out.push(A[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { A[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { A[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// 宽容解码：忽略非 base64 字符（与 Buffer.from(s,"base64") 的常见行为一致），不 panic。
fn oto_b64_decode(src: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buf: u32 = 0;
    let mut bits = 0u32;
    for b in src.bytes() {
        if b == b'=' { break; }
        let v = match b { b'A'..=b'Z' => b - b'A', b'a'..=b'z' => b - b'a' + 26, b'0'..=b'9' => b - b'0' + 52, b'+' => 62, b'/' => 63, _ => continue };
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 { bits -= 8; out.push(((buf >> bits) & 255) as u8); }
    }
    out
}

fn utau_read_oto_at(root: &Path, voicebank: Option<&str>) -> serde_json::Value {
    let dir = match oto_bank_dir(root, voicebank) { Ok(d) => d, Err(e) => return oto_err(e) };
    let target = dir.join("oto.ini");
    if !target.is_file() { return oto_err("该声库没有 oto.ini"); }
    let bytes = match std::fs::read(&target) { Ok(b) => b, Err(e) => return oto_err(&e.to_string()) };
    let mtime = std::fs::metadata(&target).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as f64).unwrap_or(0.0);
    serde_json::json!({ "ok": true, "path": oto_path_text(&target), "base64": oto_b64_encode(&bytes), "size": bytes.len(), "mtimeMs": mtime })
}

fn utau_save_oto_at(root: &Path, voicebank: Option<&str>, base64: Option<&str>) -> serde_json::Value {
    let dir = match oto_bank_dir(root, voicebank) { Ok(d) => d, Err(e) => return oto_err(e) };
    let bytes = oto_b64_decode(base64.unwrap_or(""));
    if bytes.is_empty() { return oto_err("内容为空"); }
    if bytes.len() > OTO_MAX_BYTES { return oto_err("文件过大（上限 8MB）"); }
    let target = dir.join("oto.ini");
    let backup = if target.is_file() {
        let bak = dir.join("oto.ini.bak");
        if let Err(e) = std::fs::copy(&target, &bak) { return oto_err(&e.to_string()); }
        oto_path_text(&bak)
    } else { String::new() };
    if let Err(e) = std::fs::write(&target, &bytes) { return oto_err(&e.to_string()); }
    serde_json::json!({ "ok": true, "path": oto_path_text(&target), "backup": backup, "bytes": bytes.len() })
}

#[tauri::command]
fn utau_read_oto(voicebank: Option<String>) -> serde_json::Value {
    utau_read_oto_at(&data_dir().join("voicebanks"), voicebank.as_deref())
}

#[tauri::command]
fn utau_save_oto(voicebank: Option<String>, base64: Option<String>) -> serde_json::Value {
    utau_save_oto_at(&data_dir().join("voicebanks"), voicebank.as_deref(), base64.as_deref())
}

fn utau_delete_voicebank_at(root: &Path, voicebank: Option<&str>) -> serde_json::Value {
    let dir = match oto_bank_dir(root, voicebank) { Ok(d) => d, Err(e) => return oto_err(e) };
    let root_c = match root.canonicalize() { Ok(r) => r, Err(_) => return oto_err("声库目录不存在") };
    if dir == root_c { return oto_err("不能删除声库根目录"); }
    match std::fs::remove_dir_all(&dir) {
        Ok(_) => serde_json::json!({ "ok": true, "dir": oto_path_text(&dir) }),
        Err(e) => oto_err(&e.to_string()),
    }
}

#[tauri::command]
fn utau_delete_voicebank(voicebank: Option<String>) -> serde_json::Value {
    utau_delete_voicebank_at(&data_dir().join("voicebanks"), voicebank.as_deref())
}

fn utau_safe_name(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        if ch.is_control() || matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { out.push('_'); } else { out.push(ch); }
    }
    let t = out.trim().trim_matches('.');
    if t.is_empty() { format!("voicebank_{}", std::process::id()) } else { t.to_string() }
}

fn utau_find_bank_root(dir: &Path, depth: u32) -> Option<PathBuf> {
    if depth > 4 { return None; }
    if utau_is_bank_root(dir) || dir.join("oto.ini").is_file() { return Some(dir.to_path_buf()); }
    let entries = std::fs::read_dir(dir).ok()?;
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() { if let Some(found) = utau_find_bank_root(&p, depth + 1) { return Some(found); } }
    }
    None
}

fn utau_unique_dest(root: &Path, base: &str) -> PathBuf {
    let mut dest = root.join(base);
    let mut i = 2;
    while dest.exists() { dest = root.join(format!("{base}_{i}")); i += 1; }
    dest
}

fn utau_import_zip_at(root: &Path, archive: &Path) -> serde_json::Value {
    let ext = archive.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext != "zip" { return oto_err("只支持 .zip 声库压缩包"); }
    if !archive.is_file() { return oto_err("压缩包不存在"); }
    let _ = std::fs::create_dir_all(root);
    let uniq = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("fufumidi-utau-{}-{uniq}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let _ = std::fs::create_dir_all(&tmp);
    let result = (|| -> Result<serde_json::Value, String> {
        let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        if zip.len() > 20000 { return Err("压缩包条目过多".to_string()); }
        let mut total: u64 = 0;
        for i in 0..zip.len() {
            let mut e = zip.by_index(i).map_err(|e| e.to_string())?;
            let name = e.name().replace('\\', "/");
            if name.is_empty() || name.contains("..") || name.starts_with('/') { continue; }
            total += e.size();
            if total > 4 * 1024 * 1024 * 1024 { return Err("压缩包解压后过大（>4GB）".to_string()); }
            let dest = tmp.join(&name);
            if e.is_dir() { let _ = std::fs::create_dir_all(&dest); continue; }
            if let Some(parent) = dest.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
            let mut out = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
            std::io::copy(&mut e, &mut out).map_err(|e| e.to_string())?;
        }
        let src = utau_find_bank_root(&tmp, 0).ok_or_else(|| "压缩包内没有找到声库（character.txt/character.yaml/oto.ini）".to_string())?;
        let base = utau_safe_name(archive.file_stem().and_then(|x| x.to_str()).unwrap_or("voicebank"));
        let dest = utau_unique_dest(root, &base);
        copy_tree(&src, &dest).map_err(|e| e.to_string())?;
        if !dest.join("character.txt").exists() && !dest.join("character.yaml").exists() && dest.join("oto.ini").exists() {
            let _ = std::fs::write(dest.join("character.txt"), "\n");
            let _ = std::fs::write(dest.join("character.yaml"), "textFileEncoding: utf-8\n");
        }
        let name = { let n = utau_bank_display_name(&dest); if n.is_empty() { dest.file_name().and_then(|x| x.to_str()).unwrap_or("voicebank").to_string() } else { n } };
        Ok(serde_json::json!({ "ok": true, "name": name, "dir": oto_path_text(&dest) }))
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result.unwrap_or_else(|e| oto_err(&e))
}

#[tauri::command]
fn utau_import_voicebank_zip(app: AppHandle) -> serde_json::Value {
    let picked = app.dialog().file().set_title("导入 UTAU 声库压缩包").add_filter("UTAU 声库", &["zip"]).blocking_pick_file();
    match picked.and_then(file_path_string) {
        Some(p) => utau_import_zip_at(&data_dir().join("voicebanks"), Path::new(&p)),
        None => serde_json::json!({ "ok": false, "canceled": true }),
    }
}

fn utau_export_voicebank_at(dir: &Path, files: &[serde_json::Value]) -> serde_json::Value {
    if !dir.is_dir() { return oto_err("保存目录不存在"); }
    let mut count = 0usize;
    let mut total: u64 = 0;
    for f in files {
        let raw = f.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
        if raw.is_empty() || raw == "." || raw == ".." { continue; }
        let name = utau_safe_name(raw);
        if name == "." || name == ".." { continue; }
        let data = f.get("data").and_then(|v| v.as_str()).unwrap_or("");
        let bytes = oto_b64_decode(data);
        total += bytes.len() as u64;
        if total > 512 * 1024 * 1024 { return oto_err("导出内容过大（上限 512MB）"); }
        match std::fs::write(dir.join(&name), &bytes) {
            Ok(_) => count += 1,
            Err(e) => return oto_err(&e.to_string()),
        }
    }
    serde_json::json!({ "ok": true, "dir": oto_path_text(dir), "count": count })
}

#[tauri::command]
fn utau_export_voicebank(dir: String, files: Vec<serde_json::Value>) -> serde_json::Value {
    utau_export_voicebank_at(Path::new(&dir), &files)
}

fn write_voicebank_zip_at(path: &Path, files: &[serde_json::Value]) -> serde_json::Value {
    let f = match std::fs::File::create(path) { Ok(f) => f, Err(e) => return oto_err(&e.to_string()) };
    let mut z = zip::ZipWriter::new(f);
    let opt = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut count = 0usize;
    let mut total: u64 = 0;
    for item in files {
        let raw = item.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
        if raw.is_empty() || raw == "." || raw == ".." { continue; }
        let name = utau_safe_name(raw);
        let data = oto_b64_decode(item.get("data").and_then(|v| v.as_str()).unwrap_or(""));
        total += data.len() as u64;
        if total > 512 * 1024 * 1024 { let _ = std::fs::remove_file(path); return oto_err("导出内容过大（上限 512MB）"); }
        if let Err(e) = z.start_file(&name, opt) { let _ = std::fs::remove_file(path); return oto_err(&e.to_string()); }
        if let Err(e) = z.write_all(&data) { let _ = std::fs::remove_file(path); return oto_err(&e.to_string()); }
        count += 1;
    }
    if let Err(e) = z.finish() { let _ = std::fs::remove_file(path); return oto_err(&e.to_string()); }
    serde_json::json!({ "ok": true, "path": oto_path_text(path), "count": count })
}

#[tauri::command]
fn utau_export_voicebank_zip(app: AppHandle, files: Vec<serde_json::Value>) -> serde_json::Value {
    let picked = app.dialog().file().set_title("导出 UTAU 声库包").set_file_name("voicebank.zip").add_filter("ZIP", &["zip"]).blocking_save_file();
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return serde_json::json!({ "ok": false, "canceled": true }); };
    write_voicebank_zip_at(&path, &files)
}

fn rvc_root() -> PathBuf { data_dir().join("models").join("rvc") }

fn rvc_file_state(m: &serde_json::Value, dir: &Path) -> (u64, Vec<String>) {
    let mut size = 0u64;
    let mut missing = Vec::new();
    if let Some(files) = m.get("files").and_then(|v| v.as_object()) {
        for v in files.values() {
            let Some(name) = v.as_str().filter(|x| !x.is_empty()) else { continue };
            let raw = PathBuf::from(name);
            let path = if raw.is_absolute() { raw } else { dir.join(raw) };
            match std::fs::metadata(&path) {
                Ok(md) if md.is_file() => size += md.len(),
                _ => missing.push(name.to_string()),
            }
        }
    }
    (size, missing)
}

fn rvc_list_at(root: &Path) -> serde_json::Value {
    let mut out: Vec<serde_json::Value> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let dir = e.path();
            if !dir.is_dir() { continue; }
            let m = match std::fs::read_to_string(dir.join("model.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) { Some(m) => m, None => continue };
            let id = m.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if id.is_empty() { continue; }
            let (size, missing) = rvc_file_state(&m, &dir);
            let external = !dir.starts_with(root);
            let mut item = m.clone();
            if let Some(o) = item.as_object_mut() {
                o.insert("dir".into(), serde_json::json!(oto_path_text(&dir)));
                o.insert("size".into(), serde_json::json!(size));
                o.insert("missing".into(), serde_json::json!(missing));
                o.insert("ready".into(), serde_json::json!(missing.is_empty() && m.get("engine").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false)));
                o.insert("external".into(), serde_json::json!(external));
            }
            out.push(item);
        }
    }
    // 引用式导入：index.json 里的 external 条目
    if let Ok(t) = std::fs::read_to_string(root.join("index.json")) {
        if let Ok(idx) = serde_json::from_str::<serde_json::Value>(&t) {
            if let Some(models) = idx.get("models").and_then(|v| v.as_object()) {
                for (_id, m) in models {
                    let id = m.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    if id.is_empty() || out.iter().any(|x| x.get("id").and_then(|v| v.as_str()) == Some(id)) { continue; }
                    let dir_text = m.get("dir").and_then(|v| v.as_str()).unwrap_or("");
                    let dir = Path::new(dir_text);
                    let (size, missing) = rvc_file_state(m, dir);
                    let mut item = m.clone();
                    if let Some(o) = item.as_object_mut() {
                        o.insert("size".into(), serde_json::json!(size));
                        o.insert("missing".into(), serde_json::json!(missing));
                        o.insert("ready".into(), serde_json::json!(missing.is_empty() && m.get("engine").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false)));
                        o.insert("external".into(), serde_json::json!(true));
                    }
                    out.push(item);
                }
            }
        }
    }
    out.sort_by(|a, b| a.get("name").and_then(|v| v.as_str()).unwrap_or("").cmp(b.get("name").and_then(|v| v.as_str()).unwrap_or("")));
    serde_json::json!({ "ok": true, "models": out, "root": oto_path_text(root) })
}

fn rvc_remove_at(root: &Path, id: &str) -> serde_json::Value {
    if id.trim().is_empty() { return oto_err("缺少模型 id"); }
    let mut dir: Option<PathBuf> = None;
    let mut in_index = false;
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let d = e.path();
            let m = std::fs::read_to_string(d.join("model.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
            if m.and_then(|v| v.get("id").and_then(|x| x.as_str()).map(|s| s == id)).unwrap_or(false) { dir = Some(d); break; }
        }
    }
    let idx_path = root.join("index.json");
    let mut idx = std::fs::read_to_string(&idx_path).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).unwrap_or_else(|| serde_json::json!({ "models": {} }));
    if idx.get("models").and_then(|v| v.as_object()).map(|m| m.contains_key(id)).unwrap_or(false) {
        in_index = true;
        if dir.is_none() { dir = idx.get("models").and_then(|m| m.get(id)).and_then(|m| m.get("dir")).and_then(|v| v.as_str()).map(PathBuf::from); }
    }
    if dir.is_none() && !in_index { return oto_err("not found"); }
    let mut removed_physical = false;
    if let Some(d) = dir {
        if d.starts_with(root) && d.is_dir() {
            if let Err(e) = std::fs::remove_dir_all(&d) { return oto_err(&e.to_string()); }
            removed_physical = true;
        }
    }
    if in_index {
        if let Some(models) = idx.get_mut("models").and_then(|v| v.as_object_mut()) { models.remove(id); }
        if let Ok(t) = serde_json::to_string_pretty(&idx) { let _ = std::fs::write(&idx_path, t); }
    }
    serde_json::json!({ "ok": true, "removedPhysical": removed_physical })
}

#[tauri::command]
fn rvc_list() -> serde_json::Value { rvc_list_at(&rvc_root()) }

#[tauri::command]
fn rvc_remove(id: String) -> serde_json::Value { rvc_remove_at(&rvc_root(), &id) }

const RVC_DEFAULTS: &str = r#"{"transpose":0,"indexRate":0.3,"rmsMixRate":0.25,"protect":0.33,"f0Method":"rmvpe","chunkSec":60,"autoPredictF0":false}"#;

fn rvc_slug(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { out.push(ch.to_ascii_lowercase()); }
        else if ch.is_whitespace() || ch == '.' { out.push('-'); }
    }
    let t = out.trim_matches('-').to_string();
    if t.is_empty() { format!("rvc-{}", std::process::id()) } else { t }
}

fn rvc_unique_id(root: &Path, base: &str) -> String {
    let mut id = base.to_string();
    let mut i = 2;
    loop {
        let used = root.join(&id).is_dir() || std::fs::read_to_string(root.join("index.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).and_then(|v| v.get("models").and_then(|m| m.as_object()).map(|m| m.contains_key(&id))).unwrap_or(false);
        if !used { return id; }
        id = format!("{base}-{i}"); i += 1;
    }
}

fn rvc_detect(dir: &Path) -> serde_json::Value {
    let mut all: Vec<String> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_file() { all.push(e.file_name().to_string_lossy().into_owned()); }
            else if p.is_dir() { if let Ok(sd) = std::fs::read_dir(&p) { for g in sd.flatten() { if g.path().is_file() { all.push(format!("{}/{}", e.file_name().to_string_lossy(), g.file_name().to_string_lossy())); } } } }
        }
    }
    let pth = all.iter().find(|f| f.to_ascii_lowercase().ends_with(".pth")).cloned();
    let pt = all.iter().find(|f| f.to_ascii_lowercase().ends_with(".pt")).cloned();
    let index = all.iter().find(|f| f.to_ascii_lowercase().ends_with(".index")).cloned();
    let config = all.iter().find(|f| { let l = f.to_ascii_lowercase(); l.ends_with("config.yaml") || l.ends_with("config.yml") || l.ends_with("diffusion.yaml") || l.ends_with("diffusion.yml") }).cloned();
    let mut files = serde_json::Map::new();
    let mut engine = "";
    if let Some(p) = pth { engine = "rvc"; files.insert("model".into(), serde_json::json!(p)); if let Some(i) = index { files.insert("index".into(), serde_json::json!(i)); } }
    else if let (Some(c), Some(p)) = (config.clone(), pt) { engine = "ddsp"; files.insert("config".into(), serde_json::json!(c)); files.insert("model".into(), serde_json::json!(p)); }
    let joined = all.join(" ").to_ascii_lowercase();
    let sr = if joined.contains("48k") { 48000 } else if joined.contains("40k") { 40000 } else if joined.contains("32k") { 32000 } else { 0 };
    serde_json::json!({ "engine": engine, "files": files, "sr": sr, "version": "", "all": all })
}

fn rvc_save_model(root: &Path, m: &serde_json::Value) -> Result<(), String> {
    let dir = PathBuf::from(m.get("dir").and_then(|v| v.as_str()).unwrap_or(""));
    if dir.starts_with(root) {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("model.json"), serde_json::to_string_pretty(m).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    } else {
        let idx_path = root.join("index.json");
        let mut idx = std::fs::read_to_string(&idx_path).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).unwrap_or_else(|| serde_json::json!({ "models": {} }));
        if !idx.get("models").map(|v| v.is_object()).unwrap_or(false) { idx["models"] = serde_json::json!({}); }
        let id = m.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if let Some(models) = idx.get_mut("models").and_then(|v| v.as_object_mut()) { models.insert(id, m.clone()); }
        std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
        std::fs::write(&idx_path, serde_json::to_string_pretty(&idx).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn rvc_defaults_value() -> serde_json::Value { serde_json::from_str(RVC_DEFAULTS).unwrap_or_else(|_| serde_json::json!({})) }

fn rvc_import_folder_at(root: &Path, dir: &str, name_hint: Option<&str>) -> serde_json::Value {
    let d = Path::new(dir);
    if !d.is_dir() { return oto_err("目录不存在"); }
    let detected = rvc_detect(d);
    let engine = detected.get("engine").and_then(|v| v.as_str()).unwrap_or("");
    if engine.is_empty() { return oto_err("没认出这是什么模型：目录下既没有 *.pth，也没有 config.yaml + *.pt"); }
    let manifest = std::fs::read_to_string(d.join("manifest.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).unwrap_or_else(|| serde_json::json!({}));
    let base_name = name_hint.map(|s| s.to_string()).filter(|s| !s.trim().is_empty()).or_else(|| manifest.get("name").and_then(|v| v.as_str()).map(|s| s.to_string())).unwrap_or_else(|| d.file_name().and_then(|x| x.to_str()).unwrap_or("rvc").to_string());
    let id = rvc_unique_id(root, &rvc_slug(manifest.get("id").and_then(|v| v.as_str()).unwrap_or(&base_name)));
    let model = serde_json::json!({
        "id": id, "name": base_name, "engine": engine,
        "version": manifest.get("version").cloned().unwrap_or_else(|| detected["version"].clone()),
        "sr": manifest.get("sr").and_then(|v| v.as_u64()).or_else(|| detected.get("sr").and_then(|v| v.as_u64())).unwrap_or(0),
        "f0": manifest.get("f0").and_then(|v| v.as_bool()).unwrap_or(true),
        "dir": oto_path_text(d),
        "files": manifest.get("files").cloned().unwrap_or_else(|| detected["files"].clone()),
        "defaults": manifest.get("defaults").cloned().unwrap_or_else(rvc_defaults_value),
        "source": "folder", "lang": manifest.get("lang").cloned().unwrap_or_else(|| serde_json::json!("")),
        "work": manifest.get("work").cloned().unwrap_or_else(|| serde_json::json!("")),
    });
    match rvc_save_model(root, &model) { Ok(_) => serde_json::json!({ "ok": true, "model": model, "detected": detected }), Err(e) => oto_err(&e) }
}

fn rvc_file_name(p: &str) -> String { Path::new(p).file_name().and_then(|x| x.to_str()).unwrap_or("file").to_string() }

fn rvc_import_files_at(root: &Path, files: &serde_json::Value, opts: &serde_json::Value) -> serde_json::Value {
    let Some(obj) = files.as_object() else { return oto_err("没有选中任何文件"); };
    let mut picked: Vec<(&String, PathBuf)> = Vec::new();
    for (k, v) in obj { if let Some(p) = v.as_str().filter(|s| !s.is_empty() && Path::new(s).is_file()) { picked.push((k, PathBuf::from(p))); } }
    if picked.is_empty() { return oto_err("没有选中任何文件"); }
    let name = opts.get("name").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).map(|s| s.to_string()).unwrap_or_else(|| Path::new(picked[0].1.to_str().unwrap_or("rvc")).file_stem().and_then(|x| x.to_str()).unwrap_or("rvc").to_string());
    let id = rvc_unique_id(root, &rvc_slug(opts.get("id").and_then(|v| v.as_str()).unwrap_or(&name)));
    let dest = root.join(&id);
    let result = (|| -> Result<serde_json::Value, String> {
        std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        let mut rel = serde_json::Map::new();
        for (k, src) in &picked {
            let fname = rvc_file_name(src.to_str().unwrap_or(""));
            std::fs::copy(src, dest.join(&fname)).map_err(|e| e.to_string())?;
            rel.insert((*k).clone(), serde_json::json!(fname));
        }
        let engine = if rel.contains_key("config") { "ddsp" } else { "rvc" };
        let model = serde_json::json!({
            "id": id, "name": name, "engine": engine, "version": opts.get("version").cloned().unwrap_or_else(|| serde_json::json!("")),
            "sr": opts.get("sr").cloned().unwrap_or_else(|| serde_json::json!(0)), "f0": opts.get("f0").and_then(|v| v.as_bool()).unwrap_or(true),
            "dir": oto_path_text(&dest), "files": rel, "defaults": rvc_defaults_value(), "source": "files",
            "lang": opts.get("lang").cloned().unwrap_or_else(|| serde_json::json!("")), "work": opts.get("work").cloned().unwrap_or_else(|| serde_json::json!("")),
        });
        rvc_save_model(root, &model)?;
        Ok(serde_json::json!({ "ok": true, "model": model }))
    })();
    match result { Ok(v) => v, Err(e) => { let _ = std::fs::remove_dir_all(&dest); oto_err(&e) } }
}

#[tauri::command]
fn rvc_pick_folder(app: AppHandle) -> serde_json::Value {
    match app.dialog().file().set_title("选择 RVC 模型目录").blocking_pick_folder().and_then(file_path_string) {
        Some(dir) => { let detected = rvc_detect(Path::new(&dir)); serde_json::json!({ "ok": true, "dir": dir, "detected": detected }) }
        None => serde_json::json!({ "canceled": true }),
    }
}

#[tauri::command]
fn rvc_pick_files(app: AppHandle) -> serde_json::Value {
    let picked = app.dialog().file().set_title("选择 RVC 模型文件").add_filter("模型文件", &["pth", "pt", "index", "yaml", "yml", "json"]).blocking_pick_files();
    match picked { Some(list) => { let files: Vec<String> = list.into_iter().filter_map(file_path_string).collect(); serde_json::json!({ "ok": true, "files": files }) }, None => serde_json::json!({ "canceled": true }) }
}

#[tauri::command]
fn rvc_import_folder(dir: String, opts: Option<serde_json::Value>) -> serde_json::Value {
    let name = opts.as_ref().and_then(|o| o.get("name")).and_then(|v| v.as_str());
    rvc_import_folder_at(&rvc_root(), &dir, name)
}

#[tauri::command]
fn rvc_import_files(files: serde_json::Value, opts: Option<serde_json::Value>) -> serde_json::Value {
    rvc_import_files_at(&rvc_root(), &files, &opts.unwrap_or_else(|| serde_json::json!({})))
}

fn rvc_import_zip_at(root: &Path, archive: &Path, opts: &serde_json::Value) -> serde_json::Value {
    if !archive.is_file() { return oto_err("压缩包不存在"); }
    let ext = archive.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext != "zip" { return oto_err("只支持 .zip 模型压缩包"); }
    let base = opts.get("name").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).map(|s| s.to_string()).unwrap_or_else(|| archive.file_stem().and_then(|x| x.to_str()).unwrap_or("rvc").to_string());
    let id = rvc_unique_id(root, &rvc_slug(opts.get("id").and_then(|v| v.as_str()).unwrap_or(&base)));
    let dest = root.join(&id);
    let result = (|| -> Result<serde_json::Value, String> {
        std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        if zip.len() > 20000 { return Err("压缩包条目过多".to_string()); }
        let mut total: u64 = 0;
        for i in 0..zip.len() {
            let mut e = zip.by_index(i).map_err(|x| x.to_string())?;
            let name = e.name().replace('\\', "/");
            if name.is_empty() || name.contains("..") || name.starts_with('/') { continue; }
            total += e.size();
            if total > 4 * 1024 * 1024 * 1024 { return Err("压缩包解压后过大（>4GB）".to_string()); }
            let out = dest.join(&name);
            if e.is_dir() { std::fs::create_dir_all(&out).map_err(|x| x.to_string())?; continue; }
            if let Some(parent) = out.parent() { std::fs::create_dir_all(parent).map_err(|x| x.to_string())?; }
            let mut w = std::fs::File::create(&out).map_err(|x| x.to_string())?;
            std::io::copy(&mut e, &mut w).map_err(|x| x.to_string())?;
        }
        let mut inner = dest.clone();
        if rvc_detect(&dest).get("engine").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
            let dirs: Vec<PathBuf> = std::fs::read_dir(&dest).map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default();
            if dirs.len() == 1 && !rvc_detect(&dirs[0]).get("engine").and_then(|v| v.as_str()).unwrap_or("").is_empty() { inner = dirs[0].clone(); }
        }
        let detected = rvc_detect(&inner);
        if detected.get("engine").and_then(|v| v.as_str()).unwrap_or("").is_empty() { return Err("没认出这是什么模型：压缩包内没有 .pth 或 config.yaml + .pt".to_string()); }
        let manifest = std::fs::read_to_string(inner.join("manifest.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).unwrap_or_else(|| serde_json::json!({}));
        // 压缩包可能多一层：model 以解压根为 dir，文件路径加相对前缀，list/remove 只认顶层目录。
        let prefix = inner.strip_prefix(&dest).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
        let mut files_val = manifest.get("files").cloned().unwrap_or_else(|| detected["files"].clone());
        if !prefix.is_empty() {
            if let Some(o) = files_val.as_object_mut() {
                for v in o.values_mut() {
                    if let Some(s) = v.as_str() { if !s.is_empty() { *v = serde_json::json!(format!("{prefix}/{s}")); } }
                }
            }
        }
        let model = serde_json::json!({
            "id": id, "name": base, "engine": detected["engine"],
            "version": manifest.get("version").cloned().unwrap_or_else(|| serde_json::json!("")),
            "sr": manifest.get("sr").and_then(|v| v.as_u64()).or_else(|| detected.get("sr").and_then(|v| v.as_u64())).unwrap_or(0),
            "f0": manifest.get("f0").and_then(|v| v.as_bool()).unwrap_or(true),
            "dir": oto_path_text(&dest), "files": files_val,
            "defaults": manifest.get("defaults").cloned().unwrap_or_else(rvc_defaults_value), "source": "zip",
            "lang": manifest.get("lang").cloned().unwrap_or_else(|| serde_json::json!("")), "work": manifest.get("work").cloned().unwrap_or_else(|| serde_json::json!("")),
        });
        std::fs::write(dest.join("model.json"), serde_json::to_string_pretty(&model).map_err(|x| x.to_string())?).map_err(|x| x.to_string())?;
        Ok(serde_json::json!({ "ok": true, "model": model }))
    })();
    if result.is_err() { let _ = std::fs::remove_dir_all(&dest); }
    result.unwrap_or_else(|e| oto_err(&e))
}

#[tauri::command]
fn rvc_pick_zip(app: AppHandle) -> serde_json::Value {
    match app.dialog().file().set_title("选择 RVC 模型压缩包").add_filter("ZIP", &["zip"]).blocking_pick_file().and_then(file_path_string) {
        Some(path) => serde_json::json!({ "ok": true, "path": path }),
        None => serde_json::json!({ "canceled": true }),
    }
}

#[tauri::command]
fn rvc_import_zip(path: String, opts: Option<serde_json::Value>) -> serde_json::Value {
    rvc_import_zip_at(&rvc_root(), Path::new(&path), &opts.unwrap_or_else(|| serde_json::json!({})))
}

const RVC_CATALOG_JSON: &str = include_str!("../../../main/rvc-catalog.json");

#[tauri::command]
fn rvc_catalog() -> serde_json::Value {
    match serde_json::from_str::<serde_json::Value>(RVC_CATALOG_JSON) {
        Ok(v) => serde_json::json!({ "ok": true, "catalog": v }),
        Err(e) => oto_err(&e.to_string()),
    }
}

#[tauri::command]
fn rvc_open_catalog_page(url: String) -> serde_json::Value { open_external(url) }

fn rvc_find_model(root: &Path, id: &str) -> Option<(serde_json::Value, bool)> {
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let d = e.path();
            let m = std::fs::read_to_string(d.join("model.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
            if let Some(m) = m { if m.get("id").and_then(|v| v.as_str()) == Some(id) { return Some((m, true)); } }
        }
    }
    let idx = std::fs::read_to_string(root.join("index.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())?;
    let m = idx.get("models")?.get(id)?.clone();
    Some((m, false))
}

fn rvc_patch_model(mut m: serde_json::Value, raw: &serde_json::Value) -> (serde_json::Value, serde_json::Value) {
    let mut patched = serde_json::Map::new();
    if let Some(o) = m.as_object_mut() {
        for k in ["version", "sr", "f0", "engine"] {
            if let Some(v) = raw.get(k) {
                let changed = o.get(k).map(|old| old != v).unwrap_or(true);
                if changed { o.insert(k.to_string(), v.clone()); patched.insert(k.to_string(), v.clone()); }
            }
        }
    }
    (m, serde_json::Value::Object(patched))
}

#[tauri::command]
async fn rvc_probe(id: String) -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(move || {
        let root = rvc_root();
        let Some((mut model, _physical)) = rvc_find_model(&root, &id) else { return oto_err("模型不存在") };
        let dir = model.get("dir").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if !Path::new(&dir).is_dir() { return oto_err("模型目录不存在"); }
        let (Some(py), Some(engine)) = (python_path(), engine_dir()) else { return oto_err("Python/引擎目录不存在") };
        let script = engine.join("engine_rvc.py");
        if !script.is_file() { return oto_err("engine_rvc.py 不存在"); }
        let mut cmd = Command::new(&py); cmd.arg(&script).arg("probe").arg("--model").arg(&dir); apply_engine_env(&mut cmd);
        let out = match cmd.output() {
            Ok(o) => o, Err(e) => return oto_err(&e.to_string()),
        };
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let Some(raw) = parse_health_json(&stdout) else { return serde_json::json!({ "ok": false, "error": format!("引擎无 JSON 结果: {}", stderr.chars().rev().take(400).collect::<String>().chars().rev().collect::<String>()) }) };
        if raw.get("ok").and_then(|v| v.as_bool()) != Some(true) { return serde_json::json!({ "ok": false, "error": raw.get("error").cloned().unwrap_or_else(|| serde_json::json!("probe failed")), "raw": raw }) };
        let (patched_model, patch) = rvc_patch_model(model, &raw);
        if let Err(e) = rvc_save_model(&root, &patched_model) { return oto_err(&e); }
        model = patched_model;
        serde_json::json!({ "ok": true, "model": model, "patched": patch, "raw": raw })
    }).await.unwrap_or_else(|e| oto_err(&e.to_string()))
}

/// 文件关联冷启动：从 argv 里挑第一个存在的 .mid/.midi（跳过 Tauri 自己的参数）。
fn pending_open_from_args<I: IntoIterator<Item = String>>(args: I) -> Option<PathBuf> {
    for raw in args.into_iter().skip(1) {
        if raw.starts_with('-') { continue; }
        let p = PathBuf::from(&raw);
        let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
        if (ext == "mid" || ext == "midi") && p.is_file() { return Some(p); }
    }
    None
}

struct PendingOpen(Mutex<Option<PathBuf>>);

#[tauri::command]
fn take_pending_open_file(state: State<'_, PendingOpen>) -> serde_json::Value {
    let path = state.0.lock().unwrap_or_else(|e| e.into_inner()).take();
    let Some(path) = path else { return serde_json::Value::Null };
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::json!({ "name": path.file_name().and_then(|x| x.to_str()).unwrap_or("opened.mid"), "bytes": bytes }),
        Err(_) => serde_json::Value::Null,
    }
}

const SINGLE_INSTANCE_PORT: u16 = 47823;

/// 已有实例时把待开文件（或 FOCUS）发给它；连不上/写失败返回 false。
fn single_instance_forward_at(port: u16, path: Option<&Path>) -> bool {
    for _ in 0..10 {
        if let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) {
            let msg = path.map(|p| p.display().to_string()).unwrap_or_else(|| "__FOCUS__".to_string());
            return s.write_all(msg.as_bytes()).is_ok() && s.write_all(b"\n").is_ok();
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    false
}

fn single_instance_forward(path: Option<&Path>) -> bool { single_instance_forward_at(SINGLE_INSTANCE_PORT, path) }

fn start_single_instance_listener(listener: TcpListener, app: AppHandle) {
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut line = String::new();
            let mut r = BufReader::new(stream);
            if r.read_line(&mut line).is_err() { continue; }
            let msg = line.trim();
            if msg == "__FOCUS__" {
                if let Some(w) = app.webview_windows().values().next() {
                    let _ = w.unminimize(); let _ = w.show(); let _ = w.set_focus();
                }
                continue;
            }
            let path = PathBuf::from(msg);
            let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
            if ext != "mid" && ext != "midi" { continue; }
            if let Ok(bytes) = std::fs::read(&path) {
                if bytes.len() > 64 * 1024 * 1024 { continue; }
                if let Some(st) = app.try_state::<PendingOpen>() { *st.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(path.clone()); }
                let payload = serde_json::json!({ "name": path.file_name().and_then(|x| x.to_str()).unwrap_or("opened.mid"), "bytes": bytes });
                let _ = app.emit("open-file", payload);
                if let Some(w) = app.webview_windows().values().next() { let _ = w.unminimize(); let _ = w.show(); let _ = w.set_focus(); }
            }
        }
    });
}

const RVC_CATALOG_API: &str = "https://www.modelscope.cn/api/v1/models/aihobbyist/RVC_Model_Collection/repo/files?Revision=master&Recursive=True";

/// 把 ModelScope 文件树转成与 main/rvc-catalog.json 相同的最小结构（只收 blob 的 .pth/.index）。
fn rvc_catalog_from_api(body: &str) -> Result<serde_json::Value, String> {
    let v: serde_json::Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
    let files = v.get("Data").and_then(|d| d.get("Files")).and_then(|f| f.as_array()).ok_or_else(|| "目录响应缺少 Data.Files".to_string())?;
    let mut by_dir: std::collections::BTreeMap<String, (Option<String>, Option<String>)> = std::collections::BTreeMap::new();
    for f in files {
        if f.get("Type").and_then(|t| t.as_str()) != Some("blob") { continue; }
        let Some(path) = f.get("Path").and_then(|p| p.as_str()) else { continue };
        let dir = path.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default();
        let name = path.rsplit_once('/').map(|(_, n)| n).unwrap_or(path);
        let lower = name.to_ascii_lowercase();
        let e = by_dir.entry(dir).or_insert((None, None));
        if lower.ends_with(".pth") { e.0 = Some(path.to_string()); }
        else if lower.ends_with(".index") { e.1 = Some(path.to_string()); }
    }
    let langs = ["中文", "日语", "英语", "韩语"];
    let mut models = Vec::new();
    for (dir, (pth, index)) in by_dir {
        let Some(pth) = pth else { continue };
        let parts: Vec<&str> = dir.split('/').collect();
        let gen = parts.first().copied().unwrap_or("");
        let sr = if gen.contains("40k") { 40000 } else if gen.contains("48k") { 48000 } else if gen.contains("32k") { 32000 } else { 0 };
        let has_lang = parts.len() > 3 && langs.contains(&parts[2]);
        models.push(serde_json::json!({
            "id": format!("rvc:{dir}"), "name": parts.last().copied().unwrap_or(""), "work": parts.get(1).copied().unwrap_or(""),
            "lang": if has_lang { parts[2] } else { "未标语言" }, "sr": sr, "gen": gen, "engine": "rvc", "repo": "rvc",
            "pth": pth, "pthSize": 0, "index": index.unwrap_or_default(), "indexSize": 0,
        }));
    }
    Ok(serde_json::json!({ "generated": format!("unix:{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)), "refreshed": true, "models": models }))
}

#[tauri::command]
async fn rvc_refresh_catalog() -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(move || {
        let out = match Command::new("curl.exe").args(["-L", "--silent", "--show-error", "--max-time", "30", RVC_CATALOG_API]).output() {
            Ok(o) => o, Err(e) => return oto_err(&format!("curl 不可用: {e}")),
        };
        if !out.status.success() { return oto_err(&String::from_utf8_lossy(&out.stderr).chars().rev().take(400).collect::<String>().chars().rev().collect::<String>()); }
        let body = String::from_utf8_lossy(&out.stdout).to_string();
        let catalog = match rvc_catalog_from_api(&body) { Ok(c) => c, Err(e) => return oto_err(&e) };
        let n = catalog.get("models").and_then(|m| m.as_array()).map(|m| m.len()).unwrap_or(0);
        let cache = data_dir().join("rvc-catalog.json");
        let _ = std::fs::create_dir_all(cache.parent().unwrap_or_else(|| Path::new(".")));
        if let Err(e) = std::fs::write(&cache, serde_json::to_string_pretty(&catalog).unwrap_or_default()) { return oto_err(&e.to_string()); }
        serde_json::json!({ "ok": true, "count": n, "generated": catalog.get("generated").cloned().unwrap_or(serde_json::Value::Null) })
    }).await.unwrap_or_else(|e| oto_err(&e.to_string()))
}

fn plugin_platform_base() -> String { std::env::var("FUFUMIDI_PLATFORM_URL").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "https://platform.fufumidi.de5.net".to_string()).trim_end_matches('/').to_string() }

fn plugin_catalog_cache_reply(mut v: serde_json::Value, url: &str) -> serde_json::Value {
    if let Some(o) = v.as_object_mut() {
        o.insert("ok".into(), serde_json::json!(true));
        o.insert("url".into(), serde_json::json!(url));
        o.insert("cached".into(), serde_json::json!(true));
    }
    v
}

fn plugin_catalog_from_json(body: &str, channel: &str, url: &str) -> serde_json::Value {
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(v) => serde_json::json!({
            "ok": true, "url": url, "channel": v.get("channel").and_then(|x| x.as_str()).unwrap_or(channel),
            "generatedAt": v.get("generatedAt").cloned().unwrap_or(serde_json::json!("")),
            "plugins": v.get("plugins").cloned().unwrap_or_else(|| serde_json::json!([])),
        }),
        Err(e) => oto_err(&e.to_string()),
    }
}

#[tauri::command]
fn plugins_installed_list() -> serde_json::Value {
    let dir = data_dir().join("plugins");
    serde_json::json!({ "ok": true, "dir": oto_path_text(&dir), "plugins": plugins_list() })
}

/// 平台外链只接受站内相对路径；绝对 URL/空白/引号/尖括号一律回退 /（与 Electron 白名单一致）。
fn plugin_platform_rel(rel: Option<&str>) -> String {
    let mut p = rel.unwrap_or("/").to_string();
    if p.is_empty() { p = "/".to_string(); }
    if !p.starts_with('/') { p = format!("/{p}"); }
    if p.len() > 120 || p.chars().any(|c| c.is_whitespace() || c == '"' || c == '\'' || c == '<' || c == '>') { "/".to_string() } else { p }
}

#[tauri::command]
fn plugins_platform_info() -> serde_json::Value {
    let base = plugin_platform_base();
    let host = base.trim_start_matches("https://").trim_start_matches("http://").to_string();
    serde_json::json!({ "ok": true, "base": base, "host": host })
}

#[tauri::command]
async fn plugins_catalog(channel: Option<String>) -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(move || {
        let ch = if channel.as_deref() == Some("beta") { "beta" } else { "stable" };
        let url = format!("{}/api/store/manifest/{ch}", plugin_platform_base());
        let cache = data_dir().join(format!("plugins-manifest-{ch}.json"));
        let cached = || std::fs::read_to_string(&cache).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
        let out = match Command::new("curl.exe").args(["-L", "--silent", "--show-error", "--max-time", "15", "-H", "accept: application/json", &url]).output() {
            Ok(o) => o, Err(e) => {
                return cached().map(|v| plugin_catalog_cache_reply(v, &url)).unwrap_or_else(|| oto_err(&format!("curl 不可用且无缓存: {e}")));
            }
        };
        if !out.status.success() {
            return cached().map(|v| plugin_catalog_cache_reply(v, &url)).unwrap_or_else(|| oto_err(&String::from_utf8_lossy(&out.stderr).chars().rev().take(400).collect::<String>().chars().rev().collect::<String>()));
        }
        let body = String::from_utf8_lossy(&out.stdout).to_string();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
            let _ = std::fs::write(&cache, serde_json::to_string(&v).unwrap_or_default());
        }
        plugin_catalog_from_json(&body, ch, &url)
    }).await.unwrap_or_else(|e| oto_err(&e.to_string()))
}

#[tauri::command]
fn plugins_open_platform(rel: Option<String>) -> serde_json::Value {
    let base = plugin_platform_base();
    let url = format!("{base}{}", plugin_platform_rel(rel.as_deref()));
    open_external(url)
}

fn plugin_token_dir(token: &str) -> Option<PathBuf> {
    if token.is_empty() || token.len() > 80 || !token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { return None; }
    Some(data_dir().join("temp").join("plugin-install").join(token))
}

fn plugin_id_valid(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() < 2 || bytes.len() > 64 { return false; }
    if !bytes[0].is_ascii_alphanumeric() { return false; }
    bytes.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
}

fn plugin_url_encode(slug: &str) -> String {
    let mut out = String::new();
    for b in slug.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') { out.push(b as char); }
        else { out.push_str(&format!("%{b:02X}")); }
    }
    out
}

fn plugin_find_installed(plugins_dir: &Path, id: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(plugins_dir).ok()?;
    for e in entries.flatten() {
        let d = e.path();
        if !d.is_dir() { continue; }
        let m = std::fs::read_to_string(d.join("plugin.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
        if m.and_then(|v| v.get("id").and_then(|x| x.as_str()).map(|s| s == id)).unwrap_or(false) { return Some(d); }
    }
    None
}

fn plugin_zip_entry_unsafe(name: &str) -> bool {
    name.is_empty() || name.starts_with('/') || name.starts_with("//") || name.contains("..") || name.contains(':')
}

fn plugin_inspect_zip(zip_path: &Path, plugins_dir: &Path) -> Result<serde_json::Value, String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    if zip.len() > 2000 { return Err("压缩包条目过多".to_string()); }
    let mut total: u64 = 0;
    let mut names: Vec<String> = Vec::new();
    for i in 0..zip.len() {
        let e = zip.by_index(i).map_err(|x| x.to_string())?;
        let name = e.name().replace('\\', "/");
        if name.is_empty() { continue; }
        if name.contains("..") || name.starts_with('/') { return Err(format!("压缩包包含不安全路径：{name}")); }
        total += e.size();
        if total > 100 * 1024 * 1024 { return Err("解压后超过 100MB 上限".to_string()); }
        names.push(name);
    }
    let manifest_name = names.iter().filter(|n| n.rsplit('/').next().map(|x| x.eq_ignore_ascii_case("plugin.json")).unwrap_or(false)).min_by_key(|n| (n.matches('/').count(), n.len())).cloned().ok_or_else(|| "包里找不到 plugin.json".to_string())?;
    let mut entry = zip.by_name(&manifest_name).map_err(|e| e.to_string())?;
    let mut raw = String::new();
    entry.read_to_string(&mut raw).map_err(|e| e.to_string())?;
    let manifest: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("plugin.json 解析失败：{e}"))?;
    let id = manifest.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if !plugin_id_valid(id) { return Err(format!("plugin.json 的 id「{id}」不合法")); }
    let root_name = manifest_name.split('/').next().filter(|_| manifest_name.contains('/')).unwrap_or("");
    let prefix = if root_name.is_empty() { String::new() } else { format!("{root_name}/") };
    let existing = plugin_find_installed(plugins_dir, id);
    let files: Vec<serde_json::Value> = names.iter().filter(|n| !n.ends_with('/')).map(|n| serde_json::json!({ "path": n.strip_prefix(&prefix).unwrap_or(n), "size": 0 })).collect();
    Ok(serde_json::json!({
        "id": id, "prefix": prefix, "targetDirName": if root_name.is_empty() { id } else { root_name },
        "manifest": {
            "id": id, "name": manifest.get("name").and_then(|v| v.as_str()).unwrap_or(id),
            "version": manifest.get("version").and_then(|v| v.as_str()).unwrap_or("0.0.0"),
            "author": manifest.get("author").and_then(|v| v.as_str()).unwrap_or(""),
            "description": manifest.get("description").and_then(|v| v.as_str()).unwrap_or(""),
            "entry": manifest.get("entry").and_then(|v| v.as_str()).unwrap_or("index.js"),
        },
        "files": files, "fileCount": names.len(), "unpackedBytes": total,
        "existing": existing.map(|d| d.display().to_string()),
        "isUpgrade": plugin_find_installed(plugins_dir, id).is_some(),
    }))
}

#[tauri::command]
async fn plugins_install_from_platform(slug: String, version: Option<String>) -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(move || {
        if slug.trim().is_empty() { return oto_err("缺少插件 slug"); }
        let token = format!("{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        let Some(dir) = plugin_token_dir(&token) else { return oto_err("token 非法") };
        if let Err(e) = std::fs::create_dir_all(&dir) { return oto_err(&e.to_string()); }
        let zip_path = dir.join("package.zip");
        let mut url = format!("{}/api/store/plugins/{}/download?source=app", plugin_platform_base(), plugin_url_encode(slug.trim()));
        if let Some(v) = version.filter(|v| !v.trim().is_empty()) { url.push_str(&format!("&version={}", plugin_url_encode(v.trim()))); }
        let out = match Command::new("curl.exe").args(["-f", "-L", "--silent", "--show-error", "--max-time", "120", "-H", "Accept: application/zip", "-o"]).arg(&zip_path).arg(&url).output() {
            Ok(o) => o, Err(e) => { let _ = std::fs::remove_dir_all(&dir); return oto_err(&format!("curl 不可用: {e}")); }
        };
        if !out.status.success() || !zip_path.is_file() { let _ = std::fs::remove_dir_all(&dir); return oto_err(&String::from_utf8_lossy(&out.stderr).chars().rev().take(400).collect::<String>().chars().rev().collect::<String>()); }
        match plugin_inspect_zip(&zip_path, &data_dir().join("plugins")) {
            Ok(mut info) => { info["ok"] = serde_json::json!(true); info["token"] = serde_json::json!(token); info },
            Err(e) => { let _ = std::fs::remove_dir_all(&dir); oto_err(&e) }
        }
    }).await.unwrap_or_else(|e| oto_err(&e.to_string()))
}

#[tauri::command]
fn plugins_confirm_install(token: String, overwrite: Option<bool>) -> serde_json::Value {
    let Some(dir) = plugin_token_dir(&token) else { return oto_err("token 非法") };
    let zip_path = dir.join("package.zip");
    if !zip_path.is_file() { return oto_err("下载记录已失效，请重新下载"); }
    let plugins_dir = data_dir().join("plugins");
    let result = plugins_confirm_install_at(&zip_path, &plugins_dir, &token, overwrite.unwrap_or(false));
    let _ = std::fs::remove_dir_all(&dir);
    match result {
        Ok(mut v) => {
            let list = plugins_list();
            let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            if let Some(o) = v.as_object_mut() {
                o.insert("activated".into(), list.iter().find(|p| p.get("id").and_then(|x| x.as_str()) == Some(id.as_str())).cloned().unwrap_or(serde_json::Value::Null));
                o.insert("total".into(), serde_json::json!(list.len()));
            }
            v
        }
        Err(e) => oto_err(&e),
    }
}

fn plugins_confirm_install_at(zip_path: &Path, plugins_dir: &Path, token: &str, overwrite: bool) -> Result<serde_json::Value, String> {
    let _ = std::fs::create_dir_all(plugins_dir);
    let info = plugin_inspect_zip(zip_path, plugins_dir)?;
    let id = info.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let target = info.get("existing").and_then(|v| v.as_str()).map(PathBuf::from).unwrap_or_else(|| plugins_dir.join(info.get("targetDirName").and_then(|v| v.as_str()).unwrap_or(&id)));
    if target.exists() && !overwrite { return Err("插件已存在，需确认覆盖".to_string()); }
    let backup = if target.exists() {
        let b = target.with_file_name(format!(".install-backup-{token}"));
        let _ = std::fs::remove_dir_all(&b);
        std::fs::rename(&target, &b).map_err(|e| e.to_string())?;
        Some(b)
    } else { None };
    let result = (|| -> Result<serde_json::Value, String> {
        std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        let prefix = info.get("prefix").and_then(|v| v.as_str()).unwrap_or("");
        let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        for i in 0..zip.len() {
            let mut e = zip.by_index(i).map_err(|x| x.to_string())?;
            let name = e.name().replace('\\', "/");
            let Some(rel) = name.strip_prefix(prefix) else { continue };
            if rel.is_empty() || rel.ends_with('/') { continue; }
            if plugin_zip_entry_unsafe(rel) { return Err(format!("不安全路径：{rel}")); }
            let dest = target.join(rel);
            if let Some(parent) = dest.parent() { std::fs::create_dir_all(parent).map_err(|x| x.to_string())?; }
            let mut out = std::fs::File::create(&dest).map_err(|x| x.to_string())?;
            std::io::copy(&mut e, &mut out).map_err(|x| x.to_string())?;
        }
        Ok(serde_json::json!({ "ok": true, "id": id, "dir": oto_path_text(&target) }))
    })();
    match result {
        Ok(v) => { if let Some(b) = backup { let _ = std::fs::remove_dir_all(&b); } Ok(v) }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&target);
            if let Some(b) = backup { let _ = std::fs::rename(&b, &target); }
            Err(e)
        }
    }
}

#[tauri::command]
fn plugins_cancel_install(token: String) -> serde_json::Value {
    match plugin_token_dir(&token) {
        Some(dir) => { let _ = std::fs::remove_dir_all(&dir); serde_json::json!({ "ok": true }) },
        None => oto_err("token 非法"),
    }
}

struct VideoStream { path: PathBuf, bytes: u64, container: String }

struct VideoExportState(Arc<Mutex<HashMap<String, VideoStream>>>);

fn video_bytes(v: &serde_json::Value) -> Vec<u8> { v.as_array().map(|a| a.iter().filter_map(|x| x.as_u64()).map(|n| n as u8).collect()).unwrap_or_default() }

#[tauri::command]
fn video_export_begin(state: State<'_, VideoExportState>, opts: Option<serde_json::Value>) -> serde_json::Value {
    let container = opts.as_ref().and_then(|o| o.get("container")).and_then(|v| v.as_str()).unwrap_or("h264");
    let container = if container == "webm" { "webm" } else { "h264" };
    let uniq = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let id = format!("v{}-{uniq}", std::process::id());
    let dir = data_dir().join("temp").join("fufumidi-video");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(format!("{id}.{container}"));
    if let Err(e) = std::fs::File::create(&path) { return oto_err(&e.to_string()); }
    if let Ok(mut m) = state.0.lock() { m.insert(id.clone(), VideoStream { path: path.clone(), bytes: 0, container: container.to_string() }); }
    serde_json::json!({ "ok": true, "id": id, "container": container, "path": oto_path_text(&path) })
}

#[tauri::command]
fn video_export_write(state: State<'_, VideoExportState>, id: String, data: Vec<u8>) -> serde_json::Value {
    let mut map = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let Some(st) = map.get_mut(&id) else { return oto_err("stream-not-found") };
    match std::fs::OpenOptions::new().append(true).open(&st.path).and_then(|mut f| { use std::io::Write; f.write_all(&data) }) {
        Ok(_) => { st.bytes += data.len() as u64; serde_json::json!({ "ok": true, "bytes": st.bytes }) },
        Err(e) => oto_err(&e.to_string()),
    }
}

#[tauri::command]
fn video_export_abort(state: State<'_, VideoExportState>, id: String) -> serde_json::Value {
    let mut map = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(st) = map.remove(&id) { let _ = std::fs::remove_file(st.path); }
    serde_json::json!({ "ok": true })
}

#[tauri::command]
fn video_export_end(app: AppHandle, state: State<'_, VideoExportState>, opts: serde_json::Value) -> serde_json::Value {
    let id = opts.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let st = { let mut m = state.0.lock().unwrap_or_else(|e| e.into_inner()); m.remove(id) };
    let Some(st) = st else { return oto_err("stream-not-found") };
    if st.bytes == 0 { let _ = std::fs::remove_file(&st.path); return oto_err("empty-stream"); }
    let mut out = opts.get("targetPath").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if out.is_empty() {
        let name = opts.get("name").and_then(|v| v.as_str()).unwrap_or("FuFumidi-video").trim().trim_end_matches(".mid").to_string();
        let picked = app.dialog().file().set_title("导出视频 MP4").set_file_name(format!("{}{}", if name.is_empty() { "FuFumidi-video" } else { &name }, ".mp4")).add_filter("MP4", &["mp4"]).blocking_save_file();
        let Some(p) = picked.and_then(|p| p.into_path().ok()) else { let _ = std::fs::remove_file(&st.path); return serde_json::json!({ "ok": false, "canceled": true }); };
        out = p.display().to_string();
    }
    let audio = opts.get("audio").map(video_bytes).unwrap_or_default();
    let wav = if audio.is_empty() { None } else {
        let p = data_dir().join("temp").join("fufumidi-video").join(format!("{id}.wav"));
        if let Err(e) = std::fs::write(&p, &audio) { let _ = std::fs::remove_file(&st.path); return oto_err(&e.to_string()); }
        Some(p)
    };
    let fps = opts.get("fps").and_then(|v| v.as_u64()).unwrap_or(24).clamp(1, 240);
    let mut args: Vec<String> = vec!["-y".into(), "-hide_banner".into(), "-loglevel".into(), "error".into()];
    if st.container == "h264" { args.extend(["-r".into(), fps.to_string(), "-f".into(), "h264".into(), "-framerate".into(), fps.to_string()]); }
    args.extend(["-i".into(), st.path.display().to_string()]);
    if let Some(w) = &wav {
        let off = opts.get("audioOffset").and_then(|v| v.as_f64()).unwrap_or(0.0).max(0.0);
        if off > 0.0 { args.extend(["-ss".into(), format!("{off:.6}")]); }
        args.extend(["-i".into(), w.display().to_string(), "-map".into(), "0:v:0".into(), "-map".into(), "1:a:0".into()]);
    }
    args.extend(["-c:v".into(), "copy".into(), "-pix_fmt".into(), "yuv420p".into()]);
    if wav.is_some() { args.extend(["-c:a".into(), "aac".into()]); }
    let dur = opts.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
    if dur > 0.0 { args.extend(["-t".into(), format!("{dur:.6}")]); } else { args.push("-shortest".into()); }
    args.extend(["-movflags".into(), "+faststart".into(), out.clone()]);
    let Some(py) = python_path() else { let _ = std::fs::remove_file(&st.path); if let Some(w)=wav { let _=std::fs::remove_file(w); } return oto_err("python runtime not found") };
    let code = format!(r#"import json, subprocess, imageio_ffmpeg
ff = imageio_ffmpeg.get_ffmpeg_exe()
r = subprocess.run([ff] + {}, capture_output=True)
print(json.dumps({{"ok": r.returncode == 0, "err": (r.stderr or b"").decode("utf-8", "replace")[-300:]}}))
"#, serde_json::to_string(&args).unwrap_or_else(|_| "[]".into()));
    let run = Command::new(&py).args(["-c", &code]).env("PYTHONIOENCODING", "utf-8").creation_flags(0x08000000).output();
    let parsed = match run { Ok(o) => parse_health_json(&String::from_utf8_lossy(&o.stdout)), Err(_) => None };
    let _ = std::fs::remove_file(&st.path);
    if let Some(w) = wav { let _ = std::fs::remove_file(w); }
    match parsed {
        Some(v) if v.get("ok").and_then(|x| x.as_bool()) == Some(true) => serde_json::json!({ "ok": true, "path": out, "bytes": st.bytes, "copy": true }),
        Some(v) => oto_err(v.get("err").and_then(|x| x.as_str()).unwrap_or("ffmpeg failed")),
        None => oto_err("ffmpeg helper failed"),
    }
}

struct CoverJob { child: std::process::Child }
struct CoverState(Arc<Mutex<Option<CoverJob>>>);
static COVER_CANCELED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn cover_sep_arch(name: &str) -> String {
    let n = name.to_ascii_lowercase();
    if n.contains("htdemucs") || n.contains("demucs") { "HTDemucs".into() }
    else if n.contains("bs_roformer") || n.contains("bs-roformer") { "BS-Roformer".into() }
    else if n.contains("roformer") { "Mel-Band Roformer".into() }
    else if n.contains("mdx") { "MDX23C".into() }
    else if n.contains("scnet") { "SCNet".into() }
    else if n.ends_with(".pth") || n.ends_with(".pt") || n.ends_with(".th") || n.contains("uvr") { "UVR-VR".into() }
    else { String::new() }
}

fn sep_norm(s: &str) -> String {
    s.to_ascii_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

/// 在 _configs / msst_autocfg 里挑一份与模型名最匹配的 yaml。Electron 的 resolveSeparateModel
/// 也是先模型目录、再数据根共享配置；Tauri 以前只看模型目录，6stems 因而误报缺配置。
fn pick_sep_yaml(dir: &Path, want: &str) -> Option<PathBuf> {
    let w = sep_norm(want);
    let mut best: Option<(i32, PathBuf)> = None;
    for e in std::fs::read_dir(dir).ok().into_iter().flatten().flatten() {
        let p = e.path();
        let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
        if ext != "yaml" && ext != "yml" { continue; }
        let n = sep_norm(p.file_name().and_then(|x| x.to_str()).unwrap_or(""));
        let mut score = 0;
        if n == w { score += 100; }
        if w.contains("6stems") && n.contains("6stems") { score += 50; }
        if w.contains("4stems") && n.contains("4stems") { score += 50; }
        if w.contains("htdemucs") && n.contains("htdemucs") { score += 20; }
        if n.contains(&w) || w.contains(&n) { score += 10; }
        if score > 0 && best.as_ref().map(|(b, _)| score > *b).unwrap_or(true) { best = Some((score, p)); }
    }
    best.map(|(_, p)| p)
}

fn cover_sep_resolve_at(root: &Path, id: &str) -> Result<(PathBuf, Option<PathBuf>, String), String> {
    let name = Path::new(id).file_name().and_then(|x| x.to_str()).unwrap_or("").trim().to_string();
    if name.is_empty() || name == "." || name == ".." { return Err("分离模型 id 非法".into()); }
    let mut base: Option<PathBuf> = None;
    for c in [root.join(&name), root.join("multi").join(&name), root.join("separate").join(&name)] {
        if c.exists() { base = Some(c); break; }
    }
    if base.is_none() {
        fn walk(d: &Path, name: &str, depth: u32, hit: &mut Option<PathBuf>) {
            if depth > 3 || hit.is_some() { return; }
            let Ok(rd) = std::fs::read_dir(d) else { return };
            for e in rd.flatten() { if e.file_name().to_string_lossy() == name { *hit = Some(e.path()); return; } }
            for e in std::fs::read_dir(d).into_iter().flatten().flatten() {
                let p = e.path(); if p.is_dir() { walk(&p, name, depth + 1, hit); if hit.is_some() { return; } }
            }
        }
        let mut hit = None; walk(root, &name, 0, &mut hit); base = hit;
    }
    let Some(base) = base else { return Err(format!("找不到分离模型：{name}")) };
    let (weight, dir) = if base.is_file() { (base.clone(), base.parent().unwrap_or(root).to_path_buf()) } else {
        fn find_weights(d: &Path, depth: u32, best: &mut Option<(u64, PathBuf)>) {
            if depth > 2 { return; }
            let Ok(rd) = std::fs::read_dir(d) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_file() {
                    let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
                    if matches!(ext.as_str(), "safetensors" | "pth" | "pt" | "ckpt" | "th") {
                        let sz = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                        if best.as_ref().map(|(b, _)| sz > *b).unwrap_or(true) { *best = Some((sz, p)); }
                    }
                } else if p.is_dir() { find_weights(&p, depth + 1, best); }
            }
        }
        let mut best = None; find_weights(&base, 0, &mut best);
        let Some((_, w)) = best else { return Err(format!("分离模型目录里没有权重：{name}")) };
        (w, base.clone())
    };
    let mut config = std::fs::read_dir(&dir).ok().and_then(|rd| rd.flatten().map(|e| e.path()).find(|p| p.extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case("yaml") || x.eq_ignore_ascii_case("yml")).unwrap_or(false)));
    if config.is_none() {
        let want = weight.file_name().and_then(|x| x.to_str()).unwrap_or(&name);
        config = pick_sep_yaml(&root.join("_configs"), want)
            .or_else(|| pick_sep_yaml(&root.join("cache").join("msst_autocfg"), want));
    }
    let arch = cover_sep_arch(weight.to_string_lossy().as_ref());
    Ok((weight, config, arch))
}
fn cover_args(opts: &serde_json::Value, models_root: &Path) -> Result<Vec<String>, String> {
    let audio = opts.get("audio").and_then(|v| v.as_str()).unwrap_or("");
    if audio.is_empty() || !Path::new(audio).is_file() { return Err("请先选择源音频".into()); }
    let outdir = opts.get("outdir").and_then(|v| v.as_str()).unwrap_or("");
    if outdir.is_empty() { return Err("请选择输出目录".into()); }
    let singer_id = opts.get("singer").and_then(|v| v.get("id")).and_then(|v| v.as_str()).unwrap_or("");
    if singer_id.is_empty() { return Err("请选择一个导入的翻唱模型".into()); }
    let sep_id = opts.get("sepModel").and_then(|v| v.get("id")).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
    let mut a: Vec<String> = vec!["all".into(), audio.into(), "--outdir".into(), outdir.into(), "--rvc-model".into(), singer_id.into()];
    if let Some(sep) = sep_id {
        let (model, config, arch) = cover_sep_resolve_at(models_root, &sep)?;
        a.extend(["--sep-model".into(), model.display().to_string()]);
        if let Some(c) = config { a.extend(["--sep-config".into(), c.display().to_string()]); }
        if !arch.is_empty() { a.extend(["--sep-arch".into(), arch]); }
    }
    if let Some(n) = opts.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) { a.extend(["--name".into(), n.into()]); }
    if opts.get("sepMode").and_then(|v| v.as_str()) == Some("off") { a.push("--no-separate".into()); }
    let num = |k: &str, d: f64| opts.get(k).and_then(|v| v.as_f64()).unwrap_or(d);
    a.extend(["--transpose".into(), format!("{}", num("transpose", 0.0))]);
    if let Some(f0) = opts.get("f0Method").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) { a.extend(["--f0-method".into(), f0.into()]); }
    a.extend(["--index-rate".into(), format!("{}", num("indexRate", 0.3))]);
    a.extend(["--rms-mix-rate".into(), format!("{}", num("rmsMixRate", 0.25))]);
    a.extend(["--protect".into(), format!("{}", num("protect", 0.33))]);
    a.extend(["--chunk-sec".into(), format!("{}", num("chunkSec", 60.0))]);
    if opts.get("autoPredictF0").and_then(|v| v.as_bool()).unwrap_or(false) { a.push("--auto-predict-f0".into()); }
    a.extend(["--device".into(), opts.get("device").and_then(|v| v.as_str()).unwrap_or("auto").into()]);
    if let Some(c) = opts.get("clarityDb").and_then(|v| v.as_f64()).filter(|v| *v != 0.0) { a.extend(["--clarity-db".into(), format!("{c}")]); }
    if opts.get("noResume").and_then(|v| v.as_bool()).unwrap_or(false) { a.push("--no-resume".into()); }
    for (k, flag) in [("vocals", "--vocals"), ("instrumental", "--instrumental")] {
        if let Some(p) = opts.get(k).and_then(|v| v.as_str()).filter(|p| !p.is_empty() && Path::new(p).is_file()) { a.extend([flag.into(), p.into()]); }
    }
    Ok(a)
}

fn cover_singers_from_models(models: &[serde_json::Value]) -> Vec<serde_json::Value> {
    models.iter().filter(|m| m.get("engine").and_then(|v| v.as_str()) == Some("rvc")).map(|m| {
        let ready = m.get("ready").and_then(|v| v.as_bool()).unwrap_or(false);
        let missing: Vec<String> = m.get("missing").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
        let note = if !ready { if missing.is_empty() { "引擎未识别".to_string() } else { format!("缺文件：{}", missing.join("、")) } }
            else if m.get("external").and_then(|v| v.as_bool()).unwrap_or(false) { "引用式导入（源目录在应用外，删除只注销条目）".to_string() }
            else { "已导入".to_string() };
        let sr = m.get("sr").and_then(|v| v.as_u64()).unwrap_or(0);
        let mut arch_parts = vec!["RVC".to_string()];
        if let Some(v) = m.get("version").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) { arch_parts.push(v.to_string()); }
        if sr > 0 { arch_parts.push(sr.to_string()); }
        let arch = arch_parts.join(" · ");
        serde_json::json!({
            "kind": "rvc", "id": m.get("id").cloned().unwrap_or(serde_json::Value::Null),
            "name": m.get("name").cloned().unwrap_or(serde_json::Value::Null),
            "dir": m.get("dir").cloned().unwrap_or(serde_json::Value::Null),
            "ready": ready, "note": note, "arch": arch,
            "sr": sr, "lang": m.get("lang").cloned().unwrap_or_else(|| serde_json::json!("")),
            "work": m.get("work").cloned().unwrap_or_else(|| serde_json::json!("")),
        })
    }).collect()
}

#[tauri::command]
fn cover_singers() -> serde_json::Value {
    let list = rvc_list_at(&rvc_root());
    let models = list.get("models").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    serde_json::json!({ "ok": true, "rvc": cover_singers_from_models(&models) })
}

#[tauri::command]
fn cover_pick_audio(app: AppHandle) -> serde_json::Value {
    match app.dialog().file().set_title("选择要翻唱的歌曲").add_filter("音频", &["flac", "wav", "mp3", "m4a", "aac", "ogg", "opus"]).blocking_pick_file().and_then(file_path_string) {
        Some(p) => serde_json::json!({ "ok": true, "path": p }),
        None => serde_json::json!({ "canceled": true }),
    }
}

#[tauri::command]
fn cover_pick_dir(app: AppHandle) -> serde_json::Value {
    match app.dialog().file().set_title("选择输出目录").blocking_pick_folder().and_then(file_path_string) {
        Some(p) => serde_json::json!({ "ok": true, "path": p }),
        None => serde_json::json!({ "canceled": true }),
    }
}

#[tauri::command]
fn cover_open(path: String) -> serde_json::Value {
    let p = PathBuf::from(&path);
    if !p.exists() { return oto_err("路径不存在"); }
    #[cfg(target_os = "windows")]
    {
        match Command::new("explorer").arg(&p).spawn() { Ok(_) => serde_json::json!({ "ok": true }), Err(e) => oto_err(&e.to_string()) }
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = p; oto_err("not supported") }
}

#[tauri::command]
fn cover_cancel(state: State<'_, CoverState>) -> serde_json::Value {
    let mut g = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut job) = g.take() { COVER_CANCELED.store(true, Ordering::SeqCst); let _ = job.child.kill(); serde_json::json!({ "ok": true, "canceled": true }) } else { serde_json::json!({ "ok": true, "canceled": false }) }
}

#[tauri::command]
fn cover_run(state: State<'_, CoverState>, app: AppHandle, opts: serde_json::Value) -> serde_json::Value {
    if state.0.lock().unwrap_or_else(|e| e.into_inner()).is_some() { return oto_err("已有一个翻唱任务在跑，先取消它"); }
    COVER_CANCELED.store(false, Ordering::SeqCst);
    let args = match cover_args(&opts, &models_dir()) { Ok(a) => a, Err(e) => return oto_err(&e) };
    let outdir = opts.get("outdir").and_then(|v| v.as_str()).unwrap_or("");
    if let Err(e) = std::fs::create_dir_all(outdir) { return oto_err(&format!("输出目录不可写：{e}")); }
    let (Some(py), Some(engine)) = (python_path(), engine_dir()) else { return oto_err("Python/引擎目录不存在") };
    let script = engine.join("engine_cover.py");
    if !script.is_file() { return oto_err("engine_cover.py 不存在"); }
    let uniq = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let id = format!("cover{}-{uniq}", std::process::id());
    let mut cmd = Command::new(&py);
    cmd.current_dir(&engine).arg(&script).args(&args).stdout(Stdio::piped()).stderr(Stdio::null()).creation_flags(0x08000000);
    apply_engine_env(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c, Err(e) => return oto_err(&e.to_string()),
    };
    let stdout = child.stdout.take();
    *state.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(CoverJob { child });
    let shared = state.0.clone(); let app2 = app.clone(); let id2 = id.clone();
    std::thread::spawn(move || {
        let mut result: Option<serde_json::Value> = None;
        if let Some(out) = stdout {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let t = line.trim();
                if let Some(rest) = t.strip_prefix("###PROG ") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(rest) {
                        let pct = v.get("percent").and_then(|x| x.as_f64()).unwrap_or(-1.0);
                        let stage = v.get("stage").and_then(|x| x.as_str()).unwrap_or("");
                        let part = v.get("part").and_then(|x| x.as_u64());
                        let parts = v.get("parts").and_then(|x| x.as_u64());
                        let text = if let (Some(a), Some(b)) = (part, parts) { format!("{stage} {a}/{b}") } else { stage.to_string() };
                        let _ = app2.emit("cover:progress", serde_json::json!({ "id": id2, "percent": pct, "text": text, "stage": stage, "done": false }));
                    }
                    continue;
                }
                if let Some(rest) = t.strip_prefix("###RESULT ") { result = serde_json::from_str::<serde_json::Value>(rest).ok(); continue; }
                let _ = app2.emit("cover:progress", serde_json::json!({ "id": id2, "percent": -1, "log": t, "done": false }));
            }
        }
        {
            let mut g = shared.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(mut job) = g.take() { let _ = job.child.wait(); }
        }
        let aborted = COVER_CANCELED.load(Ordering::SeqCst);
        let ok = !aborted && result.as_ref().and_then(|r| r.get("ok")).and_then(|v| v.as_bool()) != Some(false);
        let err = if ok { String::new() } else { result.as_ref().and_then(|r| r.get("error")).and_then(|v| v.as_str()).unwrap_or("翻唱失败").to_string() };
        let _ = app2.emit("cover:progress", serde_json::json!({ "id": id2, "percent": 100, "done": true, "ok": ok, "aborted": aborted, "result": result, "error": err }));
    });
    serde_json::json!({ "ok": true, "id": id })
}

struct SeparateJob { child: std::process::Child }
struct SeparationState(Arc<Mutex<Option<SeparateJob>>>);
static SEPARATE_CANCELED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn separate_args(opts: &serde_json::Value, models_root: &Path, outdir: &Path) -> Result<Vec<String>, String> {
    let audio = opts.get("audio").and_then(|v| v.as_str()).unwrap_or("");
    if audio.is_empty() || !Path::new(audio).is_file() { return Err("请先选择要分离的音频".into()); }
    let id = opts.get("sep_model").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("");
    if id.is_empty() { return Err("请先选择处理模型".into()); }
    let (model, config, arch) = cover_sep_resolve_at(models_root, id)?;
    let mut a = vec!["separate".to_string(), audio.to_string(), "--output".into(), oto_path_text(outdir), "--model".into(), model.display().to_string()];
    if let Some(c) = config { a.extend(["--config".into(), c.display().to_string()]); }
    a.extend(["--arch".into(), arch]);
    if let Some(v) = opts.get("chunk_size").and_then(|v| v.as_u64()) { a.extend(["--chunk-size".into(), v.to_string()]); }
    if let Some(v) = opts.get("num_overlap").and_then(|v| v.as_u64()) { a.extend(["--num-overlap".into(), v.to_string()]); }
    a.extend(["--batch-size".into(), opts.get("batch_size").and_then(|v| v.as_u64()).unwrap_or(1).to_string()]);
    if let Some(stems) = opts.get("stems").and_then(|v| v.as_array()) { let v: Vec<String> = stems.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect(); if !v.is_empty() { a.extend(["--stems".into(), v.join(",")]); } }
    if let Some(f) = opts.get("format").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) { a.extend(["--format".into(), f.to_ascii_lowercase()]); }
    if opts.get("tta").and_then(|v| v.as_bool()).unwrap_or(false) { a.push("--tta".into()); }
    if opts.get("normalize").and_then(|v| v.as_bool()).unwrap_or(true) { a.push("--normalize".into()); }
    Ok(a)
}

#[tauri::command]
async fn separate_audio(state: State<'_, SeparationState>, app: AppHandle, opts: serde_json::Value) -> Result<serde_json::Value, String> {
    if state.0.lock().unwrap_or_else(|e| e.into_inner()).is_some() { return Err("已有一个分离任务在跑".into()); }
    SEPARATE_CANCELED.store(false, Ordering::SeqCst);
    let audio = opts.get("audio").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let audio_path = PathBuf::from(&audio);
    if audio.is_empty() || !audio_path.is_file() { return Err("请先选择要分离的音频".into()); }
    let outdir = opts.get("out_dir").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or_else(|| audio_path.parent().unwrap_or_else(|| Path::new(".")).to_path_buf());
    if let Err(e) = std::fs::create_dir_all(&outdir) { return Err(format!("输出目录不可写：{e}")); }
    let args = match separate_args(&opts, &models_dir(), &outdir) { Ok(a) => a, Err(e) => return Err(e) };
    let id = opts.get("id").and_then(|v| v.as_str()).unwrap_or("sep").to_string();
    let (Some(py), Some(engine)) = (python_path(), engine_dir()) else { return Err("Python/引擎目录不存在".into()) };
    let script = engine.join("music2midi.py");
    if !script.is_file() { return Err("music2midi.py 不存在".into()); }
    let mut cmd = Command::new(&py);
    cmd.current_dir(&engine).arg(&script).args(&args).stdout(Stdio::piped()).stderr(Stdio::null()).creation_flags(0x08000000);
    apply_engine_env(&mut cmd);
    let mut child = match cmd.spawn() { Ok(c) => c, Err(e) => return Err(e.to_string()) };
    let stdout = child.stdout.take();
    *state.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(SeparateJob { child });
    let shared = state.0.clone(); let app2 = app.clone(); let id2 = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut result: Option<serde_json::Value> = None;
        if let Some(out) = stdout {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let t = line.trim();
                if let Some(rest) = t.strip_prefix("###PROG ") {
                    if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(rest) {
                        if let Some(o) = v.as_object_mut() { o.insert("id".into(), serde_json::json!(id2)); }
                        let _ = app2.emit("engine:separate:progress", v);
                    }
                    continue;
                }
                if let Some(rest) = t.strip_prefix("###RESULT ") { result = serde_json::from_str::<serde_json::Value>(rest).ok(); continue; }
                let _ = app2.emit("engine:separate:log", serde_json::json!({ "id": id2, "line": t }));
            }
        }
        { let mut g = shared.lock().unwrap_or_else(|e| e.into_inner()); if let Some(mut job) = g.take() { let _ = job.child.wait(); } }
        let aborted = SEPARATE_CANCELED.load(Ordering::SeqCst);
        match result {
            Some(mut v) => { if aborted { v["ok"] = serde_json::json!(false); v["error"] = serde_json::json!("已取消"); v["aborted"] = serde_json::json!(true); } serde_json::json!({ "ok": v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false), "result": v }) },
            None => serde_json::json!({ "ok": false, "error": if aborted { "已取消" } else { "引擎未返回结果" } }),
        }
    }).await.map_err(|e| e.to_string())?;
    let outputs = result.get("result").and_then(|r| r.get("outputs")).cloned().unwrap_or_else(|| serde_json::json!([]));
    Ok(serde_json::json!({ "ok": result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false), "outputs": outputs, "out_dir": oto_path_text(&outdir), "error": result.get("error").cloned().unwrap_or(serde_json::Value::Null), "result": result.get("result").cloned().unwrap_or(serde_json::Value::Null) }))
}

fn omr_root() -> PathBuf { data_dir().join("omr") }

fn omr_lang_catalog() -> serde_json::Value {
    serde_json::json!([
        { "code": "eng", "name": "英语（速度记号、力度、乐器名多为英文缩写）" },
        { "code": "chi_sim", "name": "简体中文（标题、中文乐器名）" },
        { "code": "chi_tra", "name": "繁体中文" },
        { "code": "jpn", "name": "日语" }
    ])
}

fn omr_lang_status_at(root: &Path) -> serde_json::Value {
    let dir = root.join("tessdata");
    let mut installed = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.to_ascii_lowercase().ends_with(".traineddata") { continue; }
            let Ok(md) = e.metadata() else { continue };
            if md.len() < 5 * 1024 * 1024 { continue; }
            installed.push(serde_json::json!({ "code": name.trim_end_matches(".traineddata"), "bytes": md.len() }));
        }
    }
    serde_json::json!({ "ok": true, "dir": dir.display().to_string(), "installed": installed, "catalog": omr_lang_catalog() })
}

fn homr_status_at(root: &Path) -> serde_json::Value {
    let dir = root.join("homr");
    let venv_py = dir.join("venv").join("Scripts").join("python.exe");
    let site = dir.join("venv").join("Lib").join("site-packages").join("homr");
    let installed = venv_py.is_file() || site.is_dir();
    let bytes = if site.is_dir() { dir_size(&site) } else { 0 };
    serde_json::json!({ "ok": true, "installed": installed, "ready": installed && site.is_dir(), "dir": dir.display().to_string(), "weightBytes": bytes, "weights": [], "missing": 0, "reason": if installed { "" } else { "未安装" }, "license": "AGPL-3.0" })
}

fn sr_status_at(root: &Path) -> serde_json::Value {
    let dir = root.join("waifu2x");
    let installed = dir.is_dir() && std::fs::read_dir(&dir).map(|mut rd| rd.next().is_some()).unwrap_or(false);
    serde_json::json!({ "ok": true, "installed": installed, "dir": dir.display().to_string(), "bytes": if installed { dir_size(&dir) } else { 0 } })
}

#[tauri::command]
fn omr_engine_status() -> serde_json::Value {
    let exe = omr_root().join("audiveris").join("Audiveris").join("Audiveris.exe");
    let installed = exe.is_file();
    let bytes = std::fs::metadata(&exe).map(|m| m.len()).unwrap_or(0);
    serde_json::json!({ "ok": true, "installed": installed, "exe": exe.display().to_string(), "version": "5.5", "bytes": bytes, "url": "https://github.com/Audiveris/audiveris/releases" })
}

#[tauri::command]
fn omr_engine_open_dir() -> serde_json::Value {
    let dir = omr_root(); let _ = std::fs::create_dir_all(&dir);
    #[cfg(target_os = "windows")] { match Command::new("explorer").arg(&dir).spawn() { Ok(_) => serde_json::json!({ "ok": true }), Err(e) => oto_err(&e.to_string()) } }
    #[cfg(not(target_os = "windows"))] { oto_err("not supported") }
}

#[tauri::command]
fn omr_engine_remove() -> serde_json::Value {
    let _ = std::fs::remove_dir_all(omr_root().join("audiveris"));
    omr_engine_status()
}

#[tauri::command]
fn omr_lang_status() -> serde_json::Value { omr_lang_status_at(&omr_root()) }

#[tauri::command]
fn omr_lang_remove(code: String) -> serde_json::Value {
    if !code.chars().all(|c| c.is_ascii_lowercase() || c == '_') || code.len() < 2 || code.len() > 12 { return oto_err("语言代码非法"); }
    let _ = std::fs::remove_file(omr_root().join("tessdata").join(format!("{code}.traineddata")));
    omr_lang_status()
}

#[tauri::command]
fn omr_homr_status() -> serde_json::Value { homr_status_at(&omr_root()) }

#[tauri::command]
fn omr_homr_remove() -> serde_json::Value { let _ = std::fs::remove_dir_all(omr_root().join("homr")); omr_homr_status() }

#[tauri::command]
fn omr_sr_status() -> serde_json::Value { sr_status_at(&omr_root()) }

#[tauri::command]
fn omr_sr_remove() -> serde_json::Value { let _ = std::fs::remove_dir_all(omr_root().join("waifu2x")); omr_sr_status() }

fn github_json(url: &str) -> Result<serde_json::Value, String> {
    let out = Command::new("curl.exe").args(["-s", "-L", "--max-time", "25", "-H", "User-Agent: FuFumidi-Update", url]).creation_flags(0x08000000).output().map_err(|e| e.to_string())?;
    if !out.status.success() { return Err(format!("curl exit {}", out.status)); }
    serde_json::from_slice::<serde_json::Value>(&out.stdout).map_err(|e| e.to_string())
}

fn release_asset(rel: &serde_json::Value) -> Option<&serde_json::Value> {
    rel.get("assets").and_then(|v| v.as_array()).and_then(|a| a.iter().find(|x| x.get("name").and_then(|n| n.as_str()).map(|n| n.to_ascii_lowercase().contains("install")).unwrap_or(false)))
}

fn update_check_remote(channel: &str) -> serde_json::Value {
    let releases = match github_json("https://api.github.com/repos/qdTXTbp/FuFumidi/releases?per_page=10") {
        Ok(v) => v, Err(e) => return serde_json::json!({ "ok": false, "error": e }),
    };
    let arr = match releases.as_array() { Some(a) => a, None => return serde_json::json!({ "ok": false, "error": "GitHub releases 不是数组" }) };
    let want_beta = channel.eq_ignore_ascii_case("beta");
    let Some(rel) = arr.iter().find(|r| want_beta || r.get("prerelease").and_then(|v| v.as_bool()) != Some(true)) else {
        return serde_json::json!({ "ok": false, "error": "没有匹配通道的版本" });
    };
    let tag = rel.get("tag_name").and_then(|v| v.as_str()).unwrap_or("");
    let latest = tag.trim_start_matches(['v', 'V']).to_string();
    let asset = release_asset(rel);
    serde_json::json!({
        "ok": true, "current": env!("CARGO_PKG_VERSION"), "latest": latest, "tag": tag,
        "channel": if want_beta || rel.get("prerelease").and_then(|v| v.as_bool()) == Some(true) { "beta" } else { "stable" },
        "notes": rel.get("body").and_then(|v| v.as_str()).unwrap_or("").chars().take(500).collect::<String>(),
        "url": asset.and_then(|a| a.get("browser_download_url")).and_then(|v| v.as_str()).map(|s| s.to_string()),
        "name": asset.and_then(|a| a.get("name")).and_then(|v| v.as_str()).map(|s| s.to_string()),
        "html": rel.get("html_url").and_then(|v| v.as_str()).unwrap_or(""), "source": "github"
    })
}

#[tauri::command]
fn update_check(channel: Option<String>) -> serde_json::Value { update_check_remote(channel.as_deref().unwrap_or("stable")) }

#[tauri::command]
fn update_list() -> serde_json::Value {
    match github_json("https://api.github.com/repos/qdTXTbp/FuFumidi/releases?per_page=10") {
        Ok(v) => serde_json::Value::Array(v.as_array().map(|a| a.iter().map(|x| serde_json::json!({
            "tag": x.get("tag_name").cloned().unwrap_or(serde_json::Value::Null),
            "name": x.get("name").cloned().unwrap_or(serde_json::Value::Null),
            "prerelease": x.get("prerelease").cloned().unwrap_or(serde_json::json!(false)),
            "body": x.get("body").and_then(|b| b.as_str()).unwrap_or("").chars().take(240).collect::<String>(),
            "assets": x.get("assets").and_then(|v| v.as_array()).map(|a| a.iter().map(|z| serde_json::json!({ "name": z.get("name"), "url": z.get("browser_download_url"), "size": z.get("size") })).collect::<Vec<_>>()).unwrap_or_default()
        })).collect::<Vec<_>>()).unwrap_or_default()),
        Err(e) => serde_json::json!({ "error": e }),
    }
}

#[tauri::command]
fn update_notes(tag: Option<String>) -> serde_json::Value {
    let t = tag.unwrap_or_default(); let t = if t.starts_with('v') { t } else { format!("v{t}") };
    match github_json(&format!("https://api.github.com/repos/qdTXTbp/FuFumidi/releases/tags/{t}")) {
        Ok(v) => serde_json::json!({ "ok": true, "body": v.get("body").and_then(|b| b.as_str()).unwrap_or("") }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
fn launch_updater(app: AppHandle, channel: Option<String>) -> serde_json::Value {
    // 与旧 Electron 版同一路径：不依赖 Authenticode，直接拉起随包更新器。
    // 更新器自己用 Ed25519 签名的 update-manifest.json 校验安装包；Authenticode 只影响 SmartScreen 信任。
    let Some(dir) = exe_dir() else { return oto_err("无法定位安装目录") };
    let updater = dir.join("FuFumidi.update.exe");
    if updater.is_file() {
        #[cfg(target_os = "windows")]
        {
            let source = if channel.as_deref() == Some("beta") { "cnb-beta" } else { "cnb" };
            let spawn = Command::new(&updater).args(["-I", "-O", "-D", &dir.display().to_string(), "--source", source]).creation_flags(0x00000008 | 0x08000000).spawn();
            if let Err(e) = spawn { return serde_json::json!({ "ok": false, "error": e.to_string() }); }
            // 更新器替换的是正在运行的 exe：先起一个独立守护，等更新器退出后重启应用，再退出当前进程。
            let main_exe = dir.join("FuFumidi.exe");
            let script = format!("Wait-Process -Name FuFumidi.update -Timeout 600 -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3; Start-Process -FilePath '{}' -WorkingDirectory '{}'", main_exe.display(), dir.display());
            let _ = Command::new("powershell").args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script]).creation_flags(0x00000008 | 0x08000000).spawn();
            tauri_log("updater-launched; exiting for replacement");
            app.exit(0);
            return serde_json::json!({ "ok": true, "manual": false, "updater": updater.display().to_string() });
        }
    }
    // 更新器缺失时才回退到发布页（便携版/手工部署）。
    let r = update_check_remote(channel.as_deref().unwrap_or("stable"));
    let Some(url) = r.get("html").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else { return serde_json::json!({ "ok": false, "error": "更新器不存在且没有发布页" }); };
    #[cfg(target_os = "windows")]
    { match Command::new("cmd").args(["/C", "start", "", url]).creation_flags(0x08000000).spawn() { Ok(_) => serde_json::json!({ "ok": true, "manual": true, "url": url }), Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }) } }
    #[cfg(not(target_os = "windows"))] { let _ = url; serde_json::json!({ "ok": false, "error": "not supported" }) }
}

#[tauri::command]
fn plugin_pick_file(app: AppHandle) -> serde_json::Value {
    match app.dialog().file().set_title("选择 VST3 插件").add_filter("VST3", &["vst3", "dll"]).blocking_pick_file().and_then(file_path_string) {
        Some(p) => serde_json::json!({ "ok": true, "file": p }), None => serde_json::json!({ "canceled": true }),
    }
}
#[tauri::command]
fn plugin_pick_audio(app: AppHandle) -> serde_json::Value {
    match app.dialog().file().set_title("选择 VST 渲染输入").add_filter("音频", &["wav", "flac", "mp3", "m4a", "aiff"]).blocking_pick_file().and_then(file_path_string) {
        Some(p) => serde_json::json!({ "ok": true, "file": p }), None => serde_json::json!({ "canceled": true }),
    }
}
#[tauri::command]
fn plugin_save_path(app: AppHandle, name: Option<String>) -> serde_json::Value {
    let n = name.unwrap_or_else(|| "vst3-render.wav".to_string());
    match app.dialog().file().set_title("VST 渲染输出").set_file_name(n).add_filter("WAV", &["wav"]).blocking_save_file().and_then(|p| p.into_path().ok()) {
        Some(p) => serde_json::json!({ "ok": true, "file": p.display().to_string() }), None => serde_json::json!({ "canceled": true }),
    }
}
fn plugin_host_python() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("FUFUMIDI_PLUGIN_PYTHON") { if Path::new(&p).is_file() { return Some(PathBuf::from(p)); } }
    let s = read_json(&settings_path());
    if let Some(p) = s.get("plugin.host_python").and_then(|v| v.as_str()).filter(|p| !p.trim().is_empty()) {
        if Path::new(p).is_file() { return Some(PathBuf::from(p)); }
    }
    let p = PathBuf::from("E:/Midi/_attic/envs/plugin-uv/Scripts/python.exe");
    p.is_file().then_some(p)
}

#[tauri::command]
async fn plugin_render_file(req: serde_json::Value) -> Result<serde_json::Value, String> {
    let plugin = req.get("plugin").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let input = req.get("input").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let output = req.get("output").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if plugin.is_empty() || input.is_empty() || output.is_empty() { return Err("缺少插件/输入/输出路径".into()); }
    if !Path::new(&input).is_file() { return Err("输入音频不存在".into()); }
    let py = plugin_host_python().ok_or("插件宿主不可用（需配置 plugin.host_python）")?;
    let script = engine_dir().ok_or("engine directory not found")?.join("plugin_render.py");
    if !script.is_file() { return Err("engine/plugin_render.py 不存在".into()); }
    let mut args = vec![script.display().to_string(), "fx".into(), "--plugin".into(), plugin, "--in".into(), input, "--out".into(), output];
    if let Some(params) = req.get("params").filter(|v| v.is_object()) { args.extend(["--params".into(), params.to_string()]); }
    if let Some(sr) = req.get("sampleRate").and_then(|v| v.as_u64()) { args.extend(["--sample-rate".into(), sr.to_string()]); }
    tauri::async_runtime::spawn_blocking(move || {
        let out = Command::new(&py).args(&args).creation_flags(0x08000000).output().map_err(|e| e.to_string())?;
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let last = stdout.lines().rev().find_map(|l| serde_json::from_str::<serde_json::Value>(l.trim()).ok());
        match last {
            Some(v) => Ok(v),
            None => Ok(serde_json::json!({ "ok": false, "error": "插件宿主没有返回 JSON", "log": format!("{}{}", stderr, stdout).chars().take(1500).collect::<String>() })),
        }
    }).await.map_err(|e| e.to_string())?
}

fn model_download_urls(id: &str) -> Option<(&'static str, &'static str, u64)> {
    Some(match id {
        "piano_transcription" => ("https://zenodo.org/record/4034264/files/CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth?download=1", "piano_transcription/note_F1=0.9677_pedal_F1=0.9186.pth", 160_000_000),
        "beat_this" => ("https://raw.githubusercontent.com/monologue82/Models/main/beat_this/beat_this-final0.ckpt", "hub/checkpoints/beat_this-final0.ckpt", 70_000_000),
        "hnsep_240512" => ("https://cnb.cool/FuFuCloud-mirror/Models/-/releases/download/hnsep-v1/hnsep_240512.oudep", "hnsep/hnsep_240512.oudep", 50_000_000),
        _ => return None,
    })
}

#[tauri::command]
async fn model_download(req: serde_json::Value) -> serde_json::Value {
    let id = req.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if let Some(item) = model_list().into_iter().find(|m| m.get("id").and_then(|v| v.as_str()) == Some(id.as_str())) {
        if item.get("exists").and_then(|v| v.as_bool()) == Some(true) {
            return serde_json::json!({ "ok": true, "id": id, "existed": true, "path": item.get("path"), "size": item.get("size") });
        }
    }
    let Some((url, rel, min)) = model_download_urls(&id) else {
        return serde_json::json!({ "ok": false, "id": id, "error": "该模型没有直链下载定义；请用资源中心手动放置到 data-root/models" });
    };
    let root = data_dir();
    tauri::async_runtime::spawn_blocking(move || {
        let dest = root.join("models").join(rel);
        if let Some(parent) = dest.parent() { if let Err(e) = std::fs::create_dir_all(parent) { return oto_err(&e.to_string()); } }
        let part = dest.with_extension("part");
        let out = match Command::new("curl.exe").args(["-L", "--fail", "--retry", "2", "-C", "-", "-o", &part.display().to_string(), url]).creation_flags(0x08000000).output() {
            Ok(o) => o, Err(e) => return oto_err(&e.to_string()),
        };
        if !out.status.success() { return serde_json::json!({ "ok": false, "id": id, "error": format!("下载失败：{}", String::from_utf8_lossy(&out.stderr).chars().take(400).collect::<String>()) }); }
        let size = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if size < min { return serde_json::json!({ "ok": false, "id": id, "error": format!("下载不完整：{size} < {min}") }); }
        if let Err(e) = std::fs::rename(&part, &dest) { return oto_err(&e.to_string()); }
        serde_json::json!({ "ok": true, "id": id, "path": dest.display().to_string(), "size": size })
    }).await.map_err(|e| e.to_string()).unwrap_or_else(|e| oto_err(&e))
}

#[tauri::command]
fn model_cancel(_id: Option<String>) -> serde_json::Value { serde_json::json!({ "ok": false, "error": "直链下载在独立线程执行，当前不支持中途取消" }) }
#[tauri::command]
fn model_pause(_id: Option<String>) -> serde_json::Value { serde_json::json!({ "ok": false, "error": "直链下载不支持暂停；重新下载会从 .part 断点续传" }) }

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
fn renderer_ready() -> serde_json::Value {
    let ms = PROCESS_START.get().map(|s| s.elapsed().as_millis()).unwrap_or(0);
    tauri_log(&format!("renderer-ready elapsedMs={ms}"));
    serde_json::json!({ "ok": true, "elapsedMs": ms })
}

#[tauri::command]
fn load_settings() -> serde_json::Value {
    read_json(&settings_path())
}

#[tauri::command]
fn save_settings(s: serde_json::Value) -> serde_json::Value {
    // 前端有时只提交部分键（theme/ui_mode 等）；直接整文件覆盖会把
    // data_root_last、音色库等持久键清掉。这里按顶层合并，保留未提交的键。
    let path = settings_path();
    let mut merged = read_json(&path);
    let Some(incoming) = s.as_object() else { return serde_json::json!({ "ok": false, "error": "settings must be an object" }); };
    if let Some(dst) = merged.as_object_mut() {
        for (k, v) in incoming { dst.insert(k.clone(), v.clone()); }
    } else {
        merged = s;
    }
    match write_json(&path, &merged) {
        Ok(_) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

// ── 更新线路（本地：只读设置，不联网、不下载、不检查版本）────────────────────
// 语义对齐 Electron：
//   · main/update.js 的 orderedUpdateSources —— stable/beta 只改 id 后缀（-beta）；
//     国内优先（auto/cnb）时 CNB 打头、GitHub 官方压尾；全球优先（github）时
//     GitHub 官方打头、CNB 兜底。
//   · main/update-speedtest.js 的 orderCandidates —— preferred 只把该条提到最前，
//     其余保持原顺序（不可达时照旧沿回退链往下走，不能改成硬绑定）。
// 源 id 必须与 build/kachina.config.json 的 source[].id 一一对应（单测校验）。
struct UpdateMirror {
    id: &'static str,
    label: &'static str,
    kind: &'static str,
}

const UPDATE_MIRRORS: [UpdateMirror; 4] = [
    UpdateMirror { id: "ghfast", label: "ghfast.top", kind: "mirror" },
    UpdateMirror { id: "ghproxy", label: "gh-proxy.com", kind: "mirror" },
    UpdateMirror { id: "ghproxy-net", label: "ghproxy.net", kind: "mirror" },
    UpdateMirror { id: "github", label: "GitHub 官方", kind: "github" },
];

/// 用户选定的首选线路：只存本次会话（不落盘）。None / 空串 = 没有会话内覆盖。
struct UpdatePreferredState(Mutex<Option<String>>);

fn norm_update_channel(v: Option<&str>) -> &'static str {
    match v {
        Some(s) if s.eq_ignore_ascii_case("beta") => "beta",
        _ => "stable",
    }
}

fn update_source_id(id: &str, channel: &str) -> String {
    if channel == "beta" { format!("{id}-beta") } else { id.to_string() }
}

/// 与 main/download-source.js 的 preferCnb/normSource 一致：
/// auto / cnb（含未知值 → 归一为 auto）走国内优先；只有 github 是全球优先。
fn update_prefer_cnb(download_source: Option<&str>) -> bool {
    !matches!(download_source.map(|s| s.to_ascii_lowercase()).as_deref(), Some("github"))
}

/// 与 main/update-speedtest.js 的 orderCandidates 一致：只把 preferred 移到最前。
fn order_update_candidates(list: Vec<serde_json::Value>, preferred: Option<&str>) -> Vec<serde_json::Value> {
    let Some(pref) = preferred.filter(|p| !p.is_empty()) else { return list };
    let Some(i) = list.iter().position(|s| s.get("id").and_then(|v| v.as_str()) == Some(pref)) else { return list };
    if i == 0 { return list; }
    let mut out = Vec::with_capacity(list.len());
    out.push(list[i].clone());
    out.extend(list[..i].iter().cloned());
    out.extend(list[i + 1..].iter().cloned());
    out
}

/// 纯函数：给定通道 / 下载源偏好 / 首选线路，返回按优先级排好的线路列表。
/// 不读设置、不联网 —— 命令层负责把设置里的值读出来再传进来。
fn update_sources_at(
    channel: Option<&str>,
    download_source: Option<&str>,
    preferred: Option<&str>,
) -> Vec<serde_json::Value> {
    let ch = norm_update_channel(channel);
    let cnb = serde_json::json!({
        "id": update_source_id("cnb", ch),
        "label": "CNB 国内源",
        "kind": "cnb",
        "channel": ch,
    });
    let gh: Vec<serde_json::Value> = UPDATE_MIRRORS
        .iter()
        .map(|m| serde_json::json!({
            "id": update_source_id(m.id, ch),
            "label": m.label,
            "kind": m.kind,
            "channel": ch,
        }))
        .collect();
    let github_i = gh.len() - 1; // UPDATE_MIRRORS 末位是官方直连
    let mut ordered = Vec::with_capacity(gh.len() + 1);
    if update_prefer_cnb(download_source) {
        ordered.push(cnb);
        ordered.extend(gh);
    } else {
        ordered.push(gh[github_i].clone());
        ordered.extend(gh[..github_i].iter().cloned());
        ordered.push(cnb);
    }
    order_update_candidates(ordered, preferred)
}

#[tauri::command]
fn update_sources(state: State<'_, UpdatePreferredState>, channel: Option<String>) -> Vec<serde_json::Value> {
    // 设置只读（前端自己持久化 update_preferred_source）；会话内选择覆盖持久值。
    let settings = read_json(&settings_path());
    let download_source = settings.get("download_source").and_then(|v| v.as_str());
    let persisted = settings.get("update_preferred_source").and_then(|v| v.as_str()).unwrap_or("");
    let session = state.0.lock().ok().and_then(|g| (*g).clone()).unwrap_or_default();
    let preferred = if session.is_empty() { persisted.to_string() } else { session };
    update_sources_at(channel.as_deref(), download_source, Some(preferred.as_str()))
}

/// 用户选定的线路只提到最前（不是锁定）；这里只存会话内存，绝不写 settings。
#[tauri::command]
fn update_set_preferred_source(state: State<'_, UpdatePreferredState>, id: Option<String>) -> String {
    let v = id.unwrap_or_default();
    if let Ok(mut g) = state.0.lock() {
        *g = if v.is_empty() { None } else { Some(v.clone()) };
    }
    v
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
    let mut cmd = Command::new(&py); cmd.current_dir(&eng).args(["deps.py", "check"]); apply_engine_env(&mut cmd);
    let out = match cmd.output() {
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
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
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
    if let Some(rvc_id) = id.strip_prefix("rvc:") { return rvc_remove_at(&root.join("rvc"), rvc_id); }
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
    base = base.trim_end_matches(['.', ' ']).to_string();
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
    let mut target = if !prev.is_empty() { PathBuf::from(prev) } else { same.clone() };
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

fn parse_um_json(stdout: &str) -> Option<serde_json::Value> {
    let t = stdout.trim();
    let candidate = t.rsplit_once('\n').map(|(_, last)| last.trim()).unwrap_or(t);
    serde_json::from_str::<serde_json::Value>(candidate).ok().or_else(|| {
        let start = t.find('{')?;
        serde_json::from_str::<serde_json::Value>(&t[start..]).ok()
    })
}

#[tauri::command]
async fn gpu_unified_memory_experiment() -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(move || {
        let (Some(py), Some(engine)) = (python_path(), engine_dir()) else { return oto_err("Python/引擎目录不存在") };
        let script = engine.join("cuda_um_experiment.py");
        if !script.is_file() { return oto_err("cuda_um_experiment.py 不存在"); }
        let mut cmd = Command::new(&py); cmd.current_dir(&engine).arg(&script).args(["--mb", "256", "--json"]).creation_flags(0x08000000); apply_engine_env(&mut cmd);
        let out = match cmd.output() {
            Ok(o) => o, Err(e) => return oto_err(&e.to_string()),
        };
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        match parse_um_json(&stdout) {
            Some(v) => v,
            None => serde_json::json!({ "ok": false, "error": "实验脚本没有返回 JSON", "raw": format!("{}{}", stdout.chars().rev().take(400).collect::<String>().chars().rev().collect::<String>(), stderr.chars().rev().take(200).collect::<String>().chars().rev().collect::<String>()) }),
        }
    }).await.unwrap_or_else(|e| oto_err(&e.to_string()))
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
    let secs = ts % 86400;
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
    base = base.trim_end_matches(['.', ' ']).to_string();
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
fn ogg_pages(b: &[u8]) -> Vec<(u64, usize, usize)> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 27 <= b.len() {
        if &b[i..i+4] != b"OggS" { i += 1; continue; }
        let granule = u64::from_le_bytes([b[i+6],b[i+7],b[i+8],b[i+9],b[i+10],b[i+11],b[i+12],b[i+13]]);
        let nseg = b[i+26] as usize;
        let table = i + 27;
        if table + nseg > b.len() { break; }
        let payload: usize = b[table..table+nseg].iter().map(|x| *x as usize).sum();
        let body = table + nseg;
        if body + payload > b.len() { break; }
        out.push((granule, body, payload));
        i = body + payload;
    }
    out
}

fn ogg_duration(b: &[u8]) -> Option<f64> {
    let pages = ogg_pages(b);
    let last = pages.iter().rev().find(|(g, _, _)| *g != u64::MAX).map(|(g, _, _)| *g)?;
    if let Some(p) = b.windows(7).position(|w| w == b"OpusHead") {
        if p + 12 <= b.len() {
            let preskip = u16::from_le_bytes([b[p+10], b[p+11]]) as u64;
            return Some(last.saturating_sub(preskip) as f64 / 48000.0);
        }
        return Some(last as f64 / 48000.0);
    }
    if let Some(p) = b.windows(7).position(|w| w == b"\x01vorbis") {
        if p + 16 <= b.len() {
            let rate = u32::from_le_bytes([b[p+12],b[p+13],b[p+14],b[p+15]]);
            if rate > 0 { return Some(last as f64 / rate as f64); }
        }
    }
    None
}
fn aiff_extended_rate(b: &[u8]) -> f64 {
    if b.len() < 10 { return 0.0; }
    let exp = (((b[0] & 0x7f) as i32) << 8) | b[1] as i32;
    let mant = u64::from_be_bytes([b[2],b[3],b[4],b[5],b[6],b[7],b[8],b[9]]);
    if exp == 0 && mant == 0 { return 0.0; }
    let frac = mant as f64 / 9223372036854775808.0;
    frac * 2f64.powi(exp - 16383)
}

fn aiff_duration(b: &[u8]) -> Option<f64> {
    if b.len() < 12 || &b[0..4] != b"FORM" || !(&b[8..12] == b"AIFF" || &b[8..12] == b"AIFC") { return None; }
    let mut i = 12usize;
    while i + 8 <= b.len() {
        let id = &b[i..i+4];
        let size = u32::from_be_bytes([b[i+4],b[i+5],b[i+6],b[i+7]]) as usize;
        let body = i + 8;
        if id == b"COMM" && size >= 18 && body + 18 <= b.len() {
            let frames = u32::from_be_bytes([b[body+2],b[body+3],b[body+4],b[body+5]]) as f64;
            let rate = aiff_extended_rate(&b[body+8..body+18]);
            if rate > 0.0 { return Some(frames / rate); }
        }
        i = body.saturating_add(size).saturating_add(size % 2);
    }
    None
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
        "ogg" | "oga" | "opus" => ogg_duration(&head),
        "aiff" | "aif" | "aifc" => aiff_duration(&head),
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
    rows.sort_by_key(|a| std::cmp::Reverse(a.0));
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
    s = s.trim_end_matches(['.', ' ']).trim().to_string();
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
async fn db_songs_list() -> Vec<serde_json::Value> {
    // 65MB 曲库的 JSON 反序列化不能占住 IPC/主线程；放到阻塞线程池。
    tauri::async_runtime::spawn_blocking(db_songs_list_blocking).await.unwrap_or_default()
}

fn db_songs_list_blocking() -> Vec<serde_json::Value> {
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

/// P1/P2：生产路径不再自己持有 Option<Worker>，改用 worker_pool::WorkerPool。
/// P2 起 pool 的 cap 由每次请求的 `__slots`（GPU/MAX_WORKERS 修正后）动态设置；
/// seq 仍是跨 job 单调递增的诊断请求号（结果/事件的 id 走前端 `cfg.id`，P3）。
struct WorkerState {
    pool: Arc<worker_pool::WorkerPool>,
    seq: Arc<AtomicU64>,
    /// 前端 job id（`cfg.id`，如 `batch7`）→ 池内 [worker_pool::JobId]。
    /// cap>1 时取消必须按它精确命中，不能靠“唯一在途”猜。
    jobs: JobMap,
    tasks: Arc<Mutex<Vec<serde_json::Value>>>,
}

/// 前端 job id → 池内 JobId 的共享表（key 已 trim；值由池单调分配）。
type JobMap = Arc<Mutex<HashMap<String, worker_pool::JobId>>>;

/// run_convert 的 job 登记凭据：登记后任何 return / panic 展开都由 Drop 清理映射。
/// 同一前端 id 被并发的后一个请求复用时，只删属于自己 JobId 的那条，不误删后来者。
struct JobRegistration {
    jobs: JobMap,
    key: String,
    pool_id: worker_pool::JobId,
}

impl JobRegistration {
    fn register(jobs: JobMap, key: String, pool_id: worker_pool::JobId) -> Self {
        jobs.lock()
            .unwrap_or_else(|err| err.into_inner())
            .insert(key.clone(), pool_id);
        Self { jobs, key, pool_id }
    }
}

impl Drop for JobRegistration {
    fn drop(&mut self) {
        let mut jobs = self.jobs.lock().unwrap_or_else(|err| err.into_inner());
        if jobs.get(&self.key) == Some(&self.pool_id) {
            jobs.remove(&self.key);
        }
    }
}
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

/// 启动一个真实 Python worker 子进程（stdin JSON / stdout ### 协议）。
/// P1：stdin/stdout 管道、stderr=null、Windows CREATE_NO_WINDOW 由 ChildWorker::spawn 统一设置；
/// 旧的 Worker{child,stdin,reader} 由池的暖 worker 复用取代。
/// 引擎子进程的统一环境：数据根/模型/缓存 + 已安装的 GPU 增强包 site-packages。
///
/// 发布版 python/ 故意不带 torch/demucs（体积），必须把数据根下的
/// gpu-enhancements/<kind>/site-packages 挂到 PYTHONPATH；没有增强包时显式
/// FUFUMIDI_DISABLE_GPU=1，避免继承宿主环境里的旧 torch 造成 ABI/版本错配。
fn apply_engine_env(cmd: &mut Command) {
    cmd.env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .env("FUFUMIDI_DATA_DIR", data_dir())
        .env("FUFUMIDI_MODELS_DIR", models_dir())
        .env("TORCH_HOME", models_dir())
        .env("FUFUMIDI_PAUSE_FILE", pause_file());
    if let Some(b) = bundled_models_dir() { cmd.env("FUFUMIDI_MODELS_BUNDLED_DIR", b); }
    cmd.env_remove("PYTHONPATH");
    let mut sites = Vec::new();
    let mut kinds = Vec::new();
    if let Ok(rd) = std::fs::read_dir(data_dir().join("gpu-enhancements")) {
        for e in rd.flatten() {
            let kind = e.file_name().to_string_lossy().to_string();
            let site = e.path().join("site-packages");
            if site.join("torch").is_dir() { sites.push(site); kinds.push(kind); }
        }
    }
    if sites.is_empty() {
        cmd.env("FUFUMIDI_DISABLE_GPU", "1");
    } else {
        let joined = std::env::join_paths(&sites).map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        if !joined.is_empty() { cmd.env("PYTHONPATH", joined); }
        cmd.env("FUFUMIDI_GPU_KINDS", kinds.join(","));
    }
}

fn spawn_worker() -> Result<Box<dyn worker_pool::WorkerProc>, String> {
    let py = python_path().ok_or("python runtime not found")?;
    let eng = engine_dir().ok_or("engine/music2midi.py not found")?;
    let mut cmd = Command::new(&py);
    cmd.current_dir(&eng).args(["music2midi.py", "worker"]);
    apply_engine_env(&mut cmd);
    worker_pool::ChildWorker::spawn(cmd)
        .map(|worker| Box::new(worker) as Box<dyn worker_pool::WorkerProc>)
        .map_err(|e| e.to_string())
}

fn canceled_convert() -> serde_json::Value {
    serde_json::json!({ "ok": false, "canceled": true, "error": "canceled" })
}

/// 请求号规则（保持旧实现行为）：每个新 spawn 的 worker 从 1 开始，暖 worker 接着自增。
fn next_worker_seq(reused: bool, seq: &AtomicU64) -> u64 {
    if !reused {
        seq.store(0, Ordering::SeqCst);
    }
    seq.fetch_add(1, Ordering::SeqCst) + 1
}

/// 只取 PoolError::Io 里的原始 io 文本，保持旧错误串形态（worker write failed: ...）。
fn pool_io_text(err: worker_pool::PoolError) -> String {
    match err {
        worker_pool::PoolError::Io(text) => text,
        other => other.to_string(),
    }
}

/// 按一次请求 + 宿主环境计算并发上限（纯函数；env 由调用方注入，便于单测）。
///
/// 规则（与 Electron `engineWorkerConvert` 对齐）：
/// 1. `__slots` clamp 1..=4，缺省/非法为 1；
/// 2. `FUFUMIDI_DISABLE_GPU != "1"` 视为 GPU 环境：cap = max(1, slots - 1)；
/// 3. `FUFUMIDI_MAX_WORKERS` 可继续压低（只降不升，自身 clamp 1..=4）。
fn effective_cap(req: &serde_json::Value, env: impl Fn(&str) -> Option<String>) -> usize {
    let slots = match req.get("__slots") {
        Some(serde_json::Value::Number(n)) => n
            .as_u64()
            .map(|v| v as usize)
            .or_else(|| n.as_f64().filter(|f| f.is_finite()).map(|f| f.trunc().max(0.0) as usize)),
        Some(serde_json::Value::String(s)) => s.trim().parse::<usize>().ok(),
        _ => None,
    }
    .unwrap_or(1)
    .clamp(worker_pool::MIN_CAP, worker_pool::MAX_CAP);

    let mut cap = slots;
    if env("FUFUMIDI_DISABLE_GPU").as_deref() != Some("1") {
        cap = cap.saturating_sub(1).max(worker_pool::MIN_CAP);
    }
    if let Some(max) = env("FUFUMIDI_MAX_WORKERS").and_then(|raw| raw.trim().parse::<usize>().ok()) {
        cap = cap.min(max.clamp(worker_pool::MIN_CAP, worker_pool::MAX_CAP));
    }
    cap
}

/// 前端 job id：优先 `cfg.id`（P3 起事件/结果都用它），缺省退回 `job-<seq>`。
fn job_event_id(req: &serde_json::Value, seq: u64) -> String {
    req.get("id").and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty()).map(|s| s.to_string()).unwrap_or_else(|| format!("job-{seq}"))
}

fn result_id_matches(v: &serde_json::Value, job_id: &str) -> bool {
    match v.get("_id") {
        Some(serde_json::Value::String(s)) => s == job_id,
        Some(serde_json::Value::Number(n)) => n.as_u64().map(|x| x.to_string() == job_id).unwrap_or(false),
        _ => false,
    }
}

/// 把一次转录请求交给池里的 worker（P2：按请求调 cap；跨请求复用暖 worker）。
/// 模型/参数契约与 Electron 路径一致（req 原样转发）；
/// 进度/日志仍通过 Tauri 事件 engine:log / engine:progress 推给前端。
struct ConvertTask {
    tasks: Arc<Mutex<Vec<serde_json::Value>>>,
    app: AppHandle,
    id: String,
}

impl ConvertTask {
    fn start(tasks: Arc<Mutex<Vec<serde_json::Value>>>, app: AppHandle, id: String, title: String) -> Self {
        if let Ok(mut list) = tasks.lock() {
            list.retain(|t| t.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
            list.push(serde_json::json!({ "id": id, "kind": "transcribe", "title": title, "status": "running", "startedAt": unix_now_ms() }));
            let _ = app.emit("tasks:update", serde_json::json!({ "tasks": list.clone() }));
        }
        Self { tasks, app, id }
    }
}

impl Drop for ConvertTask {
    fn drop(&mut self) {
        if let Ok(mut list) = self.tasks.lock() {
            if let Some(t) = list.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(self.id.as_str())) {
                t["status"] = serde_json::json!("done");
                t["finishedAt"] = serde_json::json!(unix_now_ms());
            }
            let _ = self.app.emit("tasks:update", serde_json::json!({ "tasks": list.clone() }));
        }
    }
}

fn unix_now_ms() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) }

#[tauri::command]
fn tasks_list(state: State<'_, WorkerState>) -> Vec<serde_json::Value> {
    state.tasks.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
fn tasks_cancel(state: State<'_, WorkerState>, app: AppHandle, id: String) -> serde_json::Value {
    let status = state.pool.status();
    let target = {
        let jobs = state.jobs.lock().unwrap_or_else(|e| e.into_inner());
        cancel_target(Some(&id), status.cap, &status.workers, &jobs)
    };
    let canceled = target.map(|job| state.pool.cancel(job)).unwrap_or(false);
    let mut list = state.tasks.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(t) = list.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(id.as_str())) {
        if canceled { t["status"] = serde_json::json!("cancelled"); t["finishedAt"] = serde_json::json!(unix_now_ms()); }
    }
    let snapshot = list.clone();
    drop(list);
    let _ = app.emit("tasks:update", serde_json::json!({ "tasks": snapshot }));
    serde_json::json!({ "ok": canceled, "canceled": canceled })
}

#[tauri::command]
fn tasks_clear_finished(state: State<'_, WorkerState>) -> serde_json::Value {
    let mut list = state.tasks.lock().unwrap_or_else(|e| e.into_inner());
    list.retain(|t| t.get("status").and_then(|v| v.as_str()) == Some("running"));
    serde_json::json!({ "ok": true, "tasks": list.clone() })
}

fn run_convert(
    pool: Arc<worker_pool::WorkerPool>,
    seq: Arc<AtomicU64>,
    jobs: JobMap,
    tasks: Arc<Mutex<Vec<serde_json::Value>>>,
    app: AppHandle,
    req: serde_json::Value,
) -> serde_json::Value {
    let started = std::time::Instant::now();
    if req.get("stemEnhance").and_then(|v| v.as_bool()) == Some(true) {
        if let Some(r) = stem_workflow::run(&req, Some(&app)) { return r; }
        let _ = app.emit("engine:log", serde_json::json!({ "id": req.get("id").cloned().unwrap_or(serde_json::json!("stem")), "line": "[分轨] 分轨失败，回退整曲转录" }));
    }
    // P2：先按本次请求的 __slots/GPU/MAX_WORKERS 调池上限；只影响排队与暖池，不杀在途 job。
    pool.set_cap(effective_cap(&req, |key| std::env::var(key).ok()));
    let lease = match pool.acquire(|_id, _cancel| spawn_worker()) {
        Ok(lease) => lease,
        Err(worker_pool::PoolError::Shutdown) => {
            return serde_json::json!({ "ok": false, "error": "engine worker pool is shut down" });
        }
        // cancel 恰好落在 spawn 窗口：池已回收迟到 worker，这里按取消返回。
        Err(worker_pool::PoolError::Canceled) => return canceled_convert(),
        // 旧实现直接返回 spawn 错误串；这里拆掉 PoolError 的外层前缀保持一致。
        Err(worker_pool::PoolError::Spawn(err)) => {
            return serde_json::json!({ "ok": false, "error": err });
        }
        Err(err) => return serde_json::json!({ "ok": false, "error": err.to_string() }),
    };
    // 暖 worker 若在两次请求之间退出：与旧实现一致——本次请求报错，下一次请求重新拉起。
    if let Ok(Some(_)) = lease.try_wait() {
        return serde_json::json!({ "ok": false, "error": "engine worker exited; retry restarts it" });
    }
    if lease.is_canceled() {
        return canceled_convert();
    }
    let seq_id = next_worker_seq(lease.reused(), &seq);
    let job_id = job_event_id(&req, seq_id);
    // P2 精确取消：acquire 之后登记前端 job id → 池内 JobId。
    // 之后所有返回路径（含提前 return / panic）都由 _registration 的 Drop 清理。
    let _registration = JobRegistration::register(Arc::clone(&jobs), job_id.clone(), lease.id());
    let title = req.get("audio").and_then(|v| v.as_str()).and_then(|p| Path::new(p).file_name()).and_then(|x| x.to_str()).unwrap_or("transcribe").to_string();
    let _task = ConvertTask::start(Arc::clone(&tasks), app.clone(), job_id.clone(), title);
    let mut payload = req;
    if let Some(o) = payload.as_object_mut() {
        o.insert("_id".to_string(), serde_json::json!(job_id));
    }
    if let Err(err) = lease.send(&payload.to_string()) {
        lease.mark_broken();
        if lease.is_canceled() {
            return canceled_convert();
        }
        return serde_json::json!({ "ok": false, "error": format!("worker write failed: {}", pool_io_text(err)) });
    }
    let mut logs: Vec<String> = Vec::new();
    // P3 节流：###PROG 每 50ms 最多发一次；最终结果仍由 ###RESULT 驱动。
    let mut last_progress = Instant::now() - Duration::from_secs(1);
    loop {
        let line = match lease.read_line() {
            Ok(Some(line)) => line,
            Ok(None) => {
                lease.mark_broken();
                if lease.is_canceled() {
                    return canceled_convert();
                }
                return serde_json::json!({ "ok": false, "error": "engine worker closed" });
            }
            Err(worker_pool::PoolError::WorkerGone) => {
                if lease.is_canceled() {
                    return canceled_convert();
                }
                return serde_json::json!({ "ok": false, "error": "engine worker closed" });
            }
            Err(err) => {
                lease.mark_broken();
                if lease.is_canceled() {
                    return canceled_convert();
                }
                return serde_json::json!({ "ok": false, "error": format!("worker read failed: {}", pool_io_text(err)) });
            }
        };
        let t = line.trim();
        if t.is_empty() { continue; }
        if lease.is_canceled() {
            return canceled_convert();
        }
        if let Some(rest) = t.strip_prefix("###RESULT ") {
            if let Ok(mut r) = serde_json::from_str::<serde_json::Value>(rest) {
                if result_id_matches(&r, &job_id) {
                    if let Some(o) = r.as_object_mut() {
                        o.insert("_id".to_string(), serde_json::json!(job_id));
                        o.insert("elapsedMs".to_string(), serde_json::json!(started.elapsed().as_millis() as u64));
                        o.insert("workerSeq".to_string(), serde_json::json!(seq_id));
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
                let _ = app.emit("engine:log", serde_json::json!({ "id": job_id, "line": s }));
            }
            continue;
        }
        if let Some(rest) = t.strip_prefix("###PROG ") {
            if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(rest) {
                if let Some(o) = v.as_object_mut() { o.insert("id".to_string(), serde_json::json!(job_id)); }
                let now = Instant::now();
                if now.duration_since(last_progress) >= Duration::from_millis(50) {
                    last_progress = now;
                    let _ = app.emit("engine:progress", v);
                }
            }
            continue;
        }
        if logs.len() < 200 { logs.push(t.to_string()); }
    }
}

#[tauri::command]
async fn convert(state: State<'_, WorkerState>, app: AppHandle, req: serde_json::Value) -> Result<serde_json::Value, String> {
    let pool = state.pool.clone();
    let seq = state.seq.clone();
    let jobs = state.jobs.clone();
    let tasks = state.tasks.clone();
    tauri::async_runtime::spawn_blocking(move || run_convert(pool, seq, jobs, tasks, app, req))
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

/// 取消转录（P2：按前端 job id 精确映射到池内 JobId）。
///
/// 优先级：
/// 1. `id` 在 [JobMap] 中命中 → 只取消该 job（cap>1 时不会误杀别的在途转换）；
/// 2. 数字 id 命中池内 job → 取消该 job（兼容旧调用/诊断）；
/// 3. 只有 **cap == 1 且唯一在途** 时才回退取消它 —— 兼容 smoke 的 `smoke-cancel`
///    和旧前端“忽略 id、砍当前 worker”的行为；
/// 4. 其余返回 no running worker：**cap>1 的未知 id 不猜、不误杀**。
#[tauri::command]
fn cancel(state: State<'_, WorkerState>, separation: State<'_, SeparationState>, id: Option<String>) -> serde_json::Value {
    if let Some(raw) = id.as_deref().filter(|x| x.starts_with("sep")) {
        let mut g = separation.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut job) = g.take() {
            SEPARATE_CANCELED.store(true, Ordering::SeqCst);
            let _ = job.child.kill();
            return serde_json::json!({ "ok": true, "canceled": true, "id": raw });
        }
    }
    let status = state.pool.status();
    let target = {
        let jobs = state.jobs.lock().unwrap_or_else(|err| err.into_inner());
        cancel_target(id.as_deref(), status.cap, &status.workers, &jobs)
    };
    let Some(job_id) = target else {
        return serde_json::json!({ "ok": false, "canceled": false, "error": "no running worker", "id": id });
    };
    let pid = status.workers.iter().find(|worker| worker.id == job_id).and_then(|worker| worker.pid);
    if state.pool.cancel(job_id) {
        serde_json::json!({ "ok": true, "canceled": true, "pid": pid, "id": id })
    } else {
        serde_json::json!({ "ok": false, "canceled": false, "error": "no running worker", "id": id })
    }
}

/// cancel(id) 的目标选择（纯函数，单测覆盖，不启动真实 worker）。
///
/// 映射优先、数字 id 次之、**仅 cap=1** 才允许“唯一在途”回退；cap>1 的未知 id → None。
fn cancel_target(
    id: Option<&str>,
    cap: usize,
    workers: &[worker_pool::WorkerInfo],
    jobs: &HashMap<String, worker_pool::JobId>,
) -> Option<worker_pool::JobId> {
    let key = id.map(str::trim).filter(|raw| !raw.is_empty());
    if let Some(job_id) = key.and_then(|raw| jobs.get(raw)).copied() {
        return Some(job_id);
    }
    if workers.is_empty() {
        return None;
    }
    if let Some(parsed) = key.and_then(|raw| raw.parse::<u64>().ok()) {
        if workers.iter().any(|worker| worker.id == parsed) {
            return Some(parsed);
        }
    }
    if cap == 1 && workers.len() == 1 {
        return Some(workers[0].id);
    }
    None
}

/// 运行时状态：旧字段（ok/running/pid/seq）保持不变，另加 cap 与 workers 明细。
///
/// 只读池的原子元数据 + job 映射，**不抢任何在途 worker 的槽锁**：
/// convert 正阻塞在 read_line 时这里也能立即返回。
fn worker_status_json(
    status: &worker_pool::PoolStatus,
    seq: u64,
    jobs: &HashMap<String, worker_pool::JobId>,
) -> serde_json::Value {
    // 反向表：池内 JobId → 前端 job id（同一前端 id 并发复用时后登记者获胜）。
    let mut by_pool: HashMap<worker_pool::JobId, &str> = HashMap::new();
    for (front_id, pool_id) in jobs {
        by_pool.insert(*pool_id, front_id.as_str());
    }
    let mut running: Vec<&worker_pool::WorkerInfo> = status.workers.iter().collect();
    running.sort_by_key(|worker| worker.id);

    let mut workers: Vec<serde_json::Value> = Vec::with_capacity(running.len() + status.warm_pids.len());
    for worker in &running {
        let slot = workers.len();
        workers.push(serde_json::json!({
            "slot": slot,
            "pid": worker.pid,
            "jobId": by_pool.get(&worker.id).copied(),
            "busy": true,
        }));
    }
    // 空闲暖 worker 也列出来（busy=false，jobId=null），否则 running=true 时 workers 会是空的。
    for pid in &status.warm_pids {
        let slot = workers.len();
        workers.push(serde_json::json!({
            "slot": slot,
            "pid": pid,
            "jobId": serde_json::Value::Null,
            "busy": false,
        }));
    }

    let running_now = !running.is_empty() || status.warm_alive;
    if !running_now {
        return serde_json::json!({ "ok": true, "running": false, "seq": 0, "cap": status.cap, "workers": workers });
    }
    let pid = running.iter().find_map(|worker| worker.pid).or(status.warm_pid);
    serde_json::json!({ "ok": true, "running": true, "pid": pid, "seq": seq, "cap": status.cap, "workers": workers })
}

#[tauri::command]
fn engine_worker_status(state: State<'_, WorkerState>) -> serde_json::Value {
    let status = state.pool.status();
    let seq = state.seq.load(Ordering::SeqCst);
    let jobs = state.jobs.lock().unwrap_or_else(|err| err.into_inner());
    worker_status_json(&status, seq, &jobs)
}


/// 无窗口验收：真实拉起生产 `spawn_worker`，发一个缺文件请求，读到 ###RESULT 后关闭池。
/// 不加载模型、不创建 Tauri/WebView 窗口；用于安装版/构建产物自检。
fn engine_self_check() -> serde_json::Value {
    let pool = match worker_pool::WorkerPool::with_reuse(1) { Ok(p) => p, Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }) };
    let lease = match pool.acquire(|_id, _cancel| spawn_worker()) {
        Ok(l) => l,
        Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }),
    };
    let req = serde_json::json!({ "audio": "__fufumidi_selfcheck_missing__.wav", "out": "__fufumidi_selfcheck_missing__.mid", "_id": "selfcheck" });
    if let Err(e) = lease.send(&req.to_string()) {
        return serde_json::json!({ "ok": false, "error": format!("write: {e}") });
    }
    let mut result = None;
    for _ in 0..200 {
        match lease.read_line() {
            Ok(Some(line)) => {
                if let Some(rest) = line.trim().strip_prefix("###RESULT ") {
                    result = serde_json::from_str::<serde_json::Value>(rest).ok();
                    break;
                }
            }
            Ok(None) => break,
            Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }),
        }
    }
    let pid = lease.pid();
    drop(lease);
    let status = pool.status();
    pool.shutdown();
    match result {
        Some(r) => serde_json::json!({ "ok": r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) || r.get("error").is_some(), "pid": pid, "warm": status.warm, "result": r }),
        None => serde_json::json!({ "ok": false, "pid": pid, "error": "engine worker did not return ###RESULT" }),
    }
}
static PROCESS_START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// 无窗口排障日志：Tauri 启动/退出/panic 追加到数据根 logs/tauri-start.log。
fn tauri_log(msg: &str) {
    let dir = data_dir().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    use std::io::Write as _;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("tauri-start.log")) {
        let _ = writeln!(f, "[{}] {}", unix_to_iso(ts), msg);
    }
}

fn main() {
    let _ = PROCESS_START.set(std::time::Instant::now());
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("panic: {}", info);
        let dir = data_dir().join("logs");
        let _ = std::fs::create_dir_all(&dir);
        use std::io::Write as _;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("tauri-start.log")) { let _ = writeln!(f, "{msg}"); }
    }));
    tauri_log(&format!("start pid={} exe={} data={} args={:?}", std::process::id(), std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default(), data_dir().display(), std::env::args().collect::<Vec<_>>()));
    if std::env::args().any(|a| a == "--self-check") {
        println!("{}", serde_json::to_string_pretty(&host_info_json()).unwrap_or_default());
        return;
    }
    if std::env::args().any(|a| a == "--engine-self-check") {
        // 只跑 worker 协议，不创建 Tauri Builder/WebView 窗口。
        println!("{}", serde_json::to_string_pretty(&engine_self_check()).unwrap_or_default());
        return;
    }
    if std::env::args().any(|a| a == "--model-check") {
        let items = model_list();
        let sep: Vec<&serde_json::Value> = items.iter().filter(|m| m.get("kind").and_then(|v| v.as_str()) == Some("separate")).collect();
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({ "ok": true, "dataDir": data_dir().display().to_string(), "models": items.len(), "separates": sep })).unwrap_or_default());
        return;
    }
    let argv: Vec<String> = std::env::args().collect();
    if argv.iter().any(|a| a == "--update-check") {
        println!("{}", serde_json::to_string_pretty(&update_check_remote("beta")).unwrap_or_default());
        return;
    }
    if let Some(i) = argv.iter().position(|a| a == "--stem-smoke") {
        let audio = argv.get(i + 1).cloned().unwrap_or_default();
        let out = argv.get(i + 2).cloned().unwrap_or_default();
        if audio.is_empty() || out.is_empty() {
            println!("{}", serde_json::json!({ "ok": false, "error": "usage: --stem-smoke <audio> <out.mid>" }));
            return;
        }
        let req = serde_json::json!({ "id": "stem-smoke", "audio": audio, "out": out, "stemEnhance": true, "mode": "universal", "model": "basic", "perf": "quality", "trackBudget": "auto" });
        println!("{}", serde_json::to_string_pretty(&stem_workflow::run(&req, None).unwrap_or_else(|| serde_json::json!({ "ok": false, "fallback": true }))).unwrap_or_default());
        return;
    }
    let state = WorkerState {
        // P1 的 cap=1 默认保留；每次 convert 再按请求 __slots 调 set_cap（P2）。
        pool: Arc::new(worker_pool::WorkerPool::with_reuse(1).expect("worker pool cap=1")),
        seq: Arc::new(AtomicU64::new(0)),
        jobs: Arc::new(Mutex::new(HashMap::new())),
        tasks: Arc::new(Mutex::new(Vec::new())),
    };
    let open_arg = pending_open_from_args(std::env::args());
    let listener = TcpListener::bind(("127.0.0.1", SINGLE_INSTANCE_PORT)).ok();
    if listener.is_none() {
        // 已有实例：把文件/聚焦请求交给它，本进程不再创建窗口。
        if single_instance_forward(open_arg.as_deref()) { return; }
    }
    let pending_open = PendingOpen(Mutex::new(open_arg));
    let zoom_state = ZoomState(Arc::new(Mutex::new(1.0)));
    let update_preferred_state = UpdatePreferredState(Mutex::new(None));
    let video_export_state = VideoExportState(Arc::new(Mutex::new(HashMap::new())));
    let cover_state = CoverState(Arc::new(Mutex::new(None)));
    let separation_state = SeparationState(Arc::new(Mutex::new(None)));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .manage(pending_open)
        .manage(zoom_state)
        .manage(update_preferred_state)
        .manage(video_export_state)
        .manage(cover_state)
        .manage(separation_state)
        .invoke_handler(tauri::generate_handler![
            host_info, app_version, ping, python_selfcheck, engine_probe,
            model_download, model_cancel, model_pause, plugin_pick_file, plugin_pick_audio, plugin_save_path, plugin_render_file, renderer_ready, update_check, update_list, update_notes, launch_updater, load_settings, save_settings, update_sources, update_set_preferred_source, db_kv_get, db_kv_set,
            tasks_list, tasks_cancel, tasks_clear_finished, db_status, db_songs_list, db_songs_put, db_songs_delete, db_playlists_list, db_playlists_put, db_playlists_delete, check_midi, has_midi, verify_midi, dupe_midi, delete_midi, rename_midi, wallpaper_defaults, data_root, open_data_root, clean_temp, get_zoom_factor, set_zoom_factor, set_full_screen, autosave_write, autosave_list, autosave_read, autosave_clear, read_sidecar_lyrics, reveal_midi, copy_asset, open_folder, project_save, project_open, storage_report, storage_cleanup, audio_duration, export_audio, export_stems_zip, cover_singers, cover_pick_audio, cover_pick_dir, cover_open, cover_cancel, cover_run, video_export_begin, video_export_write, video_export_abort, video_export_end, pick_cover, export_dawproject, autostart_get, autostart_set, diag_health, pick_model_archive, model_import_local, clear_user_data, check_integrity, repair_integrity, write_midi, write_binary, usermeta_list, usermeta_set, usermeta_remove, usermeta_reorder, usermeta_pin, wallpaper_list, wallpaper_add_local, wallpaper_remove_local, wallpaper_scan_folder, file_assoc, wallpaper_set_desktop, gpu_status, gpu_uninstall, gpu_unified_memory_experiment, plugins_list, plugins_rescan, plugins_set_enabled, plugins_installed_list, plugins_platform_info, plugins_catalog, plugins_open_platform, plugins_install_from_platform, plugins_confirm_install, plugins_cancel_install, plugins_open_dir, plugins_open_docs, open_edit_guide, sf_workshop_list, sf_workshop_import, sf_workshop_delete, sf_workshop_open_dir, model_list, omr_engine_status, omr_engine_open_dir, omr_engine_remove, omr_lang_status, omr_lang_remove, omr_homr_status, omr_homr_remove, omr_sr_status, omr_sr_remove,
            soundfont_list, dep_check, diag_export, notify, open_output, open_external,
            presets_list, presets_save, presets_delete, presets_last_used, presets_set_model,
            presets_reorder, presets_reorder_to, presets_restore,
            pick_file, pick_directory, pick_audio, pick_audio_files, pick_image, pick_music_xml,
            list_midi_files, list_audio_files, library_stats, read_soundfont, read_binary, save_binary,
            convert, probe, refine, separate_audio, cancel, set_transcribe_pause, engine_worker_status,
            utau_list_voicebanks, voicebank_unified, utau_read_oto, utau_save_oto, utau_delete_voicebank, utau_import_voicebank_zip, utau_export_voicebank, utau_export_voicebank_zip, model_delete, take_pending_open_file, rvc_list, rvc_remove, rvc_pick_folder, rvc_pick_files, rvc_pick_zip, rvc_import_folder, rvc_import_files, rvc_import_zip, rvc_probe, rvc_catalog, rvc_open_catalog_page, rvc_refresh_catalog
        ])
        .setup(move |app| {
            if let Some(listener) = listener { start_single_instance_listener(listener, app.handle().clone()); }
            println!("[fufumidi-shell] {}", serde_json::to_string(&host_info_json()).unwrap_or_default());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building FuFumidi Tauri shell");
    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            tauri_log("exit");
            if let Some(st) = app_handle.try_state::<WorkerState>() {
                // 取消在途 job 并 kill 暖 worker，退出后不留 Python 进程。
                st.pool.shutdown();
            }
        }
    });
    tauri_log("run-returned");
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
    fn cancel_target_prefers_job_map_and_only_guesses_at_cap_one() {
        use std::collections::HashMap;
        let info = |id: u64| super::worker_pool::WorkerInfo {
            id,
            pid: Some(100 + id as u32),
            ready: true,
            canceled: false,
        };
        let no_jobs = HashMap::new();
        assert_eq!(super::cancel_target(None, 1, &[], &no_jobs), None);
        assert_eq!(super::cancel_target(Some("smoke-cancel"), 1, &[info(7)], &no_jobs), Some(7));
        assert_eq!(super::cancel_target(Some("sep3"), 1, &[info(7)], &no_jobs), Some(7));
        assert_eq!(super::cancel_target(Some("7"), 1, &[info(7)], &no_jobs), Some(7));
        // 过期/未知数字：cap=1 下回退唯一在途，与旧实现忽略 id 等价。
        assert_eq!(super::cancel_target(Some("9"), 1, &[info(7)], &no_jobs), Some(7));
        // cap>1 未知 id 不猜目标，也不误杀唯一在途。
        assert_eq!(super::cancel_target(Some("nope"), 4, &[info(1), info(2)], &no_jobs), None);
        assert_eq!(super::cancel_target(Some("nope"), 4, &[info(7)], &no_jobs), None);
        assert_eq!(super::cancel_target(None, 4, &[info(7)], &no_jobs), None);
        assert_eq!(super::cancel_target(Some("1"), 4, &[info(1), info(2)], &no_jobs), Some(1));

        // 前端 job id 精确映射优先：只命中自己，不误杀另一个在途转换。
        let mut jobs = HashMap::new();
        jobs.insert("batch7".to_string(), 2u64);
        assert_eq!(super::cancel_target(Some("batch7"), 4, &[info(1), info(2)], &jobs), Some(2));
        assert_eq!(super::cancel_target(Some("batch8"), 4, &[info(1), info(2)], &jobs), None);
        // 映射优先于数字 id（同名字符串不会把池内 job 2 当目标）。
        jobs.insert("2".to_string(), 1u64);
        assert_eq!(super::cancel_target(Some("2"), 1, &[info(1), info(2)], &jobs), Some(1));
    }

    #[test]
    fn effective_cap_matrix_clamps_gpu_and_max_workers() {
        fn cap(req: serde_json::Value, env: &[(&str, &str)]) -> usize {
            let map: std::collections::HashMap<String, String> =
                env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            super::effective_cap(&req, |key: &str| map.get(key).cloned())
        }
        // 缺省 __slots=1；缺省视为 GPU，再减 1 后仍 >=1。
        assert_eq!(cap(serde_json::json!({}), &[]), 1);
        assert_eq!(cap(serde_json::json!({ "__slots": 1 }), &[]), 1);
        // CPU（FUFUMIDI_DISABLE_GPU=1）用满 slots。
        let cpu = [("FUFUMIDI_DISABLE_GPU", "1")];
        assert_eq!(cap(serde_json::json!({ "__slots": 1 }), &cpu), 1);
        assert_eq!(cap(serde_json::json!({ "__slots": 2 }), &cpu), 2);
        assert_eq!(cap(serde_json::json!({ "__slots": 3 }), &cpu), 3);
        assert_eq!(cap(serde_json::json!({ "__slots": 4 }), &cpu), 4);
        // GPU 语义：cap = max(1, slots-1)（只有显式 "1" 才算禁用 GPU）。
        assert_eq!(cap(serde_json::json!({ "__slots": 2 }), &[]), 1);
        assert_eq!(cap(serde_json::json!({ "__slots": 3 }), &[]), 2);
        assert_eq!(cap(serde_json::json!({ "__slots": 4 }), &[]), 3);
        assert_eq!(cap(serde_json::json!({ "__slots": 4 }), &[("FUFUMIDI_DISABLE_GPU", "0")]), 3);
        // __slots clamp 1..=4；字符串/非法/浮点都容错。
        assert_eq!(cap(serde_json::json!({ "__slots": 0 }), &cpu), 1);
        assert_eq!(cap(serde_json::json!({ "__slots": 9 }), &cpu), 4);
        assert_eq!(cap(serde_json::json!({ "__slots": "3" }), &cpu), 3);
        assert_eq!(cap(serde_json::json!({ "__slots": "abc" }), &cpu), 1);
        assert_eq!(cap(serde_json::json!({ "__slots": -2 }), &cpu), 1);
        assert_eq!(cap(serde_json::json!({ "__slots": 3.9 }), &cpu), 3);
        assert_eq!(cap(serde_json::json!({ "__slots": null }), &cpu), 1);
        // FUFUMIDI_MAX_WORKERS 只降不升。
        assert_eq!(cap(serde_json::json!({ "__slots": 4 }), &[("FUFUMIDI_DISABLE_GPU", "1"), ("FUFUMIDI_MAX_WORKERS", "2")]), 2);
        assert_eq!(cap(serde_json::json!({ "__slots": 4 }), &[("FUFUMIDI_MAX_WORKERS", "2")]), 2);
        assert_eq!(cap(serde_json::json!({ "__slots": 1 }), &[("FUFUMIDI_DISABLE_GPU", "1"), ("FUFUMIDI_MAX_WORKERS", "4")]), 1);
        assert_eq!(cap(serde_json::json!({ "__slots": 4 }), &[("FUFUMIDI_DISABLE_GPU", "1"), ("FUFUMIDI_MAX_WORKERS", "0")]), 1);
        assert_eq!(cap(serde_json::json!({ "__slots": 4 }), &[("FUFUMIDI_DISABLE_GPU", "1"), ("FUFUMIDI_MAX_WORKERS", "bogus")]), 4);
    }

    #[test]
    fn job_registration_cleans_up_on_drop() {
        let jobs = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
        {
            let _reg = super::JobRegistration::register(jobs.clone(), "batch7".to_string(), 11);
            assert_eq!(jobs.lock().unwrap().get("batch7"), Some(&11));
        }
        assert!(jobs.lock().unwrap().is_empty(), "Drop must clear the mapping");
        // 同一前端 id 后登记覆盖先登记：先登记的 Drop 不误删后来者。
        let first = super::JobRegistration::register(jobs.clone(), "batch8".to_string(), 21);
        let second = super::JobRegistration::register(jobs.clone(), "batch8".to_string(), 22);
        drop(first);
        assert_eq!(jobs.lock().unwrap().get("batch8"), Some(&22));
        drop(second);
        assert!(jobs.lock().unwrap().is_empty());
    }

    #[test]
    fn worker_status_payload_keeps_legacy_fields_and_lists_workers() {
        use std::collections::HashMap;
        let queued = super::worker_pool::PoolStatus {
            cap: 2,
            busy: 2,
            workers: vec![
                super::worker_pool::WorkerInfo { id: 12, pid: None, ready: false, canceled: false },
                super::worker_pool::WorkerInfo { id: 11, pid: Some(101), ready: true, canceled: false },
            ],
            warm: 1,
            warm_alive: true,
            warm_pid: Some(201),
            warm_pids: vec![201],
            ..Default::default()
        };
        let mut jobs = HashMap::new();
        jobs.insert("batch7".to_string(), 11u64);
        let value = super::worker_status_json(&queued, 7, &jobs);
        assert_eq!(value["ok"], true);
        assert_eq!(value["running"], true);
        assert_eq!(value["pid"], 101);
        assert_eq!(value["seq"], 7);
        assert_eq!(value["cap"], 2);
        let workers = value["workers"].as_array().expect("workers array");
        assert_eq!(workers.len(), 3);
        // 在途 job 按池内 JobId 排序；jobId 是前端 id（取消用的就是它）。
        assert_eq!(workers[0]["slot"], 0);
        assert_eq!(workers[0]["pid"], 101);
        assert_eq!(workers[0]["jobId"], "batch7");
        assert_eq!(workers[0]["busy"], true);
        assert_eq!(workers[1]["slot"], 1);
        assert_eq!(workers[1]["pid"], serde_json::Value::Null);
        assert_eq!(workers[1]["jobId"], serde_json::Value::Null);
        assert_eq!(workers[1]["busy"], true);
        // 暖 worker 是 idle 槽：busy=false、jobId=null。
        assert_eq!(workers[2]["slot"], 2);
        assert_eq!(workers[2]["pid"], 201);
        assert_eq!(workers[2]["jobId"], serde_json::Value::Null);
        assert_eq!(workers[2]["busy"], false);

        // 只有暖 worker 时旧字段 running 仍为 true；彻底空闲时 seq=0、workers 为空。
        let idle = super::worker_pool::PoolStatus {
            warm: 1,
            warm_alive: true,
            warm_pid: Some(301),
            warm_pids: vec![301],
            ..Default::default()
        };
        let value = super::worker_status_json(&idle, 9, &HashMap::new());
        assert_eq!(value["running"], true);
        assert_eq!(value["pid"], 301);
        assert_eq!(value["seq"], 9);
        assert_eq!(value["workers"].as_array().unwrap().len(), 1);
        assert_eq!(value["workers"][0]["busy"], false);

        let down = super::worker_pool::PoolStatus::default();
        let value = super::worker_status_json(&down, 9, &HashMap::new());
        assert_eq!(value["running"], false);
        assert_eq!(value["seq"], 0);
        assert_eq!(value["workers"].as_array().unwrap().len(), 0);
    }


    /// 生产路径集成测试：用真实 engine worker（不加载模型，仅校验缺文件请求）验证
    /// spawn_worker → ###RESULT 协议 → 暖 worker 复用 → shutdown 杀进程；不开窗口。
    #[test]
    fn real_engine_worker_protocol_warm_and_shutdown() {
        if super::python_path().is_none() || super::engine_dir().is_none() {
            eprintln!("real_engine_worker_protocol_warm_and_shutdown: skipped (python/engine not found)");
            return;
        }
        let pool = super::worker_pool::WorkerPool::with_reuse(1).expect("worker pool");
        let first_pid = {
            let lease = pool
                .acquire(|_id, _cancel| super::spawn_worker())
                .expect("spawn engine worker");
            let pid = lease.pid().expect("worker pid");
            // 缺文件请求在参数校验阶段就返回 ###RESULT，不会加载任何模型。
            let req = serde_json::json!({
                "audio": "__fufumidi_missing__.wav",
                "out": "__fufumidi_missing__.mid",
                "_id": 1,
            });
            lease.send(&req.to_string()).expect("send request");
            let mut result = None;
            for _ in 0..80 {
                match lease.read_line().expect("read worker line") {
                    Some(line) => {
                        if let Some(rest) = line.trim().strip_prefix("###RESULT ") {
                            result = serde_json::from_str::<serde_json::Value>(rest).ok();
                            break;
                        }
                    }
                    None => break,
                }
            }
            let result = result.expect("engine worker must answer with ###RESULT");
            assert_eq!(result["_id"], 1);
            assert_eq!(result["ok"], false);
            pid
        };
        let status = pool.status();
        assert_eq!(status.warm, 1, "engine worker should stay warm");
        assert_eq!(status.warm_pid, Some(first_pid));
        {
            let lease = pool
                .acquire(|_id, _cancel| super::spawn_worker())
                .expect("reuse engine worker");
            assert_eq!(lease.pid(), Some(first_pid), "second request must reuse warm worker");
        }
        pool.shutdown();
        let status = pool.status();
        assert_eq!(status.warm, 0);
        assert_eq!(status.busy, 0);
    }

    #[test]
    fn p3_job_event_id_and_result_matching() {
        assert_eq!(super::job_event_id(&serde_json::json!({ "id": "batch37" }), 7), "batch37");
        assert_eq!(super::job_event_id(&serde_json::json!({ "id": "  " }), 7), "job-7");
        assert_eq!(super::job_event_id(&serde_json::json!({}), 7), "job-7");
        assert!(super::result_id_matches(&serde_json::json!({ "_id": "batch37" }), "batch37"));
        assert!(!super::result_id_matches(&serde_json::json!({ "_id": "batch38" }), "batch37"));
        assert!(super::result_id_matches(&serde_json::json!({ "_id": 7 }), "7"));
        assert!(!super::result_id_matches(&serde_json::json!({ "_id": null }), "7"));
    }

    #[test]
    fn worker_seq_restarts_per_worker_and_continues_when_warm() {
        let seq = std::sync::atomic::AtomicU64::new(0);
        assert_eq!(super::next_worker_seq(false, &seq), 1, "new worker starts at 1");
        assert_eq!(super::next_worker_seq(true, &seq), 2, "warm worker continues");
        assert_eq!(super::next_worker_seq(true, &seq), 3, "warm worker continues");
        assert_eq!(super::next_worker_seq(false, &seq), 1, "new worker resets to 1");
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
    fn audio_duration_unsupported_extension() {
        let root = tmpdir("audio-unsupported");
        let f = root.join("clip.wma");
        std::fs::write(&f, b"not supported").unwrap();
        let r = super::audio_duration_at(f.to_str().unwrap());
        assert_eq!(r["ok"], false);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn audio_duration_aiff() {
        let root = tmpdir("audio-aiff");
        let f = root.join("clip.aiff");
        let mut b: Vec<u8> = Vec::new();
        b.extend_from_slice(b"FORM"); b.extend_from_slice(&30u32.to_be_bytes()); b.extend_from_slice(b"AIFF");
        b.extend_from_slice(b"COMM"); b.extend_from_slice(&18u32.to_be_bytes());
        b.extend_from_slice(&1u16.to_be_bytes());
        b.extend_from_slice(&44100u32.to_be_bytes());
        b.extend_from_slice(&16u16.to_be_bytes());
        b.extend_from_slice(&[0x40,0x0E,0xAC,0x44,0,0,0,0,0,0]);
        std::fs::write(&f, &b).unwrap();
        let r = super::audio_duration_at(f.to_str().unwrap());
        assert_eq!(r["ok"], true, "{}", r);
        assert!((r["seconds"].as_f64().unwrap() - 1.0).abs() < 0.001);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn audio_duration_ogg() {
        let root = tmpdir("audio-ogg");
        let f = root.join("clip.ogg");
        fn page(granule: u64, payload: &[u8]) -> Vec<u8> {
            let mut b: Vec<u8> = Vec::new();
            b.extend_from_slice(b"OggS"); b.push(0); b.push(0);
            b.extend_from_slice(&granule.to_le_bytes());
            b.extend_from_slice(&1u32.to_le_bytes()); b.extend_from_slice(&0u32.to_le_bytes()); b.extend_from_slice(&0u32.to_le_bytes());
            b.push(1); b.push(payload.len() as u8); b.extend_from_slice(payload); b
        }
        let mut header = vec![1u8]; header.extend_from_slice(b"vorbis"); header.extend_from_slice(&[0,0,0,0,1,0x44,0xAC,0,0]);
        let mut data: Vec<u8> = Vec::new(); data.extend_from_slice(&page(0, &header)); data.extend_from_slice(&page(44100, &[]));
        std::fs::write(&f, &data).unwrap();
        let r = super::audio_duration_at(f.to_str().unwrap());
        assert_eq!(r["ok"], true, "{}", r);
        assert!((r["seconds"].as_f64().unwrap() - 1.0).abs() < 0.001);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn audio_duration_m4a() {
        let root = tmpdir("audio-m4a");
        let f = root.join("clip.m4a");
        let mut mvhd: Vec<u8> = Vec::new();
        mvhd.extend_from_slice(&[0,0,0,0]);
        mvhd.extend_from_slice(&[0,0,0,0]); mvhd.extend_from_slice(&[0,0,0,0]);
        mvhd.extend_from_slice(&1000u32.to_be_bytes());
        mvhd.extend_from_slice(&2000u32.to_be_bytes());
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

#[cfg(test)]
mod update_sources_tests {
    use super::{update_sources_at, UPDATE_MIRRORS};
    use std::path::Path;

    fn ids(list: &[serde_json::Value]) -> Vec<String> {
        list.iter().map(|x| x["id"].as_str().unwrap_or_default().to_string()).collect()
    }

    fn ids_at(channel: Option<&str>, download_source: Option<&str>, preferred: Option<&str>) -> Vec<String> {
        ids(&update_sources_at(channel, download_source, preferred))
    }

    #[test]
    fn stable_auto_prefers_cnb_then_mirrors_then_github() {
        let list = update_sources_at(Some("stable"), Some("auto"), None);
        assert_eq!(ids(&list), ["cnb", "ghfast", "ghproxy", "ghproxy-net", "github"]);
        assert_eq!(list[0]["label"], "CNB 国内源");
        assert_eq!(list[0]["kind"], "cnb");
        assert_eq!(list[4]["label"], "GitHub 官方");
        assert_eq!(list[4]["kind"], "github");
        assert!(list[1..4].iter().all(|x| x["kind"] == "mirror"), "middle entries are mirrors");
        assert!(list.iter().all(|x| x["channel"] == "stable"));
        assert_eq!(list.len(), UPDATE_MIRRORS.len() + 1);
    }

    #[test]
    fn stable_github_prefers_official_then_mirrors_then_cnb() {
        assert_eq!(ids_at(Some("stable"), Some("github"), None), ["github", "ghfast", "ghproxy", "ghproxy-net", "cnb"]);
        // 归一化与 main/download-source.js 的 normSource 一致：大小写不敏感，未知值 → auto
        assert_eq!(ids_at(Some("stable"), Some("GITHUB"), None), ids_at(Some("stable"), Some("github"), None));
        assert_eq!(ids_at(Some("stable"), Some("cnb"), None), ids_at(Some("stable"), Some("auto"), None));
        assert_eq!(ids_at(Some("stable"), Some("bogus"), None), ids_at(Some("stable"), Some("auto"), None));
        assert_eq!(ids_at(Some("stable"), None, None), ids_at(Some("stable"), Some("auto"), None));
    }

    #[test]
    fn preferred_is_moved_to_front_without_reordering_the_rest() {
        assert_eq!(
            ids_at(Some("stable"), Some("auto"), Some("ghproxy-net")),
            ["ghproxy-net", "cnb", "ghfast", "ghproxy", "github"]
        );
        assert_eq!(
            ids_at(Some("stable"), Some("auto"), Some("github")),
            ["github", "cnb", "ghfast", "ghproxy", "ghproxy-net"]
        );
        // 已在第一位 / 未知 id / 空串：顺序不变（preferred 只是提前，不是硬绑定）
        let base = ids_at(Some("stable"), Some("auto"), None);
        assert_eq!(ids_at(Some("stable"), Some("auto"), Some("cnb")), base);
        assert_eq!(ids_at(Some("stable"), Some("auto"), Some("nope")), base);
        assert_eq!(ids_at(Some("stable"), Some("auto"), Some("")), base);
        // 通道不匹配的 preferred（stable id 用在 beta 列表）不应该改动顺序
        assert_eq!(ids_at(Some("beta"), Some("auto"), Some("ghproxy")), ids_at(Some("beta"), Some("auto"), None));
    }

    #[test]
    fn beta_channel_appends_beta_suffix_to_ids() {
        let beta = update_sources_at(Some("beta"), Some("auto"), None);
        assert_eq!(ids(&beta), ["cnb-beta", "ghfast-beta", "ghproxy-beta", "ghproxy-net-beta", "github-beta"]);
        assert!(beta.iter().all(|x| x["channel"] == "beta"));
        assert_eq!(beta[0]["label"], "CNB 国内源");
        assert_eq!(beta[0]["kind"], "cnb");
        assert_eq!(beta[4]["label"], "GitHub 官方");
        assert_eq!(beta[4]["kind"], "github");
        // preferred 必须用带 -beta 后缀的 id 才能提前
        assert_eq!(
            ids_at(Some("beta"), Some("auto"), Some("ghproxy-beta")),
            ["ghproxy-beta", "cnb-beta", "ghfast-beta", "ghproxy-net-beta", "github-beta"]
        );
        // 只有等价于 beta（大小写不敏感）才进测试通道
        assert_eq!(ids_at(Some("BETA"), None, None), ids(&beta));
        assert_eq!(ids_at(Some("stable"), None, None), ids_at(None, None, None));
    }

    #[test]
    fn unknown_channel_falls_back_to_stable() {
        let stable = ids_at(Some("stable"), Some("auto"), None);
        assert_eq!(ids_at(Some("nightly"), Some("auto"), None), stable);
        assert_eq!(ids_at(None, Some("auto"), None), stable);
        assert_eq!(ids_at(Some(""), Some("auto"), None), stable);
    }

    #[test]
    fn ids_match_build_kachina_config() {
        let cfg_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../build/kachina.config.json");
        let raw = std::fs::read_to_string(&cfg_path).expect("build/kachina.config.json must exist");
        let cfg: serde_json::Value = serde_json::from_str(&raw).expect("kachina config must be valid json");
        let source = cfg.get("source").and_then(|v| v.as_array()).expect("kachina config needs source[]");
        let mut config_ids: Vec<String> = source
            .iter()
            .filter_map(|s| s.get("id").and_then(|v| v.as_str()).map(str::to_string))
            .collect();
        config_ids.sort();
        assert_eq!(config_ids.len(), 10, "kachina config should keep 5 stable + 5 beta sources");

        let mut actual = ids(&update_sources_at(Some("stable"), Some("auto"), None));
        actual.extend(ids(&update_sources_at(Some("beta"), Some("auto"), None)));
        actual.sort();
        assert_eq!(actual, config_ids, "Tauri 更新源 id 必须与 build/kachina.config.json 的 source[].id 一致");
    }
}

#[cfg(test)]
mod voicebank_tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn tmpdir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("fufumidi-voicebank-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn mkdir(p: &Path) {
        std::fs::create_dir_all(p).unwrap();
    }

    fn put(p: &Path, text: &str) {
        if let Some(parent) = p.parent() { mkdir(parent); }
        std::fs::write(p, text).unwrap();
    }

    fn put_bytes(p: &Path, bytes: &[u8]) {
        if let Some(parent) = p.parent() { mkdir(parent); }
        std::fs::write(p, bytes).unwrap();
    }

    fn find<'a>(v: &'a serde_json::Value, name: &str) -> Option<&'a serde_json::Value> {
        v["list"].as_array()?.iter().find(|x| x["name"] == name)
    }

    fn ids(v: &serde_json::Value) -> Vec<String> {
        v["list"].as_array().unwrap().iter()
            .map(|x| x["id"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    /// 三标记识别 / yaml 优先 / txt name= 与 名前= / 空名回退目录名 / 非声库跳过 / 只扫一层。
    #[test]
    fn utau_markers_names_and_single_level() {
        let root = tmpdir("markers");
        mkdir(&root.join("txt-name"));
        put(&root.join("txt-name/character.txt"), "name=文本声库\n");
        mkdir(&root.join("jp-name"));
        put(&root.join("jp-name/character.txt"), "名前：日本語名\n");
        mkdir(&root.join("yaml-wins"));
        put(&root.join("yaml-wins/character.txt"), "name=旧名\n");
        put(&root.join("yaml-wins/character.yaml"), "name: 新名\n");
        mkdir(&root.join("yaml-only"));
        put(&root.join("yaml-only/character.yaml"), "name: 仅 Yaml\n");
        mkdir(&root.join("oto-only"));
        put(&root.join("oto-only/oto.ini"), "");
        mkdir(&root.join("empty-name"));
        put(&root.join("empty-name/character.txt"), "name=\n");
        mkdir(&root.join("bom-name"));
        let mut bom_txt = vec![0xEF, 0xBB, 0xBF];
        bom_txt.extend_from_slice("name=BOM 声库".as_bytes());
        put_bytes(&root.join("bom-name/character.txt"), &bom_txt);
        mkdir(&root.join("not-a-bank"));
        put(&root.join("not-a-bank/readme.md"), "x");
        put(&root.join("stray.txt"), "x");
        // 声库根下一层的声库不应被扫到（只扫 root 一层）
        mkdir(&root.join("txt-name/nested"));
        put(&root.join("txt-name/nested/character.txt"), "name=嵌套\n");

        let v = utau_list_voicebanks_at(&root);
        assert_eq!(v["ok"], true);
        assert_eq!(v["list"].as_array().unwrap().len(), 7, "7 个声库根（三标记、空名回退、BOM 各一个）");
        assert_eq!(find(&v, "文本声库").unwrap()["dir"], root.join("txt-name").display().to_string());
        assert_eq!(find(&v, "日本語名").unwrap()["dir"], root.join("jp-name").display().to_string());
        assert_eq!(find(&v, "新名").unwrap()["dir"], root.join("yaml-wins").display().to_string());
        assert_eq!(find(&v, "仅 Yaml").unwrap()["dir"], root.join("yaml-only").display().to_string(), "只有 character.yaml 也算声库根");
        assert!(find(&v, "旧名").is_none(), "yaml 的 name: 必须覆盖 character.txt 的 name=");
        assert_eq!(find(&v, "oto-only").unwrap()["dir"], root.join("oto-only").display().to_string());
        assert_eq!(find(&v, "empty-name").unwrap()["dir"], root.join("empty-name").display().to_string());
        assert_eq!(find(&v, "BOM 声库").unwrap()["dir"], root.join("bom-name").display().to_string(), "UTF-8 BOM 不该吞掉 name=");
        assert!(find(&v, "嵌套").is_none(), "不递归声库根");
        assert!(find(&v, "not-a-bank").is_none(), "非声库目录跳过");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn utau_missing_root_is_empty_ok() {
        let root = tmpdir("missing-root");
        let v = utau_list_voicebanks_at(&root.join("nope"));
        assert_eq!(v["ok"], true);
        assert_eq!(v["list"].as_array().unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(root);
    }

    /// UTF-8 非法字节走 lossy：不 panic、不丢条目。
    #[test]
    fn utau_lossy_utf8_does_not_panic() {
        let root = tmpdir("lossy");
        mkdir(&root.join("broken-txt"));
        put_bytes(&root.join("broken-txt/character.txt"), b"name=\xff\xfe\x80\n");
        mkdir(&root.join("broken-yaml"));
        put_bytes(&root.join("broken-yaml/character.yaml"), b"name: \xc3\x28\n");
        let v = utau_list_voicebanks_at(&root);
        assert_eq!(v["ok"], true);
        assert_eq!(v["list"].as_array().unwrap().len(), 2);
        assert!(
            v["list"].as_array().unwrap().iter()
                .any(|x| x["name"].as_str().unwrap_or_default().contains('\u{FFFD}')),
            "非法字节应替换为 U+FFFD 而不是放弃整条"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    /// DiffSinger 只看 dsconfig.yaml 的根/下一层；UTAU 侧任意目录；counts 与 id 前缀。
    #[test]
    fn unified_dsconfig_root_and_one_level() {
        let base = tmpdir("unified");
        let utau_root = base.join("voicebanks");
        let ds_root = base.join("diffsinger-voicebanks");
        mkdir(&utau_root.join("ub1"));
        put(&utau_root.join("ub1/oto.ini"), "");
        mkdir(&utau_root.join("ub-any-dir"));
        put(&utau_root.join("stray.txt"), "x");
        mkdir(&ds_root.join("ds-root"));
        put(&ds_root.join("ds-root/dsconfig.yaml"), "x");
        mkdir(&ds_root.join("ds-child/inner"));
        put(&ds_root.join("ds-child/inner/dsconfig.yaml"), "x");
        mkdir(&ds_root.join("ds-deep/l2/l3"));
        put(&ds_root.join("ds-deep/l2/l3/dsconfig.yaml"), "x");
        mkdir(&ds_root.join("ds-empty"));
        put(&ds_root.join("ds-empty/readme.md"), "x");

        let v = voicebank_unified_at(&utau_root, &ds_root);
        assert_eq!(v["ok"], true);
        assert_eq!(v["utauCount"], 2);
        assert_eq!(v["diffsingerCount"], 2);
        assert_eq!(v["list"].as_array().unwrap().len(), 4);
        assert_eq!(v["utauRoot"], utau_root.display().to_string());
        assert_eq!(v["diffsingerRoot"], ds_root.display().to_string());

        let all = ids(&v);
        for want in ["utau:ub1", "utau:ub-any-dir", "diffsinger:ds-root", "diffsinger:ds-child"] {
            assert!(all.iter().any(|x| x == want), "缺少 {want}");
        }
        assert!(!all.iter().any(|x| x == "diffsinger:ds-deep"), "dsconfig 第三层不算");
        assert!(!all.iter().any(|x| x == "diffsinger:ds-empty"), "无 dsconfig 不算");

        let ds_child = find(&v, "ds-child").unwrap();
        assert_eq!(ds_child["kind"], "diffsinger");
        assert_eq!(ds_child["dir"], ds_root.join("ds-child").display().to_string());
        let _ = std::fs::remove_dir_all(base);
    }

    /// size 递归求和（含子目录），UTAU 统一清单里也带 size。
    #[test]
    fn unified_size_sums_recursively() {
        let base = tmpdir("size");
        let utau_root = base.join("vb");
        mkdir(&utau_root.join("bank/nested"));
        put_bytes(&utau_root.join("bank/a.bin"), &[0u8; 3]);
        put_bytes(&utau_root.join("bank/nested/b.bin"), &[0u8; 5]);
        put_bytes(&utau_root.join("bank/nested/empty.bin"), b"");
        let v = voicebank_unified_at(&utau_root, &base.join("ds-missing"));
        let item = &v["list"][0];
        assert_eq!(item["kind"], "utau");
        assert_eq!(item["size"], 8);
        assert_eq!(v["diffsingerCount"], 0);
        let _ = std::fs::remove_dir_all(base);
    }

    /// 一侧目录缺失时另一侧照常工作，roots 仍然原样回显。
    #[test]
    fn unified_tolerates_one_missing_side() {
        let base = tmpdir("tolerant");
        let utau_root = base.join("voicebanks");
        let ds_root = base.join("diffsinger-voicebanks");
        mkdir(&utau_root.join("only-utau"));
        mkdir(&ds_root.join("only-ds"));
        put(&ds_root.join("only-ds/dsconfig.yaml"), "x");

        let no_ds = base.join("no-ds");
        let a = voicebank_unified_at(&utau_root, &no_ds);
        assert_eq!(a["ok"], true);
        assert_eq!(a["utauCount"], 1);
        assert_eq!(a["diffsingerCount"], 0);
        assert_eq!(a["diffsingerRoot"], no_ds.display().to_string());

        let no_utau = base.join("no-utau");
        let b = voicebank_unified_at(&no_utau, &ds_root);
        assert_eq!(b["ok"], true);
        assert_eq!(b["utauCount"], 0);
        assert_eq!(b["diffsingerCount"], 1);
        assert_eq!(ids(&b), vec!["diffsinger:only-ds"]);
        let _ = std::fs::remove_dir_all(base);
    }
}

#[cfg(test)]
mod oto_tests {
    use super::{oto_b64_decode, oto_b64_encode, utau_read_oto_at, utau_save_oto_at};

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let uniq = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let p = std::env::temp_dir().join(format!("fufumidi-oto-{tag}-{}-{uniq}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn base64_roundtrip_and_lenient_decode() {
        let raw = b"oto.ini\x00\xff\xe4\xb8\xad";
        let enc = oto_b64_encode(raw);
        assert_eq!(oto_b64_decode(&enc), raw.to_vec());
        // 非法字符/空白忽略；'=' 截止；不 panic
        assert_eq!(oto_b64_decode("!!QUJDRA=="), b"ABCD".to_vec());
        assert_eq!(oto_b64_decode("QUJDRA"), b"ABCD".to_vec());
        assert!(oto_b64_decode("=======").is_empty());
    }

    #[test]
    fn read_oto_bytes_size_mtime_and_cjk_dir() {
        let root = tmpdir("read-root");
        let bank = root.join("声库 中文");
        std::fs::create_dir_all(&bank).unwrap();
        let bytes = b"a=oto\r\nb=oto2";
        std::fs::write(bank.join("oto.ini"), bytes).unwrap();
        let r = utau_read_oto_at(&root, Some(bank.to_str().unwrap()));
        assert_eq!(r["ok"], true, "{}", r);
        assert_eq!(r["size"], bytes.len());
        assert!(r["mtimeMs"].as_f64().unwrap() > 0.0);
        assert_eq!(oto_b64_decode(r["base64"].as_str().unwrap()), bytes.to_vec());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn read_errors_for_missing_bank_oto_and_arg() {
        let root = tmpdir("read-err");
        std::fs::create_dir_all(root.join("empty")).unwrap();
        assert_eq!(utau_read_oto_at(&root, None)["ok"], false);
        assert_eq!(utau_read_oto_at(&root, Some(""))["ok"], false);
        assert_eq!(utau_read_oto_at(&root, Some("nope"))["ok"], false);
        assert_eq!(utau_read_oto_at(&root, Some(root.join("empty").to_str().unwrap()))["ok"], false);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn save_new_file_backup_and_overwrite() {
        let root = tmpdir("save-root");
        let bank = root.join("bank");
        std::fs::create_dir_all(&bank).unwrap();
        let v = bank.to_str().unwrap();
        let first = utau_save_oto_at(&root, Some(v), Some(&oto_b64_encode(b"first")));
        assert_eq!(first["ok"], true, "{}", first);
        assert_eq!(first["backup"], "");
        assert_eq!(std::fs::read(bank.join("oto.ini")).unwrap(), b"first");
        let second = utau_save_oto_at(&root, Some(v), Some(&oto_b64_encode(b"second")));
        assert_eq!(second["ok"], true, "{}", second);
        assert!(second["backup"].as_str().unwrap().ends_with("oto.ini.bak"));
        assert_eq!(std::fs::read(bank.join("oto.ini.bak")).unwrap(), b"first");
        assert_eq!(std::fs::read(bank.join("oto.ini")).unwrap(), b"second");
        let third = utau_save_oto_at(&root, Some(v), Some(&oto_b64_encode(b"third")));
        assert_eq!(third["ok"], true);
        assert_eq!(std::fs::read(bank.join("oto.ini.bak")).unwrap(), b"second");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn save_rejects_empty_missing_and_outside_paths() {
        let root = tmpdir("save-err");
        let bank = root.join("bank");
        std::fs::create_dir_all(&bank).unwrap();
        let v = bank.to_str().unwrap();
        assert_eq!(utau_save_oto_at(&root, Some(v), None)["ok"], false, "empty");
        assert_eq!(utau_save_oto_at(&root, Some(v), Some(""))["ok"], false, "empty b64");
        assert_eq!(utau_save_oto_at(&root, Some("missing"), Some(&oto_b64_encode(b"x")))["ok"], false);
        let outside = tmpdir("outside");
        let r = utau_save_oto_at(&root, Some(outside.to_str().unwrap()), Some(&oto_b64_encode(b"x")));
        assert_eq!(r["ok"], false, "outside must be rejected: {}", r);
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn save_rejects_over_8mb() {
        let root = tmpdir("save-big");
        let bank = root.join("bank");
        std::fs::create_dir_all(&bank).unwrap();
        let raw = vec![b'x'; super::OTO_MAX_BYTES + 1];
        let r = utau_save_oto_at(&root, Some(bank.to_str().unwrap()), Some(&oto_b64_encode(&raw)));
        assert_eq!(r["ok"], false, "{}", r);
        let _ = std::fs::remove_dir_all(root);
    }




    #[test]
    fn export_voicebank_zip_sanitizes_entries() {
        use super::{oto_b64_encode, write_voicebank_zip_at};
        use std::io::Read as _;
        let root = tmpdir("export-zip");
        let out = root.join("bank.zip");
        let files = vec![
            serde_json::json!({ "name": "a.wav", "data": oto_b64_encode(b"AAA") }),
            serde_json::json!({ "name": "../escape.txt", "data": oto_b64_encode(b"no") }),
            serde_json::json!({ "name": "", "data": oto_b64_encode(b"skip") }),
        ];
        let r = write_voicebank_zip_at(&out, &files);
        assert_eq!(r["ok"], true, "{}", r);
        assert_eq!(r["count"], 2);
        assert!(out.is_file());
        let mut z = zip::ZipArchive::new(std::fs::File::open(&out).unwrap()).unwrap();
        assert_eq!(z.len(), 2);
        let mut names = Vec::new();
        for i in 0..z.len() {
            let mut e = z.by_index(i).unwrap();
            names.push(e.name().to_string());
            let mut b = Vec::new(); e.read_to_end(&mut b).unwrap();
            if e.name() == "a.wav" { assert_eq!(b, b"AAA"); }
        }
        assert!(names.iter().all(|n| !n.contains("..") && !n.contains('/')));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn export_voicebank_writes_sanitized_files() {
        use super::{oto_b64_encode, utau_export_voicebank_at};
        let root = tmpdir("export-root");
        let out = root.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let files = vec![
            serde_json::json!({ "name": "a.wav", "data": oto_b64_encode(b"AAA") }),
            serde_json::json!({ "name": "../escape.txt", "data": oto_b64_encode(b"no") }),
            serde_json::json!({ "name": "", "data": oto_b64_encode(b"skip") }),
        ];
        let r = utau_export_voicebank_at(&out, &files);
        assert_eq!(r["ok"], true, "{}", r);
        assert_eq!(r["count"], 2);
        assert_eq!(std::fs::read(out.join("a.wav")).unwrap(), b"AAA");
        assert!(!root.join("escape.txt").exists());
        assert!(!out.parent().unwrap().join("escape.txt").exists());
        assert_eq!(utau_export_voicebank_at(&root.join("missing"), &files)["ok"], false);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn import_zip_bank_nested_traversal_and_duplicate() {
        use super::{utau_import_zip_at, utau_list_voicebanks_at};
        use std::io::Write as _;
        let root = tmpdir("import-root");
        let outside = tmpdir("import-outside");
        let mkzip = |name: &str, entries: &[(&str, &[u8])]| {
            let p = root.join(name);
            let f = std::fs::File::create(&p).unwrap();
            let mut z = zip::ZipWriter::new(f);
            let opt = zip::write::SimpleFileOptions::default();
            for (n, b) in entries { z.start_file(*n, opt).unwrap(); z.write_all(b).unwrap(); }
            z.finish().unwrap();
            p
        };
        let z1 = mkzip("Bank One.zip", &[
            ("Bank/character.txt", b"name=Imported\n"),
            ("Bank/oto.ini", b"a=oto\n"),
        ]);
        let r = utau_import_zip_at(&root, &z1);
        assert_eq!(r["ok"], true, "{}", r);
        let dir1 = r["dir"].as_str().unwrap().to_string();
        assert!(dir1.ends_with("Bank One"));
        assert_eq!(r["name"], "Imported");
        let list = utau_list_voicebanks_at(&root);
        assert_eq!(list["list"].as_array().unwrap().len(), 1);

        let r2 = utau_import_zip_at(&root, &z1);
        assert_eq!(r2["ok"], true);
        assert!(r2["dir"].as_str().unwrap().ends_with("Bank One_2"));

        let z3 = mkzip("Evil.zip", &[
            ("../evil.txt", b"evil"),
            ("voice/character.yaml", b"name: EvilBank\n"),
            ("voice/oto.ini", b"x=1\n"),
        ]);
        let r3 = utau_import_zip_at(&root, &z3);
        assert_eq!(r3["ok"], true, "{}", r3);
        assert!(!outside.join("evil.txt").exists());
        assert!(r3["dir"].as_str().unwrap().ends_with("Evil"));

        let z4 = mkzip("Bare.zip", &[("oto.ini", b"a=1\n")]);
        let r4 = utau_import_zip_at(&root, &z4);
        assert_eq!(r4["ok"], true, "{}", r4);
        let d4 = std::path::PathBuf::from(r4["dir"].as_str().unwrap());
        assert!(d4.join("character.txt").exists() && d4.join("character.yaml").exists());

        let z5 = mkzip("NoBank.zip", &[("readme.txt", b"none")]);
        assert_eq!(utau_import_zip_at(&root, &z5)["ok"], false);
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn delete_voicebank_removes_only_child_dirs() {
        use super::utau_delete_voicebank_at;
        let root = tmpdir("delete-bank");
        let bank = root.join("bank");
        std::fs::create_dir_all(bank.join("nested")).unwrap();
        std::fs::write(bank.join("oto.ini"), b"x").unwrap();
        let r = utau_delete_voicebank_at(&root, Some(bank.to_str().unwrap()));
        assert_eq!(r["ok"], true, "{}", r);
        assert!(!bank.exists());
        assert_eq!(utau_delete_voicebank_at(&root, None)["ok"], false);
        assert_eq!(utau_delete_voicebank_at(&root, Some(root.to_str().unwrap()))["ok"], false, "root must be refused");
        let outside = tmpdir("delete-outside");
        assert_eq!(utau_delete_voicebank_at(&root, Some(outside.to_str().unwrap()))["ok"], false);
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }
}


#[cfg(test)]
mod rvc_tests {
    use super::{rvc_list_at, rvc_remove_at};

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let uniq = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let p = std::env::temp_dir().join(format!("fufumidi-rvc-{tag}-{}-{uniq}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }


    #[test]
    fn import_folder_reference_and_physical() {
        use super::{rvc_import_folder_at, rvc_list_at};
        let root = tmpdir("import-root");
        let ext = tmpdir("import-src");
        std::fs::write(ext.join("voice.pth"), b"pth").unwrap();
        std::fs::write(ext.join("voice.index"), b"idx").unwrap();
        let r = rvc_import_folder_at(&root, ext.to_str().unwrap(), None);
        assert_eq!(r["ok"], true, "{}", r);
        assert_eq!(r["model"]["engine"], "rvc");
        assert_eq!(r["model"]["files"]["model"], "voice.pth");
        let listed = rvc_list_at(&root);
        let m = &listed["models"][0];
        assert_eq!(m["external"], true);
        assert_eq!(m["ready"], true);
        // inside-root folder writes model.json
        let inner = root.join("local");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(inner.join("local.pth"), b"x").unwrap();
        let r2 = rvc_import_folder_at(&root, inner.to_str().unwrap(), Some("Local"));
        assert_eq!(r2["ok"], true, "{}", r2);
        assert!(inner.join("model.json").exists());
        assert_eq!(rvc_list_at(&root)["models"].as_array().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(ext);
    }

    #[test]
    fn import_files_copies_and_detects_engine() {
        use super::{rvc_import_files_at, rvc_list_at};
        let root = tmpdir("import-files");
        let src = tmpdir("import-files-src");
        std::fs::write(src.join("m.pth"), b"pth").unwrap();
        std::fs::write(src.join("m.index"), b"idx").unwrap();
        let files = serde_json::json!({ "model": src.join("m.pth").to_str().unwrap(), "index": src.join("m.index").to_str().unwrap() });
        let r = rvc_import_files_at(&root, &files, &serde_json::json!({ "name": "Files Model" }));
        assert_eq!(r["ok"], true, "{}", r);
        assert_eq!(r["model"]["name"], "Files Model");
        let dir = std::path::PathBuf::from(r["model"]["dir"].as_str().unwrap());
        assert!(dir.join("m.pth").exists() && dir.join("m.index").exists());
        assert!(dir.join("model.json").exists());
        assert_eq!(rvc_list_at(&root)["models"][0]["ready"], true);
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(src);
    }

    #[test]
    fn list_and_remove_physical_model() {
        let root = tmpdir("list");
        let d = root.join("m1");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("w.pth"), b"12345").unwrap();
        std::fs::write(d.join("model.json"), serde_json::to_string(&serde_json::json!({ "id": "m1", "name": "Model One", "engine": "rvc", "files": { "model": "w.pth" } })).unwrap()).unwrap();
        let r = rvc_list_at(&root);
        assert_eq!(r["ok"], true, "{}", r);
        let models = r["models"].as_array().unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["id"], "m1");
        assert_eq!(models[0]["ready"], true);
        assert_eq!(models[0]["size"], 5);
        assert_eq!(rvc_remove_at(&root, "m1")["ok"], true);
        assert!(!d.exists());
        assert_eq!(rvc_list_at(&root)["models"].as_array().unwrap().len(), 0);
        assert_eq!(rvc_remove_at(&root, "nope")["ok"], false);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn list_external_index_and_remove_keeps_source() {
        let root = tmpdir("index");
        let outside = tmpdir("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("w.pth"), b"x").unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("index.json"), serde_json::to_string(&serde_json::json!({ "models": { "ext": { "id": "ext", "name": "External", "dir": outside.display().to_string(), "engine": "rvc", "files": { "model": "w.pth" } } } })).unwrap()).unwrap();
        let r = rvc_list_at(&root);
        let models = r["models"].as_array().unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["external"], true);
        assert_eq!(models[0]["ready"], true);
        assert_eq!(rvc_remove_at(&root, "ext")["ok"], true);
        assert!(outside.join("w.pth").exists(), "external files must remain");
        assert_eq!(rvc_list_at(&root)["models"].as_array().unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn missing_files_mark_not_ready() {
        let root = tmpdir("missing");
        let d = root.join("m1");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("model.json"), serde_json::to_string(&serde_json::json!({ "id": "m1", "engine": "rvc", "files": { "model": "absent.pth" } })).unwrap()).unwrap();
        let r = rvc_list_at(&root);
        assert_eq!(r["models"][0]["ready"], false);
        assert_eq!(r["models"][0]["missing"][0], "absent.pth");
        let _ = std::fs::remove_dir_all(root);
    }
}


#[cfg(test)]
mod rvc_zip_tests {
    use super::{rvc_import_zip_at, rvc_list_at};
    use std::io::Write as _;

    #[test]
    fn import_zip_flat_nested_and_invalid() {
        let root = std::env::temp_dir().join(format!("fufumidi-rvc-zip-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let mkzip = |name: &str, entries: &[(&str, &[u8])]| {
            let p = root.join(name);
            let f = std::fs::File::create(&p).unwrap();
            let mut z = zip::ZipWriter::new(f);
            let opt = zip::write::SimpleFileOptions::default();
            for (n, b) in entries { z.start_file(*n, opt).unwrap(); z.write_all(b).unwrap(); }
            z.finish().unwrap();
            p
        };
        let flat = mkzip("Flat.zip", &[("voice.pth", b"pth"), ("voice.index", b"idx")]);
        let r1 = rvc_import_zip_at(&root, &flat, &serde_json::json!({ "name": "Flat Model" }));
        assert_eq!(r1["ok"], true, "{}", r1);
        assert_eq!(r1["model"]["name"], "Flat Model");
        assert_eq!(r1["model"]["engine"], "rvc");
        let nested = mkzip("Nested.zip", &[("inner/sub/voice.pth", b"pth")]);
        let r2 = rvc_import_zip_at(&root, &nested, &serde_json::json!({}));
        assert_eq!(r2["ok"], true, "{}", r2);
        let listed = rvc_list_at(&root);
        assert_eq!(listed["models"].as_array().unwrap().len(), 2);
        assert!(listed["models"].as_array().unwrap().iter().all(|m| m["ready"] == true));
        let bad = mkzip("Bad.zip", &[("readme.txt", b"none")]);
        assert_eq!(rvc_import_zip_at(&root, &bad, &serde_json::json!({}))["ok"], false);
        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod rvc_catalog_tests {
    #[test]
    fn embedded_catalog_parses() {
        let v: serde_json::Value = serde_json::from_str(super::RVC_CATALOG_JSON).unwrap();
        assert!(v.get("models").and_then(|m| m.as_array()).map(|m| m.len()).unwrap_or(0) > 0);
        let r = super::rvc_catalog();
        assert_eq!(r["ok"], true);
        assert!(r["catalog"]["models"].as_array().unwrap().len() > 0);
    }
}

#[cfg(test)]
mod rvc_probe_tests {
    use super::{rvc_find_model, rvc_patch_model};
    #[test]
    fn find_and_patch_model() {
        let root = std::env::temp_dir().join(format!("fufumidi-probe-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let d = root.join("m1");
        std::fs::create_dir_all(&d).unwrap();
        let m = serde_json::json!({ "id": "m1", "engine": "rvc", "version": "", "sr": 0, "dir": d.display().to_string() });
        std::fs::write(d.join("model.json"), serde_json::to_string(&m).unwrap()).unwrap();
        let (found, physical) = rvc_find_model(&root, "m1").unwrap();
        assert!(physical);
        assert_eq!(found["id"], "m1");
        let (patched, patch) = rvc_patch_model(found, &serde_json::json!({ "version": "v2", "sr": 40000, "f0": false }));
        assert_eq!(patched["version"], "v2");
        assert_eq!(patched["sr"], 40000);
        assert_eq!(patch["f0"], false);
        assert!(rvc_find_model(&root, "nope").is_none());
        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod pending_open_tests {
    #[test]
    fn picks_only_existing_midi_args() {
        let dir = std::env::temp_dir().join(format!("fufumidi-open-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        let mid = dir.join("song.MID");
        std::fs::write(&mid, b"mid").unwrap();
        let txt = dir.join("note.txt");
        std::fs::write(&txt, b"x").unwrap();
        let args = vec!["fufumidi-shell.exe".to_string(), "--flag".to_string(), txt.display().to_string(), mid.display().to_string()];
        let picked = super::pending_open_from_args(args).unwrap();
        assert_eq!(picked, mid);
        assert!(super::pending_open_from_args(vec!["exe".to_string(), dir.join("missing.mid").display().to_string()]).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod single_instance_tests {
    use std::io::BufRead as _;
    #[test]
    fn forwards_path_and_focus_to_listener() {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let mut r = std::io::BufReader::new(s);
            let mut line = String::new();
            r.read_line(&mut line).unwrap();
            line.trim().to_string()
        });
        assert!(super::single_instance_forward_at(port, Some(std::path::Path::new("C:/x/a.mid"))));
        assert_eq!(h.join().unwrap(), "C:/x/a.mid");
        let l2 = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port2 = l2.local_addr().unwrap().port();
        let h2 = std::thread::spawn(move || {
            let (s, _) = l2.accept().unwrap();
            let mut r = std::io::BufReader::new(s);
            let mut line = String::new();
            r.read_line(&mut line).unwrap();
            line.trim().to_string()
        });
        assert!(super::single_instance_forward_at(port2, None));
        assert_eq!(h2.join().unwrap(), "__FOCUS__");
    }
}

#[cfg(test)]
mod rvc_catalog_api_tests {
    #[test]
    fn parses_modelscope_file_tree() {
        let body = r#"{"Data":{"Files":[
            {"Type":"blob","Path":"40k/作品/中文/角色/voice.pth","Size":123},
            {"Type":"blob","Path":"40k/作品/中文/角色/voice.index","Size":4},
            {"Type":"tree","Path":"40k/作品/中文/角色"}
        ]}}"#;
        let v = super::rvc_catalog_from_api(body).unwrap();
        let m = &v["models"][0];
        assert_eq!(m["engine"], "rvc");
        assert_eq!(m["name"], "角色");
        assert_eq!(m["sr"], 40000);
        assert_eq!(m["index"], "40k/作品/中文/角色/voice.index");
        assert!(super::rvc_catalog_from_api("{}").is_err());
    }
}

#[cfg(test)]
mod plugin_catalog_tests {
    #[test]
    fn parses_manifest_and_platform_defaults() {
        let v = super::plugin_catalog_from_json(r#"{"channel":"beta","generatedAt":"x","plugins":[{"id":"p"}]}"#, "stable", "http://x");
        assert_eq!(v["ok"], true);
        assert_eq!(v["channel"], "beta");
        assert_eq!(v["plugins"][0]["id"], "p");
        assert_eq!(super::plugin_catalog_from_json("{}", "stable", "u")["plugins"].as_array().unwrap().len(), 0);
        assert!(super::plugin_platform_base().starts_with("http"));
    }
}

#[cfg(test)]
mod plugin_platform_tests {
    #[test]
    fn relative_paths_only() {
        assert_eq!(super::plugin_platform_rel(Some("/store")), "/store");
        assert_eq!(super::plugin_platform_rel(Some("store")), "/store");
        assert_eq!(super::plugin_platform_rel(Some("https://evil.example")), "/https://evil.example");
        assert_eq!(super::plugin_platform_rel(Some("/a b")), "/");
        assert_eq!(super::plugin_platform_rel(None), "/");
    }
}

#[cfg(test)]
mod plugin_install_tests {
    use std::io::Write as _;

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("fufumidi-plugin-{tag}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn mkzip(path: &std::path::Path, entries: &[(&str, &[u8])]) {
        let f = std::fs::File::create(path).unwrap();
        let mut z = zip::ZipWriter::new(f);
        let opt = zip::write::SimpleFileOptions::default();
        for (n, b) in entries { z.start_file(*n, opt).unwrap(); z.write_all(b).unwrap(); }
        z.finish().unwrap();
    }

    #[test]
    fn inspect_valid_and_traversal() {
        let root = tmpdir("inspect");
        let plugins = root.join("plugins"); std::fs::create_dir_all(&plugins).unwrap();
        let z = root.join("good.zip");
        mkzip(&z, &[
            ("pkg/plugin.json", br#"{"id":"demo-plugin","name":"Demo","version":"1.2.3"}"#),
            ("pkg/index.js", b"module.exports=1"),
        ]);
        let info = super::plugin_inspect_zip(&z, &plugins).unwrap();
        assert_eq!(info["id"], "demo-plugin");
        assert_eq!(info["prefix"], "pkg/");
        assert_eq!(info["targetDirName"], "pkg");
        assert_eq!(info["manifest"]["version"], "1.2.3");
        assert!(info["files"].as_array().unwrap().iter().any(|f| f["path"] == "index.js"));
        let bad = root.join("bad.zip");
        mkzip(&bad, &[("plugin.json", br#"{"id":"x-plugin"}"#), ("../evil", b"x")]);
        assert!(super::plugin_inspect_zip(&bad, &plugins).is_err());
        assert!(super::plugin_zip_entry_unsafe("C:/evil.js"));
        assert!(super::plugin_zip_entry_unsafe("//server/share/x"));
        assert!(super::plugin_zip_entry_unsafe("../x"));
        assert!(!super::plugin_zip_entry_unsafe("pkg/index.js"));
        let _ = std::fs::remove_dir_all(root);
    }
}


#[cfg(test)]
mod plugin_confirm_tests {
    use std::io::Write as _;

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("fufumidi-plugin-confirm-{tag}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn mkzip(path: &std::path::Path, entries: &[(&str, &[u8])]) {
        let f = std::fs::File::create(path).unwrap();
        let mut z = zip::ZipWriter::new(f);
        let opt = zip::write::SimpleFileOptions::default();
        for (n, b) in entries { z.start_file(*n, opt).unwrap(); z.write_all(b).unwrap(); }
        z.finish().unwrap();
    }

    #[test]
    fn extracts_and_restores_on_failure() {
        let root = tmpdir("confirm");
        let plugins = root.join("plugins");
        let z = root.join("v1.zip");
        mkzip(&z, &[
            ("pkg/plugin.json", br#"{"id":"demo-plugin","name":"Demo","version":"1.0.0"}"#),
            ("pkg/index.js", b"old"),
            ("pkg/sub/a.txt", b"a"),
        ]);
        let r = super::plugins_confirm_install_at(&z, &plugins, "test-token", false).unwrap();
        assert_eq!(r["id"], "demo-plugin");
        let dir = plugins.join("pkg");
        assert_eq!(std::fs::read(dir.join("index.js")).unwrap(), b"old");
        assert!(dir.join("sub/a.txt").is_file());

        let z2 = root.join("v2.zip");
        mkzip(&z2, &[
            ("pkg/plugin.json", br#"{"id":"demo-plugin","name":"Demo","version":"2.0.0"}"#),
            ("pkg/index.js", b"new"),
        ]);
        assert!(super::plugins_confirm_install_at(&z2, &plugins, "test-token", false).is_err());
        assert_eq!(std::fs::read(dir.join("index.js")).unwrap(), b"old");
        super::plugins_confirm_install_at(&z2, &plugins, "test-token", true).unwrap();
        assert_eq!(std::fs::read(dir.join("index.js")).unwrap(), b"new");

        let bad = root.join("bad.zip");
        mkzip(&bad, &[("readme.txt", b"no manifest")]);
        assert!(super::plugins_confirm_install_at(&bad, &plugins, "test-token", true).is_err());
        assert_eq!(std::fs::read(dir.join("index.js")).unwrap(), b"new");
        let _ = std::fs::remove_dir_all(root);
    }
}


#[cfg(test)]
mod cover_args_tests {
    #[test]
    fn rejects_missing_and_builds_sep_args() {
        let dir = std::env::temp_dir().join(format!("fufumidi-cover-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(super::cover_args(&serde_json::json!({}), &dir).is_err());
        let audio = dir.join("a.wav"); std::fs::write(&audio, b"x").unwrap();
        let out = dir.join("out");
        let opts = serde_json::json!({ "audio": audio.display().to_string(), "outdir": out.display().to_string(), "singer": { "id": "m1" }, "sepMode": "off", "transpose": 2, "f0Method": "rmvpe" });
        let args = super::cover_args(&opts, &dir).unwrap();
        assert_eq!(args[0], "all");
        assert!(args.contains(&"--no-separate".to_string()));
        assert!(args.contains(&"--rvc-model".to_string()));
        assert!(args.contains(&"2".to_string()));
        let sep = serde_json::json!({ "audio": audio.display().to_string(), "outdir": out.display().to_string(), "singer": { "id": "m1" }, "sepModel": { "id": "htdemucs4_6stems" } });
        let models = dir.join("models");
        let sep_src = models.join("multi/htdemucs4_6stems");
        std::fs::create_dir_all(&sep_src).unwrap();
        std::fs::write(sep_src.join("model.safetensors"), b"x").unwrap();
        std::fs::write(sep_src.join("config.yaml"), b"y").unwrap();
        let sep_args = super::cover_args(&sep, &models).unwrap();
        assert!(sep_args.contains(&"--sep-model".to_string()));
        assert!(sep_args.contains(&"--sep-arch".to_string()));
        assert!(sep_args.contains(&"HTDemucs".to_string()));
        let unknown = serde_json::json!({ "audio": audio.display().to_string(), "outdir": out.display().to_string(), "singer": { "id": "m1" }, "sepModel": { "id": "nope" } });
        assert!(super::cover_args(&unknown, &models).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod cover_singers_tests {
    #[test]
    fn filters_rvc_and_counts_arch() {
        let models = vec![
            serde_json::json!({ "id": "a", "name": "A", "engine": "rvc", "ready": true, "dir": "/x", "sr": 40000, "version": "v2", "lang": "zh", "work": "w", "external": true }),
            serde_json::json!({ "id": "b", "name": "B", "engine": "ddsp", "ready": true }),
            serde_json::json!({ "id": "c", "name": "C", "engine": "rvc", "ready": false, "missing": ["m.pth"] }),
        ];
        let out = super::cover_singers_from_models(&models);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["id"], "a");
        assert_eq!(out[0]["arch"], "RVC · v2 · 40000");
        assert!(out[0]["note"].as_str().unwrap().contains("引用式"));
        assert!(out[1]["note"].as_str().unwrap().contains("m.pth"));
    }
}


#[cfg(test)]
mod separate_args_tests {
    #[test]
    fn builds_separate_args_and_rejects_unknown() {
        let root = std::env::temp_dir().join(format!("fufumidi-sep-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let models = root.join("models");
        let model = models.join("multi/htdemucs4_6stems");
        std::fs::create_dir_all(&model).unwrap();
        std::fs::write(model.join("model.safetensors"), b"x").unwrap();
        std::fs::write(model.join("config.yaml"), b"y").unwrap();
        let audio = root.join("a.wav"); std::fs::write(&audio, b"x").unwrap();
        let out = root.join("out");
        let opts = serde_json::json!({ "audio": audio.display().to_string(), "sep_model": "htdemucs4_6stems", "chunk_size": 44100, "stems": ["vocals", "other"], "format": "WAV" });
        let a = super::separate_args(&opts, &models, &out).unwrap();
        assert_eq!(a[0], "separate");
        assert!(a.contains(&"--model".to_string()));
        assert!(a.contains(&"--arch".to_string()));
        assert!(a.contains(&"HTDemucs".to_string()));
        assert!(a.contains(&"vocals,other".to_string()));
        assert!(a.contains(&"wav".to_string()));
        let bad = serde_json::json!({ "audio": audio.display().to_string(), "sep_model": "nope" });
        assert!(super::separate_args(&bad, &models, &out).is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod um_json_tests {
    #[test]
    fn parses_last_json_or_first_brace() {
        assert_eq!(super::parse_um_json("{\"ok\":true}").unwrap()["ok"], true);
        assert_eq!(super::parse_um_json("log line\n{\"ok\":false,\"code\":\"no_gpu\"}").unwrap()["code"], "no_gpu");
        assert!(super::parse_um_json("no json").is_none());
    }
}


#[cfg(test)]
mod data_root_pick_tests {
    fn mk(root: &std::path::Path, name: &str, with_data: bool) -> std::path::PathBuf {
        let d = root.join(name);
        std::fs::create_dir_all(d.join("models")).unwrap();
        if with_data { std::fs::write(d.join("models/model.onnx"), b"x").unwrap(); }
        d
    }
    #[test]
    fn honors_last_with_data_over_empty_user_and_preferred() {
        let root = std::env::temp_dir().join(format!("fufumidi-root-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let user = mk(&root, "appdata", false);
        let preferred = mk(&root, "portable", false);
        let last = mk(&root, "last", true);
        let picked = super::pick_data_root(None, Some(last.clone()), Some(preferred), &[], user);
        assert_eq!(picked, last);
        let explicit = mk(&root, "explicit", false);
        let picked2 = super::pick_data_root(Some(explicit.clone()), Some(last), None, &[], root.join("appdata"));
        assert_eq!(picked2, explicit);
        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod sep_yaml_tests {
    #[test]
    fn picks_config_by_model_stem() {
        let root = std::env::temp_dir().join(format!("fufumidi-yaml-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let cfg = root.join("_configs"); std::fs::create_dir_all(&cfg).unwrap();
        std::fs::write(cfg.join("config_htdemucs_6stems.yaml"), b"x").unwrap();
        std::fs::write(cfg.join("config_musdb18_htdemucs.yaml"), b"y").unwrap();
        let hit = super::pick_sep_yaml(&cfg, "HTDemucs4_6stems.th").unwrap();
        assert!(hit.file_name().unwrap().to_string_lossy().contains("6stems"));
        let _ = std::fs::remove_dir_all(root);
    }
}
