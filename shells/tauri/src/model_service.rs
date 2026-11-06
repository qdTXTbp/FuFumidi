//! 模型服务：与 Electron v6.4.4 的 MODEL_REGISTRY 对齐的下载规格、下载器、
//! 进度/暂停/取消，以及分离模型配置自愈入口。
//!
//! 边界：所有取文件字节的活都从这里走；下载源顺序 = 国内镜像优先，失败按顺序回退。
//! 暂停/取消通过 kill 子进程实现；暂停保留 .part/.parts，取消清理。

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::{apply_engine_env, bundled_models_dir, data_dir, engine_dir, models_dir, python_path};

#[allow(dead_code)]
const CHUNK: u64 = 25 * 1024 * 1024;

#[derive(Clone, Copy)]
pub struct PartSet {
    pub urls: &'static [&'static str],
    pub sizes: &'static [u64],
}

#[derive(Clone, Copy)]
pub enum Dl {
    File { url: &'static str, mirrors: &'static [&'static str] },
    Zip { url: &'static str, mirrors: &'static [&'static str] },
    Parts(PartSet),
    Gsplit { size_key: &'static str, repo: &'static str },
    Hf { repo: &'static str },
}

#[derive(Clone, Copy)]
pub struct ModelSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: &'static str,
    pub arch: &'static str,
    pub use_text: &'static str,
    pub runtime: &'static str,
    pub dest: &'static str,
    pub note: &'static str,
    pub min_size: u64,
    pub size: u64,
    pub sha256: Option<&'static str>,
    pub marker: Option<&'static str>,
    pub dl: Dl,
}

const HFT_MIRRORS: &[&str] = &[
    "https://cnb.cool/FuFuCloud-mirror/Models/-/releases/download/models-extra-v1/hft-transformer-ismir2023.zip",
    "https://ghfast.top/https://github.com/monologue82/Models/releases/download/models-extra-v1/hft-transformer-ismir2023.zip",
    "https://gh-proxy.com/https://github.com/monologue82/Models/releases/download/models-extra-v1/hft-transformer-ismir2023.zip",
];
const TAGGER_MIRRORS: &[&str] = &[
    "https://cnb.cool/FuFuCloud-mirror/Models/-/releases/download/models-extra-v1/audio-tagger-20240415.zip",
    "https://ghfast.top/https://github.com/monologue82/Models/releases/download/models-extra-v1/audio-tagger-20240415.zip",
];
const BEAT_MIRRORS: &[&str] = &[
    "https://cnb.cool/FuFuCloud-mirror/Models/-/git/raw/main/beat_this/beat_this-final0.ckpt",
    "https://ghfast.top/https://raw.githubusercontent.com/monologue82/Models/main/beat_this/beat_this-final0.ckpt",
    "https://gh-proxy.com/https://raw.githubusercontent.com/monologue82/Models/main/beat_this/beat_this-final0.ckpt",
    "https://ghproxy.net/https://raw.githubusercontent.com/monologue82/Models/main/beat_this/beat_this-final0.ckpt",
    "https://raw.gitmirror.com/monologue82/Models/main/beat_this/beat_this-final0.ckpt",
];
const YOURMT3_MIRRORS: &[&str] = &[
    "https://cnb.cool/FuFuCloud-mirror/Models/-/releases/download/yourmt3-v1/yourmt3-runtime-20261020.zip",
    "https://ghfast.top/https://github.com/monologue82/Models/releases/download/yourmt3-v1/yourmt3-runtime-20261020.zip",
];
const MIROS_URLS: &[&str] = &[
    "https://cnb.cool/FuFuCloud-mirror/Models/-/releases/download/miros-v1/miros-runtime-20261021.z01",
    "https://cnb.cool/FuFuCloud-mirror/Models/-/releases/download/miros-v1/miros-runtime-20261021.z02",
    "https://cnb.cool/FuFuCloud-mirror/Models/-/releases/download/miros-v1/miros-runtime-20261021.z03",
    "https://cnb.cool/FuFuCloud-mirror/Models/-/releases/download/miros-v1/miros-runtime-20261021.z04",
    "https://cnb.cool/FuFuCloud-mirror/Models/-/releases/download/miros-v1/miros-runtime-20261021.z05",
    "https://cnb.cool/FuFuCloud-mirror/Models/-/releases/download/miros-v1/miros-runtime-20261021.z06",
];
const MIROS_SIZES: &[u64] = &[943718400, 943718400, 943718400, 943718400, 943718400, 645912192];

pub const SPECS: &[ModelSpec] = &[
    ModelSpec {
        id: "piano_transcription",
        name: "钢琴转录模型",
        kind: "transcribe",
        arch: "Piano-Transformer",
        use_text: "钢琴转录：和弦、旋律与踏板落音，适合纯钢琴曲快速转 MIDI",
        runtime: "piano",
        dest: "piano_transcription/note_F1=0.9677_pedal_F1=0.9186.pth",
        note: "piano-transcription CRNN（含踏板检测）· 约 166 MB",
        min_size: 160_000_000,
        size: 0,
        sha256: None,
        marker: None,
        dl: Dl::File {
            url: "https://zenodo.org/record/4034264/files/CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth?download=1",
            mirrors: &[],
        },
    },
    ModelSpec {
        id: "hft_transformer",
        name: "hFT-Transformer",
        kind: "transcribe",
        arch: "hFT-Transformer",
        use_text: "钢琴专用：分层频时 Transformer，MAESTRO 权重，CPU 可跑",
        runtime: "piano",
        dest: "hft_transformer",
        note: "钢琴转录 · Sony ISMIR2023 · 5.5M 参数 · 约 22 MB · CPU 可跑",
        min_size: 18_000_000,
        size: 20_540_269,
        sha256: Some("bb3c88758e4802e6b3881ccb6dc7927417fb43f76980df3739ab2bbc418d70c5"),
        marker: Some("checkpoint/MAESTRO-V3/model_016_003.pkl"),
        dl: Dl::Zip {
            url: "https://github.com/monologue82/Models/releases/download/models-extra-v1/hft-transformer-ismir2023.zip",
            mirrors: HFT_MIRRORS,
        },
    },
    ModelSpec {
        id: "miros",
        name: "MIROS",
        kind: "transcribe",
        arch: "MIROS (MusicFM + YourMT3+)",
        use_text: "通用多乐器转录：2025 AMT Challenge 冠军，MusicFM 编码器 + YourMT3+ 多通道解码",
        runtime: "miros",
        dest: "miros",
        note: "通用多乐器转录 · 2025 AMT Challenge 冠军 · 运行时+权重约 5.0 GB",
        min_size: 5_000_000_000,
        size: 5_364_504_192,
        sha256: Some("6ee7a2d2b3181de7a9b26408a6a787ac4c81cc13d227872f7b02d7466487c844"),
        marker: Some("site/transformers/__init__.py"),
        dl: Dl::Parts(PartSet { urls: MIROS_URLS, sizes: MIROS_SIZES }),
    },
    ModelSpec {
        id: "yourmt3",
        name: "YourMT3+",
        kind: "transcribe",
        arch: "YourMT3+ (YPTF.Single)",
        use_text: "通用多乐器转录：YPTF+Single，强于 Basic Pitch；含独立 Python 运行时",
        runtime: "yourmt3",
        dest: "yourmt3",
        note: "通用多乐器转录 · YPTF+Single · 运行时+权重约 433 MB · CPU/GPU 均可",
        min_size: 300_000_000,
        size: 453_848_674,
        sha256: Some("82054845789bf380317cd3ab77dedc6622ee969e58216d7b8289691ae8011c46"),
        marker: Some("amt/logs/2024/ptf_all_cross_rebal5_mirst_xk2_edr005_attend_c_full_plus_b100/checkpoints/model.ckpt"),
        dl: Dl::Zip {
            url: "https://cnb.cool/FuFuCloud-mirror/Models/-/releases/download/yourmt3-v1/yourmt3-runtime-20261020.zip",
            mirrors: YOURMT3_MIRRORS,
        },
    },
    ModelSpec {
        id: "muscriptor_small",
        name: "MuScriptor Small",
        kind: "transcribe",
        arch: "MuScriptor",
        use_text: "通用多乐器转录：103M 参数，轻量快速，适合快速出草稿",
        runtime: "muscriptor",
        dest: "muscriptor/small",
        note: "多乐器转录 · 103M 参数 · 约 400 MB · GitHub 镜像分卷下载",
        min_size: 50_000_000,
        size: 411_888_600,
        sha256: None,
        marker: Some("model.safetensors"),
        dl: Dl::Gsplit { size_key: "small", repo: "monologue82/Models" },
    },
    ModelSpec {
        id: "muscriptor_medium",
        name: "MuScriptor Medium",
        kind: "transcribe",
        arch: "MuScriptor",
        use_text: "通用多乐器转录：307M 参数，精度与速度均衡（推荐）",
        runtime: "muscriptor",
        dest: "muscriptor/medium",
        note: "多乐器转录 · 307M 参数（推荐）· 约 1.2 GB · GitHub 镜像分卷下载",
        min_size: 200_000_000,
        size: 1_228_144_472,
        sha256: None,
        marker: Some("model.safetensors"),
        dl: Dl::Gsplit { size_key: "medium", repo: "monologue82/Models" },
    },
    ModelSpec {
        id: "muscriptor_large",
        name: "MuScriptor Large",
        kind: "transcribe",
        arch: "MuScriptor",
        use_text: "通用多乐器转录：1.4B 参数，多轨精准，适合复杂编曲",
        runtime: "muscriptor",
        dest: "muscriptor/large",
        note: "多乐器转录 · 1.4B 参数 · 约 5.2 GB · GitHub 镜像分卷下载",
        min_size: 900_000_000,
        size: 5_465_642_136,
        sha256: None,
        marker: Some("model.safetensors"),
        dl: Dl::Gsplit { size_key: "large", repo: "monologue82/Models" },
    },
    ModelSpec {
        id: "beat_this",
        name: "节拍网格检测（Beat This!）",
        kind: "transcribe",
        arch: "BeatThis",
        use_text: "MuScriptor 转录可选前置：节拍网格检测，提升音符时值 / 对齐",
        runtime: "muscriptor",
        dest: "hub/checkpoints/beat_this-final0.ckpt",
        note: "MuScriptor 转录时值对齐 · final0 · 约 81 MB · 多源并行加速下载",
        min_size: 70_000_000,
        size: 0,
        sha256: Some("8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331"),
        marker: None,
        dl: Dl::File {
            url: "https://raw.githubusercontent.com/monologue82/Models/main/beat_this/beat_this-final0.ckpt",
            mirrors: BEAT_MIRRORS,
        },
    },
    ModelSpec {
        id: "audio_tagger",
        name: "乐器组标签模型（AudioSet）",
        kind: "transcribe",
        arch: "AudioSet zipformer-small (int8 ONNX)",
        use_text: "转录前按段自动探测乐器组的标签模型，不参与 MIDI 生成",
        runtime: "muscriptor",
        dest: "audio-tagger",
        note: "MuScriptor 自动探测乐器组用 · 20.8 MB · CPU 约 0.3s/10s",
        min_size: 19_000_000,
        size: 21_820_758,
        sha256: Some("e2fa9affc4d42bcf6f8400e4d0def0dcdefd95202819b1b90cf75d1123653295"),
        marker: Some("model.int8.onnx"),
        dl: Dl::Zip {
            url: "https://github.com/monologue82/Models/releases/download/models-extra-v1/audio-tagger-20240415.zip",
            mirrors: TAGGER_MIRRORS,
        },
    },
    ModelSpec {
        id: "aria_amt",
        name: "Aria-AMT 钢琴",
        kind: "transcribe",
        arch: "Aria-AMT",
        use_text: "钢琴转录：Aria-AMT 强化模型，和弦与演奏细节更准",
        runtime: "aria",
        dest: "aria_amt",
        note: "EleutherAI · 钢琴转录（Apache-2.0）· 约 680 MB",
        min_size: 100_000_000,
        size: 446_577_344,
        sha256: None,
        marker: Some("piano-medium-double-1.0.safetensors"),
        dl: Dl::Hf { repo: "AEmotionStudio/aria-amt-models" },
    },
    ModelSpec {
        id: "hnsep_240512",
        name: "hnsep 谐波分离（Worldline v11）",
        kind: "tuning",
        arch: "Hnsep ONNX（STFT 复数掩码）",
        use_text: "把原音拆成谐波 + 噪声两路，气声与辅音更真；只在轨道渲染器选 Worldline v11 时使用",
        runtime: "worldline-r11",
        dest: "hnsep/hnsep_240512",
        note: "约 52 MB · MIT（tsurumeso/vocal-remover）",
        min_size: 50_000_000,
        size: 54_934_878,
        sha256: Some("8f8c1046d0cacd40363e6f71d48bc1663e06a01d4625af0569055648d771ff92"),
        marker: Some("hnsep.yaml"),
        dl: Dl::Zip {
            url: "https://cnb.cool/FuFuCloud-mirror/Models/-/releases/download/hnsep-v1/hnsep_240512.oudep",
            mirrors: &[],
        },
    },
];

fn spec_of(id: &str) -> Option<&'static ModelSpec> { SPECS.iter().find(|s| s.id == id) }

fn oto_err(error: impl Into<String>) -> Value { json!({ "ok": false, "error": error.into() }) }

pub fn artifact_rel(id: &str) -> Option<String> {
    if let Some(spec) = spec_of(id) { return Some(spec.dest.to_string()); }
    if let Some(rest) = id.strip_prefix("msst:") {
        let mut it = rest.splitn(2, ':');
        let tag = it.next().unwrap_or("");
        let stem = it.next().unwrap_or("");
        if matches!(tag, "multi" | "vocal" | "single" | "vr") && !stem.is_empty() && !stem.contains('/') && !stem.contains('\\') && !stem.contains("..") {
            return Some(format!("{tag}/{stem}"));
        }
    }
    None
}

fn file_len(p: &Path) -> u64 { std::fs::metadata(p).map(|m| m.len()).unwrap_or(0) }

fn sha256_file(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 { break; }
        h.update(&buf[..n]);
    }
    Some(format!("{:x}", h.finalize()))
}

fn dir_size(p: &Path) -> u64 {
    fn walk(p: &Path, depth: u32) -> u64 {
        if depth > 32 { return 0; }
        let Ok(rd) = std::fs::read_dir(p) else { return 0 };
        let mut total = 0;
        for e in rd.flatten() {
            let Ok(md) = std::fs::symlink_metadata(e.path()) else { continue };
            if md.file_type().is_symlink() { continue; }
            if md.is_dir() { total += walk(&e.path(), depth + 1); } else { total += md.len(); }
        }
        total
    }
    walk(p, 0)
}

/// 分卷期望字节数：25 MiB 固定切片，末卷余数（与 main/fast-download.js 一致）。
#[allow(dead_code)]
pub fn expected_part_size(total: u64, parts: u64, index: u64) -> u64 {
    if total == 0 || parts == 0 || index < 1 || index > parts { return 0; }
    let remaining = total.saturating_sub((index - 1) * CHUNK);
    if remaining == 0 { return 0; }
    remaining.min(CHUNK)
}

#[allow(dead_code)]
pub fn parts_layout_ok(total: u64, parts: u64) -> bool {
    if total == 0 || parts == 0 { return false; }
    let last = expected_part_size(total, parts, parts);
    last > 0 && last <= CHUNK
}

fn read_msst_manifest() -> Value {
    let p = models_dir().join("msst-manifest.json");
    if let Some(v) = std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) { return v; }
    serde_json::from_str::<Value>(include_str!("msst-manifest-seed.json")).unwrap_or_else(|_| json!({}))
}

fn manifest_meta(man: &Value, tag: &str, key: &str) -> Option<Value> {
    man.get(tag)?.get(key).cloned().or_else(|| {
        let obj = man.get(tag)?.as_object()?;
        for (_k, v) in obj {
            let model = v.get("model").and_then(|x| x.as_str()).unwrap_or("");
            let stem = Path::new(model).file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let norm = |s: &str| s.to_ascii_lowercase().replace('-', "_");
            if norm(stem) == norm(key) { return Some(v.clone()); }
        }
        None
    })
}

fn base_item(spec: &ModelSpec, dir: &Path, active: bool) -> Value {
    let dest = dir.join(spec.dest);
    let (exists, size) = match spec.dl {
        Dl::File { .. } => {
            let n = file_len(&dest);
            (n >= spec.min_size && n > 0, n)
        }
        _ => {
            if let Some(marker) = spec.marker {
                let mp = dest.join(marker);
                if mp.is_file() { (true, file_len(&mp)) } else { (false, 0) }
            } else if dest.is_dir() {
                let has = std::fs::read_dir(&dest).map(|mut r| r.next().is_some()).unwrap_or(false);
                (has, 0)
            } else { (false, 0) }
        }
    };
    let (parts, part_sizes): (Value, Value) = match spec.dl {
        Dl::Parts(p) => (json!(p.sizes.len()), json!(p.sizes)),
        _ => (Value::Null, Value::Null),
    };
    let typ = match spec.dl {
        Dl::File { .. } => "file",
        Dl::Zip { .. } => "zip",
        Dl::Parts(_) => "parts",
        Dl::Gsplit { .. } => "ghsplit",
        Dl::Hf { .. } => "hf",
    };
    let repo = match spec.dl {
        Dl::Gsplit { repo, .. } => json!(repo),
        Dl::Hf { repo } => json!(repo),
        _ => Value::Null,
    };
    json!({
        "id": spec.id, "name": spec.name, "kind": spec.kind, "path": dest.display().to_string(),
        "size": size, "exists": exists, "downloadable": true,
        "note": spec.note, "arch": spec.arch, "use": spec.use_text, "runtime": spec.runtime,
        "type": typ, "repo": repo, "sizeKey": match spec.dl { Dl::Gsplit { size_key, .. } => json!(size_key), _ => Value::Null }, "gated": false,
        "parts": parts, "partSizes": part_sizes, "sha256": spec.sha256,
        "minSize": spec.min_size, "totalSize": spec.size,
        "active": active,
    })
}

fn bundled_tagger_item(active: bool) -> Option<Value> {
    let d = models_dir().join("audio-tagger");
    if d.join("model.int8.onnx").is_file() { return None; }
    let b = bundled_models_dir()?.join("audio-tagger");
    if !b.join("model.int8.onnx").is_file() { return None; }
    Some(json!({
        "id": "audio_tagger", "name": "乐器组标签模型（AudioSet）", "kind": "transcribe",
        "path": b.display().to_string(), "size": file_len(&b.join("model.int8.onnx")), "exists": true,
        "downloadable": false, "note": "随包内置；资源中心可下载更新副本", "arch": "AudioSet zipformer-small (int8 ONNX)",
        "use": "转录前按段自动探测乐器组的标签模型，不参与 MIDI 生成", "runtime": "muscriptor",
        "type": "zip", "active": active,
    }))
}

fn msst_catalog_items(dir: &Path, states: Option<&ModelDlState>) -> Vec<Value> {
    let mut items = Vec::new();
    let mut seen: HashMap<String, bool> = HashMap::new();
    let cat: Vec<Value> = serde_json::from_str(include_str!("../../../frontend/public/models-msst-catalog.json")).unwrap_or_default();
    let man: Value = read_msst_manifest();
    // 目录条目 + manifest 里未收录的条目（Electron 的 _msstRegistry 是两者并集）
    let mut rows: Vec<(String, String, String, String)> = Vec::new();
    for m in &cat {
        let file = m.get("file").and_then(|v| v.as_str()).unwrap_or("");
        let tag = m.get("tag").and_then(|v| v.as_str()).unwrap_or("");
        if file.is_empty() || tag.is_empty() { continue; }
        let stem = Path::new(file).file_stem().and_then(|s| s.to_str()).unwrap_or(file).to_string();
        rows.push((tag.to_string(), stem, m.get("desc").and_then(|v| v.as_str()).unwrap_or("").to_string(), m.get("label").and_then(|v| v.as_str()).unwrap_or("").to_string()));
    }
    for tag in ["vocal", "multi", "single", "vr"] {
        if let Some(obj) = man.get(tag).and_then(|v| v.as_object()) {
            for (key, meta) in obj {
                let model = meta.get("model").and_then(|v| v.as_str()).unwrap_or("");
                let stem = Path::new(model).file_stem().and_then(|s| s.to_str()).unwrap_or(key.as_str()).to_string();
                if rows.iter().any(|(t2, s2, _, _)| t2 == tag && s2 == &stem) { continue; }
                rows.push((tag.to_string(), stem, String::new(), String::new()));
            }
        }
    }
    for (tag, stem, desc, label) in rows {
        let id = format!("msst:{tag}:{stem}");
        if seen.contains_key(&id) { continue; }
        seen.insert(id.clone(), true);
        let dest = dir.join(&tag).join(&stem);
        let meta = manifest_meta(&man, &tag, &stem);
        let model_name = meta.as_ref().and_then(|v| v.get("model")).and_then(|v| v.as_str()).unwrap_or("");
        let final_file = if model_name.is_empty() { dest.clone() } else { dest.join(model_name) };
        let size = file_len(&final_file);
        let total_size = meta.as_ref().and_then(|v| v.get("size")).and_then(|v| v.as_u64()).unwrap_or(0);
        let min_size = if total_size > 0 { (total_size as f64 * 0.9) as u64 } else { 1_000_000 };
        let exists = if final_file.is_file() { size >= min_size } else {
            std::fs::read_dir(&dest).map(|mut r| r.next().is_some()).unwrap_or(false)
        };
        let parts_n = meta.as_ref().and_then(|v| v.get("parts")).and_then(|v| v.as_u64()).unwrap_or(0);
        let parts = if parts_n > 0 { json!(parts_n) } else { Value::Null };
        let part_sizes = if parts_n > 0 && total_size > 0 {
            (1..=parts_n).map(|i| expected_part_size(total_size, parts_n, i)).collect::<Vec<u64>>()
        } else { Vec::new() };
        let sha = meta.as_ref().and_then(|v| v.get("sha256")).cloned().unwrap_or(Value::Null);
        let active = states.map(|s| s.active(&id)).unwrap_or(false);
        items.push(json!({
            "id": id, "name": stem, "kind": "separate", "path": dest.display().to_string(),
            "size": size, "exists": exists, "downloadable": true,
            "note": desc, "arch": if label.is_empty() { "分离模型".to_string() } else { label.clone() },
            "use": desc, "runtime": "separate", "type": "ghsplit", "repo": "monologue82/Models",
            "parts": parts, "partSizes": part_sizes, "sha256": sha, "minSize": min_size,
            "totalSize": total_size, "group": "msst", "active": active,
        }));
    }
    // 已下载但不在目录/manifest 里的（旧版本/用户自放）也要列出来
    for (tag, kind, label) in [("multi", "separate", "multi-stem"), ("vocal", "separate", "vocal"), ("single", "separate", "single-stem"), ("vr", "separate", "vr")] {
        let Ok(rd) = std::fs::read_dir(dir.join(tag)) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let name = p.file_stem().and_then(|s| s.to_str()).unwrap_or("model").to_string();
            let id = format!("msst:{tag}:{name}");
            if seen.contains_key(&id) { continue; }
            let active = states.map(|s| s.active(&id)).unwrap_or(false);
            let size = if p.is_dir() { dir_size(&p) } else { file_len(&p) };
            items.push(json!({
                "id": id, "name": name, "kind": kind, "path": p.display().to_string(),
                "size": size, "exists": size >= 1_000_000, "downloadable": true,
                "note": label, "arch": label, "use": label, "runtime": "separate",
                "type": "ghsplit", "repo": "monologue82/Models", "group": "msst", "active": active,
            }));
        }
    }
    items
}

pub fn list_with_state(state: Option<&ModelDlState>) -> Vec<Value> {
    let dir = models_dir();
    let mut items = Vec::new();
    let basic = if dir.join("basic_pitch_quant.onnx").exists() { dir.join("basic_pitch_quant.onnx") }
        else if let Some(b) = bundled_models_dir() { b.join("basic_pitch_quant.onnx") }
        else { dir.join("basic_pitch_quant.onnx") };
    let bn = file_len(&basic);
    items.push(json!({
        "id": "basic_pitch", "name": "通用转录（int8 量化）", "kind": "transcribe",
        "path": basic.display().to_string(), "size": bn, "exists": bn > 0, "downloadable": false,
        "note": "basic-pitch ONNX int8 量化模型（CPU 加速）", "arch": "Basic Pitch (int8)",
        "use": "默认通用转录：note + onset，CPU 可用", "runtime": "basic", "type": "file", "active": false,
    }));
    for spec in SPECS {
        let active = state.map(|s| s.active(spec.id)).unwrap_or(false);
        items.push(base_item(spec, &dir, active));
    }
    if let Some(v) = bundled_tagger_item(state.map(|s| s.active("audio_tagger")).unwrap_or(false)) { items.push(v); }
    // 4.4 的 htdemucs 6stems 是随包/内置条目
    let six = dir.join("multi/htdemucs4_6stems");
    let six_size = dir_size(&six);
    items.push(json!({
        "id": "htdemucs4_6stems", "name": "HTDemucs4 6stems", "kind": "separate",
        "path": six.display().to_string(), "size": six_size, "exists": six_size >= 1_000_000,
        "downloadable": false, "note": "6-stem separation", "arch": "HTDemucs", "use": "六轨分离（随包）",
        "runtime": "separate", "type": "file", "active": false,
    }));
    items.extend(msst_catalog_items(&dir, state));
    items
}

pub fn list_plain() -> Vec<Value> { list_with_state(None) }

/* ---------------- 下载状态 ---------------- */

pub struct ModelJob {
    canceled: AtomicBool,
    paused: AtomicBool,
    child: Mutex<Option<Child>>,
    control: Mutex<Option<PathBuf>>,
}

impl ModelJob {
    fn new() -> Self { ModelJob { canceled: AtomicBool::new(false), paused: AtomicBool::new(false), child: Mutex::new(None), control: Mutex::new(None) } }
    fn set_control(&self, dir: PathBuf) { *self.control.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir); }
    fn control(&self) -> Option<PathBuf> { self.control.lock().unwrap_or_else(|e| e.into_inner()).clone() }
    fn stop_flags(&self) -> (bool, bool) { (self.canceled.load(Ordering::SeqCst), self.paused.load(Ordering::SeqCst)) }
    fn set_child(&self, c: Child) { *self.child.lock().unwrap_or_else(|e| e.into_inner()) = Some(c); }
    /// 只 kill，不 wait —— wait 由执行线程负责，避免两处同时回收。
    fn kill(&self) {
        if let Some(c) = self.child.lock().unwrap_or_else(|e| e.into_inner()).as_mut() { let _ = c.kill(); }
    }
    fn wait(&self) {
        if let Some(mut c) = self.child.lock().unwrap_or_else(|e| e.into_inner()).take() { let _ = c.wait(); }
    }
}

#[derive(Clone, Default)]
pub struct ModelDlState { jobs: Arc<Mutex<HashMap<String, Arc<ModelJob>>>> }

impl ModelDlState {
    pub fn active(&self, id: &str) -> bool { self.jobs.lock().unwrap_or_else(|e| e.into_inner()).contains_key(id) }
    fn begin(&self, id: &str) -> Result<Arc<ModelJob>, String> {
        let mut g = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        if g.contains_key(id) { return Err("模型下载已在进行中，请稍候".into()); }
        let job = Arc::new(ModelJob::new());
        g.insert(id.to_string(), job.clone());
        Ok(job)
    }
    fn end(&self, id: &str) { self.jobs.lock().unwrap_or_else(|e| e.into_inner()).remove(id); }
    fn get(&self, id: &str) -> Option<Arc<ModelJob>> { self.jobs.lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned() }
}

pub fn cancel(state: &ModelDlState, id: Option<String>) -> Value {
    let Some(id) = id.filter(|s| !s.is_empty()) else { return json!({ "ok": false, "error": "missing id" }); };
    if let Some(job) = state.get(&id) {
        job.canceled.store(true, Ordering::SeqCst);
        if let Some(dir) = job.control() { let _ = std::fs::create_dir_all(&dir); let _ = std::fs::write(dir.join("cancel"), b"1"); }
        // 先给 Python 下载器一个优雅退出的窗口（它每块都会看控制文件），超时才 kill。
        for _ in 0..20 { if !state.active(&id) { break; } std::thread::sleep(Duration::from_millis(150)); }
        job.kill();
        job.wait();
        state.end(&id);
    }
    // 取消 = 清理断点；暂停 = 保留。
    if let Some(rel) = artifact_rel(&id) {
        let dest = models_dir().join(rel);
        let _ = std::fs::remove_file(dest.with_extension("part"));
        let _ = std::fs::remove_file(dest.with_extension("tmp"));
        if let Some(parent) = dest.parent() {
            let base = dest.file_name().and_then(|s| s.to_str()).unwrap_or("");
            let _ = std::fs::remove_dir_all(parent.join(format!(".{base}.parts")));
        }
        let _ = std::fs::remove_dir_all(dest.join(".parts"));
    }
    json!({ "ok": true })
}

pub fn pause(state: &ModelDlState, id: Option<String>) -> Value {
    let Some(id) = id.filter(|s| !s.is_empty()) else { return json!({ "ok": false, "error": "missing id" }); };
    if let Some(job) = state.get(&id) {
        job.paused.store(true, Ordering::SeqCst);
        if let Some(dir) = job.control() { let _ = std::fs::create_dir_all(&dir); let _ = std::fs::write(dir.join("pause"), b"1"); }
        for _ in 0..20 { if !state.active(&id) { break; } std::thread::sleep(Duration::from_millis(150)); }
        job.kill();
        json!({ "ok": true, "paused": true })
    } else {
        json!({ "ok": true, "paused": false, "note": "当前没有在下载" })
    }
}

#[allow(clippy::too_many_arguments)]
fn emit_progress(app: Option<&AppHandle>, id: &str, received: u64, total: u64, done: bool, text: &str, speed: u64, extra: Value) {
    let percent = if total > 0 { ((received as f64 / total as f64) * 100.0).min(if done { 100.0 } else { 99.0 }) as u8 } else { 0 };
    let mut v = json!({
        "id": id, "received": received, "total": total, "percent": percent,
        "done": done, "text": text, "speed": speed, "active": !done,
    });
    if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) { for (k, val) in e { o.insert(k.clone(), val.clone()); } }
    if let Some(app) = app { let _ = app.emit("model:progress", v); }
}

fn fmt_speed(bps: u64) -> String {
    if bps >= 1_000_000 { format!("{:.1} MB/s", bps as f64 / 1e6) } else if bps >= 1000 { format!("{} KB/s", bps / 1000) } else { String::new() }
}

/// 下载一个 URL 到 part 文件（curl -C - 断点续传），期间按文件大小发进度。
/// 返回最终字节数；被暂停/取消时返回 "__paused"/"__canceled"。
#[allow(clippy::too_many_arguments)]
fn curl_to_part(app: Option<&AppHandle>, job: &ModelJob, id: &str, url: &str, part: &Path, expect: u64, base: u64, total: u64, label: &str) -> Result<u64, String> {
    if let Some(parent) = part.parent() { let _ = std::fs::create_dir_all(parent); }
    let mut have = file_len(part);
    if expect > 0 && have >= expect { return Ok(have); }
    if expect > 0 && have > expect { let _ = std::fs::remove_file(part); have = 0; }
    if let Some(app) = app { let _ = app.emit("model:progress", json!({ "id": id, "received": base + have, "total": total, "percent": if total > 0 { ((base + have) as f64 / total as f64 * 100.0).min(99.0) as u8 } else { 0 }, "done": false, "text": label, "active": true })); }
    let mut last_err = String::new();
    for attempt in 0..2 {
        let (canceled, paused) = job.stop_flags();
        if canceled { return Err("__canceled".into()); }
        if paused { return Err("__paused".into()); }
        let mut cmd = Command::new("curl.exe");
        cmd.creation_flags(0x08000000)
            .args(["-L", "--fail", "--silent", "--show-error", "--retry", "2", "--retry-delay", "2",
                   "--connect-timeout", "20", "--speed-limit", "102400", "--speed-time", "60",
                   "-C", "-", "-o"])
            .arg(part)
            .arg(url);
        let child = match cmd.spawn() { Ok(c) => c, Err(e) => return Err(e.to_string()) };
        job.set_child(child);
        let mut last_t = Instant::now();
        let mut last_b = file_len(part);
        let mut speed;
        loop {
            let (canceled, paused) = job.stop_flags();
            if canceled { job.kill(); job.wait(); return Err("__canceled".into()); }
            if paused { job.kill(); job.wait(); return Err("__paused".into()); }
            let mut status: Option<Result<std::process::ExitStatus, String>> = None;
            {
                let mut g = job.child.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(c) = g.as_mut() {
                    match c.try_wait() { Ok(Some(st)) => status = Some(Ok(st)), Ok(None) => {}, Err(e) => status = Some(Err(e.to_string())) }
                }
            }
            if let Some(st) = status {
                job.wait();
                match st {
                    Ok(st) => {
                        let n = file_len(part);
                        if st.success() { return Ok(n); }
                        last_err = format!("curl exit {:?}", st.code());
                    }
                    Err(e) => last_err = e,
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(300));
            let n = file_len(part);
            let now = Instant::now();
            if now.duration_since(last_t).as_millis() >= 500 {
                let dt = now.duration_since(last_t).as_secs_f64().max(0.001);
                speed = ((n.saturating_sub(last_b)) as f64 / dt) as u64;
                last_t = now; last_b = n;
                let text = format!("{label}{}", if speed > 0 { format!(" · {}", fmt_speed(speed)) } else { String::new() });
                emit_progress(app, id, base + n, total.max(expect), false, &text, speed, Value::Null);
            }
        }
        // 失败：若服务器不支持续传，清掉 part 重来一次
        if attempt == 0 && expect > 0 && file_len(part) < expect {
            let _ = std::fs::remove_file(part);
        }
    }
    Err(if last_err.is_empty() { "下载失败".to_string() } else { last_err })
}

fn safe_extract_zip(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    if zip.len() > 200_000 { return Err("压缩包条目过多".into()); }
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let mut e = zip.by_index(i).map_err(|x| x.to_string())?;
        let name = e.name().replace('\\', "/");
        if name.is_empty() { continue; }
        if name.starts_with('/') || name.contains("..") || name.contains(':') { return Err(format!("压缩包包含不安全路径：{name}")); }
        let out = dest.join(&name);
        if e.is_dir() { std::fs::create_dir_all(&out).map_err(|x| x.to_string())?; continue; }
        if let Some(parent) = out.parent() { std::fs::create_dir_all(parent).map_err(|x| x.to_string())?; }
        let mut f = std::fs::File::create(&out).map_err(|x| x.to_string())?;
        std::io::copy(&mut e, &mut f).map_err(|x| x.to_string())?;
    }
    Ok(())
}

fn verify_size_sha(path: &Path, expect_total: u64, sha: Option<&str>) -> Result<u64, String> {
    let size = file_len(path);
    if expect_total > 0 && size != expect_total { return Err(format!("大小不符：{size}/{expect_total}")); }
    if let Some(want) = sha {
        let got = sha256_file(path).ok_or("SHA-256 读取失败")?;
        if !got.eq_ignore_ascii_case(want) {
            let _ = std::fs::remove_file(path);
            return Err(format!("SHA-256 校验失败：{}…（期望 {}…）", &got[..got.len().min(12)], &want[..want.len().min(12)]));
        }
    }
    Ok(size)
}

fn marker_ok(dest: &Path, marker: Option<&str>) -> bool {
    marker.map(|m| dest.join(m).is_file()).unwrap_or_else(|| std::fs::read_dir(dest).map(|mut r| r.next().is_some()).unwrap_or(false))
}

fn finish_emit(app: Option<&AppHandle>, id: &str, size: u64) { emit_progress(app, id, size, size, true, "下载完成", 0, json!({ "existed": false })); }

fn urls_of(spec: &ModelSpec) -> Vec<String> {
    match spec.dl {
        Dl::File { url, mirrors } | Dl::Zip { url, mirrors } => {
            let mut v: Vec<String> = mirrors.iter().map(|s| s.to_string()).collect();
            if !url.is_empty() && !v.iter().any(|x| x == url) { v.push(url.to_string()); }
            v
        }
        _ => Vec::new(),
    }
}

fn download_file(app: Option<&AppHandle>, job: &ModelJob, spec: &ModelSpec, dest: &Path) -> Result<u64, String> {
    let part = dest.with_extension("part");
    let total = if spec.size > 0 { spec.size } else { spec.min_size };
    let urls = urls_of(spec);
    if urls.is_empty() { return Err("没有下载地址".into()); }
    let mut last = String::new();
    let mut ok = false;
    for (i, url) in urls.iter().enumerate() {
        let label = format!("下载中（源 {}/{}）", i + 1, urls.len());
        match curl_to_part(app, job, spec.id, url, &part, 0, 0, total, &label) {
            Ok(_) => { ok = true; last.clear(); break; }
            Err(e) if e == "__paused" || e == "__canceled" => return Err(e),
            Err(e) => last = e,
        }
    }
    if !ok && file_len(&part) == 0 { return Err(if last.is_empty() { "下载失败".into() } else { last }); }
    let n = file_len(&part);
    if n < spec.min_size { let _ = std::fs::remove_file(&part); return Err(format!("下载文件不完整：{n} bytes")); }
    if let Some(want) = spec.sha256 {
        let got = sha256_file(&part).ok_or("SHA-256 读取失败")?;
        if got != want { let _ = std::fs::remove_file(&part); return Err("SHA-256 校验失败（已丢弃，请重试）".into()); }
    }
    if dest.exists() { let _ = std::fs::remove_file(dest); }
    std::fs::rename(&part, dest).map_err(|e| e.to_string())?;
    finish_emit(app, spec.id, n);
    Ok(n)
}

fn download_zip(app: Option<&AppHandle>, job: &ModelJob, spec: &ModelSpec, dest: &Path) -> Result<u64, String> {
    let archive = models_dir().join(format!(".{}.zip", spec.id));
    let _ = std::fs::remove_file(&archive);
    let total = if spec.size > 0 { spec.size } else { spec.min_size };
    let urls = urls_of(spec);
    let mut last = String::new();
    for url in &urls {
        match curl_to_part(app, job, spec.id, url, &archive, 0, 0, total, "下载运行时包") {
            Ok(_) => { last.clear(); break; }
            Err(e) if e == "__paused" || e == "__canceled" => return Err(e),
            Err(e) => last = e,
        }
    }
    if !last.is_empty() { return Err(last); }
    verify_size_sha(&archive, spec.size, spec.sha256).inspect_err(|_e| { let _ = std::fs::remove_file(&archive); })?;
    if dest.exists() && !marker_ok(dest, spec.marker) { let _ = std::fs::remove_dir_all(dest); }
    safe_extract_zip(&archive, dest)?;
    if !marker_ok(dest, spec.marker) { let _ = std::fs::remove_file(&archive); return Err(format!("解压后缺标记文件：{}", spec.marker.unwrap_or(""))); }
    let _ = std::fs::remove_file(&archive);
    let size = dir_size(dest);
    finish_emit(app, spec.id, size);
    Ok(size)
}

fn download_parts(app: Option<&AppHandle>, job: &ModelJob, spec: &ModelSpec, dest: &Path) -> Result<u64, String> {
    let Dl::Parts(parts) = spec.dl else { return Err("not parts".into()); };
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    let base = dest.file_name().and_then(|s| s.to_str()).unwrap_or("model");
    let parts_dir = parent.join(format!(".{base}.parts"));
    let _ = std::fs::create_dir_all(&parts_dir);
    let total = spec.size;
    let mut base_received = 0u64;
    for (i, url) in parts.urls.iter().enumerate() {
        let expect = parts.sizes.get(i).copied().unwrap_or(0);
        let pp = parts_dir.join(format!("part{:02}", i + 1));
        let have = file_len(&pp);
        if have == expect && expect > 0 { base_received += have; continue; }
        if have > expect { let _ = std::fs::remove_file(&pp); }
        let label = format!("分卷 {}/{}", i + 1, parts.urls.len());
        match curl_to_part(app, job, spec.id, url, &pp, expect, base_received, total, &label) {
            Ok(n) => {
                if n != expect { let _ = std::fs::remove_file(&pp); return Err(format!("分卷{}大小不符：{}/{}", i + 1, n, expect)); }
                base_received += n;
            }
            Err(e) if e == "__paused" || e == "__canceled" => return Err(e),
            Err(e) => return Err(e),
        }
    }
    // 合并到 .zip 临时文件，再校验/解包
    let merged = parent.join(format!(".{base}.zip"));
    let _ = std::fs::remove_file(&merged);
    {
        let mut out = std::fs::File::create(&merged).map_err(|e| e.to_string())?;
        for i in 0..parts.urls.len() {
            let pp = parts_dir.join(format!("part{:02}", i + 1));
            let mut f = std::fs::File::open(&pp).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, &mut out).map_err(|e| e.to_string())?;
        }
    }
    verify_size_sha(&merged, spec.size, spec.sha256).inspect_err(|_e| { let _ = std::fs::remove_file(&merged); })?;
    if dest.exists() && !marker_ok(dest, spec.marker) { let _ = std::fs::remove_dir_all(dest); }
    safe_extract_zip(&merged, dest)?;
    if !marker_ok(dest, spec.marker) { return Err("解压后缺标记文件".into()); }
    let _ = std::fs::remove_file(&merged);
    let _ = std::fs::remove_dir_all(&parts_dir);
    let size = dir_size(dest);
    finish_emit(app, spec.id, size);
    Ok(size)
}

fn hf_hosts(channel: Option<&str>) -> Vec<&'static str> {
    if channel == Some("hf-mirror") { vec!["https://hf-mirror.com", "https://huggingface.co"] }
    else { vec!["https://huggingface.co", "https://hf-mirror.com"] }
}

fn curl_text(url: &str) -> Result<String, String> {
    let out = Command::new("curl.exe").creation_flags(0x08000000)
        .args(["-L", "--fail", "--silent", "--show-error", "--connect-timeout", "20", "--max-time", "60", url])
        .output().map_err(|e| e.to_string())?;
    if !out.status.success() { return Err(format!("HTTP 请求失败：{}", String::from_utf8_lossy(&out.stderr).chars().take(200).collect::<String>())); }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn download_hf(app: Option<&AppHandle>, job: &ModelJob, spec: &ModelSpec, channel: Option<&str>) -> Result<u64, String> {
    let Dl::Hf { repo } = spec.dl else { return Err("not hf".into()); };
    let hosts = hf_hosts(channel);
    let mut tree: Option<Vec<Value>> = None;
    let mut last = String::new();
    for h in &hosts {
        match curl_text(&format!("{h}/api/models/{repo}/tree/main?recursive=true")) {
            Ok(body) => match serde_json::from_str::<Vec<Value>>(&body) { Ok(v) => { tree = Some(v); break; } Err(e) => last = e.to_string() },
            Err(e) => last = e,
        }
    }
    let tree = tree.ok_or_else(|| format!("HF 文件清单获取失败：{last}"))?;
    let files: Vec<(String, u64)> = tree.iter().filter_map(|f| {
        if f.get("type").and_then(|v| v.as_str()) != Some("file") { return None; }
        let rel = f.get("path").and_then(|v| v.as_str())?;
        if rel.rsplit('/').next().map(|n| n.starts_with('.')).unwrap_or(false) { return None; }
        Some((rel.to_string(), f.get("size").and_then(|v| v.as_u64()).unwrap_or(0)))
    }).collect();
    if files.is_empty() { return Err("HF 仓库文件列表为空".into()); }
    let total: u64 = files.iter().map(|(_, s)| *s).sum();
    let dest_dir = models_dir().join(spec.dest);
    let _ = std::fs::create_dir_all(&dest_dir);
    let mut received = 0u64;
    for (rel, sz) in &files {
        let target = dest_dir.join(rel);
        if file_len(&target) == *sz && *sz > 0 { received += *sz; continue; }
        let part = target.with_extension("part");
        if let Some(parent) = target.parent() { let _ = std::fs::create_dir_all(parent); }
        let enc: Vec<String> = rel.split('/').map(urlencode).collect();
        let mut urls: Vec<String> = Vec::new();
        for h in &hosts { urls.push(format!("{h}/{repo}/resolve/main/{}", enc.join("/"))); }
        let mut ok = false;
        let mut err = String::new();
        for u in &urls {
            match curl_to_part(app, job, spec.id, u, &part, *sz, received, total, rel) {
                Ok(_) => { ok = true; break; }
                Err(e) if e == "__paused" || e == "__canceled" => return Err(e),
                Err(e) => err = e,
            }
        }
        if !ok { return Err(format!("{rel} 下载失败：{err}")); }
        let n = file_len(&part);
        if n != *sz { return Err(format!("{rel} 大小不符：{n}/{sz}")); }
        let _ = std::fs::remove_file(&target);
        std::fs::rename(&part, &target).map_err(|e| e.to_string())?;
        received += n;
        emit_progress(app, spec.id, received, total, false, rel, 0, Value::Null);
    }
    let size = dir_size(&dest_dir);
    if size < spec.min_size { return Err(format!("下载文件不完整：{size} bytes")); }
    finish_emit(app, spec.id, size);
    Ok(size)
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') { out.push(b as char); }
        else { out.push_str(&format!("%{b:02X}")); }
    }
    out
}

fn run_msst_python(app: Option<&AppHandle>, job: &ModelJob, id: &str) -> Value {
    let Some(py) = python_path() else { return oto_err("Python 运行时不存在，无法下载分卷模型"); };
    let Some(eng) = engine_dir() else { return oto_err("引擎目录不存在"); };
    let script = eng.join("msst_fetch.py");
    if !script.is_file() { return oto_err("engine/msst_fetch.py 不存在"); }
    let safe: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    let ctl = data_dir().join("temp").join("model-ctl").join(&safe);
    let _ = std::fs::create_dir_all(&ctl);
    let _ = std::fs::remove_file(ctl.join("pause"));
    let _ = std::fs::remove_file(ctl.join("cancel"));
    job.set_control(ctl.clone());
    let mut cmd = Command::new(&py);
    cmd.current_dir(&eng).arg(&script).args(["--id", id, "--root"]).arg(data_dir())
        .args(["--cancel-file"]).arg(ctl.join("cancel"))
        .args(["--pause-file"]).arg(ctl.join("pause"))
        .stdout(Stdio::piped()).stderr(Stdio::null());
    apply_engine_env(&mut cmd);
    let mut child = match cmd.spawn() { Ok(c) => c, Err(e) => return oto_err(e.to_string()) };
    let stdout = child.stdout.take();
    job.set_child(child);
    let mut final_v: Option<Value> = None;
    if let Some(out) = stdout {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            let t = line.trim();
            if t.is_empty() { continue; }
            let Ok(v) = serde_json::from_str::<Value>(t) else { continue; };
            if v.get("event").and_then(|x| x.as_str()) == Some("progress") {
                let received = v.get("received").and_then(|x| x.as_u64()).unwrap_or(0);
                let total = v.get("total").and_then(|x| x.as_u64()).unwrap_or(0);
                let text = v.get("text").and_then(|x| x.as_str()).unwrap_or("");
                let speed = v.get("speed").and_then(|x| x.as_u64()).unwrap_or(0);
                emit_progress(app, id, received, total, false, text, speed, Value::Null);
            } else { final_v = Some(v); }
        }
    }
    job.wait();
    let _ = std::fs::remove_dir_all(&ctl);
    let (canceled, paused) = job.stop_flags();
    if canceled || paused {
        return json!({ "ok": false, "id": id, "error": if paused { "已暂停（断点已保留，继续时会接着下）" } else { "已取消" }, "paused": paused, "canceled": canceled });
    }
    match final_v {
        Some(v) => {
            if v.get("ok").and_then(|x| x.as_bool()) == Some(true) {
                let size = v.get("size").and_then(|x| x.as_u64()).unwrap_or(0);
                finish_emit(app, id, size);
            }
            v
        }
        None => oto_err("下载器没有返回结果"),
    }
}

/// 确保分离权重有一份可用的 yaml：模型目录 → _configs/autocfg → 内置 index → Python 自愈脚本。
pub fn heal_config_for_weight(models_root: &Path, weight: &Path, arch: &str) -> Option<Value> {
    let dir = weight.parent()?;
    let has_yaml = std::fs::read_dir(dir).ok().into_iter().flatten().flatten().any(|e| {
        e.path().extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case("yaml") || x.eq_ignore_ascii_case("yml")).unwrap_or(false)
    });
    if has_yaml { return Some(json!({ "ok": true, "config": dir.display().to_string(), "from": "model-dir" })); }
    let name = weight.file_name()?.to_str()?;
    let engine = engine_dir()?;
    let data_root = if models_root.file_name().and_then(|x| x.to_str()) == Some("models") {
        models_root.parent().unwrap_or(models_root)
    } else { models_root };
    // 1) Python 脚本（覆盖 _configs 匹配 / 内置 / 上游 / autoconfig）
    let script = engine.join("msst_config_heal.py");
    if script.is_file() {
        if let Some(py) = python_path() {
            let out = Command::new(&py).creation_flags(0x08000000)
                .current_dir(&engine).arg(&script)
                .args(["--root"]).arg(data_root)
                .args(["--model"]).arg(weight)
                .args(["--arch", arch])
                .output().ok()?;
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(v) = s.lines().rev().find_map(|l| serde_json::from_str::<Value>(l.trim()).ok()) { return Some(v); }
        }
    }
    // 2) 退化为内置配置复制
    let idx = std::fs::read_to_string(engine.join("msst_configs/index.json")).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok())?;
    let entry = idx.get(name)?;
    let cfg = entry.get("config").and_then(|v| v.as_str())?;
    let src = engine.join("msst_configs").join(cfg);
    if !src.is_file() { return None; }
    let dst = models_root.join("_configs").join(cfg);
    std::fs::create_dir_all(dst.parent()?).ok()?;
    std::fs::copy(&src, &dst).ok()?;
    Some(json!({ "ok": true, "config": dst.display().to_string(), "from": "bundled" }))
}

fn heal_sep_config_for(models_root: &Path, id: &str) -> Option<Value> {
    let rel = artifact_rel(id)?;
    let dir = models_root.join(&rel);
    let weight = find_weight_file(&dir)?;
    let arch = arch_from_name(&weight.to_string_lossy());
    heal_config_for_weight(models_root, &weight, &arch)
}

fn find_weight_file(dir: &Path) -> Option<PathBuf> {
    fn walk(d: &Path, depth: u32, best: &mut Option<(u64, PathBuf)>) {
        if depth > 3 { return; }
        let Ok(rd) = std::fs::read_dir(d) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() { walk(&p, depth + 1, best); continue; }
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
            if matches!(ext.as_str(), "safetensors" | "pth" | "pt" | "ckpt" | "th") {
                let sz = file_len(&p);
                if best.as_ref().map(|(b, _)| sz > *b).unwrap_or(true) { *best = Some((sz, p)); }
            }
        }
    }
    let mut best = None;
    walk(dir, 0, &mut best);
    best.map(|(_, p)| p)
}

fn arch_from_name(name: &str) -> String {
    let n = name.to_ascii_lowercase();
    if n.contains("htdemucs") || n.contains("demucs") { "HTDemucs".into() }
    else if n.contains("bs_roformer") || n.contains("bs-roformer") { "BS-Roformer".into() }
    else if n.contains("roformer") { "Mel-Band Roformer".into() }
    else if n.contains("mdx") { "MDX23C".into() }
    else if n.contains("scnet") { "SCNet".into() }
    else if n.ends_with(".pth") || n.ends_with(".pt") || n.ends_with(".th") || n.contains("uvr") { "UVR-VR".into() }
    else { String::new() }
}

fn run_one(app: Option<&AppHandle>, job: &ModelJob, spec: &ModelSpec, channel: Option<&str>) -> Value {
    let id = spec.id;
    if matches!(spec.dl, Dl::Gsplit { .. }) {
        let mut v = run_msst_python(app, job, id);
        if v.get("ok").and_then(|x| x.as_bool()) == Some(true) {
            if let Some(cfg) = heal_sep_config_for(&models_dir(), id) { v["config"] = cfg; }
        }
        return v;
    }
    let dest = models_dir().join(spec.dest);
    if let Some(parent) = dest.parent() { let _ = std::fs::create_dir_all(parent); }
    let r = match spec.dl {
        Dl::File { .. } => download_file(app, job, spec, &dest),
        Dl::Zip { .. } => download_zip(app, job, spec, &dest),
        Dl::Parts(_) => download_parts(app, job, spec, &dest),
        Dl::Hf { .. } => download_hf(app, job, spec, channel),
        Dl::Gsplit { .. } => unreachable!(),
    };
    match r {
        Ok(size) => {
            let cfg = heal_sep_config_for(&models_dir(), id);
            let mut v = json!({ "ok": true, "id": id, "path": dest.display().to_string(), "size": size });
            if let Some(c) = cfg { v["config"] = c; }
            v
        }
        Err(e) if e == "__paused" => json!({ "ok": false, "id": id, "error": "已暂停（断点已保留，继续时会接着下）", "paused": true }),
        Err(e) if e == "__canceled" => json!({ "ok": false, "id": id, "error": "已取消", "canceled": true }),
        Err(e) => oto_err(e),
    }
}

/// 无窗口下载入口：供 --model-fetch CLI 与回归矩阵使用（进度写 stderr）。
pub fn download_headless(id: &str, channel: Option<&str>) -> Value {
    let job = ModelJob::new();
    if id.starts_with("msst:") || matches!(id, "muscriptor_small" | "muscriptor_medium" | "muscriptor_large") {
        let mut v = run_msst_python(None, &job, id);
        if v.get("ok").and_then(|x| x.as_bool()) == Some(true) {
            if let Some(cfg) = heal_sep_config_for(&models_dir(), id) { v["config"] = cfg; }
        }
        v
    } else if let Some(spec) = spec_of(id) {
        run_one(None, &job, spec, channel)
    } else {
        oto_err(format!("未知模型：{id}"))
    }
}

pub async fn download(app: AppHandle, state: ModelDlStateArc, req: Value) -> Value {
    let id = req.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if id.is_empty() { return oto_err("missing id"); }
    let spec = spec_of(&id);
    let is_msst = id.starts_with("msst:");
    let is_muscriptor = matches!(id.as_str(), "muscriptor_small" | "muscriptor_medium" | "muscriptor_large");
    if spec.is_none() && !is_msst && !is_muscriptor { return oto_err(format!("未知模型：{id}")); }
    // 已存在就直接返回
    if let Some(s) = spec {
        let dest = models_dir().join(s.dest);
        if let Some(marker) = s.marker {
            if marker_ok(&dest, Some(marker)) { return json!({ "ok": true, "id": id, "existed": true, "path": dest.display().to_string() }); }
        } else if matches!(s.dl, Dl::File { .. }) {
            let n = file_len(&dest);
            if n >= s.min_size && n > 0 { return json!({ "ok": true, "id": id, "existed": true, "path": dest.display().to_string(), "size": n }); }
        }
    }
    let job = match state.begin(&id) { Ok(j) => j, Err(e) => return oto_err(e) };
    let st = state.clone();
    let app2 = app.clone();
    let channel = req.get("channel").and_then(|v| v.as_str()).map(|s| s.to_string());
    let result = tauri::async_runtime::spawn_blocking(move || {
        let app = &app2;
        let res = if is_msst || is_muscriptor {
            let mut v = run_msst_python(Some(app), &job, &id);
            if v.get("ok").and_then(|x| x.as_bool()) == Some(true) {
                if let Some(cfg) = heal_sep_config_for(&models_dir(), &id) { v["config"] = cfg; }
            }
            v
        } else {
            run_one(Some(app), &job, spec.expect("checked"), channel.as_deref())
        };
        st.end(&id);
        let (canceled, paused) = job.stop_flags();
        let failed = res.get("ok").and_then(|v| v.as_bool()) != Some(true);
        if failed {
            emit_progress(Some(app), &id, 0, 0, false, res.get("error").and_then(|v| v.as_str()).unwrap_or("下载失败"), 0, json!({ "error": res.get("error"), "canceled": canceled, "paused": paused, "active": false }));
        }
        res
    }).await;
    match result {
        Ok(v) => v,
        Err(e) => oto_err(e.to_string()),
    }
}

// 便于 main.rs 只依赖一个类型别名
pub type ModelDlStateArc = ModelDlState;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_match_electron_registry_min_sizes() {
        let want = [
            ("piano_transcription", 160_000_000u64),
            ("hft_transformer", 18_000_000),
            ("miros", 5_000_000_000),
            ("yourmt3", 300_000_000),
            ("muscriptor_small", 50_000_000),
            ("muscriptor_medium", 200_000_000),
            ("muscriptor_large", 900_000_000),
            ("beat_this", 70_000_000),
            ("audio_tagger", 19_000_000),
            ("aria_amt", 100_000_000),
            ("hnsep_240512", 50_000_000),
        ];
        assert_eq!(SPECS.len(), want.len());
        for (id, min) in want {
            let s = spec_of(id).unwrap_or_else(|| panic!("missing {id}"));
            assert_eq!(s.min_size, min, "{id} minSize");
        }
    }

    #[test]
    fn part_sizes_follow_25mib_layout() {
        assert_eq!(expected_part_size(411_888_600, 16, 1), CHUNK);
        assert_eq!(expected_part_size(411_888_600, 16, 16), 411_888_600 - 15 * CHUNK);
        assert!(parts_layout_ok(411_888_600, 16));
        assert!(!parts_layout_ok(0, 16));
        let total: u64 = MIROS_SIZES.iter().sum();
        assert_eq!(total, 5_364_504_192);
    }

    #[test]
    fn artifact_rel_handles_msst_and_rejects_traversal() {
        assert_eq!(artifact_rel("piano_transcription").unwrap(), "piano_transcription/note_F1=0.9677_pedal_F1=0.9186.pth");
        assert_eq!(artifact_rel("msst:multi:HTDemucs4").unwrap(), "multi/HTDemucs4");
        assert!(artifact_rel("msst:multi:../../evil").is_none());
        assert!(artifact_rel("nope").is_none());
    }
}
