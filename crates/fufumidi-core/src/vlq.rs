//! SMF 可变长整数（VLQ）读写。

use crate::error::{Error, Result};

/// 读取一个 VLQ，并把游标推进到最后一个字节之后。
///
/// 规范里 delta time 的 VLQ 最多 4 字节；这里放宽到 5 字节以覆盖 u32 全范围
/// （u32::MAX 编码为 0x8F 0xFF 0xFF 0xFF 0x7F）。超过 5 字节或数值溢出报
/// [Error::InvalidVlq]。
pub fn read_vlq(data: &[u8], position: &mut usize) -> Result<u32> {
    let mut value: u32 = 0;
    let mut used = 0usize;
    loop {
        let byte = *data.get(*position).ok_or(Error::Truncated("vlq"))?;
        *position += 1;
        used += 1;
        value = value
            .checked_mul(128)
            .and_then(|current| current.checked_add(u32::from(byte & 0x7f)))
            .ok_or(Error::InvalidVlq)?;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
        if used >= 5 {
            return Err(Error::InvalidVlq);
        }
    }
}

/// 把一个 u32 写成 VLQ 并追加到 out。
pub fn write_vlq(out: &mut Vec<u8>, mut value: u32) {
    let mut buffer = [0u8; 5];
    let mut index = 4usize;
    buffer[index] = (value & 0x7f) as u8;
    loop {
        value >>= 7;
        if value == 0 {
            break;
        }
        index -= 1;
        buffer[index] = ((value & 0x7f) as u8) | 0x80;
    }
    out.extend_from_slice(&buffer[index..]);
}
