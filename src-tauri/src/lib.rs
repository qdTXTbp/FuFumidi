// FuFumidi Tauri 后端 —— 分阶段移植自 Electron 主进程
mod db;
mod diagnostics;
mod dialogs;
mod engine;
mod gpu;
mod models;
mod plugins;
mod presets;
mod score;
mod settings;
mod system;
mod updater;
mod video;
mod wallpaper;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(engine::EngineState::default())
        .manage(models::ModelState::default())
        .manage(db::DbState::default())
        .setup(|app| {
            settings::init(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::load_settings,
            settings::save_settings,
            system::file_assoc,
            system::check_integrity,
            system::repair_integrity,
            system::open_output,
            system::open_edit_guide,
            system::notify,
            dialogs::pick_audio,
            dialogs::pick_audio_files,
            dialogs::list_audio_files,
            dialogs::pick_image,
            dialogs::pick_file,
            dialogs::pick_directory,
            dialogs::soundfont_list,
            dialogs::pick_music_xml,
            dialogs::list_midi_files,
            dialogs::read_binary,
            dialogs::read_soundfont,
            dialogs::save_binary,
            engine::convert,
            engine::cancel,
            engine::probe,
            engine::refine,
            models::model_list,
            models::model_delete,
            models::model_cancel,
            models::model_pause,
            models::model_download,
            updater::launch_updater,
            updater::check_update,
            updater::update_list,
            updater::update_download,
            updater::update_open,
            updater::open_external,
            db::db_status,
            db::db_kv_get,
            db::db_kv_set,
            db::db_songs_list,
            db::db_songs_put,
            db::db_songs_delete,
            db::db_playlists_list,
            db::db_playlists_put,
            presets::presets_list,
            presets::presets_save,
            presets::presets_delete,
            presets::presets_last_used,
            presets::presets_reorder,
            presets::presets_reorder_to,
            presets::presets_restore,
            diagnostics::dep_check,
            diagnostics::dep_install,
            diagnostics::diag_export,
            score::export_score_png_zip,
            score::export_score_pdf,
            video::transcode_video,
            wallpaper::wallpaper_defaults,
            wallpaper::wallpaper_list,
            wallpaper::wallpaper_remove_local,
            wallpaper::wallpaper_add_local,
            wallpaper::wallpaper_download,
            gpu::gpu_status,
            gpu::gpu_uninstall,
            gpu::gpu_list_packages,
            gpu::gpu_package_url,
            gpu::gpu_download_package,
            gpu::gpu_import_local,
            gpu::gpu_install_auto,
            plugins::plugins_list,
            plugins::plugins_set_enabled,
            plugins::plugins_invoke,
            plugins::plugins_rescan,
            plugins::plugins_open_dir,
            plugins::plugins_open_docs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running FuFumidi");
}
