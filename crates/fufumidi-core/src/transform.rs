//! 写回变换：量化与移调。
//!
//! 输入字节 -> parse -> 修改事件 -> encode，与旧 CLI 的 transform_smf 行为一致：
//! - 量化网格 = ticks_per_beat * 4 / divisions（divisions 至少 1）；
//! - 量化只移动 note-on 起点，note-off 保持相对时值；
//! - 移调同时作用于 note-on 与 note-off，音高钳制在 0-127；
//! - velocity 为 0 的 note-on 视为 note-off；
//! - 变换后每条轨道按 tick 稳定排序。

use crate::error::Result;
use crate::parse::parse_smf;
use crate::smf::{encode_smf, EventKind, SmfFile, SmfTrack};

/// 一次写回变换。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transform {
    /// 按 divisions 量化（4 分音符 = 4 * divisions 个网格）。
    Quantize {
        /// 4 分音符的细分数；0 按 1 处理。
        divisions: u32,
    },
    /// 按半音移调。
    Transpose {
        /// 半音数，可为负。
        semitones: i32,
    },
}

impl Transform {
    /// 量化变换。
    pub fn quantize(divisions: u32) -> Self {
        Self::Quantize { divisions }
    }

    /// 移调变换。
    pub fn transpose(semitones: i32) -> Self {
        Self::Transpose { semitones }
    }

    /// 量化网格（tick）。移调返回 0。
    pub fn grid_ticks(self, ticks_per_beat: u16) -> u32 {
        match self {
            Self::Quantize { divisions } => {
                let divisions = divisions.max(1);
                u32::from(ticks_per_beat).saturating_mul(4).max(1) / divisions
            }
            Self::Transpose { .. } => 0,
        }
    }
}

/// 把 tick 量化到最近的网格点（grid 为 0 时按 1 处理）。
pub fn quantize_tick(tick: u32, grid: u32) -> u32 {
    let grid = if grid == 0 { 1 } else { grid };
    let steps = (f64::from(tick) / f64::from(grid)).round();
    (steps as u32).wrapping_mul(grid)
}

/// 对字节执行变换并写回字节。
pub fn transform_smf(bytes: &[u8], transform: Transform) -> Result<Vec<u8>> {
    let mut smf = parse_smf(bytes)?;
    apply_transform(&mut smf, transform);
    Ok(encode_smf(&smf))
}

/// 量化。
pub fn quantize_smf(bytes: &[u8], divisions: u32) -> Result<Vec<u8>> {
    transform_smf(bytes, Transform::quantize(divisions))
}

/// 移调。
pub fn transpose_smf(bytes: &[u8], semitones: i32) -> Result<Vec<u8>> {
    transform_smf(bytes, Transform::transpose(semitones))
}

/// 就地修改一个 SmfFile。
pub fn apply_transform(smf: &mut SmfFile, transform: Transform) {
    let grid = transform.grid_ticks(smf.ticks_per_beat);
    for track in &mut smf.tracks {
        apply_track(track, transform, grid);
    }
}

fn apply_track(track: &mut SmfTrack, transform: Transform, grid: u32) {
    let mut active: Vec<(u8, u8, u32, u32)> = Vec::new();
    for event in &mut track.events {
        let (channel, note, is_note_on) = match &event.kind {
            EventKind::NoteOn {
                channel,
                note,
                velocity,
            } => (*channel, *note, *velocity > 0),
            EventKind::NoteOff { channel, note, .. } => (*channel, *note, false),
            _ => continue,
        };

        let note = match transform {
            Transform::Transpose { semitones } => {
                i32::from(note).saturating_add(semitones).clamp(0, 127) as u8
            }
            Transform::Quantize { .. } => note,
        };
        match &mut event.kind {
            EventKind::NoteOn { note: slot, .. } | EventKind::NoteOff { note: slot, .. } => {
                *slot = note;
            }
            _ => {}
        }

        if is_note_on {
            let original_start = event.tick;
            let quantized_start = match transform {
                Transform::Quantize { .. } => quantize_tick(original_start, grid),
                Transform::Transpose { .. } => original_start,
            };
            event.tick = quantized_start;
            active.push((channel, note, original_start, quantized_start));
        } else if let Some(index) = active
            .iter()
            .position(|item| item.0 == channel && item.1 == note)
        {
            let (_, _, original_start, quantized_start) = active.remove(index);
            if matches!(transform, Transform::Quantize { .. }) {
                event.tick =
                    quantized_start.saturating_add(event.tick.saturating_sub(original_start));
            }
        }
    }
    track.events.sort_by_key(|event| event.tick);
}
