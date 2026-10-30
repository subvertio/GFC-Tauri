mod files;
mod secure_store;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(secure_store::init())
        .manage(files::Picked::default())
        .invoke_handler(tauri::generate_handler![
            files::pick_file,
            files::debug_pick_path,
            files::read_picked,
            files::forget_picked,
            files::save_text,
            files::save_teaser,
            files::download_file,
            files::upload_seed,
            files::cancel_upload,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GFC");
}
