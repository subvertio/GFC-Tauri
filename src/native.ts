// The app's native commands, also in a plain browser: the iPhone web app (installed from Safari
// with Add to Home Screen) runs this same code without Tauri. In the desktop and Android apps
// `invoke` is Tauri's; in a browser it's `webInvoke`, which does the same jobs with web APIs:
// files come from <input type=file>, uploads go over XMLHttpRequest (for progress), and saved
// files are downloads. Commands a browser can't do (OneDrive, folders of videos) aren't offered
// there (the callers check `inTauri`).

import { invoke as tauriInvoke } from "@tauri-apps/api/core";

const inTauri = "__TAURI_INTERNALS__" in window; // as in api.ts, which imports this module

export interface WebPicked { id: string; name: string; size: number; mime: string }
export interface HttpResult { status: number; body: string }

const files = new Map<string, File>();
const uploads = new Map<string, XMLHttpRequest>();

const ACCEPT: Record<string, string> = {
  media: "image/*,video/*",
  image: "image/*",
  backup: ".json,application/json",
  text: ".txt,text/plain",
};

/** A file the user picks: kept in memory under a random id, like the desktop app's picked files. */
function pickFile(kind: string): Promise<WebPicked | null> {
  return new Promise((done) => {
    const input = document.createElement("input");
    input.type = "file";
    if (ACCEPT[kind]) input.accept = ACCEPT[kind];
    input.style.display = "none";
    let settled = false;
    const finish = (p: WebPicked | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      done(p);
    };
    input.addEventListener("change", () => {
      const f = input.files?.[0];
      if (!f) return finish(null);
      const id = crypto.randomUUID();
      files.set(id, f);
      finish({ id, name: f.name, size: f.size, mime: f.type || "application/octet-stream" });
    });
    input.addEventListener("cancel", () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}

export function pickedFile(id: string): File | undefined {
  return files.get(id);
}

/** Upload a post like the desktop app's upload_seed: multipart to /seeds/upload, with progress. */
export function webUpload(args: {
  uploadId: string; baseUrl: string; token: string; fileId: string | null; text: string | null;
  title: string; description: string; tags: string; exclusive: boolean; teaserSeconds: number | null;
  thumbnail: Uint8Array | null; onProgress: (sent: number, total: number) => void;
}): Promise<HttpResult> {
  const form = new FormData();
  form.append("title", args.title);
  form.append("description", args.description);
  form.append("tags", args.tags);
  if (args.exclusive) {
    form.append("exclusive", "true");
    if (args.teaserSeconds) form.append("teaser_seconds", String(args.teaserSeconds));
  }
  if (args.thumbnail) form.append("thumbnail", new Blob([new Uint8Array(args.thumbnail)], { type: "image/jpeg" }), "thumb.jpg");
  if (args.fileId) {
    const f = files.get(args.fileId);
    if (!f) return Promise.reject(new Error("The picked file is gone: pick it again."));
    form.append("file", f, f.name || "upload.bin");
  } else if (args.text !== null) {
    form.append("file", new Blob([args.text], { type: "text/plain" }), "post.txt");
  } else {
    return Promise.reject(new Error("nothing to upload"));
  }
  return new Promise((done, fail) => {
    const xhr = new XMLHttpRequest();
    uploads.set(args.uploadId, xhr);
    xhr.open("POST", `${args.baseUrl.replace(/\/+$/, "")}/seeds/upload`);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Authorization", `Bearer ${args.token}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) args.onProgress(e.loaded, e.total); };
    xhr.onload = () => {
      uploads.delete(args.uploadId);
      done({ status: xhr.status, body: xhr.responseText });
    };
    xhr.onerror = () => {
      uploads.delete(args.uploadId);
      done({ status: 0, body: "Couldn't reach the node." }); // status 0: the caller retries
    };
    xhr.onabort = () => {
      uploads.delete(args.uploadId);
      fail(new Error("Upload cancelled."));
    };
    xhr.send(form);
  });
}

/** Save text as a download (the wallet backup): returns a name to show, since browsers don't say where. */
function saveText(defaultName: string, contents: string): string {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return `${defaultName} (in your Downloads or Files)`;
}

/** Video duration and size from the browser's own decoder (the desktop app reads the file header). */
function videoInfo(id: string): Promise<{ duration: number; width: number; height: number } | null> {
  const f = files.get(id);
  if (!f) return Promise.resolve(null);
  return new Promise((done) => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(f);
    const end = (r: { duration: number; width: number; height: number } | null) => {
      URL.revokeObjectURL(url);
      done(r);
    };
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => end({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
    v.onerror = () => end(null);
    setTimeout(() => end(null), 8000);
    v.src = url;
  });
}

async function webInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  switch (cmd) {
    case "pick_file":
      return (await pickFile(String(args.kind ?? ""))) as T;
    case "read_picked": {
      const f = files.get(String(args.id));
      if (!f) throw new Error("The picked file is gone: pick it again.");
      return (await f.slice(0, Number(args.maxBytes) || f.size).arrayBuffer()) as T;
    }
    case "forget_picked":
      files.delete(String(args.id));
      return undefined as T;
    case "cancel_upload":
      uploads.get(String(args.uploadId))?.abort();
      return undefined as T;
    case "save_text":
      return saveText(String(args.defaultName), String(args.contents)) as T;
    case "video_info":
      return (await videoInfo(String(args.id))) as T;
    case "onedrive_missing":
    case "onedrive_status":
      return false as T;
    default:
      throw new Error(`"${cmd}" needs the GFC desktop or Android app.`);
  }
}

export const invoke: typeof tauriInvoke = inTauri ? tauriInvoke : (webInvoke as typeof tauriInvoke);
