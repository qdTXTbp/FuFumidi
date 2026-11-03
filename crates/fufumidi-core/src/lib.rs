#![forbid(unsafe_code)]

//! FuFumidi SMF/MIDI 领域核心。
//!
//! 本 crate 把旧 rust-core/src/main.rs 里的 SMF 解析逻辑结构化后搬进库：
//! 数据模型（SmfFile / SmfTrack / Event / EventKind）、解析（parse_smf /
//! read_vlq）、编码（encode_smf / write_vlq）、统计（analyze_smf）与写回
//! 变换（quantize_smf / transpose_smf）共用同一套事件流。
//!
//! 设计约束：
//! - 纯函数 + 纯数据，不碰文件系统，也不依赖第三方 crate；
//! - running status 只在解析阶段展开，写出时一律补全状态字节；
//! - 量化 / 移调以字节进、字节出，命令层行为与旧 CLI 保持一致。

pub mod error;
pub mod parse;
pub mod smf;
pub mod stats;
pub mod transform;
pub mod vlq;

pub use error::{Error, Result};
pub use parse::parse_smf;
pub use smf::{encode_smf, Event, EventKind, SmfFile, SmfTrack, SysExKind};
pub use stats::{analyze_file, analyze_smf, MidiStats};
pub use transform::{
    apply_transform, quantize_smf, quantize_tick, transform_smf, transpose_smf, Transform,
};
pub use vlq::{read_vlq, write_vlq};

/// 本 crate 的版本号（来自 Cargo.toml）。
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
