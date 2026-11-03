// Post actions shared by feed cards and the post screen: like, bookmark, share, the •••
// sheet (report, block, edit, edit history, delete).

import { openUrl } from "@tauri-apps/plugin-opener";
import { api, ApiError, inTauri, kindOf, titleFromBody, type Seed } from "../api";
import { session } from "../session";
import { go } from "../app";
import { h, sheet, toast, confirmSheet, timeAgo, clear } from "./dom";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h("textarea", { style: "position:fixed;opacity:0" }) as HTMLTextAreaElement;
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

export async function openExternal(url: string): Promise<boolean> {
  try {
    if (inTauri) await openUrl(url);
    else window.open(url, "_blank", "noopener");
    return true;
  } catch {
    return false;
  }
}

/** Seeds shown on screen, so an edit or toggle updates every copy at once. */
const listeners = new Map<string, Set<(s: Seed) => void>>();
export function onSeedChange(id: string, f: (s: Seed) => void): () => void {
  let set = listeners.get(id);
  if (!set) listeners.set(id, (set = new Set()));
  set.add(f);
  return () => set!.delete(f);
}
export function seedChanged(s: Seed) {
  for (const f of listeners.get(s.id) ?? []) f(s);
}

const inFlight = new Set<string>();

export async function toggleLike(s: Seed) {
  if (!session.loggedIn) return toast("Log in to like posts.");
  const key = "like:" + s.id;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  const before = { liked: s.liked, likes: s.likes };
  s.liked = !s.liked;
  s.likes = Math.max(0, (s.likes || 0) + (s.liked ? 1 : -1));
  seedChanged(s);
  try {
    const r = await api.like(s.id);
    s.liked = r.liked;
    s.likes = r.like_count;
  } catch (e) {
    Object.assign(s, before);
    toast(String((e as Error).message), true);
  } finally {
    inFlight.delete(key);
    seedChanged(s);
  }
}

export async function toggleBookmark(s: Seed) {
  if (!session.loggedIn) return toast("Log in to bookmark posts.");
  const key = "mark:" + s.id;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  const before = s.bookmarked;
  s.bookmarked = !s.bookmarked;
  seedChanged(s);
  try {
    const r = await api.bookmark(s.id);
    s.bookmarked = r.bookmarked;
    toast(r.bookmarked ? "Added to your Bookmarks." : "Removed from your Bookmarks.");
  } catch (e) {
    s.bookmarked = before;
    toast(String((e as Error).message), true);
  } finally {
    inFlight.delete(key);
    seedChanged(s);
  }
}

export async function shareLink(s: Seed) {
  if (await copyText(api.shareUrl(s.id))) toast("Link copied to the clipboard.");
}

export async function shareOnX(s: Seed) {
  const text = s.owner ? `${s.title || "a seed"} by ${s.owner} on GFC` : `${s.title || "a seed"} on GFC`;
  const url = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(api.shareUrl(s.id))}`;
  if (await openExternal(url)) toast("Opened X to share.");
  else if (await copyText(api.shareUrl(s.id))) toast("Couldn't open X, so the link was copied instead.");
}

const REASONS: [string, string][] = [
  ["spam", "Spam"], ["nudity", "Nudity or sexual content"], ["violence", "Violence or gore"],
  ["harassment", "Harassment or bullying"], ["hate", "Hate speech"], ["scam", "Scam or fraud"],
  ["copyright", "Stolen or copyrighted work"], ["other", "Something else"],
];

/** The ••• sheet. `onHidden` runs when the post should leave the screen (reported, blocked or deleted). */
export async function moreMenu(s: Seed, onHidden: () => void) {
  if (!session.loggedIn) return toast("Log in to report a post or block an account.");
  const mine = session.isMine(s);
  const choice = await sheet<string>((close) =>
    h("div", h("div.btns", { style: "margin-top:0" },
      mine ? [
        h("button.btn.secondary.block", { onclick: () => close("promote") }, "Promote this post (ad)"),
        h("button.btn.secondary.block", { onclick: () => close("edit") }, "Edit post"),
        s.edited_at ? h("button.btn.secondary.block", { onclick: () => close("history") }, "Edit history") : null,
        h("button.btn.danger.block", { onclick: () => close("delete") }, "Delete post"),
      ] : [
        h("button.btn.secondary.block", { onclick: () => close("report") }, "Report post"),
        h("button.btn.danger.block", { onclick: () => close("block") }, `Block @${s.owner}`),
      ],
      h("button.btn.secondary.block", { onclick: () => close() }, "Cancel"))),
  );
  if (choice === "promote") go({ name: "promote", seedId: s.id, seed: s });
  else if (choice === "edit") editPost(s);
  else if (choice === "history") editHistory(s);
  else if (choice === "delete") deletePost(s, onHidden);
  else if (choice === "report") {
    const reason = await sheet<string>((close) =>
      h("div", h("h2", "Why are you reporting this post?"),
        h("div.btns", REASONS.map(([k, label]) => h("button.btn.secondary.block", { onclick: () => close(k) }, label)),
          h("button.btn.secondary.block", { onclick: () => close() }, "Cancel"))));
    if (!reason) return;
    try {
      await api.report(s.id, reason);
      session.reported.add(s.id);
      onHidden();
      toast("Thanks for reporting. We've hidden this post for you.");
    } catch (e) {
      toast(String((e as Error).message), true);
    }
  } else if (choice === "block") {
    if (!(await confirmSheet(`Block @${s.owner}?`, "You won't see their posts. They aren't told.", `Block @${s.owner}`, true))) return;
    try {
      await api.block(s.owner);
      session.blocked.add(s.owner.toLowerCase());
      onHidden();
      toast(`Blocked @${s.owner}.`);
    } catch (e) {
      toast(String((e as Error).message), true);
    }
  }
}

export async function deletePost(s: Seed, onHidden: () => void) {
  if (!(await confirmSheet("Delete this post?",
    "It's removed from GFC for everyone, on every node, with its likes, comments and files. This can't be undone. " +
    "GFC it already earned or was paid isn't reversed: the ledger never changes.", "Delete post", true))) return;
  try {
    const r = await api.deletePost(s.id);
    toast(r.synced ? "Post deleted." : "Post deleted on this node.");
  } catch (e) {
    // Already gone (deleted from another device): leave the screen all the same
    if (!(e instanceof ApiError && (e.status === 404 || e.status === 410))) return toast(String((e as Error).message), true);
    toast("This post was already deleted.");
  }
  session.deleted.add(s.id);
  session.playCache.delete(s.id);
  onHidden();
}

export async function editPost(s: Seed, currentText?: string) {
  const isText = kindOf(s) === "text";
  const body = currentText ?? s.description ?? "";
  const autoTitle = isText && s.title === titleFromBody(body);
  const titleBox = h("input", { value: s.title, maxlength: 300, placeholder: isText ? "Title (the first line if empty)" : "Title" }) as HTMLInputElement;
  const bodyBox = h("textarea", { maxlength: 20000, placeholder: isText ? "What's happening?" : "Description (optional)", rows: isText ? 8 : 4 }) as HTMLTextAreaElement;
  bodyBox.value = body;
  const tagsBox = h("input", { value: (s.tags ?? []).join(", "), placeholder: "comma-separated, e.g. music, 3d" }) as HTMLInputElement;
  const err = h("div.danger.small");
  const save = h("button.btn.block", "Save") as HTMLButtonElement;
  let touchedTitle = false;
  titleBox.addEventListener("input", () => (touchedTitle = true));

  await sheet((close) => {
    save.onclick = async () => {
      const fields: { title?: string; description?: string; tags?: string } = {};
      const newBody = isText ? bodyBox.value.trim() : bodyBox.value.replace(/\s+$/, "");
      let newTitle = titleBox.value.trim();
      if (isText && (!newTitle || (autoTitle && !touchedTitle))) newTitle = titleFromBody(newBody);
      if (!isText && !newTitle) newTitle = s.title;
      const newTags = tagsBox.value.split(",").map((t) => t.trim()).filter(Boolean).join(",");
      if (newTitle !== s.title) fields.title = newTitle;
      if (newBody !== body) fields.description = newBody;
      if (newTags !== (s.tags ?? []).join(",")) fields.tags = newTags;
      if (!Object.keys(fields).length) return void (err.textContent = "Nothing changed yet.");
      save.disabled = true;
      save.textContent = "Saving…";
      try {
        const r = await api.edit(s.id, fields);
        s.title = r.title;
        s.tags = r.tags;
        s.edited_at = r.edited_at;
        if (!s.exclusive || s.description) s.description = r.description;
        const cached = session.playCache.get(s.id);
        if (cached && cached.links.text != null) cached.links.text = r.description;
        seedChanged(s);
        close();
        toast("Post updated.");
      } catch (e) {
        err.textContent = String((e as Error).message) || "Couldn't save the edit.";
        save.disabled = false;
        save.textContent = "Save";
      }
    };
    return h("div", h("h2", "Edit post"),
      h("p.muted.small", isText ? "Fix a typo or change the text. Everyone can see the earlier versions."
        : "Change the title, description or tags. The file can't be changed. Everyone can see the earlier versions."),
      isText ? [h("label", "Text"), bodyBox, h("label", "Title"), titleBox] : [h("label", "Title"), titleBox, h("label", "Description"), bodyBox],
      h("label", "Tags"), tagsBox, err,
      h("div.btns", save, h("button.btn.secondary.block", { onclick: () => close() }, "Cancel")));
  });
}

export async function editHistory(s: Seed) {
  const list = h("div", { style: "max-height:460px;overflow-y:auto" }, h("div.muted", "Loading…"));
  const p = sheet((close) => h("div", h("h2", "Edit history"), h("p.muted.small", "Every version of this post's text, newest first."), list,
    h("div.btns", h("button.btn.secondary.block", { onclick: () => close() }, "Close"))));
  try {
    const edits = await api.edits(s.id);
    clear(list, edits.length ? edits.map((e, i) =>
      h("div.comment",
        h("div.muted.small", i === 0 ? `${timeAgo(e.edited_at)} · current` : timeAgo(e.edited_at)),
        h("div", { style: "font-weight:700" }, e.title),
        e.description && e.description !== e.title ? h("div.text", e.description.length > 400 ? e.description.slice(0, 400) + "…" : e.description) : null,
        e.tags?.length ? h("div.muted.small", e.tags.map((t) => `#${t}`).join("  ")) : null))
      : h("div.muted", "This post hasn't been edited."));
  } catch {
    clear(list, h("div.danger", "Couldn't load the history."));
  }
  await p;
}
