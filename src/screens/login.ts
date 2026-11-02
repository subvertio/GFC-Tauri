// Log in, create an account (the recovery code is shown once), forgot password, and the node switcher.

import { api, HOME_NODE, ApiError, isAndroid } from "../api";
import { registerScreen, go, home, type Route } from "../app";
import { session } from "../session";
import { h, toast, sheet } from "../ui/dom";
import { copyText, openExternal } from "../ui/actions";
import { afterLogin } from "../earnings";
import { APP_VERSION } from "../update";

const TEST_NODE = "http://127.0.0.1:8100";

registerScreen("login", (route, page) => {
  const r = route as Extract<Route, { name: "login" }>;
  const user = h("input", { placeholder: "username (without @)", autocomplete: "username", autocapitalize: "off", spellcheck: false }) as HTMLInputElement;
  const pass = h("input", { type: "password", placeholder: "password", autocomplete: "current-password" }) as HTMLInputElement;
  const email = h("input", { type: "email", placeholder: "e-mail (optional)", autocomplete: "email" }) as HTMLInputElement;
  const stay = h("input", { type: "checkbox", checked: session.prefs.stayLoggedIn }) as HTMLInputElement;
  const msg = h("div.small", { style: "min-height:20px;margin-top:8px" });
  const loginBtn = h("button.btn.block", "Log in") as HTMLButtonElement;
  const registerBtn = h("button.btn.secondary.block", "Create account") as HTMLButtonElement;
  const nodeText = h("div.small.muted");
  const nodeBox = h("input", { placeholder: "or another node's address", value: api.baseUrl }) as HTMLInputElement;

  const say = (text: string, error = false) => {
    msg.textContent = text;
    msg.className = "small " + (error ? "danger" : "muted");
  };
  const showNode = () => {
    nodeText.textContent = `Node: ${api.baseUrl}`;
    nodeBox.value = api.baseUrl;
  };
  const useNode = (url: string) => {
    if (!session.setNode(url)) return say("Enter a node address starting with http:// or https://.", true);
    user.value = "";
    pass.value = "";
    showNode();
    say(`Using node ${api.baseUrl}.`);
  };
  const busy = (b: boolean) => {
    loginBtn.disabled = registerBtn.disabled = b;
  };
  const done = () => (r.back ? go(r.back, { replace: true }) : home());
  // Names are shown as "@Name", so people type the @ too
  const username = () => user.value.trim().replace(/^@+/, "").trim();

  const doLogin = async () => {
    if (!username() || !pass.value) return say("Enter a username and password.", true);
    busy(true);
    say("Logging in…");
    try {
      const res = await api.login(username(), pass.value);
      await session.begin(res.user, res.token, stay.checked);
      toast(`Welcome back, ${res.user}.`);
      afterLogin();
      done();
    } catch (e) {
      // Newer nodes say which part was wrong (usernames are public anyway); older ones don't
      const known = e instanceof ApiError && /^(No account with that username|Wrong password)/.test(e.message);
      say(e instanceof ApiError && e.status === 401 && !known ? "Wrong username or password." : String((e as Error).message), true);
    } finally {
      busy(false);
      pass.value = "";
    }
  };

  const doRegister = async () => {
    if (!username() || !pass.value) return say("Enter a username and password.", true);
    if (pass.value.length < 8) return say("Use a password of at least 8 characters.", true);
    busy(true);
    say("Creating your account…");
    try {
      const res = await api.register(username(), pass.value, email.value);
      await session.begin(res.user, res.token, stay.checked);
      pass.value = "";
      if (res.recovery_code) await showRecoveryCode(res.recovery_code, true);
      toast(`Account created. Welcome, ${res.user}! Now create your first wallet.`);
      afterLogin();
      go({ name: "wallet" }, { replace: true });
    } catch (e) {
      say(String((e as Error).message), true);
    } finally {
      busy(false);
    }
  };

  loginBtn.onclick = doLogin;
  registerBtn.onclick = doRegister;
  pass.addEventListener("keydown", (e) => e.key === "Enter" && doLogin());
  user.addEventListener("keydown", (e) => e.key === "Enter" && pass.focus());

  showNode();
  page.append(h("div.page.narrow",
    h("div", { style: "text-align:center;margin:24px 0" }, h("div.logo", { style: "width:64px;height:64px;font-size:20px" }, "GFC"),
      h("h1", { style: "margin-top:12px" }, "Galactic Federation Coin"),
      h("p.muted", "Log in or create an account to see the feed and your wallet.")),
    h("div.box",
      h("label", "Username"), user,
      h("label", "Password"), pass,
      h("label.check", { style: "margin-top:12px" }, stay, isAndroid ? "Stay logged in on this phone" : "Stay logged in on this computer"),
      h("p.small", { style: "color:#ffad1f;margin:12px 0 0" },
        "Your password also unlocks your wallets. Forgot it? Reset it with your phone or email, and the recovery code you'll get when you create your account brings your wallets back with it."),
      h("label", "E-mail, for new accounts"), email,
      msg,
      h("div.stack", { style: "margin-top:8px" }, loginBtn, registerBtn,
        h("button.linkbtn", { style: "display:block;margin:12px auto 0", onclick: async () => {
          if (await openExternal(`${api.baseUrl}/reset`)) say("Reset your password in the browser, then log in here with the new one.");
          else say("Couldn't open the browser.", true);
        } }, "Forgot password?"))),
    h("div.box",
      h("h2", "Node"), nodeText,
      h("div.row.wrap", { style: "margin-top:8px" },
        h("button.btn.secondary.small", { onclick: () => useNode(HOME_NODE) }, "Live node"),
        h("button.btn.secondary.small", { onclick: () => useNode(TEST_NODE) }, "Local test node")),
      h("div.row", { style: "margin-top:8px" }, nodeBox, h("button.btn.small", { onclick: () => useNode(nodeBox.value) }, "Use")),
      h("p.muted.small", "Switching nodes logs you out: an account lives on one node."),
      h("p.muted.small", `GFC app ${APP_VERSION}`)),
    h("div", { style: "text-align:center" }, h("button.linkbtn", { onclick: home }, "Browse the feed without logging in")),
  ));
  // On phones focusing would pop the keyboard over the screen before the user asked for it
  if (!isAndroid) setTimeout(() => user.focus());
});

/** The recovery code, shown once. GFC can't show it again. */
export async function showRecoveryCode(code: string, mustConfirm = false) {
  session.pendingRecoveryCode = code;
  await sheet<void>((close) => {
    const ok = h("button.btn.block", { onclick: () => { session.pendingRecoveryCode = ""; close(); } }, "I've written it down");
    return h("div",
      h("h2", "Write down your recovery code"),
      h("p.muted.small", "If you forget your password, reset it with your phone or email and this code, and your wallets come back with it. It's shown only this once and GFC can't show it again. Keep it somewhere safe, away from your phone."),
      h("div.codebox", code),
      h("div.btns",
        h("button.btn.secondary.block", { onclick: async () => {
          if (await copyText(code)) toast("Recovery code copied. Paste it somewhere safe, then clear your clipboard.");
        } }, "Copy"),
        ok,
        mustConfirm ? null : h("button.btn.secondary.block", { onclick: () => close() }, "Close")));
  });
  // Escape/backdrop closes without confirming; the wallet screen keeps showing it until confirmed.
}
