// 视频导出：WebM（可视化）+ 可选 WAV → ffmpeg 合成 MP4 —— 移植自 main/video.js
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::engine::{parse_py_json, run_inline_python};

#[derive(Deserialize)]
pub struct TranscodeOpts {
    data: Option<Vec<u8>>,
    audio: Option<Vec<u8>>,
}

// 合成 MP4：保存对话框 → 写临时 WebM/WAV → Python imageio_ffmpeg 编码
#[tauri::command]
pub async fn transcode_video(
    app: AppHandle,
    window: tauri::WebviewWindow,
    opts: Option<TranscodeOpts>,
) -> Value {
    let opts = match opts {
        Some(o) => o,
        None => return json!({ "ok": false, "error": "empty" }),
    };
    let webm_data = match opts.data {
        Some(d) if !d.is_empty() => d,
        _ => return json!({ "ok": false, "error": "empty" }),
    };
    let saved = window
        .dialog()
        .file()
        .add_filter("MP4 视频", &["mp4"])
        .set_file_name("FuFumidi-video.mp4")
        .blocking_save_file();
    let out_path = match saved.and_then(|f| f.into_path().ok()) {
        Some(p) => p,
        None => return json!({ "ok": false, "canceled": true }),
    };

    let tmp_dir = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("fufumidi-video");
    let _ = fs::create_dir_all(&tmp_dir);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let webm = tmp_dir.join(format!("{}.webm", stamp));
    let _ = fs::write(&webm, &webm_data);
    let mut wav: Option<std::path::PathBuf> = None;
    if let Some(a) = &opts.audio {
        if !a.is_empty() {
            let w = tmp_dir.join(format!("{}.wav", stamp + 1));
            let _ = fs::write(&w, a);
            wav = Some(w);
        }
    }

    let out = out_path.to_string_lossy().to_string();
    let webm_s = webm.to_string_lossy().to_string();
    let wav_s = wav.as_ref().map(|w| w.to_string_lossy().to_string());
    let mut ff_args: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-i".into(),
        webm_s.clone(),
    ];
    if let Some(w) = &wav_s {
        ff_args.push("-i".into());
        ff_args.push(w.clone());
        ff_args.push("-map".into());
        ff_args.push("0:v:0".into());
        ff_args.push("-map".into());
        ff_args.push("1:a:0".into());
    }
    ff_args.extend([
        "-c:v".into(),
        "libx264".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-c:a".into(),
        "aac".into(),
        "-shortest".into(),
        "-movflags".into(),
        "+faststart".into(),
        out.clone(),
    ]);
    let args_json = serde_json::to_string(&ff_args).unwrap_or_else(|_| "[]".into());
    let code = format!(
        "import json, subprocess\nimport imageio_ffmpeg\nff = imageio_ffmpeg.get_ffmpeg_exe()\nr = subprocess.run([ff] + json.loads(r'''{}'''), capture_output=True)\nprint(json.dumps({{'ok': r.returncode == 0, 'err': (r.stderr or b'').decode('utf-8', 'replace')[-300:]}}))",
        args_json
    );
    let r = run_inline_python(&app, &code);
    let _ = fs::remove_file(&webm);
    if let Some(w) = wav {
        let _ = fs::remove_file(w);
    }
    match parse_py_json(&r.out) {
        Some(d) if d.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) => {
            json!({ "ok": true, "path": out })
        }
        Some(d) => json!({ "ok": false, "error": d.get("err").and_then(|x| x.as_str()).unwrap_or("ffmpeg failed") }),
        None => json!({ "ok": false, "error": r.out.chars().take(300).collect::<String>() }),
    }
}
