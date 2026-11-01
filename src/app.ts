// The app shell and router. Phone layout below 1000 px (top bar, one column, bottom bar);
// desktop adds the left rail (nav) and, from 1240 px, the right rail (search, balance, top earners).

import { api, kindOf, KIND_LABEL, type Seed } from "./api";
import { session } from "./session";
import { h, clear, sheet, toast } from "./ui/dom";
import { sweepModels } from "./lazy3d";
import { stopAllMedia } from "./ui/media";
import { APP_VERSION } from "./update";

export type FeedSource = "foryou" | "following" | "explore" | "bookmarks" | "mine" | "user";
export type Route =
  | { name: "feed"; src: FeedSource; q?: string; user?: string }
  | { name: "seed"; id: string; seed?: Seed }
  | { name: "post"; text?: string; pick?: "media" | "file" }
  | { name: "batch" }
  | { name: "editprofile" }
  | { name: "promote"; seedId: string; seed?: Seed }
  | { name: "ads" }
  | { name: "connect" }
  | { name: "wallet" }
  | { name: "login"; back?: Route };

type Screen = (route: Route, el: HTMLElement) => void | (() => void);
const screens = new Map<Route["name"], Screen>();
export function registerScreen(name: Route["name"], s: Screen) {
  screens.set(name, s);
}

const stack: Route[] = [];
let current: Route = { name: "feed", src: "foryou" };
let cleanup: (() => void) | void;
const scrollMemory = new Map<string, number>();

let centre: HTMLElement;
let leftRail: HTMLElement;
let rightRail: HTMLElement;
let topbar: HTMLElement;
let bottombar: HTMLElement;

const routeKey = (r: Route) => JSON.stringify({ ...r, seed: undefined, back: undefined });

export function currentRoute() {
  return current;
}

// Each page we open is also a browser history entry, so the Android back button (which
// goes back in the web view) and a mouse's back button step back through pages.
let depth = 0;
let skipPop = false;
window.addEventListener("popstate", () => {
  if (skipPop) return void (skipPop = false);
  depth = Math.max(0, depth - 1);
  const prev = stack.pop();
  show(prev ?? { name: "feed", src: "foryou" }, true);
});

export function go(r: Route, opts: { replace?: boolean } = {}) {
  if (!opts.replace) {
    stack.push(current);
    history.pushState({ gfc: ++depth }, "");
  }
  if (stack.length > 50) stack.shift();
  show(r);
}

export function back() {
  if (depth > 0) return history.back(); // popstate shows the previous page
  const prev = stack.pop();
  show(prev ?? { name: "feed", src: "foryou" }, true);
}

/** Home: For you, with the history cleared (the logo, Feed, Home). */
export function home() {
  stack.length = 0;
  if (depth > 0) {
    skipPop = true;
    history.go(-depth);
    depth = 0;
  }
  show({ name: "feed", src: "foryou" });
}

export function openUser(name: string) {
  if (session.isMine({ owner: name })) go({ name: "feed", src: "mine" });
  else go({ name: "feed", src: "user", user: name });
}

function show(r: Route, restoreScroll = false) {
  scrollMemory.set(routeKey(current), centre.scrollTop);
  if (typeof cleanup === "function") cleanup();
  cleanup = undefined;
  current = r;
  const page = h("div.screen");
  clear(centre, page);
  stopAllMedia(); // pauses, and lets go of players that just left the page
  centre.scrollTop = 0;
  sweepModels();
  const s = screens.get(r.name);
  if (s) cleanup = s(r, page);
  if (restoreScroll) {
    const y = scrollMemory.get(routeKey(r)) ?? 0;
    requestAnimationFrame(() => (centre.scrollTop = y));
  }
  renderNav();
}

/** Re-render the current page in place (after a login, a node switch, a refresh). */
export function refresh() {
  show(current);
}

/** Run `next` if the user may post now; otherwise ask them to verify their phone. */
export async function whenAllowedToPost(next: () => void) {
  if (!session.loggedIn) return go({ name: "login", back: { name: "post" } });
  if (session.verified) return next();
  try {
    const health = await api.health();
    if (!health.phone_required_to_post) return next();
    const st = await api.verifyStatus();
    session.verified = st.verified;
    session.learnWallets(st.wallets);
    if (st.verified) return next();
  } catch {
    return next();
  }
  askToVerify("Verify your phone number to post on the GFC network. It takes a minute, and it keeps bots and spam out.");
}

export async function askToVerify(message: string) {
  const ok = await sheet<boolean>((close) =>
    h("div", h("h2", "Verify your phone"), h("p.muted", message),
      h("div.btns",
        h("button.btn.block", { onclick: () => close(true) }, "Verify my phone"),
        h("button.btn.secondary.block", { onclick: () => close(false) }, "Not now"))),
  );
  if (ok) (await import("./screens/wallet")).startPhoneVerification();
}

// ---- Shell ---------------------------------------------------------------------------

const NAV: { id: string; glyph: string; label: string; login?: boolean; route: () => Route; active: (r: Route) => boolean }[] = [
  { id: "home", glyph: "✦", label: "Home", route: () => ({ name: "feed", src: "foryou" }), active: (r) => r.name === "feed" && r.src === "foryou" },
  { id: "explore", glyph: "#", label: "Explore", route: () => ({ name: "feed", src: "explore" }), active: (r) => r.name === "feed" && r.src === "explore" },
  { id: "bookmarks", glyph: "☆", label: "Bookmarks", login: true, route: () => ({ name: "feed", src: "bookmarks" }), active: (r) => r.name === "feed" && r.src === "bookmarks" },
  { id: "wallet", glyph: "¤", label: "Wallet", login: true, route: () => ({ name: "wallet" }), active: (r) => r.name === "wallet" },
  { id: "ads", glyph: "◆", label: "Your ads", login: true, route: () => ({ name: "ads" }), active: (r) => r.name === "ads" || r.name === "promote" },
  { id: "profile", glyph: "@", label: "Profile", login: true, route: () => ({ name: "feed", src: "mine" }), active: (r) => r.name === "feed" && r.src === "mine" },
];

export function avatarFor(name: string, path?: string | null, big = false) {
  const a = h("span.avatar", { class: big ? "big" : "", title: `@${name}` });
  if (path) {
    const img = h("img", { src: api.media(path), alt: "", loading: "lazy" });
    img.onerror = () => clear(a, (name[0] || "?").toUpperCase());
    a.appendChild(img);
  } else a.textContent = (name[0] || "?").toUpperCase();
  return a;
}

function renderNav() {
  const r = current;
  // Left rail
  clear(leftRail,
    h("button.logo", { title: "Home", onclick: home }, "GFC"),
    h("nav", NAV.filter((n) => !n.login || session.loggedIn).map((n) =>
      h("button", { class: n.active(r) ? "active" : "", onclick: () => (n.id === "home" ? home() : go(n.route())) },
        h("span.glyph", n.id === "bookmarks" && n.active(r) ? "★" : n.glyph), n.label))),
    session.loggedIn
      ? h("button.btn.postbtn", { onclick: () => whenAllowedToPost(() => go({ name: "post" })) }, "Post")
      : h("button.btn.postbtn", { onclick: () => go({ name: "login" }) }, "Log in"),
    session.loggedIn
      ? h("button.account", { onclick: accountMenu },
          avatarFor(session.user),
          h("span.grow", h("div", { style: "font-weight:700" }, session.user), h("div.muted.small", `@${session.user}`)),
          h("span.muted", "•••"))
      : null,
  );
  // Phone bars
  clear(topbar,
    h("button.logo", { title: "Home", onclick: home }, "GFC"),
    h("div.grow", h("div", { style: "font-weight:700" }, "Galactic Federation Coin"), h("div.muted.small", session.loggedIn ? `@${session.user}` : nodeLabel())),
    session.loggedIn
      ? h("button.btn.secondary.small", { onclick: accountMenu }, "•••")
      : h("button.btn.small", { onclick: () => go({ name: "login" }) }, "Log in"),
  );
  clear(bottombar,
    h("button", { class: r.name === "feed" ? "active" : "", onclick: home }, "Feed"),
    h("button.postbtn", { onclick: () => whenAllowedToPost(() => go({ name: "post" })) }, "+ Post"),
    h("button", { class: r.name === "wallet" ? "active" : "", onclick: () => (session.loggedIn ? go({ name: "wallet" }) : go({ name: "login" })) }, "Wallet"),
  );
  bottombar.classList.toggle("hidden", r.name === "login");
}

function nodeLabel() {
  return api.baseUrl.replace(/^https?:\/\//, "");
}

async function accountMenu() {
  const choice = await sheet<string>((close) =>
    h("div", h("h2", `@${session.user}`), h("div.muted.small", `GFC ${APP_VERSION} · Node: ${nodeLabel()}`),
      h("div.btns",
        h("button.btn.secondary.block", { onclick: () => close("mine") }, "Your posts"),
        h("button.btn.secondary.block", { onclick: () => close("editprofile") }, "Edit profile"),
        h("button.btn.secondary.block", { onclick: () => close("ads") }, "Your ads"),
        h("button.btn.secondary.block", { onclick: () => close("connect") }, "Connect another site"),
        h("button.btn.secondary.block", { onclick: () => close("wallet") }, "Wallet"),
        h("button.btn.danger.block", { onclick: () => close("logout") }, `Log out @${session.user}`),
        h("button.btn.secondary.block", { onclick: () => close() }, "Cancel"))),
  );
  if (choice === "mine") go({ name: "feed", src: "mine" });
  else if (choice === "editprofile") go({ name: "editprofile" });
  else if (choice === "ads") go({ name: "ads" });
  else if (choice === "connect") go({ name: "connect" });
  else if (choice === "wallet") go({ name: "wallet" });
  else if (choice === "logout") {
    toast("Logging out…");
    await session.logout();
    toast("Logged out.");
    stack.length = 0;
    show({ name: "login" });
  }
}

// ---- Right rail ----------------------------------------------------------------------

let railSerial = 0;
export async function renderRightRail() {
  const serial = ++railSerial;
  const search = h("input.search", { placeholder: "Search GFC", type: "search" }) as HTMLInputElement;
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && search.value.trim()) {
      go({ name: "feed", src: "explore", q: search.value.trim() });
      search.value = "";
    }
  });
  const balance = h("div.panel", h("h2", "Your GFC"), h("div.gold", { style: "font-size:28px;font-weight:800" }, "…"), h("div.muted.small", ""),
    h("button.btn.secondary.small", { style: "margin-top:8px", onclick: () => go({ name: "wallet" }) }, "Open wallet"));
  const earners = h("div.panel", h("h2", "Top earners"), h("div.muted.small", "Loading…"));
  clear(rightRail, search, session.loggedIn ? balance : null, trendingPanel, earners,
    h("div.muted.small", { style: "padding:0 4px" }, `GFC ${APP_VERSION} · Node: ${nodeLabel()}`, h("br"), "GFC pays creators when people view their posts."));

  if (session.loggedIn) {
    const ws = session.wallets();
    let total = 0, failed = 0;
    await Promise.all(ws.map(async (w) => {
      try {
        const r = await api.wallet(w.id);
        total += r.balance_cents ?? Math.round(r.balance * 100);
      } catch {
        failed++;
      }
    }));
    if (serial !== railSerial) return;
    (balance.children[1] as HTMLElement).textContent = (total / 100).toFixed(2) + " GFC";
    (balance.children[2] as HTMLElement).textContent = !ws.length
      ? "No wallet on this device yet. Create one to earn from your posts."
      : failed ? "Some wallets couldn't be reached." : `Across ${ws.length} wallet${ws.length === 1 ? "" : "s"}`;
  }

  try {
    const st = await api.podtStats();
    if (serial !== railSerial) return;
    const rows = (st.top_seeders ?? []).filter((t) => t.wallet).slice(0, 5);
    clear(earners, h("h2", "Top earners"),
      h("div.muted.small", `${(st.total_reward_gfc ?? 0).toFixed(2)} GFC paid to creators for ${st.total_transfers ?? 0} views`),
      rows.length ? rows.map((t, i) => {
        const name = t.owner
          ? h("a", { href: "#", title: `See @${t.owner}'s posts`, onclick: (e: Event) => { e.preventDefault(); openUser(t.owner!); } }, `@${t.owner}`)
          : h("span.mono", { title: t.wallet }, shortId(t.wallet));
        return h("div.item", h("span", h("span.muted", `${i + 1}. `), name, h("div.muted.small", `${t.transfer_count} paid views`)),
          h("span.gold", `+${t.total_earned_gfc.toFixed(2)} GFC`));
      }) : h("div.muted.small", { style: "margin-top:8px" }, "No paid views yet."));
  } catch {
    if (serial === railSerial) clear(earners, h("h2", "Top earners"), h("div.muted.small", "Earnings aren't available from this node."));
  }
}

const trendingPanel = h("div.panel.hidden");
/** Trending on GFC: the latest For you list by likes, then GFC earned, then views. */
export function setTrending(items: Seed[]) {
  const top = items.filter((s) => !session.isHiddenForMe(s))
    .sort((a, b) => b.likes - a.likes || b.gfc_earned - a.gfc_earned || b.views - a.views).slice(0, 5);
  trendingPanel.classList.toggle("hidden", !top.length);
  clear(trendingPanel, h("h2", "Trending on GFC"), top.map((s) => {
    const kind = KIND_LABEL[kindOf(s)];
    const text = (s.title || s.description || "").slice(0, 70);
    return h("div.item", { style: "display:block;cursor:pointer", onclick: () => go({ name: "seed", id: s.id, seed: s }) },
      h("div.muted.small", `${kind} · by @${s.owner}`), h("div", { style: "font-weight:700" }, text),
      h("div.muted.small", `${s.likes} like${s.likes === 1 ? "" : "s"} · ${s.views} view${s.views === 1 ? "" : "s"}${s.gfc_earned > 0 ? ` · ${s.gfc_earned.toFixed(2)} GFC earned` : ""}`));
  }));
}

export function shortId(id: string) {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

export function mountShell(root: HTMLElement) {
  topbar = h("header.topbar.phone");
  leftRail = h("aside.left-rail");
  centre = h("main.centre");
  rightRail = h("aside.right-rail");
  bottombar = h("nav.bottombar");
  clear(root, topbar, h("div.shell", leftRail, centre, rightRail), bottombar);
  session.onChange(() => {
    renderNav();
    renderRightRail();
  });
  window.addEventListener("gfc:expired", () => {
    toast("Your session has expired. Please log in again.", true);
    if (current.name !== "login" && current.name !== "seed") show({ name: "login", back: current });
  });
}

export function scroller() {
  return centre;
}

export function start(r: Route) {
  show(r);
  renderRightRail();
}
