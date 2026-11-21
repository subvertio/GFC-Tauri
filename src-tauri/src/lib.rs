mod files;
mod videoinfo;
mod native;
mod secure_store;

// The Android (and iOS) app calls into this through the generated JNI entry point
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Windows updates itself from the node (signed with the updater key); Android can't, so it
    // only gets the "update available" prompt (src/update.ts)
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    builder
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(secure_store::init())
        .plugin(native::init())
        .manage(files::Picked::default())
        .manage(files::Dropped::default())
        // Drag and drop (desktop): remember what was dropped for take_dropped
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                use tauri::Manager;
                files::remember_drop(&window.state::<files::Dropped>(), paths);
            }
        })
        .invoke_handler(tauri::generate_handler![
            files::take_dropped,
            files::pick_file,
            files::pick_videos,
            files::make_available,
            files::onedrive_missing,
            files::onedrive_status,
            files::start_onedrive,
            files::video_info,
            files::debug_pick_path,
            files::read_picked,
            files::forget_picked,
            files::save_text,
            files::save_teaser,
            files::download_file,
            files::share_native,
            files::upload_seed,
            files::cancel_upload,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GFC");
}
