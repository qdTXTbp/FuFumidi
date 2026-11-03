//! SMF（Standard MIDI File）数据模型与编码。
//!
//! 事件保留原始 tick 与 7 位数据字节；running status 在解析时展开成完整状态，
//! 因此写出路径不需要、也不会再生成 running status。

use crate::vlq::write_vlq;

/// 一个 SMF 文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmfFile {
    /// 头部 Format（0 / 1 / 2）。
    pub format: u16,
    /// 每四分音符的 tick 数（division 的低 15 位）。
    pub ticks_per_beat: u16,
    /// 轨道列表。
    pub tracks: Vec<SmfTrack>,
}

impl SmfFile {
    /// 构造一个 SMF 文件。
    pub fn new(format: u16, ticks_per_beat: u16, tracks: Vec<SmfTrack>) -> Self {
        Self {
            format,
            ticks_per_beat,
            tracks,
        }
    }

    /// 编码为 SMF 字节。
    pub fn to_bytes(&self) -> Vec<u8> {
        encode_smf(self)
    }

    /// note-on + note-off 的事件总数（含 velocity 为 0 的 note-on）。
    pub fn note_event_count(&self) -> usize {
        self.tracks
            .iter()
            .map(|track| {
                track
                    .events
                    .iter()
                    .filter(|event| event.kind.is_note())
                    .count()
            })
            .sum()
    }

    /// 所有事件里最大的 tick（用于快速判断时长）。
    pub fn last_tick(&self) -> u32 {
        self.tracks
            .iter()
            .flat_map(|track| track.events.iter())
            .map(|event| event.tick)
            .max()
            .unwrap_or(0)
    }
}

/// 一条 SMF 轨道。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SmfTrack {
    /// 按文件顺序排列的事件（transform 会按 tick 稳定排序）。
    pub events: Vec<Event>,
}

impl SmfTrack {
    /// 空轨道。
    pub fn new() -> Self {
        Self::default()
    }

    /// 从事件列表构造轨道。
    pub fn from_events(events: Vec<Event>) -> Self {
        Self { events }
    }

    /// 追加一个事件。
    pub fn push(&mut self, event: Event) {
        self.events.push(event);
    }

    /// 事件数量。
    pub fn len(&self) -> usize {
        self.events.len()
    }

    /// 是否没有事件。
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    /// 事件迭代器。
    pub fn iter(&self) -> std::slice::Iter<'_, Event> {
        self.events.iter()
    }
}

impl From<Vec<Event>> for SmfTrack {
    fn from(events: Vec<Event>) -> Self {
        Self { events }
    }
}

impl<'a> IntoIterator for &'a SmfTrack {
    type Item = &'a Event;
    type IntoIter = std::slice::Iter<'a, Event>;

    fn into_iter(self) -> Self::IntoIter {
        self.events.iter()
    }
}

/// 一条事件：绝对 tick + 事件内容。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    /// 从轨道开头累计的绝对 tick。
    pub tick: u32,
    /// 事件内容。
    pub kind: EventKind,
}

impl Event {
    /// 构造事件。
    pub fn new(tick: u32, kind: EventKind) -> Self {
        Self { tick, kind }
    }
}

/// System Exclusive 的两种状态字节。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SysExKind {
    /// 0xF0：普通 SysEx。
    Start,
    /// 0xF7：转义 / 分段 SysEx。
    Escape,
}

impl SysExKind {
    /// 对应的状态字节。
    pub fn status_byte(self) -> u8 {
        match self {
            Self::Start => 0xf0,
            Self::Escape => 0xf7,
        }
    }
}

/// SMF 事件内容。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventKind {
    /// 0x80 note off。
    NoteOff {
        /// 通道 0-15。
        channel: u8,
        /// 音高 0-127。
        note: u8,
        /// 释放力度 0-127。
        velocity: u8,
    },
    /// 0x90 note on（velocity 为 0 时按 note off 处理）。
    NoteOn {
        /// 通道 0-15。
        channel: u8,
        /// 音高 0-127。
        note: u8,
        /// 力度 0-127。
        velocity: u8,
    },
    /// 0xA0 复音触后。
    PolyPressure {
        /// 通道 0-15。
        channel: u8,
        /// 音高 0-127。
        note: u8,
        /// 压力 0-127。
        pressure: u8,
    },
    /// 0xB0 控制器。
    ControlChange {
        /// 通道 0-15。
        channel: u8,
        /// 控制器号 0-127。
        controller: u8,
        /// 值 0-127。
        value: u8,
    },
    /// 0xC0 音色切换。
    ProgramChange {
        /// 通道 0-15。
        channel: u8,
        /// 音色号 0-127。
        program: u8,
    },
    /// 0xD0 通道触后。
    ChannelPressure {
        /// 通道 0-15。
        channel: u8,
        /// 压力 0-127。
        pressure: u8,
    },
    /// 0xE0 弯音（14 位，0-16383，中心 8192）。
    PitchBend {
        /// 通道 0-15。
        channel: u8,
        /// 14 位弯音值。
        value: u16,
    },
    /// 0xFF 元事件。
    Meta {
        /// 元事件类型。
        meta_type: u8,
        /// 元事件负载（不含长度前缀）。
        data: Vec<u8>,
    },
    /// 0xF0 / 0xF7 SysEx。
    SysEx {
        /// SysEx 状态。
        kind: SysExKind,
        /// 负载（不含长度前缀）。
        data: Vec<u8>,
    },
}

impl EventKind {
    /// 构造 note on（通道 / 音高 / 力度超出范围时截断到合法值）。
    pub fn note_on(channel: u8, note: u8, velocity: u8) -> Self {
        Self::NoteOn {
            channel: channel & 0x0f,
            note: note & 0x7f,
            velocity: velocity & 0x7f,
        }
    }

    /// 构造 note off（参数截断到合法值）。
    pub fn note_off(channel: u8, note: u8, velocity: u8) -> Self {
        Self::NoteOff {
            channel: channel & 0x0f,
            note: note & 0x7f,
            velocity: velocity & 0x7f,
        }
    }

    /// 构造控制器事件（参数截断到合法值）。
    pub fn control_change(channel: u8, controller: u8, value: u8) -> Self {
        Self::ControlChange {
            channel: channel & 0x0f,
            controller: controller & 0x7f,
            value: value & 0x7f,
        }
    }

    /// 构造音色切换事件（参数截断到合法值）。
    pub fn program_change(channel: u8, program: u8) -> Self {
        Self::ProgramChange {
            channel: channel & 0x0f,
            program: program & 0x7f,
        }
    }

    /// 构造 tempo 元事件（0x51，3 字节微秒数）。
    pub fn tempo(tempo_us: u32) -> Self {
        Self::Meta {
            meta_type: 0x51,
            data: vec![
                (tempo_us >> 16) as u8,
                (tempo_us >> 8) as u8,
                tempo_us as u8,
            ],
        }
    }

    /// 构造 End of Track（0x2F）。
    pub fn end_of_track() -> Self {
        Self::Meta {
            meta_type: 0x2f,
            data: Vec::new(),
        }
    }

    /// 构造任意元事件。
    pub fn meta(meta_type: u8, data: Vec<u8>) -> Self {
        Self::Meta { meta_type, data }
    }

    /// 构造 SysEx 事件。
    pub fn sysex(kind: SysExKind, data: Vec<u8>) -> Self {
        Self::SysEx { kind, data }
    }

    /// 是否是 note on / note off（含 velocity 为 0 的 note on）。
    pub fn is_note(&self) -> bool {
        matches!(self, Self::NoteOn { .. } | Self::NoteOff { .. })
    }

    /// 音高（仅 note 事件）。
    pub fn note(&self) -> Option<u8> {
        match self {
            Self::NoteOn { note, .. } | Self::NoteOff { note, .. } => Some(*note),
            _ => None,
        }
    }

    /// 通道（仅通道事件）。
    pub fn channel(&self) -> Option<u8> {
        match self {
            Self::NoteOff { channel, .. }
            | Self::NoteOn { channel, .. }
            | Self::PolyPressure { channel, .. }
            | Self::ControlChange { channel, .. }
            | Self::ProgramChange { channel, .. }
            | Self::ChannelPressure { channel, .. }
            | Self::PitchBend { channel, .. } => Some(*channel),
            Self::Meta { .. } | Self::SysEx { .. } => None,
        }
    }

    /// tempo 微秒值（仅合法的 0x51 元事件，且值必须大于 0）。
    pub fn tempo_us(&self) -> Option<u32> {
        match self {
            Self::Meta {
                meta_type: 0x51,
                data,
            } if data.len() == 3 => {
                let value =
                    (u32::from(data[0]) << 16) | (u32::from(data[1]) << 8) | u32::from(data[2]);
                (value > 0).then_some(value)
            }
            _ => None,
        }
    }

    /// 状态字节（Meta / SysEx 没有单一状态字节，返回 None）。
    pub fn status(&self) -> Option<u8> {
        match self {
            Self::NoteOff { channel, .. } => Some(0x80 | (channel & 0x0f)),
            Self::NoteOn { channel, .. } => Some(0x90 | (channel & 0x0f)),
            Self::PolyPressure { channel, .. } => Some(0xa0 | (channel & 0x0f)),
            Self::ControlChange { channel, .. } => Some(0xb0 | (channel & 0x0f)),
            Self::ProgramChange { channel, .. } => Some(0xc0 | (channel & 0x0f)),
            Self::ChannelPressure { channel, .. } => Some(0xd0 | (channel & 0x0f)),
            Self::PitchBend { channel, .. } => Some(0xe0 | (channel & 0x0f)),
            Self::Meta { .. } | Self::SysEx { .. } => None,
        }
    }
}

/// 编码为 SMF 字节。事件按当前顺序写出，调用方负责保证 tick 单调。
pub fn encode_smf(smf: &SmfFile) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"MThd");
    out.extend_from_slice(&6u32.to_be_bytes());
    out.extend_from_slice(&smf.format.to_be_bytes());
    out.extend_from_slice(&(smf.tracks.len() as u16).to_be_bytes());
    out.extend_from_slice(&smf.ticks_per_beat.to_be_bytes());

    for track in &smf.tracks {
        let mut data = Vec::new();
        let mut previous_tick = 0u32;
        for event in &track.events {
            write_vlq(&mut data, event.tick.saturating_sub(previous_tick));
            encode_event(&mut data, &event.kind);
            previous_tick = event.tick;
        }
        out.extend_from_slice(b"MTrk");
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(&data);
    }
    out
}

fn encode_event(out: &mut Vec<u8>, kind: &EventKind) {
    match kind {
        EventKind::NoteOff {
            channel,
            note,
            velocity,
        } => push_channel_event(out, 0x80, *channel, &[*note, *velocity]),
        EventKind::NoteOn {
            channel,
            note,
            velocity,
        } => push_channel_event(out, 0x90, *channel, &[*note, *velocity]),
        EventKind::PolyPressure {
            channel,
            note,
            pressure,
        } => push_channel_event(out, 0xa0, *channel, &[*note, *pressure]),
        EventKind::ControlChange {
            channel,
            controller,
            value,
        } => push_channel_event(out, 0xb0, *channel, &[*controller, *value]),
        EventKind::ProgramChange { channel, program } => {
            push_channel_event(out, 0xc0, *channel, &[*program]);
        }
        EventKind::ChannelPressure { channel, pressure } => {
            push_channel_event(out, 0xd0, *channel, &[*pressure]);
        }
        EventKind::PitchBend { channel, value } => {
            let value = value & 0x3fff;
            push_channel_event(
                out,
                0xe0,
                *channel,
                &[(value & 0x7f) as u8, ((value >> 7) & 0x7f) as u8],
            );
        }
        EventKind::Meta { meta_type, data } => {
            out.push(0xff);
            out.push(*meta_type);
            write_vlq(out, data.len() as u32);
            out.extend_from_slice(data);
        }
        EventKind::SysEx { kind, data } => {
            out.push(kind.status_byte());
            write_vlq(out, data.len() as u32);
            out.extend_from_slice(data);
        }
    }
}

fn push_channel_event(out: &mut Vec<u8>, status: u8, channel: u8, data: &[u8]) {
    out.push(status | (channel & 0x0f));
    for byte in data {
        out.push(byte & 0x7f);
    }
}
