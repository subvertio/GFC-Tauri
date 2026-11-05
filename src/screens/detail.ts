// One post: the full media (3D view, image, video, audio or text), likes, comments,
// bookmarks, sharing, editing your own post with its history, report/block.

import { api, kindOf, titleFromBody, KIND_LABEL, ApiError, type Seed } from "../api";
import { registerScreen, back, go, avatarFor, openUser, askToVerify, type Route } from "../app";
import { session } from "../session";
import { h, clear, timeAgo, fmtBytes, toast } from "../ui/dom";
import { load3d } from "../lazy3d";
import type { ModelView } from "../viewer3d";
import { moreMenu, toggleLike, toggleBookmark, shareOnX, copyText, onSeedChange, seedChanged, editHistory, openExternal } from "../ui/actions";
import { exclusiveAccess, playLinks, unlockText, EXCLUSIVE_BADGE } from "../ui/exclusive";
import { trackPlayer, trackVisible, reportPlayed } from "../ui/media";
import { downloadBox } from "../ui/download";
import { followButton, noteFollowing } from "../ui/follow";

registerScreen("seed", (route, page) => {
  const r = route as Extract<Route, { name: "seed" }>;
  const disposers: (() => void)[] = [];
  let model: ModelView | null = null;
  let alive = true;
  disposers.push(() => {
    alive = false;
    model?.dispose();
  });

  const head = h("div.pagehead", h("div.title",
    h("button.iconbtn", { title: "Back", style: "font-size:20px", onclick: back }, "←"),
    h("h1.grow", "Post")));
  const body = h("div.page", h("div.muted", "Loading the post…"));
  page.append(head, body);

  let follow: HTMLElement | null | undefined;  // made once: show() runs again when the post changes
  const show = (s: Seed) => {
    noteFollowing(s.owner, s.following);
    if (follow === undefined) follow = followButton(s.owner, disposers);
    const kind = kindOf(s);
    const access = exclusiveAccess(s);
    const preview = h("div");
    const textEl = h("div.text", { class: kind === "text" ? "big" : "" });
    const commentsEl = h("div");
    const stats = h("div.stats");
    const actions = h("div.row.wrap", { style: "margin:12px 0" });

    const renderCounts = () => {
      stats.textContent = [KIND_LABEL[kind], s.file_size ? fmtBytes(s.file_size) : "", `${s.views} views`, `${s.likes} likes`,
        `${s.comments} comments`, `earned ${s.gfc_earned.toFixed(2)} GFC`].filter(Boolean).join(" · ") +
        (s.tags?.length ? `\nTags: ${s.tags.join(", ")}` : "");
      stats.style.whiteSpace = "pre-line";
      clear(actions,
        h("button.btn.secondary.small", { class: s.liked ? "on" : "", style: s.liked ? "color:var(--like);border-color:var(--like)" : "", onclick: () => toggleLike(s) }, s.liked ? "♥ Liked" : "♡ Like"),
        h("button.btn.secondary.small", { onclick: () => toggleBookmark(s) }, s.bookmarked ? "★ Bookmarked" : "☆ Bookmark"),
        h("button.btn.secondary.small", { onclick: () => shareOnX(s) }, "Share on X"),
        h("button.btn.secondary.small", { onclick: async () => (await copyText(api.shareUrl(s.id))) && toast("Share link copied.") }, "Copy link"),
        kind === "other" && s.full && !s.download ? h("button.btn.secondary.small", { onclick: () => openExternal(api.media(s.full)) }, "Open the original file") : null);
    };

    const renderText = (text: string | null) => {
      if (text === null) textEl.textContent = s.exclusive ? (access === "login" || access === "verify" ? "" : "Loading the post…") : "";
      else textEl.textContent = text.trim() || (kind === "text" ? "" : "No description.");
    };

    const isAuto = kind === "text" && s.title === titleFromBody(s.description || "");
    const unlock = s.exclusive && !s.download
      ? unlockText(kind === "video" ? "video" : kind === "audio" ? "audio" : "text", access) : "";
    clear(body,
      h("div.row", { style: "gap:12px;margin-bottom:12px" },
        h("span", { onclick: () => openUser(s.owner) }, avatarFor(s.owner, s.owner_avatar)),
        h("div.grow", h("div.who", h("span.name", { onclick: () => openUser(s.owner) }, s.owner)),
          h("div.muted.small", `@${s.owner} · ${timeAgo(s.created_at)}`,
            s.edited_at ? h("a", { href: "#", style: "color:var(--text-2)", onclick: (e: Event) => { e.preventDefault(); editHistory(s); } }, " · Edited") : null)),
        follow,
        h("button.iconbtn", { title: "More", onclick: () => moreMenu(s, back) }, "•••")),
      s.repost_of ? h("div.repost", `Repost of @${s.repost_of.owner}. Credit goes to the original.`) : null,
      s.exclusive ? h("span.badge.exclusive", EXCLUSIVE_BADGE) : null,
      !isAuto && s.title ? h("h1", { style: "font-size:24px;margin:4px 0 8px" }, s.title) : null,
      kind === "text" ? textEl : null,
      preview,
      kind !== "text" ? textEl : null,
      unlock ? h("a.gold", { href: "#", style: "display:inline-block;margin-top:8px;font-weight:700", onclick: (e: Event) => {
        e.preventDefault();
        if (access === "login") go({ name: "login", back: { name: "seed", id: s.id } });
        else askToVerify("Verify your phone number to see GFC Exclusives. It takes a minute, and it keeps bots and spam out.");
      } }, unlock) : null,
      stats, actions,
      h("h2", { style: "margin-top:20px" }, "Comments"), commentsEl);
    renderCounts();
    disposers.push(onSeedChange(s.id, () => {
      renderCounts();
      if (!s.exclusive) renderText(s.description);
    }));

    // Text: exclusives come from /play
    if (s.exclusive && kind === "text") {
      renderText(null);
      if (access !== "login" && access !== "verify") {
        playLinks(s).then((l) => {
          if (!alive) return;
          if (!l) return show(s); // not allowed: show the unlock link instead
          renderText(l.text ?? "");
        }).catch((e) => alive && toast(String(e.message), true));
      }
    } else renderText(s.description);

    // Media
    renderPreview(s, kind, access, preview);
    if (kind === "text" || kind === "image") disposers.push(trackVisible(kind === "text" ? textEl : preview, s, 2000, true));

    renderComments(s, commentsEl);
  };

  const renderPreview = (s: Seed, kind: string, access: ReturnType<typeof exclusiveAccess>, el: HTMLElement) => {
    if (kind === "image") {
      const img = h("img", { src: api.media(s.full || s.thumb), alt: s.title });
      img.onerror = () => clear(el, h("div.notice.error", "This image couldn't be opened."));
      el.append(h("div.media", img));
    } else if (kind === "3d") {
      const note = h("div.note", "Loading 3D…");
      const box = h("div.media.model", note);
      const reset = h("button.btn.secondary.small.corner", { title: "Reset view (or double-click)" }, "Reset view");
      box.append(reset);
      el.append(box, h("div.muted.small", { style: "margin-top:4px" }, (matchMedia("(pointer: coarse)").matches ? "Drag to turn · pinch to zoom · two fingers to pan · double-tap to reset" : "Drag to orbit · Ctrl + wheel to zoom · right-drag to pan · double-click to reset")));
      reset.onclick = () => model?.resetView();
      let reported = false;
      const report = () => !reported && ((reported = true), reportPlayed(s, true));
      load3d().then((m) => {
        if (!alive) throw new Error("left");
        model = new m.ModelView(box, { onStatus: (t) => (note.textContent = t) });
        return model.load(api.media(s.full));
      }).then(() => {
        if (!alive) return;
        disposers.push(trackVisible(box, s, 3000, true));
        model?.canvas.addEventListener("pointerdown", report, { once: true });
      }).catch((e) => {
        if (!alive) return;
        model?.dispose();
        model = null;
        clear(box, s.thumb ? h("img", { src: api.media(s.thumb), alt: "" }) : "", h("div.note", String(e.message ?? e)));
      });
    } else if (kind === "video") {
      const v = h("video", { controls: true, playsInline: true, poster: api.media(s.thumb) }) as HTMLVideoElement;
      v.muted = true;
      const box = h("div.media", v);
      el.append(box);
      const useTeaser = () => {
        if (s.teaser) {
          v.src = api.media(s.teaser);
          box.after(h("div.muted.small", { style: "margin-top:4px" }, `${s.teaser_seconds ?? 5}-second preview. The full clip is only for GFC accounts.`));
        }
        else clear(box, h("div.notice", "The teaser isn't ready yet. Try again in a minute."));
      };
      if (s.exclusive) {
        if (access === "login" || access === "verify") useTeaser();
        else playLinks(s).then((l) => {
          if (!alive) return;
          if (l) v.src = api.media(l.stream || l.full);
          else show(s); // not allowed: teaser and the unlock link
        }).catch(useTeaser);
      } else v.src = api.media(s.stream || s.full);
      trackPlayer(v, s, true);
    } else if (kind === "audio") {
      const a = h("audio", { controls: true, preload: "metadata", style: "width:100%" }) as HTMLAudioElement;
      const box = h("div.media.audio", s.thumb ? h("img", { src: api.media(s.thumb), alt: "" }) : null, a);
      el.append(box);
      // Exclusive tracks: the public preview, or the full track through signed /play links
      const usePreview = () => {
        if (s.teaser) {
          a.src = api.media(s.teaser);
          box.after(h("div.muted.small", { style: "margin-top:4px" }, `${s.teaser_seconds ?? 5}-second preview. The full track is only for GFC accounts.`));
        } else clear(box, h("div.notice", "The preview isn't ready yet. Try again in a minute."));
      };
      if (s.exclusive) {
        if (access === "login" || access === "verify") usePreview();
        else playLinks(s).then((l) => {
          if (!alive) return;
          if (l) a.src = api.media(l.stream || l.full);
          else show(s); // not allowed: preview and the unlock link
        }).catch(usePreview);
      } else a.src = api.media(s.stream || s.full);
      trackPlayer(a, s, true);
    } else if (kind === "other") {
      if (s.thumb) el.append(h("div.media", h("img", { src: api.media(s.thumb), alt: "" })));
      if (s.download) el.append(downloadBox(s));
    }
  };

  const renderComments = (s: Seed, el: HTMLElement) => {
    const list = h("div", h("div.muted.small", "Loading…"));
    const box = h("textarea", { placeholder: "Post your reply", maxlength: 2000, rows: 2 }) as HTMLTextAreaElement;
    const send = h("button.btn.small", { disabled: true }, "Reply") as HTMLButtonElement;
    box.addEventListener("input", () => (send.disabled = !box.value.trim()));
    send.onclick = async () => {
      send.disabled = true;
      try {
        const res = await api.comment(s.id, box.value.trim());
        box.value = "";
        s.comments = res.comment_count;
        list.prepend(commentRow(res.comment.owner, res.comment.text, res.comment.created_at));
        list.querySelector(".none")?.remove();
      } catch (e) {
        toast(String((e as Error).message), true);
        send.disabled = false;
      }
    };
    clear(el,
      session.loggedIn
        ? h("div.row", { style: "align-items:flex-end;margin-bottom:8px" }, h("div.grow", box), send)
        : h("div.muted.small", { style: "margin-bottom:8px" }, h("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); go({ name: "login", back: { name: "seed", id: s.id } }); } }, "Log in"), " to reply."),
      list);
    api.comments(s.id).then((items) => {
      if (!alive) return;
      const shown = items.filter((c) => !session.blocked.has(c.owner.toLowerCase()));
      clear(list, shown.length ? shown.map((c) => commentRow(c.owner, c.text, c.created_at)) : h("div.muted.small.none", "No comments yet."));
    }).catch(() => alive && clear(list, h("div.muted.small", "Couldn't load comments.")));
  };

  // Show what we have at once, then refresh counts from the node (keeping our liked/bookmarked)
  if (r.seed) show(r.seed);
  api.seed(r.id).then((fresh) => {
    if (!alive) return;
    if (session.isHiddenForMe(fresh)) return back();
    if (r.seed) {
      Object.assign(r.seed, { ...fresh, liked: r.seed.liked, bookmarked: r.seed.bookmarked, stream: r.seed.stream ?? null });
      seedChanged(r.seed);
    } else show(fresh);
  }).catch((e) => {
    if (!alive || r.seed) return;
    const msg = e instanceof ApiError && e.status === 404 ? "That post isn't on this node (yet). It may still be syncing." : String(e.message);
    clear(body, h("div.empty", msg));
  });

  return () => disposers.forEach((d) => d());
});

function commentRow(owner: string, text: string, at: string) {
  return h("div.comment",
    h("div.who", h("span.name", { onclick: () => openUser(owner) }, owner), h("span.handle", `@${owner} · ${timeAgo(at)}`)),
    h("div.text", text));
}
