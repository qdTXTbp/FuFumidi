// 更新器启动 + 版本检查 —— 移植自 main/update.js
use serde_json::{json, Value};
use std::process::Command;
use tauri::{AppHandle, Manager};

const RELEASE_API: &str = "https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest";
const MIRRORS: &[&str] = &[
    "https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest",
    "https://ghfast.top/https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest",
    "https://ghproxy.net/https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest",
    "https://gh-proxy.com/https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest",
];

fn http_get_json(url: &str) -> Result<Value, String> {
    let out = std::process::Command::new("curl.exe")
        .args(["--ssl-no-revoke", "-sS", "-L", "-m", "15", "-H", "User-Agent: FuFumidi", url])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    let body = String::from_utf8_lossy(&out.stdout).to_string();
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

fn compare_version(a: &str, b: &str) -> std::cmp::Ordering {
    let pa: Vec<u32> = a
        .trim_start_matches('v')
        .split('.')
        .filter_map(|x| x.parse().ok())
        .collect();
    let pb: Vec<u32> = b
        .trim_start_matches('v')
        .split('.')
        .filter_map(|x| x.parse().ok())
        .collect();
    for i in 0..pa.len().max(pb.len()) {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        if x != y {
            return x.cmp(&y);
        }
    }
    std::cmp::Ordering::Equal
}

// 检查更新：获取 GitHub latest release，对比当前版本
#[tauri::command]
pub fn check_update(app: AppHandle) -> Value {
    let current = app.package_info().version.to_string();
    let mut last_err = String::new();
    let mut release: Option<Value> = None;
    for m in MIRRORS {
        match http_get_json(m) {
            Ok(v) => {
                if v.get("tag_name").and_then(|t| t.as_str()).is_some() {
                    release = Some(v);
                    break;
                }
                last_err = "响应缺少 tag_name".into();
            }
            Err(e) => last_err = e,
        }
    }
    let release = match release {
        Some(r) => r,
        None => return json!({ "ok": false, "error": format!("检查更新失败：{}", last_err) }),
    };
    let tag = release["tag_name"].as_str().unwrap_or("").to_string();
    let latest = tag.trim_start_matches('v').to_string();
    let notes = release["body"].as_str().unwrap_or("").chars().take(500).collect::<String>();

    // 找 Windows exe 资产
    let mut url: Option<String> = None;
    let mut name: Option<String> = None;
    if let Some(assets) = release["assets"].as_array() {
        for a in assets {
            if let Some(n) = a["name"].as_str() {
                if n.to_lowercase().ends_with(".exe") {
                    url = a["browser_download_url"].as_str().map(|s| s.to_string());
                    name = Some(n.to_string());
                    break;
                }
            }
        }
    }

    let has_update = compare_version(&latest, &current) == std::cmp::Ordering::Greater;
    json!({
        "ok": true,
        "current": current,
        "latest": latest,
        "tag": tag,
        "has_update": has_update,
        "notes": notes,
        "url": url,
        "name": name,
        "mirror": url.clone().map(|u| format!("https://ghfast.top/{}", u)),
    })
}

// 启动 kachina 更新器（FuFumidi.update.exe -I，与主程序同目录）
#[tauri::command]
pub fn launch_updater(app: AppHandle) -> Value {
    // 主程序 exe 所在目录
    let exe_dir = match std::env::current_exe() {
        Ok(p) => p.parent().map(|d| d.to_path_buf()),
        Err(_) => None,
    };
    let updater = exe_dir.map(|d| d.join("FuFumidi.update.exe"));
    let updater = match updater {
        Some(p) => p,
        None => return json!({ "ok": false, "error": "无法定位程序目录" }),
    };
    if !updater.exists() {
        return json!({ "ok": false, "error": format!("更新器不存在：{}（请使用新版便携版 / 重新下载）", updater.to_string_lossy()) });
    }
    let dir = updater.parent().map(|p| p.to_path_buf());
    let mut cmd = Command::new(&updater);
    cmd.arg("-I");
    if let Some(d) = dir {
        cmd.current_dir(d);
    }
    match cmd.spawn() {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": format!("启动更新器失败：{}", e) }),
    }
}

// 更新列表（GitHub releases 前 10 条）
#[tauri::command]
pub fn update_list() -> Value {
    let body = match http_get_json("https://api.github.com/repos/qdTXTbp/FuFumidi/releases?per_page=10") {
        Ok(v) => v,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let arr = match body.as_array() {
        Some(a) => a,
        None => return json!({ "ok": false, "error": "解析失败" }),
    };
    let out: Vec<Value> = arr
        .iter()
        .map(|x| {
            let assets: Vec<Value> = x["assets"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|as_| {
                            json!({
                                "name": as_["name"].as_str().unwrap_or(""),
                                "url": as_["browser_download_url"].as_str().unwrap_or(""),
                                "size": as_["size"].as_u64().unwrap_or(0),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            json!({
                "tag": x["tag_name"].as_str().unwrap_or(""),
                "name": x["name"].as_str().unwrap_or(""),
                "assets": assets,
                "body": x["body"].as_str().unwrap_or("").chars().take(240).collect::<String>(),
            })
        })
        .collect();
    json!(out)
}

// 下载更新资产到临时目录（curl，多镜像回退）
#[tauri::command]
pub async fn update_download(app: AppHandle, url: String) -> Value {
    let dir = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("fufumidi-update");
    let _ = std::fs::create_dir_all(&dir);
    let name = url.split('/').last().unwrap_or("FuFumidi-update.exe").to_string();
    let dest = dir.join(&name);
    let mirrors = [
        url.clone(),
        format!("https://ghfast.top/{}", url),
        format!("https://gh-proxy.com/{}", url),
        format!("https://ghproxy.net/{}", url),
    ];
    let mut last_err = String::new();
    for m in &mirrors {
        let out = std::process::Command::new("curl.exe")
            .args(["--ssl-no-revoke", "-sS", "-L", "-o"])
            .arg(dest.to_string_lossy().to_string())
            .arg(m)
            .output();
        match out {
            Ok(o) if o.status.success() => {
                return json!({ "ok": true, "path": dest.to_string_lossy() });
            }
            Ok(o) => last_err = String::from_utf8_lossy(&o.stderr).to_string(),
            Err(e) => last_err = e.to_string(),
        }
    }
    json!({ "ok": false, "error": format!("下载失败：{}", last_err) })
}

// 打开下载的文件
#[tauri::command]
pub fn update_open(app: AppHandle, p: String) -> Value {
    let _ = std::process::Command::new("explorer.exe")
        .arg(p.clone())
        .spawn();
    json!({ "ok": true, "path": p })
}

// 打开外部链接
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Value {
    let _ = std::process::Command::new("cmd.exe")
        .args(["/C", "start", "", &url])
        .spawn();
    json!({ "ok": true })
}
