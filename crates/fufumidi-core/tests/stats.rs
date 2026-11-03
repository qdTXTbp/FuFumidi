mod common;

use common::*;
use fufumidi_core::{analyze_smf, Error};

#[test]
fn stats_reports_format_one_multitrack() {
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
    let stats = analyze_smf(&bytes).expect("analyze format 1");
    assert_eq!(stats.format, 1);
    assert_eq!(stats.tracks, 2);
    assert_eq!(stats.notes, 2);
    assert!((stats.bpm - 120.0).abs() < 1e-9);
    assert_eq!(stats.min_midi, 60);
    assert_eq!(stats.max_midi, 64);
    assert!((stats.avg_vel - 90.0).abs() < 1e-9);
    assert!((stats.avg_dur_ticks - 360.0).abs() < 1e-9);
}

#[test]
fn stats_treats_zero_velocity_note_on_as_note_off() {
    let bytes = smf(
        0,
        480,
        &[track(&[
            (0, note_on(0, 60, 100)),
            (480, note_on(0, 60, 0)),
            (480, end_of_track()),
        ])],
    );
    let stats = analyze_smf(&bytes).expect("analyze zero-velocity off");
    assert_eq!(stats.notes, 1);
    assert!((stats.avg_dur_ticks - 480.0).abs() < 1e-9);
    assert_eq!(stats.min_midi, 60);
    assert_eq!(stats.max_midi, 60);
}

#[test]
fn stats_uses_last_tempo_event() {
    let bytes = smf(
        0,
        480,
        &[track(&[
            (0, tempo(500_000)),
            (10, tempo(400_000)),
            (20, note_on(0, 60, 100)),
            (500, note_off(0, 60, 0)),
            (500, end_of_track()),
        ])],
    );
    let stats = analyze_smf(&bytes).expect("analyze tempo");
    assert!((stats.bpm - 150.0).abs() < 1e-9);
}

#[test]
fn stats_counts_running_status_notes() {
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
    let stats = analyze_smf(&bytes).expect("analyze running status");
    assert_eq!(stats.notes, 2);
    assert_eq!(stats.tracks, 1);
    assert_eq!(stats.min_midi, 60);
    assert_eq!(stats.max_midi, 64);
    assert!((stats.avg_vel - 90.0).abs() < 1e-9);
    assert!((stats.avg_dur_ticks - 360.0).abs() < 1e-9);
}

#[test]
fn stats_rejects_files_without_paired_notes() {
    let bytes = smf(0, 480, &[track(&[(0, end_of_track())])]);
    assert_eq!(analyze_smf(&bytes), Err(Error::NoNoteEvents));

    let hanging = smf(0, 480, &[track(&[(0, note_on(0, 60, 100))])]);
    assert_eq!(analyze_smf(&hanging), Err(Error::NoNoteEvents));
}

#[test]
fn stats_ignores_note_off_without_matching_on() {
    let bytes = smf(
        0,
        480,
        &[track(&[
            (0, note_off(0, 60, 0)),
            (0, note_on(0, 64, 100)),
            (480, note_off(0, 64, 0)),
            (480, end_of_track()),
        ])],
    );
    let stats = analyze_smf(&bytes).expect("analyze orphan note-off");
    assert_eq!(stats.notes, 1);
    assert_eq!(stats.min_midi, 64);
    assert!((stats.avg_dur_ticks - 480.0).abs() < 1e-9);
}
