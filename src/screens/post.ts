// New post: title, then text, then media (optional), then Post. Text-only posts are
// uploaded as a small .txt. Videos, text posts and downloads (.zip) can be "Exclusive to
// GFC Network": the poster picks where to share it (X, LinkedIn, Substack) and, for a
// video, how long the public preview is (5, 10 or 30 s). One Share click does them all.

import { invoke } from "@tauri-apps/api/core";
import { api, inTauri, isAndroid, titleFromBody, ApiError, type UploadResult } from "../api";
import { registerScreen, back, go, askToVerify, type Route } from "../app";
import { h, clear, toast, fmtBytes } from "../ui/dom";
import { load3d } from "../lazy3d";
import type { ModelView } from "../viewer3d";
import { SHARE_TARGETS, availableTargets, saveTeaser, shareTo, type ShareTarget } from "../ui/share";
import { celebrate, checkEarnings } from "../earnings";

export interface Picked {
  id: string; name: string; size: number; mime: string;
  /** OneDrive "Available when online": downloaded from the cloud before it's posted */
  online_only?: boolean;
}
export const MAX_UPLOAD = 200 * 1024 * 1024;
const VIDEO_EXT = ["mp4", "mov", "webm", "mkv", "avi", "wmv", "flv"];
const ext = (n: string) => n.split(".").pop()!.toLowerCase();
const isVideo = (p: Picked) => p.mime.startsWith("video/") || VIDEO_EXT.includes(ext(p.name));
const isImage = (p: Picked) => p.mime.startsWith("image/");
const isModel = (p: Picked) => ["glb", "gltf"].includes(ext(p.name));
const isZipFile = (p: Picked) => ext(p.name) === "zip";
export const PREVIEW_LENGTHS = [5, 10, 30];
// The preview (and its first-frame thumbnail) reads the clip into memory: less on phones
export const VIDEO_PREVIEW_MAX = (isAndroid ? 40 : 120) * 1024 * 1024;

let uploading = false;

export async function readPicked(p: Picked, max: number): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("read_picked", { id: p.id, maxBytes: max });
}

export function canvasJpeg(src: CanvasImageSource, w: number, hgt: number, quality: number): Promise<Blob | null> {
  const scale = Math.min(1, 512 / Math.max(w, hgt));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(hgt * scale));
  c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
  return new Promise((ok) => c.toBlob(ok, "image/jpeg", quality));
}

registerScreen("post", (route, page) => {
  const r = route as Extract<Route, { name: "post" }>;
  let picked: Picked | null = null;
  let thumbMaker: (() => Promise<Blob | null>) | null = null;
  let model: ModelView | null = null;
  let objectUrl = "";
  let uploadId = "";

  const title = h("input", { placeholder: "Title (optional for text)", maxlength: 300 }) as HTMLInputElement;
  const text = h("textarea", { placeholder: "What's on your mind?", maxlength: 5000, rows: 6 }) as HTMLTextAreaElement;
  text.value = r.text ?? "";
  const mediaPanel = h("div.hidden");
  const exclusive = h("input", { type: "checkbox" }) as HTMLInputElement;
  const exclusiveHint = h("div.muted.small");
  // Shown while Exclusive is ticked: where to share it, and (videos) the preview length
  const targetBoxes = new Map<ShareTarget, HTMLInputElement>(
    SHARE_TARGETS.map((t) => [t.id, h("input", { type: "checkbox", checked: t.id === "x" }) as HTMLInputElement]));
  const allBox = h("input", { type: "checkbox" }) as HTMLInputElement;
  const lengthRadios = PREVIEW_LENGTHS.map((n) =>
    h("input", { type: "radio", name: "preview-length", value: String(n), checked: n === 5 }) as HTMLInputElement);
  const syncAll = () => (allBox.checked = [...targetBoxes.values()].every((b) => b.checked));
  for (const b of targetBoxes.values()) b.addEventListener("change", syncAll);
  allBox.addEventListener("change", () => targetBoxes.forEach((b) => (b.checked = allBox.checked)));
  const lengthRow = h("div",
    h("label", "Preview length"),
    h("div.row.wrap", { style: "gap:16px" }, lengthRadios.map((r, i) => h("label.check", r, `${PREVIEW_LENGTHS[i]} s`))));
  const exclusiveOptions = h("div.hidden", { style: "margin-top:4px" },
    h("label", "Share to"),
    h("div.row.wrap", { style: "gap:16px" },
      SHARE_TARGETS.map((t) => h("label.check", targetBoxes.get(t.id)!, t.label)),
      h("label.check", allBox, "All")),
    lengthRow);
  const previewSeconds = () => Number(lengthRadios.find((r) => r.checked)?.value ?? 5);
  for (const r of lengthRadios) r.addEventListener("change", () => update());
  const postBtn = h("button.btn.block", "Post") as HTMLButtonElement;
  const headerPost = h("button.btn.small", "Post") as HTMLButtonElement;
  const progress = h("div.progress.hidden", h("div"));
  const progressText = h("div.muted.small");
  const cancelBtn = h("button.btn.secondary.small.hidden", "Cancel upload") as HTMLButtonElement;
  const resultEl = h("div", { style: "white-space:pre-line;margin-top:12px" });
  const after = h("div.row.wrap.hidden", { style: "margin-top:12px" });
  const notes = h("div.small", { style: "margin-top:8px;line-height:1.6" });

  const tooBig = () => !!picked && picked.size + 64 * 1024 > MAX_UPLOAD;
  const exclusiveAllowed = () => !picked || isVideo(picked) || isZipFile(picked);

  const update = () => {
    const can = (!!text.value.trim() || !!picked) && !tooBig() && !uploading;
    postBtn.disabled = headerPost.disabled = !can;
    const allowed = exclusiveAllowed();
    if (!allowed) exclusive.checked = false;
    exclusive.disabled = !allowed || uploading;
    const video = !!picked && isVideo(picked);
    exclusiveOptions.classList.toggle("hidden", !exclusive.checked || !allowed);
    lengthRow.classList.toggle("hidden", !video);
    lengthRadios.forEach((r) => (r.disabled = uploading));
    exclusiveHint.textContent = !allowed
      ? "Only videos, text posts and downloads (.zip) can be exclusive."
      : !exclusive.checked
        ? "Only real GFC accounts see all of it; the rest of the world gets a preview to share."
        : video
          ? `A ${previewSeconds()}-second preview is public (share it). Only real GFC accounts can watch the full clip.`
          : picked
            ? "Everyone sees the title. Only real GFC accounts can download it."
            : "Everyone sees the title. Only real GFC accounts can read the post.";
  };
  text.addEventListener("input", update);
  exclusive.addEventListener("change", update);

  const dropMedia = () => {
    if (picked && inTauri) invoke("forget_picked", { id: picked.id }).catch(() => {});
    picked = null;
    thumbMaker = null;
    model?.dispose();
    model = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = "";
    clear(mediaPanel);
    mediaPanel.classList.add("hidden");
    update();
  };

  // Windows' file dialog takes about half a second to appear (it lists the folder first),
  // so the button says so at once, and a second click can't queue a second dialog.
  const pick = async (kind: "media" | "file", btn?: HTMLButtonElement) => {
    if (!inTauri) return toast("Picking files needs the desktop app.", true);
    if (uploading) return toast("Wait for the current upload to finish, or cancel it.");
    if (btn?.disabled) return;
    const label = btn?.textContent ?? "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Opening…";
    }
    try {
      const p = await invoke<Picked | null>("pick_file", { kind });
      if (p) await usePicked(p);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
    }
  };

  const usePicked = async (p: Picked) => {
    dropMedia();
    picked = p;
    if (!title.value.trim() && !text.value.trim()) title.value = p.name.replace(/\.[^.]+$/, "");
    const info = h("div.small", `${p.name} · ${fmtBytes(p.size)}`);
    const prev = h("div");
    clear(mediaPanel, prev, h("div.row", { style: "margin-top:8px" }, h("div.grow", info),
      h("button.btn.secondary.small", { onclick: dropMedia }, "Remove")));
    mediaPanel.classList.remove("hidden");
    if (tooBig()) info.append(h("div.danger", "Too big: uploads are limited to 200 MB. Trim the video and try again."));
    update();
    try {
      if (isImage(p) && p.size < 40 * 1024 * 1024) {
        objectUrl = URL.createObjectURL(new Blob([await readPicked(p, 40 * 1024 * 1024)], { type: p.mime }));
        const img = h("img", { src: objectUrl, style: "max-height:280px;object-fit:contain" }) as HTMLImageElement;
        prev.append(h("div.media", img));
        await img.decode();
        thumbMaker = () => canvasJpeg(img, img.naturalWidth, img.naturalHeight, 0.82);
      } else if (isVideo(p) && p.size < VIDEO_PREVIEW_MAX) {
        objectUrl = URL.createObjectURL(new Blob([await readPicked(p, VIDEO_PREVIEW_MAX)], { type: p.mime }));
        const v = h("video", { src: objectUrl, muted: true, controls: true, preload: "auto", style: "max-height:280px" }) as HTMLVideoElement;
        v.muted = true;
        prev.append(h("div.media", v));
        thumbMaker = () => new Promise((ok) => {
          const grab = () => canvasJpeg(v, v.videoWidth, v.videoHeight, 0.82).then(ok);
          if (v.readyState >= 2) grab();
          else v.addEventListener("loadeddata", grab, { once: true });
        });
      } else if (isModel(p)) {
        const box = h("div.media.model", { style: "max-height:320px" }, h("div.note", "Building the 3D preview…"));
        prev.append(box);
        const { ModelView, BUDGET } = await load3d();
        if (p.size > BUDGET.bytes) throw new Error(`over the ${BUDGET.bytes / 1048576} MB limit`);
        model = new ModelView(box, { onStatus: () => {} });
        const res = await model.loadBytes(await readPicked(p, BUDGET.bytes));
        box.querySelector(".note")?.remove();
        info.append(h("div.muted", `${res.triangles.toLocaleString()} triangles${res.animation ? `, animated (${res.animation})` : ""}. Drag to turn it; the thumbnail is the view when you post.`));
        thumbMaker = async () => {
          const shot = await model?.snapshot();
          if (!shot) return null;
          const bmp = await createImageBitmap(shot);
          return canvasJpeg(bmp, bmp.width, bmp.height, 0.85);
        };
      }
    } catch (e) {
      if (isModel(p)) {
        model?.dispose();
        model = null;
        info.append(h("div", { style: "color:#ffad1f" }, `The app's 3D viewer can't show this model: ${(e as Error).message ?? e}`));
      }
    }
  };

  const doPost = async () => {
    if (uploading) return;
    const body = text.value.trim();
    if (!body && !picked) return;
    uploading = true;
    update();
    uploadId = crypto.randomUUID();
    let thumb: Uint8Array | null = null;
    try {
      const b = await thumbMaker?.();
      if (b) thumb = new Uint8Array(await b.arrayBuffer());
    } catch {
      /* post without a thumbnail */
    }
    const targets = [...targetBoxes].filter(([, b]) => b.checked).map(([t]) => t);
    const seconds = picked && isVideo(picked) ? previewSeconds() : undefined;
    const ttl = title.value.trim() || (picked ? picked.name.replace(/\.[^.]+$/, "") : titleFromBody(body));
    progress.classList.remove("hidden");
    cancelBtn.classList.remove("hidden");
    clear(resultEl);
    try {
      const { result: res, attempts } = await api.upload(
        { fileId: picked?.id, text: picked ? undefined : body, title: ttl, description: body, tags: "", exclusive: exclusive.checked, teaserSeconds: seconds, thumbnail: thumb },
        (sent, total) => {
          (progress.firstChild as HTMLElement).style.width = `${total ? (100 * sent) / total : 0}%`;
          progressText.textContent = `Uploading ${fmtBytes(sent)} of ${fmtBytes(total)}`;
        },
        uploadId,
      );
      showResult(res, attempts, targets);
      dropMedia();
      title.value = "";
      text.value = "";
      exclusive.checked = false;
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      clear(resultEl, h("div", { class: /cancel/i.test(msg) ? "muted" : "danger" }, msg));
      if (e instanceof ApiError && e.status === 403 && /phone/i.test(msg)) askToVerify(msg);
    } finally {
      uploading = false;
      progress.classList.add("hidden");
      cancelBtn.classList.add("hidden");
      progressText.textContent = "";
      update();
    }
  };

  const showResult = (res: UploadResult, attempts: number, chosen: ShareTarget[]) => {
    const secs = res.teaser_seconds ?? 5;
    const lines = [attempts > 1 ? `Posted (after ${attempts} tries).` : "Posted!"];
    if (res.repost_of) lines.push(`This looks like a repost of @${res.repost_of.owner}. They'll get the credit.`);
    else if (res.first_post_bonus) lines.push(`You earned ${res.first_post_bonus} GFC for your first post!`);
    else if (res.first_post_bonus_pending) lines.push("Your first post bonus is saved. Verify your phone and have a wallet (both in Wallet) to collect it.");
    else if (res.rewards_enabled === false) lines.push("Create a wallet so your posts can earn GFC.");
    if (res.exclusive) {
      if (res.content_type === "video") lines.push(res.teaser
        ? `Exclusive to the GFC Network. Here's your ${secs}-second teaser: share it, and the full clip stays for GFC accounts.`
        : "Exclusive to the GFC Network. The teaser is still being made; you can share the link now.");
      else if (res.download) lines.push("Exclusive to the GFC Network. Share it: people see the title and come to GFC to download it.");
      else lines.push("Exclusive to the GFC Network. Share it: people see the title and come to GFC to read it.");
    }
    if (res.download) lines.push("It's being checked for viruses: it can be downloaded once the scan passes.");
    clear(resultEl, h("div.success", { style: "font-weight:700" }, lines[0]), lines.slice(1).map((l) => h("div", l)));
    if (res.exclusive && res.teaser) {
      resultEl.append(h("div.media", { style: "max-width:320px" },
        h("video", { src: api.media(res.teaser), muted: true, loop: true, autoplay: true, playsInline: true })),
        h("div.muted.small", `Your ${secs}-second teaser. The full clip is only on GFC.`));
    }
    const targets = res.exclusive ? chosen.filter((t) => availableTargets(res).includes(t)) : [];
    const names = targets.map((t) => SHARE_TARGETS.find((x) => x.id === t)!.label);
    const listed = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
    clear(notes);
    const shareBtn = h("button.btn", `${res.teaser && targets.includes("x") ? "Share teaser" : "Share"} on ${listed}`) as HTMLButtonElement;
    shareBtn.onclick = async () => {
      shareBtn.disabled = true;
      const done = await shareTo(res, targets);
      clear(notes, done.map((n) => h("div", h("b", SHARE_TARGETS.find((x) => x.id === n.target)!.label + ": "), n.note)));
      shareBtn.disabled = false;
    };
    const wantsClip = !!res.teaser && targets.some((t) => t !== "x");
    clear(after,
      targets.length ? shareBtn : null,
      wantsClip ? h("button.btn.secondary", { onclick: async () => {
        const dir = await saveTeaser(res);
        toast(dir ? `Teaser saved to ${dir}. Attach it to your LinkedIn or Substack post.` : "Couldn't save the teaser.", !dir);
      } }, "Save teaser") : null,
      h("button.btn.secondary", { onclick: () => go({ name: "seed", id: res.id }) }, "View your post"));
    after.classList.remove("hidden");
    if (res.first_post_bonus) {
      celebrate(res.first_post_bonus, "First post bonus!");
      checkEarnings();
    }
  };

  cancelBtn.onclick = () => invoke("cancel_upload", { uploadId }).catch(() => {});
  postBtn.onclick = headerPost.onclick = doPost;

  page.append(
    h("div.pagehead", h("div.title",
      h("button.iconbtn", { title: "Back", style: "font-size:20px", onclick: back }, "←"),
      h("h1.grow", "New post"),
      inTauri && !isAndroid ? h("button.btn.secondary.small", { title: "Upload many videos at once, from a folder",
        onclick: () => go({ name: "batch" }) }, "Batch upload") : null,
      headerPost)),
    h("div.page",
      h("label", "Title"), title,
      h("label", "Text"), text,
      h("p.muted.small", "Add to your post (optional)."),
      h("div.row.wrap",
        h("button.btn.secondary.small", { onclick: (ev: MouseEvent) => pick("media", ev.currentTarget as HTMLButtonElement) }, "⊕ Photo or video"),
        h("button.btn.secondary.small", { onclick: (ev: MouseEvent) => pick("file", ev.currentTarget as HTMLButtonElement) }, "✧ 3D model, audio or other file")),
      h("div", { style: "margin-top:12px" }, mediaPanel),
      h("div.box", { style: "margin-top:16px" },
        h("label.check", exclusive, h("span.gold", { style: "font-weight:700" }, "Exclusive to GFC Network")),
        exclusiveHint, exclusiveOptions),
      postBtn,
      h("div", { style: "margin-top:8px" }, progress, h("div.row", progressText, h("span.grow"), cancelBtn)),
      resultEl, after, notes));
  update();
  // Dev builds: automated UI tests attach a file without the native dialog
  if (import.meta.env.DEV && inTauri) {
    (window as unknown as Record<string, unknown>).__gfcTestAttach = async (path: string) =>
      usePicked(await invoke<Picked>("debug_pick_path", { path }));
  }
  if (r.pick) setTimeout(() => pick(r.pick!), 50);
  else setTimeout(() => (r.text ? text : title).focus());

  return () => {
    model?.dispose();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
});
