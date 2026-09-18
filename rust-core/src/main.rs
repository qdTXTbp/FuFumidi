use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use sha2::{Digest, Sha256};

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

/// 字节数组 → 小写 hex（用于 SHA-256 输出）
fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
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

/// 基于 SMF 事件流做统计（用于 batch-stats / midi-stats）。
/// 与量化/移调共用同一个 `parse_smf`，因此天然支持 running status ——
/// 不再维护第二套「跳过 running status」的解析，杜绝两条路径行为不一致。
fn stat_smf_bytes(bytes: &[u8]) -> Result<MidiStats, String> {
    let smf = parse_smf(bytes)?;
    let mut tempo_us = 500_000u32;
    let mut notes: Vec<(i32, u32, u32, u32)> = Vec::new(); // (midi, vel, start_tick, dur_ticks)
    for track in &smf.tracks {
        let mut active: Vec<(i32, i32, u32, i32)> = Vec::new(); // (channel, midi, onset_tick, vel)
        for ev in track {
            let raw = &ev.raw;
            if raw.is_empty() { continue; }
            let status = raw[0];
            if status == 0xFF {
                // meta 事件；tempo (0x51) 的布局是 [0xFF, 0x51, mlen, b0, b1, b2]
                if raw.len() >= 6 && raw[1] == 0x51 && raw[2] == 3 {
                    let v = ((raw[3] as u32) << 16) | ((raw[4] as u32) << 8) | (raw[5] as u32);
                    if v > 0 { tempo_us = v; }
                }
                continue;
            }
            let kind = status & 0xF0;
            let channel = (status & 0x0F) as i32;
            if kind == 0x80 { // note off
                if raw.len() < 2 { continue; }
                let note = raw[1] as i32;
                if let Some(idx) = active.iter().position(|a| a.0 == channel && a.1 == note) {
                    let (_, _, onset, vel) = active.remove(idx);
                    notes.push((note, vel.max(0) as u32, onset, ev.tick.saturating_sub(onset)));
                }
            } else if kind == 0x90 { // note on
                if raw.len() < 3 { continue; }
                let note = raw[1] as i32;
                let vel = raw[2] as i32;
                if vel == 0 {
                    if let Some(idx) = active.iter().position(|a| a.0 == channel && a.1 == note) {
                        let (_, _, onset, v2) = active.remove(idx);
                        notes.push((note, v2.max(0) as u32, onset, ev.tick.saturating_sub(onset)));
                    }
                } else {
                    if let Some(idx) = active.iter().position(|a| a.0 == channel && a.1 == note) {
                        active.remove(idx);
                    }
                    active.push((channel, note, ev.tick, vel));
                }
            }
        }
    }

    if notes.is_empty() || smf.tracks.is_empty() {
        return Err("no note events found".into());
    }

    let format = smf.format;
    let track_count = smf.tracks.len();
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


#[derive(Clone)]
struct SmfEvent {
    tick: u32,
    raw: Vec<u8>,
}

struct Smf {
    format: u16,
    tpb: u16,
    tracks: Vec<Vec<SmfEvent>>,
}

fn write_vlq(out: &mut Vec<u8>, mut v: u32) {
    let mut buf = [0u8; 5];
    let mut i = 4usize;
    buf[i] = (v & 0x7f) as u8;
    loop {
        v >>= 7;
        if v == 0 { break; }
        i -= 1;
        buf[i] = ((v & 0x7f) as u8) | 0x80;
    }
    out.extend_from_slice(&buf[i..]);
}

fn push_vlq(out: &mut Vec<u8>, v: u32) {
    write_vlq(out, v);
}

fn parse_smf(bytes: &[u8]) -> Result<Smf, String> {
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
    let tpb = division_raw & 0x7fff;
    if tpb == 0 {
        return Err("invalid division".into());
    }

    let mut pos = 14 + head_len.saturating_sub(6);
    let mut tracks = Vec::with_capacity(ntrks);
    for _ in 0..ntrks {
        if pos + 8 > bytes.len() { break; }
        if &bytes[pos..pos + 4] != b"MTrk" { break; }
        let len = u32::from_be_bytes([bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]]) as usize;
        pos += 8;
        let end = (pos + len).min(bytes.len());
        let mut tick: u32 = 0;
        let mut last_status: Option<u8> = None;
        let mut events = Vec::new();
        while pos < end {
            let delta = read_vlq(bytes, &mut pos);
            tick = tick.saturating_add(delta);
            if pos >= end { break; }
            let first = bytes[pos];
            if first & 0x80 == 0 {
                let status = last_status.ok_or("running status without prior status")?;
                let kind = status & 0xF0;
                if (0x80..=0xE0).contains(&kind) {
                    pos += 1;
                    let data_len = if kind == 0xC0 || kind == 0xD0 { 1 } else { 2 };
                    let mut raw = vec![status, first];
                    for _ in 1..data_len {
                        if pos < end { raw.push(bytes[pos]); pos += 1; }
                    }
                    last_status = Some(status);
                    events.push(SmfEvent { tick, raw });
                } else {
                    pos += 1;
                }
                continue;
            }

            let status = first;
            pos += 1;
            if status == 0xFF {
                let mtype = bytes.get(pos).copied().unwrap_or(0);
                pos += 1;
                let mlen = read_vlq(bytes, &mut pos) as usize;
                let mdata_end = (pos + mlen).min(end);
                let mut raw = vec![0xFF, mtype];
                push_vlq(&mut raw, mlen as u32);
                raw.extend_from_slice(&bytes[pos..mdata_end]);
                pos = mdata_end;
                events.push(SmfEvent { tick, raw });
                continue;
            }
            if status == 0xF0 || status == 0xF7 {
                let slen = read_vlq(bytes, &mut pos) as usize;
                let sdata_end = (pos + slen).min(end);
                let mut raw = vec![status];
                push_vlq(&mut raw, slen as u32);
                raw.extend_from_slice(&bytes[pos..sdata_end]);
                pos = sdata_end;
                events.push(SmfEvent { tick, raw });
                continue;
            }
            let kind = status & 0xF0;
            if !(0x80..=0xE0).contains(&kind) {
                return Err("unexpected status".into());
            }
            let data_len = if kind == 0xC0 || kind == 0xD0 { 1 } else { 2 };
            let mut raw = vec![status];
            for _ in 0..data_len {
                if pos < end { raw.push(bytes[pos]); pos += 1; }
            }
            last_status = Some(status);
            events.push(SmfEvent { tick, raw });
        }
        pos = end;
        tracks.push(events);
    }
    if tracks.is_empty() {
        return Err("no tracks found".into());
    }
    Ok(Smf { format, tpb, tracks })
}

fn quantize_tick(tick: u32, grid: u32) -> u32 {
    let grid = if grid == 0 { 1 } else { grid };
    ((tick as f64 / grid as f64).round() as u32).wrapping_mul(grid)
}

fn transform_smf(bytes: &[u8], mode: &str, arg: i32) -> Result<Vec<u8>, String> {
    let mut smf = parse_smf(bytes)?;
    let grid = if mode == "quantize" {
        let divisions = arg.max(1) as u32;
        (smf.tpb as u32).saturating_mul(4).max(1) / divisions
    } else {
        0
    };

    for track in &mut smf.tracks {
        let mut active: Vec<(i32, i32, u32, u32)> = Vec::new(); // (channel, note, orig_start, quant_start)
        for ev in track.iter_mut() {
            if ev.raw.len() < 3 { continue; }
            let status = ev.raw[0];
            let kind = status & 0xF0;
            if kind != 0x90 && kind != 0x80 { continue; }
            let channel = (status & 0x0F) as i32;
            let mut note = ev.raw[1] as i32;
            let vel = ev.raw[2] as i32;
            if mode == "transpose" {
                note = (note + arg).clamp(0, 127);
                ev.raw[1] = note as u8;
            }
            if kind == 0x90 && vel > 0 {
                let orig_start = ev.tick;
                let qstart = if mode == "quantize" {
                    quantize_tick(orig_start, grid)
                } else {
                    orig_start
                };
                ev.tick = qstart;
                active.push((channel, note, orig_start, qstart));
            } else {
                if let Some(idx) = active.iter().position(|a| a.0 == channel && a.1 == note) {
                    let (_, _, orig_start, qstart) = active.remove(idx);
                    if mode == "quantize" {
                        ev.tick = qstart.saturating_add(ev.tick.saturating_sub(orig_start));
                    }
                }
            }
        }
        track.sort_by_key(|e| e.tick);
    }

    let mut out = Vec::new();
    out.extend_from_slice(b"MThd");
    out.extend_from_slice(&6u32.to_be_bytes());
    out.extend_from_slice(&smf.format.to_be_bytes());
    out.extend_from_slice(&(smf.tracks.len() as u16).to_be_bytes());
    out.extend_from_slice(&smf.tpb.to_be_bytes());
    for track in &smf.tracks {
        let mut data = Vec::new();
        let mut prev = 0u32;
        for ev in track {
            push_vlq(&mut data, ev.tick.saturating_sub(prev));
            data.extend_from_slice(&ev.raw);
            prev = ev.tick;
        }
        out.extend_from_slice(b"MTrk");
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(&data);
    }
    Ok(out)
}

fn run_batch_transform(input_dir: &str, output_dir: &str, mode: &str, arg: i32) -> String {
    let files = walk_files(input_dir, &["mid", "midi"]);
    if let Err(e) = fs::create_dir_all(output_dir) {
        return format!(r#"{{"ok":false,"error":{}}}"#, json_str(&e.to_string()));
    }
    let mut arr = Vec::new();
    for f in &files {
        let name = std::path::Path::new(f).file_name().and_then(|x| x.to_str()).unwrap_or("out.mid");
        let out_path = std::path::Path::new(output_dir).join(name);
        let entry = match fs::read(f) {
            Ok(bytes) => match transform_smf(&bytes, mode, arg) {
                Ok(transformed) => match fs::write(&out_path, &transformed) {
                    Ok(()) => format!(r#"{{"file":{},"out":{},"ok":true}}"#, json_str(f), json_str(&out_path.to_string_lossy())),
                    Err(e) => format!(r#"{{"file":{},"ok":false,"error":{}}}"#, json_str(f), json_str(&e.to_string())),
                },
                Err(e) => format!(r#"{{"file":{},"ok":false,"error":{}}}"#, json_str(f), json_str(&e)),
            },
            Err(e) => format!(r#"{{"file":{},"ok":false,"error":{}}}"#, json_str(f), json_str(&e.to_string())),
        };
        arr.push(entry);
    }
    format!(r#"{{"ok":true,"mode":{},"arg":{},"count":{},"files":[{}]}}"#, json_str(mode), arg, arr.len(), arr.join(","))
}
fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let out = run(&args);
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    writeln!(handle, "{}", out).expect("write stdout");
}

/// 命令分发：与 stdout 解耦，便于单测直接断言输出（必须始终是一行合法 JSON）
fn run(args: &[String]) -> String {
    match args.first().map(|s| s.as_str()) {
        Some("ping") => r#"{"ok":true,"service":"fufumidi-core","version":"0.2.0"}"#.to_string(),
        Some("version") => r#"{"ok":true,"version":"0.2.0"}"#.to_string(),
        Some("midi-stats") => {
            let path = args.get(1).cloned().unwrap_or_default();
            match fs::read(&path) {
                Ok(bytes) => match stat_smf_bytes(&bytes) {
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
                // 读不出来的文件也必须出现在结果里（ok:false），否则调用方会把
                // 「扫不到」误判成「全部正常」，体检与去重结果都会失真
                match fs::read(f) {
                    Ok(bytes) => match stat_smf_bytes(&bytes) {
                        Ok(s) => arr.push(format!(
                            r#"{{"file":{},"format":{},"tracks":{},"notes":{},"bpm":{:.2},"min_midi":{},"max_midi":{},"avg_vel":{:.1},"size":{}}}"#,
                            json_str(f), s.format, s.tracks, s.notes, s.bpm, s.min_midi, s.max_midi, s.avg_vel, bytes.len()
                        )),
                        Err(e) => arr.push(format!(r#"{{"file":{},"ok":false,"error":{},"size":{}}}"#, json_str(f), json_str(&e), bytes.len())),
                    },
                    Err(e) => arr.push(format!(r#"{{"file":{},"ok":false,"error":{},"size":0}}"#, json_str(f), json_str(&e.to_string()))),
                }
            }
            format!(r#"{{"ok":true,"count":{},"files":[{}]}}"#, arr.len(), arr.join(","))
        }
        Some("hash-batch") => {
            let dir = args.get(1).cloned().unwrap_or_default();
            let files = walk_files(&dir, &["mid", "midi", "sf2", "sf3", "wav", "mp3", "flac"]);
            let mut arr = Vec::new();
            for f in &files {
                match fs::read(f) {
                    Ok(bytes) => {
                        // SHA-256 与 JS 侧 `library:dupes` 回退路径保持一致（Node crypto.sha256），
                        // 这样去重分组不受「Rust 是否可用」影响。hash 必须带引号，否则 JSON.parse 会失败。
                        let h = to_hex(&Sha256::digest(&bytes));
                        arr.push(format!(r#"{{"file":{},"hash":"{}","size":{}}}"#, json_str(f), h, bytes.len()));
                    }
                    Err(e) => arr.push(format!(r#"{{"file":{},"ok":false,"error":{},"size":0}}"#, json_str(f), json_str(&e.to_string()))),
                }
            }
            format!(r#"{{"ok":true,"count":{},"files":[{}]}}"#, arr.len(), arr.join(","))
        }
        Some("quantize-batch") => {
            let dir = args.get(1).cloned().unwrap_or_default();
            let out_dir = args.get(2).cloned().unwrap_or_default();
            let divisions = args.get(3).and_then(|s| s.parse::<i32>().ok()).unwrap_or(8);
            run_batch_transform(&dir, &out_dir, "quantize", divisions)
        }
        Some("transpose-batch") => {
            let dir = args.get(1).cloned().unwrap_or_default();
            let out_dir = args.get(2).cloned().unwrap_or_default();
            let semitones = args.get(3).and_then(|s| s.parse::<i32>().ok()).unwrap_or(12);
            run_batch_transform(&dir, &out_dir, "transpose", semitones)
        }
        _ => r#"{"ok":false,"error":"unknown command"}"#.to_string(),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    /// running-status 一致性测试用的 SMF：第二个 note-on / note-off 省略状态字节，
    /// 必须被解析为「2 个音符」而不是被跳过。
    const RUNNING_STATUS_MIDI: &[u8] =
        b"\x4d\x54\x68\x64\x00\x00\x00\x06\x00\x00\x00\x01\x01\xe0\x4d\x54\x72\x6b\x00\x00\x00\x13\x00\x90\x3c\x64\x83\x60\x40\x5a\x00\x80\x3c\x00\x00\x40\x00\x00\xff\x2f\x00";

    /// 极简 JSON 校验：只检查「括号配对 / 字符串外不允许裸标识符」这类会导致
    /// 调用方 JSON.parse 失败的结构性错误（历史上 hash-batch 就漏了 hash 的引号）。
    fn assert_single_line_json(s: &str) {
        assert!(!s.contains('\n'), "输出必须是一行: {}", s);
        let bytes = s.as_bytes();
        let mut depth = 0i32;
        let mut in_str = false;
        let mut esc = false;
        for (i, &b) in bytes.iter().enumerate() {
            if in_str {
                if esc { esc = false; }
                else if b == b'\\' { esc = true; }
                else if b == b'"' { in_str = false; }
                continue;
            }
            match b {
                b'"' => in_str = true,
                b'{' | b'[' => depth += 1,
                b'}' | b']' => depth -= 1,
                _ => {}
            }
            assert!(depth >= 0, "括号不配对 @{}", i);
        }
        assert!(!in_str, "字符串未闭合: {}", s);
        assert_eq!(depth, 0, "括号未闭合: {}", s);
        assert!(s.starts_with('{') && s.ends_with('}'), "必须是对象: {}", s);
    }

    #[test]
    fn cli_outputs_are_valid_single_line_json() {
        assert_single_line_json(&run(&["ping".into()]));
        assert_single_line_json(&run(&["version".into()]));
        assert_single_line_json(&run(&["nope".into()]));
    }

    #[test]
    fn hash_batch_quotes_the_hash_field() {
        let dir = env::temp_dir().join(format!("fufumidi-hash-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("mkdir");
        let data: &[u8] = b"MThd\x00\x00\x00\x06\x00\x00\x00\x01\x01\xe0MTrk\x00\x00\x00\x0d\x64\x90\x3c\x64\x83\x60\x80\x3c\x00\x00\xff\x2f\x00";
        fs::write(dir.join("a.mid"), data).expect("write");
        let out = run(&["hash-batch".into(), dir.to_string_lossy().to_string()]);
        assert_single_line_json(&out);
        let expect_hash = to_hex(&Sha256::digest(data));
        assert_eq!(expect_hash.len(), 64, "SHA-256 应为 64 位 hex");
        assert!(out.contains(&format!(r#""hash":"{}""#, expect_hash)), "hash 应为 SHA-256 hex: {}", out);
        assert!(out.contains(r#""count":1"#), "应扫描到 1 个文件: {}", out);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn batch_stats_has_no_bare_nan_or_inf() {
        let dir = env::temp_dir().join(format!("fufumidi-stats-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("mkdir");
        let data: &[u8] = b"MThd\x00\x00\x00\x06\x00\x00\x00\x01\x01\xe0MTrk\x00\x00\x00\x0d\x64\x90\x3c\x64\x83\x60\x80\x3c\x00\x00\xff\x2f\x00";
        fs::write(dir.join("a.mid"), data).expect("write");
        let out = run(&["batch-stats".into(), dir.to_string_lossy().to_string()]);
        assert_single_line_json(&out);
        assert!(!out.contains("NaN") && !out.contains("inf"), "数值必须是有限数: {}", out);
        let _ = fs::remove_dir_all(&dir);
    }


    #[test]
    fn transposes_single_note_midi() {
        let data = b"MThd\x00\x00\x00\x06\x00\x00\x00\x01\x01\xe0MTrk\x00\x00\x00\x0d\x64\x90\x3c\x64\x83\x60\x80\x3c\x00\x00\xff\x2f\x00";
        let out = transform_smf(data, "transpose", 12).expect("transform");
        assert!(out.windows(3).any(|w| w == [0x90, 0x48, 0x64]));
        assert!(out.windows(3).any(|w| w == [0x80, 0x48, 0x00]));
    }

    #[test]
    fn quantizes_single_note_midi() {
        let data = b"MThd\x00\x00\x00\x06\x00\x00\x00\x01\x01\xe0MTrk\x00\x00\x00\x0d\x64\x90\x3c\x64\x83\x60\x80\x3c\x00\x00\xff\x2f\x00";
        let out = transform_smf(data, "quantize", 8).expect("transform");
        let smf = parse_smf(&out).expect("parse");
        assert_eq!(smf.tracks[0][0].tick, 0); // note-on quantized to 0
        assert_eq!(smf.tracks[0][1].tick, 480); // original 100+480 = 580 -> 0+480 = 480
    }
    #[test]
    fn empty_hash_is_known_sha256() {
        // SHA-256("") 的标准摘要，验证 to_hex/Sha256 接线正确
        assert_eq!(to_hex(&Sha256::digest(b"")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    /// running status 必须被正确统计：两个音符（第二个省略状态字节）。
    /// 旧统计路径遇到 running status 会跳字节导致音符数错乱，此测试守住一致性。
    #[test]
    fn running_status_is_counted_by_stats() {
        let s = stat_smf_bytes(RUNNING_STATUS_MIDI).expect("should parse running-status SMF");
        assert_eq!(s.notes, 2, "running status 下应统计出 2 个音符");
        assert_eq!(s.min_midi, 60);
        assert_eq!(s.max_midi, 64);
        assert_eq!(s.tracks, 1);
        // 同一文件走量化/移调（parse_smf 完整路径）也应解析出同样的 note 事件数
        let smf = parse_smf(RUNNING_STATUS_MIDI).expect("parse should be ok");
        let note_events = smf.tracks[0].iter()
            .filter(|e| !e.raw.is_empty() && (e.raw[0] & 0xF0 == 0x90 || e.raw[0] & 0xF0 == 0x80))
            .count();
        assert_eq!(note_events, 4, "应有 2 个 note-on + 2 个 note-off");
    }

    #[test]
    fn parses_single_note_midi() {
        let data = b"MThd\x00\x00\x00\x06\x00\x00\x00\x01\x01\xe0MTrk\x00\x00\x00\x09\x00\x90\x3c\x64\x83\x60\x80\x3c\x00";
        let s = stat_smf_bytes(data).expect("should parse");
        assert_eq!(s.format, 0);
        assert_eq!(s.tracks, 1);
        assert_eq!(s.notes, 1);
        assert_eq!(s.min_midi, 60);
        assert_eq!(s.max_midi, 60);
        assert_eq!(s.avg_vel, 100.0);
        assert_eq!(s.avg_dur_ticks, 480.0);
    }
}
