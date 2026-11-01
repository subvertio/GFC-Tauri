// "You earned GFC": the gold burst, and checking balances against what the user last saw.

import { api } from "./api";
import { session } from "./session";
import { h } from "./ui/dom";

// The ka-ching from the original GFC app
const KA_CHING = "/sounds/ka_ching.mp3";

export function celebrate(amount: number, caption: string) {
  const sound = new Audio(KA_CHING);
  sound.volume = 0.8;
  sound.play().catch(() => {
    /* the WebView may refuse sound before the first tap: the burst still shows */
  });
  const burst = h("div.burst",
    h("div.amount", `+${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} GFC`, h("small", caption)));
  for (let i = 0; i < 22; i++) {
    const c = h("div.coin");
    c.style.left = `${50 + (Math.random() - 0.5) * 30}%`;
    c.style.setProperty("--dx", `${(Math.random() - 0.5) * 70}vw`);
    c.style.animationDelay = `${Math.random() * 0.4}s`;
    burst.appendChild(c);
  }
  document.body.appendChild(burst);
  setTimeout(() => burst.remove(), 3200);
}

/** Sum of rises across known wallets since they were last seen; records the new balances. */
export async function checkEarnings(): Promise<number> {
  let gained = 0;
  await Promise.all(session.wallets().map(async (w) => {
    try {
      const r = await api.wallet(w.id);
      gained += session.noteBalance(w.id, r.balance_cents ?? Math.round(r.balance * 100));
    } catch {
      /* skip unreachable wallets */
    }
  }));
  return gained;
}

const WATCH_MS = 30_000;
let watching = false;

/**
 * While the app is open, every rise in the user's wallets (views paid, ad payouts, transfers in,
 * bridged GFC coming back) plays the ka-ching and the coin burst. Screens that celebrate a gain
 * themselves call checkEarnings() after, so it isn't celebrated twice.
 */
export function watchEarnings() {
  if (watching) return;
  watching = true;
  setInterval(async () => {
    if (!session.loggedIn || document.hidden) return;  // a hidden window catches up when shown
    const gained = await checkEarnings();
    if (gained > 0) celebrate(gained / 100, "You earned GFC!");
  }, WATCH_MS);
}

/** After login, register, or launch with a saved session. */
export async function afterLogin() {
  api.health().then((h) => (session.phoneRequired = h.phone_required_to_post)).catch(() => {});
  api.blocks().then((b) => b.forEach((n) => session.blocked.add(n.toLowerCase()))).catch(() => {});
  try {
    const st = await api.verifyStatus();
    session.verified = st.verified;
    session.learnWallets(st.wallets);
  } catch {
    /* older node or offline */
  }
  const gained = await checkEarnings();
  if (gained > 0) celebrate(gained / 100, "You earned GFC while you were away!");
}
