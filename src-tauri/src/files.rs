//! Files the user picked, and uploads to the node with progress.
//!
//! The webview never names a path itself: files come from a native picker opened here,
//! and are referred to afterwards by an opaque id. So a compromised page can only read
//! what the user chose. Saving works the same way (the native save dialog picks the path).
//!
//! On Android the pickers return content:// URIs, which are opened through the Kotlin
//! helper (native.rs), and saved files go to the shared Downloads / Movies folders.

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
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_http::reqwest;

/// The public gateway's request limit.
pub const MAX_UPLOAD_BYTES: u64 = 200 * 1024 * 1024;
/// The largest download the app saves (the gateway takes uploads up to 200 MB).
const MAX_DOWNLOAD_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TEASER_BYTES: u64 = 64 * 1024 * 1024;

/// Where a picked file lives: a path (desktop), or a content:// URI (Android).
#[derive(Clone)]
enum Source {
    Path(PathBuf),
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    Uri(String),
}

#[derive(Clone)]
struct PickedEntry {
    source: Source,
    name: String,
}

#[derive(Default)]
pub struct Picked {
    next: AtomicU64,
    files: Mutex<HashMap<String, PickedEntry>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Picked {
    fn add(&self, source: Source, name: String) -> String {
        let id = format!("f{}", self.next.fetch_add(1, Ordering::Relaxed));
        self.files.lock().unwrap().insert(id.clone(), PickedEntry { source, name });
        id
    }
    fn get(&self, id: &str) -> Result<PickedEntry, String> {
        self.files.lock().unwrap().get(id).cloned().ok_or_else(|| "that file is no longer available".into())
    }
}

#[derive(Serialize)]
pub struct PickedFile {
    id: String,
    name: String,
    size: u64,
    mime: String,
    /// A cloud placeholder (OneDrive "Available when online"): its content is downloaded
    /// by the cloud app when it's first read. make_available() does that up front.
    online_only: bool,
}

/// Windows cloud files (OneDrive Files On-Demand, Dropbox, iCloud...): a placeholder whose
/// content is still in the cloud. Reading its attributes doesn't download it.
#[cfg(windows)]
fn is_online_only(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const OFFLINE: u32 = 0x1000;
    const RECALL_ON_OPEN: u32 = 0x4_0000;
    const RECALL_ON_DATA_ACCESS: u32 = 0x40_0000;
    meta.file_attributes() & (OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS) != 0
}
#[cfg(not(windows))]
fn is_online_only(_meta: &std::fs::Metadata) -> bool {
    false
}

/// Windows' cloud-file errors (ERROR_CLOUD_FILE_*: OneDrive crashed, isn't running or signed
/// in, timed out...), e.g. 0x80070194 "The cloud file provider exited unexpectedly".
fn is_cloud_error(code: i32) -> bool {
    (358..=404).contains(&code) || code == 426
}

/// Whether `path` is inside a OneDrive folder (personal or work), from OneDrive's own
/// environment variables.
fn in_onedrive(path: &std::path::Path) -> bool {
    ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"].iter().filter_map(std::env::var_os).any(|root| {
        let root = PathBuf::from(root);
        !root.as_os_str().is_empty() && path.starts_with(&root)
    })
}

/// Is the OneDrive app running? Without it, reading an online-only file fails, and Windows
/// pops up "The cloud file provider exited unexpectedly".
#[cfg(windows)]
fn onedrive_running() -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq OneDrive.exe", "/NH", "/FO", "CSV"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_ascii_lowercase().contains("onedrive.exe"))
        .unwrap_or(true) // can't tell: let Windows try
}
#[cfg(not(windows))]
fn onedrive_running() -> bool {
    true
}

/// For the OneDrive tip: is the OneDrive app running now?
#[tauri::command]
pub fn onedrive_status() -> bool {
    onedrive_running()
}

/// The tip's Start OneDrive button: open the OneDrive app (per-user or per-machine install).
#[tauri::command]
pub fn start_onedrive() -> Result<(), String> {
    let candidates: Vec<PathBuf> = [
        ("LOCALAPPDATA", r"Microsoft\OneDrive\OneDrive.exe"),
        ("ProgramFiles", r"Microsoft OneDrive\OneDrive.exe"),
        ("ProgramFiles(x86)", r"Microsoft OneDrive\OneDrive.exe"),
    ]
    .iter()
    .filter_map(|(var, rel)| std::env::var_os(var).map(|base| PathBuf::from(base).join(rel)))
    .collect();
    let exe = candidates.into_iter().find(|p| p.is_file())
        .ok_or("OneDrive isn't installed here. Install it from Microsoft, or move the videos out of OneDrive.")?;
    std::process::Command::new(exe).spawn().map(|_| ()).map_err(|e| format!("Couldn't start OneDrive: {e}"))
}

const ONEDRIVE_NOT_RUNNING: &str = "OneDrive isn't running, so this video can't be downloaded from the cloud.     Start OneDrive (Start menu, then OneDrive), wait until it's signed in, then press Post again.";

/// For the batch screen: true when some picked files are online-only in OneDrive but the
/// OneDrive app isn't running (so they can't be posted until it is).
#[tauri::command]
pub fn onedrive_missing(picked: State<'_, Picked>, ids: Vec<String>) -> bool {
    let needs = ids.iter().filter_map(|id| picked.get(id).ok()).any(|e| match &e.source {
        Source::Path(p) => in_onedrive(p) && std::fs::metadata(p).map(|m| is_online_only(&m)).unwrap_or(false),
        Source::Uri(_) => false,
    });
    needs && !onedrive_running()
}

/// An I/O error as something a person can act on.
fn friendly_io(e: &std::io::Error) -> String {
    match e.raw_os_error() {
        Some(c) if is_cloud_error(c) => format!(
            "OneDrive (or your cloud storage app) couldn't download this file: {e}. Check that OneDrive is running and              signed in, then try again. To avoid this, right-click the folder in File Explorer and choose              \"Always keep on this device\" before posting."),
        _ => e.to_string(),
    }
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
        "wmv" => "video/x-ms-wmv",
        "flv" => "video/x-flv",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "flac" => "audio/flac",
        "m4a" | "aac" => "audio/mp4",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "txt" | "md" => "text/plain",
        "zip" => "application/zip",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

/// Picker results on Android can lack an extension (e.g. "1000123" from the photo picker);
/// the node decides a post's kind by extension, so add one from the MIME type.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn with_extension(name: String, mime: &str) -> String {
    if name.contains('.') {
        return name;
    }
    let ext = match mime {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "audio/mpeg" => "mp3",
        "audio/mp4" => "m4a",
        "audio/ogg" => "ogg",
        "audio/wav" | "audio/x-wav" => "wav",
        "application/zip" => "zip",
        "model/gltf-binary" => "glb",
        _ => return name,
    };
    format!("{name}.{ext}")
}

/// Open a picked file for reading, with its size.
fn open_entry<R: Runtime>(_app: &AppHandle<R>, e: &PickedEntry) -> Result<(std::fs::File, u64), String> {
    match &e.source {
        Source::Path(p) => {
            let f = std::fs::File::open(p).map_err(|e| friendly_io(&e))?;
            let len = f.metadata().map_err(|e| friendly_io(&e))?.len();
            Ok((f, len))
        }
        #[cfg(target_os = "android")]
        Source::Uri(u) => {
            let o = crate::native::android::open_uri(_app, u, "r")?;
            Ok((o.file, o.size))
        }
        #[cfg(not(target_os = "android"))]
        Source::Uri(_) => Err("content URIs are Android-only".into()),
    }
}

#[tauri::command]
pub async fn pick_file<R: Runtime>(app: AppHandle<R>, picked: State<'_, Picked>, kind: String) -> Result<Option<PickedFile>, String> {
    let mut d = app.dialog().file();
    let android = cfg!(target_os = "android");
    d = match kind.as_str() {
        "media" => d.add_filter("Photos and videos", &["jpg", "jpeg", "png", "gif", "webp", "mp4", "mov", "webm", "mkv"]),
        "image" => d.add_filter("Images", &["jpg", "jpeg", "png", "gif", "webp"]),
        "backup" => d.add_filter("GFC wallet backup", &["json"]),
        // Android maps filters to MIME types and greys out what it doesn't know (.glb): show everything
        _ if android => d,
        _ => d
            .add_filter("3D models, audio, downloads and other files", &["glb", "gltf", "zip", "mp3", "wav", "ogg", "m4a", "flac", "opus", "jpg", "jpeg", "png", "gif", "webp", "mp4", "mov", "webm"])
            .add_filter("All files", &["*"]),
    };
    let Some(fp) = d.blocking_pick_file() else { return Ok(None) };
    let uri = match fp {
        FilePath::Path(p) => return Ok(Some(picked_path(&picked, p)?)),
        FilePath::Url(u) if u.scheme() == "file" => {
            let p = u.to_file_path().map_err(|_| "this file can't be opened here".to_string())?;
            return Ok(Some(picked_path(&picked, p)?));
        }
        FilePath::Url(u) => u.to_string(),
    };
    #[cfg(target_os = "android")]
    {
        // Name, size and type from the content resolver; the descriptor closes when `o` drops
        let o = crate::native::android::open_uri(&app, &uri, "r")?;
        let mime = if o.mime.is_empty() { mime_for(&o.name).to_string() } else { o.mime.clone() };
        let name = with_extension(o.name.clone(), &mime);
        let id = picked.add(Source::Uri(uri), name.clone());
        return Ok(Some(PickedFile { id, name, size: o.size, mime, online_only: false }));
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = uri;
        Err("this file can't be opened here".into())
    }
}

/// Video types the node posts as videos (app_seeds.CONTENT_TYPE_MAP).
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "webm", "mkv", "m4v", "avi", "wmv", "flv"];
/// The most videos one batch takes (a folder with more lists the first ones, by name).
const MAX_BATCH: usize = 100;

fn is_video_path(p: &std::path::Path) -> bool {
    p.extension().and_then(|e| e.to_str()).map(|e| VIDEO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str())).unwrap_or(false)
}

/// Batch upload (desktop): every video in a folder the user picks ("folder", top level only,
/// sorted by name), or several videos picked at once ("files"). Too-big files are listed too;
/// the app skips them. None if the user cancelled.
#[tauri::command]
pub async fn pick_videos<R: Runtime>(app: AppHandle<R>, picked: State<'_, Picked>, mode: String) -> Result<Option<Vec<PickedFile>>, String> {
    if cfg!(target_os = "android") {
        return Err("batch upload is in the Windows app".into());
    }
    let mut paths: Vec<PathBuf> = Vec::new();
    if mode == "folder" {
        let Some(dir) = app.dialog().file().set_title("Choose a folder of videos").blocking_pick_folder() else { return Ok(None) };
        let dir = dir.into_path().map_err(|_| "this folder can't be opened here".to_string())?;
        paths = videos_in(&dir)?;
    } else {
        let Some(files) = app.dialog().file().add_filter("Videos", VIDEO_EXTENSIONS).blocking_pick_files() else { return Ok(None) };
        for f in files {
            if let Ok(p) = f.into_path() {
                if is_video_path(&p) {
                    paths.push(p);
                }
            }
        }
    }
    paths.truncate(MAX_BATCH);
    paths.into_iter().map(|p| picked_path(&picked, p)).collect::<Result<Vec<_>, _>>().map(Some)
}

/// The videos directly in `dir` (not in subfolders), sorted by name, at most MAX_BATCH.
fn videos_in(dir: &std::path::Path) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let p = entry.map_err(|e| e.to_string())?.path();
        if p.is_file() && is_video_path(&p) {
            paths.push(p);
        }
    }
    paths.sort_by_key(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()));
    paths.truncate(MAX_BATCH);
    Ok(paths)
}

fn picked_path(picked: &Picked, path: PathBuf) -> Result<PickedFile, String> {
    let meta = std::fs::metadata(&path).map_err(|e| friendly_io(&e))?;
    let name = path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "upload.bin".into());
    let id = picked.add(Source::Path(path), name.clone());
    Ok(PickedFile { id, mime: mime_for(&name).into(), name, size: meta.len(), online_only: is_online_only(&meta) })
}

/// Get a cloud placeholder's content onto this PC before it's posted (reading it through
/// makes OneDrive download it), with progress. Nothing to do for a file that's already here.
/// Cancel with cancel_upload(upload_id).
#[tauri::command]
pub async fn make_available<R: Runtime>(
    app: AppHandle<R>,
    picked: State<'_, Picked>,
    id: String,
    upload_id: String,
    on_progress: Channel<Progress>,
) -> Result<(), String> {
    use tokio::io::AsyncReadExt;
    let entry = picked.get(&id)?;
    let Source::Path(path) = &entry.source else { return Ok(()) };
    let meta = std::fs::metadata(path).map_err(|e| friendly_io(&e))?;
    if !is_online_only(&meta) {
        return Ok(());
    }
    // Don't even try: Windows would show its own error box for every file
    if in_onedrive(path) && !onedrive_running() {
        return Err(ONEDRIVE_NOT_RUNNING.into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    picked.cancels.lock().unwrap().insert(upload_id.clone(), cancel.clone());
    let result = async {
        let (file, total) = open_entry(&app, &entry)?;
        let mut f = tokio::fs::File::from_std(file);
        let mut buf = vec![0u8; 1024 * 1024];
        let mut done = 0u64;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("Upload cancelled.".to_string());
            }
            let n = f.read(&mut buf).await.map_err(|e| friendly_io(&e))?;
            if n == 0 {
                return Ok(());
            }
            done += n as u64;
            let _ = on_progress.send(Progress { sent: done, total });
        }
    }.await;
    picked.cancels.lock().unwrap().remove(&upload_id);
    result
}

/// Debug builds only: register a file as if the user had picked it, so automated UI
/// tests can post without a native dialog. Release builds refuse.
#[tauri::command]
pub fn debug_pick_path(picked: State<'_, Picked>, path: String) -> Result<PickedFile, String> {
    if !cfg!(debug_assertions) {
        return Err("not available".into());
    }
    picked_path(&picked, PathBuf::from(path))
}

/// The picked file's bytes, for previews (images, 3D models) and backups. Capped.
#[tauri::command]
pub async fn read_picked<R: Runtime>(app: AppHandle<R>, picked: State<'_, Picked>, id: String, max_bytes: u64) -> Result<tauri::ipc::Response, String> {
    let entry = picked.get(&id)?;
    let (file, len) = open_entry(&app, &entry)?;
    if len > max_bytes {
        return Err(format!("file is {len} bytes, over the {max_bytes} limit"));
    }
    let bytes = tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut buf = Vec::with_capacity(len as usize);
        file.take(max_bytes + 1).read_to_end(&mut buf).map(|_| buf)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("file is over the {max_bytes} limit"));
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn forget_picked(picked: State<'_, Picked>, id: String) {
    picked.files.lock().unwrap().remove(&id);
}

fn safe_name(name: &str, allowed: &str, max: usize) -> String {
    name.chars().map(|c| if c.is_alphanumeric() || allowed.contains(c) { c } else { '_' }).take(max).collect()
}

/// A temp file in the app's cache (Android hands it to the share sheet or MediaStore).
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn cache_file<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("out");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

/// Save text (a wallet backup). Desktop: the native save dialog. Android: Download/.
/// Returns where it went, or None if cancelled.
#[tauri::command]
pub async fn save_text<R: Runtime>(app: AppHandle<R>, default_name: String, contents: String) -> Result<Option<String>, String> {
    let name: String = default_name.chars().filter(|c| c.is_ascii_alphanumeric() || "-_.".contains(*c)).collect();
    #[cfg(target_os = "android")]
    {
        let tmp = cache_file(&app, &name)?;
        tokio::fs::write(&tmp, contents).await.map_err(|e| e.to_string())?;
        let saved = crate::native::android::save_to_collection(&app, &tmp, &name, "application/json", "downloads");
        let _ = tokio::fs::remove_file(&tmp).await;
        return saved.map(Some);
    }
    #[cfg(not(target_os = "android"))]
    {
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
}

/// Stream `url` into `dest` (via dest.part), refusing anything over `max` bytes.
async fn download_to(url: &str, dest: &std::path::Path, max: u64, timeout: Duration) -> Result<(), String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;
    let res = reqwest::Client::new().get(url).timeout(timeout).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(String::from));
        return Err(detail.unwrap_or_else(|| format!("Download failed (HTTP {status}).")));
    }
    if res.content_length().unwrap_or(0) > max {
        return Err("This download is too big.".into());
    }
    let tmp = dest.with_extension("part");
    let mut file = tokio::fs::File::create(&tmp).await.map_err(|e| e.to_string())?;
    let mut stream = res.bytes_stream();
    let mut written: u64 = 0;
    let result: Result<(), String> = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            written += chunk.len() as u64;
            if written > max {
                return Err("This download is too big.".into());
            }
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        }
        file.flush().await.map_err(|e| e.to_string())
    }
    .await;
    drop(file);
    if let Err(e) = result {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    tokio::fs::rename(&tmp, dest).await.map_err(|e| e.to_string())
}

fn teaser_url(base_url: &str, path: &str) -> Result<String, String> {
    if !path.starts_with("/teasers/") || path.contains("..") {
        return Err("not a teaser".into());
    }
    Ok(format!("{}{}", base_url.trim_end_matches('/'), path))
}

fn teaser_name(file_name: &str) -> String {
    let safe = safe_name(file_name, " -_", 60);
    let safe = if safe.trim().is_empty() { "GFC".to_string() } else { safe.trim().to_string() };
    format!("{safe}-teaser.mp4")
}

/// Save a teaser clip so it can be attached to a post: Videos\GFC on Windows (shown in
/// Explorer), Movies/GFC on Android. Returns where it went.
#[tauri::command]
pub async fn save_teaser<R: Runtime>(app: AppHandle<R>, base_url: String, path: String, file_name: String) -> Result<String, String> {
    let url = teaser_url(&base_url, &path)?;
    let name = teaser_name(&file_name);
    #[cfg(target_os = "android")]
    {
        let tmp = cache_file(&app, &name)?;
        download_to(&url, &tmp, MAX_TEASER_BYTES, Duration::from_secs(120)).await?;
        let saved = crate::native::android::save_to_collection(&app, &tmp, &name, "video/mp4", "movies");
        let _ = tokio::fs::remove_file(&tmp).await;
        return saved;
    }
    #[cfg(not(target_os = "android"))]
    {
        let dir = app.path().video_dir().map_err(|e| e.to_string())?.join("GFC");
        tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
        let dest = dir.join(name);
        download_to(&url, &dest, MAX_TEASER_BYTES, Duration::from_secs(120)).await?;
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("explorer").arg("/select,").arg(&dest).spawn();
        }
        Ok(dest.to_string_lossy().into_owned())
    }
}

/// Android: the system share sheet with the post's text and link, plus the teaser clip when
/// there is one (so X, LinkedIn or a Substack app gets the video too). Desktop: not available.
#[tauri::command]
pub async fn share_native<R: Runtime>(app: AppHandle<R>, text: String, base_url: String, teaser: Option<String>, file_name: String) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        let mut clip = None;
        if let Some(path) = teaser.filter(|p| !p.is_empty()) {
            let url = teaser_url(&base_url, &path)?;
            let tmp = cache_file(&app, &teaser_name(&file_name))?;
            // Share without the clip if it can't be fetched
            if download_to(&url, &tmp, MAX_TEASER_BYTES, Duration::from_secs(120)).await.is_ok() {
                clip = Some(tmp);
            }
        }
        crate::native::android::share(&app, &text, clip.as_deref(), Some("video/mp4"), "Share your GFC post")?;
        return Ok(clip.is_some());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, text, base_url, teaser, file_name);
        Err("the share sheet is Android-only".into())
    }
}

/// Save a post's download (a zip). Desktop: the native save dialog, streaming to disk.
/// Android: into Download/. Returns where it went, or None if the user cancelled.
#[tauri::command]
pub async fn download_file<R: Runtime>(app: AppHandle<R>, url: String, default_name: String) -> Result<Option<String>, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("not a web link".into());
    }
    let name = safe_name(&default_name, " -_.()", 120);
    let name = if name.trim().is_empty() { "download.zip".to_string() } else { name };
    #[cfg(target_os = "android")]
    {
        let tmp = cache_file(&app, &name)?;
        download_to(&url, &tmp, MAX_DOWNLOAD_BYTES, Duration::from_secs(30 * 60)).await?;
        let saved = crate::native::android::save_to_collection(&app, &tmp, &name, mime_for(&name), "downloads");
        let _ = tokio::fs::remove_file(&tmp).await;
        return saved.map(Some);
    }
    #[cfg(not(target_os = "android"))]
    {
        let mut d = app.dialog().file().set_file_name(name);
        if let Ok(dir) = app.path().download_dir() {
            d = d.set_directory(dir);
        }
        let Some(fp) = d.blocking_save_file() else { return Ok(None) };
        let path = fp.into_path().map_err(|e| e.to_string())?;
        download_to(&url, &path, MAX_DOWNLOAD_BYTES, Duration::from_secs(30 * 60)).await?;
        Ok(Some(path.to_string_lossy().into_owned()))
    }
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
pub async fn upload_seed<R: Runtime>(
    app: AppHandle<R>,
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
    teaser_seconds: Option<u32>,
    thumbnail: Option<Vec<u8>>,
    on_progress: Channel<Progress>,
) -> Result<HttpResult, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    picked.cancels.lock().unwrap().insert(upload_id.clone(), cancel.clone());
    let result = upload_inner(&app, &picked, &base_url, &token, file_id, text, title, description, tags, exclusive, teaser_seconds, thumbnail, on_progress, cancel).await;
    picked.cancels.lock().unwrap().remove(&upload_id);
    result
}

#[allow(clippy::too_many_arguments)]
async fn upload_inner<R: Runtime>(
    app: &AppHandle<R>,
    picked: &Picked,
    base_url: &str,
    token: &str,
    file_id: Option<String>,
    text: Option<String>,
    title: String,
    description: String,
    tags: String,
    exclusive: bool,
    teaser_seconds: Option<u32>,
    thumbnail: Option<Vec<u8>>,
    on_progress: Channel<Progress>,
    cancel: Arc<AtomicBool>,
) -> Result<HttpResult, String> {
    use reqwest::multipart::{Form, Part};

    let mut form = Form::new().text("title", title).text("description", description).text("tags", tags);
    if exclusive {
        form = form.text("exclusive", "true");
        if let Some(sec) = teaser_seconds {
            form = form.text("teaser_seconds", sec.to_string());
        }
    }
    if let Some(t) = thumbnail.filter(|t| !t.is_empty()) {
        form = form.part("thumbnail", Part::bytes(t).file_name("thumb.jpg").mime_str("image/jpeg").unwrap());
    }

    let (part, total) = if let Some(id) = file_id {
        let entry = picked.get(&id)?;
        let (file, len) = open_entry(app, &entry)?;
        if len + 64 * 1024 > MAX_UPLOAD_BYTES {
            return Err(format!("This file is {:.0} MB; uploads are limited to 200 MB.", len as f64 / 1048576.0));
        }
        let name: String = entry.name.chars().filter(|c| !matches!(c, '"' | '\r' | '\n')).collect();
        let name = if name.is_empty() { "upload.bin".to_string() } else { name };
        let sent = Arc::new(AtomicU64::new(0));
        let stream = progress_stream(tokio::fs::File::from_std(file), len, sent, on_progress.clone(), cancel.clone());
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

#[cfg(test)]
mod batch_tests {
    use super::*;

    #[test]
    fn a_folder_lists_its_videos_by_name_and_nothing_else() {
        let dir = std::env::temp_dir().join(format!("gfc-batch-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        for name in ["b clip.MP4", "a.mov", "notes.txt", "cover.jpg", "c.webm", "sub/inner.mp4"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        std::fs::create_dir_all(dir.join("folder.mp4")).unwrap(); // a folder named like a video
        let names: Vec<String> = videos_in(&dir).unwrap().iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["a.mov", "b clip.MP4", "c.webm"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cloud_errors_get_a_plain_explanation() {
        // 0x80070194: "The cloud file provider exited unexpectedly" (OneDrive crashed)
        let crashed = std::io::Error::from_raw_os_error(0x194);
        assert!(friendly_io(&crashed).contains("OneDrive"));
        assert!(friendly_io(&crashed).contains("Always keep on this device"));
        let missing = std::io::Error::from_raw_os_error(2);
        assert!(!friendly_io(&missing).contains("OneDrive"));
    }

    #[test]
    fn a_normal_file_is_not_online_only() {
        let p = std::env::temp_dir().join(format!("gfc-local-{}.mp4", std::process::id()));
        std::fs::write(&p, b"x").unwrap();
        assert!(!is_online_only(&std::fs::metadata(&p).unwrap()));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn onedrive_folders_are_recognised() {
        let root = std::env::temp_dir().join("gfc-fake-onedrive");
        std::env::set_var("OneDriveConsumer", &root);
        assert!(in_onedrive(&root.join("Videos").join("clip.mp4")));
        assert!(!in_onedrive(&std::env::temp_dir().join("elsewhere.mp4")));
    }

    #[test]
    fn a_batch_stops_at_the_limit() {
        let dir = std::env::temp_dir().join(format!("gfc-batch-limit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..(MAX_BATCH + 5) {
            std::fs::write(dir.join(format!("v{i:03}.mp4")), b"x").unwrap();
        }
        assert_eq!(videos_in(&dir).unwrap().len(), MAX_BATCH);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
