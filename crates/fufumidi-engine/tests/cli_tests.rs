use std::fs;
use std::io::{Cursor, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use fufumidi_core::{parse_smf, EventKind};
use fufumidi_engine::cli::dispatch;
use fufumidi_engine::protocol::{handle_line, result_line, run};
use serde_json::Value;
use sha2::{Digest, Sha256};

// ---------- 临时目录 ----------

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(tag: &str) -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "fufumidi-engine-test-{tag}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create temp dir");
        Self { path }
    }

    fn join(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }

    fn as_str(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

// ---------- 测试侧 SMF 字节构造器 ----------

fn vlq(mut value: u32) -> Vec<u8> {
    let mut buffer = [0u8; 5];
    let mut index = 4usize;
    buffer[index] = (value & 0x7f) as u8;
    loop {
        value >>= 7;
        if value == 0 {
            break;
        }
        index -= 1;
        buffer[index] = ((value & 0x7f) as u8) | 0x80;
    }
    buffer[index..].to_vec()
}

fn track_bytes(events: &[(u32, Vec<u8>)]) -> Vec<u8> {
    let mut data = Vec::new();
    let mut previous = 0u32;
    for (tick, bytes) in events {
        data.extend_from_slice(&vlq(tick.saturating_sub(previous)));
        data.extend_from_slice(bytes);
        previous = *tick;
    }
    data
}

fn build_smf(format: u16, ticks_per_beat: u16, tracks: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"MThd");
    out.extend_from_slice(&6u32.to_be_bytes());
    out.extend_from_slice(&format.to_be_bytes());
    out.extend_from_slice(&(tracks.len() as u16).to_be_bytes());
    out.extend_from_slice(&ticks_per_beat.to_be_bytes());
    for data in tracks {
        out.extend_from_slice(b"MTrk");
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(data);
    }
    out
}

fn note_on(channel: u8, note: u8, velocity: u8) -> Vec<u8> {
    vec![0x90 | (channel & 0x0f), note, velocity]
}

fn note_off(channel: u8, note: u8, velocity: u8) -> Vec<u8> {
    vec![0x80 | (channel & 0x0f), note, velocity]
}

fn tempo(tempo_us: u32) -> Vec<u8> {
    vec![
        0xff,
        0x51,
        0x03,
        (tempo_us >> 16) as u8,
        (tempo_us >> 8) as u8,
        tempo_us as u8,
    ]
}

fn end_of_track() -> Vec<u8> {
    vec![0xff, 0x2f, 0x00]
}

fn format_one_fixture() -> Vec<u8> {
    build_smf(
        1,
        480,
        &[
            track_bytes(&[(0, tempo(500_000)), (0, end_of_track())]),
            track_bytes(&[
                (0, note_on(0, 60, 100)),
                (240, note_on(0, 64, 80)),
                (480, note_off(0, 60, 0)),
                (480, note_off(0, 64, 0)),
                (480, end_of_track()),
            ]),
        ],
    )
}

fn quantize_fixture() -> Vec<u8> {
    build_smf(
        0,
        480,
        &[track_bytes(&[
            (100, note_on(0, 60, 64)),
            (580, note_off(0, 60, 0)),
            (580, end_of_track()),
        ])],
    )
}

fn write_midi(dir: &TempDir, name: &str) -> String {
    let path = dir.join(name);
    fs::write(&path, format_one_fixture()).expect("write fixture");
    path.to_string_lossy().into_owned()
}

// ---------- 旧 CLI 兼容 ----------

#[test]
fn ping_and_version_match_legacy_contract() {
    let ping = dispatch(&["ping".to_string()]);
    assert_eq!(ping["ok"], true);
    assert_eq!(ping["service"], "fufumidi-core");
    assert_eq!(ping["version"], env!("CARGO_PKG_VERSION"));

    let version = dispatch(&["version".to_string()]);
    assert_eq!(version["ok"], true);
    assert_eq!(version["version"], env!("CARGO_PKG_VERSION"));

    let ready = handle_line(r#"{"id":7,"cmd":"ready"}"#)
        .expect("ready response")
        .value;
    assert_eq!(ready["id"], 7);
    assert_eq!(ready["service"], "fufumidi-engine");
    let capabilities = ready["capabilities"].as_array().expect("capabilities");
    assert!(capabilities.contains(&Value::String("midi-stats".to_string())));
}

#[test]
fn midi_stats_reports_generated_file() {
    let dir = TempDir::new("stats");
    let path = write_midi(&dir, "a.mid");

    let value = dispatch(&["midi-stats".to_string(), path]);
    assert_eq!(value["ok"], true);
    assert_eq!(value["format"], 1);
    assert_eq!(value["tracks"], 2);
    assert_eq!(value["notes"], 2);
    assert_eq!(value["bpm"], 120.0);
    assert_eq!(value["min_midi"], 60);
    assert_eq!(value["max_midi"], 64);
    assert_eq!(value["avg_vel"], 90.0);
    assert_eq!(value["avg_dur_ticks"], 360.0);
    let text = serde_json::to_string(&value).expect("serialize");
    assert!(!text.contains("NaN") && !text.contains("inf"));
}

#[test]
fn midi_stats_rejects_missing_file() {
    let value = dispatch(&[
        "midi-stats".to_string(),
        "E:/definitely/not/here.mid".to_string(),
    ]);
    assert_eq!(value["ok"], false);
    assert!(!value["error"].as_str().expect("error").is_empty());
}

#[test]
fn batch_stats_flags_broken_files() {
    let dir = TempDir::new("batch-stats");
    let good = write_midi(&dir, "good.mid");
    let bad_path = dir.join("broken.mid");
    fs::write(&bad_path, b"this is not midi").expect("write broken");

    let value = dispatch(&["batch-stats".to_string(), dir.as_str()]);
    assert_eq!(value["ok"], true);
    assert_eq!(value["count"], 2);
    let rows = value["files"].as_array().expect("files");
    let good_row = rows
        .iter()
        .find(|row| row["file"] == good)
        .expect("good row");
    assert!(good_row.get("ok").is_none(), "success rows omit ok");
    assert_eq!(good_row["notes"], 2);
    assert!(good_row["size"].as_u64().expect("size") > 0);

    let bad_row = rows
        .iter()
        .find(|row| row["file"] == bad_path.to_string_lossy().as_ref())
        .expect("bad row");
    assert_eq!(bad_row["ok"], false);
    assert!(bad_row["error"]
        .as_str()
        .expect("error")
        .contains("not a MIDI file"));
}

#[test]
fn hash_batch_outputs_sha256_hex() {
    let dir = TempDir::new("hash");
    let empty = dir.join("empty.mid");
    fs::write(&empty, b"").expect("write empty");

    let value = dispatch(&["hash-batch".to_string(), dir.as_str()]);
    assert_eq!(value["ok"], true);
    assert_eq!(value["count"], 1);
    let rows = value["files"].as_array().expect("files");
    assert_eq!(
        rows[0]["hash"],
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(rows[0]["size"], 0);

    let non_empty = dir.join("a.mid");
    fs::write(&non_empty, format_one_fixture()).expect("write midi");
    let expected = format!("{:x}", Sha256::digest(format_one_fixture()));
    let value = dispatch(&["hash-batch".to_string(), dir.as_str()]);
    let rows = value["files"].as_array().expect("files");
    let row = rows
        .iter()
        .find(|row| row["file"] == non_empty.to_string_lossy().as_ref())
        .expect("midi row");
    assert_eq!(row["hash"], expected);
}

#[test]
fn quantize_batch_writes_quantized_copy() {
    let dir = TempDir::new("quantize");
    let input = dir.join("in");
    fs::create_dir_all(&input).expect("mkdir in");
    fs::write(input.join("a.mid"), quantize_fixture()).expect("write input");
    let output = dir.join("out");

    let value = dispatch(&[
        "quantize-batch".to_string(),
        input.to_string_lossy().into_owned(),
        output.to_string_lossy().into_owned(),
        "8".to_string(),
    ]);
    assert_eq!(value["ok"], true);
    assert_eq!(value["mode"], "quantize");
    assert_eq!(value["arg"], 8);
    assert_eq!(value["count"], 1);
    assert_eq!(value["files"][0]["ok"], true);

    let bytes = fs::read(output.join("a.mid")).expect("read output");
    let parsed = parse_smf(&bytes).expect("parse output");
    assert_eq!(parsed.tracks[0].events[0].tick, 0);
    assert_eq!(parsed.tracks[0].events[1].tick, 480);
}

#[test]
fn quantize_batch_defaults_to_eighth_notes() {
    let dir = TempDir::new("quantize-default");
    let input = dir.join("in");
    fs::create_dir_all(&input).expect("mkdir in");
    fs::write(input.join("a.mid"), quantize_fixture()).expect("write input");
    let output = dir.join("out");

    let value = dispatch(&[
        "quantize-batch".to_string(),
        input.to_string_lossy().into_owned(),
        output.to_string_lossy().into_owned(),
    ]);
    assert_eq!(value["arg"], 8);
    let parsed = parse_smf(&fs::read(output.join("a.mid")).expect("read output")).expect("parse");
    assert_eq!(parsed.tracks[0].events[0].tick, 0);
}

#[test]
fn transpose_batch_writes_transposed_copy() {
    let dir = TempDir::new("transpose");
    let input = dir.join("in");
    fs::create_dir_all(&input).expect("mkdir in");
    fs::write(input.join("a.mid"), format_one_fixture()).expect("write input");
    let output = dir.join("out");

    let value = dispatch(&[
        "transpose-batch".to_string(),
        input.to_string_lossy().into_owned(),
        output.to_string_lossy().into_owned(),
        "-12".to_string(),
    ]);
    assert_eq!(value["ok"], true);
    assert_eq!(value["mode"], "transpose");
    assert_eq!(value["arg"], -12);
    let parsed = parse_smf(&fs::read(output.join("a.mid")).expect("read output")).expect("parse");
    let notes: Vec<u8> = parsed.tracks[1]
        .events
        .iter()
        .filter_map(|event| event.kind.note())
        .collect();
    assert_eq!(notes, vec![48, 52, 48, 52]);
}

#[test]
fn transpose_batch_defaults_to_one_octave() {
    let dir = TempDir::new("transpose-default");
    let input = dir.join("in");
    fs::create_dir_all(&input).expect("mkdir in");
    fs::write(input.join("a.mid"), format_one_fixture()).expect("write input");
    let output = dir.join("out");

    let value = dispatch(&[
        "transpose-batch".to_string(),
        input.to_string_lossy().into_owned(),
        output.to_string_lossy().into_owned(),
    ]);
    assert_eq!(value["arg"], 12);
    let parsed = parse_smf(&fs::read(output.join("a.mid")).expect("read output")).expect("parse");
    assert_eq!(
        parsed.tracks[1].events[0].kind,
        EventKind::NoteOn {
            channel: 0,
            note: 72,
            velocity: 100,
        }
    );
}

#[test]
fn batch_transforms_handle_empty_directory() {
    let dir = TempDir::new("empty");
    let input = dir.join("in");
    fs::create_dir_all(&input).expect("mkdir in");
    let output = dir.join("out");
    let value = dispatch(&[
        "quantize-batch".to_string(),
        input.to_string_lossy().into_owned(),
        output.to_string_lossy().into_owned(),
    ]);
    assert_eq!(value["ok"], true);
    assert_eq!(value["count"], 0);
    assert_eq!(value["files"].as_array().expect("files").len(), 0);
}

#[test]
fn help_lists_all_commands_and_aliases() {
    let help = dispatch(&["--help".to_string()]);
    assert_eq!(help["ok"], true);
    let commands = help["commands"].as_array().expect("commands");
    assert!(commands.len() >= 7);
    let aliases = help["json_lines"]["aliases"].as_array().expect("aliases");
    assert!(aliases.contains(&Value::String("--json-lines".to_string())));
    assert!(fufumidi_engine::cli::wants_json_lines(&[
        "serve".to_string()
    ]));
    assert!(fufumidi_engine::cli::wants_json_lines(&[
        "--stdin".to_string()
    ]));
    assert!(!fufumidi_engine::cli::wants_json_lines(&[
        "ping".to_string()
    ]));
}

#[test]
fn unknown_command_is_json_error() {
    let value = dispatch(&["definitely-not-a-command".to_string()]);
    assert_eq!(value["ok"], false);
    assert_eq!(value["error"], "unknown command");
}

// ---------- JSON 行协议 ----------

#[test]
fn json_lines_echoes_id_and_frames_result() {
    let response = handle_line(r#"{"id":11,"cmd":"ping","args":[]}"#).expect("response");
    assert!(!response.exit);
    assert_eq!(response.value["id"], 11);
    assert_eq!(response.value["ok"], true);

    let line = result_line(&response.value);
    assert!(line.starts_with("###RESULT {"), "framing: {line}");
    let body = &line["###RESULT ".len()..];
    let parsed: Value = serde_json::from_str(body).expect("parse framed json");
    assert_eq!(parsed["id"], 11);
    assert!(!line.contains('\n'));
}

#[test]
fn json_lines_accepts_argv_form_and_string_ids() {
    let response = handle_line(r#"{"id":"req-9","argv":["version"]}"#).expect("response");
    assert_eq!(response.value["id"], "req-9");
    assert_eq!(response.value["version"], env!("CARGO_PKG_VERSION"));
}

#[test]
fn json_lines_rejects_bad_json_and_missing_command() {
    let bad = handle_line("{not json").expect("response");
    assert_eq!(bad.value["id"], Value::Null);
    assert_eq!(bad.value["ok"], false);
    assert!(bad.value["error"]
        .as_str()
        .expect("error")
        .starts_with("invalid json:"));

    let missing = handle_line(r#"{"id":3}"#).expect("response");
    assert_eq!(missing.value["id"], 3);
    assert_eq!(missing.value["error"], "missing cmd");

    let unknown = handle_line(r#"{"id":4,"cmd":"nope"}"#).expect("response");
    assert_eq!(unknown.value["id"], 4);
    assert_eq!(unknown.value["ok"], false);
    assert_eq!(unknown.value["error"], "unknown command");
}

#[test]
fn json_lines_exit_marks_response() {
    let response = handle_line(r#"{"id":9,"cmd":"exit"}"#).expect("response");
    assert!(response.exit);
    assert_eq!(response.value["id"], 9);
    assert_eq!(response.value["exiting"], true);
}

#[test]
fn json_lines_run_processes_multiple_requests() {
    let input = Cursor::new(
        r#"{"id":1,"cmd":"ping"}

{"id":2,"cmd":"version"}
{"id":3,"cmd":"exit"}
"#,
    );
    let mut output = Vec::new();
    let code = run(input, &mut output);
    assert_eq!(code, 0);
    let text = String::from_utf8(output).expect("utf8");
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 3, "blank line ignored: {text}");
    assert!(lines[0].starts_with("###RESULT "));
    assert!(lines[1].starts_with("###RESULT "));
    assert!(lines[2].contains(r#""exiting":true"#));
}

#[test]
fn spawned_cli_prints_single_line_json() {
    let dir = TempDir::new("spawn-cli");
    let path = write_midi(&dir, "a.mid");
    let output = Command::new(env!("CARGO_BIN_EXE_fufumidi-engine"))
        .arg("midi-stats")
        .arg(&path)
        .output()
        .expect("run engine");
    assert!(output.status.success(), "exit status: {:?}", output.status);
    let text = String::from_utf8_lossy(&output.stdout);
    assert_eq!(text.lines().count(), 1, "one line only: {text}");
    let value: Value = serde_json::from_str(text.trim()).expect("json output");
    assert_eq!(value["ok"], true);
    assert_eq!(value["notes"], 2);
}

#[test]
fn spawned_binary_speaks_json_lines_end_to_end() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_fufumidi-engine"))
        .arg("--json-lines")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn engine");
    {
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin
            .write_all(b"{\"id\":1,\"cmd\":\"ping\"}\n")
            .expect("write ping");
        stdin
            .write_all(b"{\"id\":2,\"cmd\":\"exit\"}\n")
            .expect("write exit");
        stdin.flush().expect("flush");
    }
    drop(child.stdin.take());
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success());
    let text = String::from_utf8_lossy(&output.stdout);
    let results: Vec<&str> = text
        .lines()
        .filter(|line| line.starts_with("###RESULT "))
        .collect();
    assert_eq!(results.len(), 2, "stdout: {text}");
    let first: Value =
        serde_json::from_str(&results[0]["###RESULT ".len()..]).expect("parse first");
    assert_eq!(first["id"], 1);
    assert_eq!(first["ok"], true);
    let second: Value =
        serde_json::from_str(&results[1]["###RESULT ".len()..]).expect("parse second");
    assert_eq!(second["id"], 2);
    assert_eq!(second["exiting"], true);
}
