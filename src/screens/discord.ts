// Link Discord: a one-time code the member types into /verify in the GFC Discord server, which
// gives their Discord account the Verified GFC role. Only for phone-verified accounts; one
// Discord account per GFC account. Discord never sees their password, phone number or wallet.

import { api, type DiscordStatus } from "../api";
import { registerScreen, back, go } from "../app";
import { session } from "../session";
import { h, clear, toast, confirmSheet } from "../ui/dom";
import { openExternal } from "../ui/actions";

const INVITE = "https://discord.gg/dDwFhzykcn";

registerScreen("discord", (_route, page) => {
  page.append(h("div.pagehead", h("div.title",
    h("button.iconbtn", { title: "Back", style: "font-size:20px", onclick: back }, "←"),
    h("h1.grow", "Link Discord"))));
  const body = h("div.page", h("div.muted", "Loading…"));
  page.append(body);
  if (!session.loggedIn) return void go({ name: "login", back: { name: "discord" } }, { replace: true });

  let timer = 0;
  const join = () => h("button.btn.secondary.small", { onclick: () => openExternal(INVITE) }, "Open the GFC Discord");

  const showCode = (code: string, seconds: number) => {
    const left = h("span");
    const tick = () => {
      const m = Math.floor(seconds / 60), s = seconds % 60;
      left.textContent = seconds > 0 ? `Valid for ${m}:${String(s).padStart(2, "0")}` : "Expired: get a new code";
      if (seconds-- <= 0) clearInterval(timer);
    };
    clearInterval(timer);
    timer = window.setInterval(tick, 1000);
    tick();
    const command = `/verify ${code}`;
    const copy = h("button.btn.small", { onclick: async () => {
      try {
        await navigator.clipboard.writeText(command);
        toast("Copied");
      } catch {
        toast("Select the command and copy it", true);
      }
    } }, "Copy command");
    return h("div.connect-code",
      h("div.muted.small", "Type this in #how-to-verify on the GFC Discord"),
      h("div.code", command),
      h("div.muted.small", left),
      h("div.row", { style: "gap:8px;justify-content:center" }, copy, join()),
      h("p.small", "It works once. The reply in Discord is private: only you see it. "
        + "GFC staff will never DM you first or ask for your password, seed phrase or private key."));
  };

  const render = (st: DiscordStatus) => {
    clearInterval(timer);
    if (!st.available) {
      return void clear(body, h("p", "Discord verification isn't open yet. Watch #announcements on the GFC Discord."),
        h("div.btns", join()));
    }
    if (st.linked) {
      const unlink = h("button.btn.danger.block", { onclick: async () => {
        const ok = await confirmSheet("Unlink Discord?",
          h("p", "Your Discord account loses the Verified GFC role and the community channels. You can link again later."),
          "Unlink");
        if (!ok) return;
        try {
          await api.discordUnlink();
          toast("Discord unlinked");
          load();
        } catch (e) {
          toast(String((e as Error).message ?? e), true);
        }
      } }, "Unlink Discord");
      return void clear(body,
        h("p", "Linked to Discord", st.discordName ? h("b", ` ${st.discordName}`) : null, "."),
        st.role === "granted" ? h("p.small.muted", "Your Discord account has the Verified GFC role.")
          : st.role === "left" ? h("p.small", { style: "color:#ffad1f" },
            "You're not on the GFC Discord right now. Rejoin and the role comes back within a few minutes.")
          : h("p.small.muted", "The Verified GFC role is being added: it can take a few minutes."),
        h("div.btns", join(), unlink));
    }
    if (!st.phoneVerified) {
      return void clear(body,
        h("p", "The community channels on the GFC Discord are for phone-verified GFC members."),
        h("p.small", { style: "color:#ffad1f" }, "Verify your phone in Wallet first, then come back here."),
        h("div.btns", h("button.btn.block", { onclick: () => go({ name: "wallet" }) }, "Go to Wallet")));
    }
    const out = h("div");
    const get = h("button.btn.block", { onclick: async () => {
      get.disabled = true;
      try {
        const c = await api.discordCode();
        clear(out, showCode(c.code, c.expiresIn));
      } catch (err) {
        clear(out, h("div.danger", String((err as Error).message ?? err)));
      } finally {
        get.disabled = false;
      }
    } }, "Get a code") as HTMLButtonElement;
    clear(body,
      h("p", "Link your Discord account to get the Verified GFC role and the community channels."),
      h("ol.small",
        h("li", "Join the GFC Discord if you haven't."),
        h("li", "Get a code here."),
        h("li", "In #how-to-verify, type the /verify command shown with the code.")),
      h("div.btns", get, join()), out);
  };

  const load = () => api.discordStatus().then(render)
    .catch((e) => clear(body, h("div.danger", `Couldn't load: ${(e as Error).message ?? e}`)));
  load();

  return () => clearInterval(timer);
});
