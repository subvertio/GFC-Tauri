// Ads: promote one of your posts with GFC (Promote), and see and stop your ads (Your ads).
// The node runs the market (ads.py): every winning ad pays the same market price per
// 1,000 views, never more than your max, and 70% of each view goes to the creator of the
// post shown above the ad, at once.

import { api, type AdCampaign, type AdMarket, type Seed } from "../api";
import { registerScreen, back, go, whenAllowedToPost, type Route } from "../app";
import { session } from "../session";
import { h, clear, toast, timeAgo } from "../ui/dom";

const gfc = (n: number) => `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} GFC`;

function header(title: string) {
  return h("div.pagehead", h("div.title",
    h("button.iconbtn", { title: "Back", style: "font-size:20px", onclick: back }, "←"),
    h("h1.grow", title)));
}

function marketLine(m: AdMarket) {
  return h("div.muted.small",
    `Market rate now: ${gfc(m.price_per_1000_views)} per 1,000 views (lowest ${gfc(m.floor_per_1000_views)}) · `
    + `${m.active_ads} ad${m.active_ads === 1 ? "" : "s"} running · ${Math.round(m.creator_share * 100)}% of every view pays the creator next to the ad.`);
}

registerScreen("promote", (route, page) => {
  const r = route as Extract<Route, { name: "promote" }>;
  page.append(header("Promote a post"));
  const body = h("div.page.ad-form", h("div.muted", "Loading…"));
  page.append(body);
  if (!session.loggedIn) return void go({ name: "login", back: r }, { replace: true });

  Promise.all([api.adMarket(), r.seed ? Promise.resolve(r.seed) : api.seed(r.seedId)]).then(([m, seed]) => {
    const wallets = session.wallets();
    if (!wallets.length) {
      clear(body, h("p", "You need a wallet with GFC to run an ad."), h("button.btn", { onclick: () => go({ name: "wallet" }) }, "Open Wallet"));
      return;
    }
    const suggested = Math.ceil(m.price_per_1000_views * 1.2);
    const budget = h("input", { type: "number", min: m.min_budget, step: 1, value: Math.max(m.min_budget, 500) }) as HTMLInputElement;
    const price = h("input", { type: "number", min: m.floor_per_1000_views, step: 1, value: suggested }) as HTMLInputElement;
    const days = h("select", [1, 3, 7, 14, 30].map((d) => h("option", { value: d, selected: d === 7 }, `${d} day${d === 1 ? "" : "s"}`))) as HTMLSelectElement;
    const wallet = h("select", wallets.map((w) => h("option", { value: w.id }, w.name))) as HTMLSelectElement;
    const balance = h("div.muted.small");
    const estimate = h("div.ad-estimate");
    const status = h("div.small");
    const start = h("button.btn", "Start ad") as HTMLButtonElement;

    const showBalance = () => {
      balance.textContent = "";
      api.wallet(wallet.value).then((w) => (balance.textContent = `Balance: ${gfc(w.balance)}`)).catch(() => {});
    };
    const update = () => {
      const b = Number(budget.value), p = Number(price.value), d = Number(days.value);
      const ok = b >= m.min_budget && p >= m.floor_per_1000_views;
      start.disabled = !ok;
      if (!ok) {
        estimate.textContent = `The budget must be at least ${gfc(m.min_budget)}, and the max price at least ${gfc(m.floor_per_1000_views)} per 1,000 views.`;
        return;
      }
      const atMarket = Math.min(p, Math.max(m.price_per_1000_views, m.floor_per_1000_views));
      const views = Math.floor((b / atMarket) * 1000);
      clear(estimate,
        h("div", h("b", `About ${views.toLocaleString()} views`), ` over ${d} day${d === 1 ? "" : "s"} at today's rate (${gfc(atMarket)} per 1,000). `,
          p < m.price_per_1000_views ? h("span.danger", "Your max is under the market rate: the ad only shows when the price drops to it.") : null),
        h("div.muted.small", `You pay the market price, never more than ${gfc(p)} per 1,000 views. `
          + `About ${gfc(b * m.creator_share)} of the budget goes to creators whose posts appear next to your ad. `
          + "Whatever isn't spent comes back to your wallet when the ad ends, or if you stop it."));
    };
    for (const el of [budget, price, days]) el.addEventListener("input", update);
    wallet.addEventListener("change", showBalance);

    start.onclick = () => whenAllowedToPost(async () => {
      start.disabled = true;
      status.className = "small muted";
      status.textContent = "Starting your ad…";
      try {
        await api.createAd({ seedId: seed.id, walletId: wallet.value, budget: Number(budget.value), maxCpm: Number(price.value), days: Number(days.value) });
        toast("Your ad is running");
        go({ name: "ads" }, { replace: true });
      } catch (e) {
        status.className = "small danger";
        status.textContent = String((e as Error).message ?? e);
        start.disabled = false;
      }
    });

    clear(body,
      h("div.card", { style: "cursor:default" }, h("div.post",
        h("div.muted.small", "Your post"), h("h3", (seed as Seed).title || "Untitled"))),
      marketLine(m),
      h("label", "Budget (GFC)"), budget,
      h("label", "Max price (GFC per 1,000 views)"), price,
      h("div.muted.small", `The market rate is ${gfc(m.price_per_1000_views)}. Bidding more wins more of the slots when lots of ads compete.`),
      h("label", "Run for"), days,
      h("label", "Pay from"), wallet, balance,
      estimate, start, status);
    showBalance();
    update();
  }).catch((e) => clear(body, h("div.danger", `Couldn't load: ${(e as Error).message ?? e}`)));
});

registerScreen("ads", (_route, page) => {
  page.append(header("Your ads"));
  const body = h("div.page", h("div.muted", "Loading…"));
  page.append(body);
  if (!session.loggedIn) return void go({ name: "login", back: { name: "ads" } }, { replace: true });

  const load = () => api.myAds().then(({ campaigns, market }) => {
    clear(body, marketLine(market),
      h("p.muted.small", "To start an ad, open one of your posts' ••• menu and choose Promote this post."),
      campaigns.length ? campaigns.map(row) : h("div.empty", "You haven't run any ads yet."));
  }).catch((e) => clear(body, h("div.danger", `Couldn't load your ads: ${(e as Error).message ?? e}`)));

  const row = (c: AdCampaign) => {
    const stop = c.status === "active" ? h("button.btn.secondary.small", {
      onclick: async () => {
        try {
          const done = await api.cancelAd(c.id);
          toast(`Ad stopped. ${gfc(done.refund ?? 0)} back to your wallet.`);
          load();
        } catch (e) {
          toast(String((e as Error).message ?? e), true);
        }
      },
    }, "Stop ad") : null;
    const daysLeft = Math.max(0, Math.ceil((Date.parse(c.ends_at) - Date.now()) / 86_400_000));
    const state = c.status === "active" ? `Running · ${daysLeft ? `${daysLeft} day${daysLeft === 1 ? "" : "s"} left` : "ends today"}`
      : c.status === "cancelled" ? `Stopped ${timeAgo(c.ended_at)} ago` : `Ended ${timeAgo(c.ended_at)} ago`;
    return h("div.ad-row",
      h("div.row", { style: "justify-content:space-between;align-items:center" },
        h("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); go({ name: "seed", id: c.seed_id }); } }, h("b", "View post")),
        h("span.small", state), stop),
      h("div.stats",
        `${c.views.toLocaleString()} view${c.views === 1 ? "" : "s"} · spent ${gfc(c.spent)} of ${gfc(c.budget)}`
        + (c.avg_cpm != null ? ` · ${gfc(c.avg_cpm)} per 1,000 views` : "")
        + ` · paid to creators ${gfc(c.paid_to_creators)}`
        + (c.refund != null ? ` · refunded ${gfc(c.refund)}` : ` · max ${gfc(c.max_cpm)} per 1,000`)));
  };
  load();
});
