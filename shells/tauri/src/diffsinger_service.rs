//! DiffSinger 模块：组件安装 + 公开声库/ModelScope 声库管理。
//!
//! 部分移植自 main/diffsinger.js（Electron）。所有网络操作必须：
//! - 后台线程执行、可取消（模块内 Job 注册表 + 原子取消位）
//! - 通过事件回报进度：diffsinger:runtimeProgress / diffsinger:voicebankProgress /
//!   diffsinger:msProgress（另加 model:progress 给顶部全局下载条）
//! - 完成后校验（体积 / dsconfig.yaml / ONNX 存在）
//!
//! # 线程模型
//!
//! main.rs 的包装：install_runtime / uninstall_runtime / import_voicebank_zip /
//! download_voicebank 标了 tauri::command(async)（线程池），ms_download 是 async fn。
//! 因此这里一律「阻塞式最终返回」——与 Electron 语义一致：下载/安装完成后直接返回
//! {ok:true,...} 或 {ok:false,error,canceled}；进度照旧用同名事件推送；取消命令由
//! 另一个线程并发执行，靠 Job 的原子取消位 + 杀掉 curl/pip 子进程生效。
//!
//! 「状态查询」例外：diffsinger_status 的包装是同步命令（main.rs 已冻结），跑在主线程，
//! 所以依赖探测带 30 秒缓存，过期后先返回旧值、后台线程再刷新，把主线程阻塞限制在
//! 进程内首次探测（本机实测约 1.3 秒）。
//!
//! # 硬约束
//!
//! 所有子进程（curl / python / pip）都走 CREATE_NO_WINDOW(0x08000000) 隐藏窗口；
//! 压缩包解开前统一拒绝绝对路径 / 盘符 / 上级目录 / 重名条目（zip-slip 与解压炸弹防御）；
//! 任何路径删除都先校验在数据根之内；错误只返回 {ok:false,error}，不 panic。
//!
//! # 与 Electron 的已知偏差
//!
//! - enabled 读 settings.diffsinger_enabled（默认 true）。Electron 的 enabled() 恒为 true；
//!   这里让「停用模块」开关真的生效，但安装/下载不因开关被拦截（与 Electron
//!   「不再据此拦截」的结论一致）。
//! - runtime.json 的 updatedAt 写 Unix 秒（Electron 写 ISO 字符串）；只本模块读取。
//! - 导入对话框只列 .zip / .oudep 文件；已解压的声库文件夹靠前端拖拽传 direct_path。
//! - ModelScope 目录直接读内嵌的 renderer/dist/diffsinger-ms-catalog.json（与 main.rs 同源）。

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::DialogExt;

use crate::{apply_engine_env, data_dir, engine_dir, python_path, read_json, settings_path};

/* ------------------------------- 事件与常量 ------------------------------- */

const RUNTIME_EVENT: &str = "diffsinger:runtimeProgress";
const VB_EVENT: &str = "diffsinger:voicebankProgress";
const MS_EVENT: &str = "diffsinger:msProgress";
const MODEL_EVENT: &str = "model:progress";

/// 推理依赖（pip 包名）：与 Electron DS_PY_DEPS 对齐。
const DS_PY_DEPS: [&str; 2] = ["onnxruntime", "pyyaml"];

/// 依赖探测超时（Electron 侧 spawnEngine 是 60 秒；本机实测 1.3 秒，这里收紧到 30 秒）。
const DEPS_TIMEOUT: Duration = Duration::from_secs(30);
/// 依赖探测结果缓存：30 秒内直接复用（对齐 main/diffsinger.js 的 30s 短缓存）。
const DEPS_TTL: Duration = Duration::from_secs(30);

/// 安全解压标记：调用方据此把「取消」与「失败」分开。
const CANCELED: &str = "__canceled";

const ZIP_MAX_ENTRIES: usize = 200_000;
const ZIP_MAX_TOTAL: u64 = 8 * 1024 * 1024 * 1024;

/// 通用 NSF-HiFiGAN 声码器（openvpi 社区声码器；CC BY-NC-SA 4.0）。
///
/// 注意：同名 .zip 包里只有 PyTorch 权重（onnxruntime 用不了），带 ONNX 的是 .oudep
/// （OpenUTAU 依赖包，实为 zip：*.onnx + vocoder.yaml + oudep.yaml + NOTICE）。
/// 国内 CNB 镜像 / 全球 GitHub 自有仓库 / openvpi 官方兜底，按下载源偏好排序。
struct VocoderSpec {
    id: &'static str,
    name: &'static str,
    note: &'static str,
    tag: &'static str,
    file: &'static str,
    gh_url: &'static str,
    fallback_url: &'static str,
    official_url: &'static str,
}

static VOCODER: VocoderSpec = VocoderSpec {
    id: "nsf_hifigan_44.1k_2024.02",
    name: "NSF-HiFiGAN 通用声码器",
    note: "openvpi 社区声码器 · 44.1kHz / 128 mel bins · 约 50 MB（.oudep） · CC BY-NC-SA 4.0（非商用）",
    tag: "vocoder-2024.02",
    file: "nsf_hifigan_44.1k_hop512_128bin_2024.02.oudep",
    gh_url: "https://github.com/FuFuCloud-mirror/DiffSinger/releases/download/vocoder-2024.02/nsf_hifigan_44.1k_hop512_128bin_2024.02.oudep",
    fallback_url: "https://github.com/openvpi/vocoders/releases/download/nsf-hifigan-44.1k-hop512-128bin-2024.02/nsf_hifigan_44.1k_hop512_128bin_2024.02.oudep",
    official_url: "https://github.com/openvpi/vocoders/releases",
};

/// 声码器包实测大小（2026-11-06 真实下载：52,893,206 字节）。
/// 只用于进度百分比与「断点已完整」判断；严格校验只对实际交付字节的源做 HEAD。
const VOCODER_SIZE_HINT: u64 = 52_893_206;

/// CNB 上的 DiffSinger 组件镜像仓库（仅 openvpi 声码器；第三方声库不做镜像）。
const CNB_DS_REPO: &str = "FuFuCloud-mirror/DiffSinger";
const GH_MIRRORS: [&str; 3] = [
    "https://ghfast.top/",
    "https://gh-proxy.com/",
    "https://ghproxy.net/",
];

/// 公开声库注册表：只收「作者公开托管、可自由下载」的仓库（同 main/diffsinger.js）。
/// 合规说明：第三方声库（如 Ria 白名单条款未授权再分发权重）只走作者 GitHub 源，不镜像。
struct VbEntry {
    id: &'static str,
    dir_name: &'static str,
    name: &'static str,
    author: &'static str,
    lang: &'static str,
    desc: &'static str,
    license: &'static str,
    gh_url: &'static str,
    official_url: &'static str,
}

static VB_REGISTRY: [VbEntry; 1] = [VbEntry {
    id: "ria_multi_dict",
    dir_name: "Ria",
    name: "Ria（多字典版）",
    author: "RibosomeK",
    lang: "日本語 · 多字典（支持跨语种）",
    desc: "开源 DiffSinger 日文声库（多字典分支）：平假名 + 外来语片假名覆盖完整。v0.4-multi-dict。",
    license: "白名单条款 · 详见仓库 README（输出音频需注明声库名）",
    gh_url: "https://github.com/RibosomeK/RiaDiffSinger/releases/download/v0.4-multi-dict/Ria-v0.4-multi-dict.zip",
    official_url: "https://github.com/RibosomeK/RiaDiffSinger",
}];

/// ModelScope 声库目录（与 main.rs diffsinger_catalog 同一份内嵌数据）。
const MS_CATALOG_JSON: &str = include_str!("../../../renderer/dist/diffsinger-ms-catalog.json");
const MS_REPO_OWNER: &str = "aihobbyist";
const MS_REPO_NAME: &str = "ACG-DiffSinger-VoiceDB";

/* ------------------------------- 路径 ------------------------------- */

fn ds_root() -> PathBuf {
    data_dir().join("diffsinger")
}
fn vocoder_dir() -> PathBuf {
    ds_root().join("vocoder")
}
fn runtime_file() -> PathBuf {
    ds_root().join("runtime.json")
}
fn vb_root() -> PathBuf {
    data_dir().join("diffsinger-voicebanks")
}
fn dl_root() -> PathBuf {
    data_dir().join("temp").join("diffsinger-dl")
}

/* ------------------------------- 通用小工具 ------------------------------- */

/// 给外部命令加 Windows 隐藏窗口标志（Electron 对应 spawn({windowsHide:true})）。
fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
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

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 删除文件或目录（失败忽略：清理路径上不该因个别条目中断）。
fn remove_path(p: &Path) {
    let Ok(md) = std::fs::symlink_metadata(p) else {
        return;
    };
    if md.is_dir() {
        let _ = std::fs::remove_dir_all(p);
    } else {
        let _ = std::fs::remove_file(p);
    }
}

/// 递归目录字节数：不跟随符号链接（声库里的链接可能成环），深度上限兜底。
fn dir_size(p: &Path) -> u64 {
    fn depth(p: &Path, d: u32) -> u64 {
        if d > 64 {
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
                total = total.saturating_add(depth(&path, d + 1));
            } else {
                total = total.saturating_add(md.len());
            }
        }
        total
    }
    depth(p, 0)
}

/// 递归复制目录树（只复制目录内容，不含 src 自身；跳过符号链接）。
fn copy_tree(src: &Path, dest: &Path) -> Result<(), String> {
    fn walk(src: &Path, dest: &Path, depth: u32) -> Result<(), String> {
        if depth > 32 {
            return Err("目录层级过深".to_string());
        }
        std::fs::create_dir_all(dest).map_err(|e| format!("创建目录 {}：{e}", dest.display()))?;
        let rd = std::fs::read_dir(src).map_err(|e| format!("读取目录 {}：{e}", src.display()))?;
        for entry in rd.flatten() {
            let from = entry.path();
            let Some(name) = from.file_name() else {
                continue;
            };
            let to = dest.join(name);
            let Ok(md) = std::fs::symlink_metadata(&from) else {
                continue;
            };
            if md.file_type().is_symlink() {
                continue;
            }
            if md.is_dir() {
                walk(&from, &to, depth + 1)?;
            } else {
                std::fs::copy(&from, &to).map_err(|e| format!("复制 {}：{e}", from.display()))?;
            }
        }
        Ok(())
    }
    walk(src, dest, 0)
}

/// 文件名校验：压缩包条目名不得为空 / 绝对路径 / 盘符 / 含上级目录段。
fn zip_entry_unsafe(name: &str) -> bool {
    let n = name.replace('\\', "/");
    if n.is_empty() {
        return true;
    }
    if n.starts_with('/') || n.starts_with("//") {
        return true;
    }
    let b = n.as_bytes();
    if b.len() >= 2 && b[1] == b':' {
        return true;
    }
    n.split('/').any(|seg| seg == "..")
}

/// 目录路径归一化成分量列表（用于「是否在数据根内」判断；Windows 上大小写不敏感）。
fn path_key(p: &Path) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for c in p.components() {
        match c {
            Component::Prefix(pre) => out.push(pre.as_os_str().to_string_lossy().to_lowercase()),
            Component::RootDir => out.push(std::path::MAIN_SEPARATOR.to_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop()?;
            }
            Component::Normal(s) => out.push(s.to_string_lossy().to_lowercase()),
        }
    }
    Some(out)
}

/// p 是否严格位于 base 之内（base 自身不算）。上级目录会先归一化，越界即 false。
fn path_under(base: &Path, p: &Path) -> bool {
    match (path_key(base), path_key(p)) {
        (Some(b), Some(k)) => k.len() > b.len() && k.starts_with(&b),
        _ => false,
    }
}

/// 去掉 Windows 非法文件名字符并修剪首尾空白/句点。
fn sanitize_file_name(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        let bad = matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            || (ch as u32) < 0x20;
        out.push(if bad { '_' } else { ch });
    }
    out.trim().trim_end_matches('.').trim().to_string()
}

/// 在 root 下取一个不重名的子目录名：name、name_2、name_3…
fn unique_child_dir(root: &Path, name: &str) -> PathBuf {
    let mut dest = root.join(name);
    let mut i = 2u32;
    while dest.exists() {
        dest = root.join(format!("{name}_{i}"));
        i += 1;
    }
    dest
}

/* ------------------------------- 设置 / runtime.json ------------------------------- */

fn read_settings() -> Value {
    read_json(&settings_path())
}

/// DiffSinger 开关：缺省 true（与 main/settings.js 默认值一致）。
fn ds_enabled() -> bool {
    read_settings()
        .get("diffsinger_enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建目录 {}：{e}", parent.display()))?;
    }
    let tmp = path.with_extension("tmp");
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("写入 {}：{e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("落盘 {}：{e}", path.display()))
}

/// 等价 main.rs save_settings 的「按顶层键合并」语义：只改这一个键，保留其它设置。
fn set_enabled_at(path: &Path, on: bool) -> Result<(), String> {
    let existing = read_json(path);
    let mut merged = if existing.is_object() {
        existing
    } else {
        json!({})
    };
    if let Some(o) = merged.as_object_mut() {
        o.insert("diffsinger_enabled".to_string(), json!(on));
    }
    write_json_atomic(path, &merged)
}

fn patch_runtime_at(path: &Path, patch: Value) -> Result<(), String> {
    let existing = read_json(path);
    let mut merged = if existing.is_object() {
        existing
    } else {
        json!({})
    };
    if let (Some(dst), Some(src)) = (merged.as_object_mut(), patch.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    if let Some(o) = merged.as_object_mut() {
        o.insert("updatedAt".to_string(), json!(now_secs()));
    }
    write_json_atomic(path, &merged)
}

fn read_runtime() -> Value {
    read_json(&runtime_file())
}

/* ------------------------------- 依赖探测 ------------------------------- */

static DEPS_CACHE: OnceLock<Mutex<Option<(Instant, Value)>>> = OnceLock::new();
static DEPS_REFRESHING: AtomicBool = AtomicBool::new(false);

fn deps_cache() -> &'static Mutex<Option<(Instant, Value)>> {
    DEPS_CACHE.get_or_init(|| Mutex::new(None))
}

fn store_deps(data: Value) {
    let mut g = deps_cache().lock().unwrap_or_else(|e| e.into_inner());
    *g = Some((Instant::now(), data));
}

fn reset_deps_cache() {
    let mut g = deps_cache().lock().unwrap_or_else(|e| e.into_inner());
    *g = None;
}

fn deps_error(msg: &str) -> Value {
    json!({
        "ok": false,
        "installed": [],
        "missing": DS_PY_DEPS.to_vec(),
        "error": msg,
        "gpu": Value::Null,
    })
}

fn parse_result_json(stdout: &str) -> Option<Value> {
    stdout.lines().rev().find_map(|l| {
        l.trim()
            .strip_prefix("###RESULT ")
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
    })
}

fn normalize_deps(v: Value) -> Value {
    let installed = v
        .get("installed")
        .filter(|x| x.is_array())
        .cloned()
        .unwrap_or_else(|| json!([]));
    let missing = v
        .get("missing")
        .filter(|x| x.is_array())
        .cloned()
        .unwrap_or_else(|| json!([]));
    let ok = v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
    let error = v.get("error").and_then(|x| x.as_str()).unwrap_or("");
    let gpu = v.get("gpu").cloned().unwrap_or(Value::Null);
    let engine_version = v.get("engine_version").cloned().unwrap_or(Value::Null);
    json!({
        "ok": ok,
        "installed": installed,
        "missing": missing,
        "error": error,
        "gpu": gpu,
        "engineVersion": engine_version,
    })
}

struct CmdOutput {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

fn read_limited<R: Read>(src: Option<R>) -> String {
    let Some(s) = src else {
        return String::new();
    };
    let mut buf: Vec<u8> = Vec::new();
    let _ = s.take(512 * 1024).read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).to_string()
}

/// 跑一个短命令：stdout/stderr 各一个读取线程（避免管道写满卡死），主线程轮询 try_wait 直到超时。
fn run_capture(mut cmd: Command, timeout: Duration) -> Result<CmdOutput, String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("无法启动子进程：{e}"))?;
    let so = child.stdout.take();
    let se = child.stderr.take();
    let t_out = std::thread::spawn(move || read_limited(so));
    let t_err = std::thread::spawn(move || read_limited(se));
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status: Option<ExitStatus> = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
        if Instant::now() >= deadline {
            timed_out = true;
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let stdout = t_out.join().unwrap_or_default();
    let stderr = t_err.join().unwrap_or_default();
    Ok(CmdOutput {
        code: status.and_then(|s| s.code()),
        stdout,
        stderr,
        timed_out,
    })
}

/// 真实依赖探测：resource/python + engine/engine_diffsinger.py deps --check。
fn deps_probe() -> Value {
    let Some(py) = python_path() else {
        return deps_error("python runtime not found（检查 resources/python 或 FUFUMIDI_PYTHON）");
    };
    let Some(eng) = engine_dir() else {
        return deps_error("engine directory not found（engine/music2midi.py 不存在）");
    };
    let mut cmd = Command::new(&py);
    cmd.current_dir(&eng)
        .args(["engine_diffsinger.py", "deps", "--check"]);
    apply_engine_env(&mut cmd);
    let out = match run_capture(cmd, DEPS_TIMEOUT) {
        Ok(o) => o,
        Err(e) => return deps_error(&format!("无法运行依赖检查：{e}")),
    };
    if let Some(v) = parse_result_json(&out.stdout) {
        return normalize_deps(v);
    }
    let detail = tail_chars(format!("{}\n{}", out.stderr, out.stdout).trim(), 400);
    let msg = if out.timed_out {
        "依赖检查超时（30 秒）".to_string()
    } else if !detail.is_empty() {
        detail
    } else {
        match out.code {
            Some(c) => format!("引擎退出码 {c}"),
            None => "依赖检查没有返回结果".to_string(),
        }
    };
    deps_error(&msg)
}

/// 依赖探测（30 秒缓存）。force=true 强制重探（GPU 增强包安装/卸载后由前端传 force）。
///
/// 缓存过期时：先返回上一次结果，同时后台线程刷新 —— diffsinger_status 是同步命令，
/// 这样不会每 30 秒在主线程上等一次 Python 启动。
fn check_deps(force: bool) -> Value {
    let cached = {
        let g = deps_cache().lock().unwrap_or_else(|e| e.into_inner());
        g.as_ref().map(|(at, v)| (at.elapsed(), v.clone()))
    };
    if !force {
        if let Some((age, data)) = cached {
            if age < DEPS_TTL {
                return data;
            }
            if !DEPS_REFRESHING.swap(true, Ordering::SeqCst) {
                std::thread::spawn(|| {
                    let fresh = deps_probe();
                    store_deps(fresh);
                    DEPS_REFRESHING.store(false, Ordering::SeqCst);
                });
            }
            return data;
        }
    }
    let data = deps_probe();
    store_deps(data.clone());
    DEPS_REFRESHING.store(false, Ordering::SeqCst);
    data
}

/// 从 deps 结果里取 GPU 探测信息。
fn deps_gpu(deps: &Value) -> Value {
    deps.get("gpu").cloned().unwrap_or(Value::Null)
}

/* ------------------------------- 后台任务 / 取消 ------------------------------- */

/// 一个可取消的后台任务：保住进行中的子进程，取消 = 置标记（工作线程 250ms 内 kill）。
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

/// 取消所有前缀匹配的任务；返回去掉前缀后的 id 列表。
fn cancel_jobs_with_prefix(prefix: &str) -> Vec<String> {
    let g = job_map().lock().unwrap_or_else(|e| e.into_inner());
    let mut out = Vec::new();
    for (id, job) in g.iter() {
        if let Some(rest) = id.strip_prefix(prefix) {
            job.cancel();
            out.push(rest.to_string());
        }
    }
    out
}

/// Drop 守卫：工作线程即使 panic 也会释放槽位并杀掉遗留子进程。
struct JobGuard(Arc<Job>);

impl Drop for JobGuard {
    fn drop(&mut self) {
        self.0.kill_child();
        job_end(&self.0.id);
    }
}

/// 在后台线程执行 work 并等它结束，返回终态对象。
///
/// 调用方（main.rs 的 async 包装）阻塞的是线程池线程而不是主线程：进度事件照常到达
/// WebView，取消命令也能并发执行（它只需给 Job 置标记 / 杀子进程）。
fn run_blocking<F>(app: &AppHandle, job: Arc<Job>, work: F) -> Value
where
    F: FnOnce(AppHandle, Arc<Job>) -> Value + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<Value>();
    let worker_job = job.clone();
    let app2 = app.clone();
    let name = format!("fufumidi-ds-{}", job.id);
    let spawned = std::thread::Builder::new().name(name).spawn(move || {
        let _guard = JobGuard(worker_job.clone());
        let v = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work(app2, worker_job)))
            .unwrap_or_else(|_| json!({ "ok": false, "error": "后台任务异常结束（内部错误）" }));
        let _ = tx.send(v);
    });
    if spawned.is_err() {
        job_end(&job.id);
        return json!({ "ok": false, "error": "无法创建后台线程" });
    }
    match rx.recv() {
        Ok(v) => v,
        Err(_) => json!({ "ok": false, "error": "后台任务异常结束（工作线程没有返回结果）" }),
    }
}

/* ------------------------------- 进度事件 ------------------------------- */

/// 进度事件发送器：base 是每条事件都带的固定字段（id / phase / label…）。
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
    /// percent = -1 表示「只报日志文本」（前端 runtimeProgress 只在 percent >= 0 时更新进度条）。
    fn send(&self, received: u64, total: u64, percent: i64, done: bool, extra: Value) {
        let mut m = self.base.clone();
        if let Some(o) = extra.as_object() {
            for (k, v) in o {
                m.insert(k.clone(), v.clone());
            }
        }
        m.insert("received".to_string(), json!(received));
        m.insert("total".to_string(), json!(total));
        m.insert("percent".to_string(), json!(percent));
        m.insert("done".to_string(), json!(done));
        let _ = self.app.emit(self.event, Value::Object(m));
    }
}

fn emit_all(peers: &[Peer], received: u64, total: u64, percent: i64, done: bool, extra: Value) {
    for p in peers {
        p.send(received, total, percent, done, extra.clone());
    }
}

fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let host = rest.split('/').next().unwrap_or("");
    host.rsplit('@').next().unwrap_or("").to_string()
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

fn local_percent(received: u64, total: u64, cap: i64) -> i64 {
    if total == 0 {
        return 0;
    }
    ((received.saturating_mul(100) / total) as i64).min(cap)
}

/// 把 0..100 的局部进度映射到 [lo, hi] 的总进度区间。
fn map_pct(lo: i64, hi: i64, local: i64) -> i64 {
    if hi <= lo {
        return lo;
    }
    let span = hi - lo;
    (lo + local.clamp(0, 100) * span / 100).clamp(lo, hi)
}

/* ------------------------------- 下载核心 ------------------------------- */

#[derive(Debug)]
enum JobFail {
    Canceled,
    Failed(String),
}

fn part_of(dest: &Path) -> PathBuf {
    PathBuf::from(format!("{}.part", dest.display()))
}

/// HEAD 探测 Content-Length（重定向链取最后一条）。只用于进度与可选严格校验。
fn http_head_total(url: &str) -> Option<u64> {
    let mut cmd = Command::new("curl.exe");
    hidden(&mut cmd)
        .args([
            "--ssl-no-revoke",
            "-sS",
            "-L",
            "-I",
            "-m",
            "15",
            "-H",
            "User-Agent: FuFumidi",
            url,
        ])
        .stdin(Stdio::null());
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().rev().find_map(|l| {
        l.trim()
            .to_ascii_lowercase()
            .strip_prefix("content-length:")
            .and_then(|v| v.trim().parse::<u64>().ok())
    })
}

struct DlSpec<'a> {
    urls: &'a [String],
    dest: &'a Path,
    label: &'a str,
    min_size: u64,
    /// 声明总字节（目录/规格里的已知大小）：只用于进度百分比与「断点已完整」判断，
    /// **不参与最终校验**。严格校验只对「实际交付字节的那个源」做 HEAD（见 finish_download）。
    hint_total: u64,
    pct_lo: i64,
    pct_hi: i64,
    peers: &'a [Peer],
}

impl<'a> DlSpec<'a> {
    fn emit(&self, received: u64, total: u64, local: i64, done: bool, extra: Value) {
        let pct = map_pct(self.pct_lo, self.pct_hi, local);
        emit_all(self.peers, received, total, pct, done, extra);
    }
}

/// 多源下载到 dest：先写 dest.part（curl -C - 断点续传），校验后原子改名。
///
/// 取消时保留 .part（与 Electron fast-download 一致：再点一次从断点继续）；
/// 内容明显不对（大小不符）时丢弃 .part，避免拿坏包反复重试。
fn download_multi(job: &Arc<Job>, spec: &DlSpec) -> Result<u64, JobFail> {
    if spec.urls.is_empty() {
        return Err(JobFail::Failed("没有可用的下载地址".to_string()));
    }
    if let Some(parent) = spec.dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let part = part_of(spec.dest);
    // 只把声明总长用于进度与断点判断。为什么不预先对所有源做 HEAD：镜像/加速站在
    // 某些情况下会先返回一个很小的 Content-Length（错误页/跳转页，实测 CNB 首源
    // 返回过 39 字节），拿它做严格校验会把随后从别的源成功下到的 52MB 误判为「大小不符」。
    let total = spec.hint_total;
    spec.emit(file_len(&part), total, 0, false, json!({ "text": spec.label }));

    let have = file_len(&part);
    if spec.hint_total > spec.min_size && have == spec.hint_total {
        // 断点已经是完整文件（上次下完但没来得及改名）
        return finish_download(spec, &part, None);
    }

    let mut ok = false;
    let mut used_url: Option<&str> = None;
    let mut last_err = String::new();
    'outer: for round in 0..2 {
        for (i, url) in spec.urls.iter().enumerate() {
            if job.is_canceled() {
                job.kill_child();
                return Err(JobFail::Canceled);
            }
            let have_now = file_len(&part);
            spec.emit(
                have_now,
                total,
                local_percent(have_now, total, 99),
                false,
                json!({
                    "text": spec.label,
                    "host": host_of(url),
                    "round": round + 1,
                    "source": format!("{}/{}", i + 1, spec.urls.len()),
                }),
            );
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
            let status: ExitStatus;
            loop {
                if job.is_canceled() {
                    job.kill_child();
                    return Err(JobFail::Canceled);
                }
                let mut finished: Option<ExitStatus> = None;
                {
                    let mut g = job.child.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(c) = g.as_mut() {
                        match c.try_wait() {
                            Ok(Some(st)) => finished = Some(st),
                            Ok(None) => {}
                            Err(e) => last_err = e.to_string(),
                        }
                    }
                }
                if let Some(st) = finished {
                    status = st;
                    break;
                }
                std::thread::sleep(Duration::from_millis(250));
                let n = file_len(&part);
                if last_emit.elapsed() >= Duration::from_millis(400) {
                    let dt = last_t.elapsed().as_secs_f64().max(0.001);
                    let speed = ((n.saturating_sub(last_n)) as f64 / dt) as u64;
                    last_t = Instant::now();
                    last_n = n;
                    last_emit = Instant::now();
                    spec.emit(
                        n,
                        total,
                        local_percent(n, total, 99),
                        false,
                        json!({
                            "speed": speed,
                            "text": speed_text(spec.label, speed),
                            "host": host_of(url),
                        }),
                    );
                }
            }
            // try_wait 已回收子进程：从槽里拿掉，避免取消时误杀。
            drop(job.take_child());
            let n = file_len(&part);
            if status.success() {
                if n >= spec.min_size {
                    ok = true;
                    used_url = Some(url);
                    break 'outer;
                }
                // 镜像/代理返回的错误页（HTTP 200 + 极小 body）：丢掉换下一个源。
                remove_path(&part);
                last_err = format!("源返回的内容过小（{n} 字节）");
                continue;
            }
            last_err = format!("curl 退出码 {}", status.code().unwrap_or(-1));
            // 退出码非 0 但字节已够声明总长（服务器提前断连）：交给最终校验。
            if spec.hint_total > spec.min_size && n >= spec.hint_total {
                ok = true;
                used_url = Some(url);
                break 'outer;
            }
            if i + 1 < spec.urls.len() {
                let now = file_len(&part);
                spec.emit(
                    now,
                    total,
                    local_percent(now, total, 99),
                    false,
                    json!({
                        "notice": format!("源 {}/{} 未完成，换下一个源…", i + 1, spec.urls.len()),
                        "host": host_of(url),
                    }),
                );
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
    finish_download(spec, &part, used_url)
}

/// 校验 .part 并原子改名到 dest。
///
/// used_url 是**真正交付字节的那个源**：只对它做 Content-Length 校验。
/// 小于 min_size 的 Content-Length 视为错误页/跳转页，直接忽略（不可信）。
fn finish_download(spec: &DlSpec, part: &Path, used_url: Option<&str>) -> Result<u64, JobFail> {
    let n = file_len(part);
    if n == 0 {
        remove_path(part);
        return Err(JobFail::Failed(
            "下载内容为空（网络受限或文件被拦截）".to_string(),
        ));
    }
    if n < spec.min_size {
        remove_path(part);
        return Err(JobFail::Failed(format!(
            "下载文件不完整：{n} 字节 < 最小 {} 字节",
            spec.min_size
        )));
    }
    if let Some(url) = used_url {
        if let Some(t) = http_head_total(url) {
            if t > spec.min_size && t != n {
                remove_path(part);
                return Err(JobFail::Failed(format!(
                    "下载大小不符：{n}/{t} 字节（已丢弃不完整文件，请重试）"
                )));
            }
        }
    }
    if spec.dest.exists() {
        remove_path(spec.dest);
    }
    std::fs::rename(part, spec.dest)
        .map_err(|e| JobFail::Failed(format!("落盘失败 {}：{e}", spec.dest.display())))?;
    Ok(n)
}

/* ------------------------------- 下载源 ------------------------------- */

fn download_source_pref() -> String {
    read_settings()
        .get("download_source")
        .and_then(|v| v.as_str())
        .unwrap_or("auto")
        .to_ascii_lowercase()
}

fn prefer_cnb(source: &str) -> bool {
    matches!(source, "auto" | "cnb")
}

fn dedup_urls(urls: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for u in urls {
        if u.is_empty() || out.iter().any(|x| x == &u) {
            continue;
        }
        out.push(u);
    }
    out
}

/// GitHub 地址套镜像前缀（顺序即国内偏好顺序），末尾保留官方直连。
fn github_mirror_candidates(url: &str) -> Vec<String> {
    if url.is_empty() {
        return Vec::new();
    }
    if !url.to_ascii_lowercase().starts_with("https://github.com/") {
        return vec![url.to_string()];
    }
    let mut out: Vec<String> = GH_MIRRORS.iter().map(|p| format!("{p}{url}")).collect();
    out.push(url.to_string());
    out
}

fn vocoder_urls(source: &str) -> Vec<String> {
    let cnb = format!(
        "https://cnb.cool/{CNB_DS_REPO}/-/releases/download/{}/{}",
        VOCODER.tag, VOCODER.file
    );
    let mut gh = github_mirror_candidates(VOCODER.gh_url);
    gh.extend(github_mirror_candidates(VOCODER.fallback_url));
    let ordered = if prefer_cnb(source) {
        let mut v = vec![cnb];
        v.extend(gh);
        v
    } else {
        let mut v = gh;
        v.push(cnb);
        v
    };
    dedup_urls(ordered)
}

/// 当前下载源的人话标签（进度展示用）。
fn source_label_of(url: &str) -> &'static str {
    if url.contains("cnb.cool") {
        "国内源 · CNB"
    } else if url.contains("FuFuCloud-mirror/DiffSinger") {
        "全球源 · GitHub（自有仓库）"
    } else if url.contains("openvpi") {
        "全球源 · openvpi 官方"
    } else {
        "全球源 · GitHub 镜像"
    }
}

/// pip 源回退顺序：清华 / 阿里 / 官方（按 download_source 偏好决定谁先）。
fn pip_candidates(source: &str) -> Vec<Option<&'static str>> {
    let tsinghua = Some("https://pypi.tuna.tsinghua.edu.cn/simple");
    let aliyun = Some("https://mirrors.aliyun.com/pypi/simple/");
    let official: Option<&'static str> = None;
    if prefer_cnb(source) {
        vec![tsinghua, aliyun, official]
    } else {
        vec![official, tsinghua, aliyun]
    }
}

/* ------------------------------- 安全解压 ------------------------------- */

/// 安全解压：拒绝越界路径 / 重名条目 / 超量（zip-slip、解压炸弹防御），支持取消。
/// 任何一条不满足就整包拒绝，不做部分解压。
fn safe_extract_zip(archive: &Path, dest: &Path, job: Option<&Arc<Job>>) -> Result<usize, String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("打开压缩包失败：{e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("不是有效的 ZIP：{e}"))?;
    if zip.is_empty() {
        return Err("压缩包为空".to_string());
    }
    if zip.len() > ZIP_MAX_ENTRIES {
        return Err(format!("压缩包条目过多（{}）", zip.len()));
    }
    std::fs::create_dir_all(dest).map_err(|e| format!("创建解压目录失败：{e}"))?;
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut total: u64 = 0;
    let mut count = 0usize;
    for i in 0..zip.len() {
        if let Some(j) = job {
            if j.is_canceled() {
                return Err(CANCELED.to_string());
            }
        }
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let raw = entry.name().replace('\\', "/");
        if raw.starts_with("__MACOSX/") || raw.is_empty() {
            continue;
        }
        if zip_entry_unsafe(&raw) {
            return Err(format!("压缩包含不安全路径：{raw}"));
        }
        let rel = raw.trim_end_matches('/');
        if rel.is_empty() {
            continue;
        }
        // Windows 上大小写不敏感：A.txt / a.txt 视为重名（按名取与按序解会指到不同内容）。
        if !seen.insert(rel.to_lowercase()) {
            return Err(format!("压缩包含重名条目：{raw}"));
        }
        total = total.saturating_add(entry.size());
        if total > ZIP_MAX_TOTAL {
            return Err(format!("压缩包解压后体积超限（{total} 字节）"));
        }
        let out = dest.join(rel);
        if !path_under(dest, &out) {
            return Err(format!("压缩包条目解析后越界：{raw}"));
        }
        if entry.is_dir() || raw.ends_with('/') {
            std::fs::create_dir_all(&out).map_err(|e| format!("创建目录 {}：{e}", out.display()))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录 {}：{e}", parent.display()))?;
        }
        let mut f = std::fs::File::create(&out).map_err(|e| format!("写入 {}：{e}", out.display()))?;
        std::io::copy(&mut entry, &mut f).map_err(|e| format!("解压 {}：{e}", out.display()))?;
        count += 1;
    }
    Ok(count)
}

/* ------------------------------- 声库结构识别 ------------------------------- */

fn is_noise_dir(p: &Path) -> bool {
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    name == "__MACOSX" || name.starts_with('.')
}

/// 在目录树（深度 ≤ max_depth）里找含 dsconfig.yaml 的目录。先根后子。
fn find_dsconfig_dir(root: &Path, max_depth: u32) -> Option<PathBuf> {
    if !root.is_dir() {
        return None;
    }
    if root.join("dsconfig.yaml").is_file() {
        return Some(root.to_path_buf());
    }
    if max_depth == 0 {
        return None;
    }
    let rd = std::fs::read_dir(root).ok()?;
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() && !is_noise_dir(&p) {
            if let Some(hit) = find_dsconfig_dir(&p, max_depth - 1) {
                return Some(hit);
            }
        }
    }
    None
}

fn has_yaml_key(cfg: &str, key: &str) -> bool {
    cfg.lines().any(|line| {
        line.trim_start()
            .strip_prefix(key)
            .map(|rest| rest.trim_start().starts_with(':'))
            .unwrap_or(false)
    })
}

/// 给一个 dsconfig.yaml 所在目录打分：主声库根（有 acoustic / 顶层 onnx）分高，
/// dsdur / dspitch 这类子模型目录分低（避免误命中的子配置）。
fn voicebank_root_score(dir: &Path) -> i32 {
    let Ok(cfg) = std::fs::read_to_string(dir.join("dsconfig.yaml")) else {
        return 0;
    };
    let mut score = 0;
    if has_yaml_key(&cfg, "acoustic") {
        score += 10;
    }
    if has_yaml_key(&cfg, "vocoder") || has_yaml_key(&cfg, "sample_rate") || has_yaml_key(&cfg, "hop_size")
    {
        score += 2;
    }
    if let Ok(rd) = std::fs::read_dir(dir) {
        if rd.flatten().any(|e| {
            e.path().is_file()
                && e.file_name()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .ends_with(".onnx")
        }) {
            score += 5;
        }
    }
    let base = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if matches!(
        base.as_str(),
        "dsdur" | "dspitch" | "dsvariance" | "dsvocoder" | "dsacoustic"
    ) {
        score -= 20;
    }
    score
}

struct VbRootInfo {
    root: PathBuf,
    name: String,
    depth: u32,
    score: i32,
}

/// 在目录树里定位声库根：优先分数高（主声库根）、其次层级浅。
fn detect_voicebank_root(start: &Path) -> Option<VbRootInfo> {
    fn walk(dir: &Path, depth: u32, out: &mut Vec<VbRootInfo>) {
        if depth > 4 {
            return;
        }
        if dir.join("dsconfig.yaml").is_file() {
            let score = voicebank_root_score(dir);
            if score > 0 {
                out.push(VbRootInfo {
                    root: dir.to_path_buf(),
                    name: String::new(),
                    depth,
                    score,
                });
            }
            // 命中就不再往这个子树里找（子模型目录另有自己的 dsconfig）。
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() && !is_noise_dir(&p) {
                walk(&p, depth + 1, out);
            }
        }
    }
    let mut found: Vec<VbRootInfo> = Vec::new();
    walk(start, 0, &mut found);
    if found.is_empty() {
        return None;
    }
    found.sort_by(|a, b| b.score.cmp(&a.score).then(a.depth.cmp(&b.depth)));
    let mut best = found.remove(0);
    best.name = voicebank_display_name(&best.root);
    Some(best)
}

fn read_text_limited(path: &Path, max: u64) -> Option<String> {
    let f = std::fs::File::open(path).ok()?;
    let mut buf: Vec<u8> = Vec::new();
    let _ = f.take(max).read_to_end(&mut buf);
    Some(String::from_utf8_lossy(&buf).to_string())
}

fn ini_name(text: &str) -> Option<String> {
    for line in text.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("name") {
            let rest = rest.trim_start();
            if let Some(v) = rest.strip_prefix('=') {
                let v = v.trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

fn yaml_name(text: &str) -> Option<String> {
    for line in text.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("name") {
            let rest = rest.trim_start();
            if let Some(v) = rest.strip_prefix(':') {
                let v = v.trim().trim_matches(|c| c == '"' || c == '\'').trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

/// 声库显示名：character.txt 的 name= 优先，其次 dsconfig 的 name:，最后目录名。
fn voicebank_display_name(dir: &Path) -> String {
    if let Some(text) = read_text_limited(&dir.join("character.txt"), 1 << 20) {
        if let Some(n) = ini_name(&text) {
            return n;
        }
    }
    if let Some(text) = read_text_limited(&dir.join("dsconfig.yaml"), 1 << 20) {
        if let Some(n) = yaml_name(&text) {
            return n;
        }
    }
    dir.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// 收集目录树里的文件（限定扩展名），返回 (相对路径/正斜杠, 绝对路径)。
fn collect_files_by_ext(root: &Path, exts: &[&str], max_depth: u32) -> Vec<(String, PathBuf)> {
    fn walk(
        dir: &Path,
        prefix: &str,
        exts: &[&str],
        depth: u32,
        max_depth: u32,
        out: &mut Vec<(String, PathBuf)>,
    ) {
        if depth > 32 {
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for e in rd.flatten() {
            let p = e.path();
            let Some(name) = p.file_name().map(|n| n.to_string_lossy().to_string()) else {
                continue;
            };
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let Ok(md) = std::fs::symlink_metadata(&p) else {
                continue;
            };
            if md.file_type().is_symlink() {
                continue;
            }
            if md.is_dir() {
                if depth < max_depth {
                    walk(&p, &rel, exts, depth + 1, max_depth, out);
                }
                continue;
            }
            let ext = p
                .extension()
                .map(|x| x.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if exts.iter().any(|x| *x == ext) {
                out.push((rel, p));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, "", exts, 0, max_depth, &mut out);
    out
}

/// 把顶层 NOTICE / LICENSE / README 一并收进要复制的清单（CC BY-NC-SA 4.0 要求保留声明）。
/// 只按文件名匹配、只取顶层，不参与 ONNX 定位，因此不改变既有包结构的识别方式。
fn push_license_files(root: &Path, files: &mut Vec<(String, PathBuf)>) {
    let Ok(rd) = std::fs::read_dir(root) else {
        return;
    };
    for e in rd.flatten() {
        let path = e.path();
        if !path.is_file() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        let low = name.to_ascii_lowercase();
        let wanted = low.starts_with("notice")
            || low.starts_with("license")
            || low.starts_with("readme");
        if wanted && !files.iter().any(|(_, p)| p == &path) {
            files.push((name, path));
        }
    }
}

/// 声库模型摘要（导入后展示 / 排查用），对齐 main/diffsinger.js 的 collectModelSummary。
fn collect_model_summary(root: &Path) -> Value {
    let files = collect_files_by_ext(root, &["onnx"], 3);
    let pick = |needles: &[&str]| -> String {
        files
            .iter()
            .find(|(rel, _)| {
                let low = rel.to_ascii_lowercase();
                needles.iter().any(|n| low.contains(n))
            })
            .map(|(rel, _)| rel.clone())
            .unwrap_or_default()
    };
    let listed: Vec<Value> = files
        .iter()
        .take(40)
        .map(|(rel, p)| {
            json!({
                "name": p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                "rel": rel,
                "size": file_len(p),
            })
        })
        .collect();
    json!({
        "acoustic": pick(&["aco", "acoustic"]),
        "linguistic": pick(&["linguistic"]),
        "dur": pick(&["dur"]),
        "pitch": pick(&["pitch", "pit."]),
        "variance": pick(&["variance", "var."]),
        "vocoder": pick(&["hifigan", "vocoder"]),
        "hasVocoderDir": root.join("dsvocoder").is_dir(),
        "totalOnnx": files.len(),
        "files": listed,
    })
}

fn dir_has_onnx(dir: &Path) -> bool {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return false;
    };
    rd.flatten().any(|e| {
        e.path().is_file()
            && e.file_name()
                .to_string_lossy()
                .to_ascii_lowercase()
                .ends_with(".onnx")
    })
}

/* ------------------------------- 状态 / 开关 ------------------------------- */

pub fn status(opts: Value) -> Value {
    let force = opts.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
    let enabled = ds_enabled();
    let deps = if enabled {
        check_deps(force)
    } else {
        json!({
            "ok": false,
            "installed": [],
            "missing": DS_PY_DEPS.to_vec(),
            "error": "",
            "skipped": true,
            "gpu": Value::Null,
        })
    };
    let deps_ok = deps.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let vdir = vocoder_dir();
    let vocoder_installed = dir_has_onnx(&vdir);
    let root = vb_root();
    let voicebank_count = voicebank_dirs(&root).len() as u64;
    json!({
        "ok": true,
        "enabled": enabled,
        "deps": {
            "installed": deps.get("installed").cloned().unwrap_or_else(|| json!([])),
            "missing": deps.get("missing").cloned().unwrap_or_else(|| json!([])),
            "ok": deps_ok,
            "error": deps.get("error").cloned().unwrap_or_else(|| json!("")),
            "skipped": deps.get("skipped").and_then(|v| v.as_bool()).unwrap_or(false),
        },
        "gpu": deps_gpu(&deps),
        "vocoder": {
            "installed": vocoder_installed,
            "dir": vdir.display().to_string(),
            "spec": {
                "id": VOCODER.id,
                "name": VOCODER.name,
                "note": VOCODER.note,
                "file": VOCODER.file,
                "officialUrl": VOCODER.official_url,
            },
            "runtime": read_runtime(),
        },
        "voicebankDir": root.display().to_string(),
        "voicebankCount": voicebank_count,
        "ready": enabled && deps_ok && vocoder_installed,
    })
}

pub fn set_enabled(on: bool) -> Value {
    match set_enabled_at(&settings_path(), on) {
        Ok(()) => json!({ "ok": true, "enabled": on }),
        Err(e) => json!({ "ok": false, "error": format!("保存设置失败：{e}") }),
    }
}

/* ------------------------------- 组件安装 ------------------------------- */

/// 读取某次 pip 的一行行日志并泵到事件里。
fn pump_lines<R: Read + Send + 'static>(src: Option<R>, tx: mpsc::Sender<String>) {
    let Some(src) = src else {
        return;
    };
    let reader = BufReader::new(src);
    for line in reader.lines() {
        match line {
            Ok(l) => {
                if tx.send(l).is_err() {
                    return;
                }
            }
            Err(_) => return,
        }
    }
}

/// 收集 pip 输出里最近的几段（pip 用 \r 刷进度条，按 \r 再切一次）。
fn log_text(lines: &[String]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for line in lines {
        for seg in line.split('\r') {
            let t = seg.trim();
            if !t.is_empty() {
                parts.push(t.to_string());
            }
        }
    }
    let tail = parts.iter().rev().take(3).cloned().collect::<Vec<_>>();
    let mut out = tail.into_iter().rev().collect::<Vec<_>>().join(" | ");
    if out.chars().count() > 300 {
        out = out.chars().take(300).collect();
    }
    out
}

/// 跑一轮 pip install（流式日志 → 事件；可取消）。
fn pip_install(
    job: &Arc<Job>,
    peer: &Peer,
    pkgs: &[&str],
    index: Option<&str>,
) -> Result<(), JobFail> {
    let Some(py) = python_path() else {
        return Err(JobFail::Failed(
            "python runtime not found（检查 resources/python 或 FUFUMIDI_PYTHON）".to_string(),
        ));
    };
    let mut cmd = Command::new(&py);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .args(["-m", "pip", "install", "--no-input", "--disable-pip-version-check"]);
    if let Some(u) = index {
        cmd.args(["-i", u]);
    }
    cmd.args(pkgs);
    apply_engine_env(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| JobFail::Failed(format!("无法启动 pip：{e}")))?;
    let (tx, rx) = mpsc::channel::<String>();
    let so = child.stdout.take();
    let se = child.stderr.take();
    let tx2 = tx.clone();
    let t_out = std::thread::spawn(move || pump_lines(so, tx));
    let t_err = std::thread::spawn(move || pump_lines(se, tx2));
    job.set_child(child);

    let mut pending: Vec<String> = Vec::new();
    let mut last_emit = Instant::now();
    let result: Result<Option<ExitStatus>, JobFail> = loop {
        if job.is_canceled() {
            job.kill_child();
            break Err(JobFail::Canceled);
        }
        while let Ok(line) = rx.try_recv() {
            pending.push(line);
        }
        let mut finished: Option<ExitStatus> = None;
        {
            let mut g = job.child.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(c) = g.as_mut() {
                match c.try_wait() {
                    Ok(Some(st)) => finished = Some(st),
                    Ok(None) => {}
                    Err(_) => {}
                }
            }
        }
        if let Some(st) = finished {
            break Ok(Some(st));
        }
        if last_emit.elapsed() >= Duration::from_millis(400) && !pending.is_empty() {
            let text = log_text(&pending);
            pending.clear();
            last_emit = Instant::now();
            if !text.is_empty() {
                peer.send(0, 0, -1, false, json!({ "phase": "deps", "text": text }));
            }
        }
        std::thread::sleep(Duration::from_millis(120));
    };
    drop(job.take_child());
    // 线程结束后管道关闭；先把剩余输出排空，再收线程（避免漏掉最后几行报错）。
    let _ = t_out.join();
    let _ = t_err.join();
    let drain = rx.try_iter().collect::<Vec<_>>();
    if result.is_ok() && !drain.is_empty() {
        let text = log_text(&drain);
        if !text.is_empty() {
            peer.send(0, 0, -1, false, json!({ "phase": "deps", "text": text }));
        }
    }
    let status = result?;
    match status {
        Some(st) if st.success() => Ok(()),
        Some(st) => Err(JobFail::Failed(format!(
            "pip 退出码 {}",
            st.code().unwrap_or(-1)
        ))),
        None => Err(JobFail::Failed("pip 异常退出".to_string())),
    }
}

fn install_runtime_worker(app: &AppHandle, job: &Arc<Job>) -> Value {
    let peer = Peer::new(app, RUNTIME_EVENT, json!({ "phase": "deps" }));
    match install_runtime_steps(job, &peer) {
        Ok(()) => {
            peer.send(
                0,
                0,
                100,
                true,
                json!({ "phase": "vocoder", "text": "DiffSinger 组件安装完成", "step": "all" }),
            );
            json!({ "ok": true })
        }
        Err(JobFail::Canceled) => {
            peer.send(
                0,
                0,
                0,
                true,
                json!({ "phase": "canceled", "text": "已取消安装", "canceled": true }),
            );
            json!({ "ok": false, "canceled": true, "error": "" })
        }
        Err(JobFail::Failed(msg)) => {
            peer.send(
                0,
                0,
                0,
                true,
                json!({ "phase": "error", "text": msg, "error": msg }),
            );
            json!({ "ok": false, "error": msg })
        }
    }
}

fn install_runtime_steps(job: &Arc<Job>, peer: &Peer) -> Result<(), JobFail> {
    // ---- 步骤 1：Python 依赖 ----
    peer.send(
        0,
        0,
        0,
        false,
        json!({ "phase": "deps", "text": "正在检查 Python 推理依赖…" }),
    );
    let before = check_deps(true);
    let before_ok = before.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if !before_ok {
        let installed: Vec<String> = before
            .get("installed")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let mut pkgs: Vec<&str> = DS_PY_DEPS
            .iter()
            .copied()
            .filter(|p| !installed.iter().any(|i| i == p))
            .collect();
        if pkgs.is_empty() {
            pkgs = DS_PY_DEPS.to_vec();
        }
        let source = download_source_pref();
        let candidates = pip_candidates(&source);
        let mut last_err = String::new();
        let mut pip_ok = false;
        for (idx, index) in candidates.iter().enumerate() {
            if job.is_canceled() {
                return Err(JobFail::Canceled);
            }
            peer.send(
                0,
                0,
                40,
                false,
                json!({ "phase": "deps", "text": format!("正在安装推理依赖（{}）…", pkgs.join(" / ")) }),
            );
            match pip_install(job, peer, &pkgs, *index) {
                Ok(()) => {
                    pip_ok = true;
                    break;
                }
                Err(JobFail::Canceled) => return Err(JobFail::Canceled),
                Err(JobFail::Failed(msg)) => {
                    last_err = msg;
                    if idx + 1 < candidates.len() {
                        peer.send(
                            0,
                            0,
                            60,
                            false,
                            json!({ "phase": "deps", "text": "首选源失败，正在切换 pip 源重试…" }),
                        );
                    }
                }
            }
        }
        if !pip_ok {
            return Err(JobFail::Failed(format!(
                "推理依赖安装失败（{last_err}）。请检查网络，或手动执行：pip install {}",
                DS_PY_DEPS.join(" ")
            )));
        }
        let after = check_deps(true);
        if !after.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            let err = after
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("未知错误");
            return Err(JobFail::Failed(format!("依赖安装后校验未通过：{err}")));
        }
    }
    peer.send(
        0,
        0,
        100,
        true,
        json!({ "phase": "deps", "text": "推理依赖就绪", "step": "deps" }),
    );

    // ---- 步骤 2：通用 NSF-HiFiGAN 声码器 ----
    let vdir = vocoder_dir();
    if dir_has_onnx(&vdir) {
        peer.send(
            0,
            0,
            100,
            true,
            json!({ "phase": "vocoder", "text": "声码器已就绪", "step": "vocoder", "existed": true }),
        );
        return Ok(());
    }
    let source = download_source_pref();
    let urls = vocoder_urls(&source);
    let first = urls.first().map(|u| source_label_of(u)).unwrap_or("自动源");
    let label = format!("下载通用声码器（{first}）");
    let dl_dir = dl_root();
    let _ = std::fs::create_dir_all(&dl_dir);
    let zip_path = dl_dir.join("vocoder.oudep");
    let peers = [peer.clone()];
    let spec = DlSpec {
        urls: &urls,
        dest: &zip_path,
        label: &label,
        min_size: 1_000_000,
        hint_total: VOCODER_SIZE_HINT,
        pct_lo: 0,
        pct_hi: 96,
        peers: &peers,
    };
    peer.send(
        0,
        0,
        0,
        false,
        json!({ "phase": "vocoder", "text": "正在下载通用声码器（NSF-HiFiGAN，约 50 MB）…" }),
    );
    match download_multi(job, &spec) {
        Ok(_) => {}
        Err(JobFail::Canceled) => return Err(JobFail::Canceled),
        Err(JobFail::Failed(msg)) => {
            return Err(JobFail::Failed(format!("声码器下载失败：{msg}")));
        }
    }
    peer.send(
        0,
        0,
        97,
        false,
        json!({ "phase": "vocoder", "text": "正在解压声码器…" }),
    );
    let stage = dl_dir.join("vocoder-extract");
    remove_path(&stage);
    match safe_extract_zip(&zip_path, &stage, Some(job)) {
        Ok(_) => {}
        Err(e) if e == CANCELED => {
            remove_path(&stage);
            return Err(JobFail::Canceled);
        }
        Err(e) => {
            remove_path(&stage);
            return Err(JobFail::Failed(format!("解压声码器失败：{e}")));
        }
    }
    let mut files = collect_files_by_ext(&stage, &["onnx", "json", "yaml", "yml"], 8);
    push_license_files(&stage, &mut files);
    let Some(onnx_path) = files
        .iter()
        .find(|(rel, _)| rel.to_ascii_lowercase().ends_with(".onnx"))
        .map(|(_, p)| p.clone())
    else {
        remove_path(&stage);
        return Err(JobFail::Failed(
            "声码器包里没有找到 ONNX 模型（包结构可能已变更）".to_string(),
        ));
    };
    let onnx_name = onnx_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| VOCODER.file.to_string());
    remove_path(&vdir);
    std::fs::create_dir_all(&vdir)
        .map_err(|e| JobFail::Failed(format!("创建声码器目录失败：{e}")))?;
    for (_, p) in &files {
        let Some(name) = p.file_name() else {
            continue;
        };
        let _ = std::fs::copy(p, vdir.join(name));
    }
    patch_runtime_at(
        &runtime_file(),
        json!({ "vocoder": { "file": onnx_name, "spec": VOCODER.id } }),
    )
    .map_err(|e| JobFail::Failed(format!("写入 runtime.json 失败：{e}")))?;
    remove_path(&stage);
    remove_path(&zip_path);
    peer.send(
        0,
        0,
        100,
        true,
        json!({ "phase": "vocoder", "step": "vocoder", "text": "声码器安装完成" }),
    );
    Ok(())
}

pub fn install_runtime(app: &AppHandle) -> Value {
    let Some(job) = job_begin("runtime") else {
        return json!({ "ok": false, "error": "组件安装已在进行中" });
    };
    run_blocking(app, job, move |app3, job3| {
        install_runtime_worker(&app3, &job3)
    })
}

pub fn cancel_runtime_install() -> Value {
    let hit = job_cancel("runtime");
    json!({ "ok": true, "canceled": hit })
}

pub fn uninstall_runtime(opts: Value) -> Value {
    let also_voicebanks = opts
        .get("alsoVoicebanks")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let base = data_dir();
    let root = ds_root();
    // 若安装/下载还在跑，先取消并等任务退场，避免「边写边删」留下半套文件。
    let was_running = job_cancel("runtime");
    for _ in 0..30 {
        let active = job_map()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key("runtime");
        if !active {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let mut removed: Vec<String> = Vec::new();
    if !path_under(&base, &root) {
        return json!({ "ok": false, "error": "DiffSinger 目录不在数据根内，拒绝删除" });
    }
    if root.exists() {
        remove_path(&root);
        removed.push(root.display().to_string());
    }
    if also_voicebanks {
        let vb = vb_root();
        if path_under(&base, &vb) && vb.exists() {
            remove_path(&vb);
            removed.push(vb.display().to_string());
        }
    }
    reset_deps_cache();
    json!({ "ok": true, "removed": removed, "canceledInstall": was_running })
}

/* ------------------------------- 声库管理 ------------------------------- */

/// 有效声库目录：(顶层目录名, 顶层目录, 含 dsconfig 的目录)。
fn voicebank_dirs(root: &Path) -> Vec<(String, PathBuf, PathBuf)> {
    let mut out: Vec<(String, PathBuf, PathBuf)> = Vec::new();
    let Ok(rd) = std::fs::read_dir(root) else {
        return out;
    };
    let mut entries: Vec<(String, PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.is_dir() {
                Some((e.file_name().to_string_lossy().to_string(), p))
            } else {
                None
            }
        })
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, dir) in entries {
        if let Some(cfg) = find_dsconfig_dir(&dir, 2) {
            out.push((name, dir, cfg));
        }
    }
    out
}

fn list_voicebanks_at(root: &Path) -> Value {
    let list: Vec<Value> = voicebank_dirs(root)
        .into_iter()
        .map(|(name, dir, cfg)| {
            json!({
                "name": name,
                "dir": cfg.display().to_string(),
                "size": dir_size(&dir),
            })
        })
        .collect();
    json!({ "ok": true, "list": list })
}

pub fn list_voicebanks() -> Value {
    list_voicebanks_at(&vb_root())
}

struct ImportDirs<'a> {
    vb_root: &'a Path,
    vocoder_dir: &'a Path,
    runtime_file: &'a Path,
}

pub fn import_voicebank_zip(app: &AppHandle, direct_path: Option<String>) -> Value {
    let picked: Option<PathBuf> = match direct_path {
        Some(p) if !p.trim().is_empty() => Some(PathBuf::from(p)),
        _ => app
            .dialog()
            .file()
            .set_title("导入 DiffSinger 声库")
            .add_filter("DiffSinger 声库", &["zip", "oudep"])
            .blocking_pick_file()
            .and_then(|p| p.into_path().ok()),
    };
    let Some(picked) = picked else {
        return json!({ "ok": false, "canceled": true });
    };
    let vr = vb_root();
    let vd = vocoder_dir();
    let rf = runtime_file();
    let dirs = ImportDirs {
        vb_root: &vr,
        vocoder_dir: &vd,
        runtime_file: &rf,
    };
    import_voicebank_path(&dirs, &dl_root(), &picked)
}

fn import_voicebank_path(dirs: &ImportDirs, stage_root: &Path, picked: &Path) -> Value {
    match import_voicebank_inner(dirs, stage_root, picked) {
        Ok(v) => v,
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

fn import_voicebank_inner(
    dirs: &ImportDirs,
    stage_root: &Path,
    picked: &Path,
) -> Result<Value, String> {
    if !picked.exists() {
        return Err(format!("文件不存在：{}", picked.display()));
    }
    let is_dir = picked.is_dir();
    let ext = picked
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let is_oudep = ext == "oudep";
    if !is_dir && !(ext == "zip" || is_oudep) {
        return Err(
            "不支持的文件类型：请选择 .zip / .oudep 声库包，或直接选择已解压的声库文件夹".to_string(),
        );
    }
    let mut stage = picked.to_path_buf();
    let mut cleanup = false;
    if !is_dir {
        let s = stage_root.join(format!("import-{}", now_millis()));
        remove_path(&s);
        if let Err(e) = safe_extract_zip(picked, &s, None) {
            remove_path(&s);
            return Err(e);
        }
        stage = s;
        cleanup = true;
    }
    let result = import_stage(dirs, &stage, picked, is_dir, is_oudep);
    if cleanup {
        remove_path(&stage);
    }
    result
}

fn import_stage(
    dirs: &ImportDirs,
    stage: &Path,
    picked: &Path,
    is_dir: bool,
    is_oudep: bool,
) -> Result<Value, String> {
    if is_oudep {
        // 依赖包（.oudep）：装到通用声码器位
        let mut files = collect_files_by_ext(stage, &["onnx", "json", "yaml", "yml"], 8);
        push_license_files(stage, &mut files);
        let Some(onnx_path) = files
            .iter()
            .find(|(rel, _)| rel.to_ascii_lowercase().ends_with(".onnx"))
            .map(|(_, p)| p.clone())
        else {
            return Err("该依赖包里没有 ONNX 模型".to_string());
        };
        let onnx_name = onnx_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        remove_path(dirs.vocoder_dir);
        std::fs::create_dir_all(dirs.vocoder_dir)
            .map_err(|e| format!("创建声码器目录失败：{e}"))?;
        for (_, p) in &files {
            let Some(name) = p.file_name() else {
                continue;
            };
            std::fs::copy(p, dirs.vocoder_dir.join(name))
                .map_err(|e| format!("复制 {}：{e}", p.display()))?;
        }
        patch_runtime_at(
            dirs.runtime_file,
            json!({ "vocoder": { "file": onnx_name, "imported": true } }),
        )?;
        return Ok(json!({
            "ok": true,
            "kind": "vocoder",
            "name": picked.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            "dir": dirs.vocoder_dir.display().to_string(),
        }));
    }

    // 声库包：定位含 dsconfig.yaml 的声库根
    // 先按「主声库根打分」挑（避免命中 dsdur 等子模型目录），
    // 打分全为 0（例如极简 dsconfig）时回退到「深度 ≤4 里第一个含 dsconfig 的目录」。
    let (cfg_dir, detected_name) = match detect_voicebank_root(stage) {
        Some(info) => (info.root, info.name),
        None => match find_dsconfig_dir(stage, 4) {
            Some(dir) => {
                let name = voicebank_display_name(&dir);
                (dir, name)
            }
            None => {
                return Err("没有找到 dsconfig.yaml。请确认这是 DiffSinger / OpenUTAU 声库（压缩包内应含 dsconfig.yaml 与 *.onnx），或直接选择已解压的声库文件夹".to_string())
            }
        },
    };
    // 名字优先级：压缩包/文件夹名 → character.txt 的 name= → dsconfig 的 name
    let mut name = if is_dir {
        picked
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default()
    } else {
        picked
            .file_stem()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default()
    };
    name = sanitize_file_name(&name);
    if name.is_empty() {
        name = if detected_name.trim().is_empty() {
            format!("voicebank_{}", now_millis())
        } else {
            sanitize_file_name(&detected_name)
        };
    }
    std::fs::create_dir_all(dirs.vb_root).map_err(|e| format!("创建声库根目录失败：{e}"))?;
    let dest = unique_child_dir(dirs.vb_root, &name);
    copy_tree(&cfg_dir, &dest)?;
    if find_dsconfig_dir(&dest, 1).is_none() {
        remove_path(&dest);
        return Err("安装后未找到 dsconfig.yaml（可能解压失败或权限不足）".to_string());
    }
    let models = collect_model_summary(&dest);
    Ok(json!({
        "ok": true,
        "kind": "voicebank",
        "name": dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        "dir": dest.display().to_string(),
        "size": dir_size(&dest),
        "models": models,
        "detectedName": detected_name,
        "fromDir": is_dir,
    }))
}

fn delete_voicebank_at(vb: &Path, dir: &str) -> Value {
    if dir.trim().is_empty() {
        return json!({ "ok": false, "error": "参数错误" });
    }
    let p = PathBuf::from(dir.trim());
    if !path_under(vb, &p) {
        return json!({ "ok": false, "error": "只能删除已导入的声库目录" });
    }
    if !p.exists() {
        return json!({ "ok": false, "error": "声库不存在" });
    }
    remove_path(&p);
    // 清理可能残留的空父目录（声库根在子目录时）；不删声库根本身。
    let mut cur = p.parent().map(|x| x.to_path_buf());
    while let Some(c) = cur {
        if c == *vb || !path_under(vb, &c) {
            break;
        }
        let empty = std::fs::read_dir(&c)
            .map(|mut r| r.next().is_none())
            .unwrap_or(false);
        if !empty {
            break;
        }
        let _ = std::fs::remove_dir(&c);
        cur = c.parent().map(|x| x.to_path_buf());
    }
    json!({ "ok": true, "dir": p.display().to_string() })
}

pub fn delete_voicebank(dir: String) -> Value {
    delete_voicebank_at(&vb_root(), &dir)
}

/* ------------------------------- 公开声库（GitHub） ------------------------------- */

fn voicebank_registry_at(root: &Path) -> Value {
    let list: Vec<Value> = VB_REGISTRY
        .iter()
        .map(|e| {
            let dir = root.join(e.dir_name);
            let installed = find_dsconfig_dir(&dir, 2).is_some();
            json!({
                "id": e.id,
                "name": e.name,
                "author": e.author,
                "lang": e.lang,
                "desc": e.desc,
                "license": e.license,
                "officialUrl": e.official_url,
                "installed": installed,
                "dir": dir.display().to_string(),
                "size": if installed { dir_size(&dir) } else { 0 },
            })
        })
        .collect();
    json!({ "ok": true, "dir": root.display().to_string(), "list": list })
}

pub fn voicebank_registry() -> Value {
    voicebank_registry_at(&vb_root())
}

fn vb_entry(id: &str) -> Option<&'static VbEntry> {
    VB_REGISTRY.iter().find(|e| e.id == id)
}

fn vb_download_worker(app: &AppHandle, job: &Arc<Job>, e: &'static VbEntry) -> Value {
    let id = e.id;
    let name = e.name;
    let dir_name = e.dir_name;
    let peer = Peer::new(app, VB_EVENT, json!({ "id": id, "phase": "download" }));
    let urls = dedup_urls(github_mirror_candidates(e.gh_url));
    let dl_dir = dl_root();
    let _ = std::fs::create_dir_all(&dl_dir);
    let zip_path = dl_dir.join(format!("vb-{id}.zip"));
    let stage = dl_dir.join(format!("vb-{id}-extract"));
    let peers = [peer.clone()];
    let spec = DlSpec {
        urls: &urls,
        dest: &zip_path,
        label: "下载声库",
        min_size: 500_000,
        hint_total: 0,
        pct_lo: 0,
        pct_hi: 88,
        peers: &peers,
    };
    match download_multi(job, &spec) {
        Ok(_) => {}
        Err(JobFail::Canceled) => {
            peer.send(
                0,
                0,
                0,
                true,
                json!({ "phase": "canceled", "canceled": true, "error": "", "text": "已取消" }),
            );
            return json!({ "ok": false, "canceled": true, "error": "" });
        }
        Err(JobFail::Failed(msg)) => {
            peer.send(
                0,
                0,
                0,
                true,
                json!({ "phase": "error", "error": msg, "text": msg }),
            );
            return json!({ "ok": false, "error": format!("下载声库失败：{msg}") });
        }
    }
    peer.send(
        0,
        0,
        90,
        false,
        json!({ "phase": "extract", "text": "正在解压声库…" }),
    );
    remove_path(&stage);
    match safe_extract_zip(&zip_path, &stage, Some(job)) {
        Ok(_) => {}
        Err(e) if e == CANCELED => {
            remove_path(&stage);
            peer.send(
                0,
                0,
                0,
                true,
                json!({ "phase": "canceled", "canceled": true, "error": "", "text": "已取消" }),
            );
            return json!({ "ok": false, "canceled": true, "error": "" });
        }
        Err(e) => {
            remove_path(&stage);
            remove_path(&zip_path);
            peer.send(
                0,
                0,
                0,
                true,
                json!({ "phase": "error", "error": e, "text": e }),
            );
            return json!({ "ok": false, "error": e });
        }
    }
    let Some(cfg_dir) = detect_voicebank_root(&stage)
        .map(|r| r.root)
        .or_else(|| find_dsconfig_dir(&stage, 4))
    else {
        remove_path(&stage);
        remove_path(&zip_path);
        let msg = "声库包里没有 dsconfig.yaml（包结构可能已变更）".to_string();
        peer.send(
            0,
            0,
            0,
            true,
            json!({ "phase": "error", "error": msg, "text": msg }),
        );
        return json!({ "ok": false, "error": msg });
    };
    let final_dir = vb_root().join(dir_name);
    remove_path(&final_dir);
    if let Some(parent) = final_dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = copy_tree(&cfg_dir, &final_dir) {
        remove_path(&stage);
        peer.send(
            0,
            0,
            0,
            true,
            json!({ "phase": "error", "error": e, "text": e }),
        );
        return json!({ "ok": false, "error": e });
    }
    remove_path(&stage);
    remove_path(&zip_path);
    if find_dsconfig_dir(&final_dir, 1).is_none() {
        let msg = "安装后未找到 dsconfig.yaml".to_string();
        peer.send(
            0,
            0,
            0,
            true,
            json!({ "phase": "error", "error": msg, "text": msg }),
        );
        return json!({ "ok": false, "error": msg });
    }
    let size = dir_size(&final_dir);
    peer.send(
        size,
        size,
        100,
        true,
        json!({ "phase": "done", "text": "安装完成", "ok": true }),
    );
    json!({
        "ok": true,
        "name": name,
        "dir": final_dir.display().to_string(),
        "size": size,
    })
}

pub fn download_voicebank(app: &AppHandle, id: String) -> Value {
    let Some(entry) = vb_entry(&id) else {
        return json!({ "ok": false, "error": format!("未知声库: {id}") });
    };
    let final_dir = vb_root().join(entry.dir_name);
    if find_dsconfig_dir(&final_dir, 2).is_some() {
        let peer = Peer::new(app, VB_EVENT, json!({ "id": entry.id, "phase": "done" }));
        peer.send(0, 0, 100, true, json!({ "ok": true, "existed": true }));
        return json!({
            "ok": true,
            "existed": true,
            "name": entry.name,
            "dir": final_dir.display().to_string(),
        });
    }
    let job_id = format!("vb:{id}");
    let Some(job) = job_begin(&job_id) else {
        return json!({ "ok": false, "error": "该声库正在下载中", "id": id });
    };
    run_blocking(app, job, move |app3, job3| {
        vb_download_worker(&app3, &job3, entry)
    })
}

pub fn cancel_voicebank_download(id: Option<String>) -> Value {
    match id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        Some(id) => {
            let hit = job_cancel(&format!("vb:{id}"));
            json!({ "ok": true, "canceled": hit, "id": id })
        }
        None => {
            let ids = cancel_jobs_with_prefix("vb:");
            json!({ "ok": true, "canceled": !ids.is_empty(), "ids": ids })
        }
    }
}

/* ------------------------------- ModelScope 声库 ------------------------------- */

fn ms_catalog() -> Value {
    serde_json::from_str::<Value>(MS_CATALOG_JSON)
        .unwrap_or_else(|_| json!({ "ok": false, "works": [] }))
}

#[derive(Clone, Debug)]
struct MsRec {
    name: String,
    work: String,
    path: String,
    size: u64,
    placeholder: bool,
    url: String,
}

fn ms_lookup_in(catalog: &Value, path: &str) -> Option<MsRec> {
    let works = catalog.get("works")?.as_array()?;
    for w in works {
        let cats = w.get("categories")?.as_array()?;
        for c in cats {
            let models = c.get("models")?.as_array()?;
            for m in models {
                if m.get("path").and_then(|v| v.as_str()) != Some(path) {
                    continue;
                }
                return Some(MsRec {
                    name: m.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    work: m.get("work").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    path: path.to_string(),
                    size: m.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
                    placeholder: m
                        .get("placeholder")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                    url: m.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                });
            }
        }
    }
    None
}

/// 百分号编码声库路径（保留 /），用于 catalog 缺 url 时现算 ModelScope 官方直链。
fn pct_encode_path(path: &str) -> String {
    let mut out = String::new();
    for b in path.as_bytes() {
        let keep = b.is_ascii_alphanumeric() || matches!(*b, b'-' | b'_' | b'.' | b'~' | b'/');
        if keep {
            out.push(*b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn ms_file_url(path: &str) -> String {
    format!(
        "https://www.modelscope.cn/api/v1/models/{MS_REPO_OWNER}/{MS_REPO_NAME}/repo?Revision=master&FilePath={}",
        pct_encode_path(path)
    )
}

#[derive(Debug)]
struct MsPlan {
    id: String,
    label: String,
    rec: MsRec,
}

fn ms_resolve(catalog: &Value, req: &Value) -> Result<MsPlan, String> {
    let path = req.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if path.trim().is_empty() {
        return Err("缺少声库路径（path）".to_string());
    }
    let rec = ms_lookup_in(catalog, path).ok_or_else(|| "目录中不存在该声库条目".to_string())?;
    if rec.placeholder {
        return Err("该声库在上游仓库中尚未上传权重（仅占位文件），暂不可下载".to_string());
    }
    let raw_name = req.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let mut id = sanitize_file_name(raw_name);
    if id.is_empty() {
        id = sanitize_file_name(&rec.name);
    }
    if id.is_empty() {
        id = format!("ms_{}", now_millis());
    }
    let label = if rec.work.trim().is_empty() {
        rec.name.clone()
    } else {
        format!("{}（{}）", rec.name, rec.work)
    };
    Ok(MsPlan { id, label, rec })
}

fn ms_emit_phase(peers: &[Peer], phase: &str, percent: i64, text: &str) {
    for p in peers {
        p.send(
            1,
            1,
            percent,
            false,
            json!({ "phase": phase, "text": text, "speed": 0 }),
        );
    }
}

fn ms_finish(peers: &[Peer], ok: bool, msg: &str) -> Value {
    if ok {
        for p in peers {
            p.send(1, 1, 100, true, json!({ "phase": "done", "text": msg }));
        }
        json!({ "ok": true })
    } else {
        for p in peers {
            p.send(
                0,
                0,
                0,
                false,
                json!({ "phase": "error", "error": msg, "text": msg }),
            );
        }
        json!({ "ok": false, "error": msg })
    }
}

fn ms_download_worker(app: &AppHandle, job: &Arc<Job>, plan: MsPlan) -> Value {
    let MsPlan { id, label, rec } = plan;
    let evt_id = format!("dsms:{id}");
    let peer_ms = Peer::new(app, MS_EVENT, json!({ "id": id, "phase": "download" }));
    let peer_model = Peer::new(
        app,
        MODEL_EVENT,
        json!({ "id": evt_id, "label": label, "phase": "download" }),
    );
    let peers = [peer_ms, peer_model];

    let url = if rec.url.trim().is_empty() {
        ms_file_url(&rec.path)
    } else {
        rec.url.clone()
    };
    let dl_dir = dl_root();
    let _ = std::fs::create_dir_all(&dl_dir);
    let zip_path = dl_dir.join(format!("ms-{id}.zip"));
    let stage = dl_dir.join(format!("ms-{id}-extract"));

    emit_all(
        &peers,
        0,
        rec.size,
        0,
        false,
        json!({ "phase": "download", "text": "正在连接 ModelScope 官方源…", "speed": 0 }),
    );
    let urls = [url];
    let spec = DlSpec {
        urls: &urls,
        dest: &zip_path,
        label: "下载声库",
        min_size: 100_000,
        hint_total: rec.size,
        pct_lo: 0,
        pct_hi: 88,
        peers: &peers,
    };
    match download_multi(job, &spec) {
        Ok(_) => {}
        Err(JobFail::Canceled) => {
            emit_all(
                &peers,
                0,
                0,
                0,
                false,
                json!({ "phase": "canceled", "canceled": true, "error": "", "text": "已取消", "speed": 0 }),
            );
            return json!({ "ok": false, "canceled": true, "error": "" });
        }
        Err(JobFail::Failed(msg)) => {
            return ms_finish(&peers, false, &format!("下载声库失败：{msg}"));
        }
    }

    ms_emit_phase(&peers, "extract", 88, "正在解压声库包…");
    remove_path(&stage);
    match safe_extract_zip(&zip_path, &stage, Some(job)) {
        Ok(_) => {}
        Err(e) if e == CANCELED => {
            remove_path(&stage);
            remove_path(&zip_path);
            emit_all(
                &peers,
                0,
                0,
                0,
                false,
                json!({ "phase": "canceled", "canceled": true, "error": "", "text": "已取消", "speed": 0 }),
            );
            return json!({ "ok": false, "canceled": true, "error": "" });
        }
        Err(e) => {
            remove_path(&stage);
            remove_path(&zip_path);
            return ms_finish(&peers, false, &format!("解压声库失败：{e}"));
        }
    }
    ms_emit_phase(&peers, "extract", 94, "正在校验声库结构…");
    let Some(cfg_dir) = detect_voicebank_root(&stage)
        .map(|r| r.root)
        .or_else(|| find_dsconfig_dir(&stage, 4))
    else {
        remove_path(&stage);
        remove_path(&zip_path);
        return ms_finish(&peers, false, "声库包里没有 dsconfig.yaml（包结构可能已变更）");
    };
    ms_emit_phase(&peers, "extract", 96, "正在安装到声库目录…");
    let root = vb_root();
    if let Err(e) = std::fs::create_dir_all(&root) {
        remove_path(&stage);
        remove_path(&zip_path);
        return ms_finish(&peers, false, &format!("创建声库目录失败：{e}"));
    }
    let final_dir = unique_child_dir(&root, &id);
    if let Err(e) = copy_tree(&cfg_dir, &final_dir) {
        remove_path(&stage);
        remove_path(&zip_path);
        remove_path(&final_dir);
        return ms_finish(&peers, false, &format!("安装声库失败：{e}"));
    }
    remove_path(&stage);
    remove_path(&zip_path);
    if find_dsconfig_dir(&final_dir, 1).is_none() {
        remove_path(&final_dir);
        return ms_finish(&peers, false, "安装后未找到 dsconfig.yaml");
    }
    let size = dir_size(&final_dir);
    let _ = ms_finish(&peers, true, "安装完成");
    json!({
        "ok": true,
        "name": id,
        "dir": final_dir.display().to_string(),
        "size": size,
        "source": "modelscope",
    })
}

pub fn ms_download(app: &AppHandle, req: Value) -> Value {
    let catalog = ms_catalog();
    let plan = match ms_resolve(&catalog, &req) {
        Ok(p) => p,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let job_id = format!("ms:{}", plan.id);
    let Some(job) = job_begin(&job_id) else {
        return json!({ "ok": false, "error": "该声库正在下载中", "id": plan.id });
    };
    run_blocking(app, job, move |app3, job3| {
        ms_download_worker(&app3, &job3, plan)
    })
}

pub fn ms_cancel(name: Option<String>) -> Value {
    match name
        .map(|s| sanitize_file_name(&s))
        .filter(|s| !s.is_empty())
    {
        Some(id) => {
            let hit = job_cancel(&format!("ms:{id}"));
            json!({ "ok": true, "canceled": hit, "id": id })
        }
        None => {
            let ids = cancel_jobs_with_prefix("ms:");
            json!({ "ok": true, "canceled": !ids.is_empty(), "ids": ids })
        }
    }
}

/* ------------------------------- 单元测试 ------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn tmpdir(tag: &str) -> PathBuf {
        let uniq = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let p = std::env::temp_dir().join(format!("fufumidi-ds-{tag}-{}-{uniq}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn put(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, text).unwrap();
    }

    fn mkzip(path: &Path, entries: &[(&str, &[u8])]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let f = std::fs::File::create(path).unwrap();
        let mut z = zip::ZipWriter::new(f);
        let o = zip::write::SimpleFileOptions::default();
        for (n, b) in entries {
            z.start_file(*n, o).unwrap();
            z.write_all(b).unwrap();
        }
        z.finish().unwrap();
    }

    #[test]
    fn zip_entry_unsafe_matrix() {
        assert!(zip_entry_unsafe(""));
        assert!(zip_entry_unsafe("../evil"));
        assert!(zip_entry_unsafe("a/../b"));
        assert!(zip_entry_unsafe("/abs/evil"));
        assert!(zip_entry_unsafe("C:\\evil"));
        assert!(zip_entry_unsafe("C:/evil"));
        assert!(zip_entry_unsafe("\\\\server\\share"));
        assert!(!zip_entry_unsafe("Bank/dsconfig.yaml"));
        assert!(!zip_entry_unsafe("a..b/c.onnx"));
        assert!(!zip_entry_unsafe("中文 声库/x.onnx"));
    }

    #[test]
    fn safe_extract_blocks_zip_slip_duplicates_and_absolute() {
        let root = tmpdir("zip-guard");
        let dest = root.join("out");

        let bad = root.join("bad.zip");
        mkzip(&bad, &[("../evil.txt", b"evil"), ("ok.txt", b"ok")]);
        let err = safe_extract_zip(&bad, &dest, None).unwrap_err();
        assert!(err.contains("不安全路径"), "{err}");
        assert!(!root.join("evil.txt").exists());
        assert!(!dest.join("ok.txt").exists(), "整包拒绝，不做部分解压");

        let abs = root.join("abs.zip");
        mkzip(&abs, &[("C:\\Windows\\evil.txt", b"x")]);
        assert!(safe_extract_zip(&abs, &dest, None).is_err());

        // zip 4.x 的写入端拒绝完全同名条目，这里用大小写不同的两个名字：
        // Windows 上按名取与按序解会指向不同内容，必须整包拒绝。
        let dup = root.join("dup.zip");
        mkzip(&dup, &[("A.txt", b"1"), ("a.txt", b"2")]);
        let err = safe_extract_zip(&dup, &dest, None).unwrap_err();
        assert!(err.contains("重名"), "{err}");

        let good = root.join("good.zip");
        mkzip(
            &good,
            &[
                ("Bank/dsconfig.yaml", b"acoustic: x\n"),
                ("Bank/model.onnx", b"onnx"),
            ],
        );
        let n = safe_extract_zip(&good, &dest, None).unwrap();
        assert_eq!(n, 2);
        assert!(dest.join("Bank/dsconfig.yaml").is_file());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn safe_extract_aborts_on_cancel_flag() {
        let root = tmpdir("zip-cancel");
        let good = root.join("good.zip");
        mkzip(&good, &[("a.txt", b"x")]);
        let job = Job::new("unit-extract-cancel");
        job.cancel();
        let err = safe_extract_zip(&good, &root.join("out"), Some(&job)).unwrap_err();
        assert_eq!(err, CANCELED);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn find_dsconfig_depth_limits() {
        let root = tmpdir("dsconfig");
        put(&root.join("a/b/dsconfig.yaml"), "acoustic: x\n");
        assert!(find_dsconfig_dir(&root, 0).is_none());
        assert!(find_dsconfig_dir(&root, 1).is_none());
        assert_eq!(
            find_dsconfig_dir(&root, 2).unwrap(),
            root.join("a/b"),
            "深度 2 应能找到 a/b"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn detect_voicebank_root_prefers_main_over_submodels() {
        let root = tmpdir("detect");
        let bank = root.join("Wrapper/Bank");
        put(
            &bank.join("dsconfig.yaml"),
            "acoustic: acoustic.onnx\nsample_rate: 44100\nhop_size: 512\n",
        );
        put(&bank.join("model.onnx"), "onnx");
        put(&bank.join("character.txt"), "name=测试声库\nversion=1\n");
        put(&bank.join("dsdur/dsconfig.yaml"), "acoustic: dur.onnx\n");
        put(&bank.join("dsdur/dur.onnx"), "dur");
        let info = detect_voicebank_root(&root).unwrap();
        assert_eq!(info.root, bank);
        assert_eq!(info.name, "测试声库");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn detect_voicebank_root_falls_back_to_dsconfig_name() {
        let root = tmpdir("detect-name");
        let bank = root.join("Bank");
        put(&bank.join("dsconfig.yaml"), "acoustic: a.onnx\nname: \"中文声库\"\n");
        put(&bank.join("a.onnx"), "x");
        let info = detect_voicebank_root(&root).unwrap();
        assert_eq!(info.name, "中文声库");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn unique_child_dir_appends_suffix() {
        let root = tmpdir("unique");
        assert_eq!(unique_child_dir(&root, "Ria"), root.join("Ria"));
        std::fs::create_dir_all(root.join("Ria")).unwrap();
        assert_eq!(unique_child_dir(&root, "Ria"), root.join("Ria_2"));
        std::fs::create_dir_all(root.join("Ria_2")).unwrap();
        assert_eq!(unique_child_dir(&root, "Ria"), root.join("Ria_3"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn sanitize_and_path_containment() {
        assert_eq!(sanitize_file_name("a/b:c*?\"<>|d"), "a_b_c______d");
        assert_eq!(sanitize_file_name("  名字. "), "名字");
        assert_eq!(sanitize_file_name(".."), "");
        assert_eq!(sanitize_file_name("神里绫华/测试:你好"), "神里绫华_测试_你好");

        let base = tmpdir("contain");
        assert!(path_under(&base, &base.join("x")));
        assert!(path_under(&base, &base.join("x/y/z")));
        assert!(!path_under(&base, &base));
        assert!(!path_under(&base, &base.join("..").join("evil")));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn percent_mapping_helpers() {
        assert_eq!(local_percent(0, 0, 99), 0);
        assert_eq!(local_percent(50, 100, 99), 50);
        assert_eq!(local_percent(100, 100, 99), 99);
        assert_eq!(local_percent(1, 3, 99), 33);
        assert_eq!(map_pct(0, 96, 100), 96);
        assert_eq!(map_pct(0, 88, 50), 44);
        assert_eq!(map_pct(88, 94, 50), 91);
        assert_eq!(map_pct(95, 99, 0), 95);
        assert_eq!(map_pct(0, 0, 100), 0, "退化区间不除零，退回 lo");
    }

    #[test]
    fn download_source_order_and_labels() {
        let auto = vocoder_urls("auto");
        assert!(auto[0].contains("cnb.cool"), "国内优先应以 CNB 打头：{auto:?}");
        assert!(auto.iter().any(|u| u.contains("openvpi")), "缺官方兜底：{auto:?}");
        assert!(
            auto.iter().any(|u| u.starts_with("https://ghfast.top/https://github.com/")),
            "缺 GitHub 镜像候选：{auto:?}"
        );
        let gh = vocoder_urls("github");
        assert!(!gh[0].contains("cnb.cool"), "全球优先应 GitHub 打头：{gh:?}");
        assert!(gh.iter().any(|u| u.contains("cnb.cool")), "GitHub 失败要回退 CNB");
        assert_eq!(dedup_urls(auto.clone()).len(), auto.len(), "候选不应重复");
        assert_eq!(source_label_of(&auto[0]), "国内源 · CNB");

        let pip_auto = pip_candidates("auto");
        assert_eq!(pip_auto.len(), 3);
        assert_eq!(pip_auto[0], Some("https://pypi.tuna.tsinghua.edu.cn/simple"));
        assert_eq!(pip_auto[1], Some("https://mirrors.aliyun.com/pypi/simple/"));
        assert_eq!(pip_auto[2], None);
        let pip_gh = pip_candidates("github");
        assert_eq!(pip_gh[0], None);
    }

    #[test]
    fn job_lifecycle_and_cancel_flags() {
        let id = format!("unit-lifecycle-{}", now_millis());
        let job = job_begin(&id).unwrap();
        assert!(job_begin(&id).is_none(), "同一 id 只允许一个任务");
        assert!(!job.is_canceled());
        assert!(job_cancel(&id));
        assert!(job.is_canceled());
        {
            let _guard = JobGuard(job.clone());
        }
        assert!(job_begin(&id).is_some(), "守卫 Drop 后槽位应释放");
        job_end(&id);
        assert!(!job_cancel(&id));
    }

    #[test]
    fn cancel_jobs_with_prefix_marks_all_matching() {
        let a = job_begin("unit-vb:a").unwrap();
        let b = job_begin("unit-vb:b").unwrap();
        let c = job_begin("unit-ms:c").unwrap();
        let mut ids = cancel_jobs_with_prefix("unit-vb:");
        ids.sort();
        assert_eq!(ids, vec!["a", "b"]);
        assert!(a.is_canceled() && b.is_canceled());
        assert!(!c.is_canceled(), "前缀不匹配的不受影响");
        job_end("unit-vb:a");
        job_end("unit-vb:b");
        job_end("unit-ms:c");
    }

    #[test]
    fn settings_and_runtime_roundtrip() {
        let root = tmpdir("settings");
        let sp = root.join("settings.json");
        put(&sp, "{\"theme\":\"fufu\",\"diffsinger_enabled\":true}");
        set_enabled_at(&sp, false).unwrap();
        let v = read_json(&sp);
        assert_eq!(v["diffsinger_enabled"], false);
        assert_eq!(v["theme"], "fufu", "其它设置不能被覆盖");

        put(&sp, "not json at all");
        set_enabled_at(&sp, true).unwrap();
        assert_eq!(read_json(&sp)["diffsinger_enabled"], true);

        let rp = root.join("diffsinger/runtime.json");
        put(&rp, "{\"vocoder\":{\"file\":\"old.onnx\"}}");
        patch_runtime_at(&rp, json!({"vocoder": {"file": "new.onnx", "spec": "x"}})).unwrap();
        let rv = read_json(&rp);
        assert_eq!(rv["vocoder"]["file"], "new.onnx");
        assert!(rv["updatedAt"].is_number());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn registry_structure_and_installed_flag() {
        let root = tmpdir("registry");
        let v = voicebank_registry_at(&root);
        assert_eq!(v["ok"], true);
        let list = v["list"].as_array().unwrap();
        assert_eq!(list.len(), VB_REGISTRY.len());
        assert_eq!(list[0]["installed"], false);
        assert_eq!(list[0]["size"], 0);
        assert_eq!(list[0]["id"], "ria_multi_dict");

        put(&root.join("Ria/dsconfig.yaml"), "acoustic: x.onnx\n");
        put(&root.join("Ria/x.onnx"), "onnx");
        let v2 = voicebank_registry_at(&root);
        assert_eq!(v2["list"][0]["installed"], true);
        assert!(v2["list"][0]["size"].as_u64().unwrap() > 0);

        let mut seen = std::collections::HashSet::new();
        for e in VB_REGISTRY.iter() {
            assert!(seen.insert(e.id), "注册表 id 必须唯一");
            assert!(e.gh_url.starts_with("https://github.com/"), "只走作者 GitHub 源");
            assert!(e.official_url.starts_with("https://github.com/"));
            assert!(!e.dir_name.contains("..") && !e.dir_name.contains('/'));
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn voicebank_list_and_delete_guards() {
        let base = tmpdir("vb-manage");
        let vb = base.join("diffsinger-voicebanks");
        put(&vb.join("Bank/dsconfig.yaml"), "acoustic: a.onnx\n");
        put(&vb.join("Bank/model.onnx"), "onnx");
        put(&vb.join("NotABank/readme.txt"), "x");
        put(&vb.join("Wrapped/Inner/dsconfig.yaml"), "acoustic: b.onnx\n");

        let v = list_voicebanks_at(&vb);
        let list = v["list"].as_array().unwrap();
        assert_eq!(list.len(), 2, "无 dsconfig 的目录不算声库：{v}");
        let names: Vec<&str> = list.iter().filter_map(|x| x["name"].as_str()).collect();
        assert!(names.contains(&"Bank"));
        assert!(names.contains(&"Wrapped"));

        let outside = base.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        assert_eq!(
            delete_voicebank_at(&vb, &outside.display().to_string())["ok"],
            false,
            "越界目录不许删"
        );
        assert_eq!(delete_voicebank_at(&vb, &vb.display().to_string())["ok"], false);
        assert_eq!(delete_voicebank_at(&vb, "nope")["ok"], false);
        assert_eq!(delete_voicebank_at(&vb, "  ")["ok"], false);

        let inner = vb.join("Wrapped/Inner");
        assert_eq!(delete_voicebank_at(&vb, &inner.display().to_string())["ok"], true);
        assert!(!inner.exists());
        assert!(!vb.join("Wrapped").exists(), "空父目录应被修剪");
        assert!(vb.join("Bank").exists());
        assert!(vb.exists(), "声库根本身不能删");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn import_zip_voicebank_and_duplicate_rename() {
        let base = tmpdir("import");
        let vb = base.join("diffsinger-voicebanks");
        let voc = base.join("diffsinger/vocoder");
        let rt = base.join("diffsinger/runtime.json");
        let dirs = ImportDirs {
            vb_root: &vb,
            vocoder_dir: &voc,
            runtime_file: &rt,
        };
        let stage_root = base.join("stage");
        let zip = base.join("测试声库.zip");
        mkzip(
            &zip,
            &[
                ("Wrapper/MyBank/dsconfig.yaml", b"acoustic: acoustic.onnx\nsample_rate: 44100\n"),
                ("Wrapper/MyBank/acoustic.onnx", b"onnx"),
                ("Wrapper/MyBank/character.txt", b"name=Role\n"),
            ],
        );
        let r = import_voicebank_path(&dirs, &stage_root, &zip);
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(r["kind"], "voicebank");
        assert_eq!(r["name"], "测试声库");
        let dir1 = PathBuf::from(r["dir"].as_str().unwrap());
        assert!(dir1.join("dsconfig.yaml").is_file());
        assert!(dir1.join("acoustic.onnx").is_file());
        assert!(r["size"].as_u64().unwrap() > 0);
        assert_eq!(r["models"]["acoustic"], "acoustic.onnx");

        let r2 = import_voicebank_path(&dirs, &stage_root, &zip);
        assert_eq!(r2["ok"], true, "{r2}");
        assert_eq!(r2["name"], "测试声库_2", "重名目录要加 _2 后缀");
        assert_eq!(list_voicebanks_at(&vb)["list"].as_array().unwrap().len(), 2);

        let bad = base.join("bad.zip");
        mkzip(&bad, &[("a.txt", b"x")]);
        let r3 = import_voicebank_path(&dirs, &stage_root, &bad);
        assert_eq!(r3["ok"], false);
        assert!(r3["error"].as_str().unwrap().contains("dsconfig"), "{r3}");

        let txt = base.join("x.txt");
        put(&txt, "x");
        let r4 = import_voicebank_path(&dirs, &stage_root, &txt);
        assert_eq!(r4["ok"], false);
        assert!(r4["error"].as_str().unwrap().contains("不支持"));

        let missing = base.join("nope.zip");
        let r5 = import_voicebank_path(&dirs, &stage_root, &missing);
        assert_eq!(r5["ok"], false);

        // 目录形态（已解压）也能导入
        let plain = base.join("PlainBank");
        put(&plain.join("dsconfig.yaml"), "acoustic: p.onnx\n");
        put(&plain.join("p.onnx"), "onnx");
        let r6 = import_voicebank_path(&dirs, &stage_root, &plain);
        assert_eq!(r6["ok"], true, "{r6}");
        assert_eq!(r6["name"], "PlainBank");
        assert_eq!(r6["fromDir"], true);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn import_oudep_installs_vocoder() {
        let base = tmpdir("oudep");
        let vb = base.join("diffsinger-voicebanks");
        let voc = base.join("diffsinger/vocoder");
        let rt = base.join("diffsinger/runtime.json");
        let dirs = ImportDirs {
            vb_root: &vb,
            vocoder_dir: &voc,
            runtime_file: &rt,
        };
        let zip = base.join("vocoder.oudep");
        mkzip(&zip, &[("model.onnx", b"onnx"), ("vocoder.yaml", b"x: 1\n")]);
        let r = import_voicebank_path(&dirs, &base.join("stage"), &zip);
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(r["kind"], "vocoder");
        assert!(voc.join("model.onnx").is_file());
        assert!(voc.join("vocoder.yaml").is_file());
        assert_eq!(read_json(&rt)["vocoder"]["file"], "model.onnx");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn collect_model_summary_picks_onnx() {
        let root = tmpdir("summary");
        put(&root.join("acoustic.onnx"), "a");
        put(&root.join("dsdur/dur.onnx"), "d");
        put(&root.join("hifigan.onnx"), "v");
        let s = collect_model_summary(&root);
        assert_eq!(s["acoustic"], "acoustic.onnx");
        assert!(s["vocoder"].as_str().unwrap().contains("hifigan"));
        assert_eq!(s["totalOnnx"], 3);
        assert_eq!(s["files"].as_array().unwrap().len(), 3);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ms_catalog_embedded_is_consistent() {
        let cat = ms_catalog();
        assert_eq!(cat["ok"], true, "内嵌 ModelScope 目录必须可解析");
        let mut total = 0usize;
        let mut available = 0usize;
        let mut placeholder = 0usize;
        let mut paths = std::collections::HashSet::new();
        for w in cat["works"].as_array().unwrap() {
            for c in w["categories"].as_array().unwrap() {
                for m in c["models"].as_array().unwrap() {
                    total += 1;
                    let p = m["path"].as_str().unwrap();
                    assert!(paths.insert(p.to_string()), "path 必须唯一：{p}");
                    if m["placeholder"].as_bool().unwrap() {
                        placeholder += 1;
                    } else {
                        available += 1;
                        let url = m["url"].as_str().unwrap();
                        assert!(url.starts_with("https://www.modelscope.cn/"), "{url}");
                    }
                }
            }
        }
        assert_eq!(cat["stats"]["total"].as_u64().unwrap() as usize, total);
        assert_eq!(cat["stats"]["available"].as_u64().unwrap() as usize, available);
        assert_eq!(
            cat["stats"]["placeholder"].as_u64().unwrap() as usize,
            placeholder
        );
        assert!(total > 100, "目录条目数异常：{total}");
    }

    #[test]
    fn ms_resolve_and_url_encoding() {
        let cat = json!({"works": [{"categories": [{"models": [
            {"name": "黑天鹅", "work": "崩坏：星穹铁道", "path": "星穹铁道/第二部分/黑天鹅.zip",
             "size": 413523987u64, "placeholder": false, "url": "https://example.test/x.zip"}
        ]}]}]});
        let plan = ms_resolve(&cat, &json!({"name": "黑天鹅", "path": "星穹铁道/第二部分/黑天鹅.zip"})).unwrap();
        assert_eq!(plan.id, "黑天鹅");
        assert_eq!(plan.label, "黑天鹅（崩坏：星穹铁道）");
        assert_eq!(plan.rec.size, 413523987);
        assert_eq!(plan.rec.url, "https://example.test/x.zip");

        let unknown = ms_resolve(&cat, &json!({"name": "x", "path": "nope.zip"}));
        assert!(unknown.is_err());
        let empty_path = ms_resolve(&cat, &json!({"name": "x"}));
        assert!(empty_path.is_err());

        let ph = json!({"works": [{"categories": [{"models": [
            {"name": "占位", "path": "a.zip", "placeholder": true}
        ]}]}]});
        let err = ms_resolve(&ph, &json!({"path": "a.zip"})).unwrap_err();
        assert!(err.contains("占位"), "{err}");

        let enc = pct_encode_path("星穹铁道/黑天鹅.zip");
        assert!(enc.contains("%E6%98%9F"), "{enc}");
        assert!(enc.contains('/'));
        assert!(ms_file_url("a/b.zip").contains("FilePath=a/b.zip"));
        assert!(ms_file_url("a/b.zip").starts_with("https://www.modelscope.cn/api/v1/models/"));
        let no_name = ms_resolve(&cat, &json!({"path": "星穹铁道/第二部分/黑天鹅.zip"})).unwrap();
        assert_eq!(no_name.id, "黑天鹅", "没传 name 时回退声库名");
    }

    /* ------------------- 真实环境测试（默认 ignored，手动跑） ------------------- */

    #[test]
    #[ignore = "真实环境：调用 resources/python 跑 engine_diffsinger.py deps --check"]
    fn real_deps_probe_uses_bundled_python() {
        if python_path().is_none() || engine_dir().is_none() {
            eprintln!("skip: 本机没有 python 运行时 / engine 目录");
            return;
        }
        let v = deps_probe();
        eprintln!("deps = {v}");
        assert_eq!(v["ok"], true, "{v}");
        let installed = v["installed"].as_array().cloned().unwrap_or_default();
        assert!(
            installed.iter().any(|x| x.as_str() == Some("onnxruntime")),
            "缺少 onnxruntime：{v}"
        );
    }

    #[test]
    #[ignore = "真实数据根：读取 <数据根>/diffsinger 与声库目录（只读）"]
    fn real_status_reads_installed_runtime() {
        if !data_dir().join("diffsinger").is_dir() {
            eprintln!("skip: 本机数据根没有安装 DiffSinger 运行时");
            return;
        }
        let v = status(json!({}));
        eprintln!("status = {v}");
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["vocoder"]["installed"], true, "{v}");
        assert!(v["voicebankCount"].as_u64().unwrap_or(0) >= 1, "{v}");
        assert_eq!(v["ready"], true, "{v}");
    }

    #[test]
    #[ignore = "真实网络：下载约 50MB 声码器到临时目录（不安装、不动数据根）"]
    fn real_vocoder_download_to_temp() {
        let root = tmpdir("real-vocoder");
        let dest = root.join("vocoder.oudep");
        let job = Job::new("unit-real-vocoder");
        let urls = vocoder_urls("auto");
        let empty: [Peer; 0] = [];
        let spec = DlSpec {
            urls: &urls,
            dest: &dest,
            label: "下载通用声码器",
            min_size: 1_000_000,
            hint_total: VOCODER_SIZE_HINT,
            pct_lo: 0,
            pct_hi: 96,
            peers: &empty,
        };
        let n = download_multi(&job, &spec).unwrap();
        eprintln!("downloaded {n} bytes from {urls:?}");
        assert!(n > 40_000_000, "声码器包应约 50MB，实际 {n}");
        let f = std::fs::File::open(&dest).unwrap();
        let mut zip = zip::ZipArchive::new(f).unwrap();
        let mut has_onnx = false;
        for i in 0..zip.len() {
            if let Ok(e) = zip.by_index(i) {
                if e.name().to_ascii_lowercase().ends_with(".onnx") {
                    has_onnx = true;
                    break;
                }
            }
        }
        assert!(has_onnx, "声码器包内应有 .onnx");
        let _ = std::fs::remove_dir_all(root);
    }
}
