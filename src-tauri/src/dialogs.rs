// 文件对话框 / 目录扫描 / 二进制读写 —— 移植自 main/dialogs.js
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const AUDIO_EXTS: &[&str] = &[
    "mp3", "wav", "flac", "m4a", "aac", "ogg", "oga", "opus", "wma", "mp4", "mkv", "avi", "mov",
    "webm", "aiff", "aif", "au", "snd", "caf", "m4v", "m4s", "ts", "mpg", "mpeg", "flv", "3gp",
    "amr", "mka",
];
const MIDI_EXTS: &[&str] = &["mid", "midi", "kar", "rmi"];

fn has_ext(p: &Path, exts: &[&str]) -> bool {
    match p.extension().and_then(|e| e.to_str()) {
        Some(e) => exts.contains(&e.to_lowercase().as_str()),
        None => false,
    }
}

fn walk(dir: &Path, exts: &[&str], out: &mut Vec<String>, depth: usize) {
    if out.len() >= 2000 || depth > 8 {
        return;
    }
    let items = match fs::read_dir(dir) {
        Ok(i) => i,
        Err(_) => return,
    };
    for it in items.flatten() {
        if out.len() >= 2000 {
            return;
        }
        let p = it.path();
        if p.is_dir() {
            walk(&p, exts, out, depth + 1);
        } else if p.is_file() && has_ext(&p, exts) {
            out.push(p.to_string_lossy().to_string());
        }
    }
}

// ---- 对话框命令（使用 tauri-plugin-dialog，父窗口为当前主窗口）----

#[tauri::command]
pub async fn pick_audio(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Option<String> {
    let file = window
        .dialog()
        .file()
        .add_filter("音频 / 视频", AUDIO_EXTS)
        .blocking_pick_file();
    file.and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn pick_audio_files(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Vec<String> {
    let files = window
        .dialog()
        .file()
        .add_filter("音频 / 视频", AUDIO_EXTS)
        .blocking_pick_files();
    files
        .into_iter()
        .flatten()
        .filter_map(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
        .collect()
}

#[tauri::command]
pub async fn list_audio_files(dir: String) -> Vec<String> {
    let mut out = Vec::new();
    walk(Path::new(&dir), AUDIO_EXTS, &mut out, 0);
    out.sort();
    out
}

#[tauri::command]
pub async fn pick_image(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Option<String> {
    let file = window
        .dialog()
        .file()
        .add_filter("图片", &["png", "jpg", "jpeg", "bmp", "webp", "gif"])
        .blocking_pick_file();
    file.and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().to_string())
}

#[derive(Deserialize)]
pub struct PickFileOpts {
    filters: Option<Vec<FileFilterOpts>>,
}
#[derive(Deserialize)]
pub struct FileFilterOpts {
    name: Option<String>,
    extensions: Option<Vec<String>>,
}

#[tauri::command]
pub async fn pick_file(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    opts: Option<PickFileOpts>,
) -> Option<String> {
    let mut dlg = window.dialog().file();
    if let Some(o) = opts {
        if let Some(fs) = o.filters {
            for f in fs {
                let exts: Vec<String> = f
                    .extensions
                    .unwrap_or_default()
                    .iter()
                    .map(|s| s.clone())
                    .collect();
                let exts_ref: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
                dlg = dlg.add_filter(f.name.unwrap_or_else(|| "文件".into()), &exts_ref);
            }
        }
    }
    let file = dlg.blocking_pick_file();
    file.and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn pick_directory(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Option<String> {
    let dir = window.dialog().file().blocking_pick_folder();
    dir.and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn soundfont_list(app: tauri::AppHandle) -> Vec<Value> {
    // 打包后 soundfonts 位于 resources/renderer/vendor/soundfonts
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        roots.push(res.join("renderer").join("vendor").join("soundfonts"));
    }
    let mut out = Vec::new();
    for dir in roots {
        if let Ok(entries) = fs::read_dir(&dir) {
            for e in entries.flatten() {
                let p = e.path();
                let name = p
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                if name.ends_with(".sf2") || name.ends_with(".sf3") {
                    let id = name
                        .trim_end_matches(".sf2")
                        .trim_end_matches(".sf3")
                        .to_string();
                    out.push(json!({ "id": name, "name": id, "path": p.to_string_lossy() }));
                }
            }
        }
    }
    out
}

#[tauri::command]
pub async fn pick_music_xml(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Option<String> {
    let file = window
        .dialog()
        .file()
        .add_filter("MusicXML", &["xml", "musicxml", "mxl"])
        .blocking_pick_file();
    file.and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn list_midi_files(dir: String) -> Vec<String> {
    let mut out = Vec::new();
    walk(Path::new(&dir), MIDI_EXTS, &mut out, 0);
    out.sort();
    out
}

// 读取二进制（上限 64MB）
#[tauri::command]
pub async fn read_binary(p: String) -> Option<Vec<u8>> {
    let meta = fs::metadata(&p).ok()?;
    if !meta.is_file() || meta.len() > 64 * 1024 * 1024 {
        return None;
    }
    fs::read(&p).ok()
}

// 读取 SoundFont（上限 512MB）
#[tauri::command]
pub async fn read_soundfont(p: String) -> Option<Vec<u8>> {
    let meta = fs::metadata(&p).ok()?;
    if !meta.is_file() || meta.len() > 512 * 1024 * 1024 {
        return None;
    }
    fs::read(&p).ok()
}

#[derive(Deserialize)]
pub struct SaveBinaryOpts {
    name: Option<String>,
    data: Option<Vec<u8>>,
}

// 保存二进制（原生保存对话框 → 写盘）
#[tauri::command]
pub async fn save_binary(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    opts: Option<SaveBinaryOpts>,
) -> Value {
    let name = opts.as_ref().and_then(|o| o.name.clone()).unwrap_or_else(|| "download.bin".into());
    let ext = Path::new(&name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let filters: &[&str] = if ext == "wav" {
        &["wav"]
    } else if ext == "mid" || ext == "midi" {
        &["mid", "midi"]
    } else {
        &[]
    };
    let mut dlg = window.dialog().file();
    if !filters.is_empty() {
        dlg = dlg.add_filter("保存文件", filters);
    }
    let saved = dlg.blocking_save_file();
    match saved {
        Some(file_path) => {
            let data = opts.and_then(|o| o.data).unwrap_or_default();
            if let Ok(p) = file_path.into_path() {
                if fs::write(&p, data).is_ok() {
                    return json!({ "ok": true, "path": p.to_string_lossy() });
                }
                return json!({ "ok": false, "error": "写入失败" });
            }
            json!({ "ok": false, "canceled": true })
        }
        None => json!({ "ok": false, "canceled": true }),
    }
}
