//! 测试用的最小 SMF 字节构造器。
//!
//! 刻意不复用 crate 的编码器：测试要能独立验证解析/编码，而不是自证。

#![allow(dead_code)]

/// VLQ 编码（测试侧实现）。
pub fn vlq(mut value: u32) -> Vec<u8> {
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
    buffer[index..].to_vec()
}

/// 用 (绝对 tick, 事件字节) 列表生成一条轨道数据。
pub fn track(events: &[(u32, Vec<u8>)]) -> Vec<u8> {
    let mut data = Vec::new();
    let mut previous = 0u32;
    for (tick, bytes) in events {
        data.extend_from_slice(&vlq(tick.saturating_sub(previous)));
        data.extend_from_slice(bytes);
        previous = *tick;
    }
    data
}

/// 生成完整的 SMF 字节。
pub fn smf(format: u16, ticks_per_beat: u16, tracks: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"MThd");
    out.extend_from_slice(&6u32.to_be_bytes());
    out.extend_from_slice(&format.to_be_bytes());
    out.extend_from_slice(&(tracks.len() as u16).to_be_bytes());
    out.extend_from_slice(&ticks_per_beat.to_be_bytes());
    for data in tracks {
        out.extend_from_slice(b"MTrk");
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(data);
    }
    out
}

/// note on 事件字节。
pub fn note_on(channel: u8, note: u8, velocity: u8) -> Vec<u8> {
    vec![0x90 | (channel & 0x0f), note, velocity]
}

/// note off 事件字节。
pub fn note_off(channel: u8, note: u8, velocity: u8) -> Vec<u8> {
    vec![0x80 | (channel & 0x0f), note, velocity]
}

/// running status 下的 note on：只给数据字节。
pub fn running_note_on(note: u8, velocity: u8) -> Vec<u8> {
    vec![note, velocity]
}

/// 控制器事件字节。
pub fn control_change(channel: u8, controller: u8, value: u8) -> Vec<u8> {
    vec![0xb0 | (channel & 0x0f), controller, value]
}

/// 音色切换事件字节（1 个数据字节）。
pub fn program_change(channel: u8, program: u8) -> Vec<u8> {
    vec![0xc0 | (channel & 0x0f), program]
}

/// 弯音事件字节（2 个数据字节）。
pub fn pitch_bend(channel: u8, value: u16) -> Vec<u8> {
    vec![
        0xe0 | (channel & 0x0f),
        (value & 0x7f) as u8,
        ((value >> 7) & 0x7f) as u8,
    ]
}

/// 元事件字节。
pub fn meta(meta_type: u8, data: &[u8]) -> Vec<u8> {
    let mut out = vec![0xff, meta_type];
    out.extend_from_slice(&vlq(data.len() as u32));
    out.extend_from_slice(data);
    out
}

/// tempo 元事件字节。
pub fn tempo(tempo_us: u32) -> Vec<u8> {
    meta(
        0x51,
        &[
            (tempo_us >> 16) as u8,
            (tempo_us >> 8) as u8,
            tempo_us as u8,
        ],
    )
}

/// End of Track。
pub fn end_of_track() -> Vec<u8> {
    meta(0x2f, &[])
}

/// SysEx 事件字节。
pub fn sysex(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0xf0];
    out.extend_from_slice(&vlq(data.len() as u32));
    out.extend_from_slice(data);
    out
}
