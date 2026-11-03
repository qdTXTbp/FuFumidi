//! 领域错误类型。
//!
//! 旧 CLI 把错误压成字符串；库里保留可匹配的枚举，命令层再转回字符串，
//! 这样测试可以断言具体失败原因，而不是匹配文案。

use std::fmt;

/// SMF 解析 / 变换错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// 不是 Standard MIDI File（缺少 MThd 或整体过短）。
    NotMidi,
    /// MThd 声明长度小于 6。
    HeaderTooShort,
    /// 不支持 SMPTE 时间基准（division 最高位为 1）。
    SmpteUnsupported,
    /// division 为 0。
    InvalidDivision,
    /// 文件里没有任何 MTrk。
    NoTracks,
    /// running status 出现在首次状态字节之前。
    RunningStatusWithoutStatus,
    /// 非通道事件的状态字节。
    UnexpectedStatus(u8),
    /// 数据在事件中途结束。
    Truncated(&'static str),
    /// 可变长整数非法（超过 5 字节或溢出 u32）。
    InvalidVlq,
    /// 统计时找不到任何成对音符。
    NoNoteEvents,
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotMidi => formatter.write_str("not a MIDI file"),
            Self::HeaderTooShort => formatter.write_str("MThd too short"),
            Self::SmpteUnsupported => formatter.write_str("SMPTE MIDI files not supported"),
            Self::InvalidDivision => formatter.write_str("invalid division"),
            Self::NoTracks => formatter.write_str("no tracks found"),
            Self::RunningStatusWithoutStatus => {
                formatter.write_str("running status without prior status")
            }
            Self::UnexpectedStatus(status) => write!(formatter, "unexpected status 0x{status:02x}"),
            Self::Truncated(what) => write!(formatter, "truncated MIDI data ({what})"),
            Self::InvalidVlq => formatter.write_str("invalid variable-length quantity"),
            Self::NoNoteEvents => formatter.write_str("no note events found"),
        }
    }
}

impl std::error::Error for Error {}

/// 本 crate 的 Result 别名。
pub type Result<T> = std::result::Result<T, Error>;
