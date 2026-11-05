// A post in the feed: avatar, name @handle · time, title, text, media by kind, actions.

import { api, kindOf, titleFromBody, KIND_LABEL, type Seed } from "../api";
import { avatarFor, go, openUser, askToVerify } from "../app";
import { followButton, noteFollowing } from "./follow";
import { session } from "../session";
import { h, clear, timeAgo, fmtCount, toast } from "./dom";
import { lazyModel } from "../lazy3d";
import { moreMenu, toggleLike, toggleBookmark, shareLink, onSeedChange, seedChanged, editHistory } from "./actions";
import { exclusiveAccess, playLinks, unlockText, EXCLUSIVE_BADGE } from "./exclusive";
import { trackPlayer, pauseWhenOffscreen } from "./media";
import { downloadBox } from "./download";

export interface CardHandle { el: HTMLElement; dispose: () => void }

function truncate(s: string, n: number) {
  s = s.trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

export function seedCard(s: Seed, onHidden: (id: string) => void): CardHandle {
  const kind = kindOf(s);
  const disposers: (() => void)[] = [];
  const el = h("article.card", { dataset: { id: s.id, owner: s.owner } });
  noteFollowing(s.owner, s.following);
  el.addEventListener("click", (e) => {
    if ((e.target as Element).closest("button,a,video,audio,canvas,.no-open")) return;
    go({ name: "seed", id: s.id, seed: s });
  });

  const render = () => {
    const access = exclusiveAccess(s);
    const isAutoTitle = kind === "text" && s.title === titleFromBody(s.description || "");
    const body = (s.description || "").trim();
    clear(el,
      h("div.no-open", { onclick: () => openUser(s.owner) }, avatarFor(s.owner, s.owner_avatar)),
      h("div.post",
        h("div.who",
          h("span.name.no-open", { onclick: () => openUser(s.owner) }, s.owner),
          h("span.handle", `@${s.owner} · ${timeAgo(s.created_at)}`),
          s.ad ? h("span.sponsored", { title: "A creator paid GFC to show this post. 70% of it goes to creators." }, s.ad.label) : null,
          followButton(s.owner, disposers, { small: true }),
          s.edited_at ? h("a.small", { href: "#", style: "margin-left:4px;color:var(--text-2)", onclick: (e: Event) => { e.preventDefault(); editHistory(s); } }, "· Edited") : null,
          h("button.iconbtn.more", { title: "More", onclick: () => moreMenu(s, () => onHidden(s.id)) }, "•••")),
        s.repost_of ? h("div.repost", `Repost of @${s.repost_of.owner}. Credit goes to the original.`) : null,
        s.exclusive ? h("span.badge.exclusive", EXCLUSIVE_BADGE) : null,
        !isAutoTitle && s.title ? h("h3", s.title) : null,
        body ? h("div.text", truncate(body, kind === "text" ? 600 : 200)) : null,
        mediaFor(s, kind, access, disposers),
        unlockLink(s, kind, access),
        actionRow(s, () => toggleComments()),
        commentsBox,
      ));
  };
  // The comment bubble opens the post's comments right under it (latest first, and a reply box)
  const commentsBox = h("div.inline-comments.hidden");
  let commentsOpen = false;
  const toggleComments = () => {
    commentsOpen = !commentsOpen;
    commentsBox.classList.toggle("hidden", !commentsOpen);
    if (commentsOpen) renderInlineComments(s, commentsBox);
  };
  render();
  if (s.ad) disposers.push(reportAdWhenSeen(el, s.ad.token));
  const unsubscribe = onSeedChange(s.id, () => {
    // Keep a playing video or live 3D view; only refresh the counts and text
    const media = el.querySelector(".media");
    if (media && media.querySelector("video,audio,canvas")) {
      const row = el.querySelector(".actions");
      row?.replaceWith(actionRow(s, () => toggleComments()));
      return;
    }
    for (const d of disposers.splice(0)) d();
    render();
  });
  return { el, dispose: () => { unsubscribe(); disposers.forEach((d) => d()); } };
}

function unlockLink(s: Seed, kind: string, access: ReturnType<typeof exclusiveAccess>) {
  if (!s.exclusive || s.download) return null; // a download's box has its own link
  const k = kind === "video" ? "video" : kind === "audio" ? "audio" : "text";
  const label = unlockText(k, access);
  if (label) {
    return h("a.gold", { href: "#", style: "display:inline-block;margin-top:8px;font-weight:700", onclick: (e: Event) => {
      e.preventDefault();
      if (access === "login") go({ name: "login", back: { name: "seed", id: s.id, seed: s } });
      else askToVerify("Verify your phone number to see GFC Exclusives. It takes a minute, and it keeps bots and spam out.");
    } }, label);
  }
  if (k === "text") return h("a.gold", { href: "#", style: "display:inline-block;margin-top:8px;font-weight:700", onclick: (e: Event) => { e.preventDefault(); go({ name: "seed", id: s.id, seed: s }); } }, "Read the full post →");
  return null;
}

/** An ad counts (and pays the creator above it) once it's been at least 60% on screen for a second. */
function reportAdWhenSeen(el: Element, token: string): () => void {
  let timer = 0;
  const obs = new IntersectionObserver(([e]) => {
    clearTimeout(timer);
    if (e.isIntersecting && e.intersectionRatio >= 0.6 && !document.hidden) {
      timer = window.setTimeout(() => {
        obs.disconnect();
        if (session.loggedIn) api.adView(token).catch(() => {});
      }, 1000);
    }
  }, { threshold: [0, 0.6] });
  obs.observe(el);
  return () => { clearTimeout(timer); obs.disconnect(); };
}

const COMMENT_BUBBLE = "💬";

/** The latest comments under a post in the feed, a reply box, and a link to all of them. */
function renderInlineComments(s: Seed, box: HTMLElement) {
  const list = h("div", h("div.muted.small", "Loading comments…"));
  const input = h("input", { placeholder: session.loggedIn ? "Write a comment…" : "Log in to comment", maxlength: 1000,
    disabled: !session.loggedIn }) as HTMLInputElement;
  const send = h("button.btn.small", { disabled: true }, "Reply") as HTMLButtonElement;
  input.addEventListener("input", () => (send.disabled = !input.value.trim()));
  const row = (c: { owner: string; text: string; created_at: string }) => h("div.comment",
    h("div.who", h("span.name.no-open", { onclick: () => openUser(c.owner) }, c.owner), h("span.handle", `@${c.owner} · ${timeAgo(c.created_at)}`)),
    h("div.text", c.text));
  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    send.disabled = input.disabled = true;
    try {
      const res = await api.comment(s.id, text);
      input.value = "";
      s.comments = res.comment_count;
      list.querySelector(".none")?.remove();
      list.prepend(row(res.comment));
      seedChanged(s);
    } catch (e) {
      toast(String((e as Error).message ?? e), true);
    } finally {
      input.disabled = false;
    }
  };
  send.onclick = submit;
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  clear(box, list,
    session.loggedIn ? h("div.row.comment-reply", input, send) : h("button.btn.secondary.small", { onclick: () => go({ name: "login" }) }, "Log in to comment"),
    h("a.small", { href: "#", onclick: (e: Event) => { e.preventDefault(); go({ name: "seed", id: s.id, seed: s }); } }, "Open the post"));
  api.comments(s.id).then((items) => {
    const shown = items.filter((c) => !session.isHiddenForMe({ id: "", owner: c.owner })).slice(0, 5);
    clear(list, shown.length ? shown.map(row) : h("div.muted.small.none", "No comments yet. Be the first."),
      items.length > shown.length ? h("a.small", { href: "#", onclick: (e: Event) => { e.preventDefault(); go({ name: "seed", id: s.id, seed: s }); } },
        `View all ${s.comments || items.length} comments`) : null);
  }).catch(() => clear(list, h("div.muted.small", "Couldn't load comments.")));
}

function actionRow(s: Seed, onComments: () => void = () => go({ name: "seed", id: s.id, seed: s })) {
  const n = (x: number) => (x ? fmtCount(x) : "");
  return h("div.actions",
    h("button.iconbtn.comments", { title: "Comments", onclick: onComments }, COMMENT_BUBBLE, n(s.comments)),
    h("button.iconbtn.like", { class: s.liked ? "on" : "", title: s.liked ? "Unlike" : "Like", onclick: () => toggleLike(s) }, s.liked ? "♥" : "♡", n(s.likes)),
    h("span.iconbtn", { title: "Views" }, "⊙", n(s.views)),
    h("span.iconbtn", { title: "GFC this post has earned its creator", class: s.gfc_earned > 0 ? "gold" : "" }, "¤", s.gfc_earned > 0 ? `${s.gfc_earned.toFixed(2)} GFC` : ""),
    h("button.iconbtn.mark", { class: s.bookmarked ? "on" : "", title: s.bookmarked ? "Remove bookmark" : "Bookmark", onclick: () => toggleBookmark(s) }, s.bookmarked ? "★" : "☆"),
    h("button.iconbtn", { title: "Copy link", onclick: () => shareLink(s) }, "↗"));
}

function thumbImg(s: Seed, fallbackFull = false) {
  const src = s.thumb ? api.media(s.thumb) : fallbackFull ? api.media(s.full) : "";
  if (!src) return null;
  const img = h("img", { src, alt: s.title || "", loading: "lazy", decoding: "async" });
  img.onerror = () => img.remove();
  return img;
}

function mediaFor(s: Seed, kind: string, access: ReturnType<typeof exclusiveAccess>, disposers: (() => void)[]): HTMLElement | null {
  switch (kind) {
    case "text":
      return null;
    case "image": {
      const img = thumbImg(s, true);
      return img ? h("div.media", img) : null;
    }
    case "3d": {
      const note = h("div.note");
      const box = h("div.media.model", { title: matchMedia("(pointer: coarse)").matches ? "" : "Drag to turn · Ctrl + wheel to zoom · double-click to reset" },
        h("span.tag", "3D"), thumbImg(s) ?? h("div.empty", { style: "padding-top:40%" }, "3D model"), note);
      if (s.full) disposers.push(lazyModel(box, api.media(s.full), note));
      return box;
    }
    case "video":
      return videoBox(s, access, disposers);
    case "audio":
      return audioBox(s, access);
    default: {
      if (s.download) return downloadBox(s);
      const img = thumbImg(s);
      return h("div.media", img ?? h("div.media.text-only", { style: "border:0;margin:0" }, `${KIND_LABEL.other} · open the post to download it`));
    }
  }
}

/**
 * A track. Exclusive ones start on the public preview; accounts that may hear the full track
 * get it on first play (signed /play links), so scrolling the feed doesn't fetch links.
 */
function audioBox(s: Seed, access: ReturnType<typeof exclusiveAccess>) {
  const locked = s.exclusive && (access === "login" || access === "verify");
  const preview = s.teaser ? api.media(s.teaser) : "";
  const audio = h("audio", { controls: true, preload: "none", src: s.exclusive ? preview : api.media(s.stream || s.full) }) as HTMLAudioElement;
  trackPlayer(audio, s);
  const unlock = async (play: boolean) => {
    try {
      const links = await playLinks(s);
      if (links) audio.src = api.media(links.stream || links.full);
    } catch {
      /* keep the preview */
    }
    if (play) audio.play().catch(() => {});
  };
  if (s.exclusive && !locked) {
    if (!preview) unlock(false); // nothing to start on: fetch the full track's link now
    else {
      let unlocked = false;
      audio.addEventListener("play", () => {
        if (unlocked) return;
        unlocked = true;
        audio.pause();
        unlock(true);
      });
    }
  }
  if (s.exclusive && locked && !preview) return h("div.media.audio", thumbImg(s), h("div.note", "The preview isn't ready yet."));
  const tag = s.exclusive && locked && s.thumb ? h("span.tag", `${s.teaser_seconds ?? 5}s preview`) : null;
  return h("div.media.audio", thumbImg(s), tag, audio);
}

function videoBox(s: Seed, access: ReturnType<typeof exclusiveAccess>, disposers: (() => void)[]) {
  const locked = s.exclusive && (access === "login" || access === "verify");
  const secs = s.teaser_seconds ?? 5;
  const label = locked ? `▶ Play ${secs}-second teaser` : "▶ Play video";
  const box = h("div.media.fixed");
  const poster = thumbImg(s);
  const startPlay = async () => {
    let src = "";
    if (s.exclusive) {
      if (!locked) {
        try {
          const links = await playLinks(s);
          src = links ? api.media(links.stream || links.full) : "";
        } catch {
          /* fall back to the teaser */
        }
      }
      if (!src) src = s.teaser ? api.media(s.teaser) : "";
      if (!src) {
        clear(box, poster ?? "", h("div.note", "The teaser isn't ready yet."));
        return;
      }
    } else src = api.media(s.stream || s.full);
    const v = h("video", { src, controls: true, muted: true, playsInline: true, autoplay: true, poster: poster?.src ?? "" }) as HTMLVideoElement;
    v.muted = true;
    box.classList.remove("fixed");
    clear(box, v);
    trackPlayer(v, s);
    pauseWhenOffscreen(v);
    v.addEventListener("error", () => clear(box, poster ?? "", h("button.overlay", { onclick: startPlay }, h("span", "↻")), h("div.note", "Couldn't load. Tap to retry.")));
    disposers.push(() => {
      v.pause();
      v.removeAttribute("src");
      v.load();
    });
  };
  clear(box, poster ?? h("div", { style: "width:100%;height:100%;background:#0b0c0e" }), h("span.tag", s.exclusive && locked ? `${secs}s preview` : "Video"),
    h("button.overlay", { title: label, onclick: startPlay }, h("span", "▶")));
  return box;
}

/** Whether a page should show this seed to the current user. */
export function visibleToMe(s: Seed) {
  return !session.isHiddenForMe(s);
}
