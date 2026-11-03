//! SMF 解析。行为对齐旧 rust-core：支持 running status、format 0/1/2、
//! 多轨与 tempo 元事件；遇到不支持的 SMPTE 时间基准直接报错。

use crate::error::{Error, Result};
use crate::smf::{Event, EventKind, SmfFile, SmfTrack, SysExKind};
use crate::vlq::read_vlq;

/// 解析一个 Standard MIDI File。
///
/// 与旧实现一致的地方：
/// - 头部长度大于 6 时按声明长度跳过扩展字节；
/// - 声明轨道数多于实际 MTrk 时，返回已经解析到的轨道；
/// - running status 只在通道事件之间沿用，元事件 / SysEx 不打断它；
/// - 音高与力度按文件原样保存（写出时统一截断到 7 位）。
///
/// 比旧实现更严格的地方（只影响损坏文件）：事件数据不足时返回
/// [Error::Truncated]，而不是继续读下一条轨道。
pub fn parse_smf(bytes: &[u8]) -> Result<SmfFile> {
    if bytes.len() < 14 || &bytes[0..4] != b"MThd" {
        return Err(Error::NotMidi);
    }
    let header_len = u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
    if header_len < 6 {
        return Err(Error::HeaderTooShort);
    }
    let format = u16::from_be_bytes([bytes[8], bytes[9]]);
    let track_count = u16::from_be_bytes([bytes[10], bytes[11]]) as usize;
    let division = u16::from_be_bytes([bytes[12], bytes[13]]);
    if division & 0x8000 != 0 {
        return Err(Error::SmpteUnsupported);
    }
    let ticks_per_beat = division & 0x7fff;
    if ticks_per_beat == 0 {
        return Err(Error::InvalidDivision);
    }

    let mut position = 14usize.saturating_add(header_len.saturating_sub(6));
    let mut tracks = Vec::with_capacity(track_count.min(1024));
    for _ in 0..track_count {
        if position.saturating_add(8) > bytes.len() {
            break;
        }
        if &bytes[position..position + 4] != b"MTrk" {
            break;
        }
        let track_len = u32::from_be_bytes([
            bytes[position + 4],
            bytes[position + 5],
            bytes[position + 6],
            bytes[position + 7],
        ]) as usize;
        let track_start = position + 8;
        let track_end = track_start.saturating_add(track_len).min(bytes.len());
        tracks.push(parse_track(bytes, track_start, track_end)?);
        position = track_end;
    }

    if tracks.is_empty() {
        return Err(Error::NoTracks);
    }
    Ok(SmfFile {
        format,
        ticks_per_beat,
        tracks,
    })
}

fn parse_track(bytes: &[u8], start: usize, end: usize) -> Result<SmfTrack> {
    let mut position = start;
    let mut tick = 0u32;
    let mut last_status: Option<u8> = None;
    let mut events = Vec::new();

    while position < end {
        let delta = read_vlq(&bytes[..end], &mut position)?;
        tick = tick.saturating_add(delta);
        if position >= end {
            break;
        }
        let first = bytes[position];

        if first & 0x80 == 0 {
            // running status：沿用上一条通道事件的状态字节
            let status = last_status.ok_or(Error::RunningStatusWithoutStatus)?;
            let kind = status & 0xf0;
            if !(0x80..=0xe0).contains(&kind) {
                return Err(Error::UnexpectedStatus(status));
            }
            let data_len = if kind == 0xc0 || kind == 0xd0 { 1 } else { 2 };
            let mut data = [0u8; 2];
            data[0] = first;
            position += 1;
            for slot in data.iter_mut().take(data_len).skip(1) {
                if position >= end {
                    return Err(Error::Truncated("channel event"));
                }
                *slot = bytes[position];
                position += 1;
            }
            events.push(Event {
                tick,
                kind: decode_channel(kind, status & 0x0f, &data[..data_len]),
            });
            last_status = Some(status);
            continue;
        }

        let status = first;
        position += 1;
        if status == 0xff {
            if position >= end {
                return Err(Error::Truncated("meta type"));
            }
            let meta_type = bytes[position];
            position += 1;
            let declared_len = read_vlq(&bytes[..end], &mut position)? as usize;
            let data_end = position.saturating_add(declared_len).min(end);
            let data = bytes[position..data_end].to_vec();
            position = data_end;
            events.push(Event {
                tick,
                kind: EventKind::Meta { meta_type, data },
            });
            continue;
        }
        if status == 0xf0 || status == 0xf7 {
            let declared_len = read_vlq(&bytes[..end], &mut position)? as usize;
            let data_end = position.saturating_add(declared_len).min(end);
            let data = bytes[position..data_end].to_vec();
            position = data_end;
            let kind = if status == 0xf0 {
                SysExKind::Start
            } else {
                SysExKind::Escape
            };
            events.push(Event {
                tick,
                kind: EventKind::SysEx { kind, data },
            });
            continue;
        }

        let kind = status & 0xf0;
        if !(0x80..=0xe0).contains(&kind) {
            return Err(Error::UnexpectedStatus(status));
        }
        let data_len = if kind == 0xc0 || kind == 0xd0 { 1 } else { 2 };
        let mut data = [0u8; 2];
        for slot in data.iter_mut().take(data_len) {
            if position >= end {
                return Err(Error::Truncated("channel event"));
            }
            *slot = bytes[position];
            position += 1;
        }
        events.push(Event {
            tick,
            kind: decode_channel(kind, status & 0x0f, &data[..data_len]),
        });
        last_status = Some(status);
    }

    Ok(SmfTrack { events })
}

fn decode_channel(kind: u8, channel: u8, data: &[u8]) -> EventKind {
    match kind {
        0x80 => EventKind::NoteOff {
            channel,
            note: data[0],
            velocity: data[1],
        },
        0x90 => EventKind::NoteOn {
            channel,
            note: data[0],
            velocity: data[1],
        },
        0xa0 => EventKind::PolyPressure {
            channel,
            note: data[0],
            pressure: data[1],
        },
        0xb0 => EventKind::ControlChange {
            channel,
            controller: data[0],
            value: data[1],
        },
        0xc0 => EventKind::ProgramChange {
            channel,
            program: data[0],
        },
        0xd0 => EventKind::ChannelPressure {
            channel,
            pressure: data[0],
        },
        0xe0 => EventKind::PitchBend {
            channel,
            value: u16::from(data[0]) | (u16::from(data[1]) << 7),
        },
        _ => unreachable!("channel status validated before decode"),
    }
}
