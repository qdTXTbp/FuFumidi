//! 命令实现：每个命令返回一个 serde_json::Value。
//!
//! 字段名与旧 rust-core 保持一致，便于 main/library.js 与 main/rust.js 直接复用；
//! 只有 JSON 键顺序与浮点小数位是 serde_json 的规范形式。

use std::fs;

use fufumidi_core::{analyze_smf, Transform};
use serde_json::{json, Value};

use crate::batch;
use crate::{CAPABILITIES, ENGINE, SERVICE, VERSION};

/// 成功响应的 ping（service 字段保持旧值）。
pub fn ping() -> Value {
    json!({
        "ok": true,
        "service": SERVICE,
        "version": VERSION,
    })
}

/// 版本号。
pub fn version() -> Value {
    json!({
        "ok": true,
        "version": VERSION,
    })
}

/// sidecar 就绪握手：引擎名 + 能力清单。
pub fn ready() -> Value {
    json!({
        "ok": true,
        "service": ENGINE,
        "version": VERSION,
        "compatible_service": SERVICE,
        "capabilities": CAPABILITIES,
    })
}

/// CLI 用法。
pub fn help() -> Value {
    json!({
        "ok": true,
        "service": ENGINE,
        "version": VERSION,
        "commands": [
            "ping",
            "version",
            "midi-stats <file>",
            "batch-stats <dir>",
            "hash-batch <dir>",
            "quantize-batch <dir> <out-dir> [divisions=8]",
            "transpose-batch <dir> <out-dir> [semitones=12]",
            "--json-lines (sidecar stdin protocol)"
        ],
        "json_lines": {
            "aliases": ["--json-lines", "--stdin", "json-lines", "serve"],
            "request": r#"{"id":1,"cmd":"ping","args":[]}"#,
            "response_prefix": "###RESULT ",
            "exit": r#"{"cmd":"exit"}"#
        }
    })
}

/// 统一失败响应。
pub fn failure(message: &str) -> Value {
    json!({
        "ok": false,
        "error": message,
    })
}

/// 单文件统计（midi-stats）。
pub fn midi_stats(path: &str) -> Value {
    match fs::read(path) {
        Ok(bytes) => match analyze_smf(&bytes) {
            Ok(stats) => json!({
                "ok": true,
                "format": stats.format,
                "tracks": stats.tracks,
                "notes": stats.notes,
                "bpm": stats.bpm,
                "min_midi": stats.min_midi,
                "max_midi": stats.max_midi,
                "avg_vel": stats.avg_vel,
                "avg_dur_ticks": stats.avg_dur_ticks,
            }),
            Err(error) => failure(&error.to_string()),
        },
        Err(error) => failure(&error.to_string()),
    }
}

/// 目录批量统计（batch-stats）。读不出来的文件也必须出现在结果里。
pub fn batch_stats(directory: &str) -> Value {
    let files = batch::walk_files(directory, &["mid", "midi"]);
    let mut rows = Vec::with_capacity(files.len());
    for path in &files {
        match fs::read(path) {
            Ok(bytes) => match analyze_smf(&bytes) {
                Ok(stats) => rows.push(json!({
                    "file": path,
                    "format": stats.format,
                    "tracks": stats.tracks,
                    "notes": stats.notes,
                    "bpm": stats.bpm,
                    "min_midi": stats.min_midi,
                    "max_midi": stats.max_midi,
                    "avg_vel": stats.avg_vel,
                    "size": bytes.len(),
                })),
                Err(error) => rows.push(json!({
                    "file": path,
                    "ok": false,
                    "error": error.to_string(),
                    "size": bytes.len(),
                })),
            },
            Err(error) => rows.push(json!({
                "file": path,
                "ok": false,
                "error": error.to_string(),
                "size": 0,
            })),
        }
    }
    json!({
        "ok": true,
        "count": rows.len(),
        "files": rows,
    })
}

/// 目录批量 SHA-256（hash-batch），与 JS 侧 crypto.sha256 一致。
pub fn hash_batch(directory: &str) -> Value {
    let files = batch::walk_files(
        directory,
        &["mid", "midi", "sf2", "sf3", "wav", "mp3", "flac"],
    );
    let mut rows = Vec::with_capacity(files.len());
    for path in &files {
        match fs::read(path) {
            Ok(bytes) => rows.push(json!({
                "file": path,
                "hash": batch::sha256_hex(&bytes),
                "size": bytes.len(),
            })),
            Err(error) => rows.push(json!({
                "file": path,
                "ok": false,
                "error": error.to_string(),
                "size": 0,
            })),
        }
    }
    json!({
        "ok": true,
        "count": rows.len(),
        "files": rows,
    })
}

/// 目录批量量化（quantize-batch）。
///
/// argument 保留命令行原值用于回显；实际网格使用 max(1)，与旧 CLI 一致。
pub fn quantize_batch(input_dir: &str, output_dir: &str, divisions: i32) -> Value {
    let effective = divisions.max(1) as u32;
    batch::transform_batch(
        input_dir,
        output_dir,
        Transform::quantize(effective),
        "quantize",
        divisions,
    )
}

/// 目录批量移调（transpose-batch）。
pub fn transpose_batch(input_dir: &str, output_dir: &str, semitones: i32) -> Value {
    batch::transform_batch(
        input_dir,
        output_dir,
        Transform::transpose(semitones),
        "transpose",
        semitones,
    )
}
