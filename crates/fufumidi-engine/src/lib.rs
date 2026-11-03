#![forbid(unsafe_code)]

//! FuFumidi Rust sidecar 引擎（M1 骨架）。
//!
//! 两条入口共用同一套命令实现：
//! - 兼容旧 rust-core 的一次性 CLI（ping / version / midi-stats / batch-stats /
//!   hash-batch / quantize-batch / transpose-batch）；
//! - JSON 行 stdin 协议（--json-lines），为后续常驻 sidecar 打样：
//!   请求一行为一个 JSON 对象，响应一行以 ###RESULT 开头。

pub mod batch;
pub mod cli;
pub mod commands;
pub mod protocol;

/// 旧 CLI 的 service 字段。main/rust.js 的探测依赖它取版本，保持不变。
pub const SERVICE: &str = "fufumidi-core";

/// 新 sidecar 的引擎名（ready 命令 / 文档使用）。
pub const ENGINE: &str = "fufumidi-engine";

/// crate 版本（来自 Cargo.toml）。
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// JSON 行协议支持的命令。
pub const CAPABILITIES: &[&str] = &[
    "ping",
    "version",
    "ready",
    "midi-stats",
    "batch-stats",
    "hash-batch",
    "quantize-batch",
    "transpose-batch",
];
