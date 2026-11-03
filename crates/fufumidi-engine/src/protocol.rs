//! JSON 行 sidecar 协议骨架。
//!
//! 输入：stdin 每行一个 JSON 对象，形如
//! {"id":1,"cmd":"midi-stats","args":["C:/x.mid"]}
//! 也接受旧 engine_server 风格的 {"id":1,"argv":["ping"]}。
//!
//! 输出：每行以 ###RESULT 开头，后接一个 JSON 对象；id 原样回填。
//! 空行忽略；exit / {"cmd":"exit"} 回一条结果后退出。

use std::io::{BufRead, Write};

use serde_json::{json, Value};

use crate::commands;

/// 一条协议响应。
#[derive(Debug, Clone, PartialEq)]
pub struct Response {
    /// 响应体（含 id）。
    pub value: Value,
    /// 处理完是否退出进程。
    pub exit: bool,
}

/// 把响应体格式化为一行 ###RESULT。
pub fn result_line(value: &Value) -> String {
    let body = serde_json::to_string(value)
        .unwrap_or_else(|_| r#"{"ok":false,"error":"json encode failed"}"#.to_string());
    format!("###RESULT {body}")
}

/// 处理一行输入。空行返回 None。
pub fn handle_line(line: &str) -> Option<Response> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let parsed: Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(error) => {
            return Some(error_response(
                Value::Null,
                &format!("invalid json: {error}"),
            ))
        }
    };
    let id = parsed.get("id").cloned().unwrap_or(Value::Null);
    let request = match parse_request(&parsed) {
        Ok(request) => request,
        Err(message) => return Some(error_response(id, &message)),
    };

    if request.cmd == "exit" {
        return Some(Response {
            value: with_id(id, json!({"ok": true, "exiting": true})),
            exit: true,
        });
    }

    let Request { cmd, args } = request;
    let positional = |index: usize| args.get(index).map(String::as_str).unwrap_or("");
    let mut value = match cmd.as_str() {
        "ping" => commands::ping(),
        "version" => commands::version(),
        "ready" => commands::ready(),
        "midi-stats" => commands::midi_stats(positional(0)),
        "batch-stats" => commands::batch_stats(positional(0)),
        "hash-batch" => commands::hash_batch(positional(0)),
        "quantize-batch" => {
            commands::quantize_batch(positional(0), positional(1), parse_i32(&args, 2, 8))
        }
        "transpose-batch" => {
            commands::transpose_batch(positional(0), positional(1), parse_i32(&args, 2, 12))
        }
        "help" | "--help" | "-h" => commands::help(),
        other => json!({
            "ok": false,
            "error": "unknown command",
            "cmd": other,
        }),
    };
    value = with_id(id, value);
    Some(Response { value, exit: false })
}

/// 从 reader 逐行读取请求、向 writer 写 ###RESULT，直到 EOF 或 exit。
pub fn run<R: BufRead, W: Write>(mut input: R, mut output: W) -> i32 {
    let mut line = String::new();
    loop {
        line.clear();
        match input.read_line(&mut line) {
            Ok(0) => return 0,
            Ok(_) => {}
            Err(_) => return 1,
        }
        let Some(response) = handle_line(&line) else {
            continue;
        };
        let encoded = result_line(&response.value);
        if writeln!(output, "{encoded}").is_err() {
            return 1;
        }
        if output.flush().is_err() {
            return 1;
        }
        if response.exit {
            return 0;
        }
    }
}

struct Request {
    cmd: String,
    args: Vec<String>,
}

fn parse_request(value: &Value) -> Result<Request, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "request must be a JSON object".to_string())?;

    if let Some(cmd) = object.get("cmd") {
        let cmd = cmd
            .as_str()
            .ok_or_else(|| "cmd must be a string".to_string())?
            .to_string();
        let args = match object.get("args") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items
                .iter()
                .map(arg_to_string)
                .collect::<Result<Vec<_>, _>>()?,
            Some(_) => return Err("args must be an array".to_string()),
        };
        return Ok(Request { cmd, args });
    }

    if let Some(argv) = object.get("argv") {
        let items = argv
            .as_array()
            .ok_or_else(|| "argv must be an array".to_string())?;
        let cmd = items
            .first()
            .and_then(Value::as_str)
            .ok_or_else(|| "argv must start with a command string".to_string())?
            .to_string();
        let args = items
            .iter()
            .skip(1)
            .map(arg_to_string)
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(Request { cmd, args });
    }

    Err("missing cmd".to_string())
}

fn arg_to_string(value: &Value) -> Result<String, String> {
    match value {
        Value::String(text) => Ok(text.clone()),
        Value::Number(number) => Ok(number.to_string()),
        Value::Bool(flag) => Ok(flag.to_string()),
        Value::Null => Ok(String::new()),
        _ => Err("args entries must be strings, numbers, booleans or null".to_string()),
    }
}

fn parse_i32(args: &[String], index: usize, fallback: i32) -> i32 {
    args.get(index)
        .and_then(|raw| raw.parse::<i32>().ok())
        .unwrap_or(fallback)
}

fn error_response(id: Value, message: &str) -> Response {
    Response {
        value: with_id(id, json!({"ok": false, "error": message})),
        exit: false,
    }
}

fn with_id(id: Value, mut value: Value) -> Value {
    if let Value::Object(map) = &mut value {
        map.insert("id".to_string(), id);
    }
    value
}
