//! 智能分轨：分轨 → 逐 stem 转录 → 合并。
//!
//! 与 Electron main/stem-workflow.js 同一顺序；失败返回 None，由 run_convert 回退整曲。
use super::*;

pub fn role_of(name: &str) -> &'static str {
    let s = name.to_ascii_lowercase();
    if s.contains("vocal") || s.contains("voice") { "vocals" }
    else if s.contains("drum") || s.contains("perc") { "drums" }
    else if s.contains("bass") { "bass" }
    else if s.contains("piano") || s.contains("keys") { "piano" }
    else if s.contains("guitar") { "guitar" }
    else { "other" }
}

pub fn pick_model() -> Option<String> {
    for id in ["htdemucs4_6stems", "htdemucs4"] {
        for sub in ["multi", "separate"] {
            if models_dir().join(sub).join(id).is_dir() { return Some(id.to_string()); }
        }
    }
    model_list().into_iter().find(|m| m.get("kind").and_then(|v| v.as_str()) == Some("separate") && m.get("exists").and_then(|v| v.as_bool()) == Some(true)).and_then(|m| m.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
}

fn run_worker(req: &serde_json::Value) -> Result<serde_json::Value, String> {
    let py = python_path().ok_or("python runtime not found")?;
    let eng = engine_dir().ok_or("engine directory not found")?;
    let mut cmd = Command::new(&py);
    cmd.current_dir(&eng).args(["music2midi.py", "worker"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).creation_flags(0x08000000);
    apply_engine_env(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() { use std::io::Write; if writeln!(stdin, "{}", req).is_err() { let _ = child.kill(); return Err("worker write failed".into()); } let _ = stdin.flush(); }
    let stdout = child.stdout.take().ok_or("worker stdout missing")?;
    let mut result = None;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(rest) = line.trim().strip_prefix("###RESULT ") { result = serde_json::from_str::<serde_json::Value>(rest).ok(); break; }
    }
    let _ = child.kill(); let _ = child.wait();
    result.ok_or_else(|| "worker did not return ###RESULT".to_string())
}

/// 返回 Some(合并结果) 表示成功；None 表示应回退整曲转录。
pub fn run(req: &serde_json::Value, app: Option<&AppHandle>) -> Option<serde_json::Value> {
    let audio = req.get("audio").and_then(|v| v.as_str()).filter(|s| !s.is_empty())?;
    let model = pick_model()?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let work = data_dir().join("temp").join(format!("fufumidi-stems-{stamp}"));
    let stems_dir = work.join("stems"); let midi_dir = work.join("midi");
    if std::fs::create_dir_all(&stems_dir).is_err() || std::fs::create_dir_all(&midi_dir).is_err() { return None; }
    let id = req.get("id").and_then(|v| v.as_str()).unwrap_or("stem");
    let emit = |stage: &str, percent: f64| {
        let text = match stage { "separate" => "正在分轨…", "transcribe" => "正在逐轨转录…", "done" => "完成", _ => stage };
        if let Some(a) = app { let _ = a.emit("engine:stem-progress", serde_json::json!({ "id": id, "stage": stage, "percent": percent, "text": text })); }
    };
    if let Some(a) = app { let _ = a.emit("engine:log", serde_json::json!({ "id": id, "line": format!("[分轨] 使用模型 {model}") })); }
    emit("separate", 0.0);
    let opts = serde_json::json!({ "audio": audio, "sep_model": model, "stems": ["vocals", "drums", "bass", "piano", "guitar", "other"], "format": "wav", "batch_size": 1, "normalize": true, "chunk_size": 926100, "num_overlap": 4 });
    let args = separate_args(&opts, &models_dir(), &stems_dir).ok()?;
    let py = python_path()?; let eng = engine_dir()?;
    let mut cmd = Command::new(&py);
    cmd.current_dir(&eng).args(["music2midi.py"]).args(&args).stdout(Stdio::piped()).stderr(Stdio::piped()).creation_flags(0x08000000);
    apply_engine_env(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() { return None; }
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let sep_ok = stdout.lines().rev().find_map(|l| l.trim().strip_prefix("###RESULT ").and_then(|r| serde_json::from_str::<serde_json::Value>(r).ok())).and_then(|r| r.get("ok").and_then(|v| v.as_bool())) == Some(true);
    if !sep_ok { return None; }
    emit("separate", 100.0);
    let mut files: Vec<PathBuf> = std::fs::read_dir(&stems_dir).ok()?.flatten().map(|e| e.path()).filter(|p| p.extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case("wav") || x.eq_ignore_ascii_case("flac")).unwrap_or(false)).collect();
    files.sort();
    if files.is_empty() { return None; }
    let mut built: Vec<serde_json::Value> = Vec::new();
    for (i, f) in files.iter().enumerate() {
        let name = f.file_stem().and_then(|x| x.to_str()).unwrap_or("stem").to_string();
        let mid = midi_dir.join(format!("{name}.mid"));
        let mut wreq = req.clone();
        if let Some(o) = wreq.as_object_mut() {
            o.insert("audio".into(), serde_json::json!(f.display().to_string()));
            o.insert("out".into(), serde_json::json!(mid.display().to_string()));
            o.insert("stemEnhance".into(), serde_json::json!(false));
            o.insert("forceSpawn".into(), serde_json::json!(true));
            o.insert("_id".into(), serde_json::json!(format!("{}-stem-{i}", id)));
        }
        if let Ok(r) = run_worker(&wreq) {
            if r.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                built.push(serde_json::json!({ "role": role_of(&name), "name": name, "midi": mid.display().to_string(), "noteCount": r.get("note_count").cloned().unwrap_or(serde_json::json!(0)) }));
            }
        }
        emit("transcribe", ((i + 1) as f64 / files.len() as f64) * 100.0);
    }
    if built.is_empty() { return None; }
    let manifest_in = work.join("stem-manifest.json");
    let _ = std::fs::write(&manifest_in, serde_json::to_string(&built).unwrap_or_default());
    let out_mid = req.get("out").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or_else(|| work.join("merged.mid"));
    let manifest_out = out_mid.with_extension("manifest.json");
    let budget = req.get("trackBudget").and_then(|v| v.as_str()).unwrap_or("auto");
    let mut merge = Command::new(&py);
    merge.current_dir(&eng).arg("stem_merge.py").args(["--out", &out_mid.display().to_string(), "--manifest-in", &manifest_in.display().to_string(), "--manifest-out", &manifest_out.display().to_string(), "--budget", budget]).creation_flags(0x08000000);
    apply_engine_env(&mut merge);
    if merge.status().is_err() { return None; }
    if let Some(a) = app { let _ = a.emit("engine:stem-progress", serde_json::json!({ "id": id, "stage": "done", "percent": 100 })); }
    Some(serde_json::json!({ "ok": true, "out": out_mid.display().to_string(), "tracks": built, "manifest": manifest_out.display().to_string(), "fallback": false }))
}


#[cfg(test)]
mod tests {
    #[test]
    fn role_mapping() {
        assert_eq!(super::role_of("song_vocals"), "vocals");
        assert_eq!(super::role_of("song_drums"), "drums");
        assert_eq!(super::role_of("song_bass"), "bass");
        assert_eq!(super::role_of("song_piano"), "piano");
        assert_eq!(super::role_of("song_guitar"), "guitar");
        assert_eq!(super::role_of("song_other"), "other");
    }
}
