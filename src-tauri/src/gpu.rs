// GPU 增强包服务：状态 / 安装 / 卸载 / 下载 / 本地导入 —— 移植自 main/gpu.js + gpu-ipc.js
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

use crate::engine::{parse_py_json, run_inline_python};

fn gpu_root(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("fufumidi")
        .join("gpu-enhancements")
}
fn gpu_dir(app: &AppHandle, kind: &str) -> PathBuf {
    gpu_root(app).join(kind)
}

fn installed_kinds(app: &AppHandle) -> Vec<String> {
    ["cuda", "directml"]
        .iter()
        .filter(|k| {
            let d = gpu_dir(app, k);
            d.join("site-packages").exists() && d.join("manifest.json").exists()
        })
        .map(|k| k.to_string())
        .collect()
}

fn write_manifest(app: &AppHandle, kind: &str, meta: Value) {
    let dir = gpu_dir(app, kind);
    let _ = fs::create_dir_all(&dir);
    let manifest = json!({
        "kind": kind,
        "installedAt": now_iso(),
        "meta": meta,
    });
    if let Ok(s) = serde_json::to_string_pretty(&manifest) {
        let _ = fs::write(dir.join("manifest.json"), s);
    }
}

fn now_iso() -> String {
    // 简化 ISO 时间（本地）
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}", now)
}

// 原子安装：先复制到临时目录再 rename，避免半成品
fn install_site(app: &AppHandle, kind: &str, src_site: &Path, meta: Value) -> Result<(), String> {
    if !src_site.exists() {
        return Err("缺少 site-packages 目录".into());
    }
    let final_dir = gpu_dir(app, kind);
    let tmp_dir = final_dir.with_extension(format!("tmp-{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let tmp_site = tmp_dir.join("site-packages");
    fs::create_dir_all(&tmp_site).map_err(|e| e.to_string())?;
    // 复制目录内容
    for entry in fs::read_dir(src_site).map_err(|e| e.to_string())? {
        let e = entry.map_err(|e| e.to_string())?;
        let target = tmp_site.join(e.file_name());
        if e.path().is_dir() {
            copy_dir(&e.path(), &target)?;
        } else {
            fs::copy(&e.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    write_manifest(app, kind, meta);
    let _ = fs::remove_dir_all(&final_dir);
    fs::rename(&tmp_dir, &final_dir).map_err(|e| e.to_string())?;
    Ok(())
}

fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let e = entry.map_err(|e| e.to_string())?;
        let target = dst.join(e.file_name());
        if e.path().is_dir() {
            copy_dir(&e.path(), &target)?;
        } else {
            fs::copy(&e.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn is_split(p: &str) -> bool {
    let b = Path::new(p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    b.ends_with(".part") || b.contains(".part") || b.contains(".zip.")
}

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

// PowerShell 解压 zip
fn extract_zip(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let _ = fs::remove_dir_all(dest_dir);
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let ps = format!(
        "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
        zip_path.to_string_lossy(),
        dest_dir.to_string_lossy()
    );
    let st = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &ps])
        .status()
        .map_err(|e| e.to_string())?;
    if st.success() {
        Ok(())
    } else {
        Err("解压失败".into())
    }
}

fn infer_kind(name_or_url: &str) -> Option<String> {
    let t = name_or_url.to_lowercase();
    if t.contains("cuda") {
        Some("cuda".into())
    } else if t.contains("directml") || t.contains("dml") {
        Some("directml".into())
    } else {
        None
    }
}

fn valid_kind(k: &str) -> bool {
    k == "cuda" || k == "directml"
}

// ---------- 命令 ----------

#[tauri::command]
pub fn gpu_status(app: AppHandle) -> Value {
    let dirs = installed_kinds(&app);
    json!({
        "ok": true,
        "directml": dirs.contains(&"directml".to_string()),
        "cuda": dirs.contains(&"cuda".to_string()),
        "isolated": true,
        "paths": dirs,
    })
}

#[tauri::command]
pub fn gpu_uninstall(app: AppHandle, kind: String) -> Value {
    let k = kind.to_lowercase();
    if !valid_kind(&k) {
        return json!({ "ok": false, "error": "未知的增强包类型" });
    }
    let dir = gpu_dir(&app, &k);
    let existed = dir.exists();
    if existed {
        match fs::remove_dir_all(&dir) {
            Ok(_) => {}
            Err(e) => return json!({ "ok": false, "error": e.to_string() }),
        }
    }
    json!({ "ok": true, "removed": existed })
}

#[tauri::command]
pub fn gpu_list_packages(app: AppHandle) -> Value {
    let body = match http_get("https://api.github.com/repos/qdTXTbp/FuFumidi/releases?per_page=10") {
        Ok(b) => b,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let data: Vec<Value> = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return json!({ "ok": false, "error": "GitHub API 解析失败" }),
    };
    let mut out: Vec<Value> = Vec::new();
    for rel in &data {
        let assets = rel["assets"].as_array().cloned().unwrap_or_default();
        for a in &assets {
            let name = a["name"].as_str().unwrap_or("");
            let kind = infer_kind(name);
            if let Some(k) = kind {
                if name.starts_with("fufumidi-gpu-") && (name.ends_with(".zip") || is_split(name)) {
                    out.push(json!({
                        "tag": rel["tag_name"].as_str().unwrap_or(""),
                        "name": name,
                        "url": a["browser_download_url"].as_str().unwrap_or(""),
                        "size": a["size"].as_u64().unwrap_or(0),
                        "kind": k,
                    }));
                }
            }
        }
        // CUDA 分卷合并项
        let parts: Vec<&Value> = assets
            .iter()
            .filter(|a| {
                a["name"].as_str().map(|n| n.to_lowercase().starts_with("fufumidi-gpu-cuda")).unwrap_or(false)
                    && a["name"].as_str().map(is_split).unwrap_or(false)
            })
            .collect();
        if parts.len() > 1 {
            let mut sorted = parts.clone();
            sorted.sort_by_key(|a| a["name"].as_str().unwrap_or("").to_string());
            let total: u64 = sorted.iter().map(|a| a["size"].as_u64().unwrap_or(0)).sum();
            out.push(json!({
                "tag": rel["tag_name"].as_str().unwrap_or(""),
                "name": "fufumidi-gpu-cuda-parts (split)",
                "kind": "cuda",
                "split": true,
                "size": total,
                "url": sorted[0]["browser_download_url"].as_str().unwrap_or(""),
                "files": sorted.iter().map(|a| json!({ "name": a["name"], "url": a["browser_download_url"], "size": a["size"] })).collect::<Vec<_>>(),
            }));
        }
    }
    json!({ "ok": true, "packages": out })
}

#[tauri::command]
pub fn gpu_package_url(app: AppHandle, kind: String) -> Value {
    let suffix = if kind == "cuda" { "cuda" } else { "directml" };
    let body = match http_get("https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest") {
        Ok(b) => b,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let rel: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return json!({ "ok": false, "error": "GitHub API 解析失败" }),
    };
    let assets = rel["assets"].as_array().cloned().unwrap_or_default();
    for a in &assets {
        let name = a["name"].as_str().unwrap_or("");
        if name.to_lowercase().contains(&format!("gpu-{}", suffix)) && name.to_lowercase().ends_with(".zip") {
            return json!({
                "ok": true,
                "url": a["browser_download_url"].as_str().unwrap_or(""),
                "name": name,
                "size": a["size"].as_u64().unwrap_or(0),
            });
        }
    }
    json!({ "ok": false, "error": format!("未找到 GPU 增强包资产：fufumidi-gpu-{}.zip", suffix) })
}

#[derive(Deserialize, Clone)]
pub struct GpuDownloadOpts {
    url: Option<String>,
    name: Option<String>,
    kind: Option<String>,
    size: Option<u64>,
    files: Option<Vec<GpuFile>>,
}
#[derive(Deserialize, Clone)]
pub struct GpuFile {
    name: Option<String>,
    url: Option<String>,
    size: Option<u64>,
}

#[tauri::command]
pub async fn gpu_download_package(app: AppHandle, opts: GpuDownloadOpts) -> Value {
    let hint = opts
        .name
        .clone()
        .or_else(|| opts.files.as_ref().and_then(|f| f.first()).and_then(|f| f.name.clone()))
        .or_else(|| opts.url.clone())
        .unwrap_or_default();
    let kind = opts
        .kind
        .clone()
        .or_else(|| infer_kind(&hint))
        .unwrap_or_default()
        .to_lowercase();
    if !valid_kind(&kind) {
        return json!({ "ok": false, "error": "无法识别增强包类型" });
    }
    let cache = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("fufumidi-gpu");
    let _ = fs::create_dir_all(&cache);
    let zip_tmp = cache.join(format!("fufumidi-gpu-{}.zip", kind));
    let extract_dir = cache.join(format!("extract-{}", kind));
    let files = if let Some(fs) = &opts.files {
        if !fs.is_empty() {
            fs.iter().filter(|f| f.url.is_some()).cloned().collect::<Vec<_>>()
        } else {
            vec![GpuFile { name: opts.name.clone(), url: opts.url.clone(), size: opts.size }]
        }
    } else {
        vec![GpuFile { name: opts.name.clone(), url: opts.url.clone(), size: opts.size }]
    };
    if files.is_empty() {
        return json!({ "ok": false, "error": "empty url" });
    }
    let mut last_err = String::new();
    let mut downloaded: Vec<PathBuf> = Vec::new();
    for f in &files {
        let url = f.url.clone().unwrap_or_default();
        let name = f
            .name
            .clone()
            .unwrap_or_else(|| url.split('/').last().unwrap_or("part").to_string());
        let out_path = cache.join(&name);
        let mirrors = [
            url.clone(),
            format!("https://ghfast.top/{}", url),
            format!("https://ghproxy.net/{}", url),
            format!("https://gh-proxy.com/{}", url),
        ];
        let mut ok = false;
        for m in &mirrors {
            match http_download(m, &out_path) {
                Ok(()) => {
                    ok = true;
                    break;
                }
                Err(e) => last_err = e,
            }
        }
        if !ok {
            return json!({ "ok": false, "error": format!("下载失败：{}", last_err) });
        }
        downloaded.push(out_path);
    }
    // 合并分卷 → zip_tmp
    if downloaded.len() > 1 || is_split(&downloaded[0].to_string_lossy()) {
        let _ = fs::remove_file(&zip_tmp);
        use std::io::Write;
        let mut out_f = match fs::OpenOptions::new().create(true).append(true).open(&zip_tmp) {
            Ok(f) => f,
            Err(e) => return json!({ "ok": false, "error": e.to_string() }),
        };
        for p in &downloaded {
            let bytes = match fs::read(p) {
                Ok(b) => b,
                Err(e) => return json!({ "ok": false, "error": e.to_string() }),
            };
            if out_f.write_all(&bytes).is_err() {
                return json!({ "ok": false, "error": "写入失败" });
            }
        }
    } else {
        if let Err(e) = fs::copy(&downloaded[0], &zip_tmp) {
            return json!({ "ok": false, "error": e.to_string() });
        }
    }
    // 解压并安装
    match extract_zip(&zip_tmp, &extract_dir) {
        Ok(()) => {}
        Err(e) => return json!({ "ok": false, "error": e }),
    }
    let sp_src = extract_dir.join("site-packages");
    if !sp_src.exists() {
        return json!({ "ok": false, "error": "压缩包内缺少 site-packages 目录" });
    }
    let meta = json!({ "name": hint, "url": opts.url.unwrap_or_default(), "source": "download" });
    match install_site(&app, &kind, &sp_src, meta) {
        Ok(()) => {
            let _ = app.emit("gpu:progress", json!({ "received": 1, "total": 1, "percent": 100, "done": true }));
            json!({ "ok": true, "kind": kind })
        }
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

// 本地导入：zip / 分卷 → site-packages
#[derive(Deserialize)]
pub struct GpuImportReq {
    paths: Vec<String>,
    kind: Option<String>,
}

#[tauri::command]
pub async fn gpu_import_local(app: AppHandle, req: GpuImportReq) -> Value {
    if req.paths.is_empty() || req.paths.iter().any(|p| !Path::new(p).exists()) {
        return json!({ "ok": false, "error": "本地文件不存在" });
    }
    let first = &req.paths[0];
    let detected = infer_kind(first);
    let k = detected.or_else(|| req.kind.clone()).unwrap_or_default().to_lowercase();
    if !valid_kind(&k) {
        return json!({ "ok": false, "error": "无法识别增强包类型，请先选择 DirectML 或 CUDA 包/分卷" });
    }
    let cache = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("fufumidi-gpu");
    let _ = fs::create_dir_all(&cache);
    let zip_tmp = cache.join("fufumidi-gpu-import.zip");
    let extract_dir = cache.join("fufumidi-gpu-import");
    if req.paths.len() > 1 || is_split(first) {
        let _ = fs::remove_file(&zip_tmp);
        use std::io::Write;
        let mut out_f = match fs::OpenOptions::new().create(true).append(true).open(&zip_tmp) {
            Ok(f) => f,
            Err(e) => return json!({ "ok": false, "error": e.to_string() }),
        };
        for p in &req.paths {
            match fs::read(p) {
                Ok(bytes) => {
                    if out_f.write_all(&bytes).is_err() {
                        return json!({ "ok": false, "error": "合并分卷失败" });
                    }
                }
                Err(e) => return json!({ "ok": false, "error": e.to_string() }),
            }
        }
    } else {
        if let Err(e) = fs::copy(first, &zip_tmp) {
            return json!({ "ok": false, "error": e.to_string() });
        }
    }
    if let Err(e) = extract_zip(&zip_tmp, &extract_dir) {
        return json!({ "ok": false, "error": e });
    }
    let sp_src = extract_dir.join("site-packages");
    if !sp_src.exists() {
        return json!({ "ok": false, "error": "压缩包内缺少 site-packages 目录" });
    }
    match install_site(&app, &k, &sp_src, json!({ "name": Path::new(first).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), "source": "local" })) {
        Ok(()) => json!({ "ok": true, "kind": k, "split": req.paths.len() > 1 || is_split(first) }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

// 自动检测并安装（engine_gpu.detect → pip install --target）
#[tauri::command]
pub async fn gpu_install_auto(app: AppHandle) -> Value {
    let code = "from engine_gpu import detect; import json; print('###RESULT ' + json.dumps(detect()))";
    let r = run_inline_python(&app, code);
    let d = parse_py_json(&r.out).unwrap_or_else(|| json!({}));
    let gpu_detect = json!({
        "vendor": d["vendor"].as_str().unwrap_or(""),
        "name": d["name"].as_str().unwrap_or(""),
        "blackwell": d["blackwell"].as_bool().unwrap_or(false),
        "available": d["available"].as_bool().unwrap_or(false),
        "backend": d["backend"].as_str().unwrap_or(""),
    });
    let installed = installed_kinds(&app);
    if !installed.is_empty() {
        return json!({ "ok": true, "already": true, "kind": installed[0], "kinds": installed, "gpu": gpu_detect });
    }
    let vendor = d["vendor"].as_str().unwrap_or("");
    if vendor.is_empty() {
        return json!({ "ok": false, "error": "未检测到可用的独立显卡（NVIDIA / AMD / Intel），无法安装 GPU 加速；可在下方「本地导入 ZIP」手动安装增强包", "gpu": gpu_detect });
    }
    let kind = if vendor == "nvidia" { "cuda" } else { "directml" };
    // 通过内联 Python 用 pip 安装到目标目录（复用内置 Python）
    let req_name = if kind == "cuda" { "requirements-gpu-cuda.txt" } else { "requirements-gpu-directml.txt" };
    let eng = crate::engine::engine_dir(&app);
    let req_path = eng.join(req_name);
    if !req_path.exists() {
        return json!({ "ok": false, "error": format!("GPU requirement file missing: {}", req_path.to_string_lossy()), "kind": kind, "gpu": gpu_detect });
    }
    let target_site = gpu_dir(&app, kind).join("site-packages");
    let _ = fs::create_dir_all(&target_site);
    let py = crate::engine::resolve_python(&app);
    let target_s = target_site.to_string_lossy().to_string();
    let req_s = req_path.to_string_lossy().to_string();
    let _ = app.emit("gpu:progress", json!({ "percent": 1, "text": format!("检测到 {}，开始安装 {} 加速…", d["name"].as_str().unwrap_or(vendor), if kind == "cuda" { "CUDA（cu128）" } else { "DirectML" }), "installing": true }));
    let st = std::process::Command::new(&py)
        .args(["-m", "pip", "install", "--target", &target_s, "-r", &req_s, "--no-input", "--disable-pip-version-check"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .status();
    match st {
        Ok(s) if s.success() => {
            write_manifest(&app, &kind, json!({ "source": "auto" }));
            let _ = app.emit("gpu:progress", json!({ "percent": 100, "done": true }));
            json!({ "ok": true, "kind": kind, "gpu": gpu_detect })
        }
        Ok(_) => json!({ "ok": false, "kind": kind, "error": "pip 安装失败", "gpu": gpu_detect }),
        Err(e) => json!({ "ok": false, "kind": kind, "error": format!("无法启动 pip：{}", e), "gpu": gpu_detect }),
    }
}
