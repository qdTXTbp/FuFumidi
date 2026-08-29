// 动态壁纸服务：桌面视频发现 / GitHub 壁纸库 / 本地导入删除 / 下载 —— 移植自 main/wallpaper.js
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

const WALLPAPER_REPO: &str = "monologue82/Media";
const WALLPAPER_DIR: &str = "wallpapers";
const WALLPAPER_API: &str = "https://api.github.com/repos/monologue82/Media/contents/wallpapers";
const WALLPAPER_MEDIA: &str = "https://media.githubusercontent.com/media/monologue82/Media/main/wallpapers";
const WALLPAPER_RAW: &str = "https://raw.githubusercontent.com/monologue82/Media/main/wallpapers";

fn http_get(url: &str) -> Result<String, String> {
    let out = std::process::Command::new("curl.exe")
        .args(["--ssl-no-revoke", "-sS", "-L", "-m", "20", "-H", "User-Agent: FuFumidi", url])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

fn http_download(url: &str, dest: &Path) -> Result<(), String> {
    let out = std::process::Command::new("curl.exe")
        .args(["--ssl-no-revoke", "-sS", "-L", "-o"])
        .arg(dest.to_string_lossy().to_string())
        .arg(url)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

fn wallpaper_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("wallpapers")
}

fn is_video(name: &str) -> bool {
    let n = name.to_lowercase();
    n.ends_with(".mp4") || n.ends_with(".webm") || n.ends_with(".mov")
}

// 发现桌面上的视频文件（最多 4 个）
#[tauri::command]
pub fn wallpaper_defaults(app: AppHandle) -> Value {
    let mut out: Vec<String> = Vec::new();
    if let Ok(desktop) = app.path().desktop_dir() {
        if let Ok(entries) = fs::read_dir(&desktop) {
            let mut files: Vec<String> = entries
                .flatten()
                .filter(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    is_video(&name)
                })
                .map(|e| e.path().to_string_lossy().to_string())
                .collect();
            files.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
            out = files.into_iter().take(4).collect();
        }
    }
    json!({ "ok": true, "files": out })
}

// 本地已下载壁纸列表
fn list_local(app: &AppHandle) -> Vec<Value> {
    let dir = wallpaper_dir(app);
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            // 只列「完整下载」的壁纸：视频 + .ok 标记 + 非 0 字节
            if !is_video(name) || name.ends_with(".part") {
                continue;
            }
            if !p.with_extension("ok").exists() {
                continue;
            }
            let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            if size <= 0 {
                continue;
            }
            out.push(json!({ "name": name, "video": p.to_string_lossy(), "thumb": "", "local": true }));
        }
    }
    out.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    out
}

// 壁纸库列表（GitHub 远程 + 本地合并）
#[tauri::command]
pub fn wallpaper_list(app: AppHandle) -> Value {
    let body = match http_get(WALLPAPER_API) {
        Ok(b) => b,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let items: Vec<Value> = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return json!({ "ok": false, "error": "GitHub API 解析失败" }),
    };
    let mut vids: Vec<Value> = Vec::new();
    let mut thumbs: Vec<Value> = Vec::new();
    for it in &items {
        if let Some(n) = it["name"].as_str() {
            if it["type"].as_str() == Some("file") {
                if is_video(n) {
                    vids.push(it.clone());
                } else if n.ends_with(".jpg") || n.ends_with(".jpeg") || n.ends_with(".png") {
                    thumbs.push(it.clone());
                }
            }
        }
    }
    let mut list: Vec<Value> = Vec::new();
    for v in &vids {
        let name = v["name"].as_str().unwrap_or("").to_string();
        let base = name.trim_end_matches(".mp4").trim_end_matches(".webm").trim_end_matches(".mov");
        let mut thumb = String::new();
        for t in &thumbs {
            let tn = t["name"].as_str().unwrap_or("");
            let tb = tn.trim_end_matches(".jpg").trim_end_matches(".jpeg").trim_end_matches(".png");
            if tb == base {
                thumb = format!("{}/{}", WALLPAPER_RAW, tn);
                break;
            }
        }
        list.push(json!({
            "name": name,
            "video": format!("{}/{}", WALLPAPER_MEDIA, name),
            "remote": format!("{}/{}", WALLPAPER_MEDIA, name),
            "thumb": thumb,
        }));
    }
    // 合并本地
    let locals = list_local(&app);
    let local_names: Vec<String> = locals.iter().filter_map(|l| l["name"].as_str().map(|s| s.to_lowercase())).collect();
    for l in &locals {
        let ln = l["name"].as_str().unwrap_or("").to_lowercase();
        if let Some(r) = list.iter_mut().find(|r| {
            r["name"].as_str().unwrap_or("").to_lowercase().replace(".mp4", "").replace(".webm", "").replace(".mov", "") == ln.replace(".mp4", "").replace(".webm", "").replace(".mov", "")
        }) {
            *r = l.clone();
        } else if !local_names.iter().any(|n| {
            n.replace(".mp4", "").replace(".webm", "").replace(".mov", "") == ln.replace(".mp4", "").replace(".webm", "").replace(".mov", "") && n != &ln
        }) {
            // 本地独有（自行导入）
            list.push(l.clone());
        }
    }
    json!({ "ok": true, "list": list })
}

// 删除本地壁纸
#[tauri::command]
pub fn wallpaper_remove_local(app: AppHandle, name: String) -> Value {
    let dir = wallpaper_dir(&app);
    let base = Path::new(&name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    if base.is_empty() {
        return json!({ "ok": false, "error": "invalid name" });
    }
    let video = dir.join(&base);
    if !video.exists() {
        return json!({ "ok": false, "error": "not found" });
    }
    let _ = fs::remove_file(&video);
    let _ = fs::remove_file(dir.join(format!("{}.ok", base)));
    let stem = base.trim_end_matches(".mp4").trim_end_matches(".webm").trim_end_matches(".mov");
    let _ = fs::remove_file(dir.join(format!("{}.jpg", stem)));
    json!({ "ok": true })
}

// 本地壁纸导入：复制到 userData/wallpapers
#[tauri::command]
pub async fn wallpaper_add_local(app: AppHandle, src_path: String) -> Value {
    let src = PathBuf::from(&src_path);
    if !src.exists() || !src.is_file() {
        return json!({ "ok": false, "error": "本地文件不存在" });
    }
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !["mp4", "webm", "mov"].contains(&ext.as_str()) {
        return json!({ "ok": false, "error": "不支持的视频格式" });
    }
    let dir = wallpaper_dir(&app);
    let _ = fs::create_dir_all(&dir);
    let raw_name = src.file_name().and_then(|n| n.to_str()).unwrap_or("local-wallpaper.mp4").to_string();
    let safe = raw_name.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");
    let mut dest = dir.join(&safe);
    let mut n = 1usize;
    let (stem, extname) = match safe.rfind('.') {
        Some(i) => (safe[..i].to_string(), safe[i..].to_string()),
        None => (safe.clone(), String::new()),
    };
    while dest.exists() && dest != src {
        dest = dir.join(format!("{}-{}{}", stem, n, extname));
        n += 1;
    }
    let total = fs::metadata(&src).map(|m| m.len()).unwrap_or(0);
    let _ = app.emit("wallpaper:addLocalProgress", json!({ "path": dest.to_string_lossy(), "progress": 0 }));
    match fs::copy(&src, &dest) {
        Ok(_) => {
            let _ = app.emit("wallpaper:addLocalProgress", json!({ "path": dest.to_string_lossy(), "progress": 1 }));
            let _ = fs::write(dest.with_extension("ok"), "1");
            json!({ "ok": true, "path": dest.to_string_lossy(), "name": dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), "size": total })
        }
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

// 壁纸下载：curl 下载 → 改名 + .ok 标记
#[tauri::command]
pub async fn wallpaper_download(app: AppHandle, url: String, name: Option<String>) -> Value {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return json!({ "ok": false, "error": "无效 URL" });
    }
    let dir = wallpaper_dir(&app);
    let _ = fs::create_dir_all(&dir);
    let raw = name.unwrap_or_else(|| "wallpaper.mp4".into());
    let safe = raw.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");
    let dest = dir.join(&safe);
    let tmp = dir.join(format!("{}.part", safe));
    let _ = app.emit("wallpaper:downloadProgress", json!({ "name": safe, "progress": 0 }));
    match http_download(&url, &tmp) {
        Ok(()) => {
            let size = fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
            if size <= 0 {
                let _ = fs::remove_file(&tmp);
                return json!({ "ok": false, "error": "下载文件为空（网络受限或文件被拦截），已回退在线壁纸" });
            }
            if dest.exists() {
                let _ = fs::remove_file(&dest);
            }
            if fs::rename(&tmp, &dest).is_ok() {
                let _ = fs::write(dest.with_extension("ok"), "1");
                let _ = app.emit("wallpaper:downloadProgress", json!({ "name": safe, "progress": 1 }));
                json!({ "ok": true, "path": dest.to_string_lossy(), "name": safe, "size": size })
            } else {
                json!({ "ok": false, "error": "文件改名失败" })
            }
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            json!({ "ok": false, "error": e })
        }
    }
}
