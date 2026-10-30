// New post: title, then text, then media (optional), then Post. Text-only posts are
// uploaded as a small .txt. Videos and text posts can be "Exclusive to GFC Network";
// after posting one, "Share teaser on X" saves the teaser and opens the X intent.

import { invoke } from "@tauri-apps/api/core";
import { api, inTauri, titleFromBody, ApiError, type UploadResult } from "../api";
import { registerScreen, back, go, askToVerify, type Route } from "../app";
import { h, clear, toast, fmtBytes } from "../ui/dom";
import { ModelView, BUDGET } from "../viewer3d";
import { copyText, openExternal } from "../ui/actions";
import { celebrate, checkEarnings } from "../earnings";

interface Picked { id: string; name: string; size: number; mime: string }
const MAX_UPLOAD = 200 * 1024 * 1024;
const VIDEO_EXT = ["mp4", "mov", "webm", "mkv", "avi", "wmv", "flv"];
const ext = (n: string) => n.split(".").pop()!.toLowerCase();
const isVideo = (p: Picked) => p.mime.startsWith("video/") || VIDEO_EXT.includes(ext(p.name));
const isImage = (p: Picked) => p.mime.startsWith("image/");
const isModel = (p: Picked) => ["glb", "gltf"].includes(ext(p.name));

let uploading = false;

async function readPicked(p: Picked, max: number): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("read_picked", { id: p.id, maxBytes: max });
}

function canvasJpeg(src: CanvasImageSource, w: number, hgt: number, quality: number): Promise<Blob | null> {
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
  const postBtn = h("button.btn.block", "Post") as HTMLButtonElement;
  const headerPost = h("button.btn.small", "Post") as HTMLButtonElement;
  const progress = h("div.progress.hidden", h("div"));
  const progressText = h("div.muted.small");
  const cancelBtn = h("button.btn.secondary.small.hidden", "Cancel upload") as HTMLButtonElement;
  const resultEl = h("div", { style: "white-space:pre-line;margin-top:12px" });
  const after = h("div.row.wrap.hidden", { style: "margin-top:12px" });

  const tooBig = () => !!picked && picked.size + 64 * 1024 > MAX_UPLOAD;
  const exclusiveAllowed = () => !picked || isVideo(picked);

  const update = () => {
    const can = (!!text.value.trim() || !!picked) && !tooBig() && !uploading;
    postBtn.disabled = headerPost.disabled = !can;
    const allowed = exclusiveAllowed();
    if (!allowed) exclusive.checked = false;
    exclusive.disabled = !allowed || uploading;
    exclusiveHint.textContent = !allowed
      ? "Only videos and text posts can be exclusive."
      : !exclusive.checked
        ? "Only real GFC accounts see all of it; the rest of the world gets a preview to share on X."
        : picked
          ? "A 5-second teaser is public (share it on X). Only real GFC accounts can watch the full clip."
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

  const pick = async (kind: "media" | "file") => {
    if (!inTauri) return toast("Picking files needs the desktop app.", true);
    if (uploading) return toast("Wait for the current upload to finish, or cancel it.");
    const p = await invoke<Picked | null>("pick_file", { kind });
    if (!p) return;
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
      } else if (isVideo(p) && p.size < 120 * 1024 * 1024) {
        objectUrl = URL.createObjectURL(new Blob([await readPicked(p, 120 * 1024 * 1024)], { type: p.mime }));
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
        if (p.size > BUDGET.bytes) throw new Error(`over the ${BUDGET.bytes / 1048576} MB limit`);
        model = new ModelView(box, { onStatus: () => {} });
        const res = await model.loadBytes(await readPicked(p, BUDGET.bytes));
        box.querySelector(".note")?.remove();
        info.append(h("div.muted", `${res.triangles.toLocaleString()} triangles${res.animation ? `, animated (${res.animation})` : ""}. Drag to turn it; the thumbnail is the view when you post.`));
        thumbMaker = () => model?.snapshot() ?? Promise.resolve(null);
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
    const ttl = title.value.trim() || (picked ? picked.name.replace(/\.[^.]+$/, "") : titleFromBody(body));
    progress.classList.remove("hidden");
    cancelBtn.classList.remove("hidden");
    clear(resultEl);
    try {
      const { result: res, attempts } = await api.upload(
        { fileId: picked?.id, text: picked ? undefined : body, title: ttl, description: body, tags: "", exclusive: exclusive.checked, thumbnail: thumb },
        (sent, total) => {
          (progress.firstChild as HTMLElement).style.width = `${total ? (100 * sent) / total : 0}%`;
          progressText.textContent = `Uploading ${fmtBytes(sent)} of ${fmtBytes(total)}`;
        },
        uploadId,
      );
      showResult(res, attempts);
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

  const showResult = (res: UploadResult, attempts: number) => {
    const lines = [attempts > 1 ? `Posted (after ${attempts} tries).` : "Posted!"];
    if (res.repost_of) lines.push(`This looks like a repost of @${res.repost_of.owner}. They'll get the credit.`);
    else if (res.first_post_bonus) lines.push(`You earned ${res.first_post_bonus} GFC for your first post!`);
    else if (res.first_post_bonus_pending) lines.push("Your first post bonus is saved. Verify your phone and have a wallet (both in Wallet) to collect it.");
    else if (res.rewards_enabled === false) lines.push("Create a wallet so your posts can earn GFC.");
    if (res.exclusive) {
      if (res.content_type === "video") lines.push(res.teaser
        ? "Exclusive to the GFC Network. Here's your 5-second teaser: share it on X, and the full clip stays for GFC accounts."
        : "Exclusive to the GFC Network. The teaser is still being made; you can share the link on X now.");
      else lines.push("Exclusive to the GFC Network. Share it on X: people see the title and come to GFC to read it.");
    }
    clear(resultEl, h("div.success", { style: "font-weight:700" }, lines[0]), lines.slice(1).map((l) => h("div", l)));
    if (res.exclusive && res.teaser) {
      resultEl.append(h("div.media", { style: "max-width:320px" },
        h("video", { src: api.media(res.teaser), muted: true, loop: true, autoplay: true, playsInline: true })),
        h("div.muted.small", "Your 5-second teaser. The full clip is only on GFC."));
    }
    clear(after,
      res.x_post ? h("button.btn", { onclick: () => shareTeaser(res) }, res.teaser ? "Share teaser on X" : "Share on X") : null,
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
      h("h1.grow", "New post"), headerPost)),
    h("div.page",
      h("label", "Title"), title,
      h("label", "Text"), text,
      h("p.muted.small", "Add to your post (optional)."),
      h("div.row.wrap",
        h("button.btn.secondary.small", { onclick: () => pick("media") }, "⊕ Photo or video"),
        h("button.btn.secondary.small", { onclick: () => pick("file") }, "✧ 3D model, audio or other file")),
      h("div", { style: "margin-top:12px" }, mediaPanel),
      h("div.box", { style: "margin-top:16px" },
        h("label.check", exclusive, h("span.gold", { style: "font-weight:700" }, "Exclusive to GFC Network")),
        exclusiveHint),
      postBtn,
      h("div", { style: "margin-top:8px" }, progress, h("div.row", progressText, h("span.grow"), cancelBtn)),
      resultEl, after));
  update();
  if (r.pick) setTimeout(() => pick(r.pick!), 50);
  else setTimeout(() => (r.text ? text : title).focus());

  return () => {
    model?.dispose();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
});

/** Save the teaser to Videos\GFC (shown in Explorer) and open the X post with the text and link. */
async function shareTeaser(res: UploadResult) {
  const x = res.x_post ?? {};
  const intent = x.intent || `https://x.com/intent/post?text=${encodeURIComponent(x.text ?? "")}&url=${encodeURIComponent(x.url ?? "")}`;
  let saved = "";
  if (res.teaser && inTauri) {
    try {
      toast("Getting the teaser…");
      saved = await invoke<string>("save_teaser", { baseUrl: api.baseUrl, path: res.teaser, fileName: res.title || `GFC-${res.id.slice(0, 12)}` });
    } catch {
      /* share without the clip */
    }
  }
  if (await openExternal(intent)) {
    toast(saved ? `Teaser saved to ${saved.replace(/[\\/][^\\/]+$/, "")}. Attach it to the post that just opened on X.` : "Opened X to share.");
  } else if (await copyText(`${x.text ?? ""} ${x.url ?? ""}`.trim())) {
    toast("Couldn't open X, so the post text and link were copied instead.");
  }
}

