//! 插件运行时的 Rust 侧支撑：把插件目录打包给前端 JS 宿主、代为执行引擎脚本。
//!
//! 为什么宿主在前端：Tauri 不内嵌 Node/QuickJS；WebView2 本身就是完整 JS 引擎。
//! 前端用独立 Worker 执行 CommonJS 入口（无 DOM），Rust 只提供**受控**的文件读取与引擎调用。

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::{apply_engine_env, engine_dir, plugin_dirs, python_path, read_json, settings_path};

const MAX_FILES: usize = 400;
const MAX_TOTAL: u64 = 4 * 1024 * 1024;
const TEXT_EXT: &[&str] = &["js", "cjs", "mjs", "json", "txt", "md", "yaml", "yml", "html", "css"];

fn read_manifest(dir: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(dir.join("plugin.json")).ok()?;
    serde_json::from_str::<Value>(&text).ok()
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<Value>, total: &mut u64) -> Result<(), String> {
    let rd = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    for e in rd.flatten() {
        if out.len() >= MAX_FILES { return Ok(()); }
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if name == "node_modules" || name == ".git" || name.starts_with('.') { continue; }
        let Ok(md) = std::fs::metadata(&p) else { continue };
        if md.is_dir() {
            collect_files(root, &p, out, total)?;
            continue;
        }
        let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
        if !TEXT_EXT.contains(&ext.as_str()) { continue; }
        if md.len() > 512 * 1024 { continue; }
        let rel = p.strip_prefix(root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
        let text = match std::fs::read_to_string(&p) { Ok(t) => t, Err(_) => continue };
        if *total + text.len() as u64 > MAX_TOTAL { break; }
        *total += text.len() as u64;
        out.push(json!({ "path": rel, "content": text }));
    }
    Ok(())
}

/// 把一个已安装插件（plugin.json + 文本源码）打包给前端宿主。
pub fn bundle(id: &str) -> Value {
    if id.is_empty() || id.len() > 128 { return json!({ "ok": false, "error": "插件 id 非法" }); }
    let settings = read_json(&settings_path());
    for root in plugin_dirs(&settings) {
        let root = PathBuf::from(root);
        let Ok(rd) = std::fs::read_dir(&root) else { continue };
        for e in rd.flatten() {
            let dir = e.path();
            if !dir.is_dir() { continue; }
            let Some(manifest) = read_manifest(&dir) else { continue };
            if manifest.get("id").and_then(|v| v.as_str()) != Some(id) { continue; }
            let canonical = dir.canonicalize().unwrap_or_else(|_| dir.clone());
            let mut files = Vec::new();
            let mut total = 0u64;
            if let Err(err) = collect_files(&canonical, &canonical, &mut files, &mut total) {
                return json!({ "ok": false, "error": err });
            }
            return json!({
                "ok": true, "id": id, "dir": canonical.display().to_string(),
                "manifest": manifest, "files": files, "bytes": total,
            });
        }
    }
    json!({ "ok": false, "error": format!("插件不存在：{id}") })
}

/// 代插件执行脚本。脚本可位于 engine/（内置模块）或插件自己的目录（plugin_dir 必须
/// 是配置的插件根的子目录）。stdout 逐行转发到 plugins:log，最后一条 ###RESULT 解析为 result。
#[allow(clippy::too_many_arguments)]
pub fn engine_run(
    app: &tauri::AppHandle,
    args: Vec<String>,
    script: Option<String>,
    timeout_ms: Option<u64>,
    plugin_dir: Option<String>,
    plugin_id: Option<String>,
) -> Value {
    use std::io::{BufRead, BufReader};
    use std::sync::{Arc, Mutex};
    use tauri::Emitter;

    let Some(py) = python_path() else { return json!({ "ok": false, "error": "Python 运行时不存在" }) };
    let Some(eng) = engine_dir() else { return json!({ "ok": false, "error": "引擎目录不存在" }) };
    let eng_canon = eng.canonicalize().unwrap_or_else(|_| eng.clone());
    let name = script.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "music2midi.py".to_string());
    let plugin_dir_canon = plugin_dir.as_ref().and_then(|d| PathBuf::from(d).canonicalize().ok());
    // 插件目录必须位于某个已配置的插件根下（防止宿主传入任意路径）
    let plugin_root_ok = plugin_dir_canon.as_ref().map(|d| {
        let settings = read_json(&settings_path());
        plugin_dirs(&settings).iter().any(|root| {
            PathBuf::from(root).canonicalize().map(|r| d.starts_with(&r)).unwrap_or(false)
        })
    }).unwrap_or(false);
    // 解析脚本：绝对/带分隔符按路径；否则先 engine，再插件目录。
    let raw = PathBuf::from(&name);
    let mut candidates: Vec<PathBuf> = Vec::new();
    if raw.is_absolute() || name.contains('/') || name.contains('\\') {
        candidates.push(raw.clone());
        if !raw.is_absolute() { if let Some(d) = &plugin_dir_canon { candidates.push(d.join(&raw)); } }
    } else {
        candidates.push(eng.join(&name));
        if let Some(d) = &plugin_dir_canon { candidates.push(d.join(&name)); }
    }
    let mut chosen: Option<PathBuf> = None;
    let mut in_plugin = false;
    for c in candidates {
        let Ok(canon) = c.canonicalize() else { continue };
        if canon.starts_with(&eng_canon) { chosen = Some(canon); in_plugin = false; break; }
        if plugin_root_ok {
            if let Some(d) = &plugin_dir_canon {
                if canon.starts_with(d) { chosen = Some(canon); in_plugin = true; break; }
            }
        }
    }
    let Some(file) = chosen else { return json!({ "ok": false, "error": format!("脚本不存在或越界：{name}") }) };
    if args.iter().any(|a| a.contains('\0')) { return json!({ "ok": false, "error": "参数非法" }); }
    let cwd = if in_plugin { plugin_dir_canon.clone().unwrap_or(eng.clone()) } else { eng.clone() };
    let mut cmd = Command::new(&py);
    cmd.current_dir(&cwd).arg(&file).args(&args)
        .stdout(Stdio::piped()).stderr(Stdio::piped());
    apply_engine_env(&mut cmd);
    let mut child = match cmd.spawn() { Ok(c) => c, Err(e) => return json!({ "ok": false, "error": e.to_string() }) };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let outbuf = Arc::new(Mutex::new(String::new()));
    let errbuf = Arc::new(Mutex::new(String::new()));
    let id = plugin_id.unwrap_or_default();
    let app_out = app.clone();
    let id_out = id.clone();
    let out_ref = outbuf.clone();
    let th_out = std::thread::spawn(move || {
        if let Some(s) = stdout {
            for line in BufReader::new(s).lines().map_while(Result::ok) {
                if let Ok(mut b) = out_ref.lock() {
                    if b.len() < 4 * 1024 * 1024 { b.push_str(&line); b.push('\n'); }
                }
                let _ = app_out.emit("plugins:log", json!({ "id": id_out, "line": line }));
            }
        }
    });
    let err_ref = errbuf.clone();
    let th_err = std::thread::spawn(move || {
        if let Some(s) = stderr {
            for line in BufReader::new(s).lines().map_while(Result::ok) {
                if let Ok(mut b) = err_ref.lock() { if b.len() < 1024 * 1024 { b.push_str(&line); b.push('\n'); } }
            }
        }
    });
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.unwrap_or(30 * 60 * 1000).min(60 * 60 * 1000));
    let mut killed = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(_) => { let _ = child.kill(); break; }
        }
        if Instant::now() >= deadline { killed = true; let _ = child.kill(); break; }
        std::thread::sleep(Duration::from_millis(120));
    }
    let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
    let _ = th_out.join();
    let _ = th_err.join();
    let out = outbuf.lock().map(|b| b.clone()).unwrap_or_default();
    let err = errbuf.lock().map(|b| b.clone()).unwrap_or_default();
    if killed {
        return json!({ "ok": false, "code": -1, "error": "插件引擎调用超时", "out": out.chars().take(2000).collect::<String>(), "err": err.chars().take(2000).collect::<String>() });
    }
    let result = out.lines().rev().find_map(|l| l.trim().strip_prefix("###RESULT ").and_then(|s| serde_json::from_str::<Value>(s).ok()));
    json!({
        "ok": code == 0, "code": code, "result": result,
        "out": out.chars().take(4000).collect::<String>(),
        "err": err.chars().take(4000).collect::<String>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("fufumidi-plugin-rt-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn bundle_reads_manifest_and_files() {
        let root = tmp("bundle");
        let p = root.join("demo");
        std::fs::create_dir_all(&p).unwrap();
        std::fs::write(p.join("plugin.json"), r#"{"id":"demo","name":"Demo","entry":"index.js"}"#).unwrap();
        std::fs::write(p.join("index.js"), "module.exports={activate(){}}").unwrap();
        std::env::set_var("FUFUMIDI_PLUGIN_DIRS", root.display().to_string());
        let v = bundle("demo");
        std::env::remove_var("FUFUMIDI_PLUGIN_DIRS");
        assert_eq!(v["ok"], true);
        assert_eq!(v["manifest"]["name"], "Demo");
        assert_eq!(v["files"].as_array().unwrap().len(), 2);
        assert!(bundle("nope")["ok"].as_bool() == Some(false));
    }
}
