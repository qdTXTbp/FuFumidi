// ============================================================
// 更新服务（stable/beta 双通道 + CNB/GitHub 多源回退 + 原子下载）
//
// 移植自主进程 main/update.js，语义与其保持一致（见 UPDATING.md §5）：
//   · stable = releases/latest（GitHub 自动跳过 prerelease）
//   · beta   = releases 列表里第一个 tag 形如 X.Y.Z-beta.N / -rc.N 的 prerelease
//              —— 固定锚点 release（tag 就叫 `beta`，只承载分发资产）必须被过滤掉
//   · 版本比较必须语义化：4.4.0-beta.1 < 4.4.0-rc.1 < 4.4.0
//   · 下载按「下载源偏好」排序候选（国内优先 CNB，全球优先 GitHub），逐源回退
//   · 下载一律先写 <目标>.part，校验通过后再原子 rename 覆盖正式文件
//     —— 失败/中断绝不留下半个正式文件（对齐 main/update.js 的 downloadInstallPackage）
// ============================================================
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const GH_WEB: &str = "https://github.com/qdTXTbp/FuFumidi/";
const GH_API: &str = "https://api.github.com/repos/qdTXTbp/FuFumidi/";
// CNB 国内镜像（公开可下载、无需认证）——与 main/download-source.js 的锚点一致
const CNB_RELEASES: &str = "https://cnb.cool/FuFuCloud-mirror/FuFuMIDI/-/releases/";
// GitHub 加速镜像：id 与 build/kachina.config.json 的 source 一一对应（测试通道加 -beta 后缀）
// 末位 prefix 为空 = 官方直连
const GH_MIRRORS: &[(&str, &str)] = &[
    ("ghfast", "https://ghfast.top/"),
    ("ghproxy", "https://gh-proxy.com/"),
    ("ghproxy-net", "https://ghproxy.net/"),
    ("github", ""),
];
// 两条通道共用的离线包资产名（kachina 更新器读的就是它）
const ASSET_NAME: &str = "FuFumidi.Install.exe";
// 下载完整性校验阈值：不足声明大小的 90% 视为损坏
const SIZE_MIN_RATIO: u64 = 9;
const SIZE_RATIO_DEN: u64 = 10;

fn norm_channel(v: Option<&str>) -> &'static str {
    match v.map(|s| s.to_ascii_lowercase()).as_deref() {
        Some("beta") => "beta",
        _ => "stable",
    }
}

// ── 下载源偏好（settings.download_source：auto / cnb / github）───────────────
fn prefer_cnb(app: &AppHandle) -> bool {
    let s = crate::settings::read_settings(app);
    !matches!(s.get("download_source").and_then(|v| v.as_str()), Some("github"))
}

// ── 地址构造 ────────────────────────────────────────────────────────────────
/// CNB 离线包地址：正式走 latest 锚点，测试走固定 tag `beta`
fn cnb_install_url(channel: &str) -> String {
    if channel == "beta" {
        format!("{}download/beta/{}", CNB_RELEASES, ASSET_NAME)
    } else {
        format!("{}latest/download/{}", CNB_RELEASES, ASSET_NAME)
    }
}
/// CNB 版本元数据（只有正式锚点有；测试通道不依赖它，见 UPDATING.md §5）
fn cnb_version_url() -> String {
    format!("{}latest/download/latest.yml", CNB_RELEASES)
}
/// GitHub 离线包地址
fn gh_install_url(channel: &str) -> String {
    if channel == "beta" {
        format!("{}releases/download/beta/{}", GH_WEB, ASSET_NAME)
    } else {
        format!("{}releases/latest/download/{}", GH_WEB, ASSET_NAME)
    }
}
/// kachina source id：测试通道加 -beta 后缀（与 kachina.config.json 对应）
fn source_id(mirror_id: &str, channel: &str) -> String {
    if channel == "beta" {
        format!("{}-beta", mirror_id)
    } else {
        mirror_id.to_string()
    }
}
/// 按偏好把 CNB 与 GitHub 系候选排好序：国内优先 CNB 打头，全球优先官方直连打头
fn ordered_pairs(app: &AppHandle, channel: &str) -> Vec<(String, String)> {
    let cnb = (source_id("cnb", channel), cnb_install_url(channel));
    let gh: Vec<(String, String)> = GH_MIRRORS
        .iter()
        .map(|(id, prefix)| (source_id(id, channel), format!("{}{}", prefix, gh_install_url(channel))))
        .collect();
    if prefer_cnb(app) {
        let mut v = vec![cnb];
        v.extend(gh);
        v
    } else {
        // 官方直连在 GH_MIRRORS 末位，翻转后即「官方 → 镜像 → CNB 兜底」
        let mut v: Vec<(String, String)> = gh.into_iter().rev().collect();
        v.push(cnb);
        v
    }
}
/// 给任意 GitHub 地址套镜像前缀（非 GitHub 地址原样返回），并追加 CNB 兜底
fn download_candidates(app: &AppHandle, url: &str, channel: &str) -> Vec<String> {
    let gh: Vec<String> = if url.starts_with("https://github.com/") {
        GH_MIRRORS.iter().map(|(_, p)| format!("{}{}", p, url)).collect()
    } else {
        vec![url.to_string()]
    };
    let cnb = cnb_install_url(channel);
    let mut out = if prefer_cnb(app) {
        let mut v = vec![cnb];
        v.extend(gh);
        v
    } else {
        let mut v: Vec<String> = gh.into_iter().rev().collect();
        v.push(cnb);
        v
    };
    out.dedup();
    out
}

// ── HTTP（curl 子进程，均为隐藏窗口）────────────────────────────────────────
fn curl_stdout(args: &[&str]) -> Result<Vec<u8>, String> {
    let out = crate::procutils::cmd("curl.exe")
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(out.stdout)
}
fn http_get_json(url: &str) -> Result<Value, String> {
    let b = curl_stdout(&["--ssl-no-revoke", "-sS", "-L", "-m", "15", "-H", "User-Agent: FuFumidi", url])?;
    serde_json::from_slice(&b).map_err(|e| e.to_string())
}
fn http_get_text(url: &str) -> Result<String, String> {
    let b = curl_stdout(&["--ssl-no-revoke", "-sS", "-L", "-m", "12", "-H", "User-Agent: FuFumidi", url])?;
    Ok(String::from_utf8_lossy(&b).to_string())
}
/// HEAD 探测可达性（用于选 kachina source，对齐 main/update.js 的 pickUpdateSource）
fn head_ok(url: &str) -> bool {
    crate::procutils::cmd("curl.exe")
        .args(["--ssl-no-revoke", "-sS", "-o", "NUL", "-I", "-m", "6", url])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// ── 版本语义（对齐前端 core/version.js 的 cmpVersion）───────────────────────
/// 测试版 tag：`v?X.Y.Z-beta.N` / `v?X.Y.Z-rc.N`。
/// 恒定锚点 release（tag 就叫 `beta`，不是 semver）不匹配，会被自然过滤。
/// 注意不能用 `split('.')` 取第三段再拆 '-'：`5.0.0-beta.1` 会被拆成 ["5","0","0-beta","1"]，
/// prerelease 段变成 "beta"（丢掉 `.1`），测试版会被误判成非测试版。
fn is_beta_tag(t: &str) -> bool {
    let s = t.trim_start_matches('v');
    let Some((head, pre)) = s.split_once('-') else { return false };
    let parts: Vec<&str> = head.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|p| p.parse::<u32>().is_err()) {
        return false;
    }
    let Some((kind, num)) = pre.split_once('.') else { return false };
    (kind == "beta" || kind == "rc") && num.parse::<u32>().is_ok()
}

/// 语义化版本比较：数字段 → prerelease（无 prerelease 更大；数字标识符 < 字母标识符）
fn semver_cmp(a: &str, b: &str) -> Ordering {
    fn split(v: &str) -> (Vec<u32>, Vec<String>) {
        let s = v.trim_start_matches('v');
        let (nums_s, pre_s) = match s.split_once('-') {
            Some((n, p)) => (n, Some(p)),
            None => (s, None),
        };
        let mut nums: Vec<u32> = nums_s.split('.').map(|x| x.parse().unwrap_or(0)).collect();
        nums.resize(3, 0);
        let pre: Vec<String> = pre_s
            .map(|p| p.split('.').map(|x| x.to_string()).collect())
            .unwrap_or_default();
        (nums, pre)
    }
    let (na, pa) = split(a);
    let (nb, pb) = split(b);
    for i in 0..3 {
        if na[i] != nb[i] {
            return na[i].cmp(&nb[i]);
        }
    }
    match (pa.is_empty(), pb.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater, // 正式版 > 预发布版
        (false, true) => Ordering::Less,
        (false, false) => {
            for i in 0..pa.len().max(pb.len()) {
                let x = pa.get(i).map(|s| s.as_str()).unwrap_or("0");
                let y = pb.get(i).map(|s| s.as_str()).unwrap_or("0");
                let c = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(a), Ok(b)) => a.cmp(&b),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => x.cmp(y),
                };
                if c != Ordering::Equal {
                    return c;
                }
            }
            Ordering::Equal
        }
    }
}

// ── release 拉取 ───────────────────────────────────────────────────────────
/// 测试通道的最新版：releases 列表里第一个 prerelease 且 tag 形如 beta/rc
fn pick_beta_release(list: &Value) -> Option<Value> {
    list.as_array()?.iter().find(|r| {
        r["prerelease"].as_bool().unwrap_or(false)
            && r["tag_name"].as_str().map(is_beta_tag).unwrap_or(false)
    }).cloned()
}

/// 拉指定通道的 release（GitHub 多镜像回退）
fn fetch_channel_release(channel: &str) -> Result<Value, String> {
    let path = if channel == "beta" { "releases?per_page=20" } else { "releases/latest" };
    let mut last_err = String::new();
    for (_, prefix) in GH_MIRRORS {
        match http_get_json(&format!("{}{}{}", prefix, GH_API, path)) {
            Ok(v) => {
                if channel == "beta" {
                    if let Some(rel) = pick_beta_release(&v) {
                        return Ok(rel);
                    }
                    last_err = "当前无测试版本".into();
                } else if v.get("tag_name").is_some() {
                    return Ok(v);
                } else {
                    last_err = "响应缺少 tag_name".into();
                }
            }
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

/// 从 CNB 的 latest.yml 读版本号（正式锚点专属，公开地址免认证），合成与 GitHub release 同构的对象
fn fetch_cnb_release() -> Result<Value, String> {
    let text = http_get_text(&cnb_version_url())?;
    let ver = text
        .lines()
        .find_map(|l| l.trim_start().strip_prefix("version:"))
        .map(|s| s.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "CNB 版本信息缺失".to_string())?;
    let ver = ver.trim_start_matches('v').to_string();
    Ok(json!({
        "tag_name": format!("v{}", ver),
        "body": "",
        "assets": [{
            "name": ASSET_NAME,
            "browser_download_url": cnb_install_url("stable"),
            "size": 0,
        }],
    }))
}

/// 决定该给用户报哪个版本，并返回**实际命中的通道**
/// （否则会出现「报的是测试版版本、却从正式锚点下载」）
fn resolve_release(app: &AppHandle, channel: &str) -> Result<(Value, String), String> {
    // 正式版 + 国内优先：先读 CNB latest.yml（失败再回退 GitHub）
    if channel == "stable" && prefer_cnb(app) {
        if let Ok(r) = fetch_cnb_release() {
            return Ok((r, "stable".into()));
        }
    }
    if channel == "beta" {
        // 测试通道的版本查询永远走 GitHub Releases API —— CNB 没有测试版的版本元数据
        if let Ok(r) = fetch_channel_release("beta") {
            return Ok((r, "beta".into()));
        }
    }
    Ok((fetch_channel_release("stable")?, "stable".into()))
}

// ── 原子下载 ───────────────────────────────────────────────────────────────
/// 下载到本地再替换：全程只写 `<dest>.part`，大小校验通过后才原子 rename 覆盖正式文件。
/// 任一步失败都只清理 .part，**绝不触碰已存在的正式文件** —— 对齐 main/update.js 的
/// downloadInstallPackage「绝不边下边改」，中断不会留下半个包。
/// Windows 上 std::fs::rename 走 MoveFileEx(MOVEFILE_REPLACE_EXISTING)，可直接覆盖。
fn download_atomic(candidates: &[String], dest: &Path, expect_size: Option<u64>) -> Result<u64, String> {
    let part: PathBuf = PathBuf::from(format!("{}.part", dest.display()));
    let mut last_err = String::new();
    for url in candidates {
        let _ = std::fs::remove_file(&part);
        let res = crate::procutils::cmd("curl.exe")
            .args([
                "--ssl-no-revoke", "-sS", "-L", "--fail", "-m", "3600",
                "--connect-timeout", "20",
            ])
            .arg("-o")
            .arg(part.to_string_lossy().as_ref())
            .arg(url)
            .output();
        match res {
            Ok(o) if o.status.success() => {
                let sz = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
                if sz == 0 {
                    last_err = "下载内容为空".into();
                    continue;
                }
                if let Some(exp) = expect_size {
                    if exp > 0 && sz * SIZE_RATIO_DEN < exp * SIZE_MIN_RATIO {
                        last_err = format!("下载不完整 {}/{}", sz, exp);
                        continue;
                    }
                }
                match std::fs::rename(&part, dest) {
                    Ok(_) => return Ok(sz),
                    Err(e) => {
                        let _ = std::fs::remove_file(&part);
                        return Err(format!("替换目标文件失败：{}", e));
                    }
                }
            }
            Ok(o) => last_err = String::from_utf8_lossy(&o.stderr).trim().to_string(),
            Err(e) => last_err = e.to_string(),
        }
    }
    let _ = std::fs::remove_file(&part);
    Err(last_err)
}

/// 探测可用下载源 → kachina source id（对齐 main/update.js 的 pickUpdateSource）
fn pick_source(app: &AppHandle, channel: &str) -> String {
    let ordered = ordered_pairs(app, channel);
    for (id, uri) in &ordered {
        if head_ok(uri) {
            return id.clone();
        }
    }
    source_id("github", channel)
}

// ── 命令 ───────────────────────────────────────────────────────────────────

/// 检查更新：返回该报给用户的版本、实际命中通道，以及是否有更新
#[tauri::command]
pub fn check_update(app: AppHandle, channel: Option<String>) -> Value {
    let current = app.package_info().version.to_string();
    let ch = norm_channel(channel.as_deref());
    let (release, hit) = match resolve_release(&app, ch) {
        Ok(p) => p,
        Err(e) => return json!({ "ok": false, "error": format!("检查更新失败：{}", e) }),
    };
    let tag = release["tag_name"].as_str().unwrap_or("").to_string();
    let latest = tag.trim_start_matches('v').to_string();
    let notes: String = release["body"].as_str().unwrap_or("").chars().take(500).collect();

    // 找 Windows exe 资产（正式/测试锚点的固定名都是 FuFumidi.Install.exe）
    let mut url: Option<String> = None;
    let mut name: Option<String> = None;
    let mut size: u64 = 0;
    if let Some(assets) = release["assets"].as_array() {
        for a in assets {
            if let Some(n) = a["name"].as_str() {
                if n.to_lowercase().ends_with(".exe") {
                    url = a["browser_download_url"].as_str().map(|s| s.to_string());
                    size = a["size"].as_u64().unwrap_or(0);
                    name = Some(n.to_string());
                    break;
                }
            }
        }
    }

    let has_update = semver_cmp(&latest, &current) == Ordering::Greater;
    let mirror = url.clone().map(|u| format!("https://ghfast.top/{}", u));
    json!({
        "ok": true,
        "current": current,
        "latest": latest,
        "tag": tag,
        "channel": hit,
        "has_update": has_update,
        "notes": notes,
        "url": url,
        "name": name,
        "size": size,
        "mirror": mirror,
        "source": if prefer_cnb(&app) { "auto" } else { "github" },
    })
}

/// 更新说明：按 tag 拉 release body（更新完成后首次启动的更新日志补充）
#[tauri::command]
pub fn update_notes(_app: AppHandle, tag: String) -> Value {
    let tag = if tag.starts_with('v') { tag } else { format!("v{}", tag) };
    for (_, prefix) in GH_MIRRORS {
        if let Ok(v) = http_get_json(&format!("{}{}releases/tags/{}", prefix, GH_API, tag)) {
            if let Some(b) = v["body"].as_str() {
                return json!({ "ok": true, "body": b });
            }
        }
    }
    json!({ "ok": false, "error": "无法获取更新说明" })
}

/// 启动 kachina 更新器：探测可用源后以 `-I -O --source <id>` 拉起（与主程序同目录）
#[tauri::command]
pub fn launch_updater(app: AppHandle, channel: Option<String>) -> Value {
    let ch = norm_channel(channel.as_deref());
    let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    else {
        return json!({ "ok": false, "error": "无法定位程序目录" });
    };
    let updater = dir.join("FuFumidi.update.exe");
    if !updater.exists() {
        return json!({
            "ok": false,
            "error": format!("更新器不存在：{}（请使用新版便携版 / 重新下载完整安装包）", updater.to_string_lossy())
        });
    }
    let source = pick_source(&app, ch);
    let mut cmd = crate::procutils::cmd(updater.to_string_lossy().as_ref());
    cmd.arg("-I").arg("-O").arg("--source").arg(&source);
    cmd.current_dir(&dir);
    match cmd.spawn() {
        Ok(_) => json!({ "ok": true, "source": source }),
        Err(e) => json!({ "ok": false, "error": format!("启动更新器失败：{}", e) }),
    }
}

/// 更新列表（GitHub releases 前 10 条）
#[tauri::command]
pub fn update_list() -> Value {
    let body = match http_get_json(&format!("{}releases?per_page=10", GH_API)) {
        Ok(v) => v,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let Some(arr) = body.as_array() else {
        return json!({ "ok": false, "error": "解析失败" });
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

/// 应用内下载离线包：多源回退 + **原子写入**（.part → 校验 → rename）
#[tauri::command]
pub async fn update_download(
    app: AppHandle,
    url: String,
    channel: Option<String>,
    name: Option<String>,
    size: Option<u64>,
) -> Value {
    let ch = norm_channel(channel.as_deref());
    let dir = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("fufumidi-update");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return json!({ "ok": false, "error": format!("创建下载目录失败：{}", e) });
    }
    let fname = name.unwrap_or_else(|| {
        url.split('/')
            .last()
            .filter(|s| !s.is_empty())
            .unwrap_or(ASSET_NAME)
            .to_string()
    });
    let dest = dir.join(&fname);
    let cands = download_candidates(&app, &url, ch);
    match download_atomic(&cands, &dest, size) {
        Ok(sz) => json!({ "ok": true, "path": dest.to_string_lossy(), "size": sz }),
        Err(e) => json!({ "ok": false, "error": format!("下载失败：{}", e) }),
    }
}

/// 应用版本号（前端 getVersion 动态读取，避免界面硬编码不一致）
#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// 打开下载好的离线包
#[tauri::command]
pub fn update_open(_app: AppHandle, p: String) -> Value {
    let _ = crate::procutils::cmd("explorer.exe").arg(p.clone()).spawn();
    json!({ "ok": true, "path": p })
}

/// 打开外部链接
#[tauri::command]
pub fn open_external(_app: AppHandle, url: String) -> Value {
    let _ = crate::procutils::cmd("cmd.exe")
        .args(["/C", "start", "", &url])
        .spawn();
    json!({ "ok": true })
}
