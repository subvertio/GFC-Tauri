// Feed pages: For you, Explore (search), Bookmarks, your posts, someone else's posts.

import { api, type Seed } from "../api";
import { registerScreen, go, back, avatarFor, whenAllowedToPost, setTrending, type Route } from "../app";
import { session } from "../session";
import { h, clear } from "../ui/dom";
import { seedCard, visibleToMe, type CardHandle } from "../ui/card";

/** Keep the node's order, but never more than `maxRun` posts in a row by one creator. */
export function mixCreators(items: Seed[], maxRun = 2): Seed[] {
  const out = items.slice();
  const who = (s: Seed) => s.owner.toLowerCase();
  for (let i = maxRun; i < out.length; i++) {
    const prev = who(out[i - 1]);
    let run = 0;
    for (let k = i - 1; k >= 0 && who(out[k]) === prev; k--) run++;
    if (run < maxRun || who(out[i]) !== prev) continue;
    const j = out.findIndex((s, idx) => idx > i && who(s) !== prev);
    if (j < 0) break;
    out.splice(i, 0, ...out.splice(j, 1));
  }
  return out;
}

let loadSerial = 0;

registerScreen("feed", (route, page) => {
  const r = route as Extract<Route, { name: "feed" }>;
  const serial = ++loadSerial;
  const cards: CardHandle[] = [];
  const list = h("div");
  const status = h("div.empty", "Loading the feed…");

  // Header
  let header: HTMLElement;
  if (r.src === "foryou") {
    header = h("div.pagehead", h("div.tabs", h("button.active", { onclick: () => go(r, { replace: true }) }, h("span", "For you"))));
  } else {
    const title = r.src === "explore" ? "Explore" : r.src === "bookmarks" ? "Bookmarks" : r.src === "mine" ? session.user : r.user!;
    const sub = r.src === "mine" ? `@${session.user}` : r.src === "user" ? `@${r.user}` : "";
    header = h("div.pagehead", h("div.title",
      h("button.iconbtn", { title: "Back", style: "font-size:20px", onclick: back }, "←"),
      h("div", h("h1", title), sub ? h("div.muted.small", sub) : null)));
    if (r.src === "explore") {
      const box = h("input", { type: "search", placeholder: "Search GFC", value: r.q ?? "" }) as HTMLInputElement;
      box.addEventListener("keydown", (e) => e.key === "Enter" && go({ name: "feed", src: "explore", q: box.value.trim() }, { replace: true }));
      header.appendChild(h("div.searchrow", box));
      if (!r.q) setTimeout(() => box.focus());
    }
  }
  page.append(header);

  // The user's page header (avatar, name, bio)
  if (r.src === "user" || r.src === "mine") {
    const name = r.src === "mine" ? session.user : r.user!;
    const head = h("div.profile-head", h("div.row", avatarFor(name, null, true), h("div", h("h1", name), h("div.muted", `@${name}`))));
    page.append(head);
    (r.src === "mine" ? api.me() : api.user(name)).then((p) => {
      if (serial !== loadSerial) return;
      const full = [p.first_name, p.last_name].filter(Boolean).join(" ");
      clear(head, h("div.row", avatarFor(p.username, p.avatar, true),
        h("div.grow", h("h1", full || p.username), h("div.muted", `@${p.username}`), p.bio ? h("div.text", p.bio) : null)));
    }).catch(() => {});
  }

  // The composer (For you, logged in)
  if (r.src === "foryou" && session.loggedIn) {
    const box = h("textarea", { placeholder: "What's happening?", maxlength: 5000, rows: 2, style: "border:0;font-size:19px;padding:8px 0;min-height:56px" }) as HTMLTextAreaElement;
    const post = h("button.btn.small", { disabled: true }, "Post") as HTMLButtonElement;
    box.addEventListener("input", () => (post.disabled = !box.value.trim()));
    const compose = (extra: Partial<Extract<Route, { name: "post" }>>) =>
      whenAllowedToPost(() => go({ name: "post", text: box.value, ...extra }));
    post.onclick = () => compose({ text: box.value });
    page.append(h("div.card", { style: "cursor:default" }, avatarFor(session.user),
      h("div.post", box, h("div.row", { style: "border-top:1px solid var(--border);padding-top:8px" },
        h("button.iconbtn", { title: "Photo or video", onclick: () => compose({ pick: "media" }) }, "⊕ Media"),
        h("button.iconbtn", { title: "3D model, audio or another file", onclick: () => compose({ pick: "file" }) }, "✧ 3D"),
        h("span.grow"), post))));
  }

  page.append(list, status);

  const needsLogin = (r.src === "bookmarks" || r.src === "mine") && !session.loggedIn;
  if (needsLogin) {
    status.textContent = "Log in to see this page.";
    return;
  }

  const load = async (): Promise<Seed[]> => {
    switch (r.src) {
      case "foryou": return api.feed();
      case "explore":
        if (r.q) return api.search(r.q);
        return (await api.feed()).sort((a, b) => b.likes - a.likes || b.views - a.views).slice(0, 50);
      case "bookmarks": return api.bookmarks();
      case "mine": return api.mine();
      case "user": return api.userSeeds(r.user!);
    }
  };

  load().then((items) => {
    if (serial !== loadSerial) return;
    if (r.src === "foryou") setTrending(items);
    let shown = items.filter(visibleToMe);
    if (r.src === "foryou") shown = mixCreators(shown);
    const onHidden = (id: string) => {
      const i = cards.findIndex((c) => c.el.dataset.id === id);
      if (i >= 0) {
        cards[i].dispose();
        cards[i].el.remove();
        cards.splice(i, 1);
      }
    };
    for (const s of shown) {
      const c = seedCard(s, onHidden);
      cards.push(c);
      list.appendChild(c.el);
    }
    status.className = shown.length ? "end" : "empty";
    status.textContent = emptyText(r, shown.length);
  }).catch((e) => {
    if (serial !== loadSerial) return;
    status.className = "empty";
    clear(status, h("div", "Couldn't load the feed."), h("div.danger.small", String(e.message ?? e)),
      h("button.btn.secondary.small", { style: "margin-top:12px", onclick: () => go(r, { replace: true }) }, "Try again"));
  });

  return () => cards.forEach((c) => c.dispose());
});

function emptyText(r: Extract<Route, { name: "feed" }>, n: number): string {
  switch (r.src) {
    case "foryou": return n ? `${n} seeds · you're all caught up` : "Nothing here yet. Seeds appear as creators upload them.";
    case "explore":
      if (!r.q) return n ? "Top posts on this node. Search by title, text, tag or creator." : "Nothing here yet. Seeds appear as creators upload them.";
      return n ? `${n} result${n === 1 ? "" : "s"} for "${r.q}"` : `No results for "${r.q}".`;
    case "bookmarks": return n ? `${n} bookmarked` : "Nothing bookmarked yet. Use the star on a post to keep it here.";
    case "mine": return n ? `${n} posts` : "You haven't posted yet.";
    case "user": return n ? `${n} posts` : `@${r.user} has no posts to show.`;
  }
}
