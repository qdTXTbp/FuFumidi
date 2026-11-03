//! 兼容旧 rust-core 的一次性 CLI，以及 JSON 行 sidecar 入口。

use std::io::{self, Write};

use serde_json::Value;

use crate::{commands, protocol};

const JSON_LINES_MODES: &[&str] = &["--json-lines", "--stdin", "json-lines", "serve"];

/// 首个参数是否要求进入 JSON 行协议模式。
pub fn wants_json_lines(args: &[String]) -> bool {
    match args.first() {
        Some(first) => JSON_LINES_MODES.contains(&first.as_str()),
        None => false,
    }
}

/// 把 CLI 参数分派为一个 JSON 值（不写 stdout，便于测试）。
pub fn dispatch(args: &[String]) -> Value {
    let positional = |index: usize| args.get(index).map(String::as_str).unwrap_or("");
    let number = |index: usize, fallback: i32| {
        args.get(index)
            .and_then(|raw| raw.parse::<i32>().ok())
            .unwrap_or(fallback)
    };

    match args.first().map(String::as_str) {
        Some("ping") => commands::ping(),
        Some("version") => commands::version(),
        Some("midi-stats") => commands::midi_stats(positional(1)),
        Some("batch-stats") => commands::batch_stats(positional(1)),
        Some("hash-batch") => commands::hash_batch(positional(1)),
        Some("quantize-batch") => {
            commands::quantize_batch(positional(1), positional(2), number(3, 8))
        }
        Some("transpose-batch") => {
            commands::transpose_batch(positional(1), positional(2), number(3, 12))
        }
        Some("-h" | "--help" | "help") => commands::help(),
        Some("-V" | "--version") => commands::version(),
        _ => commands::failure("unknown command"),
    }
}

/// CLI 主入口：返回进程退出码。正常路径始终为 0（与旧 CLI 一致）。
pub fn run(args: &[String]) -> i32 {
    if wants_json_lines(args) {
        let stdin = io::stdin();
        let stdout = io::stdout();
        return protocol::run(stdin.lock(), stdout.lock());
    }

    let line = match serde_json::to_string(&dispatch(args)) {
        Ok(line) => line,
        Err(_) => r#"{"ok":false,"error":"json encode failed"}"#.to_string(),
    };
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    if writeln!(handle, "{line}").is_err() {
        return 1;
    }
    if handle.flush().is_err() {
        return 1;
    }
    0
}
