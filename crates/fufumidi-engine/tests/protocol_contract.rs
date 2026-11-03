//! JSON 行协议契约测试（sidecar 接入前第一道闸）。

use fufumidi_engine::protocol::{handle_line, result_line};

#[test]
fn ping_keeps_id_and_ok() {
    let r = handle_line(r#"{"id":7,"cmd":"ping"}"#).expect("response");
    assert!(!r.exit);
    assert_eq!(r.value["id"], 7);
    assert_eq!(r.value["ok"], true);
}

#[test]
fn argv_style_is_accepted() {
    let r = handle_line(r#"{"id":3,"argv":["version"]}"#).expect("response");
    assert_eq!(r.value["id"], 3);
    assert_eq!(r.value["ok"], true);
}

#[test]
fn unknown_command_is_error_not_panic() {
    let r = handle_line(r#"{"id":9,"cmd":"no-such-cmd"}"#).expect("response");
    assert_eq!(r.value["id"], 9);
    assert_eq!(r.value["ok"], false);
}

#[test]
fn invalid_json_returns_error_response() {
    let r = handle_line("{oops}").expect("response");
    assert_eq!(r.value["ok"], false);
}

#[test]
fn exit_sets_exit_flag() {
    let r = handle_line(r#"{"id":1,"cmd":"exit"}"#).expect("response");
    assert!(r.exit);
    assert_eq!(r.value["ok"], true);
}

#[test]
fn result_line_prefix_and_valid_json() {
    let r = handle_line(r#"{"id":1,"cmd":"ping"}"#).expect("response");
    let line = result_line(&r.value);
    assert!(line.starts_with("###RESULT "));
    let body = &line["###RESULT ".len()..];
    let v: serde_json::Value = serde_json::from_str(body).expect("valid json after prefix");
    assert_eq!(v["ok"], true);
}

#[test]
fn empty_line_is_ignored() {
    assert!(handle_line("   ").is_none());
}
