//! S6 资源扩展命令：声库 / 音色 / 插件 / GPU / OMR / 依赖安装。
//!
//! 这些命令在 main.rs 里各有一个薄包装，实现集中在本文件，便于与 model_service 分开维护。
//! 所有网络下载都必须显示进度、可取消，并在完成后做尺寸/标记校验。
//!
//! # 线程模型（决定了返回契约）
//!
//! main.rs 里的包装函数标了 #[tauri::command(async)]（S6 期间由 lead 统一改）：
//! 同步函数体跑在线程池上，**不会阻塞主线程**。因此这里的命令一律是「阻塞式最终返回」，
//! 与 Electron 语义一致：下载/安装等完成后直接返回 {ok:true,...} 或 {ok:false,error,canceled}；
//! 进度照旧用 Electron 同名事件推送；取消命令由另一个线程并发执行，仍然生效。
//!
//! 实现方式：命令在后台线程跑真正的活（下载/解包/pip），工作线程负责发进度事件，
//! 命令线程等它完成并返回终态对象。工作线程结束时也会把终态对象发一条 done:true 事件，
//! 供只监听事件的界面使用。
//!
//! # 事件通道（与 Electron 主进程同名）
//! sf-workshop:progress · utau:voicebankProgress · gpu:progress · omr:progress
//!
//! # 硬约束
//! 所有子进程（curl / python / pip / msiexec / powershell）都用 CREATE_NO_WINDOW(0x08000000)
//! 隐藏窗口；下载先写 *.part，校验通过后才原子改名；错误信息带阶段与来源，便于定位。

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::{apply_engine_env, data_dir, engine_dir, python_path};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 给外部命令加 Windows 隐藏窗口标志（Electron 侧对应 spawn({ windowsHide: true })）。
fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn file_len(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

fn tail_chars(s: &str, n: usize) -> String {
    let v: Vec<char> = s.chars().collect();
    v[v.len().saturating_sub(n)..].iter().collect()
}

fn sha256_file(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Some(format!("{:x}", h.finalize()))
}

/// 目录总字节数（不跟随符号链接，深度上限兜底；坏项跳过）。
fn dir_size(p: &Path) -> u64 {
    fn walk(p: &Path, depth: u32) -> u64 {
        if depth > 64 {
            return 0;
        }
        let Ok(rd) = std::fs::read_dir(p) else {
            return 0;
        };
        let mut total = 0u64;
        for e in rd.flatten() {
            let path = e.path();
            let Ok(md) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if md.file_type().is_symlink() {
                continue;
            }
            if md.is_dir() {
                total += walk(&path, depth + 1);
            } else {
                total += md.len();
            }
        }
        total
    }
    walk(p, 0)
}

/// 文件名消毒：去路径分隔符 / 非法字符 / 前后点，空则用兜底名。
fn safe_file_name(name: &str, fallback: &str) -> String {
    let base: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if (c as u32) < 32 => '_',
            c => c,
        })
        .collect();
    let t = base.trim().trim_matches('.').trim();
    if t.is_empty() {
        fallback.to_string()
    } else {
        t.to_string()
    }
}

fn read_json_file(p: &Path) -> Value {
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| json!({}))
}

fn write_json_file(p: &Path, v: &Value) -> Result<(), String> {
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(p, serde_json::to_string_pretty(v).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// 设置文件位置（与 main.rs 的 settings_path() 同一套回退顺序）。
fn settings_file() -> PathBuf {
    if let Ok(p) = std::env::var("FUFUMIDI_SETTINGS_FILE") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    let overridden = std::env::var("FUFUMIDI_DATA_ROOT")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    if !overridden {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let p = PathBuf::from(appdata)
                .join("FuFumidi")
                .join("fufumidi")
                .join("settings.json");
            if p.is_file() {
                return p;
            }
        }
    }
    data_dir().join("settings.json")
}

fn prefer_cnb() -> bool {
    let s = read_json_file(&settings_file());
    !matches!(
        s.get("download_source")
            .and_then(|v| v.as_str())
            .map(|v| v.to_ascii_lowercase())
            .as_deref(),
        Some("github")
    )
}

fn copy_tree(src: &Path, dst: &Path) -> Result<u64, String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建目录 {}：{e}", dst.display()))?;
    let mut total = 0u64;
    for e in std::fs::read_dir(src)
        .map_err(|e| format!("读取目录 {}：{e}", src.display()))?
        .flatten()
    {
        let from = e.path();
        let to = dst.join(e.file_name());
        let md = std::fs::symlink_metadata(&from).map_err(|e| e.to_string())?;
        if md.file_type().is_symlink() {
            continue;
        }
        if md.is_dir() {
            total += copy_tree(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| format!("复制 {}：{e}", from.display()))?;
            total += md.len();
        }
    }
    Ok(total)
}

fn remove_path(p: &Path) {
    if p.is_dir() {
        let _ = std::fs::remove_dir_all(p);
    } else if p.exists() {
        let _ = std::fs::remove_file(p);
    }
}

fn unique_stamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/* ================================ 后台任务 ================================ */

/// 一个可取消的后台任务：保住进行中的子进程，取消 = 置标记（工作线程在 250ms 内 kill）。
struct Job {
    id: String,
    canceled: AtomicBool,
    child: Mutex<Option<Child>>,
}

impl Job {
    fn new(id: &str) -> Arc<Job> {
        Arc::new(Job {
            id: id.to_string(),
            canceled: AtomicBool::new(false),
            child: Mutex::new(None),
        })
    }
    fn is_canceled(&self) -> bool {
        self.canceled.load(Ordering::SeqCst)
    }
    fn cancel(&self) {
        self.canceled.store(true, Ordering::SeqCst);
    }
    fn set_child(&self, c: Child) {
        *self.child.lock().unwrap_or_else(|e| e.into_inner()) = Some(c);
    }
    fn take_child(&self) -> Option<Child> {
        self.child.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
    fn kill_child(&self) {
        if let Some(mut c) = self.take_child() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

fn job_map() -> &'static Mutex<HashMap<String, Arc<Job>>> {
    static MAP: OnceLock<Mutex<HashMap<String, Arc<Job>>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 同一 id 只允许一个进行中的任务；已存在返回 None。
fn job_begin(id: &str) -> Option<Arc<Job>> {
    let mut g = job_map().lock().unwrap_or_else(|e| e.into_inner());
    if g.contains_key(id) {
        return None;
    }
    let job = Job::new(id);
    g.insert(id.to_string(), job.clone());
    Some(job)
}

fn job_end(id: &str) {
    job_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(id);
}

/// 任务槽的 Drop 守卫：工作线程即使 panic 也会把槽位释放，不会让界面永远显示「正在进行中」。
struct JobGuard(String);

impl Drop for JobGuard {
    fn drop(&mut self) {
        job_end(&self.0);
    }
}

fn job_cancel(id: &str) -> bool {
    let g = job_map().lock().unwrap_or_else(|e| e.into_inner());
    match g.get(id) {
        Some(j) => {
            j.cancel();
            true
        }
        None => false,
    }
}

/// 在后台线程执行 work 并**等它结束**，返回终态对象。
///
/// main.rs 的包装是 async 命令，所以这里阻塞的是线程池线程而不是主线程：
/// 进度事件照常到达 WebView，取消命令也能并发执行（它只需给 Job 置标记）。
/// work 的返回值就是终态对象；终态统一补 id 与 done:true 后 emit 到 event。
fn run_job<F>(app: &AppHandle, job: Arc<Job>, event: &'static str, work: F) -> Value
where
    F: FnOnce(&AppHandle, &Arc<Job>) -> Value + Send + 'static,
{
    let app2 = app.clone();
    let job2 = job.clone();
    let (tx, rx) = mpsc::channel::<Value>();
    let jid = job.id.clone();
    let spawned = std::thread::Builder::new()
        .name("fufumidi-resource".into())
        .spawn(move || {
            let _guard = JobGuard(job2.id.clone());
            let mut v = work(&app2, &job2);
            if let Some(o) = v.as_object_mut() {
                o.insert("id".to_string(), Value::String(job2.id.clone()));
                o.insert("done".to_string(), Value::Bool(true));
            }
            let _ = app2.emit(event, v.clone());
            let _ = tx.send(v);
        });
    if spawned.is_err() {
        job_end(&jid);
        return json!({ "ok": false, "error": "无法创建后台线程" });
    }
    match rx.recv() {
        Ok(v) => v,
        Err(_) => json!({ "ok": false, "error": "后台任务异常结束（工作线程没有返回结果）" }),
    }
}

/// 进度事件发送器：base 是每条事件都带的固定字段（id/phase/…）。
#[derive(Clone)]
struct Peer {
    app: AppHandle,
    event: &'static str,
    base: Map<String, Value>,
}

impl Peer {
    fn new(app: &AppHandle, event: &'static str, base: Value) -> Peer {
        Peer {
            app: app.clone(),
            event,
            base: base.as_object().cloned().unwrap_or_default(),
        }
    }
    fn send_extra(&self, received: u64, total: u64, percent: u8, done: bool, extra: Value) {
        let mut v = self.base.clone();
        if let Some(o) = extra.as_object() {
            for (k, x) in o {
                v.insert(k.clone(), x.clone());
            }
        }
        v.insert("received".to_string(), json!(received));
        v.insert("total".to_string(), json!(total));
        v.insert("percent".to_string(), json!(percent));
        v.insert("done".to_string(), json!(done));
        let _ = self.app.emit(self.event, Value::Object(v));
    }
    fn send(&self, received: u64, total: u64, percent: u8, done: bool) {
        self.send_extra(received, total, percent, done, Value::Null);
    }
}

/* ================================ 网络 ================================ */

fn curl_text(url: &str, timeout_secs: u64, headers: &[&str]) -> Result<String, String> {
    let t = timeout_secs.to_string();
    let mut cmd = Command::new("curl.exe");
    hidden(&mut cmd)
        .args([
            "--ssl-no-revoke",
            "-sS",
            "-L",
            "-m",
            t.as_str(),
            "-H",
            "User-Agent: FuFumidi",
        ])
        .args(headers)
        .arg(url)
        .stdin(Stdio::null());
    let out = cmd
        .output()
        .map_err(|e| format!("无法启动 curl.exe：{e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "curl 失败（{}）：{}",
            url,
            tail_chars(err.trim(), 200)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn http_json(url: &str, timeout_secs: u64, headers: &[&str]) -> Result<Value, String> {
    let text = curl_text(url, timeout_secs, headers)?;
    serde_json::from_str::<Value>(&text).map_err(|e| format!("JSON 解析失败（{url}）：{e}"))
}

/// HEAD 探测 Content-Length（重定向链取最后一条）。只用于进度百分比，失败就返回 None。
fn http_head_total(url: &str) -> Option<u64> {
    let mut cmd = Command::new("curl.exe");
    hidden(&mut cmd).args([
        "--ssl-no-revoke",
        "-sS",
        "-L",
        "-I",
        "-m",
        "15",
        "-H",
        "User-Agent: FuFumidi",
        url,
    ]);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    text.lines().rev().find_map(|l| {
        let low = l.trim().to_ascii_lowercase();
        low.strip_prefix("content-length:")
            .and_then(|v| v.trim().parse::<u64>().ok())
    })
}

/// 从引擎输出里取 ###RESULT {…}（与 main/engine.js 的协议一致）。
fn parse_result_json(stdout: &str) -> Option<Value> {
    stdout.lines().rev().find_map(|l| {
        l.trim()
            .strip_prefix("###RESULT ")
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
    })
}

/// 把 JSON 里的字节数组（Tauri IPC 把 Uint8Array 序列化成 number[]）转成 Vec<u8>。
fn json_bytes(v: &Value) -> Vec<u8> {
    match v {
        Value::Array(a) => a
            .iter()
            .filter_map(|x| x.as_u64().map(|n| n as u8))
            .collect(),
        Value::String(s) => s.as_bytes().to_vec(),
        // Tauri IPC 用 JSON 序列化，Uint8Array 会变成 {"0":12,"1":34,…}（不是数组）。
        Value::Object(o) => {
            let mut pairs: Vec<(usize, u8)> = Vec::new();
            for (k, x) in o {
                if let (Ok(i), Some(n)) = (k.parse::<usize>(), x.as_u64()) {
                    pairs.push((i, n as u8));
                }
            }
            pairs.sort_by_key(|(i, _)| *i);
            pairs.into_iter().map(|(_, b)| b).collect()
        }
        _ => Vec::new(),
    }
}

fn run_python_inline(code: &str) -> Result<(bool, String, String), String> {
    let py = python_path().ok_or("python runtime not found")?;
    let mut cmd = Command::new(&py);
    if let Some(eng) = engine_dir() {
        cmd.current_dir(eng);
    }
    cmd.args(["-c", code]).stdin(Stdio::null());
    apply_engine_env(&mut cmd);
    let out = cmd.output().map_err(|e| format!("无法启动 python：{e}"))?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
    ))
}

/* ================================ 下载核心 ================================ */

#[derive(Debug)]
enum JobFail {
    Canceled,
    Failed(String),
}

fn part_of(dest: &Path) -> PathBuf {
    PathBuf::from(format!("{}.part", dest.display()))
}

fn local_percent(received: u64, total: u64, cap: u8) -> u8 {
    if total == 0 {
        return 0;
    }
    let p = (received as f64 / total as f64) * 100.0;
    let p = if p.is_finite() { p } else { 0.0 };
    (p as u8).min(cap)
}

fn speed_text(label: &str, speed: u64) -> String {
    if speed >= 1_000_000 {
        format!("{label} · {:.1} MB/s", speed as f64 / 1e6)
    } else if speed >= 1000 {
        format!("{label} · {} KB/s", speed / 1000)
    } else {
        label.to_string()
    }
}

struct DlSpec<'a> {
    urls: &'a [String],
    dest: &'a Path,
    label: &'a str,
    min_size: u64,
    max_size: u64,
    /// 声明的总字节（0 = 未知，会探测 HEAD）；只用于进度与可选严格校验。
    expect_total: u64,
    verify_exact: bool,
    pct_lo: u8,
    pct_hi: u8,
}

/// 多源下载到 dest：先写 dest.part（curl -C - 断点续传），按 min/max 校验后原子改名。
/// 取消时保留 .part（与 Electron 一致：再点一次从断点继续）。
fn dl_download(job: &Arc<Job>, peer: Option<&Peer>, spec: &DlSpec) -> Result<u64, JobFail> {
    if spec.urls.is_empty() {
        return Err(JobFail::Failed("没有可用的下载地址".to_string()));
    }
    if let Some(parent) = spec.dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let part = part_of(spec.dest);
    // 总字节优先问服务器（Content-Length 是事实；注册表里的 size 只是展示用估计值）。
    let mut total = 0u64;
    for u in spec.urls.iter().take(2) {
        if let Some(n) = http_head_total(u) {
            if n > 0 {
                total = n;
                break;
            }
        }
    }
    if total == 0 {
        total = spec.expect_total;
    }
    let span = u32::from(spec.pct_hi.saturating_sub(spec.pct_lo)).max(1);
    let map_pct = |local: u8| -> u8 {
        let v = u32::from(spec.pct_lo) + u32::from(local) * span / 100;
        v.min(u32::from(spec.pct_hi)) as u8
    };
    let mut have = file_len(&part);
    if total > 0 && have > total {
        remove_path(&part);
        have = 0;
    }
    let already = total > 0 && have >= total;
    if !already {
        let mut ok = false;
        let mut last_err = String::new();
        'outer: for round in 0..2 {
            for (i, url) in spec.urls.iter().enumerate() {
                if job.is_canceled() {
                    job.kill_child();
                    return Err(JobFail::Canceled);
                }
                let have_now = file_len(&part);
                if let Some(p) = peer {
                    p.send_extra(
                        have_now,
                        total,
                        map_pct(local_percent(have_now, total, 99)),
                        false,
                        json!({ "text": spec.label }),
                    );
                }
                let mut cmd = Command::new("curl.exe");
                hidden(&mut cmd)
                    .args([
                        "--ssl-no-revoke",
                        "-L",
                        "--fail",
                        "--silent",
                        "--show-error",
                        "--retry",
                        "2",
                        "--retry-delay",
                        "1",
                        "--connect-timeout",
                        "20",
                        "--speed-limit",
                        "102400",
                        "--speed-time",
                        "60",
                        "-C",
                        "-",
                        "-o",
                    ])
                    .arg(&part)
                    .arg(url)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::piped());
                let child = match cmd.spawn() {
                    Ok(c) => c,
                    Err(e) => {
                        last_err = format!("无法启动 curl.exe：{e}");
                        continue;
                    }
                };
                job.set_child(child);
                let mut last_emit = Instant::now();
                let mut last_t = Instant::now();
                let mut last_n = file_len(&part);
                let mut status: Option<std::process::ExitStatus> = None;
                loop {
                    if job.is_canceled() {
                        job.kill_child();
                        return Err(JobFail::Canceled);
                    }
                    let mut done = None;
                    {
                        let mut g = job.child.lock().unwrap_or_else(|e| e.into_inner());
                        if let Some(c) = g.as_mut() {
                            match c.try_wait() {
                                Ok(Some(st)) => done = Some(Ok(st)),
                                Ok(None) => {}
                                Err(e) => done = Some(Err(e.to_string())),
                            }
                        }
                    }
                    match done {
                        Some(Ok(st)) => {
                            status = Some(st);
                            break;
                        }
                        Some(Err(_)) => break,
                        None => {}
                    }
                    std::thread::sleep(Duration::from_millis(250));
                    let n = file_len(&part);
                    if last_emit.elapsed() >= Duration::from_millis(400) {
                        let dt = last_t.elapsed().as_secs_f64().max(0.001);
                        let speed = ((n.saturating_sub(last_n)) as f64 / dt) as u64;
                        last_t = Instant::now();
                        last_n = n;
                        last_emit = Instant::now();
                        if let Some(p) = peer {
                            p.send_extra(
                                n,
                                total,
                                map_pct(local_percent(n, total, 99)),
                                false,
                                json!({ "speed": speed, "text": speed_text(spec.label, speed) }),
                            );
                        }
                    }
                }
                // 子进程已被 try_wait 回收：把它从槽里拿出来，避免取消时误杀
                drop(job.take_child());
                match status {
                    Some(st) if st.success() => {
                        ok = true;
                        break 'outer;
                    }
                    Some(st) => last_err = format!("curl 退出码 {}", st.code().unwrap_or(-1)),
                    None => last_err = "curl 异常退出".to_string(),
                }
                if i + 1 < spec.urls.len() {
                    let n = file_len(&part);
                    if let Some(p) = peer {
                        p.send_extra(
                            n,
                            total,
                            map_pct(local_percent(n, total, 99)),
                            false,
                            json!({
                                "retrying": true,
                                "round": round + 1,
                                "retry": round + 1,
                                "notice": format!("源 {}/{} 未完成，换下一个源…", i + 1, spec.urls.len()),
                            }),
                        );
                    }
                }
            }
        }
        if !ok {
            let n = file_len(&part);
            let hint = if n > 0 {
                format!("（已保留 {n} 字节断点，再次下载会从断点继续）")
            } else {
                "（可检查网络/代理后重试）".to_string()
            };
            return Err(JobFail::Failed(if last_err.is_empty() {
                format!("所有下载源都失败{hint}")
            } else {
                format!("{last_err}{hint}")
            }));
        }
    }
    let n = file_len(&part);
    if n == 0 {
        remove_path(&part);
        return Err(JobFail::Failed(
            "下载内容为空（网络受限或文件被拦截）".to_string(),
        ));
    }
    if n < spec.min_size {
        // 已拿满服务器声明的长度却仍然过小 → 内容本身不对（典型：tessdata_fast 冒充完整版），
        // 断点没有意义，直接清掉；否则保留断点供续传。
        if total > 0 && n >= total {
            remove_path(&part);
        }
        return Err(JobFail::Failed(format!(
            "下载文件不完整：{n} 字节 < 最小 {} 字节",
            spec.min_size
        )));
    }
    if spec.max_size != u64::MAX && n > spec.max_size {
        remove_path(&part);
        return Err(JobFail::Failed(format!(
            "下载文件过大：{n} 字节 > 上限 {} 字节（可能是代理返回了错误页）",
            spec.max_size
        )));
    }
    if spec.verify_exact && total > 0 && n != total {
        remove_path(&part);
        return Err(JobFail::Failed(format!(
            "下载大小不符：{n}/{total} 字节{}",
            if n < total { "（被截断）" } else { "" }
        )));
    }
    if spec.dest.exists() {
        remove_path(spec.dest);
    }
    std::fs::rename(&part, spec.dest)
        .map_err(|e| JobFail::Failed(format!("落盘失败 {}：{e}", spec.dest.display())))?;
    Ok(n)
}

/* ================================ zip / 解包 ================================ */

/// 压缩包条目名是否不安全（绝对路径 / 盘符 / .. 穿越）。本地导入也必须过这一层。
fn zip_entry_unsafe(name: &str) -> bool {
    let n = name.replace('\\', "/");
    if n.is_empty() {
        return true;
    }
    if n.starts_with('/') {
        return true;
    }
    let b = n.as_bytes();
    if b.len() >= 2 && b[1] == b':' {
        return true;
    }
    n.split('/').any(|c| c == "..")
}

/// 安全解压：拒绝越界路径，跳过 __MACOSX，支持取消。返回写出的文件数。
fn safe_extract_zip(
    archive: &Path,
    dest: &Path,
    job: Option<&Arc<Job>>,
    skip_top: bool,
) -> Result<usize, String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("打开压缩包失败：{e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("不是有效的 ZIP：{e}"))?;
    if zip.len() > 300_000 {
        return Err(format!("压缩包条目过多（{}）", zip.len()));
    }
    std::fs::create_dir_all(dest).map_err(|e| format!("创建解压目录失败：{e}"))?;
    let mut count = 0usize;
    for i in 0..zip.len() {
        if let Some(j) = job {
            if j.is_canceled() {
                return Err("__canceled".to_string());
            }
        }
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let raw = entry.name().replace('\\', "/");
        if raw.starts_with("__MACOSX/") {
            continue;
        }
        let mut rel = raw.clone();
        if skip_top {
            match rel.find('/') {
                Some(idx) => rel = rel[idx + 1..].to_string(),
                None => continue,
            }
        }
        if rel.is_empty() {
            continue;
        }
        if zip_entry_unsafe(&rel) {
            return Err(format!("压缩包含不安全路径：{raw}"));
        }
        let is_dir = entry.is_dir() || rel.ends_with('/');
        let out = dest.join(rel.trim_end_matches('/'));
        if is_dir {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut f = std::fs::File::create(&out).map_err(|e| format!("写入 {}：{e}", out.display()))?;
        std::io::copy(&mut entry, &mut f).map_err(|e| format!("解压 {}：{e}", out.display()))?;
        count += 1;
    }
    Ok(count)
}

/// 在目录（含子目录，深度 ≤ max_depth）里找名为 name 的子目录（如 site-packages）。
fn find_subdir(root: &Path, name: &str, max_depth: u32) -> Option<PathBuf> {
    fn walk(dir: &Path, name: &str, depth: u32, max_depth: u32) -> Option<PathBuf> {
        if depth > max_depth {
            return None;
        }
        if dir.join(name).is_dir() {
            return Some(dir.join(name));
        }
        let rd = std::fs::read_dir(dir).ok()?;
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                if let Some(hit) = walk(&p, name, depth + 1, max_depth) {
                    return Some(hit);
                }
            }
        }
        None
    }
    walk(root, name, 0, max_depth)
}

/* ================================ 依赖安装 ================================ */

const DEP_GROUPS: [&str; 7] = [
    "universal",
    "piano",
    "separate",
    "muscriptor",
    "aria",
    "transkun",
    "all",
];

/// 运行期依赖安装：deps.py install --group <group>，返回其 ###RESULT JSON。
///
/// 对齐 main/diagnostics.js 的 dep:install：Electron 侧没有进度事件，这里同样只回最终 JSON。
pub fn dep_install(_app: &AppHandle, group: Option<String>) -> Value {
    let Some(py) = python_path() else {
        return json!({ "ok": false, "error": "python runtime not found" });
    };
    let Some(eng) = engine_dir() else {
        return json!({ "ok": false, "error": "engine directory not found（engine/music2midi.py 不存在）" });
    };
    let g = group
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "all".to_string());
    if !DEP_GROUPS.contains(&g.as_str()) {
        return json!({
            "ok": false,
            "error": format!("未知依赖组：{g}"),
            "groups": DEP_GROUPS,
        });
    }
    let mut cmd = Command::new(&py);
    cmd.current_dir(&eng)
        .args(["deps.py", "install", "--group", &g])
        .stdin(Stdio::null());
    apply_engine_env(&mut cmd);
    let out = match cmd.output() {
        Ok(o) => o,
        Err(e) => return json!({ "ok": false, "error": format!("无法启动 deps.py：{e}"), "group": g }),
    };
    let ok_status = out.status.success();
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let raw = if stderr.trim().is_empty() {
        tail_chars(&stdout, 2000)
    } else {
        tail_chars(&stderr, 2000)
    };
    match parse_result_json(&stdout) {
        Some(v) => {
            let deps_ok = v.get("ok").and_then(|x| x.as_bool()).unwrap_or(true);
            json!({
                "ok": ok_status && deps_ok,
                "group": g,
                "result": v,
                "raw": raw,
            })
        }
        None => json!({
            "ok": false,
            "group": g,
            "error": if ok_status {
                "deps.py 没有输出 ###RESULT（安装结果未知）".to_string()
            } else {
                format!("deps.py 执行失败（退出码 {:?}）", out.status.code())
            },
            "raw": raw,
        }),
    }
}

/* ================================ 音色工坊 ================================ */

const SF_EVENT: &str = "sf-workshop:progress";

fn sf_registry_items() -> Vec<Value> {
    serde_json::from_str::<Vec<Value>>(include_str!("soundfont_registry.json")).unwrap_or_default()
}

fn sf_find(id: &str) -> Option<Value> {
    sf_registry_items()
        .into_iter()
        .find(|x| x["id"].as_str() == Some(id))
}

/// 目标文件名：fileName → repoFile → 显示名消毒 + .sf2（与 main.rs 的 sf_file_name 一致）。
fn sf_file_name(it: &Value) -> String {
    for key in ["fileName", "repoFile"] {
        if let Some(s) = it.get(key).and_then(|v| v.as_str()) {
            if !s.trim().is_empty() {
                return s.trim().to_string();
            }
        }
    }
    let name = it.get("name").and_then(|v| v.as_str()).unwrap_or("soundfont");
    format!("{}.sf2", safe_file_name(name, "soundfont"))
}

fn bundled_soundfont(name: &str) -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if cfg!(debug_assertions) {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        cands.push(root.join("renderer/vendor/soundfonts").join(name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            cands.push(dir.join("resources/soundfonts").join(name));
            cands.push(dir.join("soundfonts").join(name));
        }
    }
    cands.into_iter().find(|p| p.is_file())
}

/// 注册表条目的本地目标路径 + 是否随包内置。
fn sf_local_path(it: &Value) -> (PathBuf, bool) {
    let fname = sf_file_name(it);
    let bundled_path = it.get("bundledPath").and_then(|v| v.as_str()).unwrap_or("");
    if !bundled_path.is_empty() {
        match bundled_soundfont(&fname) {
            Some(p) => return (p, true),
            None => return (PathBuf::new(), true),
        }
    }
    (data_dir().join("soundfonts").join(fname), false)
}

fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn sf_github_raw_candidates(it: &Value) -> Vec<String> {
    const HOSTS: [&str; 4] = [
        "https://gh.jasonzeng.dev/https://raw.githubusercontent.com",
        "https://raw.githubusercontent.com",
        "https://ghfast.top/https://raw.githubusercontent.com",
        "https://gh-proxy.com/https://raw.githubusercontent.com",
    ];
    let repo = match it.get("fromRepo").and_then(|v| v.as_str()) {
        Some(r) if !r.is_empty() => r,
        _ => return Vec::new(),
    };
    let file = match it.get("repoFile").and_then(|v| v.as_str()) {
        Some(f) if !f.is_empty() => f,
        _ => return Vec::new(),
    };
    let enc = file
        .split('/')
        .map(url_encode)
        .collect::<Vec<_>>()
        .join("/");
    HOSTS
        .iter()
        .map(|h| format!("{h}/{repo}/main/{enc}"))
        .collect()
}

/// 把候选地址按下载源偏好重排：国内优先 → cnb.cool 打头；全球优先 → cnb.cool 压尾。
/// （生成脚本里已按默认偏好排过一次，这里保证运行期改设置也生效。）
fn order_by_preference(urls: &[String], cnb_first: bool) -> Vec<String> {
    let (cnb, others): (Vec<String>, Vec<String>) = urls
        .iter()
        .cloned()
        .partition(|u| u.contains("cnb.cool/"));
    let mut out: Vec<String> = Vec::new();
    let push = |u: String, out: &mut Vec<String>| {
        if !u.is_empty() && !out.iter().any(|x| x == &u) {
            out.push(u);
        }
    };
    if cnb_first {
        for u in cnb {
            push(u, &mut out);
        }
        for u in others {
            push(u, &mut out);
        }
    } else {
        for u in others {
            push(u, &mut out);
        }
        for u in cnb {
            push(u, &mut out);
        }
    }
    out
}

fn sf_candidate_urls(it: &Value) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    if let Some(a) = it.get("urls").and_then(|v| v.as_array()) {
        for u in a {
            if let Some(s) = u.as_str() {
                if !s.trim().is_empty() && !urls.iter().any(|x| x == s) {
                    urls.push(s.to_string());
                }
            }
        }
    }
    for u in sf_github_raw_candidates(it) {
        if !urls.iter().any(|x| x == &u) {
            urls.push(u);
        }
    }
    order_by_preference(&urls, prefer_cnb())
}

fn sf_min_max(it: &Value) -> (u64, u64) {
    let min = it.get("minSize").and_then(|v| v.as_u64()).unwrap_or(0);
    let max = it.get("maxSize").and_then(|v| v.as_u64()).unwrap_or(u64::MAX);
    (min, max)
}

/// 下载一个注册表音色库；返回终态（同步等待）。终态事件 {done:true, ok, path, size}。
pub fn sf_workshop_download(app: &AppHandle, id: String) -> Value {
    let Some(it) = sf_find(&id) else {
        return json!({ "ok": false, "error": format!("未知音色库: {id}") });
    };
    if it.get("manual").and_then(|v| v.as_bool()).unwrap_or(false) {
        return json!({
            "ok": false,
            "manual": true,
            "officialUrl": it.get("officialUrl").and_then(|v| v.as_str()).unwrap_or(""),
            "error": "该音色受作者许可条款限制，不提供自动下载。请前往官网下载并解压，再通过「导入 .sf2 音色」导入。",
        });
    }
    let (min, max) = sf_min_max(&it);
    let (dest, builtin) = sf_local_path(&it);
    if builtin && dest.as_os_str().is_empty() {
        return json!({
            "ok": false,
            "error": "该音色库随安装包分发，但当前安装里找不到它（resources/soundfonts）。请重装应用，或从官网下载后手动导入 .sf2。",
        });
    }
    let cur = file_len(&dest);
    let complete = cur >= min && cur <= max;
    if complete {
        let peer = Peer::new(app, SF_EVENT, json!({ "id": id }));
        peer.send(cur, cur, 100, true);
        return json!({
            "ok": true, "existed": true, "path": dest.display().to_string(), "size": cur,
        });
    }
    if !builtin && cur > 0 {
        // 不合格的旧文件（旧版本 / 截断 / 过大）先删，否则新文件写不进去
        remove_path(&dest);
    }
    let urls = sf_candidate_urls(&it);
    if urls.is_empty() {
        return json!({
            "ok": false,
            "error": "注册表里没有可用下载地址（请运行 node scripts/tauri/gen-soundfont-registry.mjs 重新生成 soundfont_registry.json）",
        });
    }
    let Some(job) = job_begin(&id) else {
        return json!({ "ok": false, "error": "该音色库正在下载中", "id": id });
    };
    let name = it
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(&id)
        .to_string();
    let total_hint = it.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
    let jid = id.clone();
    let app2 = app.clone();
    run_job(&app2, job, SF_EVENT, move |app3, job3| {
        let peer = Peer::new(app3, SF_EVENT, json!({ "id": jid, "text": name }));
        let spec = DlSpec {
            urls: &urls,
            dest: &dest,
            label: &name,
            min_size: min,
            max_size: max,
            expect_total: total_hint,
            verify_exact: false,
            pct_lo: 0,
            pct_hi: 99,
        };
        match dl_download(job3, Some(&peer), &spec) {
            Ok(n) => json!({
                "ok": true,
                "path": dest.display().to_string(),
                "size": n,
                "name": name,
            }),
            Err(JobFail::Canceled) => {
                peer.send_extra(0, 0, 0, true, json!({ "canceled": true, "error": "已取消" }));
                json!({ "ok": false, "canceled": true, "error": "已取消（断点已保留，再点下载会继续）" })
            }
            Err(JobFail::Failed(e)) => {
                json!({ "ok": false, "error": format!("自动下载失败：{e}。可在「我的音色」用 .sf2 手动导入。") })
            }
        }
    })
}

pub fn sf_workshop_cancel(id: String) -> Value {
    if job_cancel(&id) {
        json!({ "ok": true, "aborted": true })
    } else {
        json!({ "ok": false, "error": "该音色当前没有进行中的下载" })
    }
}

/* ================================ UTAU 声库 ================================ */

const VB_EVENT: &str = "utau:voicebankProgress";

struct VbEntry {
    id: &'static str,
    dir_name: &'static str,
    name: &'static str,
    author: &'static str,
    lang: &'static str,
    desc: &'static str,
    license: &'static str,
    repo: &'static str,
    git_ref: &'static str,
    subdir: &'static str,
    official_url: &'static str,
}

/// 与 main/utau.js 的 VB_REGISTRY 一一对应（开源/免费，按需从上游 GitHub 归档拉取）。
const VB_REGISTRY: [VbEntry; 4] = [
    VbEntry {
        id: "iona",
        dir_name: "Iona_Beta",
        name: "Iona Beta",
        author: "titinko",
        lang: "日本語 · 単独音（CV）",
        desc: "开源 UTAU 编辑器 utsu 自带的测试声库：日文单音（CV）覆盖完整、发音干净，体积适中，适合快速试听与调声练习。",
        license: "MIT 许可 · 可自由使用/修改/再分发（保留版权声明）",
        repo: "titinko/utsu",
        git_ref: "master",
        subdir: "src/main/resources/assets/sounds/Iona_Beta",
        official_url: "https://github.com/titinko/utsu",
    },
    VbEntry {
        id: "howhow",
        dir_name: "HowHow_CV",
        name: "HowHow（中文扩张整音）",
        author: "Hugwalk / EarlySpringCommitee",
        lang: "中文 · 擴張整音（獨立音 + 語尾）",
        desc: "中文扩张整音声库：音头用独立音（如 kai、bei），语尾用「_韵母」或「韵母 R」，中文演唱自然度较高。",
        license: "免费使用 · 禁止商用（HowFun 官方标准，使用须标注作者 Hugwalk）",
        repo: "EarlySpringCommitee/HowHow-UTAU",
        git_ref: "master",
        subdir: "CV",
        official_url: "https://github.com/EarlySpringCommitee/HowHow-UTAU",
    },
    VbEntry {
        id: "chenzhe",
        dir_name: "ChenZhe_Voice",
        name: "陈者（中文单独音）",
        author: "ciwomuli",
        lang: "中文 · 单独音（CV）",
        desc: "中文单音声库，音节覆盖常见汉字读音、单文件体积小，适合中文曲目的快速试唱。",
        license: "作者公开发布 · 仅供个人学习与非商用（版权归作者）",
        repo: "ciwomuli/chen_zhe_voice",
        git_ref: "master",
        subdir: "",
        official_url: "https://github.com/ciwomuli/chen_zhe_voice",
    },
    VbEntry {
        id: "milk",
        dir_name: "Milk_JA",
        name: "Milk（日文 VCV · 6 音阶）",
        author: "Xepheris（本仓为 oxygen-dioxide 的未改动镜像）",
        lang: "日本語 · VCV（連続音 · 6 音階）",
        desc: "日文连续音（VCV）6 音阶：A3 / D4 / F3 / G4 / PowerC5 / Falsetto，另带换气音。仓根有 character.txt 与 oto.ini，多音阶按 prefix.map 自动分派，适合正经调声而不是试听。",
        license: "免费使用 · 允许无需许可再分发（Milk Voicebank Terms of Use）；须标注声库名与作者。本仓为未改动镜像。",
        repo: "oxygen-dioxide/milk-ja",
        git_ref: "main",
        subdir: "",
        official_url: "https://github.com/oxygen-dioxide/milk-ja",
    },
];

/// 渠道索引：绝大多数免费声库不在 GitHub 上（BOOTH / BowlRoll / 官网 / 网盘），
/// 这里只负责「告诉用户去哪儿找」，不假装能一键下载（与 Electron 一致）。
const VB_EXTERNAL: [(&str, &str, &str, &str, &str); 9] = [
    ("ext_teto", "重音テト（Kasane Teto）官方", "声库", "最知名的免费日文声库之一；官网配布，使用条款以官方说明为准", "https://kasaneteto.jp/utau/"),
    ("ext_momo", "桃音モモ（Momone Momo）官方", "声库", "经典免费日文声库，官网配布", "https://momonemomo.com/"),
    ("ext_booth", "BOOTH（创作者直售 / 免费配布）", "平台", "大量新声库在 BOOTH 免费发布，如 Juki、螺音ラグ 等", "https://booth.pm/"),
    ("ext_bowlroll", "BowlRoll（日本主流配布站）", "平台", "很多声库（茜音イーライ、ピータン 等）只在这里配布", "https://bowlroll.net/"),
    ("ext_chwiki", "UTAU 中华组维基", "索引", "国内最大的中文 UTAU 音源信息库，含简介与配布地址", "https://utauchn.huijiwiki.com"),
    ("ext_utaou", "UTAU ユーザー互助会@ウィキ", "索引", "记录了非常多的早期日文音源配布位置", "https://w.atwiki.jp/utaou/pages/19.html"),
    ("ext_nicodic", "ニコニコ大百科 · UTAU 音声ライブラリ一覧", "索引", "字典式的日文声库总览，信息量很大", "https://dic.nicovideo.jp/a/utau%E9%9F%B3%E5%A3%B0%E3%83%A9%E3%82%A4%E3%83%96%E3%83%A9%E3%83%AA%E4%B8%80%E8%A6%A7"),
    ("ext_utauwiki", "UTAU Wiki（英文 · UTAUloids）", "索引", "英文社区汇总，找国外音源从这里入手", "https://utau.fandom.com/wiki/UTAUloids"),
    ("ext_bilibili", "B 站「UTAU 音源配布」", "索引", "国内创作者多在 B 站发布配布视频，下载链接在简介 / 评论区", "https://search.bilibili.com/all?keyword=UTAU%20%E9%9F%B3%E6%BA%90%E9%85%8D%E5%B8%83"),
];

fn vb_root() -> PathBuf {
    data_dir().join("voicebanks")
}

fn vb_entry(id: &str) -> Option<&'static VbEntry> {
    VB_REGISTRY.iter().find(|e| e.id == id)
}

/// 在目录（含子目录，深度上限 3）里找 oto.ini —— 多音阶声库常把 oto.ini 放在子目录。
fn find_oto(root: &Path, depth: u32) -> Option<PathBuf> {
    if depth > 3 || !root.is_dir() {
        return None;
    }
    if root.join("oto.ini").is_file() {
        return Some(root.to_path_buf());
    }
    let rd = std::fs::read_dir(root).ok()?;
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(hit) = find_oto(&p, depth + 1) {
                return Some(hit);
            }
        }
    }
    None
}

fn vb_character_txt(dir: &Path) -> bool {
    dir.join("character.txt").is_file() || dir.join("character.yaml").is_file()
}

/// 声库资源中心注册表：已装状态 + 体积 + 渠道索引。
pub fn utau_voicebank_registry() -> Value {
    let root = vb_root();
    let list: Vec<Value> = VB_REGISTRY
        .iter()
        .map(|e| {
            let dir = root.join(e.dir_name);
            let installed = find_oto(&dir, 0).is_some();
            json!({
                "id": e.id,
                "name": e.name,
                "author": e.author,
                "lang": e.lang,
                "desc": e.desc,
                "license": e.license,
                "officialUrl": e.official_url,
                "repo": e.repo,
                "installed": installed,
                "dir": dir.display().to_string(),
                "size": if installed { dir_size(&dir) } else { 0 },
                "hasCharacterTxt": vb_character_txt(&dir),
            })
        })
        .collect();
    let external: Vec<Value> = VB_EXTERNAL
        .iter()
        .map(|(id, name, kind, note, url)| {
            json!({ "id": id, "name": name, "kind": kind, "note": note, "url": url })
        })
        .collect();
    json!({
        "ok": true,
        "dir": root.display().to_string(),
        "external": external,
        "list": list,
    })
}

fn vb_archive_urls(entry: &VbEntry) -> Vec<String> {
    let arch = format!(
        "https://github.com/{}/archive/refs/heads/{}.zip",
        entry.repo, entry.git_ref
    );
    let mut out = vec![
        format!("https://gh.jasonzeng.dev/{arch}"),
        format!("https://ghfast.top/{arch}"),
        format!("https://gh-proxy.com/{arch}"),
        arch.clone(),
        format!(
            "https://codeload.github.com/{}/zip/refs/heads/{}",
            entry.repo, entry.git_ref
        ),
    ];
    out.dedup();
    out
}

/// 按 Electron 的规则解包声库归档：
/// · subdir 非空 → 只取路径里含 /<subdir>/ 的条目，剥掉前缀；
/// · subdir 为空 → 剥掉 GitHub 归档的顶层 <repo>-<ref>/ 前缀。
fn extract_voicebank_archive(
    archive: &Path,
    stage: &Path,
    subdir: &str,
    job: &Arc<Job>,
) -> Result<usize, String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("打开归档失败：{e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("不是有效的 ZIP：{e}"))?;
    if zip.len() > 300_000 {
        return Err(format!("压缩包条目过多（{}）", zip.len()));
    }
    std::fs::create_dir_all(stage).map_err(|e| format!("创建解包目录失败：{e}"))?;
    let needle = if subdir.trim().is_empty() {
        None
    } else {
        Some(format!("/{}/", subdir.trim_matches('/')))
    };
    let mut count = 0usize;
    for i in 0..zip.len() {
        if job.is_canceled() {
            return Err("__canceled".to_string());
        }
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let raw = entry.name().replace('\\', "/");
        if raw.starts_with("__MACOSX/") || entry.is_dir() {
            continue;
        }
        let rel = match &needle {
            Some(n) => match raw.find(n.as_str()) {
                Some(idx) => raw[idx + n.len()..].to_string(),
                None => continue,
            },
            None => match raw.find('/') {
                Some(idx) => raw[idx + 1..].to_string(),
                None => continue,
            },
        };
        if rel.is_empty() || rel.ends_with('/') {
            continue;
        }
        if zip_entry_unsafe(&rel) {
            return Err(format!("声库归档含不安全路径：{raw}"));
        }
        let out = stage.join(&rel);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut f = std::fs::File::create(&out).map_err(|e| format!("写入 {}：{e}", out.display()))?;
        std::io::copy(&mut entry, &mut f).map_err(|e| format!("解包 {}：{e}", out.display()))?;
        count += 1;
    }
    Ok(count)
}

/// 下载并安装一个 UTAU 声库（多源轮换 + 断点续传 + 解包校验 oto.ini）。
pub fn utau_download_voicebank(app: &AppHandle, id: String) -> Value {
    let Some(entry) = vb_entry(&id) else {
        return json!({ "ok": false, "error": format!("未知声库: {id}") });
    };
    let final_dir = vb_root().join(entry.dir_name);
    if find_oto(&final_dir, 0).is_some() {
        let peer = Peer::new(app, VB_EVENT, json!({ "id": id, "phase": "done" }));
        peer.send_extra(0, 0, 100, true, json!({ "ok": true, "existed": true }));
        return json!({
            "ok": true,
            "existed": true,
            "name": entry.name,
            "dir": final_dir.display().to_string(),
        });
    }
    let Some(job) = job_begin(&id) else {
        return json!({ "ok": false, "error": "该声库正在下载中", "id": id });
    };
    let urls = vb_archive_urls(entry);
    let temp_dir = data_dir().join("temp").join("voicebank-dl");
    let zip_path = temp_dir.join(format!("{id}.zip"));
    let stage = temp_dir.join(format!("{id}-extract"));
    let subdir = entry.subdir.to_string();
    let name = entry.name.to_string();
    let jid = id.clone();
    let app2 = app.clone();
    run_job(&app2, job, VB_EVENT, move |app3, job3| {
        let _ = std::fs::create_dir_all(&temp_dir);
        let peer_dl = Peer::new(app3, VB_EVENT, json!({ "id": jid, "phase": "download", "text": name }));
        let spec = DlSpec {
            urls: &urls,
            dest: &zip_path,
            label: &name,
            min_size: 200_000,
            max_size: u64::MAX,
            expect_total: 0,
            verify_exact: false,
            pct_lo: 0,
            pct_hi: 84,
        };
        if let Err(e) = dl_download(job3, Some(&peer_dl), &spec) {
            return match e {
                JobFail::Canceled => {
                    peer_dl.send_extra(0, 0, 0, true, json!({ "canceled": true, "error": "已取消" }));
                    json!({ "ok": false, "canceled": true, "error": "已取消下载" })
                }
                JobFail::Failed(msg) => {
                    peer_dl.send_extra(0, 0, 0, true, json!({ "error": msg.clone() }));
                    json!({ "ok": false, "error": format!("下载声库失败：{msg}") })
                }
            };
        }
        let peer_ex = Peer::new(app3, VB_EVENT, json!({ "id": jid, "phase": "extract", "text": "解压声库" }));
        peer_ex.send_extra(0, 0, 88, false, Value::Null);
        remove_path(&stage);
        let extracted = match extract_voicebank_archive(&zip_path, &stage, &subdir, job3) {
            Ok(n) => n,
            Err(e) if e == "__canceled" => {
                remove_path(&stage);
                peer_ex.send_extra(0, 0, 0, true, json!({ "canceled": true, "error": "已取消" }));
                return json!({ "ok": false, "canceled": true, "error": "已取消解包" });
            }
            Err(e) => {
                remove_path(&stage);
                peer_ex.send_extra(0, 0, 0, true, json!({ "error": e.clone() }));
                return json!({ "ok": false, "error": e });
            }
        };
        if extracted == 0 {
            remove_path(&stage);
            let msg = format!(
                "归档里没有找到声库目录「{}」",
                if subdir.is_empty() { "/" } else { &subdir }
            );
            peer_ex.send_extra(0, 0, 0, true, json!({ "error": msg.clone() }));
            return json!({ "ok": false, "error": msg });
        }
        let Some(oto_root) = find_oto(&stage, 0) else {
            remove_path(&stage);
            let msg = "解包结果里没有 oto.ini，可能声库结构已变更".to_string();
            peer_ex.send_extra(0, 0, 0, true, json!({ "error": msg.clone() }));
            return json!({ "ok": false, "error": msg });
        };
        remove_path(&final_dir);
        if let Some(parent) = final_dir.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::rename(&oto_root, &final_dir).is_err() {
            if let Err(e) = copy_tree(&oto_root, &final_dir) {
                remove_path(&stage);
                peer_ex.send_extra(0, 0, 0, true, json!({ "error": e.clone() }));
                return json!({ "ok": false, "error": format!("安装声库失败：{e}") });
            }
        }
        remove_path(&stage);
        remove_path(&zip_path);
        if find_oto(&final_dir, 0).is_none() {
            let msg = "安装后未找到 oto.ini".to_string();
            peer_ex.send_extra(0, 0, 0, true, json!({ "error": msg.clone() }));
            return json!({ "ok": false, "error": msg });
        }
        let has_char = vb_character_txt(&final_dir);
        let size = dir_size(&final_dir);
        peer_ex.send_extra(size, size, 100, true, json!({ "ok": true }));
        let mut out = json!({
            "ok": true,
            "name": name,
            "dir": final_dir.display().to_string(),
            "files": extracted,
            "size": size,
            "hasCharacterTxt": has_char,
        });
        if !has_char {
            out["warning"] = json!("声库缺少 character.txt / character.yaml（不影响使用，显示名会取自目录名）");
        }
        out
    })
}

pub fn utau_cancel_voicebank_download(id: Option<String>) -> Value {
    match id.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(id) => {
            let hit = job_cancel(&id);
            json!({ "ok": true, "canceled": hit, "id": id })
        }
        None => {
            // 没有 id：把当前所有声库下载都取消（前端偶尔传空）
            let ids: Vec<String> = {
                let g = job_map().lock().unwrap_or_else(|e| e.into_inner());
                g.keys().filter(|k| vb_entry(k).is_some()).cloned().collect()
            };
            for id in &ids {
                job_cancel(id);
            }
            json!({ "ok": true, "canceled": !ids.is_empty(), "ids": ids })
        }
    }
}

/* ================================ GPU 增强包 ================================ */

const GPU_EVENT: &str = "gpu:progress";
const GPU_KINDS: [&str; 4] = ["cuda", "rocm", "xpu", "rvc"];
const GPU_GH_RELEASES: &str = "https://api.github.com/repos/qdTXTbp/FuFumidi/releases?per_page=100";
const GPU_CNB_RELEASES: &str = "https://cnb.cool/FuFuCloud-mirror/FuFuMIDI/-/releases?page=1&page_size=100";
const GPU_CNB_REPO: &str = "FuFuCloud-mirror/FuFuMIDI";

fn gpu_label(kind: &str) -> &'static str {
    match kind {
        "cuda" => "CUDA",
        "rocm" => "ROCm",
        "xpu" => "Intel XPU",
        "rvc" => "RVC 推理",
        _ => "未知增强包",
    }
}

fn gpu_kind_ok(kind: &str) -> bool {
    GPU_KINDS.contains(&kind)
}

/// 从文件名 / URL 猜增强包类型（与 main/gpu.js 的 inferGpuKind 同序）。
fn infer_gpu_kind(hint: &str) -> Option<&'static str> {
    let t = hint.to_ascii_lowercase();
    if t.contains("rvc") || t.contains("svc") {
        return Some("rvc");
    }
    if t.contains("cuda") {
        return Some("cuda");
    }
    if t.contains("rocm") || t.contains("rocmsdk") || t.contains("-hip") {
        return Some("rocm");
    }
    if t.contains("xpu") || t.contains("oneapi") {
        return Some("xpu");
    }
    None
}

fn gpu_root() -> PathBuf {
    data_dir().join("gpu-enhancements")
}

fn gpu_dir(kind: &str) -> PathBuf {
    gpu_root().join(kind)
}

fn current_python_minor() -> String {
    match run_python_inline("import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')") {
        Ok((_ok, out, _err)) => out.trim().to_string(),
        Err(_) => String::new(),
    }
}

fn gpu_manifest(kind: &str) -> Option<Value> {
    let p = gpu_dir(kind).join("manifest.json");
    if !p.is_file() {
        return None;
    }
    serde_json::from_str::<Value>(&std::fs::read_to_string(p).ok()?).ok()
}

fn gpu_installed_kinds() -> Vec<String> {
    GPU_KINDS
        .iter()
        .filter(|k| gpu_dir(k).join("site-packages").is_dir() && gpu_manifest(k).is_some())
        .map(|k| k.to_string())
        .collect()
}

fn write_gpu_manifest(kind: &str, meta: &Value) -> Result<(), String> {
    let dir = gpu_dir(kind);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut m = json!({
        "kind": kind,
        "installedAt": unique_stamp().to_string(),
    });
    if let (Some(dst), Some(src)) = (m.as_object_mut(), meta.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    write_json_file(&dir.join("manifest.json"), &m)
}

/// 原子安装 site-packages：先复制到临时目录再改名，避免半装状态被引擎加载。
fn gpu_install_site(kind: &str, src_site: &Path, meta: &Value) -> Result<PathBuf, String> {
    if !src_site.is_dir() {
        return Err("缺少 site-packages 目录".to_string());
    }
    let final_dir = gpu_dir(kind);
    let tmp_dir = PathBuf::from(format!("{}.tmp-{}", final_dir.display(), std::process::id()));
    remove_path(&tmp_dir);
    let tmp_site = tmp_dir.join("site-packages");
    std::fs::create_dir_all(&tmp_site).map_err(|e| format!("创建临时目录失败：{e}"))?;
    if let Err(e) = copy_tree(src_site, &tmp_site) {
        remove_path(&tmp_dir);
        return Err(format!("复制 site-packages 失败：{e}"));
    }
    let mut manifest = json!({ "kind": kind, "installedAt": unique_stamp().to_string() });
    if let (Some(dst), Some(src)) = (manifest.as_object_mut(), meta.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    write_json_file(&tmp_dir.join("manifest.json"), &manifest)?;
    remove_path(&final_dir);
    if let Some(parent) = final_dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::rename(&tmp_dir, &final_dir)
        .map_err(|e| format!("安装到 {} 失败：{e}", final_dir.display()))?;
    Ok(final_dir)
}

fn is_gpu_asset(name: &str) -> bool {
    name.to_ascii_lowercase().starts_with("fufumidi-gpu-")
}

fn first_gpu_release(list: &[Value]) -> Option<Value> {
    list.iter()
        .find(|rel| {
            rel.get("assets")
                .and_then(|v| v.as_array())
                .map(|assets| {
                    assets
                        .iter()
                        .any(|a| a.get("name").and_then(|v| v.as_str()).map(is_gpu_asset).unwrap_or(false))
                })
                .unwrap_or(false)
        })
        .cloned()
}

fn gh_gpu_releases() -> Result<Vec<Value>, String> {
    let v = http_json(GPU_GH_RELEASES, 8, &["-H", "User-Agent: FuFumidi-Update"])?;
    match v.as_array() {
        Some(a) => Ok(a.clone()),
        None => Err("GitHub Releases 返回的不是数组".to_string()),
    }
}

fn cnb_gpu_releases() -> Result<Vec<Value>, String> {
    let v = http_json(
        GPU_CNB_RELEASES,
        8,
        &["-H", "Accept: application/vnd.cnb.api+json"],
    )?;
    if let Some(a) = v.as_array() {
        return Ok(a.clone());
    }
    match v.get("releases").and_then(|x| x.as_array()) {
        Some(a) => Ok(a.clone()),
        None => Err("CNB Releases 返回格式无法识别".to_string()),
    }
}

/// release 列表缓存（gpu_list_packages / gpu_package_url 是同步命令，跑在主线程；
/// 设置页反复打开不该每次等两次 HTTP）。
type GpuReleaseCache = Mutex<Option<(Instant, Option<Value>)>>;

fn gpu_release_cache() -> &'static GpuReleaseCache {
    static CACHE: OnceLock<GpuReleaseCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn find_gpu_release_cached() -> Result<Option<Value>, String> {
    {
        let g = gpu_release_cache().lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, val)) = g.as_ref() {
            if at.elapsed() < Duration::from_secs(120) {
                return Ok(val.clone());
            }
        }
    }
    let found = find_gpu_release();
    if let Ok(v) = &found {
        let mut g = gpu_release_cache().lock().unwrap_or_else(|e| e.into_inner());
        *g = Some((Instant::now(), v.clone()));
    }
    found
}

/// 遍历 release 列表找「第一个带 fufumidi-gpu-* 资产的」，按下载源偏好决定先查哪边。
fn find_gpu_release() -> Result<Option<Value>, String> {
    let mut last_err = String::new();
    let cnb_first = prefer_cnb();
    for idx in 0..2 {
        let use_cnb = (idx == 0) == cnb_first;
        let got = if use_cnb { cnb_gpu_releases() } else { gh_gpu_releases() };
        match got {
            Ok(list) => {
                if let Some(rel) = first_gpu_release(&list) {
                    return Ok(Some(rel));
                }
            }
            Err(e) => last_err = format!("{last_err} / {e}"),
        }
    }
    if last_err.is_empty() {
        Ok(None)
    } else {
        Err(format!("无法获取 GPU 增强包列表：{last_err}"))
    }
}

fn gpu_prereq_warn(kind: &str) -> String {
    let cur = current_python_minor();
    if cur.is_empty() || cur == "3.12" {
        return String::new();
    }
    format!("{kind} 版 · 与当前 Python 运行时 {cur} 不匹配，可安装；若引擎加载失败会自动回退 CPU")
}

/// 分卷资产名：fufumidi-gpu-<kind>.partN 或 fufumidi-gpu-<kind>[-parts].zip.00N
fn split_parts_for(assets: &[Value], kind: &str) -> Vec<Value> {
    let prefix = format!("fufumidi-gpu-{kind}");
    let mut parts: Vec<(u64, Value)> = Vec::new();
    for a in assets {
        let Some(name) = a.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        let low = name.to_ascii_lowercase();
        let Some(rest) = low.strip_prefix(prefix.as_str()) else {
            continue;
        };
        let tail = rest
            .strip_prefix("-parts.")
            .or_else(|| rest.strip_prefix('.'));
        let Some(tail) = tail else { continue };
        let num = if let Some(z) = tail.strip_prefix("zip.") {
            if z.len() == 3 && z.chars().all(|c| c.is_ascii_digit()) {
                z.parse::<u64>().ok()
            } else {
                None
            }
        } else {
            tail.strip_prefix("part")
                .filter(|d| !d.is_empty() && d.chars().all(|c| c.is_ascii_digit()))
                .and_then(|d| d.parse::<u64>().ok())
        };
        if let Some(n) = num {
            parts.push((n, a.clone()));
        }
    }
    parts.sort_by_key(|(n, _)| *n);
    parts.into_iter().map(|(_, a)| a).collect()
}

fn asset_size(a: &Value) -> u64 {
    a.get("size").and_then(|v| v.as_u64()).unwrap_or(0)
}

fn asset_url(a: &Value) -> String {
    a.get("browser_download_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// 预打包增强包清单（gpu:listPackages 对应实现）。
pub fn gpu_list_packages() -> Value {
    let rel = match find_gpu_release_cached() {
        Ok(Some(r)) => r,
        Ok(None) => {
            return json!({
                "ok": true,
                "packages": [],
                "currentPython": current_python_minor(),
                "note": "Release 里没有 fufumidi-gpu-* 资产",
            })
        }
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let tag = rel.get("tag_name").and_then(|v| v.as_str()).unwrap_or("");
    let assets = rel
        .get("assets")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out: Vec<Value> = Vec::new();
    for kind in GPU_KINDS {
        let want = format!("fufumidi-gpu-{kind}.zip");
        if let Some(a) = assets.iter().find(|a| {
            a.get("name")
                .and_then(|v| v.as_str())
                .map(|n| n.eq_ignore_ascii_case(&want))
                .unwrap_or(false)
        }) {
            out.push(json!({
                "tag": tag,
                "name": a.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                "url": asset_url(a),
                "size": asset_size(a),
                "kind": kind,
                "label": gpu_label(kind),
                "requiresPython": "3.12",
                "warn": gpu_prereq_warn(kind),
            }));
        }
        let parts = split_parts_for(&assets, kind);
        if !parts.is_empty() {
            let total: u64 = parts.iter().map(asset_size).sum();
            out.push(json!({
                "tag": tag,
                "name": format!("fufumidi-gpu-{kind}-parts (split)"),
                "kind": kind,
                "label": gpu_label(kind),
                "split": true,
                "requiresPython": "3.12",
                "warn": gpu_prereq_warn(kind),
                "size": total,
                "url": asset_url(&parts[0]),
                "files": parts.iter().map(|a| json!({
                    "name": a.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                    "url": asset_url(a),
                    "size": asset_size(a),
                })).collect::<Vec<_>>(),
            }));
        }
    }
    json!({
        "ok": true,
        "packages": out,
        "currentPython": current_python_minor(),
        "tag": tag,
    })
}

/// 单个 kind 的直链（gpu:packageUrl 对应实现）。
pub fn gpu_package_url(kind: String) -> Value {
    let k = kind.trim().to_ascii_lowercase();
    if !gpu_kind_ok(&k) {
        return json!({ "ok": false, "error": "未知的增强包类型", "kind": k });
    }
    let rel = match find_gpu_release_cached() {
        Ok(Some(r)) => r,
        Ok(None) => return json!({ "ok": false, "error": format!("未找到 GPU 增强包资产：fufumidi-gpu-{k}.zip") }),
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let assets = rel
        .get("assets")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let needle = format!("gpu-{k}");
    let hit = assets.iter().find(|a| {
        a.get("name")
            .and_then(|v| v.as_str())
            .map(|n| n.to_ascii_lowercase().contains(&needle) && n.to_ascii_lowercase().ends_with(".zip"))
            .unwrap_or(false)
    });
    match hit {
        Some(a) => json!({
            "ok": true,
            "url": asset_url(a),
            "name": a.get("name").and_then(|v| v.as_str()).unwrap_or(""),
            "size": asset_size(a),
            "kind": k,
        }),
        None => json!({ "ok": false, "error": format!("未找到 GPU 增强包资产：fufumidi-gpu-{k}.zip") }),
    }
}

fn gh_release_tag(url: &str) -> Option<String> {
    let rest = url.split("/releases/download/").nth(1)?;
    rest.split('/').next().map(|s| s.to_string())
}

/// 候选下载源：CNB Release 镜像 + GitHub 各加速镜像 + 官方直连（按下载源偏好排序）。
fn gpu_candidate_urls(url: &str, name: &str) -> Vec<String> {
    let mut gh: Vec<String> = Vec::new();
    if url.starts_with("https://github.com/") {
        for prefix in ["https://ghfast.top/", "https://gh-proxy.com/", "https://ghproxy.net/"] {
            gh.push(format!("{prefix}{url}"));
        }
        gh.push(url.to_string());
    } else if !url.is_empty() {
        gh.push(url.to_string());
    }
    let cnb = gh_release_tag(url).map(|tag| {
        format!(
            "https://cnb.cool/{GPU_CNB_REPO}/-/releases/download/{}/{}",
            url_encode(&tag),
            url_encode(name)
        )
    });
    let mut out: Vec<String> = Vec::new();
    let push = |u: String, out: &mut Vec<String>| {
        if !u.is_empty() && !out.iter().any(|x| x == &u) {
            out.push(u);
        }
    };
    match cnb {
        Some(c) if prefer_cnb() => {
            push(c, &mut out);
            for u in gh {
                push(u, &mut out);
            }
        }
        Some(c) => {
            for u in gh {
                push(u, &mut out);
            }
            push(c, &mut out);
        }
        None => {
            for u in gh {
                push(u, &mut out);
            }
        }
    }
    out
}

/// 下载分卷并合并成单个 zip（顺序写，避免把几 GB 读进内存）。
fn concat_files(parts: &[PathBuf], out: &Path) -> Result<u64, String> {
    if let Some(parent) = out.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut dst = std::fs::File::create(out).map_err(|e| format!("创建 {}：{e}", out.display()))?;
    let mut total = 0u64;
    for p in parts {
        let mut src = std::fs::File::open(p).map_err(|e| format!("打开 {}：{e}", p.display()))?;
        total += std::io::copy(&mut src, &mut dst).map_err(|e| format!("合并 {}：{e}", p.display()))?;
    }
    Ok(total)
}

/// 从 GUI 选择 / 拖入的路径里解析出 GPU 增强包文件（支持 paths / localPath / files 三种写法）。
fn gpu_paths_from_req(req: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let push_str = |v: &Value, out: &mut Vec<String>| {
        if let Some(s) = v.as_str() {
            if !s.trim().is_empty() {
                out.push(s.trim().to_string());
            }
        }
    };
    for key in ["paths", "localPath", "files"] {
        match req.get(key) {
            Some(Value::Array(a)) => {
                for x in a {
                    match x {
                        Value::String(_) => push_str(x, &mut out),
                        Value::Object(o) => {
                            if let Some(p) = o.get("path") {
                                push_str(p, &mut out);
                            }
                        }
                        _ => {}
                    }
                }
            }
            Some(v @ Value::String(_)) => push_str(v, &mut out),
            _ => {}
        }
    }
    out.dedup();
    out
}

fn is_split_archive(name: &str) -> bool {
    let low = name.to_ascii_lowercase();
    if let Some(idx) = low.rfind(".zip.") {
        let tail = &low[idx + 5..];
        return tail.len() == 3 && tail.chars().all(|c| c.is_ascii_digit());
    }
    match low.rfind(".part") {
        Some(idx) => {
            let tail = &low[idx + 5..];
            !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit())
        }
        None => false,
    }
}

fn split_part_number(p: &str) -> u64 {
    let digits: String = p
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    digits.parse::<u64>().unwrap_or(0)
}

/// 本地 zip / 分卷 → 解包出的 site-packages 目录（统一做安全解压）。
fn gpu_zip_to_site(paths: &[String], work: &Path, job: Option<&Arc<Job>>) -> Result<(PathBuf, bool), String> {
    let mut list: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    list.sort_by_key(|p| split_part_number(&p.to_string_lossy()));
    let first_name = list
        .first()
        .map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())
        .unwrap_or_default();
    let split = list.len() > 1 || is_split_archive(&first_name);
    let zip_path = work.join("fufumidi-gpu-import.zip");
    remove_path(&zip_path);
    if split {
        concat_files(&list, &zip_path)?;
    } else {
        std::fs::copy(&list[0], &zip_path).map_err(|e| format!("复制压缩包失败：{e}"))?;
    }
    let extract_dir = work.join("fufumidi-gpu-import");
    remove_path(&extract_dir);
    let count = safe_extract_zip(&zip_path, &extract_dir, job, false)?;
    if count == 0 {
        return Err("压缩包是空的".to_string());
    }
    let site = find_subdir(&extract_dir, "site-packages", 2)
        .ok_or_else(|| "压缩包内缺少 site-packages 目录".to_string())?;
    Ok((site, split))
}

/// 下载预打包增强包并安装（gpu:downloadPackage 对应实现）。
pub fn gpu_download_package(app: &AppHandle, opts: Value) -> Value {
    if opts.is_null() {
        return json!({ "ok": false, "error": "empty url" });
    }
    let mut files: Vec<Value> = Vec::new();
    if let Some(a) = opts.get("files").and_then(|v| v.as_array()) {
        for f in a {
            if f.get("url").and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false) {
                files.push(f.clone());
            }
        }
    }
    if files.is_empty() {
        let url = opts.get("url").and_then(|v| v.as_str()).unwrap_or("");
        if url.trim().is_empty() {
            return json!({ "ok": false, "error": "empty url" });
        }
        files.push(json!({
            "url": url,
            "name": opts.get("name").and_then(|v| v.as_str()).unwrap_or(""),
            "size": opts.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
        }));
    }
    let hint = opts
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            files
                .first()
                .and_then(|f| f.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()))
        })
        .or_else(|| files.first().and_then(|f| f.get("url").and_then(|v| v.as_str()).map(|s| s.to_string())))
        .unwrap_or_default();
    let kind = opts
        .get("kind")
        .and_then(|v| v.as_str())
        .map(|s| s.to_ascii_lowercase())
        .or_else(|| infer_gpu_kind(&hint).map(|s| s.to_string()))
        .unwrap_or_default();
    if !gpu_kind_ok(&kind) {
        return json!({ "ok": false, "error": "无法识别增强包类型", "hint": hint });
    }
    let Some(job) = job_begin("gpu") else {
        return json!({ "ok": false, "error": "GPU 增强包任务正在进行中（下载或安装），请先取消或等待完成" });
    };
    let work = data_dir().join("temp").join("fufumidi-gpu-dl");
    remove_path(&work);
    let _ = std::fs::create_dir_all(&work);
    let total_all: u64 = files.iter().map(|f| f.get("size").and_then(|v| v.as_u64()).unwrap_or(0)).sum();
    let file_count = files.len();
    let app2 = app.clone();
    run_job(&app2, job, GPU_EVENT, move |app3, job3| {
        let mut downloaded: Vec<PathBuf> = Vec::new();
        let mut received_total = 0u64;
        for (i, f) in files.iter().enumerate() {
            let url = f.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let name = f
                .get("name")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    url.rsplit('/')
                        .next()
                        .filter(|s| !s.is_empty())
                        .unwrap_or("part")
                        .to_string()
                });
            let fname = safe_file_name(&name, "part");
            let size = f.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
            let dest = work.join(&fname);
            let urls = gpu_candidate_urls(url, &fname);
            let lo = if file_count > 0 {
                (i as u32 * 99 / file_count as u32) as u8
            } else {
                0
            };
            let hi = if i + 1 >= file_count {
                99
            } else {
                ((i as u32 + 1) * 99 / file_count as u32) as u8
            };
            let peer = Peer::new(app3, GPU_EVENT, json!({ "text": format!("下载增强包 {}/{}", i + 1, file_count) }));
            let spec = DlSpec {
                urls: &urls,
                dest: &dest,
                label: &fname,
                min_size: if size > 0 { size.clamp(1024, 200_000) } else { 200_000 },
                max_size: u64::MAX,
                expect_total: size,
                verify_exact: size > 0,
                pct_lo: lo,
                pct_hi: hi,
            };
            match dl_download(job3, Some(&peer), &spec) {
                Ok(n) => {
                    received_total += n;
                    downloaded.push(dest);
                    let pct = if total_all > 0 {
                        ((received_total.min(total_all) as f64 / total_all as f64) * 99.0) as u8
                    } else {
                        0
                    };
                    peer.send_extra(received_total, total_all, pct, false, json!({ "text": "分卷完成" }));
                }
                Err(JobFail::Canceled) => {
                    remove_path(&work);
                    return json!({ "ok": false, "canceled": true, "error": "已取消下载" });
                }
                Err(JobFail::Failed(e)) => {
                    remove_path(&work);
                    return json!({ "ok": false, "error": format!("下载增强包失败：{e}") });
                }
            }
        }
        let peer = Peer::new(app3, GPU_EVENT, json!({ "text": "解压增强包" }));
        peer.send_extra(received_total, total_all, 99, false, Value::Null);
        let first_name = downloaded
            .first()
            .map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())
            .unwrap_or_default();
        let split = file_count > 1 || is_split_archive(&first_name);
        let zip_path = work.join("fufumidi-gpu.zip");
        let merge = if split {
            concat_files(&downloaded, &zip_path)
        } else {
            std::fs::copy(&downloaded[0], &zip_path).map_err(|e| format!("复制压缩包失败：{e}"))
        };
        if let Err(e) = merge {
            remove_path(&work);
            return json!({ "ok": false, "error": e });
        }
        let extract_dir = work.join("extract");
        match safe_extract_zip(&zip_path, &extract_dir, Some(job3), false) {
            Ok(_) => {}
            Err(e) if e == "__canceled" => {
                remove_path(&work);
                return json!({ "ok": false, "canceled": true, "error": "已取消解包" });
            }
            Err(e) => {
                remove_path(&work);
                return json!({ "ok": false, "error": format!("解压增强包失败：{e}") });
            }
        }
        let Some(site) = find_subdir(&extract_dir, "site-packages", 2) else {
            remove_path(&work);
            return json!({ "ok": false, "error": "压缩包内缺少 site-packages 目录" });
        };
        let meta = json!({
            "name": hint,
            "url": opts.get("url").and_then(|v| v.as_str()).unwrap_or(""),
            "source": "download",
            "split": split,
            "requiresPython": "3.12",
        });
        match gpu_install_site(&kind, &site, &meta) {
            Ok(final_dir) => {
                remove_path(&work);
                let cur = current_python_minor();
                let active = cur.is_empty() || cur == "3.12";
                peer.send_extra(received_total, total_all, 100, true, json!({ "ok": true }));
                json!({
                    "ok": true,
                    "kind": kind,
                    "requiresPython": "3.12",
                    "active": active,
                    "path": final_dir.display().to_string(),
                    "bytes": received_total,
                })
            }
            Err(e) => {
                remove_path(&work);
                json!({ "ok": false, "error": format!("安装增强包失败：{e}") })
            }
        }
    })
}

fn gpu_import_local_inner(req: &Value) -> Result<Value, String> {
    let paths = gpu_paths_from_req(req);
    if paths.is_empty() {
        return Err("本地文件不存在".to_string());
    }
    for p in &paths {
        if !Path::new(p).exists() {
            return Err(format!("本地文件不存在：{p}"));
        }
    }
    let first = paths.first().cloned().unwrap_or_default();
    let kind = match req.get("kind").and_then(|v| v.as_str()) {
        Some(k) if !k.trim().is_empty() => k.trim().to_ascii_lowercase(),
        _ => infer_gpu_kind(&first).unwrap_or_default().to_string(),
    };
    if !gpu_kind_ok(&kind) {
        return Err("无法识别增强包类型，请先选择 CUDA / ROCm / XPU 包或分卷".to_string());
    }
    let work = data_dir().join("temp").join("fufumidi-gpu-import");
    remove_path(&work);
    std::fs::create_dir_all(&work).map_err(|e| format!("创建临时目录失败：{e}"))?;
    let (site, split) = gpu_zip_to_site(&paths, &work, None)?;
    let meta = json!({
        "name": Path::new(&first).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        "source": "local",
        "split": split,
        "requiresPython": "3.12",
    });
    let final_dir = gpu_install_site(&kind, &site, &meta)?;
    remove_path(&work);
    let cur = current_python_minor();
    Ok(json!({
        "ok": true,
        "kind": kind,
        "split": split,
        "requiresPython": "3.12",
        "active": cur.is_empty() || cur == "3.12",
        "path": final_dir.display().to_string(),
    }))
}

/// 本地 zip / 分卷导入（同步：本地解包不需要网络取消；与 Electron 一样完成后才返回）。
pub fn gpu_import_local(_app: &AppHandle, req: Value) -> Value {
    if req.is_null() {
        return json!({ "ok": false, "error": "本地文件不存在" });
    }
    let Some(_job) = job_begin("gpu") else {
        return json!({ "ok": false, "error": "GPU 增强包任务正在进行中（下载或安装），请先取消或等待完成" });
    };
    let r = gpu_import_local_inner(&req);
    job_end("gpu");
    match r {
        Ok(v) => v,
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

fn emit_gpu_text(app: &AppHandle, text: &str) {
    let _ = app.emit(
        GPU_EVENT,
        json!({ "percent": -1, "text": text, "installing": true }),
    );
}

/// 逐行读取子进程输出并检查取消（用于 pip / python）。
fn run_streaming<F>(job: &Arc<Job>, cmd: &mut Command, mut on_line: F) -> Result<i32, JobFail>
where
    F: FnMut(&str),
{
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| JobFail::Failed(format!("无法启动子进程：{e}")))?;
    let out = child.stdout.take();
    let err = child.stderr.take();
    job.set_child(child);
    let (tx, rx) = mpsc::channel::<(bool, String)>();
    if let Some(pipe) = out {
        let txc = tx.clone();
        std::thread::spawn(move || pump_lines(pipe, txc));
    }
    if let Some(pipe) = err {
        let txc = tx.clone();
        std::thread::spawn(move || pump_lines(pipe, txc));
    }
    drop(tx);
    let mut code: i32 = -1;
    loop {
        if job.is_canceled() {
            job.kill_child();
            return Err(JobFail::Canceled);
        }
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok((_is_err, line)) => {
                if !line.trim().is_empty() {
                    on_line(&line);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    if let Some(mut c) = job.take_child() {
        code = c.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
    }
    Ok(code)
}

fn pump_lines<R: Read + Send + 'static>(pipe: R, tx: mpsc::Sender<(bool, String)>) {
    let mut reader = BufReader::new(pipe);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                if tx.send((true, line.trim_end().to_string())).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

const CUDA_PIP_SOURCES: [(&str, &str, &str); 3] = [
    ("https://mirrors.aliyun.com/pytorch-wheels/cu128", "https://mirrors.aliyun.com/pypi/simple", "阿里云"),
    ("https://mirror.sjtu.edu.cn/pytorch-wheels/cu128", "https://pypi.tuna.tsinghua.edu.cn/simple", "上海交大"),
    ("https://download.pytorch.org/whl/cu128", "https://pypi.org/simple", "官方"),
];

const VERIFY_CUDA_CODE: &str = r#"import json
try:
    import torch
    ok = bool(torch.cuda.is_available())
    if not ok:
        print('###RESULT ' + json.dumps({'ok': False, 'error': 'backend unavailable'}))
    else:
        info = {'ok': True, 'torch': torch.__version__, 'cuda_version': getattr(torch.version, 'cuda', None)}
        cap = tuple(torch.cuda.get_device_capability(0))
        info['name'] = torch.cuda.get_device_name(0)
        info['capability'] = '%d.%d' % cap
        info['blackwell'] = cap[0] >= 9
        try:
            info['need_cu128'] = bool(info['blackwell'] and (not info['cuda_version'] or float(info['cuda_version']) < 12.8))
        except Exception:
            info['need_cu128'] = True
        try:
            from engine_gpu import detect as _d
            _g = _d() or {}
            info['arch_list'] = _g.get('torch_arch_list')
            info['arch_supported'] = _g.get('arch_supported')
            if _g.get('arch_supported') is False:
                info['ok'] = False
                info['arch_unsupported'] = True
                info['error'] = _g.get('arch_reason') or '显卡算力不在当前 CUDA 推理包支持范围内'
        except Exception:
            pass
        print('###RESULT ' + json.dumps(info))
except Exception as e:
    print('###RESULT ' + json.dumps({'ok': False, 'error': str(e)[:300]}))
"#;

fn verify_cuda_backend() -> Value {
    match run_python_inline(VERIFY_CUDA_CODE) {
        Ok((_ok, stdout, stderr)) => parse_result_json(&stdout).unwrap_or_else(|| {
            json!({ "ok": false, "error": tail_chars(if stderr.is_empty() { &stdout } else { &stderr }, 300) })
        }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// 一键安装 GPU 加速（当前只覆盖 NVIDIA → CUDA cu128；AMD/Intel 无自动包，如实说明）。
pub fn gpu_install_auto(app: &AppHandle) -> Value {
    let detect_code = "from engine_gpu import detect; import json; print('###RESULT ' + json.dumps(detect()))";
    let d = match run_python_inline(detect_code) {
        Ok((_ok, stdout, stderr)) => parse_result_json(&stdout).unwrap_or_else(|| {
            json!({ "ok": false, "error": format!("GPU 自检没有输出结果：{}", tail_chars(&stderr, 300)) })
        }),
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let gpu_detect = json!({
        "vendor": d.get("vendor").cloned().unwrap_or(Value::Null),
        "name": d.get("name").and_then(|v| v.as_str()).unwrap_or(""),
        "blackwell": d.get("blackwell").and_then(|v| v.as_bool()).unwrap_or(false),
        "needCu128": d.get("need_cu128").and_then(|v| v.as_bool()).unwrap_or(false),
        "available": d.get("available").and_then(|v| v.as_bool()).unwrap_or(false),
        "backend": d.get("backend").and_then(|v| v.as_str()).unwrap_or(""),
    });
    let installed = gpu_installed_kinds();
    if !installed.is_empty() {
        return json!({
            "ok": true,
            "already": true,
            "kind": installed[0],
            "kinds": installed,
            "gpu": gpu_detect,
        });
    }
    let vendor = d
        .get("vendor")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if vendor.is_empty() {
        return json!({
            "ok": false,
            "error": "未检测到可用的独立显卡（NVIDIA / AMD / Intel），无法安装 GPU 加速；可在下方「本地导入 ZIP」手动安装增强包",
            "gpu": gpu_detect,
        });
    }
    if vendor != "nvidia" {
        return json!({
            "ok": false,
            "kind": Value::Null,
            "error": format!(
                "当前显卡（{}）没有可一键安装的 GPU 增强包：DirectML 增强包已下线，ROCm 需要较新的 Radeon 显卡与 Python 3.12 运行时。可继续使用 CPU 转录 / 分离。",
                d.get("name").and_then(|v| v.as_str()).unwrap_or(vendor.as_str())
            ),
            "gpu": gpu_detect,
        });
    }
    let Some(eng) = engine_dir() else {
        return json!({ "ok": false, "error": "engine directory not found", "kind": "cuda", "gpu": gpu_detect });
    };
    let req_path = eng.join("requirements-gpu-cuda.txt");
    if !req_path.is_file() {
        return json!({
            "ok": false,
            "kind": "cuda",
            "error": format!("GPU requirement file missing: {}", req_path.display()),
            "gpu": gpu_detect,
        });
    }
    let Some(job) = job_begin("gpu") else {
        return json!({ "ok": false, "error": "GPU 增强包任务正在进行中（下载或安装），请先取消或等待完成" });
    };
    let target_site = gpu_dir("cuda").join("site-packages");
    let pip_cache = data_dir().join("temp").join("pip-cache");
    let _ = std::fs::create_dir_all(&pip_cache);
    let _ = std::fs::create_dir_all(&target_site);
    let app2 = app.clone();
    run_job(&app2, job, GPU_EVENT, move |app3, job3| {
        let mut ok_src: Option<String> = None;
        let mut last_err = String::new();
        for (torch_src, pypi_src, label) in CUDA_PIP_SOURCES {
            if job3.is_canceled() {
                break;
            }
            emit_gpu_text(
                app3,
                &format!(
                    "检测到 {}，开始安装 CUDA（cu128）加速（源：{label}）…",
                    d.get("name").and_then(|v| v.as_str()).unwrap_or(vendor.as_str())
                ),
            );
            let py = python_path().unwrap_or_default();
            let mut cmd = Command::new(py);
            cmd.args([
                "-m", "pip", "install", "--target", &target_site.display().to_string(), "-r",
                &req_path.display().to_string(), "--no-input", "--disable-pip-version-check",
                "--retries", "5", "--timeout", "60", "--cache-dir",
                &pip_cache.display().to_string(), "-i", torch_src, "--extra-index-url", pypi_src,
            ]);
            apply_engine_env(&mut cmd);
            let mut out_tail = String::new();
            let r = run_streaming(job3, &mut cmd, |line| {
                let t = line.trim();
                if t.starts_with("Collecting")
                    || t.starts_with("Downloading")
                    || t.starts_with("Installing")
                    || t.starts_with("Successfully")
                    || t.starts_with("Requirement already")
                    || t.starts_with("Using cached")
                    || t.starts_with("Looking in")
                    || t.starts_with("Processing")
                {
                    emit_gpu_text(app3, &tail_chars(t, 120));
                }
                out_tail = tail_chars(&format!("{out_tail}{t}\n"), 800);
            });
            match r {
                Ok(0) => {
                    ok_src = Some(label.to_string());
                    break;
                }
                Ok(code) => {
                    last_err = format!("源「{label}」pip 退出码 {code}：{}", tail_chars(&out_tail, 240));
                    emit_gpu_text(app3, &format!("源「{label}」安装失败，切换下一镜像…"));
                }
                Err(JobFail::Canceled) => {
                    remove_path(&gpu_dir("cuda"));
                    emit_gpu_text(app3, "已取消安装");
                    return json!({ "ok": false, "kind": "cuda", "canceled": true, "error": "已取消安装", "gpu": gpu_detect });
                }
                Err(JobFail::Failed(e)) => {
                    last_err = e;
                    emit_gpu_text(app3, &format!("源「{label}」无法启动 pip，切换下一镜像…"));
                }
            }
        }
        if job3.is_canceled() {
            remove_path(&gpu_dir("cuda"));
            return json!({ "ok": false, "kind": "cuda", "canceled": true, "error": "已取消安装", "gpu": gpu_detect });
        }
        let Some(src_label) = ok_src else {
            return json!({
                "ok": false,
                "kind": "cuda",
                "error": format!("所有安装源（阿里云/交大/官方）均失败：{last_err}。可到 GitHub Release 下载 fufumidi-gpu-cuda 预打包增强包，在「本地导入 ZIP」中安装。"),
                "gpu": gpu_detect,
            });
        };
        if let Err(e) = write_gpu_manifest(
            "cuda",
            &json!({ "source": "auto", "pipSource": src_label, "requiresPython": "3.12" }),
        ) {
            return json!({ "ok": false, "kind": "cuda", "error": format!("写入增强包清单失败：{e}"), "gpu": gpu_detect });
        }
        emit_gpu_text(app3, "CUDA 增强包安装完成，正在验证 GPU 可用性…");
        let verified = verify_cuda_backend();
        let v_ok = verified.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
        if v_ok {
            let mut gpu = gpu_detect.clone();
            if let Some(o) = gpu.as_object_mut() {
                o.insert("available".into(), json!(true));
                o.insert("backend".into(), json!("cuda"));
                o.insert("vendor".into(), json!("nvidia"));
                if let Some(n) = verified.get("name").and_then(|v| v.as_str()) {
                    o.insert("name".into(), json!(n));
                }
                o.insert("blackwell".into(), verified.get("blackwell").cloned().unwrap_or(json!(false)));
                o.insert("need_cu128".into(), verified.get("need_cu128").cloned().unwrap_or(json!(false)));
            }
            let _ = app3.emit(GPU_EVENT, json!({ "percent": 100, "done": true }));
            return json!({
                "ok": true,
                "kind": "cuda",
                "verified": verified,
                "gpu": gpu,
            });
        }
        let arch_bad = verified.get("arch_unsupported").and_then(|v| v.as_bool()).unwrap_or(false)
            || verified.get("arch_supported").and_then(|v| v.as_bool()) == Some(false);
        if arch_bad {
            let msg = verified
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("显卡算力不在当前 CUDA 推理包支持范围内");
            return json!({
                "ok": false,
                "kind": "cuda",
                "verified": verified,
                "gpu": gpu_detect,
                "archUnsupported": true,
                "error": format!("{msg}。增强包已装好，但本机显卡无法用它加速 —— 应用会自动改用 CPU 转录（功能不受影响，只是更慢）。若希望用 GPU：可等待面向旧算力的构建，或换一台算力较新的显卡。"),
            });
        }
        let blackwell = verified.get("blackwell").and_then(|v| v.as_bool()).unwrap_or(false);
        let hint = if blackwell {
            "检测到 Blackwell（RTX 50 系）显卡，但 CUDA 版本低于 12.8 无法驱动。请更新 NVIDIA 驱动（R570+ 支持 CUDA 12.8）后重新安装。"
        } else {
            "CUDA 增强包已安装但 torch.cuda 不可用。请检查：① NVIDIA 显卡驱动是否已安装且较新；② 网络是否完整下载了 torch cu128 包。仍不行可到 GitHub Release 下载 fufumidi-gpu-cuda 预打包增强包，在「本地导入 ZIP」中安装。"
        };
        json!({
            "ok": false,
            "kind": "cuda",
            "verified": verified,
            "gpu": gpu_detect,
            "error": hint,
        })
    })
}

/// 取消进行中的 GPU 增强包下载 / 安装（杀子进程树，清理半装目录由工作线程负责）。
pub fn gpu_cancel_install() -> Value {
    let hit = job_cancel("gpu");
    json!({ "ok": true, "canceled": hit })
}

/* ================================ OMR 增强组件 ================================ */

const OMR_EVENT: &str = "omr:progress";
const OMR_VERSION: &str = "5.11.0";
const OMR_MSI_NAME: &str = "Audiveris-5.11.0-windowsConsole-x86_64.msi";
const OMR_MSI_URL: &str = "https://github.com/Audiveris/audiveris/releases/download/5.11.0/Audiveris-5.11.0-windowsConsole-x86_64.msi";
const OMR_MSI_BYTES: u64 = 85_062_430;
const OMR_MSI_SHA256: &str = "5f1b4e96a12c53c7da426814b76e599363c4181e291855996e0a6878dda95f71";
const LANG_MIN_BYTES: u64 = 5 * 1024 * 1024;
const LANG_RAW: &str = "https://raw.githubusercontent.com/tesseract-ocr/tessdata/main/";
const SR_VERSION: &str = "20250915";
const SR_ZIP_NAME: &str = "waifu2x-ncnn-vulkan-20250915-windows.zip";
const SR_UPSTREAM: &str = "https://github.com/nihui/waifu2x-ncnn-vulkan/releases/download/20250915/waifu2x-ncnn-vulkan-20250915-windows.zip";
const SR_MIN_BYTES: u64 = 20 * 1024 * 1024;
const SR_MODELS: [&str; 3] = [
    "models-cunet",
    "models-upconv_7_photo",
    "models-upconv_7_anime_style_art_rgb",
];
const HOMR_VERSION: &str = "0.7.0";
const HOMR_CKPT: &str = "https://github.com/liebharc/homr/releases/download/onnx_checkpoints/";
const HOMR_WEIGHTS: [(&str, &str, &str); 3] = [
    ("segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f.zip", "segmentation", "segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f.onnx"),
    ("encoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.zip", "transformer", "encoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.onnx"),
    ("decoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.zip", "transformer", "decoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.onnx"),
];
const PIP_INDEXES: [&str; 3] = [
    "https://pypi.tuna.tsinghua.edu.cn/simple",
    "https://mirrors.aliyun.com/pypi/simple",
    "https://pypi.org/simple",
];

const LANG_CATALOG: [(&str, &str); 4] = [
    ("eng", "英语（速度记号、力度、乐器名多为英文缩写）"),
    ("chi_sim", "简体中文（标题、中文乐器名）"),
    ("chi_tra", "繁体中文"),
    ("jpn", "日语"),
];

fn omr_root() -> PathBuf {
    data_dir().join("omr")
}
fn omr_engine_dir() -> PathBuf {
    omr_root().join("audiveris")
}
fn omr_engine_exe() -> PathBuf {
    omr_engine_dir().join("Audiveris").join("Audiveris.exe")
}
fn tess_dir() -> PathBuf {
    omr_root().join("tessdata")
}
fn homr_dir() -> PathBuf {
    omr_root().join("homr")
}
fn homr_venv() -> PathBuf {
    homr_dir().join("venv")
}
fn homr_site() -> PathBuf {
    homr_venv().join("Lib").join("site-packages").join("homr")
}
fn homr_exe() -> PathBuf {
    homr_venv().join("Scripts").join("homr.exe")
}
fn sr_dir() -> PathBuf {
    omr_root().join("waifu2x")
}
fn sr_exe() -> PathBuf {
    sr_dir().join("waifu2x-ncnn-vulkan.exe")
}

fn lang_catalog_json() -> Value {
    Value::Array(
        LANG_CATALOG
            .iter()
            .map(|(code, name)| json!({ "code": code, "name": name }))
            .collect(),
    )
}

fn omr_engine_status() -> Value {
    let exe = omr_engine_exe();
    let installed = exe.is_file();
    json!({
        "ok": true,
        "installed": installed,
        "exe": exe.display().to_string(),
        "version": OMR_VERSION,
        "bytes": if installed { file_len(&exe) } else { 0 },
        "package": OMR_MSI_NAME,
        "url": OMR_MSI_URL,
    })
}

fn omr_lang_status() -> Value {
    let dir = tess_dir();
    let mut installed: Vec<Value> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let Some(code) = name.strip_suffix(".traineddata") else {
                continue;
            };
            let p = e.path();
            let bytes = file_len(&p);
            if bytes < LANG_MIN_BYTES {
                continue; // 半截 / fast 版不算装好（Audiveris 用不了 fast）
            }
            installed.push(json!({ "code": code, "bytes": bytes }));
        }
    }
    json!({
        "ok": true,
        "dir": dir.display().to_string(),
        "installed": installed,
        "catalog": lang_catalog_json(),
    })
}

fn homr_status() -> Value {
    let mut weights: Vec<Value> = Vec::new();
    let mut weight_bytes = 0u64;
    for (_zip, dir, file) in HOMR_WEIGHTS {
        let p = homr_site().join(dir).join(file);
        let size = file_len(&p);
        let has = size > 1024 * 1024;
        weight_bytes += size;
        weights.push(json!({ "file": file, "installed": has, "bytes": size }));
    }
    let py = venv_python(&homr_venv());
    let has_venv = py.is_file();
    let probe = if has_venv {
        probe_homr(&py)
    } else {
        json!({ "ok": false, "reason": "未创建运行环境", "providers": "" })
    };
    let weights_ok = HOMR_WEIGHTS.iter().all(|(_, dir, file)| {
        file_len(&homr_site().join(dir).join(file)) > 1024 * 1024
    });
    let probe_ok = probe.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let providers = probe.get("providers").and_then(|v| v.as_str()).unwrap_or("");
    json!({
        "ok": true,
        "installed": homr_exe().is_file() || has_venv,
        "ready": weights_ok && probe_ok,
        "broken": has_venv && !probe_ok,
        "reason": probe.get("reason").cloned().unwrap_or(json!("")),
        "providers": providers,
        "gpu": providers.to_ascii_lowercase().contains("cuda"),
        "version": HOMR_VERSION,
        "dir": homr_dir().display().to_string(),
        "exe": homr_exe().display().to_string(),
        "weights": weights,
        "weightBytes": weight_bytes,
        "missing": weights.iter().filter(|w| w["installed"].as_bool() != Some(true)).count(),
        "license": "AGPL-3.0（权重含 PrIMuS 非商用数据）",
    })
}

fn sr_status() -> Value {
    let exe_bytes = file_len(&sr_exe());
    let mut models: Vec<Value> = Vec::new();
    let mut model_bytes = 0u64;
    for name in SR_MODELS {
        let dir = sr_dir().join(name);
        let bytes = dir_size(&dir);
        model_bytes += bytes;
        models.push(json!({ "name": name, "installed": bytes > 1024 * 1024, "bytes": bytes }));
    }
    let installed = exe_bytes > 1024 * 1024 && models.iter().any(|m| m["installed"].as_bool() == Some(true));
    json!({
        "ok": true,
        "installed": installed,
        "version": SR_VERSION,
        "dir": sr_dir().display().to_string(),
        "exe": sr_exe().display().to_string(),
        "models": models,
        "bytes": exe_bytes + model_bytes,
        "missing": models.iter().filter(|m| m["installed"].as_bool() != Some(true)).count(),
        "license": "MIT（waifu2x-ncnn-vulkan · nihui）",
        "upstream": SR_UPSTREAM,
    })
}

fn venv_python(venv: &Path) -> PathBuf {
    let win = venv.join("Scripts").join("python.exe");
    if win.is_file() {
        return win;
    }
    venv.join("bin").join("python")
}

fn python_minor(py: &Path) -> String {
    let mut cmd = Command::new(py);
    cmd.args(["-c", "import sys; print('%d.%d' % sys.version_info[:2])"])
        .stdin(Stdio::null());
    hidden(&mut cmd);
    cmd.env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1");
    match cmd.output() {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => String::new(),
    }
}

fn probe_homr(py: &Path) -> Value {
    let mut cmd = Command::new(py);
    cmd.args([
        "-c",
        "import numpy,onnxruntime as o;print('OK',o.get_available_providers())",
    ])
    .stdin(Stdio::null());
    hidden(&mut cmd);
    cmd.env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1");
    match cmd.output() {
        Ok(out) => {
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            let providers = text
                .lines()
                .find_map(|l| l.trim().strip_prefix("OK "))
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            let ok = out.status.success() && !providers.is_empty();
            let reason = if ok {
                String::new()
            } else {
                text.lines()
                    .filter(|l| !l.trim().is_empty())
                    .rev()
                    .take(2)
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(220)
                    .collect()
            };
            json!({ "ok": ok, "providers": providers, "reason": reason })
        }
        Err(e) => json!({ "ok": false, "providers": "", "reason": e.to_string() }),
    }
}

fn omr_emit(app: &AppHandle, phase: &str, percent: u8, text: &str) {
    let _ = app.emit(
        OMR_EVENT,
        json!({ "phase": phase, "percent": percent, "text": text, "done": false }),
    );
}

fn lang_urls(code: &str) -> Vec<String> {
    let raw = format!("{LANG_RAW}{code}.traineddata");
    vec![
        format!("https://ghfast.top/{raw}"),
        format!("https://gh-proxy.com/{raw}"),
        format!("https://gh.jasonzeng.dev/{raw}"),
        raw,
    ]
}

fn sr_urls() -> Vec<String> {
    vec![
        format!("https://gh-proxy.com/{SR_UPSTREAM}"),
        format!("https://ghfast.top/{SR_UPSTREAM}"),
        format!("https://ghproxy.net/{SR_UPSTREAM}"),
        SR_UPSTREAM.to_string(),
    ]
}

fn homr_ckpt_urls(zip: &str) -> Vec<String> {
    let raw = format!("{HOMR_CKPT}{zip}");
    vec![
        format!("https://gh-proxy.com/{raw}"),
        format!("https://gh.jasonzeng.dev/{raw}"),
        format!("https://ghfast.top/{raw}"),
        raw,
    ]
}

/// 识谱引擎（Audiveris MSI）：下载 → SHA-256 校验 → msiexec /a 静默解包（不写注册表、无需管理员）。
pub fn omr_engine_install(app: &AppHandle) -> Value {
    if omr_engine_exe().is_file() {
        let peer = Peer::new(app, OMR_EVENT, json!({ "phase": "done", "text": "识谱引擎已就绪" }));
        peer.send_extra(0, 0, 100, true, json!({ "ok": true, "existed": true }));
        let mut st = omr_engine_status();
        st["existed"] = json!(true);
        return st;
    }
    let Some(job) = job_begin("omr") else {
        return json!({ "ok": false, "error": "OMR 组件安装正在进行中（引擎 / 语言包 / homr / 超分），请等待或取消" });
    };
    let msi = data_dir().join("temp").join(format!("audiveris-{}.msi", unique_stamp()));
    let app2 = app.clone();
    run_job(&app2, job, OMR_EVENT, move |app3, job3| {
        let peer = Peer::new(app3, OMR_EVENT, json!({ "phase": "download", "text": "下载识谱引擎…" }));
        let urls = vec![
            format!("https://ghfast.top/{OMR_MSI_URL}"),
            format!("https://gh-proxy.com/{OMR_MSI_URL}"),
            format!("https://gh.jasonzeng.dev/{OMR_MSI_URL}"),
            OMR_MSI_URL.to_string(),
        ];
        let spec = DlSpec {
            urls: &urls,
            dest: &msi,
            label: "识谱引擎",
            min_size: OMR_MSI_BYTES,
            max_size: OMR_MSI_BYTES,
            expect_total: OMR_MSI_BYTES,
            verify_exact: true,
            pct_lo: 0,
            pct_hi: 86,
        };
        match dl_download(job3, Some(&peer), &spec) {
            Ok(_) => {}
            Err(JobFail::Canceled) => {
                remove_path(&msi);
                peer.send_extra(0, 0, 0, true, json!({ "canceled": true, "error": "已取消" }));
                return json!({ "ok": false, "canceled": true, "error": "已取消安装" });
            }
            Err(JobFail::Failed(e)) => {
                remove_path(&msi);
                return json!({ "ok": false, "error": format!("下载识谱引擎失败：{e}") });
            }
        }
        omr_emit(app3, "verify", 87, "校验识谱引擎…");
        let got = sha256_file(&msi).unwrap_or_default();
        if !got.eq_ignore_ascii_case(OMR_MSI_SHA256) {
            remove_path(&msi);
            return json!({
                "ok": false,
                "error": format!("安装包指纹不符（期望 {}…，实得 {}…），已丢弃", &OMR_MSI_SHA256[..16], got.chars().take(16).collect::<String>()),
            });
        }
        omr_emit(app3, "extract", 88, "解包识谱引擎…");
        let dir = omr_engine_dir();
        if let Err(e) = std::fs::create_dir_all(&dir) {
            remove_path(&msi);
            return json!({ "ok": false, "error": format!("创建解包目录失败：{e}") });
        }
        // msiexec /a = administrative install：只解包到 TARGETDIR，不安装、不弹窗、不需要管理员。
        let mut cmd = Command::new("msiexec.exe");
        hidden(&mut cmd).args([
            "/a",
            &msi.display().to_string(),
            "/qn",
            &format!("TARGETDIR={}", dir.display()),
        ]);
        let code = match run_streaming(job3, &mut cmd, |_line| {}) {
            Ok(c) => c,
            Err(JobFail::Canceled) => {
                remove_path(&msi);
                peer.send_extra(0, 0, 0, true, json!({ "canceled": true, "error": "已取消" }));
                return json!({ "ok": false, "canceled": true, "error": "已取消解包" });
            }
            Err(JobFail::Failed(e)) => {
                remove_path(&msi);
                return json!({ "ok": false, "error": format!("调用 msiexec 失败：{e}") });
            }
        };
        remove_path(&msi);
        if !omr_engine_exe().is_file() {
            return json!({
                "ok": false,
                "error": format!("解包失败：没有找到 {}（msiexec 退出码 {code}）", omr_engine_exe().display()),
            });
        }
        omr_emit(app3, "done", 100, "识谱引擎就绪");
        omr_engine_status()
    })
}

fn parse_lang_codes(codes: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |s: &str| {
        let c = s.trim().to_ascii_lowercase();
        if c.len() >= 2
            && c.len() <= 12
            && c.chars().all(|ch| ch.is_ascii_lowercase() || ch == '_')
            && LANG_CATALOG.iter().any(|(code, _)| *code == c)
            && !out.iter().any(|x| x == &c)
        {
            out.push(c);
        }
    };
    match codes {
        Value::String(s) => push(s),
        Value::Array(a) => {
            for x in a {
                if let Some(s) = x.as_str() {
                    push(s);
                }
            }
        }
        _ => {}
    }
    out
}

/// OCR 语言包（完整版 tessdata，不是 fast 版）安装到 <数据根>/omr/tessdata。
pub fn omr_lang_install(app: &AppHandle, codes: Value) -> Value {
    let want = parse_lang_codes(&codes);
    if want.is_empty() {
        return json!({ "ok": false, "error": "没有可安装的语言代码", "catalog": lang_catalog_json() });
    }
    let Some(job) = job_begin("omr") else {
        return json!({ "ok": false, "error": "OMR 组件安装正在进行中，请等待或取消" });
    };
    let dir = tess_dir();
    let _ = std::fs::create_dir_all(&dir);
    let app2 = app.clone();
    run_job(&app2, job, OMR_EVENT, move |app3, job3| {
        let n = want.len();
        let mut added: Vec<String> = Vec::new();
        for (i, code) in want.iter().enumerate() {
            let base = ((i as u32 * 100) / n as u32) as u8;
            let span = (100 / n as u32) as u8;
            let hi = base.saturating_add(span).min(99);
            let text = format!("下载语言包 {code}");
            omr_emit(app3, "lang", base, &text);
            let peer = Peer::new(app3, OMR_EVENT, json!({ "phase": "lang", "text": text }));
            let dst = dir.join(format!("{code}.traineddata"));
            let urls = lang_urls(code);
            let spec = DlSpec {
                urls: &urls,
                dest: &dst,
                label: code,
                min_size: LANG_MIN_BYTES,
                max_size: u64::MAX,
                expect_total: 0,
                verify_exact: false,
                pct_lo: base,
                pct_hi: hi,
            };
            match dl_download(job3, Some(&peer), &spec) {
                Ok(_) => added.push(code.clone()),
                Err(JobFail::Canceled) => {
                    remove_path(&dst);
                    peer.send_extra(0, 0, 0, true, json!({ "canceled": true, "error": "已取消" }));
                    return json!({ "ok": false, "canceled": true, "error": "已取消语言包安装", "added": added });
                }
                Err(JobFail::Failed(e)) => {
                    remove_path(&dst);
                    peer.send_extra(0, 0, 0, true, json!({ "error": e.clone() }));
                    return json!({ "ok": false, "error": format!("{code}：{e}"), "added": added });
                }
            }
        }
        omr_emit(app3, "done", 100, "语言包就绪");
        let mut st = omr_lang_status();
        st["added"] = json!(added);
        st
    })
}

/// 超分辨率组件（waifu2x-ncnn-vulkan）：低清扫描件专用，解压后落到 <数据根>/omr/waifu2x。
pub fn omr_sr_install(app: &AppHandle) -> Value {
    let Some(job) = job_begin("omr") else {
        return json!({ "ok": false, "error": "OMR 组件安装正在进行中，请等待或取消" });
    };
    let tmp_zip = data_dir().join("temp").join(SR_ZIP_NAME);
    let tmp_dst = data_dir().join("temp").join("waifu2x-unzip");
    let app2 = app.clone();
    run_job(&app2, job, OMR_EVENT, move |app3, job3| {
        let _ = std::fs::create_dir_all(sr_dir());
        let peer = Peer::new(app3, OMR_EVENT, json!({ "phase": "sr-download", "text": "下载超分辨率组件（约 36 MB）" }));
        let urls = sr_urls();
        let spec = DlSpec {
            urls: &urls,
            dest: &tmp_zip,
            label: "超分辨率组件",
            min_size: SR_MIN_BYTES,
            max_size: u64::MAX,
            expect_total: 0,
            verify_exact: false,
            pct_lo: 2,
            pct_hi: 90,
        };
        match dl_download(job3, Some(&peer), &spec) {
            Ok(_) => {}
            Err(JobFail::Canceled) => {
                remove_path(&tmp_zip);
                peer.send_extra(0, 0, 0, true, json!({ "canceled": true, "error": "已取消" }));
                return json!({ "ok": false, "canceled": true, "error": "已取消下载超分辨率组件" });
            }
            Err(JobFail::Failed(e)) => {
                remove_path(&tmp_zip);
                return json!({ "ok": false, "error": format!("下载失败：{e}") });
            }
        }
        omr_emit(app3, "sr-unzip", 94, "解压超分辨率组件…");
        remove_path(&tmp_dst);
        match safe_extract_zip(&tmp_zip, &tmp_dst, Some(job3), false) {
            Ok(_) => {}
            Err(e) if e == "__canceled" => {
                remove_path(&tmp_zip);
                remove_path(&tmp_dst);
                return json!({ "ok": false, "canceled": true, "error": "已取消解压" });
            }
            Err(e) => {
                remove_path(&tmp_zip);
                remove_path(&tmp_dst);
                return json!({ "ok": false, "error": format!("解压失败：{e}") });
            }
        }
        // zip 里多一层 waifu2x-ncnn-vulkan-<版本>-windows/，把里面内容挪到 sr_dir 根下
        let inner = std::fs::read_dir(&tmp_dst).ok().and_then(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .find(|p| p.is_dir())
        });
        let src = inner.unwrap_or_else(|| tmp_dst.clone());
        let copy_err = copy_tree(&src, &sr_dir()).err();
        remove_path(&tmp_zip);
        remove_path(&tmp_dst);
        if let Some(e) = copy_err {
            return json!({ "ok": false, "error": format!("安装超分辨率组件失败：{e}") });
        }
        let st = sr_status();
        if st["installed"].as_bool() != Some(true) {
            return json!({ "ok": false, "error": "解压后没找到 waifu2x-ncnn-vulkan.exe" });
        }
        omr_emit(app3, "done", 100, "超分辨率组件就绪");
        st
    })
}

/// homr（AI 识谱）：独立 venv + pip 依赖 + 3 个权重包。
pub fn omr_homr_install(app: &AppHandle) -> Value {
    let Some(base_py) = python_path() else {
        return json!({ "ok": false, "error": "没有找到内置 Python 运行时，无法创建独立环境" });
    };
    let Some(job) = job_begin("omr") else {
        return json!({ "ok": false, "error": "OMR 组件安装正在进行中，请等待或取消" });
    };
    let venv = homr_venv();
    let vpy = venv_python(&venv);
    let app2 = app.clone();
    run_job(&app2, job, OMR_EVENT, move |app3, job3| {
        let _ = std::fs::create_dir_all(homr_dir());
        // 版本护栏：运行时升级（3.11→3.12）后老 venv 的扩展全是 cp3xx，pip 重装救不回来，只能重建。
        let want_minor = python_minor(&base_py);
        if vpy.is_file() && !want_minor.is_empty() {
            let cfg = std::fs::read_to_string(venv.join("pyvenv.cfg")).unwrap_or_default();
            let have_minor = cfg
                .lines()
                .filter(|l| l.trim_start().starts_with("version"))
                .find_map(|l| l.split('=').nth(1))
                .map(|v| v.trim().split('.').take(2).collect::<Vec<_>>().join("."))
                .unwrap_or_default();
            if !have_minor.is_empty() && have_minor != want_minor {
                omr_emit(app3, "homr-venv", 2, &format!("内置运行时已升到 Python {want_minor}，正在重建识谱环境…"));
                remove_path(&venv);
            }
        }
        if !vpy.is_file() {
            omr_emit(app3, "homr-venv", 2, "创建 homr 独立运行环境…");
            let mut cmd = Command::new(&base_py);
            cmd.args(["-m", "venv", &venv.display().to_string()]);
            hidden(&mut cmd).env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1");
            match run_streaming(job3, &mut cmd, |_l| {}) {
                Ok(_) => {}
                Err(JobFail::Canceled) => {
                    return json!({ "ok": false, "canceled": true, "error": "已取消创建运行环境" })
                }
                Err(JobFail::Failed(e)) => {
                    return json!({ "ok": false, "error": format!("创建 venv 失败：{e}") })
                }
            }
            if !venv_python(&venv).is_file() {
                return json!({ "ok": false, "error": "创建 venv 失败：没有生成 Scripts/python.exe" });
            }
        }
        // 已装就跳过 pip（避免每次重装 200MB）
        let probe = {
            let mut cmd = Command::new(venv_python(&venv));
            cmd.args(["-c", "import homr"]);
            hidden(&mut cmd).env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1");
            run_streaming(job3, &mut cmd, |_l| {}).unwrap_or(-1)
        };
        if probe != 0 {
            let mut last_err = String::new();
            let mut ok = false;
            for idx in PIP_INDEXES {
                if job3.is_canceled() {
                    break;
                }
                omr_emit(app3, "homr-pip", 8, &format!("安装 homr 依赖（{}）…", idx.trim_start_matches("https://").split('/').next().unwrap_or(idx)));
                let vp = venv_python(&venv);
                let mut cmd = Command::new(vp);
                cmd.args([
                    "-m", "pip", "install", "--no-input", "--disable-pip-version-check",
                    &format!("homr=={HOMR_VERSION}"), "onnxruntime-gpu", "-i", idx,
                ]);
                hidden(&mut cmd).env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1");
                let mut out_tail = String::new();
                let r = run_streaming(job3, &mut cmd, |line| {
                    let t = line.trim();
                    if t.starts_with("Downloading") {
                        omr_emit(app3, "homr-pip", 12, &format!("下载 {}", tail_chars(t.trim_start_matches("Downloading").trim(), 48)));
                    }
                    out_tail = tail_chars(&format!("{out_tail}{t}\n"), 800);
                });
                match r {
                    Ok(0) => {
                        ok = true;
                        break;
                    }
                    Ok(code) => {
                        last_err = format!("pip 退出码 {code}：{}", tail_chars(&out_tail, 300));
                    }
                    Err(JobFail::Canceled) => {
                        return json!({ "ok": false, "canceled": true, "error": "已取消安装 homr" })
                    }
                    Err(JobFail::Failed(e)) => last_err = e,
                }
            }
            if !ok {
                return json!({ "ok": false, "error": format!("安装 homr 失败：{last_err}") });
            }
        }
        // 权重：统一下载器（镜像可回退），失败退回 homr --init
        let tmp = data_dir().join("temp").join("homr-weights");
        let _ = std::fs::create_dir_all(&tmp);
        for (i, (zip, dir, file)) in HOMR_WEIGHTS.iter().enumerate() {
            let dst_file = homr_site().join(dir).join(file);
            if file_len(&dst_file) > 1024 * 1024 {
                continue;
            }
            let base = 55 + (i as u32 * 35 / HOMR_WEIGHTS.len() as u32) as u8;
            let label = format!("下载 AI 权重 {}/{}", i + 1, HOMR_WEIGHTS.len());
            omr_emit(app3, "homr-weights", base, &label);
            let peer = Peer::new(app3, OMR_EVENT, json!({ "phase": "homr-weights", "text": label }));
            let zip_tmp = tmp.join(zip);
            let urls = homr_ckpt_urls(zip);
            let spec = DlSpec {
                urls: &urls,
                dest: &zip_tmp,
                label: file,
                min_size: 1024 * 1024,
                max_size: u64::MAX,
                expect_total: 0,
                verify_exact: false,
                pct_lo: base,
                pct_hi: base.saturating_add(8).min(96),
            };
            match dl_download(job3, Some(&peer), &spec) {
                Ok(_) => {
                    let target = homr_site().join(dir);
                    let _ = std::fs::create_dir_all(&target);
                    if safe_extract_zip(&zip_tmp, &target, Some(job3), false).is_err() {
                        // 解压失败不致命：下面还有 homr --init 兜底
                    }
                }
                Err(JobFail::Canceled) => {
                    remove_path(&zip_tmp);
                    return json!({ "ok": false, "canceled": true, "error": "已取消下载 AI 权重" });
                }
                Err(_) => {
                    // 交给 homr --init 兜底
                }
            }
            remove_path(&zip_tmp);
            if file_len(&dst_file) <= 1024 * 1024 {
                omr_emit(app3, "homr-weights", base, "改用 homr 自带下载…");
                let mut cmd = Command::new(homr_exe());
                cmd.arg("--init");
                hidden(&mut cmd).env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1");
                let _ = run_streaming(job3, &mut cmd, |_l| {});
                if file_len(&dst_file) <= 1024 * 1024 {
                    return json!({ "ok": false, "error": format!("下载权重失败：{file} 仍不存在，可重试或检查网络") });
                }
            }
        }
        omr_emit(app3, "done", 100, "homr 就绪");
        homr_status()
    })
}

/// 取消进行中的 OMR 组件安装（引擎 / 语言包 / homr / 超分共用一个任务槽）。
pub fn omr_cancel_install() -> Value {
    let hit = job_cancel("omr");
    json!({ "ok": true, "canceled": hit })
}

/* ================================ 插件宿主 ================================ */

/// 插件命令调用：Tauri 侧目前没有等价的 JS 插件宿主，如实返回缺什么（不假成功）。
///
/// Electron 的实现是 main/plugins.js 里的 PluginHost（plugin-host.js 只负责 VST3 渲染），
/// 它要求：Node 的 require/模块解析、插件清单里的 commands 分发表、events 桥
/// （listen/emit + app:event 广播）、插件设置与会话上下文注入。这些在 Tauri 的 Rust 侧
/// 没有等价物，也没有内嵌 JS 引擎可用（Cargo 里没有 boa/rquickjs）。
pub fn plugins_invoke(id: String, cmd: String, payload: Value) -> Value {
    json!({
        "ok": false,
        "id": id,
        "cmd": cmd,
        "error": format!(
            "插件「{id}」的命令 {cmd} 未移植：Tauri 侧没有等价的 JS 插件宿主（Electron 的 PluginHost 依赖 Node require 与事件桥）"
        ),
        "missing": [
            "插件加载：按 plugins/<id>/plugin.json 定位 entry，用 JS 运行时执行（Node require / 沙箱）",
            "命令分发：plugin.json 的 commands → invoke(cmd, payload) 注册表",
            "事件桥：broadcast 与 app:event（song-loaded / view-changed / transcribe-done / refine-done）",
            "上下文注入：readSettings/writeSettings、当前曲目 meta、启停状态",
        ],
        "available": {
            "manifest": "plugins_list / plugins_rescan（main.rs，扫描 plugin.json）",
            "vst3": "plugin_host_python + plugin_render_file（main.rs，Python pedalboard 宿主）",
        },
        "hint": "纯 VST3 渲染走 plugin_render_file；要恢复 JS 插件需内嵌 JS 引擎（boa / rquickjs）或由 Python 子进程拉起 Node",
        "payload": payload,
    })
}

/* ================================ 更新包 ================================ */

const UPDATE_ASSET: &str = "FuFumidi.Install.exe";
const CNB_RELEASES_BASE: &str = "https://cnb.cool/FuFuCloud-mirror/FuFuMIDI/-/releases/";
const UPDATE_GH_MIRRORS: [&str; 3] = [
    "https://ghfast.top/",
    "https://gh-proxy.com/",
    "https://ghproxy.net/",
];
const UPDATE_MIN_BYTES: u64 = 10 * 1024 * 1024;

fn update_candidates(url: &str, channel: &str) -> Vec<String> {
    let cnb = if channel == "beta" {
        format!("{CNB_RELEASES_BASE}download/beta/{UPDATE_ASSET}")
    } else {
        format!("{CNB_RELEASES_BASE}latest/download/{UPDATE_ASSET}")
    };
    let mut gh: Vec<String> = Vec::new();
    if url.starts_with("https://github.com/") {
        for prefix in UPDATE_GH_MIRRORS {
            gh.push(format!("{prefix}{url}"));
        }
    }
    if !url.is_empty() {
        gh.push(url.to_string());
    }
    let mut out: Vec<String> = Vec::new();
    let push = |u: String, out: &mut Vec<String>| {
        if !u.is_empty() && !out.iter().any(|x| x == &u) {
            out.push(u);
        }
    };
    if prefer_cnb() {
        push(cnb, &mut out);
        for u in gh {
            push(u, &mut out);
        }
    } else {
        for u in gh {
            push(u, &mut out);
        }
        push(cnb, &mut out);
    }
    out
}

fn looks_like_pe(path: &Path) -> bool {
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut head = [0u8; 2];
    if f.read_exact(&mut head).is_err() {
        return false;
    }
    head[0] == 0x4d && head[1] == 0x5a // "MZ"
}

/// 下载离线安装包（多源回退 + .part + 大小/PE 头校验）。
///
/// 注意：这个包装的签名没有 AppHandle，因此**无法发 update:progress、也无法取消** ——
/// 这是冻结签名带来的限制（Electron 侧 update:download 会带窗口发进度）。
pub fn update_download(url: String, channel: Option<String>, name: Option<String>, size: Option<u64>) -> Value {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return json!({ "ok": false, "error": "无效 URL" });
    }
    let ch = match channel.as_deref().map(|s| s.to_ascii_lowercase()).as_deref() {
        Some("beta") => "beta",
        _ => "stable",
    };
    let dir = data_dir().join("temp").join("fufumidi-update");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return json!({ "ok": false, "error": format!("创建下载目录失败：{e}") });
    }
    let fname = safe_file_name(
        name.as_deref()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| url.split('/').next_back().filter(|s| !s.is_empty()))
            .unwrap_or(UPDATE_ASSET),
        UPDATE_ASSET,
    );
    let dest = dir.join(&fname);
    let candidates = update_candidates(&url, ch);
    let job = Job::new("update-download");
    let expect = size.unwrap_or(0);
    let spec = DlSpec {
        urls: &candidates,
        dest: &dest,
        label: "更新安装包",
        min_size: UPDATE_MIN_BYTES,
        max_size: u64::MAX,
        expect_total: expect,
        verify_exact: false,
        pct_lo: 0,
        pct_hi: 99,
    };
    match dl_download(&job, None, &spec) {
        Ok(n) => {
            if expect > 0 && n * 10 < expect * 9 {
                remove_path(&dest);
                return json!({ "ok": false, "error": format!("安装包不完整：{n}/{expect} 字节（传输被截断，已丢弃）") });
            }
            if !looks_like_pe(&dest) {
                remove_path(&dest);
                return json!({
                    "ok": false,
                    "error": "返回的不是安装包（PE 头不是 MZ，可能被镜像拦截或改写），已丢弃",
                });
            }
            json!({
                "ok": true,
                "path": dest.display().to_string(),
                "size": n,
                "channel": ch,
                "verified": false,
                "note": "签名清单校验（update-manifest.json）尚未移植：主进程侧只做大小 + PE 头校验",
            })
        }
        Err(JobFail::Canceled) => json!({ "ok": false, "canceled": true, "error": "已取消" }),
        Err(JobFail::Failed(e)) => json!({ "ok": false, "error": format!("下载失败：{e}") }),
    }
}

pub fn update_open(path: String) -> Value {
    let p = Path::new(&path);
    if !p.exists() {
        return json!({ "ok": false, "error": format!("文件不存在：{path}") });
    }
    let mut cmd = Command::new("explorer.exe");
    hidden(&mut cmd).arg(&path);
    match cmd.spawn() {
        Ok(_) => json!({ "ok": true, "path": path }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

/* ================================ 动态壁纸 ================================ */

fn wallpaper_dir() -> PathBuf {
    let base = std::env::var("APPDATA")
        .ok()
        .map(|a| PathBuf::from(a).join("FuFumidi").join("fufumidi"))
        .unwrap_or_else(data_dir);
    base.join("wallpapers")
}

fn is_video_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with(".mp4") || n.ends_with(".webm") || n.ends_with(".mov")
}

/// 动态壁纸下载：写 .part → 校验非空 → 改名 → 写 <文件名>.ok 完成标记（与 main.rs 的列表判定一致）。
///
/// 与 update_download 同样受冻结签名限制：没有 AppHandle，无法发 wallpaper:downloadProgress。
pub fn wallpaper_download(url: String, name: Option<String>) -> Value {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return json!({ "ok": false, "error": "无效 URL" });
    }
    let dir = wallpaper_dir();
    let _ = std::fs::create_dir_all(&dir);
    let raw = name.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| {
        url.split('?')
            .next()
            .and_then(|u| u.rsplit('/').next())
            .filter(|s| !s.is_empty())
            .unwrap_or("wallpaper.mp4")
            .to_string()
    });
    let safe = safe_file_name(&raw, "wallpaper.mp4");
    if !is_video_name(&safe) {
        return json!({ "ok": false, "error": "只支持 mp4 / webm / mov 动态壁纸", "name": safe });
    }
    let dest = dir.join(&safe);
    let job = Job::new("wallpaper-download");
    let urls = vec![url.clone()];
    let spec = DlSpec {
        urls: &urls,
        dest: &dest,
        label: "动态壁纸",
        min_size: 64 * 1024,
        max_size: u64::MAX,
        expect_total: 0,
        verify_exact: false,
        pct_lo: 0,
        pct_hi: 99,
    };
    match dl_download(&job, None, &spec) {
        Ok(n) => {
            let _ = std::fs::write(PathBuf::from(format!("{}.ok", dest.display())), b"1");
            json!({
                "ok": true,
                "path": dest.display().to_string(),
                "name": safe,
                "size": n,
                "note": "壁纸下载的进度事件需 AppHandle（冻结签名没有），已省略",
            })
        }
        Err(JobFail::Canceled) => json!({ "ok": false, "canceled": true, "error": "已取消" }),
        Err(JobFail::Failed(e)) => json!({ "ok": false, "error": format!("下载失败：{e}") }),
    }
}

/* ================================ 乐谱导出 ================================ */

fn tile_bytes(v: &Value) -> Vec<u8> {
    match v {
        Value::Object(o) => o.get("data").map(json_bytes).unwrap_or_default(),
        _ => json_bytes(v),
    }
}

/// 把前端传来的 PNG 分页写成 ZIP（score-001.png …）。返回写入的页数。
fn write_png_zip(tiles: &[Value], out: &Path) -> Result<usize, String> {
    if tiles.is_empty() {
        return Err("empty tiles".to_string());
    }
    if let Some(parent) = out.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let file = std::fs::File::create(out).map_err(|e| format!("创建 ZIP 失败：{e}"))?;
    use std::io::Write as _;
    let mut zw = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut count = 0usize;
    for (i, t) in tiles.iter().enumerate() {
        let bytes = tile_bytes(t);
        if bytes.is_empty() {
            continue;
        }
        let name = format!("score-{:03}.png", i + 1);
        zw.start_file(&name, opts).map_err(|e| e.to_string())?;
        zw.write_all(&bytes).map_err(|e| format!("写入 {name} 失败：{e}"))?;
        count += 1;
    }
    zw.finish().map_err(|e| format!("收尾 ZIP 失败：{e}"))?;
    if count == 0 {
        remove_path(out);
        return Err("tiles 里没有有效的 PNG 数据".to_string());
    }
    Ok(count)
}

/// 乐谱 PNG 分页包导出。
///
/// 冻结签名没有 AppHandle → 无法弹「另存为」对话框。因此要求调用方在 opts.path 里给目标路径；
/// 没给就返回明确错误（不假装成功，也不默默丢到某个目录）。
pub fn export_score_png_zip(opts: Value) -> Value {
    if opts.is_null() {
        return json!({ "ok": false, "error": "empty tiles" });
    }
    let tiles = match opts.get("tiles").and_then(|v| v.as_array()) {
        Some(a) if !a.is_empty() => a.clone(),
        _ => return json!({ "ok": false, "error": "empty tiles" }),
    };
    let target = opts
        .get("path")
        .or_else(|| opts.get("targetPath"))
        .or_else(|| opts.get("out"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    // 冻结签名没有 AppHandle → 弹不了「另存为」。给了 path 就按 path 写；没给就落到
    // <数据根>/exports/ 下（返回值里带完整路径，界面会把路径 toast 出来），不假装成功。
    let (out, default_path) = match target {
        Some(t) => (PathBuf::from(t), false),
        None => {
            let base = opts
                .get("name")
                .and_then(|v| v.as_str())
                .map(|s| safe_file_name(s, "score"))
                .unwrap_or_else(|| "score".to_string());
            let dir = data_dir().join("exports");
            let _ = std::fs::create_dir_all(&dir);
            (dir.join(format!("{base}-{}.zip", unique_stamp())), true)
        }
    };
    let target = out.display().to_string();
    match write_png_zip(&tiles, &out) {
        Ok(n) => {
            let mut v = json!({ "ok": true, "path": target, "pages": n });
            if default_path {
                v["defaultPath"] = json!(true);
                v["note"] = json!("固定签名没有 AppHandle，无法弹「另存为」；已导出到数据根 exports/ 目录");
            }
            v
        }
        Err(e) => {
            remove_path(&out);
            json!({ "ok": false, "error": e })
        }
    }
}

/// 乐谱 PDF 导出：Tauri/WebView2 没有 Chromium 的 printToPDF 等价 API。
pub fn export_score_pdf() -> Value {
    json!({
        "ok": false,
        "error": "乐谱 PDF 导出未移植：Electron 走 win.webContents.printToPDF + 打印 CSS，Tauri/WebView2 没有等价的 Rust API",
        "missing": [
            "AppHandle：选择保存路径（冻结签名没有）",
            "渲染进程栅格化：Electron 的 score:exportPdfPages 由前端把每页转成 PNG 再交给 Python(PIL) 合成 PDF",
        ],
        "alternatives": [
            "先导出「PNG 分页包」（export_score_png_zip，传 opts.path）再外部转 PDF",
            "由前端调用 window.print() 走浏览器打印为 PDF",
        ],
    })
}

/* ================================ 视频转码 ================================ */

fn transcode_args(webm: &Path, wav: Option<&Path>, out: &str, audio_offset: f64) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-i".into(),
        webm.display().to_string(),
    ];
    if let Some(w) = wav {
        if audio_offset > 0.0 {
            args.push("-ss".into());
            args.push(format!("{audio_offset:.6}"));
        }
        args.push("-i".into());
        args.push(w.display().to_string());
        args.push("-map".into());
        args.push("0:v:0".into());
        args.push("-map".into());
        args.push("1:a:0".into());
    }
    args.extend([
        "-c:v".into(),
        "libx264".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-c:a".into(),
        "aac".into(),
        "-shortest".into(),
        "-movflags".into(),
        "+faststart".into(),
        out.to_string(),
    ]);
    args
}

/// 旧通道（整段 WebM + WAV 一次性转 MP4）。
///
/// Rust 侧已有更完整的流式导出 video_export_begin/write/abort/end（main.rs:1384），
/// 它也负责保存对话框；这个命令只在调用方**自带目标路径**（opts.path）时可用。
pub fn transcode_video(opts: Value) -> Value {
    if opts.is_null() {
        return json!({ "ok": false, "error": "empty" });
    }
    let data = opts.get("data").map(json_bytes).unwrap_or_default();
    if data.is_empty() {
        return json!({ "ok": false, "error": "empty" });
    }
    let target = opts
        .get("path")
        .or_else(|| opts.get("targetPath"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let Some(target) = target else {
        return json!({
            "ok": false,
            "error": "transcode_video 需要目标路径：固定签名没有 AppHandle，无法弹保存对话框。流式导出请走 video_export_* 通道（main.rs 已有完整实现）",
            "missing": ["AppHandle（保存对话框）"],
            "howTo": "opts.path 给出 .mp4 目标路径即可；或在 main.rs 把包装函数改成接收 AppHandle",
        });
    };
    let dir = data_dir().join("temp").join("fufumidi-video");
    let _ = std::fs::create_dir_all(&dir);
    let stamp = unique_stamp();
    let webm = dir.join(format!("{stamp}.webm"));
    if let Err(e) = std::fs::write(&webm, &data) {
        return json!({ "ok": false, "error": format!("写入临时 WebM 失败：{e}") });
    }
    let audio = opts.get("audio").map(json_bytes).unwrap_or_default();
    let wav = if audio.is_empty() {
        None
    } else {
        let p = dir.join(format!("{stamp}.wav"));
        if let Err(e) = std::fs::write(&p, &audio) {
            remove_path(&webm);
            return json!({ "ok": false, "error": format!("写入临时 WAV 失败：{e}") });
        }
        Some(p)
    };
    let offset = opts.get("audioOffset").and_then(|v| v.as_f64()).unwrap_or(0.0).max(0.0);
    let args = transcode_args(&webm, wav.as_deref(), &target, offset);
    let args_json = serde_json::to_string(&args).unwrap_or_else(|_| "[]".into());
    let code = format!(
        "import json, subprocess\nimport imageio_ffmpeg\nff = imageio_ffmpeg.get_ffmpeg_exe()\nr = subprocess.run([ff] + json.loads({args_json:?}), capture_output=True)\nprint(json.dumps({{'ok': r.returncode == 0, 'err': (r.stderr or b'').decode('utf-8', 'replace')[-300:]}}))"
    );
    let parsed = match run_python_inline(&code) {
        Ok((_ok, stdout, stderr)) => parse_result_json(&stdout).or_else(|| {
            serde_json::from_str::<Value>(stdout.trim()).ok()
        }).or_else(|| {
            if stdout.trim().is_empty() { Some(json!({ "ok": false, "error": tail_chars(&stderr, 300) })) } else { None }
        }),
        Err(e) => Some(json!({ "ok": false, "error": e })),
    };
    remove_path(&webm);
    if let Some(w) = &wav {
        remove_path(w);
    }
    match parsed {
        Some(v) if v.get("ok").and_then(|x| x.as_bool()) == Some(true) => json!({
            "ok": true,
            "path": target,
            "bytes": data.len(),
        }),
        Some(v) => json!({
            "ok": false,
            "error": v.get("err").and_then(|x| x.as_str()).unwrap_or("ffmpeg 转码失败"),
        }),
        None => json!({ "ok": false, "error": "ffmpeg helper 输出无法解析" }),
    }
}

/* ================================ 单元测试 ================================ */

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "fufumidi-extras-{tag}-{}-{}",
            std::process::id(),
            unique_stamp()
        ));
        let _ = std::fs::create_dir_all(&p);
        p
    }

    #[test]
    fn zip_entry_unsafe_rejects_traversal_and_absolute() {
        assert!(zip_entry_unsafe(""));
        assert!(zip_entry_unsafe("../evil.txt"));
        assert!(zip_entry_unsafe("a/../../evil.txt"));
        assert!(zip_entry_unsafe("/etc/passwd"));
        assert!(zip_entry_unsafe("C:/Windows/system32/x.dll"));
        assert!(zip_entry_unsafe("..\\evil.txt"));
        assert!(!zip_entry_unsafe("oto.ini"));
        assert!(!zip_entry_unsafe("sub/oto.ini"));
    }

    #[test]
    fn safe_file_name_strips_separators_and_dots() {
        assert_eq!(safe_file_name("a/b\\c:d*.sf2", "x.sf2"), "a_b_c_d_.sf2");
        assert_eq!(safe_file_name("..", "fallback.sf2"), "fallback.sf2");
        assert_eq!(safe_file_name("  ", "fallback.sf2"), "fallback.sf2");
        assert_eq!(safe_file_name("GeneralUser.sf2", "x"), "GeneralUser.sf2");
    }

    #[test]
    fn infer_gpu_kind_follows_electron_order() {
        assert_eq!(infer_gpu_kind("fufumidi-gpu-rvc.zip"), Some("rvc"));
        assert_eq!(infer_gpu_kind("fufumidi-gpu-cuda-part1"), Some("cuda"));
        assert_eq!(infer_gpu_kind("fufumidi-gpu-rocm.zip"), Some("rocm"));
        assert_eq!(infer_gpu_kind("torch-hip-2.5"), Some("rocm"));
        assert_eq!(infer_gpu_kind("fufumidi-gpu-xpu.zip"), Some("xpu"));
        assert_eq!(infer_gpu_kind("intel-oneapi-2025"), Some("xpu"));
        assert_eq!(infer_gpu_kind("nothing-here.zip"), None);
    }

    #[test]
    fn split_parts_sorted_by_trailing_number() {
        let assets = vec![
            json!({ "name": "fufumidi-gpu-cuda.part2", "browser_download_url": "u2", "size": 20 }),
            json!({ "name": "fufumidi-gpu-cuda.part1", "browser_download_url": "u1", "size": 10 }),
            json!({ "name": "fufumidi-gpu-cuda.zip", "browser_download_url": "single", "size": 5 }),
            json!({ "name": "fufumidi-gpu-rocm.zip.001", "browser_download_url": "r1", "size": 1 }),
        ];
        let parts = split_parts_for(&assets, "cuda");
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["name"], json!("fufumidi-gpu-cuda.part1"));
        assert_eq!(parts[1]["name"], json!("fufumidi-gpu-cuda.part2"));
        assert!(split_parts_for(&assets, "xpu").is_empty());
    }

    #[test]
    fn lang_codes_filtered_to_catalog() {
        let got = parse_lang_codes(&json!(["eng", "chi_sim", "ENG", "bad code", "xx", "jpn"]));
        assert_eq!(got, vec!["eng", "chi_sim", "jpn"]);
        assert!(parse_lang_codes(&json!("chi_tra")).contains(&"chi_tra".to_string()));
        assert!(parse_lang_codes(&json!(null)).is_empty());
    }

    #[test]
    fn is_split_archive_detects_both_naming_schemes() {
        assert!(is_split_archive("fufumidi-gpu-cuda.zip.001"));
        assert!(is_split_archive("fufumidi-gpu-cuda.part12"));
        assert!(!is_split_archive("fufumidi-gpu-cuda.zip"));
        assert!(!is_split_archive("normal.sf2"));
    }

    #[test]
    fn gpu_paths_from_req_supports_three_shapes() {
        let a = gpu_paths_from_req(&json!({ "paths": ["a.zip", "b.zip"] }));
        assert_eq!(a, vec!["a.zip", "b.zip"]);
        let b = gpu_paths_from_req(&json!({ "localPath": "c.zip" }));
        assert_eq!(b, vec!["c.zip"]);
        let c = gpu_paths_from_req(&json!({ "files": [{ "path": "d.zip" }, "e.zip"] }));
        assert_eq!(c, vec!["d.zip", "e.zip"]);
    }

    #[test]
    fn json_bytes_accepts_array_string_and_uint8array_object() {
        assert_eq!(json_bytes(&json!([1, 2, 255])), vec![1u8, 2, 255]);
        assert_eq!(json_bytes(&json!("AB")), vec![65u8, 66]);
        // Tauri IPC 里 Uint8Array 的形态：{"0":5,"1":6}
        assert_eq!(json_bytes(&json!({ "1": 6, "0": 5 })), vec![5u8, 6]);
        assert_eq!(json_bytes(&json!(null)), Vec::<u8>::new());
    }

    #[test]
    fn order_by_preference_moves_cnb_to_front_or_back() {
        let urls = vec![
            "https://ghfast.top/https://github.com/a/b.zip".to_string(),
            "https://cnb.cool/x/-/releases/download/t/a.zip".to_string(),
            "https://github.com/a/b.zip".to_string(),
        ];
        let front = order_by_preference(&urls, true);
        assert!(front[0].contains("cnb.cool/"));
        let back = order_by_preference(&urls, false);
        assert!(back.last().map(|u| u.contains("cnb.cool/")).unwrap_or(false));
        assert_eq!(back.len(), 3);
    }

    #[test]
    fn local_percent_clamps_and_handles_unknown_total() {
        assert_eq!(local_percent(0, 0, 99), 0);
        assert_eq!(local_percent(50, 100, 99), 50);
        assert_eq!(local_percent(1000, 100, 99), 99);
    }

    #[test]
    fn parse_result_json_takes_the_last_one() {
        let out = "log line\n###RESULT {\"ok\":false}\nmore\n###RESULT {\"ok\":true,\"n\":2}\n";
        let v = parse_result_json(out).expect("should parse");
        assert_eq!(v["ok"], json!(true));
        assert_eq!(v["n"], json!(2));
        assert!(parse_result_json("no marker").is_none());
    }

    #[test]
    fn find_subdir_walks_nested_dirs() {
        let root = tmp_dir("subdir");
        let nested = root.join("waifu2x-1").join("models-cunet");
        std::fs::create_dir_all(&nested).unwrap();
        let hit = find_subdir(&root, "models-cunet", 2).expect("nested dir");
        assert_eq!(hit, nested);
        assert!(find_subdir(&root, "missing", 2).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_png_zip_creates_expected_entries() {
        let root = tmp_dir("pngzip");
        let out = root.join("score.zip");
        let tiles = vec![
            json!([1u8, 2, 3, 4]),
            json!({ "data": [5u8, 6] }),
            json!(null),
        ];
        let n = write_png_zip(&tiles, &out).expect("zip written");
        assert_eq!(n, 2);
        let f = std::fs::File::open(&out).unwrap();
        let mut zip = zip::ZipArchive::new(f).unwrap();
        assert_eq!(zip.len(), 2);
        assert_eq!(zip.by_index(0).unwrap().name(), "score-001.png");
        assert_eq!(zip.by_index(1).unwrap().name(), "score-002.png");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn soundfont_registry_entries_have_download_urls() {
        let items = sf_registry_items();
        assert!(items.len() >= 10, "registry should list the curated soundfonts");
        let mut downloadable = 0;
        for it in items {
            if it.get("manual").and_then(|v| v.as_bool()).unwrap_or(false) {
                assert!(it.get("officialUrl").and_then(|v| v.as_str()).unwrap_or("").starts_with("https://"));
                continue;
            }
            let id = it.get("id").and_then(|v| v.as_str()).unwrap_or("?");
            let urls = sf_candidate_urls(&it);
            assert!(!urls.is_empty(), "{id} 没有下载地址（重新跑 gen-soundfont-registry.mjs）");
            for u in urls {
                assert!(u.starts_with("https://"), "{id} 非法地址 {u}");
                assert!(!u.contains("example.invalid"), "{id} 仍是占位地址 {u}");
            }
            downloadable += 1;
        }
        assert!(downloadable >= 10);
    }

    #[test]
    fn transcode_args_map_audio_and_offset() {
        let webm = Path::new("in.webm");
        let wav = Path::new("a.wav");
        let args = transcode_args(webm, Some(wav), "out.mp4", 1.5);
        assert!(args.windows(2).any(|w| w[0] == "-i" && w[1] == "in.webm"));
        assert!(args.windows(2).any(|w| w[0] == "-ss" && w[1] == "1.500000"));
        assert!(args.windows(2).any(|w| w[0] == "-map" && w[1] == "1:a:0"));
        assert_eq!(args.last().map(|s| s.as_str()), Some("out.mp4"));
        let no_audio = transcode_args(webm, None, "out.mp4", 0.0);
        assert!(!no_audio.iter().any(|x| x == "-map"));
    }

    /// 真实网络冒烟（默认忽略）：验证 curl 多源下载 + .part 续传 + 尺寸校验 + 原子改名整条链路。
    /// 手动跑：cargo test --offline -- --ignored dl_download_smoke_real_network --nocapture
    #[test]
    #[ignore = "需要外网：手动执行 cargo test -- --ignored"]
    fn dl_download_smoke_real_network() {
        let root = tmp_dir("smoke");
        let dest = root.join("florestan-subset.sf2");
        let urls = vec!["https://cdn.jsdelivr.net/gh/schellingb/TinySoundFont@master/examples/florestan-subset.sf2".to_string()];
        let job = Job::new("smoke");
        let spec = DlSpec {
            urls: &urls,
            dest: &dest,
            label: "smoke",
            min_size: 300_000,
            max_size: u64::MAX,
            expect_total: 0,
            verify_exact: false,
            pct_lo: 0,
            pct_hi: 99,
        };
        let n = dl_download(&job, None, &spec).expect("download should succeed");
        assert!(n >= 300_000, "downloaded bytes {n}");
        let head = std::fs::read(&dest).expect("read downloaded file");
        assert_eq!(&head[..4], b"RIFF", "SoundFont 应以 RIFF 开头");
        assert!(!part_of(&dest).exists(), ".part 应在成功后消失");
        println!("[smoke] downloaded {n} bytes to {}", dest.display());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn update_candidates_include_cnb_and_mirrors() {
        let list = update_candidates("https://github.com/qdTXTbp/FuFumidi/releases/download/v1/FuFumidi.Install.exe", "stable");
        assert!(list.iter().any(|u| u.contains("cnb.cool")));
        assert!(list.iter().any(|u| u.starts_with("https://ghfast.top/https://github.com/")));
        assert!(list.iter().any(|u| u.starts_with("https://github.com/")));
    }
}
