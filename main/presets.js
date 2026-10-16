// ============================================================
// 主进程预设服务：转录参数预设的列表/保存/删除/排序/恢复
// ============================================================
'use strict';

function registerPresetsIpc({ ipcMain, runEngineInline, parsePyJson, pyLit }) {
  // 转录参数预设：列表（内置 + 用户合并）/ 保存 / 删除 / 记住上次使用
  ipcMain.handle('presets:list', async () => {
    const r = await runEngineInline(
      'import json, presets\n' +
      'p, last = presets.load_presets()\n' +
      "print(json.dumps({'ok': True, 'presets': p, 'last_used': last, " +
      "'builtins': list(presets._builtin_presets().keys()), " +
      // 每个模型的「内置默认预设名」+ 用户指定过的绑定；切模型自动套预设靠这两张表
      "'model_defaults': presets.MODEL_DEFAULT_PRESET, " +
      "'model_preset': presets.load_model_preset_map()}, ensure_ascii=False))"
    );
    const d = parsePyJson(r.out);
    if (d && d.ok) {
      return {
        ok: true, presets: d.presets || {}, last_used: d.last_used || '', builtins: d.builtins || [],
        model_defaults: d.model_defaults || {}, model_preset: d.model_preset || {},
      };
    }
    return { ok: false, error: (r.error || r.out || 'presets:list failed').slice(-400) };
  });
  ipcMain.handle('presets:save', async (_e, name, mode, params) => {
    const code =
      'import json, presets\n' +
      'ok = presets.save_preset(' + JSON.stringify((name || '').trim()) + ', ' + pyLit(mode) + ', ' + pyLit(params || {}) + ')\n' +
      'if ok: presets.save_last_used(' + JSON.stringify((name || '').trim()) + ')\n' +
      "print(json.dumps({'ok': True, 'saved': bool(ok)}, ensure_ascii=False))";
    const r = await runEngineInline(code);
    const d = parsePyJson(r.out);
    if (d && d.ok) return { ok: true, saved: !!d.saved };
    return { ok: false, error: (r.error || r.out || 'presets:save failed').slice(-400) };
  });
  ipcMain.handle('presets:delete', async (_e, name) => {
    const code =
      'import json, presets\n' +
      'ok = presets.delete_preset(' + JSON.stringify((name || '').trim()) + ')\n' +
      "print(json.dumps({'ok': True, 'deleted': bool(ok)}, ensure_ascii=False))";
    const r = await runEngineInline(code);
    const d = parsePyJson(r.out);
    if (d && d.ok) return { ok: true, deleted: !!d.deleted };
    return { ok: false, error: (r.error || r.out || 'presets:delete failed').slice(-400) };
  });
  ipcMain.handle('presets:lastUsed', async (_e, name) => {
    const code =
      'import presets\n' +
      'presets.save_last_used(' + JSON.stringify((name || '').trim()) + ')\n' +
      "print(json.dumps({'ok': True}, ensure_ascii=False))";
    await runEngineInline(code);
    return { ok: true };
  });
  ipcMain.handle('presets:reorder', async (_e, name, delta) => {
    const code =
      'import json, presets\n' +
      'order = presets.reorder_preset(' + JSON.stringify((name || '').trim()) + ', ' + pyLit(delta) + ')\n' +
      "print(json.dumps({'ok': True, 'order': order}, ensure_ascii=False))";
    const r = await runEngineInline(code);
    const d = parsePyJson(r.out);
    if (d && d.ok) return { ok: true, order: d.order || [] };
    return { ok: false, error: (r.error || r.out || 'presets:reorder failed').slice(-400) };
  });
  // 拖拽排序：直接把预设移到展示顺序的目标下标（前端拖放一次性定位）
  ipcMain.handle('presets:reorderTo', async (_e, name, index) => {
    const code =
      'import json, presets\n' +
      'order = presets.reorder_preset_to(' + JSON.stringify((name || '').trim()) + ', ' + pyLit(index) + ')\n' +
      "print(json.dumps({'ok': True, 'order': order}, ensure_ascii=False))";
    const r = await runEngineInline(code);
    const d = parsePyJson(r.out);
    if (d && d.ok) return { ok: true, order: d.order || [] };
    return { ok: false, error: (r.error || r.out || 'presets:reorderTo failed').slice(-400) };
  });
  // 把某个模型绑定到某个预设（name 传空 = 解绑、回到内置默认）。
  // 这就是「用户自建预设并指定某模型用它，以用户为准」+「记住用户选择」的落点。
  ipcMain.handle('presets:setModelPreset', async (_e, key, name) => {
    const code =
      'import json, presets\n' +
      'ok = presets.set_model_preset(' + JSON.stringify(String(key == null ? '' : key)) + ', ' +
      JSON.stringify(String(name == null ? '' : name)) + ')\n' +
      "print(json.dumps({'ok': True, 'saved': bool(ok), 'model_preset': presets.load_model_preset_map()}, ensure_ascii=False))";
    const r = await runEngineInline(code);
    const d = parsePyJson(r.out);
    if (d && d.ok) return { ok: true, saved: !!d.saved, model_preset: d.model_preset || {} };
    return { ok: false, error: (r.error || r.out || 'presets:setModelPreset failed').slice(-400) };
  });
  ipcMain.handle('presets:restore', async () => {
    const code =
      'import json, presets\n' +
      'ok = presets.restore_all_builtins()\n' +
      "print(json.dumps({'ok': True, 'restored': bool(ok)}, ensure_ascii=False))";
    const r = await runEngineInline(code);
    const d = parsePyJson(r.out);
    if (d && d.ok) return { ok: true, restored: !!d.restored };
    return { ok: false, error: (r.error || r.out || 'presets:restore failed').slice(-400) };
  });
}

module.exports = { registerPresetsIpc };
