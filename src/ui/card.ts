// A post in the feed: avatar, name @handle · time, title, text, media by kind, actions.

import { api, kindOf, titleFromBody, KIND_LABEL, type Seed } from "../api";
import { avatarFor, go, openUser, askToVerify } from "../app";
import { session } from "../session";
import { h, clear, timeAgo, fmtCount } from "./dom";
import { lazyModel } from "../lazy3d";
import { moreMenu, toggleLike, toggleBookmark, shareLink, onSeedChange, editHistory } from "./actions";
import { exclusiveAccess, playLinks, unlockText, EXCLUSIVE_BADGE } from "./exclusive";
import { trackPlayer, pauseWhenOffscreen } from "./media";

export interface CardHandle { el: HTMLElement; dispose: () => void }

function truncate(s: string, n: number) {
  s = s.trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

export function seedCard(s: Seed, onHidden: (id: string) => void): CardHandle {
  const kind = kindOf(s);
  const disposers: (() => void)[] = [];
  const el = h("article.card", { dataset: { id: s.id, owner: s.owner } });
  el.addEventListener("click", (e) => {
    if ((e.target as Element).closest("button,a,video,audio,canvas,.no-open")) return;
    go({ name: "seed", id: s.id, seed: s });
  });

  const render = () => {
    const access = exclusiveAccess(s);
    const isAutoTitle = kind === "text" && s.title === titleFromBody(s.description || "");
    const body = (s.description || "").trim();
    clear(el,
      h("div", { onclick: () => openUser(s.owner) }, avatarFor(s.owner, s.owner_avatar)),
      h("div.post",
        h("div.who",
          h("span.name", { onclick: () => openUser(s.owner) }, s.owner),
          h("span.handle", `@${s.owner} · ${timeAgo(s.created_at)}`),
          s.edited_at ? h("a.small", { href: "#", style: "margin-left:4px;color:var(--text-2)", onclick: (e: Event) => { e.preventDefault(); editHistory(s); } }, "· Edited") : null,
          h("button.iconbtn.more", { title: "More", onclick: () => moreMenu(s, () => onHidden(s.id)) }, "•••")),
        s.repost_of ? h("div.repost", `Repost of @${s.repost_of.owner}. Credit goes to the original.`) : null,
        s.exclusive ? h("span.badge.exclusive", EXCLUSIVE_BADGE) : null,
        !isAutoTitle && s.title ? h("h3", s.title) : null,
        body ? h("div.text", truncate(body, kind === "text" ? 600 : 200)) : null,
        mediaFor(s, kind, access, disposers),
        unlockLink(s, kind, access),
        actionRow(s),
      ));
  };
  render();
  const unsubscribe = onSeedChange(s.id, () => {
    // Keep a playing video or live 3D view; only refresh the counts and text
    const media = el.querySelector(".media");
    if (media && media.querySelector("video,audio,canvas")) {
      const row = el.querySelector(".actions");
      row?.replaceWith(actionRow(s));
      return;
    }
    for (const d of disposers.splice(0)) d();
    render();
  });
  return { el, dispose: () => { unsubscribe(); disposers.forEach((d) => d()); } };
}

function unlockLink(s: Seed, kind: string, access: ReturnType<typeof exclusiveAccess>) {
  if (!s.exclusive) return null;
  const k = kind === "video" ? "video" : "text";
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

function actionRow(s: Seed) {
  const n = (x: number) => (x ? fmtCount(x) : "");
  return h("div.actions",
    h("button.iconbtn", { title: "Comments", onclick: () => go({ name: "seed", id: s.id, seed: s }) }, "↩", n(s.comments)),
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
      const box = h("div.media.model", { title: "Drag to turn · Ctrl + wheel to zoom · double-click to reset" },
        h("span.tag", "3D"), thumbImg(s) ?? h("div.empty", { style: "padding-top:40%" }, "3D model"), note);
      if (s.full) disposers.push(lazyModel(box, api.media(s.full), note));
      return box;
    }
    case "video":
      return videoBox(s, access, disposers);
    case "audio": {
      const audio = h("audio", { controls: true, preload: "none", src: api.media(s.stream || s.full) }) as HTMLAudioElement;
      trackPlayer(audio, s);
      return h("div.media.audio", thumbImg(s), audio);
    }
    default: {
      const img = thumbImg(s);
      return h("div.media", img ?? h("div.media.text-only", { style: "border:0;margin:0" }, `${KIND_LABEL.other} · open the post to download it`));
    }
  }
}

function videoBox(s: Seed, access: ReturnType<typeof exclusiveAccess>, disposers: (() => void)[]) {
  const locked = s.exclusive && (access === "login" || access === "verify");
  const label = locked ? "▶ Play 5-second teaser" : "▶ Play video";
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
  clear(box, poster ?? h("div", { style: "width:100%;height:100%;background:#0b0c0e" }), h("span.tag", s.exclusive && locked ? "Teaser" : "Video"),
    h("button.overlay", { title: label, onclick: startPlay }, h("span", "▶")));
  return box;
}

/** Whether a page should show this seed to the current user. */
export function visibleToMe(s: Seed) {
  return !session.isHiddenForMe(s);
}
