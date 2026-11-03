mod common;

use common::*;
use fufumidi_core::{
    parse_smf, read_vlq, write_vlq, Error, EventKind, SmfFile, SmfTrack, SysExKind,
};

#[test]
fn parses_minimal_single_note_file() {
    let bytes = smf(
        0,
        480,
        &[track(&[
            (0, note_on(0, 60, 100)),
            (480, note_off(0, 60, 0)),
            (480, end_of_track()),
        ])],
    );
    let parsed = parse_smf(&bytes).expect("parse minimal SMF");
    assert_eq!(parsed.format, 0);
    assert_eq!(parsed.ticks_per_beat, 480);
    assert_eq!(parsed.tracks.len(), 1);
    assert_eq!(parsed.tracks[0].events.len(), 3);
    assert_eq!(
        parsed.tracks[0].events[0],
        fufumidi_core::Event::new(
            0,
            EventKind::NoteOn {
                channel: 0,
                note: 60,
                velocity: 100,
            }
        )
    );
    assert_eq!(parsed.tracks[0].events[1].tick, 480);
    assert_eq!(
        parsed.tracks[0].events[2].kind,
        EventKind::Meta {
            meta_type: 0x2f,
            data: vec![],
        }
    );
    assert_eq!(parsed.note_event_count(), 2);
    assert_eq!(parsed.last_tick(), 480);
}

#[test]
fn parses_format_one_multitrack_with_tempo() {
    let bytes = smf(
        1,
        480,
        &[
            track(&[(0, tempo(500_000)), (0, end_of_track())]),
            track(&[
                (0, note_on(0, 60, 100)),
                (240, note_on(0, 64, 80)),
                (480, note_off(0, 60, 0)),
                (480, note_off(0, 64, 0)),
                (480, end_of_track()),
            ]),
        ],
    );
    let parsed = parse_smf(&bytes).expect("parse format 1");
    assert_eq!(parsed.format, 1);
    assert_eq!(parsed.tracks.len(), 2);
    assert_eq!(parsed.tracks[1].events.len(), 5);
    assert_eq!(parsed.tracks[0].events[0].kind.tempo_us(), Some(500_000));
    assert_eq!(parsed.tracks[1].events[2].tick, 480);
}

#[test]
fn parses_running_status_events() {
    let bytes = smf(
        0,
        480,
        &[track(&[
            (0, note_on(0, 60, 100)),
            (240, running_note_on(64, 80)),
            (480, running_note_on(64, 0)),
            (480, running_note_on(60, 0)),
            (480, end_of_track()),
        ])],
    );
    let parsed = parse_smf(&bytes).expect("parse running status");
    let notes: Vec<_> = parsed.tracks[0]
        .events
        .iter()
        .filter(|event| event.kind.is_note())
        .collect();
    assert_eq!(notes.len(), 4, "2 note-on + 2 note-off(running status)");
    assert_eq!(
        notes[1].kind,
        EventKind::NoteOn {
            channel: 0,
            note: 64,
            velocity: 80,
        }
    );
    assert_eq!(notes[1].tick, 240);
    assert_eq!(
        notes[2].kind,
        EventKind::NoteOn {
            channel: 0,
            note: 64,
            velocity: 0,
        }
    );
}

#[test]
fn parses_one_byte_and_two_byte_channel_events() {
    let bytes = smf(
        0,
        96,
        &[track(&[
            (0, program_change(3, 42)),
            (10, pitch_bend(3, 8192)),
            (20, control_change(3, 7, 100)),
            (20, end_of_track()),
        ])],
    );
    let parsed = parse_smf(&bytes).expect("parse channel events");
    assert_eq!(
        parsed.tracks[0].events[0].kind,
        EventKind::ProgramChange {
            channel: 3,
            program: 42,
        }
    );
    assert_eq!(
        parsed.tracks[0].events[1].kind,
        EventKind::PitchBend {
            channel: 3,
            value: 8192,
        }
    );
    assert_eq!(
        parsed.tracks[0].events[2].kind,
        EventKind::ControlChange {
            channel: 3,
            controller: 7,
            value: 100,
        }
    );
}

#[test]
fn roundtrips_encoder_for_canonical_file() {
    let bytes = smf(
        1,
        480,
        &[
            track(&[(0, tempo(500_000)), (0, end_of_track())]),
            track(&[
                (0, sysex(&[0x7e, 0x7f, 0x09, 0x01, 0xf7])),
                (0, note_on(2, 60, 100)),
                (120, pitch_bend(2, 16_383)),
                (480, note_off(2, 60, 0)),
                (480, end_of_track()),
            ]),
        ],
    );
    let parsed = parse_smf(&bytes).expect("parse canonical file");
    assert_eq!(parsed.to_bytes(), bytes, "encoder must round-trip");
    let reparsed = parse_smf(&parsed.to_bytes()).expect("reparse");
    assert_eq!(parsed, reparsed);
    assert!(matches!(
        parsed.tracks[1].events[0].kind,
        EventKind::SysEx {
            kind: SysExKind::Start,
            ..
        }
    ));
}

#[test]
fn skips_extended_header_bytes() {
    let track_data = track(&[
        (0, note_on(0, 60, 100)),
        (480, note_off(0, 60, 0)),
        (480, end_of_track()),
    ]);
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"MThd");
    bytes.extend_from_slice(&8u32.to_be_bytes());
    bytes.extend_from_slice(&0u16.to_be_bytes());
    bytes.extend_from_slice(&1u16.to_be_bytes());
    bytes.extend_from_slice(&480u16.to_be_bytes());
    bytes.extend_from_slice(&[0x00, 0x00]);
    bytes.extend_from_slice(b"MTrk");
    bytes.extend_from_slice(&(track_data.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&track_data);

    let parsed = parse_smf(&bytes).expect("parse extended header");
    assert_eq!(parsed.tracks.len(), 1);
    assert_eq!(parsed.tracks[0].events.len(), 3);
}

#[test]
fn rejects_non_midi_and_short_headers() {
    assert_eq!(parse_smf(b""), Err(Error::NotMidi));
    assert_eq!(
        parse_smf(b"definitely not a midi file"),
        Err(Error::NotMidi)
    );

    let mut short_header = Vec::new();
    short_header.extend_from_slice(b"MThd");
    short_header.extend_from_slice(&4u32.to_be_bytes());
    short_header.extend_from_slice(&0u16.to_be_bytes());
    short_header.extend_from_slice(&0u16.to_be_bytes());
    short_header.extend_from_slice(&480u16.to_be_bytes());
    assert_eq!(parse_smf(&short_header), Err(Error::HeaderTooShort));
}

#[test]
fn rejects_smpte_and_zero_division() {
    let smpte = smf(0, 0xe728, &[track(&[(0, end_of_track())])]);
    assert_eq!(parse_smf(&smpte), Err(Error::SmpteUnsupported));

    let zero = smf(0, 0, &[track(&[(0, end_of_track())])]);
    assert_eq!(parse_smf(&zero), Err(Error::InvalidDivision));
}

#[test]
fn rejects_file_without_tracks() {
    assert_eq!(parse_smf(&smf(0, 480, &[])), Err(Error::NoTracks));
}

#[test]
fn rejects_running_status_without_prior_status() {
    let bytes = smf(0, 480, &[track(&[(0, running_note_on(60, 100))])]);
    assert_eq!(parse_smf(&bytes), Err(Error::RunningStatusWithoutStatus));
}

#[test]
fn rejects_unexpected_status_byte() {
    let bytes = smf(0, 480, &[track(&[(0, vec![0xf1, 0x00])])]);
    assert_eq!(parse_smf(&bytes), Err(Error::UnexpectedStatus(0xf1)));
}

#[test]
fn rejects_truncated_channel_event() {
    let bytes = smf(0, 480, &[track(&[(0, vec![0x90, 60])])]);
    assert_eq!(parse_smf(&bytes), Err(Error::Truncated("channel event")));
}

#[test]
fn rejects_truncated_vlq() {
    // 轨道数据直接以一个未结束的 VLQ 开头：0x80 表示还有后续字节，但轨道在这里结束。
    let bytes = smf(0, 480, &[vec![0x80]]);
    assert_eq!(parse_smf(&bytes), Err(Error::Truncated("vlq")));
}

#[test]
fn vlq_roundtrips_all_u32_ranges() {
    for value in [
        0,
        1,
        0x7f,
        0x80,
        0x3fff,
        0x4000,
        0x1f_ffff,
        0x20_0000,
        0x0fff_ffff,
        u32::MAX,
    ] {
        let mut buffer = Vec::new();
        write_vlq(&mut buffer, value);
        let mut position = 0usize;
        assert_eq!(read_vlq(&buffer, &mut position), Ok(value));
        assert_eq!(position, buffer.len(), "vlq should consume all bytes");
    }
}

#[test]
fn vlq_rejects_overflow_and_six_byte_sequences() {
    let mut position = 0usize;
    assert_eq!(
        read_vlq(&[0x80], &mut position),
        Err(Error::Truncated("vlq"))
    );

    let mut position = 0usize;
    assert_eq!(
        read_vlq(&[0xff, 0xff, 0xff, 0xff, 0x7f], &mut position),
        Err(Error::InvalidVlq)
    );

    let mut position = 0usize;
    assert_eq!(
        read_vlq(&[0x81, 0x80, 0x80, 0x80, 0x80, 0x00], &mut position),
        Err(Error::InvalidVlq)
    );
}

#[test]
fn exposes_model_constructors() {
    let mut track = SmfTrack::new();
    track.push(fufumidi_core::Event::new(0, EventKind::note_on(0, 60, 100)));
    track.push(fufumidi_core::Event::new(
        480,
        EventKind::note_off(0, 60, 0),
    ));
    assert_eq!(track.len(), 2);
    assert!(!track.is_empty());
    assert_eq!(track.iter().count(), 2);
    assert_eq!((&track).into_iter().count(), 2);

    let file = SmfFile::new(0, 480, vec![track]);
    assert_eq!(file.note_event_count(), 2);
    assert_eq!(file.last_tick(), 480);
    let parsed = parse_smf(&file.to_bytes()).expect("reparse constructed model");
    assert_eq!(parsed, file);
    assert_eq!(EventKind::note_on(0x1f, 200, 200).channel(), Some(0x0f));
    assert_eq!(EventKind::note_on(0x1f, 200, 200).note(), Some(0x48));
    assert_eq!(EventKind::tempo(500_000).tempo_us(), Some(500_000));
    assert_eq!(EventKind::tempo(0).tempo_us(), None);
    assert_eq!(EventKind::end_of_track().status(), None);
}
