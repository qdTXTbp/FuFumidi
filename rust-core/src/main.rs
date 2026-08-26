use std::env;
use std::io::{self, Write};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let out = match args.first().map(|s| s.as_str()) {
        Some("ping") => r#"{"ok":true,"service":"fufumidi-core","version":"0.1.0"}"#,
        Some("version") => r#"{"ok":true,"version":"0.1.0"}"#,
        _ => r#"{"ok":false,"error":"unknown command"}"#,
    };
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    writeln!(handle, "{}", out).expect("write stdout");
}
