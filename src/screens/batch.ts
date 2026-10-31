// Batch upload (Windows): pick a folder of videos (or several videos at once), check the
// titles, set one description, tags and the Exclusive options for them all, and post them
// one after another. Each video is its own post, with its own first-frame thumbnail.

import { invoke } from "@tauri-apps/api/core";
import { api, ApiError, type UploadResult } from "../api";
import { registerScreen, back, go, askToVerify, whenAllowedToPost } from "../app";
import { h, clear, toast, fmtBytes } from "../ui/dom";
import { celebrate, checkEarnings } from "../earnings";
import { canvasJpeg, readPicked, MAX_UPLOAD, PREVIEW_LENGTHS, VIDEO_PREVIEW_MAX, type Picked } from "./post";

type Status = "waiting" | "uploading" | "posted" | "failed" | "skipped" | "cancelled";

interface Row {
  file: Picked;
  include: HTMLInputElement;
  title: HTMLInputElement;
  status: HTMLElement;
  bar: HTMLElement;
  state: Status;
  result?: UploadResult;
}

/** "my_trip-2026_part 2.mp4" -> "my trip 2026 part 2" */
export function titleFromFileName(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").replace(/\s*-\s*/g, " - ").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** A JPEG of the video's first frame, or null (too big to read, or it won't decode here). */
async function videoThumb(p: Picked): Promise<Uint8Array | null> {
  if (p.size >= VIDEO_PREVIEW_MAX) return null;
  const url = URL.createObjectURL(new Blob([await readPicked(p, VIDEO_PREVIEW_MAX)], { type: p.mime }));
  try {
    const v = h("video", { src: url, muted: true, preload: "auto" }) as HTMLVideoElement;
    v.muted = true;
    await new Promise<void>((ok, fail) => {
      v.addEventListener("loadeddata", () => ok(), { once: true });
      v.addEventListener("error", () => fail(new Error("can't decode")), { once: true });
      setTimeout(() => fail(new Error("timed out")), 15000);
    });
    const blob = await canvasJpeg(v, v.videoWidth, v.videoHeight, 0.82);
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

let running = false;

registerScreen("batch", (_route, page) => {
  let rows: Row[] = [];
  let stopRequested = false;
  let uploadId = "";

  const list = h("div.batch-list");
  const summary = h("div.muted.small");
  const description = h("textarea", { placeholder: "Description for every video (optional)", maxlength: 5000, rows: 3 }) as HTMLTextAreaElement;
  const tags = h("input", { placeholder: "Tags, comma-separated (optional)", maxlength: 300 }) as HTMLInputElement;
  const exclusive = h("input", { type: "checkbox" }) as HTMLInputElement;
  const lengthRadios = PREVIEW_LENGTHS.map((n) =>
    h("input", { type: "radio", name: "batch-preview-length", value: String(n), checked: n === 5 }) as HTMLInputElement);
  const lengthRow = h("div.hidden", { style: "margin-top:8px" },
    h("label", "Preview length"),
    h("div.row.wrap", { style: "gap:16px" }, lengthRadios.map((r, i) => h("label.check", r, `${PREVIEW_LENGTHS[i]} s`))));
  const previewSeconds = () => Number(lengthRadios.find((r) => r.checked)?.value ?? 5);
  const postBtn = h("button.btn", "Post all") as HTMLButtonElement;
  const stopBtn = h("button.btn.secondary.hidden", "Stop after this one") as HTMLButtonElement;
  const overall = h("div.muted.small", { style: "margin-top:8px" });

  const included = () => rows.filter((r) => r.include.checked && r.state !== "posted" && r.state !== "skipped");

  const refresh = () => {
    const n = included().length;
    postBtn.disabled = running || n === 0;
    postBtn.textContent = running ? "Posting…" : n ? `Post ${n} video${n === 1 ? "" : "s"}` : "Post all";
    lengthRow.classList.toggle("hidden", !exclusive.checked);
    for (const el of [description, tags, exclusive, ...lengthRadios]) el.disabled = running;
    for (const r of rows) r.include.disabled = r.title.disabled = running || r.state === "posted" || r.state === "skipped";
    const total = rows.reduce((s, r) => s + (r.include.checked && r.state !== "skipped" ? r.file.size : 0), 0);
    summary.textContent = rows.length
      ? `${rows.length} video${rows.length === 1 ? "" : "s"} found · ${n} to post · ${fmtBytes(total)}`
      : "";
  };

  const setStatus = (r: Row, state: Status, text: string, cls = "muted") => {
    r.state = state;
    r.status.className = `small ${cls}`;
    r.status.textContent = text;
  };

  const choose = async (mode: "folder" | "files") => {
    if (running) return;
    let files: Picked[] | null;
    try {
      files = await invoke<Picked[] | null>("pick_videos", { mode });
    } catch (e) {
      return toast(String(e), true);
    }
    if (!files) return;
    for (const r of rows) invoke("forget_picked", { id: r.file.id }).catch(() => {});
    if (!files.length) {
      rows = [];
      clear(list, h("div.empty", mode === "folder" ? "No videos in that folder (MP4, MOV, WebM, MKV, AVI…)." : "No videos picked."));
      return refresh();
    }
    rows = files.map((file) => {
      const r: Row = {
        file,
        include: h("input", { type: "checkbox", checked: true }) as HTMLInputElement,
        title: h("input", { value: titleFromFileName(file.name), maxlength: 300, placeholder: "Title" }) as HTMLInputElement,
        status: h("div.small.muted"),
        bar: h("div.progress.hidden", h("div")),
        state: "waiting",
      };
      r.include.addEventListener("change", refresh);
      if (file.size + 64 * 1024 > MAX_UPLOAD) {
        r.include.checked = false;
        setStatus(r, "skipped", `Too big: ${fmtBytes(file.size)} (the limit is ${fmtBytes(MAX_UPLOAD)})`, "danger");
      } else {
        setStatus(r, "waiting", fmtBytes(file.size));
      }
      return r;
    });
    clear(list, rows.map((r) => h("div.batch-row",
      r.include,
      h("div.grow", r.title, h("div.muted.small.batch-name", r.file.name), r.bar, r.status))));
    refresh();
  };

  const postAll = () => whenAllowedToPost(async () => {
    if (running) return;
    const queue = included();
    if (!queue.length) return;
    running = true;
    stopRequested = false;
    stopBtn.classList.remove("hidden");
    refresh();
    let posted = 0, failed = 0, bonus = 0;
    for (const [i, r] of queue.entries()) {
      if (stopRequested) {
        setStatus(r, "cancelled", "Not posted (stopped)");
        continue;
      }
      overall.textContent = `Posting ${i + 1} of ${queue.length}…`;
      setStatus(r, "uploading", "Making the thumbnail…");
      r.bar.classList.remove("hidden");
      const thumb = await videoThumb(r.file);
      uploadId = crypto.randomUUID();
      try {
        const { result } = await api.upload({
          fileId: r.file.id,
          title: r.title.value.trim() || titleFromFileName(r.file.name),
          description: description.value.trim(),
          tags: tags.value.trim(),
          exclusive: exclusive.checked,
          teaserSeconds: exclusive.checked ? previewSeconds() : undefined,
          thumbnail: thumb,
        }, (sent, total) => {
          (r.bar.firstChild as HTMLElement).style.width = `${total ? (100 * sent) / total : 0}%`;
          setStatus(r, "uploading", `Uploading ${fmtBytes(sent)} of ${fmtBytes(total)}`);
        }, uploadId);
        r.result = result;
        posted++;
        bonus += result.first_post_bonus ?? 0;
        setStatus(r, "posted", result.exclusive ? "Posted · exclusive" : "Posted", "success");
        r.status.append(" · ", h("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); go({ name: "seed", id: result.id }); } }, "View"));
      } catch (e) {
        const msg = String((e as Error).message ?? e);
        failed++;
        setStatus(r, /cancel/i.test(msg) ? "cancelled" : "failed", msg, /cancel/i.test(msg) ? "muted" : "danger");
        if (e instanceof ApiError && e.status === 403 && /phone/i.test(msg)) {
          askToVerify(msg);
          stopRequested = true;
        }
      } finally {
        r.bar.classList.add("hidden");
        refresh();
      }
    }
    running = false;
    stopBtn.classList.add("hidden");
    overall.textContent = `${posted} posted${failed ? `, ${failed} failed` : ""}${stopRequested ? " (stopped)" : ""}.`
      + (failed ? " Press Post again to retry the ones that failed." : "");
    if (bonus) {
      celebrate(bonus, "First post bonus!");
      checkEarnings();
    }
    refresh();
  });

  postBtn.onclick = postAll;
  stopBtn.onclick = () => {
    stopRequested = true;
    stopBtn.textContent = "Stopping after this one…";
  };
  exclusive.addEventListener("change", refresh);
  description.addEventListener("input", refresh);

  page.append(
    h("div.pagehead", h("div.title",
      h("button.iconbtn", { title: "Back", style: "font-size:20px", onclick: back }, "←"),
      h("h1.grow", "Batch upload"))),
    h("div.page",
      h("p.muted", "Post many videos at once: each one becomes its own post. Up to 100 videos, 200 MB each."),
      h("div.row.wrap", { style: "gap:8px" },
        h("button.btn", { onclick: () => choose("folder") }, "Choose a folder"),
        h("button.btn.secondary", { onclick: () => choose("files") }, "Choose videos")),
      summary,
      list,
      h("label", { style: "margin-top:16px" }, "For every video"),
      description,
      tags,
      h("label.check", { style: "margin-top:8px" }, exclusive, "Exclusive to GFC Network"),
      h("div.muted.small", "Only real GFC accounts can watch the full clips; everyone else gets a short preview to share."),
      lengthRow,
      h("div.row.wrap", { style: "gap:8px;margin-top:16px" }, postBtn, stopBtn),
      overall));
  refresh();

  return () => {
    // Leaving mid-batch: finish the current video and stop there
    if (running) stopRequested = true;
    else for (const r of rows) invoke("forget_picked", { id: r.file.id }).catch(() => {});
  };
});
