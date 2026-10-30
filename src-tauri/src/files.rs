//! Files the user picked, and uploads to the node with progress.
//!
//! The webview never names a path itself: files come from a native picker opened here,
//! and are referred to afterwards by an opaque id. So a compromised page can only read
//! what the user chose. Saving works the same way (the native save dialog picks the path).

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_http::reqwest;

/// The public gateway's request limit.
pub const MAX_UPLOAD_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Default)]
pub struct Picked {
    next: AtomicU64,
    files: Mutex<HashMap<String, PathBuf>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Serialize)]
pub struct PickedFile {
    id: String,
    name: String,
    size: u64,
    mime: String,
}

fn mime_for(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "flac" => "audio/flac",
        "m4a" | "aac" => "audio/mp4",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "txt" | "md" => "text/plain",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
pub async fn pick_file<R: Runtime>(app: AppHandle<R>, picked: State<'_, Picked>, kind: String) -> Result<Option<PickedFile>, String> {
    let mut d = app.dialog().file();
    d = match kind.as_str() {
        "media" => d.add_filter("Photos and videos", &["jpg", "jpeg", "png", "gif", "webp", "mp4", "mov", "webm", "mkv"]),
        "image" => d.add_filter("Images", &["jpg", "jpeg", "png", "gif", "webp"]),
        "backup" => d.add_filter("GFC wallet backup", &["json"]),
        _ => d
            .add_filter("3D models, audio and other files", &["glb", "gltf", "mp3", "wav", "ogg", "m4a", "flac", "opus", "jpg", "jpeg", "png", "gif", "webp", "mp4", "mov", "webm"])
            .add_filter("All files", &["*"]),
    };
    let Some(fp) = d.blocking_pick_file() else { return Ok(None) };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let name = path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "upload.bin".into());
    let id = format!("f{}", picked.next.fetch_add(1, Ordering::Relaxed));
    picked.files.lock().unwrap().insert(id.clone(), path);
    Ok(Some(PickedFile { id, mime: mime_for(&name).into(), name, size: meta.len() }))
}

/// The picked file's bytes, for previews (images, 3D models) and backups. Capped.
#[tauri::command]
pub async fn read_picked(picked: State<'_, Picked>, id: String, max_bytes: u64) -> Result<tauri::ipc::Response, String> {
    let path = picked.files.lock().unwrap().get(&id).cloned().ok_or("that file is no longer available")?;
    let len = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if len > max_bytes {
        return Err(format!("file is {len} bytes, over the {max_bytes} limit"));
    }
    let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn forget_picked(picked: State<'_, Picked>, id: String) {
    picked.files.lock().unwrap().remove(&id);
}

/// Native save dialog, then write `contents`. Returns the path written, or None if cancelled.
#[tauri::command]
pub async fn save_text<R: Runtime>(app: AppHandle<R>, default_name: String, contents: String) -> Result<Option<String>, String> {
    let name: String = default_name.chars().filter(|c| c.is_ascii_alphanumeric() || "-_.".contains(*c)).collect();
    let dir = app.path().document_dir().ok();
    let mut d = app.dialog().file().set_file_name(name).add_filter("JSON", &["json"]);
    if let Some(dir) = dir {
        d = d.set_directory(dir);
    }
    let Some(fp) = d.blocking_save_file() else { return Ok(None) };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    tokio::fs::write(&path, contents).await.map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Download a teaser clip into Videos\GFC (so it can be attached to a post on X) and
/// show it in Explorer. `url` must be on the node the app is using (checked by the caller
/// passing the node base and a path).
#[tauri::command]
pub async fn save_teaser<R: Runtime>(app: AppHandle<R>, base_url: String, path: String, file_name: String) -> Result<String, String> {
    if !path.starts_with("/teasers/") || path.contains("..") {
        return Err("not a teaser".into());
    }
    let safe: String = file_name.chars().map(|c| if c.is_alphanumeric() || " -_".contains(c) { c } else { '_' }).take(60).collect();
    let safe = if safe.trim().is_empty() { "GFC".to_string() } else { safe.trim().to_string() };
    let dir = app.path().video_dir().map_err(|e| e.to_string())?.join("GFC");
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let dest = dir.join(format!("{safe}-teaser.mp4"));
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let res = reqwest::Client::new().get(&url).timeout(Duration::from_secs(60)).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("teaser too big".into());
    }
    tokio::fs::write(&dest, &bytes).await.map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("explorer").arg("/select,").arg(&dest).spawn();
    }
    Ok(dest.to_string_lossy().into_owned())
}

#[derive(Clone, Serialize)]
pub struct Progress {
    sent: u64,
    total: u64,
}

#[derive(Serialize)]
pub struct HttpResult {
    status: u16,
    body: String,
}

/// POST /seeds/upload as multipart, streaming the picked file (or a text post) with progress.
/// Field order follows the Unreal client: title, description, tags, exclusive, thumbnail, file.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn upload_seed(
    picked: State<'_, Picked>,
    upload_id: String,
    base_url: String,
    token: String,
    file_id: Option<String>,
    text: Option<String>,
    title: String,
    description: String,
    tags: String,
    exclusive: bool,
    thumbnail: Option<Vec<u8>>,
    on_progress: Channel<Progress>,
) -> Result<HttpResult, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    picked.cancels.lock().unwrap().insert(upload_id.clone(), cancel.clone());
    let result = upload_inner(&picked, &base_url, &token, file_id, text, title, description, tags, exclusive, thumbnail, on_progress, cancel).await;
    picked.cancels.lock().unwrap().remove(&upload_id);
    result
}

#[allow(clippy::too_many_arguments)]
async fn upload_inner(
    picked: &Picked,
    base_url: &str,
    token: &str,
    file_id: Option<String>,
    text: Option<String>,
    title: String,
    description: String,
    tags: String,
    exclusive: bool,
    thumbnail: Option<Vec<u8>>,
    on_progress: Channel<Progress>,
    cancel: Arc<AtomicBool>,
) -> Result<HttpResult, String> {
    use reqwest::multipart::{Form, Part};

    let mut form = Form::new().text("title", title).text("description", description).text("tags", tags);
    if exclusive {
        form = form.text("exclusive", "true");
    }
    if let Some(t) = thumbnail.filter(|t| !t.is_empty()) {
        form = form.part("thumbnail", Part::bytes(t).file_name("thumb.jpg").mime_str("image/jpeg").unwrap());
    }

    let (part, total) = if let Some(id) = file_id {
        let path = picked.files.lock().unwrap().get(&id).cloned().ok_or("that file is no longer available")?;
        let len = tokio::fs::metadata(&path).await.map_err(|e| e.to_string())?.len();
        if len + 64 * 1024 > MAX_UPLOAD_BYTES {
            return Err(format!("This file is {:.0} MB; uploads are limited to 200 MB.", len as f64 / 1048576.0));
        }
        let name: String = path
            .file_name()
            .map(|s| s.to_string_lossy().chars().filter(|c| !matches!(c, '"' | '\r' | '\n')).collect())
            .filter(|s: &String| !s.is_empty())
            .unwrap_or_else(|| "upload.bin".into());
        let file = tokio::fs::File::open(&path).await.map_err(|e| e.to_string())?;
        let sent = Arc::new(AtomicU64::new(0));
        let stream = progress_stream(file, len, sent, on_progress.clone(), cancel.clone());
        let mime = mime_for(&name);
        (Part::stream_with_length(reqwest::Body::wrap_stream(stream), len).file_name(name).mime_str(mime).unwrap(), len)
    } else if let Some(t) = text {
        let bytes = t.into_bytes();
        let len = bytes.len() as u64;
        (Part::bytes(bytes).file_name("post.txt").mime_str("text/plain").unwrap(), len)
    } else {
        return Err("nothing to upload".into());
    };
    form = form.part("file", part);
    let _ = on_progress.send(Progress { sent: 0, total });

    let url = format!("{}/seeds/upload", base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    let res = client
        .post(url)
        .header("Accept", "application/json")
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await;
    if cancel.load(Ordering::Relaxed) {
        return Err("Upload cancelled.".into());
    }
    match res {
        Ok(r) => {
            let status = r.status().as_u16();
            let body = r.text().await.unwrap_or_default();
            let _ = on_progress.send(Progress { sent: total, total });
            Ok(HttpResult { status, body })
        }
        // Status 0 = couldn't reach the node; the caller decides whether to retry
        Err(e) => Ok(HttpResult { status: 0, body: e.to_string() }),
    }
}

fn progress_stream(
    file: tokio::fs::File,
    total: u64,
    sent: Arc<AtomicU64>,
    ch: Channel<Progress>,
    cancel: Arc<AtomicBool>,
) -> impl futures_util::Stream<Item = Result<Vec<u8>, std::io::Error>> {
    use tokio::io::AsyncReadExt;
    futures_util::stream::unfold(file, move |mut f| {
        let sent = sent.clone();
        let ch = ch.clone();
        let cancel = cancel.clone();
        async move {
            if cancel.load(Ordering::Relaxed) {
                return Some((Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "cancelled")), f));
            }
            let mut buf = vec![0u8; 256 * 1024];
            match f.read(&mut buf).await {
                Ok(0) => None,
                Ok(n) => {
                    buf.truncate(n);
                    let s = sent.fetch_add(n as u64, Ordering::Relaxed) + n as u64;
                    let _ = ch.send(Progress { sent: s, total });
                    Some((Ok(buf), f))
                }
                Err(e) => Some((Err(e), f)),
            }
        }
    })
}

#[tauri::command]
pub fn cancel_upload(picked: State<'_, Picked>, upload_id: String) {
    if let Some(c) = picked.cancels.lock().unwrap().get(&upload_id) {
        c.store(true, Ordering::Relaxed);
    }
}
