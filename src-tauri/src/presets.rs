// 转录参数预设：列表 / 保存 / 删除 / 排序 / 恢复 —— 移植自 main/presets.js
// 通过内联 Python 调用 engine/presets.py（参数以 JSON 字符串传入，避免字面量注入）
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::engine::{parse_py_json, run_inline_python};

fn inline(app: &AppHandle, code: &str) -> Value {
    let r = run_inline_python(app, code);
    match parse_py_json(&r.out) {
        Some(v) => v,
        None => {
            let msg = r.error.unwrap_or_else(|| r.out.clone());
            json!({ "ok": false, "error": msg.chars().take(400).collect::<String>() })
        }
    }
}

// 预设列表
#[tauri::command]
pub fn presets_list(app: AppHandle) -> Value {
    let code = "import json, presets\np, last = presets.load_presets()\nprint(json.dumps({'ok': True, 'presets': p, 'last_used': last, 'builtins': list(presets._builtin_presets().keys())}, ensure_ascii=False))";
    inline(&app, code)
}

#[derive(serde::Deserialize)]
pub struct PresetSave {
    name: String,
    mode: Option<String>,
    params: Option<Value>,
}

#[tauri::command]
pub fn presets_save(app: AppHandle, req: PresetSave) -> Value {
    let arg = json!({ "name": req.name.trim(), "mode": req.mode, "params": req.params.unwrap_or(json!({})) });
    let s = serde_json::to_string(&arg).unwrap_or_else(|_| "{}".into());
    let code = format!(
        "import json, presets\n_args = json.loads(r'''{}''')\nok = presets.save_preset(_args['name'], _args['mode'], _args['params'])\nif ok: presets.save_last_used(_args['name'])\nprint(json.dumps({{'ok': True, 'saved': bool(ok)}}, ensure_ascii=False))",
        s
    );
    inline(&app, &code)
}

#[tauri::command]
pub fn presets_delete(app: AppHandle, name: String) -> Value {
    let code = format!(
        "import json, presets\nok = presets.delete_preset(json.loads(r'''{}'''))\nprint(json.dumps({{'ok': True, 'deleted': bool(ok)}}, ensure_ascii=False))",
        serde_json::to_string(&name.trim()).unwrap_or_else(|_| "\"\"".into())
    );
    inline(&app, &code)
}

#[tauri::command]
pub fn presets_last_used(app: AppHandle, name: String) -> Value {
    let code = format!(
        "import presets\npresets.save_last_used(json.loads(r'''{}'''))\nprint('{{}}')",
        serde_json::to_string(&name.trim()).unwrap_or_else(|_| "\"\"".into())
    );
    let _ = run_inline_python(&app, &code);
    json!({ "ok": true })
}

#[tauri::command]
pub fn presets_reorder(app: AppHandle, name: String, delta: i64) -> Value {
    let code = format!(
        "import json, presets\norder = presets.reorder_preset(json.loads(r'''{}'''), {})\nprint(json.dumps({{'ok': True, 'order': order}}, ensure_ascii=False))",
        serde_json::to_string(&name.trim()).unwrap_or_else(|_| "\"\"".into()),
        delta
    );
    inline(&app, &code)
}

#[tauri::command]
pub fn presets_reorder_to(app: AppHandle, name: String, index: i64) -> Value {
    let code = format!(
        "import json, presets\norder = presets.reorder_preset_to(json.loads(r'''{}'''), {})\nprint(json.dumps({{'ok': True, 'order': order}}, ensure_ascii=False))",
        serde_json::to_string(&name.trim()).unwrap_or_else(|_| "\"\"".into()),
        index
    );
    inline(&app, &code)
}

#[tauri::command]
pub fn presets_restore(app: AppHandle) -> Value {
    let code = "import json, presets\nok = presets.restore_all_builtins()\nprint(json.dumps({'ok': True, 'restored': bool(ok)}, ensure_ascii=False))";
    inline(&app, &code)
}
