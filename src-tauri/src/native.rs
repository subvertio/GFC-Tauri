//! Android-only helpers in Kotlin (gen/android/.../GfcNativePlugin.kt), called from Rust:
//! open content:// files from the pickers, save into the shared Downloads / Movies folders,
//! and open the system share sheet. On desktop, init() registers an empty plugin.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("gfc-native")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api.register_android_plugin("tech.galacticfederation.gfc", "GfcNativePlugin")?;
                _app.manage(android::Native(handle));
            }
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
pub mod android {
    use serde::{Deserialize, Serialize};
    use std::os::fd::FromRawFd;
    use tauri::{plugin::PluginHandle, AppHandle, Manager, Runtime};

    pub struct Native<R: Runtime>(pub PluginHandle<R>);

    #[derive(Deserialize)]
    struct Opened {
        fd: i32,
        name: String,
        size: i64,
        mime: String,
    }

    pub struct UriFile {
        pub file: std::fs::File,
        pub name: String,
        pub size: u64,
        pub mime: String,
    }

    fn handle<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::State<'_, Native<R>>, String> {
        app.try_state::<Native<R>>().ok_or_else(|| "the Android helper isn't loaded".to_string())
    }

    /// Open a content:// URI ("r" to read, "wt" to write). The descriptor is ours to close.
    pub fn open_uri<R: Runtime>(app: &AppHandle<R>, uri: &str, mode: &str) -> Result<UriFile, String> {
        #[derive(Serialize)]
        struct Args<'a> {
            uri: &'a str,
            mode: &'a str,
        }
        let o: Opened = handle(app)?.0.run_mobile_plugin("openUri", Args { uri, mode }).map_err(|e| e.to_string())?;
        if o.fd < 0 {
            return Err("couldn't open the file".into());
        }
        // SAFETY: the plugin detached this descriptor for us; nothing else owns it
        let file = unsafe { std::fs::File::from_raw_fd(o.fd) };
        let size = if o.size >= 0 { o.size as u64 } else { file.metadata().map(|m| m.len()).unwrap_or(0) };
        Ok(UriFile { file, name: o.name, size, mime: o.mime })
    }

    /// Copy a cache file into Download/ ("downloads") or Movies/GFC ("movies"). Returns where.
    pub fn save_to_collection<R: Runtime>(app: &AppHandle<R>, path: &std::path::Path, name: &str, mime: &str, collection: &str) -> Result<String, String> {
        #[derive(Serialize)]
        struct Args<'a> {
            path: String,
            name: &'a str,
            mime: &'a str,
            collection: &'a str,
        }
        #[derive(Deserialize)]
        struct Saved {
            location: String,
        }
        let s: Saved = handle(app)?
            .0
            .run_mobile_plugin("saveToCollection", Args { path: path.to_string_lossy().into_owned(), name, mime, collection })
            .map_err(|e| e.to_string())?;
        Ok(s.location)
    }

    /// The system share sheet with text and, optionally, a file from the app's cache.
    pub fn share<R: Runtime>(app: &AppHandle<R>, text: &str, path: Option<&std::path::Path>, mime: Option<&str>, title: &str) -> Result<(), String> {
        #[derive(Serialize)]
        struct Args<'a> {
            text: &'a str,
            path: Option<String>,
            mime: Option<&'a str>,
            title: &'a str,
        }
        handle(app)?
            .0
            .run_mobile_plugin::<()>("share", Args { text, path: path.map(|p| p.to_string_lossy().into_owned()), mime, title })
            .map_err(|e| e.to_string())
    }
}
