// Edit profile: photo, first and last name, and bio. The photo is cropped to a square and
// sent as a 512 px JPEG (the node takes JPEG, PNG, GIF or WebP up to 5 MB).

import { invoke } from "../native";
import { api, inTauri, type Profile } from "../api";
import { registerScreen, back, go } from "../app";
import { session } from "../session";
import { h, clear, toast } from "../ui/dom";
import { readPicked, type Picked } from "./post";

const PHOTO_SIZE = 512;
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
const BIO_MAX = 300;

/** The middle square of an image, as a PHOTO_SIZE JPEG. */
async function squareJpeg(img: HTMLImageElement): Promise<Blob> {
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const c = document.createElement("canvas");
  c.width = c.height = Math.min(PHOTO_SIZE, side);
  c.getContext("2d")!.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
    0, 0, c.width, c.height);
  const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/jpeg", 0.88));
  if (!blob) throw new Error("Couldn't prepare the photo.");
  return blob;
}

/** Ask for an image: the app's own picker in the desktop app, a file input elsewhere. */
async function chooseImage(): Promise<Blob | null> {
  if (inTauri) {
    const p = await invoke<Picked | null>("pick_file", { kind: "image" });
    if (!p) return null;
    if (p.size > MAX_SOURCE_BYTES) throw new Error("That image is too big (30 MB at most).");
    return new Blob([await readPicked(p, MAX_SOURCE_BYTES)], { type: p.mime });
  }
  return new Promise((ok) => {
    const input = h("input", { type: "file", accept: "image/jpeg,image/png,image/gif,image/webp" }) as HTMLInputElement;
    input.onchange = () => ok(input.files?.[0] ?? null);
    input.click();
  });
}

registerScreen("editprofile", (_route, page) => {
  if (!session.loggedIn) {
    go({ name: "login", back: { name: "editprofile" } }, { replace: true });
    return;
  }
  let newPhoto: Blob | null = null;
  let previewUrl = "";

  const photo = h("div.avatar.big.edit-photo", session.user.slice(0, 1).toUpperCase());
  const showPhoto = (src: string | null | undefined) => {
    clear(photo, src ? h("img", { src, alt: "" }) : session.user.slice(0, 1).toUpperCase());
  };
  const first = h("input", { placeholder: "First name", maxlength: 60, autocomplete: "given-name" }) as HTMLInputElement;
  const last = h("input", { placeholder: "Last name", maxlength: 60, autocomplete: "family-name" }) as HTMLInputElement;
  const bio = h("textarea", { placeholder: "Tell people about yourself and what you create", maxlength: BIO_MAX, rows: 4 }) as HTMLTextAreaElement;
  const bioCount = h("div.muted.small", { style: "text-align:right" });
  const save = h("button.btn", "Save") as HTMLButtonElement;
  const headerSave = h("button.btn.small", "Save") as HTMLButtonElement;
  const status = h("div.small", { style: "margin-top:8px" });
  let loaded: Profile | null = null;

  const changed = () => !!newPhoto || !!loaded && (first.value.trim() !== (loaded.first_name ?? "")
    || last.value.trim() !== (loaded.last_name ?? "") || bio.value.trim() !== (loaded.bio ?? ""));
  const refresh = () => {
    bioCount.textContent = `${bio.value.length} / ${BIO_MAX}`;
    save.disabled = headerSave.disabled = !loaded || !changed();
  };
  for (const el of [first, last, bio]) el.addEventListener("input", refresh);

  const changePhoto = async () => {
    try {
      const file = await chooseImage();
      if (!file) return;
      const url = URL.createObjectURL(file);
      try {
        const img = h("img", { src: url }) as HTMLImageElement;
        await img.decode();
        newPhoto = await squareJpeg(img);
      } catch {
        throw new Error("That file isn't an image this app can read. Try a JPEG or PNG.");
      } finally {
        URL.revokeObjectURL(url);
      }
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(newPhoto);
      showPhoto(previewUrl);
      refresh();
    } catch (e) {
      toast(String((e as Error).message ?? e), true);
    }
  };

  const doSave = async () => {
    if (!loaded) return;
    save.disabled = headerSave.disabled = true;
    status.className = "small muted";
    status.textContent = "Saving…";
    try {
      if (newPhoto) {
        await api.uploadAvatar(newPhoto);
        newPhoto = null;
      }
      loaded = await api.updateProfile({ first_name: first.value.trim(), last_name: last.value.trim(), bio: bio.value.trim() });
      toast("Profile saved");
      go({ name: "feed", src: "mine" }, { replace: true });
    } catch (e) {
      status.className = "small danger";
      status.textContent = String((e as Error).message ?? e);
      refresh();
    }
  };
  save.onclick = headerSave.onclick = doSave;

  page.append(
    h("div.pagehead", h("div.title",
      h("button.iconbtn", { title: "Back", style: "font-size:20px", onclick: back }, "←"),
      h("h1.grow", "Edit profile"), headerSave)),
    h("div.page",
      h("div.row", { style: "gap:16px;align-items:center;margin-bottom:16px" },
        photo,
        h("div",
          h("button.btn.secondary.small", { onclick: changePhoto }, "Change photo"),
          h("div.muted.small", { style: "margin-top:6px" }, "A square from the middle of the picture is used."))),
      h("label", "Name"),
      h("div.row", { style: "gap:8px" }, first, last),
      h("label", { style: "margin-top:12px" }, "Bio"),
      bio, bioCount,
      h("div.muted.small", `@${session.user} can't be changed.`),
      h("div", { style: "margin-top:16px" }, save),
      status));
  refresh();

  api.me().then((p) => {
    loaded = p;
    first.value = p.first_name ?? "";
    last.value = p.last_name ?? "";
    bio.value = p.bio ?? "";
    showPhoto(p.avatar ? api.media(p.avatar) : null);
    refresh();
  }).catch((e) => {
    status.className = "small danger";
    status.textContent = `Couldn't load your profile: ${(e as Error).message ?? e}`;
  });

  return () => { if (previewUrl) URL.revokeObjectURL(previewUrl); };
});
