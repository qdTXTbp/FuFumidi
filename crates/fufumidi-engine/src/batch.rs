//! 目录遍历与批量写回。

use std::fs;
use std::path::{Path, PathBuf};

use fufumidi_core::{transform_smf, Transform};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// 递归收集指定扩展名的文件，按小写路径排序（与旧 CLI 一致）。
pub fn walk_files(directory: &str, extensions: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![PathBuf::from(directory)];
    while let Some(current) = stack.pop() {
        let entries = match fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
                if extensions
                    .iter()
                    .any(|candidate| (*candidate).eq_ignore_ascii_case(extension))
                {
                    out.push(path.to_string_lossy().into_owned());
                }
            }
        }
    }
    out.sort_by_key(|left| left.to_lowercase());
    out
}

/// 字节 -> 小写 hex。
pub fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[usize::from(byte >> 4)] as char);
        out.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    out
}

/// 字节 -> SHA-256 小写 hex。
pub fn sha256_hex(bytes: &[u8]) -> String {
    to_hex(&Sha256::digest(bytes))
}

/// 对目录内所有 .mid/.midi 执行变换，写到 output_dir（同名覆盖）。
pub fn transform_batch(
    input_dir: &str,
    output_dir: &str,
    transform: Transform,
    mode: &str,
    argument: i32,
) -> Value {
    if let Err(error) = fs::create_dir_all(output_dir) {
        return json!({
            "ok": false,
            "error": error.to_string(),
        });
    }

    let files = walk_files(input_dir, &["mid", "midi"]);
    let mut rows = Vec::with_capacity(files.len());
    for path in &files {
        let file_name = Path::new(path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("out.mid");
        let output_path = Path::new(output_dir).join(file_name);
        let row = match fs::read(path) {
            Ok(bytes) => match transform_smf(&bytes, transform) {
                Ok(transformed) => match fs::write(&output_path, transformed) {
                    Ok(()) => json!({
                        "file": path,
                        "out": output_path.to_string_lossy(),
                        "ok": true,
                    }),
                    Err(error) => json!({
                        "file": path,
                        "ok": false,
                        "error": error.to_string(),
                    }),
                },
                Err(error) => json!({
                    "file": path,
                    "ok": false,
                    "error": error.to_string(),
                }),
            },
            Err(error) => json!({
                "file": path,
                "ok": false,
                "error": error.to_string(),
            }),
        };
        rows.push(row);
    }

    json!({
        "ok": true,
        "mode": mode,
        "arg": argument,
        "count": rows.len(),
        "files": rows,
    })
}
