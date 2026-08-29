// 转录引擎：spawn Python music2midi.py + 进度/日志/取消 —— 移植自 main/engine.js
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

// 引擎状态：child pid 表（用于取消）
pub struct EngineState {
    pub children: Arc<Mutex<HashMap<String, u32>>>,
}

impl Default for EngineState {
    fn default() -> Self {
        EngineState {
            children: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

pub fn resolve_python(app: &AppHandle) -> String {
    // 1) 打包 python（resources/python/python.exe）
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("python").join("python.exe");
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
    }
    // 2) 开发模式：从 exe 位置推导项目根（target/debug → src-tauri → 项目根）
    let roots = project_roots();
    for r in roots {
        for p in [
            r.join("resources/python/python.exe"),
            r.join("python/python.exe"),
            r.join("engine/python/python.exe"),
        ] {
            if p.exists() {
                return p.to_string_lossy().to_string();
            }
        }
    }
    // 3) 系统 python
    "python".to_string()
}

// 从 current_exe 向上找项目根（含 src-tauri 在内的各层）
fn project_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(|p| p.to_path_buf());
        let mut guard = 0;
        while let Some(d) = dir {
            out.push(d.clone());
            guard += 1;
            if guard > 8 {
                break;
            }
            dir = d.parent().map(|p| p.to_path_buf());
        }
    }
    out
}

pub fn engine_dir(app: &AppHandle) -> PathBuf {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("engine");
        if p.join("music2midi.py").exists() {
            return p;
        }
    }
    // 开发模式：从 exe 位置向上找 engine
    for r in project_roots() {
        for d in [r.join("engine"), r.join("src-tauri/../engine")] {
            if d.join("music2midi.py").exists() {
                return d;
            }
        }
    }
    PathBuf::from("engine")
}

pub fn engine_env(app: &AppHandle) -> std::collections::HashMap<String, String> {
    let mut env: std::collections::HashMap<String, String> = std::env::vars().collect();
    env.insert("PYTHONIOENCODING".into(), "utf-8".into());
    env.insert("PYTHONUTF8".into(), "1".into());
    env.insert("FUFUMIDI_DISABLE_GPU".into(), "1".into()); // Tauri 阶段先走 CPU，GPU 增强后移
    if let Ok(res) = app.path().resource_dir() {
        let models = res.join("models");
        if models.exists() {
            env.insert("FUFUMIDI_MODELS_DIR".into(), models.to_string_lossy().to_string());
        }
    }
    env
}

#[derive(Deserialize)]
pub struct ConvertReq {
    audio: String,
    out: Option<String>,
    mode: Option<String>,
    perf: Option<String>,
    model: Option<String>,
    model_size: Option<String>,
    onset_threshold: Option<f64>,
    frame_threshold: Option<f64>,
    min_note_length: Option<f64>,
    min_note_ms: Option<i64>,
    merge_gap_ms: Option<i64>,
    tempo: Option<i64>,
    denoise: Option<bool>,
    normalize: Option<bool>,
    auto_bpm: Option<bool>,
    no_merge: Option<bool>,
    no_velnorm: Option<bool>,
    with_drums: Option<bool>,
    export_stems: Option<bool>,
    no_pedal: Option<bool>,
    id: Option<String>,
}

#[derive(Serialize)]
pub struct ConvertResult {
    ok: bool,
    out: Option<String>,
    error: Option<String>,
    code: Option<i32>,
    note_count: Option<usize>,
    #[serde(flatten)]
    extra: Value,
}

fn build_args(eng: &PathBuf, req: &ConvertReq) -> Vec<String> {
    let mut args: Vec<String> = vec![
        eng.join("music2midi.py").to_string_lossy().to_string(),
        "convert".into(),
        req.audio.clone(),
    ];
    if let Some(out) = &req.out {
        if !out.is_empty() {
            args.push("-o".into());
            args.push(out.clone());
        }
    }
    args.push("--mode".into());
    args.push(req.mode.clone().unwrap_or_else(|| "universal".into()));
    args.push("--perf".into());
    args.push(req.perf.clone().unwrap_or_else(|| "quality".into()));

    if let Some(m) = &req.model {
        args.push("--model".into());
        args.push(m.clone());
    }
    if let Some(m) = &req.model_size {
        args.push("--model-size".into());
        args.push(m.clone());
    }
    if let Some(v) = req.onset_threshold {
        args.push("--onset-threshold".into());
        args.push(v.to_string());
    }
    if let Some(v) = req.frame_threshold {
        args.push("--frame-threshold".into());
        args.push(v.to_string());
    }
    if let Some(v) = req.min_note_length {
        args.push("--min-note-length".into());
        args.push(v.to_string());
    }
    if let Some(v) = req.min_note_ms {
        args.push("--min-note-ms".into());
        args.push(v.to_string());
    }
    if let Some(v) = req.merge_gap_ms {
        args.push("--merge-gap-ms".into());
        args.push(v.to_string());
    }
    if let Some(v) = req.tempo {
        args.push("--tempo".into());
        args.push(v.to_string());
    }
    for (flag, val) in [
        ("--denoise", req.denoise),
        ("--normalize", req.normalize),
        ("--auto-bpm", req.auto_bpm),
        ("--no-merge", req.no_merge),
        ("--no-velnorm", req.no_velnorm),
        ("--with-drums", req.with_drums),
        ("--export-stems", req.export_stems),
        ("--no-pedal", req.no_pedal),
    ] {
        if val.unwrap_or(false) {
            args.push(flag.into());
        }
    }
    args
}

// 转换命令：async + spawn_blocking（阻塞逻辑放线程池，不卡 Tauri IPC）
#[tauri::command]
pub async fn convert(
    app: AppHandle,
    state: State<'_, EngineState>,
    req: ConvertReq,
) -> Result<ConvertResult, String> {
    let py = resolve_python(&app);
    let eng = engine_dir(&app);
    let args = build_args(&eng, &req);
    let env = engine_env(&app);
    let log_id = req.id.clone().unwrap_or_else(|| "job".into());
    let children = state.children.clone();

    let handle = tauri::async_runtime::spawn_blocking(move || {
        run_convert(&py, &eng, args, env, &log_id, children)
    });
    handle.await.map_err(|e| e.to_string())
}

fn run_convert(
    py: &str,
    eng: &std::path::Path,
    args: Vec<String>,
    env: std::collections::HashMap<String, String>,
    log_id: &str,
    children: Arc<Mutex<HashMap<String, u32>>>,
) -> ConvertResult {
    let mut cmd = std::process::Command::new(py);
    cmd.args(&args).current_dir(eng).envs(env);
    let mut child = match cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(e) => {
            return ConvertResult {
                ok: false,
                out: None,
                error: Some(format!("无法启动 Python：{}", e)),
                code: Some(-1),
                note_count: None,
                extra: json!({}),
            };
        }
    };
    let pid = child.id();
    let child_key = format!("{}_{}", log_id, pid);
    children.lock().unwrap().insert(child_key.clone(), pid);

    let mut result_json: Option<Value> = None;
    let mut out_buf = String::new();

    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(l) = line {
                let t = l.trim().to_string();
                if t.is_empty() {
                    continue;
                }
                if let Some(rest) = t.strip_prefix("###RESULT ") {
                    if let Ok(v) = serde_json::from_str::<Value>(rest) {
                        result_json = Some(v);
                    }
                    continue;
                }
                out_buf.push_str(&t);
                out_buf.push('\n');
            }
        }
    }
    if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(l) = line {
                out_buf.push_str(&l);
                out_buf.push('\n');
            }
        }
    }
    let status = child.wait();
    let code = status.ok().and_then(|s| s.code()).unwrap_or(-1);
    children.lock().unwrap().remove(&child_key);

    match result_json {
        Some(v) => {
            let ok = v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
            let out = v.get("out").and_then(|x| x.as_str()).map(|s| s.to_string());
            let note_count = v
                .get("note_count")
                .and_then(|x| x.as_u64())
                .map(|n| n as usize);
            let error = v.get("error").and_then(|x| x.as_str()).map(|s| s.to_string());
            ConvertResult {
                ok,
                out,
                error,
                code: Some(code),
                note_count,
                extra: v,
            }
        }
        None => ConvertResult {
            ok: code == 0,
            out: None,
            error: Some(out_buf.trim().to_string()),
            code: Some(code),
            note_count: None,
            extra: json!({}),
        },
    }
}

// 取消转换（按 job id kill 对应子进程）
#[tauri::command]
pub fn cancel(app: AppHandle, state: State<'_, EngineState>, id: String) -> Value {
    let removed = {
        let mut m = state.children.lock().unwrap();
        let keys: Vec<String> = m
            .iter()
            .filter(|(k, _)| k.starts_with(&format!("{}_", id)))
            .map(|(k, _)| k.clone())
            .collect();
        for k in &keys {
            if let Some(pid) = m.remove(k) {
                let _ = kill_pid(pid);
            }
        }
        keys.len()
    };
    json!({ "ok": removed > 0 })
}

#[cfg(windows)]
fn kill_pid(pid: u32) -> Result<(), String> {
    std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn kill_pid(pid: u32) -> Result<(), String> {
    std::process::Command::new("kill")
        .arg(pid.to_string())
        .status()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// 引擎自检：python -c 版本探测
#[tauri::command]
pub async fn probe(app: AppHandle) -> Value {
    let py = resolve_python(&app);
    let eng = engine_dir(&app);
    let env = engine_env(&app);
    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        let mut cmd = std::process::Command::new(&py);
        cmd.args(["-c", "import sys,json;print(json.dumps({'py':sys.version.split()[0],'ok':True}))"])
            .current_dir(&eng)
            .envs(env)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let out = cmd.output();
        match out {
            Ok(o) => {
                let code = o.status.code().unwrap_or(-1);
                let stdout = String::from_utf8_lossy(&o.stdout).to_string();
                let stderr = String::from_utf8_lossy(&o.stderr).to_string();
                if code == 0 {
                    if let Ok(v) = serde_json::from_str::<Value>(stdout.trim()) {
                        let _ = tx.send(v);
                        return;
                    }
                }
                let _ = tx.send(json!({ "ok": false, "code": code, "error": stderr.trim() }));
            }
            Err(e) => {
                let _ = tx.send(json!({ "ok": false, "error": format!("无法启动 Python：{}", e) }));
            }
        }
    });
    rx.recv_timeout(std::time::Duration::from_secs(20))
        .unwrap_or_else(|_| json!({ "ok": false, "error": "探测超时" }))
}

// ---------- 公共工具：内联 Python 执行 / 引擎脚本执行 ----------
// 移植自 main/engine.js 的 runEngineInline / spawnEngine
#[derive(serde::Serialize)]
pub struct InlineResult {
    pub ok: bool,
    pub code: Option<i32>,
    pub out: String,
    pub error: Option<String>,
}

// 执行一段内联 Python（`python -c <code>`），用于 presets / video / wallpaper 等模块
pub fn run_inline_python(app: &AppHandle, code: &str) -> InlineResult {
    let py = resolve_python(app);
    let eng = engine_dir(app);
    let env = engine_env(app);
    let out = std::process::Command::new(&py)
        .arg("-c")
        .arg(code)
        .current_dir(&eng)
        .envs(env)
        .output();
    match out {
        Ok(o) => {
            let code_num = o.status.code();
            let stdout = String::from_utf8_lossy(&o.stdout).to_string();
            let stderr = String::from_utf8_lossy(&o.stderr).to_string();
            let mut merged = stdout.clone();
            if !stderr.trim().is_empty() {
                merged.push('\n');
                merged.push_str(&stderr);
            }
            InlineResult {
                ok: o.status.success(),
                code: code_num,
                out: merged,
                error: if o.status.success() { None } else { Some(stderr) },
            }
        }
        Err(e) => InlineResult {
            ok: false,
            code: Some(-1),
            out: String::new(),
            error: Some(format!("无法启动 Python：{}", e)),
        },
    }
}

// 解析 Python 输出的 JSON（取最后一个 {...} 块）
pub fn parse_py_json(out: &str) -> Option<Value> {
    let bytes = out.as_bytes();
    let mut best: Option<Value> = None;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            let mut depth = 0i32;
            let mut j = i;
            let mut in_str = false;
            let mut esc = false;
            while j < bytes.len() {
                let c = bytes[j];
                if in_str {
                    if esc {
                        esc = false;
                    } else if c == b'\\' {
                        esc = true;
                    } else if c == b'"' {
                        in_str = false;
                    }
                } else {
                    match c {
                        b'"' => in_str = true,
                        b'{' => depth += 1,
                        b'}' => {
                            depth -= 1;
                            if depth == 0 {
                                let slice = &out[i..=j];
                                if let Ok(v) = serde_json::from_str::<Value>(slice) {
                                    best = Some(v);
                                }
                                i = j;
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                j += 1;
            }
        }
        i += 1;
    }
    best
}

// 执行引擎脚本（deps.py / diag.py / smart_midi.py 等），返回 {ok, code, out, result}
pub fn run_engine_script(app: &AppHandle, script: &str, args: &[String]) -> Value {
    let py = resolve_python(app);
    let eng = engine_dir(app);
    let env = engine_env(app);
    let script_path = eng.join(script);
    let mut cmd = std::process::Command::new(&py);
    cmd.arg(script_path.to_string_lossy().to_string())
        .args(args)
        .current_dir(&eng)
        .envs(env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return json!({ "ok": false, "code": -1, "out": "", "err": format!("无法启动 Python：{}", e) });
        }
    };
    let mut out_buf = String::new();
    let mut err_buf = String::new();
    let mut result_json: Option<Value> = None;
    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(l) = line {
                let t = l.trim().to_string();
                if t.is_empty() {
                    continue;
                }
                if let Some(rest) = t.strip_prefix("###RESULT ") {
                    if let Ok(v) = serde_json::from_str::<Value>(rest) {
                        result_json = Some(v);
                    }
                    continue;
                }
                out_buf.push_str(&t);
                out_buf.push('\n');
            }
        }
    }
    if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(l) = line {
                err_buf.push_str(&l);
                err_buf.push('\n');
            }
        }
    }
    let status = child.wait();
    let code = status.ok().and_then(|s| s.code()).unwrap_or(-1);
    json!({
        "ok": code == 0,
        "code": code,
        "out": out_buf,
        "err": err_buf,
        "result": result_json,
    })
}

// ---------- 智能修正（smart_midi.py refine） ----------
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefineReq {
    id: Option<String>,
    audio: String,
    midi: String,
    out: Option<String>,
    mode: Option<String>,
    stem_balance: Option<bool>,
}

#[tauri::command]
pub async fn refine(
    app: AppHandle,
    state: State<'_, EngineState>,
    req: RefineReq,
) -> Result<Value, String> {
    let py = resolve_python(&app);
    let eng = engine_dir(&app);
    let env = engine_env(&app);
    let log_id = req.id.clone().unwrap_or_else(|| "job".into());
    let children = state.children.clone();
    let mut args: Vec<String> = vec![
        eng.join("smart_midi.py").to_string_lossy().to_string(),
        "refine".into(),
        "--audio".into(),
        req.audio.clone(),
        "--midi".into(),
        req.midi.clone(),
    ];
    let out = req
        .out
        .clone()
        .filter(|o| !o.is_empty())
        .unwrap_or_else(|| format!("{}_{}.mid", req.midi.trim_end_matches(".mid"), "refined"));
    args.push("-o".into());
    args.push(out.clone());
    if let Some(m) = &req.mode {
        if !m.is_empty() {
            args.push("--mode".into());
            args.push(m.clone());
        }
    }
    if let Some(sb) = req.stem_balance {
        args.push("--stem-balance".into());
        args.push(if sb { "on" } else { "off" }.into());
    }

    let handle = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(&py);
        cmd.args(&args)
            .current_dir(&eng)
            .envs(env)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                return json!({ "ok": false, "error": format!("无法启动 Python：{}", e) });
            }
        };
        let pid = child.id();
        let child_key = format!("{}_{}", log_id, pid);
        children.lock().unwrap().insert(child_key.clone(), pid);
        let mut out_buf = String::new();
        let mut result_json: Option<Value> = None;
        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(l) = line {
                    let t = l.trim().to_string();
                    if let Some(rest) = t.strip_prefix("###RESULT ") {
                        if let Ok(v) = serde_json::from_str::<Value>(rest) {
                            result_json = Some(v);
                        }
                        continue;
                    }
                    if !t.is_empty() {
                        out_buf.push_str(&t);
                        out_buf.push('\n');
                    }
                }
            }
        }
        if let Some(stderr) = child.stderr.take() {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(l) = line {
                    out_buf.push_str(&l);
                    out_buf.push('\n');
                }
            }
        }
        let status = child.wait();
        let code = status.ok().and_then(|s| s.code()).unwrap_or(-1);
        children.lock().unwrap().remove(&child_key);
        match result_json {
            Some(v) => {
                let mut base = v;
                base["ok"] = json!(base.get("ok").and_then(|x| x.as_bool()).unwrap_or(code == 0));
                if base.get("out").is_none() {
                    base["out"] = json!(out);
                }
                base
            }
            None => json!({ "ok": code == 0, "out": out, "error": out_buf.trim().to_string() }),
        }
    });
    handle.await.map_err(|e| e.to_string())
}
