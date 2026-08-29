// 乐谱导出：PNG 分页 ZIP —— 移植自 main/score.js
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::engine::run_inline_python;

#[derive(Deserialize)]
pub struct PngZipOpts {
    tiles: Vec<Tile>,
    name: Option<String>,
}
#[derive(Deserialize)]
pub struct Tile {
    data: Option<Vec<u8>>,
}

// 导出 PNG 分页 ZIP：保存对话框 → 写临时 PNG → Python zipfile 打包
#[tauri::command]
pub async fn export_score_png_zip(
    app: AppHandle,
    window: tauri::WebviewWindow,
    opts: Option<PngZipOpts>,
) -> Value {
    let opts = match opts {
        Some(o) => o,
        None => return json!({ "ok": false, "error": "empty tiles" }),
    };
    if opts.tiles.is_empty() {
        return json!({ "ok": false, "error": "empty tiles" });
    }
    let default_name = opts.name.clone().unwrap_or_else(|| "score".into());
    let saved = window
        .dialog()
        .file()
        .add_filter("ZIP", &["zip"])
        .set_file_name(format!("{}.zip", default_name))
        .blocking_save_file();
    let out_path = match saved.and_then(|f| f.into_path().ok()) {
        Some(p) => p,
        None => return json!({ "ok": false, "canceled": true }),
    };

    let tmp_dir = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("fufumidi-score-png");
    let _ = fs::create_dir_all(&tmp_dir);
    for (i, t) in opts.tiles.iter().enumerate() {
        let data = t.data.clone().unwrap_or_default();
        let png = tmp_dir.join(format!("score-{:03}.png", i + 1));
        let _ = fs::write(&png, data);
    }

    let out = out_path.to_string_lossy().to_string();
    let d = tmp_dir.to_string_lossy().to_string();
    let code = format!(
        "import zipfile, glob, os\nout = r'''{}'''\nd = r'''{}'''\nz = zipfile.ZipFile(out, \"w\", zipfile.ZIP_DEFLATED)\nfor f in glob.glob(os.path.join(d, \"*.png\")):\n    z.write(f, os.path.basename(f))\nz.close()\nprint('###RESULT ' + str({{'ok': True, 'out': out}}))",
        out, d
    );
    let r = run_inline_python(&app, &code);
    // 清理临时 PNG
    if let Ok(entries) = fs::read_dir(&tmp_dir) {
        for e in entries.flatten() {
            let _ = fs::remove_file(e.path());
        }
    }
    let parsed = crate::engine::parse_py_json(&r.out);
    match parsed {
        Some(v) if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) => {
            json!({ "ok": true, "path": out })
        }
        _ => json!({ "ok": false, "error": r.out.chars().take(300).collect::<String>() }),
    }
}

// PDF 导出：Tauri/WebView2 暂无 printToPDF 等价 API，提示使用 PNG 分页包
#[tauri::command]
pub fn export_score_pdf(app: AppHandle) -> Value {
    json!({ "ok": false, "error": "Tauri 版暂不支持 PDF 导出，请使用「PNG 分页包」导出" })
}
