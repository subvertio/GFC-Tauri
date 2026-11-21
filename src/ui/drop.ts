// Drag and drop a file anywhere on the app to post it. The post screen works out what it is
// (photo, video, audio, 3D model, download, other file) from its name, as with the pickers.
//
// Windows app: Tauri's drag-drop events (the webview's own HTML drag and drop is off); the paths
// are recorded natively and fetched with take_dropped, so the page never names a path.
// Web app: the browser's drop event and its File objects.

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke, addWebFile } from "../native";
import { inTauri, isAndroid } from "../api";
import { currentRoute, go, whenAllowedToPost } from "../app";
import { session } from "../session";
import { toast } from "./dom";

export interface DroppedFile { id: string; name: string; size: number; mime: string; online_only?: boolean }

let handler: ((f: DroppedFile) => void) | null = null;

/** The post screen takes drops itself while it's open (returns the remover). */
export function onDrop(fn: (f: DroppedFile) => void): () => void {
  handler = fn;
  return () => { if (handler === fn) handler = null; };
}

function deliver(files: DroppedFile[]) {
  if (!files.length) return toast("Drop a file (folders can't be posted). For many videos at once, use Batch upload.", true);
  const [first] = files;
  if (files.length > 1) toast(`One file per post: ${first.name} is attached.${inTauri ? " For many videos at once, use Batch upload." : ""}`);
  if (!session.loggedIn) {
    forget(files);
    return toast("Log in to post.", true);
  }
  for (const extra of files.slice(1)) forget([extra]);
  if (handler && currentRoute().name === "post") return handler(first);
  whenAllowedToPost(() => go({ name: "post", dropped: first }));
}

function forget(files: DroppedFile[]) {
  for (const f of files) invoke("forget_picked", { id: f.id }).catch(() => {});
}

const show = (on: boolean) => document.body.classList.toggle("dropping", on);

export function installDrop() {
  if (isAndroid) return;
  if (inTauri) {
    getCurrentWebview().onDragDropEvent(async (e) => {
      const t = e.payload.type;
      if (t === "enter" || t === "over") return show(true);
      show(false);
      if (t !== "drop") return;
      try {
        deliver(await invoke<DroppedFile[]>("take_dropped"));
      } catch (err) {
        toast(String((err as Error).message ?? err), true);
      }
    }).catch(() => {});
    return;
  }
  // Web app: only file drags (not text or links dragged inside the page)
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  let depth = 0;
  window.addEventListener("dragenter", (e) => { if (hasFiles(e)) { depth++; show(true); } });
  window.addEventListener("dragleave", (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; show(false); } });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    show(false);
    deliver([...(e.dataTransfer?.files ?? [])].filter((f) => f.size > 0 || f.type).map(addWebFile));
  });
}
