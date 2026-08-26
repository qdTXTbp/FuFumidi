use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;

fn walk_files(dir: &str, exts: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![PathBuf::from(dir)];
    while let Some(d) = stack.pop() {
        if let Ok(entries) = fs::read_dir(&d) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if let Some(ext) = p.extension().and_then(|x| x.to_str()) {
                    if exts.iter().any(|x2| x2.eq_ignore_ascii_case(ext)) {
                        out.push(p.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    out
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

struct MidiStats {
    format: u16,
    tracks: usize,
    notes: usize,
    bpm: f64,
    min_midi: i32,
    max_midi: i32,
    avg_vel: f64,
    avg_dur_ticks: f64,
}

fn read_vlq(data: &[u8], pos: &mut usize) -> u32 {
    let mut value: u32 = 0;
    loop {
        let b = data[*pos];
        *pos += 1;
        value = (value << 7) | (b & 0x7f) as u32;
        if b & 0x80 == 0 { break; }
    }
    value
}

fn stat_smf(bytes: &[u8]) -> Result<MidiStats, String> {
    if bytes.len() < 14 || &bytes[0..4] != b"MThd" {
        return Err("not a MIDI file".into());
    }
    let head_len = u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
    if head_len < 6 {
        return Err("MThd too short".into());
    }
    let format = u16::from_be_bytes([bytes[8], bytes[9]]);
    let ntrks = u16::from_be_bytes([bytes[10], bytes[11]]) as usize;
    let division_raw = u16::from_be_bytes([bytes[12], bytes[13]]);
    if division_raw & 0x8000 != 0 {
        return Err("SMPTE MIDI files not supported".into());
    }
    let tpb = (division_raw & 0x7fff) as f64;
    if tpb <= 0.0 {
        return Err("invalid division".into());
    }

    let mut pos = 14 + head_len.saturating_sub(6);
    let mut tempo_us = 500_000u32;
    let mut track_count = 0usize;
    let mut notes: Vec<(i32, u32, i32, u32)> = Vec::new(); // (midi, vel, start_tick, dur_ticks)
    let mut active: Vec<(i32, i32, u32, i32)> = Vec::new(); // (channel, midi, start_tick, vel)

    for _ in 0..ntrks {
        if pos + 8 > bytes.len() { break; }
        if &bytes[pos..pos + 4] == b"MTrk" {
            track_count += 1;
            let len = u32::from_be_bytes([bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]]) as usize;
            pos += 8;
            let end = (pos + len).min(bytes.len());
            let mut tick: u32 = 0;
            while pos < end {
                tick += read_vlq(bytes, &mut pos);
                if pos >= end { break; }
                let status = bytes[pos];
                if status & 0x80 == 0 {
                    // running status not handled fully; skip byte
                    pos += 1;
                    continue;
                }
                pos += 1;
                let is_meta = status == 0xFF;
                let is_sysex = status == 0xF0 || status == 0xF7;
                if is_meta {
                    let mtype = bytes.get(pos).copied().unwrap_or(0);
                    pos += 1;
                    let mlen = read_vlq(bytes, &mut pos) as usize;
                    let mdata_end = (pos + mlen).min(bytes.len());
                    if mtype == 0x51 && mlen >= 3 {
                        let b0 = bytes.get(pos).copied().unwrap_or(0);
                        let b1 = bytes.get(pos + 1).copied().unwrap_or(0);
                        let b2 = bytes.get(pos + 2).copied().unwrap_or(0);
                        let v = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);
                        if v > 0 { tempo_us = v; }
                    }
                    pos = mdata_end;
                    continue;
                }
                if is_sysex {
                    let slen = read_vlq(bytes, &mut pos) as usize;
                    pos = (pos + slen).min(bytes.len());
                    continue;
                }
                // channel events
                let channel = (status & 0x0F) as i32;
                let kind = status & 0xF0;
                match kind {
                    0x80 => { // note off
                        let note = bytes.get(pos).copied().unwrap_or(0) as i32;
                        pos += 1;
                        if pos < end { pos += 1; } // velocity
                        if let Some(idx) = active.iter().position(|a| a.0 == channel && a.1 == note) {
                            let (_, _, st, vel) = active.remove(idx);
                            notes.push((note, vel as u32, st as i32, tick.saturating_sub(st)));
                        }
                    }
                    0x90 => { // note on
                        let note = bytes.get(pos).copied().unwrap_or(0) as i32;
                        let vel = bytes.get(pos + 1).copied().unwrap_or(0) as i32;
                        pos += 2;
                        if vel == 0 {
                            if let Some(idx) = active.iter().position(|a| a.0 == channel && a.1 == note) {
                                let (_, _, st, v2) = active.remove(idx);
                                notes.push((note, v2 as u32, st as i32, tick.saturating_sub(st)));
                            }
                        } else {
                            if let Some(idx) = active.iter().position(|a| a.0 == channel && a.1 == note) {
                                active.remove(idx);
                            }
                            active.push((channel, note, tick, vel));
                        }
                    }
                    _ => {
                        // two data bytes for most channel messages
                        if pos < end { pos += 1; }
                        if pos < end { pos += 1; }
                    }
                }
            }
            pos = end;
        } else {
            break;
        }
    }

    if notes.is_empty() || track_count == 0 {
        return Err("no note events found".into());
    }

    let min_midi = notes.iter().map(|n| n.0).min().unwrap_or(0);
    let max_midi = notes.iter().map(|n| n.0).max().unwrap_or(127);
    let avg_vel = notes.iter().map(|n| n.1 as f64).sum::<f64>() / notes.len() as f64;
    let avg_dur_ticks = notes.iter().map(|n| n.3 as f64).sum::<f64>() / notes.len() as f64;
    let bpm = 60_000_000.0 / tempo_us as f64;

    Ok(MidiStats {
        format,
        tracks: track_count,
        notes: notes.len(),
        bpm,
        min_midi,
        max_midi,
        avg_vel,
        avg_dur_ticks,
    })
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let out = match args.first().map(|s| s.as_str()) {
        Some("ping") => r#"{"ok":true,"service":"fufumidi-core","version":"0.1.0"}"#.to_string(),
        Some("version") => r#"{"ok":true,"version":"0.1.0"}"#.to_string(),
        Some("midi-stats") => {
            let path = args.get(1).cloned().unwrap_or_default();
            match fs::read(&path) {
                Ok(bytes) => match stat_smf(&bytes) {
                    Ok(s) => format!(
                        r#"{{"ok":true,"format":{},"tracks":{},"notes":{},"bpm":{:.2},"min_midi":{},"max_midi":{},"avg_vel":{:.1},"avg_dur_ticks":{:.1}}}"#,
                        s.format, s.tracks, s.notes, s.bpm, s.min_midi, s.max_midi, s.avg_vel, s.avg_dur_ticks
                    ),
                    Err(e) => format!(r#"{{"ok":false,"error":{}}}"#, json_str(&e)),
                },
                Err(e) => format!(r#"{{"ok":false,"error":{}}}"#, json_str(&e.to_string())),
            }
        }
        Some("batch-stats") => {
            let dir = args.get(1).cloned().unwrap_or_default();
            let files = walk_files(&dir, &["mid", "midi"]);
            let mut arr = Vec::new();
            for f in &files {
                if let Ok(bytes) = fs::read(f) {
                    match stat_smf(&bytes) {
                        Ok(s) => arr.push(format!(
                            r#"{{"file":{},"format":{},"tracks":{},"notes":{},"bpm":{:.2},"min_midi":{},"max_midi":{},"avg_vel":{:.1}}}"#,
                            json_str(f), s.format, s.tracks, s.notes, s.bpm, s.min_midi, s.max_midi, s.avg_vel
                        )),
                        Err(e) => arr.push(format!(r#"{{"file":{},"ok":false,"error":{}}}"#, json_str(f), json_str(&e))),
                    }
                }
            }
            format!(r#"{{"ok":true,"count":{},"files":[{}]}}"#, arr.len(), arr.join(","))
        }
        Some("hash-batch") => {
            let dir = args.get(1).cloned().unwrap_or_default();
            let files = walk_files(&dir, &["mid", "midi", "sf2", "sf3", "wav", "mp3", "flac"]);
            let mut arr = Vec::new();
            for f in &files {
                if let Ok(bytes) = fs::read(f) {
                    arr.push(format!(r#"{{"file":{},"hash":{:016x},"size":{}}}"#, json_str(f), fnv1a(&bytes), bytes.len()));
                }
            }
            format!(r#"{{"ok":true,"count":{},"files":[{}]}}"#, arr.len(), arr.join(","))
        }
        _ => r#"{"ok":false,"error":"unknown command"}"#.to_string(),
    };
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    writeln!(handle, "{}", out).expect("write stdout");
}

fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
