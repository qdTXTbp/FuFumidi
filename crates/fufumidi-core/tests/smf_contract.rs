//! SMF 解析 / 统计 / 变换的契约测试（M0/M1 对拍基础）。
//!
//! 这些用例覆盖：format 1 多轨、running status、note-on vel=0 视作 note-off、
//! 量化/移调、VLQ 边界、错误输入。以后 Rust 引擎替换 Python 时，它们是第一道闸。

use fufumidi_core::{
    analyze_smf, encode_smf, parse_smf, quantize_smf, quantize_tick, read_vlq, transpose_smf,
    write_vlq, Event, EventKind, SmfFile, SmfTrack,
};

/// 造一个最小 format 1 文件：0 号轨 tempo，1 号轨两个音。
fn basic_smf() -> Vec<u8> {
    let mut conductor = SmfTrack::new();
    conductor.push(Event::new(0, EventKind::tempo(500_000)));
    conductor.push(Event::new(0, EventKind::end_of_track()));
    let mut music = SmfTrack::new();
    music.push(Event::new(0, EventKind::program_change(0, 0)));
    music.push(Event::new(0, EventKind::note_on(0, 60, 100)));
    music.push(Event::new(480, EventKind::note_off(0, 60, 0)));
    music.push(Event::new(0, EventKind::note_on(0, 64, 80)));
    music.push(Event::new(240, EventKind::note_off(0, 64, 0)));
    music.push(Event::new(0, EventKind::end_of_track()));
    let smf = SmfFile::new(1, 480, vec![conductor, music]);
    encode_smf(&smf)
}

#[test]
fn parse_format1_multi_track() {
    let bytes = basic_smf();
    let smf = parse_smf(&bytes).expect("parse");
    assert_eq!(smf.format, 1);
    assert_eq!(smf.ticks_per_beat, 480);
    assert_eq!(smf.tracks.len(), 2);
    assert_eq!(smf.last_tick(), 720);
    // encode -> parse -> encode 稳定（round-trip 字节可复现）
    let again = encode_smf(&smf);
    let smf2 = parse_smf(&again).expect("parse again");
    assert_eq!(encode_smf(&smf2), again);
}

#[test]
fn stats_counts_and_averages() {
    let stats = analyze_smf(&basic_smf()).expect("stats");
    assert_eq!(stats.format, 1);
    assert_eq!(stats.tracks, 2);
    assert_eq!(stats.notes, 2);
    assert_eq!(stats.min_midi, 60);
    assert_eq!(stats.max_midi, 64);
    assert!((stats.avg_vel - 90.0).abs() < 1e-9);
    // (480 + 240) / 2
    assert!((stats.avg_dur_ticks - 360.0).abs() < 1e-9);
    assert!((stats.bpm - 120.0).abs() < 1e-9);
}

#[test]
fn running_status_is_supported() {
    // MThd(format=0, ntrks=1, div=480) + track: note-on 60 vel100，delta 480 后 running status note-on vel=0（=off）
    let mut bytes: Vec<u8> = Vec::new();
    bytes.extend_from_slice(b"MThd");
    bytes.extend_from_slice(&6u32.to_be_bytes());
    bytes.extend_from_slice(&0u16.to_be_bytes());
    bytes.extend_from_slice(&1u16.to_be_bytes());
    bytes.extend_from_slice(&480u16.to_be_bytes());
    let track: Vec<u8> = vec![
        0x00, 0x90, 0x3C, 0x64, // delta0 note-on ch0 60 100
        0x83, 0x60, 0x3C, 0x00, // delta480 running status: 60 vel0 -> note-off
        0x00, 0xFF, 0x2F, 0x00, // end of track
    ];
    bytes.extend_from_slice(b"MTrk");
    bytes.extend_from_slice(&(track.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&track);
    let smf = parse_smf(&bytes).expect("running status parse");
    assert_eq!(smf.tracks.len(), 1);
    let stats = analyze_smf(&bytes).expect("stats");
    assert_eq!(stats.notes, 1);
    assert!((stats.avg_dur_ticks - 480.0).abs() < 1e-9);
}

#[test]
fn quantize_moves_note_on_only() {
    // note-on 在 100 tick；divisions=8 -> 网格 240 tick -> 100 落到 0。
    let mut conductor = SmfTrack::new();
    conductor.push(Event::new(0, EventKind::tempo(500_000)));
    conductor.push(Event::new(0, EventKind::end_of_track()));
    let mut music = SmfTrack::new();
    music.push(Event::new(100, EventKind::note_on(0, 60, 100)));
    music.push(Event::new(140, EventKind::note_off(0, 60, 0)));
    music.push(Event::new(0, EventKind::end_of_track()));
    let bytes = encode_smf(&SmfFile::new(1, 480, vec![conductor, music]));

    let out = quantize_smf(&bytes, 8).expect("quantize");
    let smf = parse_smf(&out).expect("parse quantized");
    let onset = smf.tracks[1]
        .iter()
        .find(|e| matches!(&e.kind, EventKind::NoteOn { velocity, .. } if *velocity > 0))
        .map(|e| e.tick)
        .expect("note-on");
    assert_eq!(onset, 0, "100 tick 应量化到 0");
    // 时值保持：off 相对 onset 仍差 40
    let offset = smf.tracks[1]
        .iter()
        .find(|e| matches!(&e.kind, EventKind::NoteOff { .. }))
        .map(|e| e.tick)
        .expect("note-off");
    assert_eq!(offset, 40);
}

#[test]
fn transpose_pitches_and_clamps() {
    let bytes = basic_smf();
    let up = transpose_smf(&bytes, 4).expect("transpose");
    let stats = analyze_smf(&up).expect("stats");
    assert_eq!(stats.min_midi, 64);
    assert_eq!(stats.max_midi, 68);

    // 顶到 127：不 panic、不越界
    let mut music = SmfTrack::new();
    music.push(Event::new(0, EventKind::note_on(0, 127, 100)));
    music.push(Event::new(120, EventKind::note_off(0, 127, 0)));
    let bytes = encode_smf(&SmfFile::new(0, 480, vec![music]));
    let out = transpose_smf(&bytes, 10).expect("transpose clamp");
    let smf = parse_smf(&out).expect("parse");
    let note = smf.tracks[0]
        .iter()
        .find_map(|e| e.kind.note())
        .expect("note");
    assert_eq!(note, 127);
}

#[test]
fn vlq_roundtrip_all_boundaries() {
    for value in [
        0u32,
        1,
        0x7f,
        0x80,
        0x3fff,
        0x4000,
        0x1f_ffff,
        0x0fff_ffff,
        u32::MAX,
    ] {
        let mut buf = Vec::new();
        write_vlq(&mut buf, value);
        let mut pos = 0usize;
        let got = read_vlq(&buf, &mut pos).expect("read vlq");
        assert_eq!(got, value, "vlq {value}");
        assert_eq!(pos, buf.len());
    }
}

#[test]
fn quantize_tick_rounds_to_nearest() {
    assert_eq!(quantize_tick(0, 480), 0);
    assert_eq!(quantize_tick(239, 480), 0);
    assert_eq!(quantize_tick(241, 480), 480);
    assert_eq!(quantize_tick(480, 480), 480);
    assert_eq!(quantize_tick(100, 0), 100); // grid=0 按 1 处理
}

#[test]
fn invalid_and_empty_inputs_error_cleanly() {
    assert!(parse_smf(b"not a midi file").is_err());
    // 合法头但没有音符：统计返回 NoNoteEvents，而不是 panic
    let mut track = SmfTrack::new();
    track.push(Event::new(0, EventKind::end_of_track()));
    let bytes = encode_smf(&SmfFile::new(0, 480, vec![track]));
    assert!(analyze_smf(&bytes).is_err());
}
