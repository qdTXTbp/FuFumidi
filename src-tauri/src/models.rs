// 模型服务：列表 / 删除 / 下载 —— 移植自 main/models.js（核心部分）
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

// 模型下载状态（进度/取消）
pub struct ModelState {
    pub cancels: Mutex<Vec<String>>,
    pub seq: AtomicU64,
}

impl Default for ModelState {
    fn default() -> Self {
        ModelState {
            cancels: Mutex::new(Vec::new()),
            seq: AtomicU64::new(0),
        }
    }
}

pub fn models_dir(app: &AppHandle) -> PathBuf {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("models");
        if p.exists() {
            return p;
        }
    }
    PathBuf::from("../models")
}

fn dir_size(p: &Path) -> u64 {
    let mut s = 0u64;
    if let Ok(entries) = fs::read_dir(p) {
        for e in entries.flatten() {
            let ep = e.path();
            if ep.is_dir() {
                s += dir_size(&ep);
            } else if let Ok(m) = fs::metadata(&ep) {
                s += m.len();
            }
        }
    }
    s
}

fn is_canceled(state: &ModelState, id: &str) -> bool {
    state.cancels.lock().unwrap().contains(&id.to_string())
}

// 模型注册表（与 Electron 保持一致）
struct ModelSpec {
    id: &'static str,
    name: &'static str,
    note: &'static str,
    dest: &'static str,
    url: Option<&'static str>,
    repo: Option<&'static str>,
    kind: &'static str, // "file" | "hf" | "ghsplit"
    size_key: Option<&'static str>,
    min_size: u64,
    gated: bool,
}

const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "piano_transcription",
        name: "钢琴转录模型",
        note: "piano-transcription CRNN（含踏板检测）· 约 166 MB",
        dest: "piano_transcription/note_F1=0.9677_pedal_F1=0.9186.pth",
        url: Some("https://zenodo.org/record/4034264/files/CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth?download=1"),
        repo: None,
        kind: "file",
        size_key: None,
        min_size: 160_000_000,
        gated: false,
    },
    ModelSpec {
        id: "muscriptor_small",
        name: "MuScriptor Small",
        note: "多乐器转录 · 103M 参数 · 约 400 MB · 需 HF 授权",
        dest: "muscriptor/small",
        url: None,
        repo: Some("monologue82/Models"),
        kind: "ghsplit",
        size_key: Some("small"),
        min_size: 50_000_000,
        gated: true,
    },
    ModelSpec {
        id: "muscriptor_medium",
        name: "MuScriptor Medium",
        note: "多乐器转录 · 307M 参数（推荐）· 约 1.2 GB · 需 HF 授权",
        dest: "muscriptor/medium",
        url: None,
        repo: Some("monologue82/Models"),
        kind: "ghsplit",
        size_key: Some("medium"),
        min_size: 200_000_000,
        gated: true,
    },
    ModelSpec {
        id: "muscriptor_large",
        name: "MuScriptor Large",
        note: "多乐器转录 · 1.4B 参数 · 约 5.2 GB · 需 HF 授权",
        dest: "muscriptor/large",
        url: None,
        repo: Some("monologue82/Models"),
        kind: "ghsplit",
        size_key: Some("large"),
        min_size: 900_000_000,
        gated: true,
    },
    ModelSpec {
        id: "aria_amt",
        name: "Aria-AMT 钢琴",
        note: "EleutherAI · 钢琴转录（Apache-2.0）· 约 680 MB",
        dest: "aria_amt",
        url: None,
        repo: Some("AEmotionStudio/aria-amt-models"),
        kind: "hf",
        size_key: None,
        min_size: 100_000_000,
        gated: false,
    },
];

fn find_spec(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id)
}

// 模型列表
#[tauri::command]
pub fn model_list(app: AppHandle) -> Vec<Value> {
    let dir = models_dir(&app);
    let mut items: Vec<Value> = Vec::new();

    // 内置 basic-pitch
    let bp = dir.join("basic_pitch_quant.onnx");
    let (bp_exists, bp_size) = file_info(&bp);
    items.push(json!({
        "name": "通用转录（int8 量化）",
        "path": bp.to_string_lossy(),
        "size": bp_size,
        "exists": bp_exists,
        "note": "basic-pitch ONNX int8 量化模型（CPU 加速）"
    }));

    // 注册表模型
    for m in MODELS {
        let dest = dir.join(m.dest);
        let exists = dest.exists();
        let size = if dest.is_dir() { dir_size(&dest) } else { file_info(&dest).1 };
        items.push(json!({
            "id": m.id,
            "name": m.name,
            "path": dest.to_string_lossy(),
            "size": size,
            "exists": exists && size >= m.min_size,
            "downloadable": true,
            "note": m.note,
            "type": m.kind,
            "repo": m.repo,
            "gated": m.gated,
        }));
    }
    items
}

fn file_info(p: &Path) -> (bool, u64) {
    match fs::metadata(p) {
        Ok(m) if m.is_file() => (true, m.len()),
        _ => (false, 0),
    }
}

// 删除模型
#[tauri::command]
pub fn model_delete(app: AppHandle, id: String) -> Value {
    let dir = models_dir(&app);
    let p = match find_spec(&id) {
        Some(m) => dir.join(m.dest),
        None => return json!({ "ok": false, "error": "not found" }),
    };
    if !p.exists() {
        return json!({ "ok": false, "error": "not found" });
    }
    let r = if p.is_dir() {
        fs::remove_dir_all(&p)
    } else {
        fs::remove_file(&p)
    };
    match r {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

// 取消下载
#[tauri::command]
pub fn model_cancel(state: tauri::State<'_, ModelState>, id: String) -> Value {
    state.cancels.lock().unwrap().push(id);
    json!({ "ok": true })
}

// 暂停下载（Tauri 阶段为占位：标记取消同名任务）
#[tauri::command]
pub fn model_pause(state: tauri::State<'_, ModelState>, id: String) -> Value {
    state.cancels.lock().unwrap().push(id);
    json!({ "ok": true, "paused": false })
}

#[derive(Deserialize)]
pub struct DownloadOpts {
    id: String,
    channel: Option<String>,
}

// 下载模型（单文件 / 分卷 / HF 整仓 —— 核心实现）
#[tauri::command]
pub fn model_download(app: AppHandle, state: tauri::State<'_, ModelState>, req: DownloadOpts) -> Value {
    let spec = match find_spec(&req.id) {
        Some(s) => s,
        None => return json!({ "ok": false, "error": "未知模型" }),
    };
    let dir = models_dir(&app);
    let dest = dir.join(spec.dest);
    if let Some(parent) = dest.parent() {
        let _ = fs::create_dir_all(parent);
    }

    // 进度事件回调
    let emit_p = |app: &AppHandle, id: &str, received: u64, total: u64, percent: u8, done: bool| {
        let _ = app.emit(
            "model:progress",
            json!({ "id": id, "received": received, "total": total, "percent": percent, "done": done }),
        );
    };

    // 单文件下载（zenodo + 镜像回退）
    if spec.kind == "file" {
        let url = spec.url.unwrap_or("");
        let out_file = &dest;
        return download_file_retry(&app, &state, spec.id, url, out_file, spec.min_size, &emit_p);
    }

    // ghsplit：monologue82/Models 分卷（MuScriptor）
    if spec.kind == "ghsplit" {
        let repo = spec.repo.unwrap_or("monologue82/Models");
        let size_key = spec.size_key.unwrap_or("");
        return download_ghsplit(&app, &state, spec, repo, size_key, &dest, &emit_p);
    }

    // hf：HuggingFace 整仓（Aria-AMT 等）
    let repo = spec.repo.unwrap_or("");
    json!({ "ok": false, "error": format!("HF 整仓下载（{}）尚未移植，请先使用 Electron 版", repo) })
}

// 单文件下载：多个镜像回退
fn download_file_retry(
    app: &AppHandle,
    state: &tauri::State<'_, ModelState>,
    id: &str,
    url: &str,
    out_file: &Path,
    min_size: u64,
    emit_p: &dyn Fn(&AppHandle, &str, u64, u64, u8, bool),
) -> Value {
    let mirrors = [
        url.to_string(),
        format!("https://ghfast.top/{}", url),
        format!("https://gh-proxy.com/{}", url),
        format!("https://ghproxy.net/{}", url),
    ];
    let tmp = out_file.with_extension("part");
    for u in &mirrors {
        if is_canceled(state, id) {
            let _ = fs::remove_file(&tmp);
            return json!({ "ok": false, "error": "canceled" });
        }
        match fetch_to_file(u, &tmp, |recv, total| {
            let pct = if total > 0 { ((recv as f64 / total as f64) * 99.0) as u8 } else { 0 };
            emit_p(app, id, recv, total, pct, false);
        }) {
            Ok(()) => {
                let size = fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
                if size < min_size {
                    let _ = fs::remove_file(&tmp);
                    return json!({ "ok": false, "error": format!("下载文件不完整：{} bytes", size) });
                }
                // 改名到正式文件
                if out_file.exists() {
                    let _ = fs::remove_file(out_file);
                }
                if fs::rename(&tmp, out_file).is_ok() {
                    emit_p(app, id, size, size, 100, true);
                    return json!({ "ok": true, "path": out_file.to_string_lossy(), "size": size });
                }
                return json!({ "ok": false, "error": "文件改名失败" });
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                // 继续尝试下一个镜像
                let _ = e;
            }
        }
    }
    json!({ "ok": false, "error": "所有镜像下载失败" })
}

// 分卷下载（monologue82/Models，100MB part 合并 + manifest）
fn download_ghsplit(
    app: &AppHandle,
    state: &tauri::State<'_, ModelState>,
    spec: &ModelSpec,
    repo: &str,
    size_key: &str,
    dest_dir: &Path,
    emit_p: &dyn Fn(&AppHandle, &str, u64, u64, u8, bool),
) -> Value {
    let base = format!("main/muscriptor/{}", size_key);
    let hosts = [
        "https://gh.jasonzeng.dev/https://raw.githubusercontent.com".to_string(),
        "https://raw.githubusercontent.com".to_string(),
        "https://ghfast.top/https://raw.githubusercontent.com".to_string(),
        "https://gh-proxy.com/https://raw.githubusercontent.com".to_string(),
    ];

    // 1) manifest.json
    let mut manifest: Option<Value> = None;
    for h in &hosts {
        let url = format!("{}/{}/main/manifest.json", h, repo);
        if let Ok(body) = http_get(&url) {
            if let Ok(v) = serde_json::from_str::<Value>(&body) {
                manifest = Some(v);
                break;
            }
        }
    }
    let manifest = match manifest {
        Some(m) => m,
        None => return json!({ "ok": false, "error": "分卷清单获取失败：请确认 Models 仓库已发布 " }),
    };
    let meta = &manifest["muscriptor"][size_key];
    let parts = meta["parts"].as_u64().unwrap_or(0);
    let total = meta["size"].as_u64().unwrap_or(0);
    let model_file = meta["model"].as_str().unwrap_or("model.safetensors");
    if parts == 0 {
        return json!({ "ok": false, "error": "manifest 缺少 parts" });
    }

    let _ = fs::create_dir_all(dest_dir);
    let out_file = dest_dir.join(model_file);
    let tmp = out_file.with_extension("part");
    let mut received: u64 = 0;

    for i in 1..=parts {
        if is_canceled(state, spec.id) {
            let _ = fs::remove_file(&tmp);
            return json!({ "ok": false, "error": "canceled" });
        }
        let part_name = format!("{}.part{:02}", model_file, i);
        let mut ok = false;
        for h in &hosts {
            let url = format!("{}/{}/{}/{}", h, repo, base, part_name);
            match fetch_to_file(&url, &tmp, |_, _| {}) {
                Ok(()) => {
                    // 追加到 out_file
                    if let Ok(bytes) = fs::read(&tmp) {
                        use std::io::Write;
                        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&out_file) {
                            let _ = f.write_all(&bytes);
                            received += bytes.len() as u64;
                        }
                    }
                    let _ = fs::remove_file(&tmp);
                    ok = true;
                    break;
                }
                Err(_) => {
                    let _ = fs::remove_file(&tmp);
                }
            }
        }
        if !ok {
            return json!({ "ok": false, "error": format!("下载分卷失败：{}", part_name) });
        }
        let pct = if total > 0 { ((received as f64 / total as f64) * 99.0) as u8 } else { 0 };
        emit_p(app, spec.id, received, total, pct, false);
    }

    let size = fs::metadata(&out_file).map(|m| m.len()).unwrap_or(0);
    if size < spec.min_size {
        let _ = fs::remove_file(&out_file);
        return json!({ "ok": false, "error": format!("下载文件不完整：{} bytes", size) });
    }
    emit_p(app, spec.id, size, size, 100, true);
    json!({ "ok": true, "path": dest_dir.to_string_lossy(), "size": size })
}

// HTTP GET（简单实现，支持重定向）
fn http_get(url: &str) -> Result<String, String> {
    let resp = ureq_get(url)?;
    Ok(resp)
}

fn ureq_get(url: &str) -> Result<String, String> {
    // 用 PowerShell curl 做兜底，避免引入 ureq 依赖
    // 简化：使用 std process curl
    let out = std::process::Command::new("curl.exe")
        .args(["--ssl-no-revoke", "-sS", "-L", "-m", "30", url])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

// 流式下载到文件（带进度回调）
fn fetch_to_file(
    url: &str,
    dest: &Path,
    on_progress: impl Fn(u64, u64),
) -> Result<(), String> {
    let out = std::process::Command::new("curl.exe")
        .args(["--ssl-no-revoke", "-sS", "-L", "-o"])
        .arg(dest.to_string_lossy().to_string())
        .arg(url)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        let size = fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
        on_progress(size, size);
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}
