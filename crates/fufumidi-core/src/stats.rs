//! SMF 统计：轨道数、音符数、BPM、音域、平均力度 / 时值。
//!
//! 与旧 CLI 的 batch-stats / midi-stats 完全同一套配对规则：note-on 起音，
//! note-off 或 velocity 为 0 的 note-on 收尾；没有配对上的事件忽略。

use crate::error::{Error, Result};
use crate::parse::parse_smf;
use crate::smf::{EventKind, SmfFile};

/// 默认 tempo：120 BPM。
const DEFAULT_TEMPO_US: u32 = 500_000;

/// 一个 SMF 的汇总统计。
#[derive(Debug, Clone, PartialEq)]
pub struct MidiStats {
    /// Format（0 / 1 / 2）。
    pub format: u16,
    /// 已解析的轨道数。
    pub tracks: usize,
    /// 成对音符数。
    pub notes: usize,
    /// 由最后一个 tempo 元事件换算的 BPM。
    pub bpm: f64,
    /// 最低音高。
    pub min_midi: i32,
    /// 最高音高。
    pub max_midi: i32,
    /// 平均力度。
    pub avg_vel: f64,
    /// 平均时值（tick）。
    pub avg_dur_ticks: f64,
}

#[derive(Debug, Clone, Copy)]
struct ActiveNote {
    channel: u8,
    note: u8,
    onset: u32,
    velocity: u8,
}

#[derive(Debug, Clone, Copy)]
struct NoteRecord {
    note: u8,
    velocity: u8,
    duration: u32,
}

/// 统计 SMF 字节。
pub fn analyze_smf(bytes: &[u8]) -> Result<MidiStats> {
    let smf = parse_smf(bytes)?;
    analyze_file(&smf)
}

/// 统计已经解析好的 SMF。
pub fn analyze_file(smf: &SmfFile) -> Result<MidiStats> {
    let mut tempo_us = DEFAULT_TEMPO_US;
    let mut notes: Vec<NoteRecord> = Vec::new();

    for track in &smf.tracks {
        let mut active: Vec<ActiveNote> = Vec::new();
        for event in &track.events {
            if let Some(value) = event.kind.tempo_us() {
                tempo_us = value;
            }
            match &event.kind {
                EventKind::NoteOff { channel, note, .. } => {
                    close_note(&mut active, &mut notes, *channel, *note, event.tick)
                }
                EventKind::NoteOn {
                    channel,
                    note,
                    velocity,
                } => {
                    if *velocity == 0 {
                        close_note(&mut active, &mut notes, *channel, *note, event.tick);
                    } else {
                        if let Some(index) = active
                            .iter()
                            .position(|item| item.channel == *channel && item.note == *note)
                        {
                            active.remove(index);
                        }
                        active.push(ActiveNote {
                            channel: *channel,
                            note: *note,
                            onset: event.tick,
                            velocity: *velocity,
                        });
                    }
                }
                _ => {}
            }
        }
    }

    if notes.is_empty() || smf.tracks.is_empty() {
        return Err(Error::NoNoteEvents);
    }

    let count = notes.len();
    let min_midi = notes
        .iter()
        .map(|item| i32::from(item.note))
        .min()
        .unwrap_or(0);
    let max_midi = notes
        .iter()
        .map(|item| i32::from(item.note))
        .max()
        .unwrap_or(0);
    let avg_vel = notes
        .iter()
        .map(|item| f64::from(item.velocity))
        .sum::<f64>()
        / count as f64;
    let avg_dur_ticks = notes
        .iter()
        .map(|item| f64::from(item.duration))
        .sum::<f64>()
        / count as f64;
    let bpm = 60_000_000.0 / f64::from(tempo_us);

    Ok(MidiStats {
        format: smf.format,
        tracks: smf.tracks.len(),
        notes: count,
        bpm,
        min_midi,
        max_midi,
        avg_vel,
        avg_dur_ticks,
    })
}

fn close_note(
    active: &mut Vec<ActiveNote>,
    notes: &mut Vec<NoteRecord>,
    channel: u8,
    note: u8,
    tick: u32,
) {
    if let Some(index) = active
        .iter()
        .position(|item| item.channel == channel && item.note == note)
    {
        let started = active.remove(index);
        notes.push(NoteRecord {
            note: started.note,
            velocity: started.velocity,
            duration: tick.saturating_sub(started.onset),
        });
    }
}
