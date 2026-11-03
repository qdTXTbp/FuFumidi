mod common;

use common::*;
use fufumidi_core::{
    parse_smf, quantize_smf, quantize_tick, transpose_smf, Error, EventKind, Transform,
};

#[test]
fn quantize_moves_note_on_and_keeps_duration() {
    let bytes = smf(
        0,
        480,
        &[track(&[
            (100, note_on(0, 60, 64)),
            (580, note_off(0, 60, 0)),
            (580, end_of_track()),
        ])],
    );
    let out = quantize_smf(&bytes, 8).expect("quantize");
    let parsed = parse_smf(&out).expect("parse quantized");
    assert_eq!(parsed.tracks[0].events[0].tick, 0, "onset 100 -> 0");
    assert_eq!(
        parsed.tracks[0].events[1].tick, 480,
        "note-off keeps 480-tick duration"
    );
    assert_eq!(
        parsed.tracks[0].events[0].kind,
        EventKind::NoteOn {
            channel: 0,
            note: 60,
            velocity: 64,
        }
    );
}

#[test]
fn quantize_rounds_to_nearest_grid_point() {
    assert_eq!(quantize_tick(119, 240), 0);
    assert_eq!(quantize_tick(120, 240), 240);
    assert_eq!(quantize_tick(359, 240), 240);
    assert_eq!(quantize_tick(360, 240), 480);
    assert_eq!(quantize_tick(100, 0), 100, "grid 0 behaves as 1");
    assert_eq!(Transform::quantize(8).grid_ticks(480), 240);
    assert_eq!(Transform::quantize(0).grid_ticks(480), 1920);
    assert_eq!(Transform::transpose(12).grid_ticks(480), 0);
}

#[test]
fn quantize_handles_running_status_input() {
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
    let out = quantize_smf(&bytes, 8).expect("quantize running status");
    let parsed = parse_smf(&out).expect("parse quantized running status");
    let notes: Vec<_> = parsed.tracks[0]
        .events
        .iter()
        .filter(|event| event.kind.is_note())
        .collect();
    assert_eq!(notes.len(), 4);
    assert_eq!(notes[0].tick, 0);
    assert_eq!(notes[1].tick, 240);
    assert_eq!(notes[2].tick, 480);
    assert_eq!(notes[3].tick, 480);
}

#[test]
fn transpose_shifts_note_on_and_note_off() {
    let bytes = smf(
        0,
        480,
        &[track(&[
            (0, note_on(0, 60, 100)),
            (480, note_off(0, 60, 0)),
            (480, end_of_track()),
        ])],
    );
    let out = transpose_smf(&bytes, 12).expect("transpose");
    let parsed = parse_smf(&out).expect("parse transposed");
    assert_eq!(
        parsed.tracks[0].events[0].kind,
        EventKind::NoteOn {
            channel: 0,
            note: 72,
            velocity: 100,
        }
    );
    assert_eq!(
        parsed.tracks[0].events[1].kind,
        EventKind::NoteOff {
            channel: 0,
            note: 72,
            velocity: 0,
        }
    );
}

#[test]
fn transpose_clamps_to_midi_range() {
    let bytes = smf(
        0,
        480,
        &[track(&[
            (0, note_on(0, 0, 100)),
            (0, note_on(0, 120, 100)),
            (480, note_off(0, 0, 0)),
            (480, note_off(0, 120, 0)),
            (480, end_of_track()),
        ])],
    );
    let up = parse_smf(&transpose_smf(&bytes, 12).expect("transpose up")).expect("parse up");
    let up_notes: Vec<u8> = up.tracks[0]
        .events
        .iter()
        .filter_map(|event| event.kind.note())
        .collect();
    assert_eq!(up_notes, vec![12, 127, 12, 127]);

    let down = parse_smf(&transpose_smf(&bytes, -12).expect("transpose down")).expect("parse down");
    let down_notes: Vec<u8> = down.tracks[0]
        .events
        .iter()
        .filter_map(|event| event.kind.note())
        .collect();
    assert_eq!(down_notes, vec![0, 108, 0, 108]);
}

#[test]
fn transpose_preserves_non_note_events() {
    let bytes = smf(
        1,
        480,
        &[
            track(&[(0, tempo(500_000)), (0, end_of_track())]),
            track(&[
                (0, program_change(1, 42)),
                (0, control_change(1, 7, 100)),
                (10, sysex(&[0x7e, 0x7f, 0x09, 0x01, 0xf7])),
                (10, pitch_bend(1, 16_383)),
                (20, note_on(1, 60, 100)),
                (500, note_off(1, 60, 0)),
                (500, end_of_track()),
            ]),
        ],
    );
    let before = parse_smf(&bytes).expect("parse before");
    let after = parse_smf(&transpose_smf(&bytes, 5).expect("transpose")).expect("parse after");
    assert_eq!(before.tracks.len(), after.tracks.len());
    for (left, right) in before.tracks[1].events.iter().zip(&after.tracks[1].events) {
        if left.kind.is_note() {
            continue;
        }
        assert_eq!(left.kind, right.kind);
        assert_eq!(left.tick, right.tick);
    }
    let notes: Vec<u8> = after.tracks[1]
        .events
        .iter()
        .filter_map(|event| event.kind.note())
        .collect();
    assert_eq!(notes, vec![65, 65]);
}

#[test]
fn transforms_reject_invalid_input() {
    assert_eq!(quantize_smf(b"not midi", 8), Err(Error::NotMidi));
    let truncated = smf(0, 480, &[track(&[(0, vec![0x90, 60])])]);
    assert_eq!(
        transpose_smf(&truncated, 12),
        Err(Error::Truncated("channel event"))
    );
}

#[test]
fn quantize_zero_divisions_still_produces_valid_file() {
    let bytes = smf(
        0,
        480,
        &[track(&[
            (100, note_on(0, 60, 100)),
            (580, note_off(0, 60, 0)),
            (580, end_of_track()),
        ])],
    );
    let out = quantize_smf(&bytes, 0).expect("quantize divisions=0");
    let parsed = parse_smf(&out).expect("parse");
    assert_eq!(parsed.tracks[0].events[0].tick, 0);
    assert_eq!(parsed.tracks[0].events[1].tick, 480);
}
