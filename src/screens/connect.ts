// Connect another site: a one-time code the member pastes into a partner site's sign-up (for
// example Creator World), so the site knows they have a confirmed GFC account. The site never
// sees their password or phone number: only their GFC username and when they verified.

import { api } from "../api";
import { registerScreen, back, go } from "../app";
import { session } from "../session";
import { h, clear, toast } from "../ui/dom";

registerScreen("connect", (_route, page) => {
  page.append(h("div.pagehead", h("div.title",
    h("button.iconbtn", { title: "Back", style: "font-size:20px", onclick: back }, "←"),
    h("h1.grow", "Connect another site"))));
  const body = h("div.page", h("div.muted", "Loading…"));
  page.append(body);
  if (!session.loggedIn) return void go({ name: "login", back: { name: "connect" } }, { replace: true });

  let timer = 0;
  const showCode = (name: string, code: string, seconds: number) => {
    const left = h("span");
    const tick = () => {
      const m = Math.floor(seconds / 60), s = seconds % 60;
      left.textContent = seconds > 0 ? `Valid for ${m}:${String(s).padStart(2, "0")}` : "Expired: get a new code";
      if (seconds-- <= 0) clearInterval(timer);
    };
    clearInterval(timer);
    timer = window.setInterval(tick, 1000);
    tick();
    const copy = h("button.btn.small", { onclick: async () => {
      try {
        await navigator.clipboard.writeText(code);
        toast("Code copied");
      } catch {
        toast("Select the code and copy it", true);
      }
    } }, "Copy code");
    return h("div.connect-code",
      h("div.muted.small", `Your code for ${name}`),
      h("div.code", code),
      h("div.muted.small", left),
      h("div.row", { style: "gap:8px;justify-content:center" }, copy),
      h("p.small", `Paste it into ${name}'s sign-up form. It works once, only on ${name}. `
        + "They'll see your GFC username and whether your phone is verified, never your password, phone number or email."));
  };

  api.connectPartners().then(({ partners }) => {
    if (!partners.length) {
      clear(body, h("div.empty", "No sites are connected to GFC yet."));
      return;
    }
    const out = h("div");
    const list = partners.map((p) => h("button.btn.secondary.block", {
      onclick: async (e: Event) => {
        const btn = e.currentTarget as HTMLButtonElement;
        btn.disabled = true;
        try {
          const c = await api.connectCode(p.id);
          clear(out, showCode(c.name, c.code, c.expiresIn));
        } catch (err) {
          clear(out, h("div.danger", String((err as Error).message ?? err)));
        } finally {
          btn.disabled = false;
        }
      },
    }, `Get a code for ${p.name}`));
    clear(body,
      h("p", "Some sites ask for a GFC account to join. Get a one-time code here and paste it into their sign-up form."),
      session.verified ? null : h("p.small", { style: "color:#ffad1f" },
        "Most sites need a verified phone. If yours isn't verified yet, verify it in Wallet first."),
      h("div.btns", list), out);
  }).catch((e) => clear(body, h("div.danger", `Couldn't load: ${(e as Error).message ?? e}`)));

  return () => clearInterval(timer);
});
