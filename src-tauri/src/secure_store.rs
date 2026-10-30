//! "Stay logged in": the session token in the OS credential store: Windows Credential
//! Manager on Windows; on Android, app-private SharedPreferences encrypted with a key held
//! in the Android Keystore. Nothing else goes here, and the token never touches disk in
//! plain text.

use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};

// The credential's service name is the app identifier, so a dev build
// (tauri.dev.conf.json) never reads or overwrites the installed app's login.
fn service<R: Runtime>(app: &AppHandle<R>) -> String {
    app.config().identifier.clone()
}

#[cfg(windows)]
mod backend {
    fn entry(service: &str, key: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(service, key).map_err(|e| e.to_string())
    }

    pub fn get(service: &str, key: &str) -> Result<Option<String>, String> {
        match entry(service, key)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn set(service: &str, key: &str, value: &str) -> Result<(), String> {
        entry(service, key)?.set_password(value).map_err(|e| e.to_string())
    }

    pub fn delete(service: &str, key: &str) -> Result<(), String> {
        match entry(service, key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    pub const AVAILABLE: bool = true;
}

#[cfg(target_os = "android")]
mod backend {
    use std::sync::Once;

    fn entry(service: &str, key: &str) -> Result<keyring_core::Entry, String> {
        // Tauri initializes the Android context (ndk-context) that the store needs
        static INIT: Once = Once::new();
        INIT.call_once(|| match android_native_keyring_store::Store::new() {
            Ok(store) => keyring_core::set_default_store(store),
            Err(e) => log_error(&e.to_string()),
        });
        keyring_core::Entry::new(service, key).map_err(|e| e.to_string())
    }

    fn log_error(msg: &str) {
        eprintln!("secure-store: couldn't open the Android keystore: {msg}");
    }

    pub fn get(service: &str, key: &str) -> Result<Option<String>, String> {
        match entry(service, key)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn set(service: &str, key: &str, value: &str) -> Result<(), String> {
        entry(service, key)?.set_password(value).map_err(|e| e.to_string())
    }

    pub fn delete(service: &str, key: &str) -> Result<(), String> {
        match entry(service, key)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    pub const AVAILABLE: bool = true;
}

#[cfg(not(any(windows, target_os = "android")))]
mod backend {
    pub fn get(_service: &str, _key: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    pub fn set(_service: &str, _key: &str, _value: &str) -> Result<(), String> {
        Err("secure storage isn't available on this platform yet".into())
    }
    pub fn delete(_service: &str, _key: &str) -> Result<(), String> {
        Ok(())
    }
    pub const AVAILABLE: bool = false;
}

// Keys are fixed names chosen by the app ("session"), never paths or user input.
fn check_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 64 || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("bad key".into());
    }
    Ok(())
}

#[tauri::command]
fn available() -> bool {
    backend::AVAILABLE
}

#[tauri::command]
fn get<R: Runtime>(app: AppHandle<R>, key: String) -> Result<Option<String>, String> {
    check_key(&key)?;
    backend::get(&service(&app), &key)
}

#[tauri::command]
fn set<R: Runtime>(app: AppHandle<R>, key: String, value: String) -> Result<(), String> {
    check_key(&key)?;
    backend::set(&service(&app), &key, &value)
}

#[tauri::command]
fn delete<R: Runtime>(app: AppHandle<R>, key: String) -> Result<(), String> {
    check_key(&key)?;
    backend::delete(&service(&app), &key)
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("secure-store")
        .invoke_handler(tauri::generate_handler![available, get, set, delete])
        .build()
}
