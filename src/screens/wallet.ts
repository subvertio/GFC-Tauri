// Wallet: recovery code (once), phone verification, wallets, backup (export/import),
// account recovery, balance, send (with a confirmation), history.

import { invoke } from "@tauri-apps/api/core";
import { api, inTauri, parseAmountToCents, ApiError, type Tx } from "../api";
import { registerScreen, back, renderRightRail, shortId, type Route } from "../app";
import { session } from "../session";
import { h, clear, toast, confirmSheet, fmtGfc } from "../ui/dom";
import { copyText, openExternal } from "../ui/actions";
import { celebrate, checkEarnings } from "../earnings";
import { showRecoveryCode } from "./login";

let rerender: (() => void) | null = null;
let verifyPending = false;

/** Open the node's phone verification page; check again when the user comes back. */
export async function startPhoneVerification() {
  if (!session.loggedIn) return;
  try {
    const r = await api.verifyLink();
    if (r.verified) {
      session.verified = true;
      return toast("Your phone is already verified.");
    }
    if (!/^(https:\/\/|http:\/\/127\.0\.0\.1|http:\/\/localhost)/i.test(r.url)) return toast("The node sent an unexpected verification link.", true);
    if (!(await openExternal(r.url))) return toast("Couldn't open the browser.", true);
    toast("Opening phone verification…");
    verifyPending = true;
  } catch (e) {
    toast(String((e as Error).message), true);
  }
}

async function recheckVerification() {
  if (!verifyPending || !session.loggedIn) return;
  try {
    const before = session.verified;
    const st = await api.verifyStatus();
    session.verified = st.verified;
    session.learnWallets(st.wallets);
    if (st.verified) {
      verifyPending = false;
      session.locked.clear();
      if (before !== true) {
        toast("Phone verified. Rewards are on.");
        const grant = (st.rewards?.grant ?? 0) + (st.rewards?.first_post_bonus ?? 0);
        if (grant > 0) celebrate(grant, st.rewards?.first_post_bonus ? "You're verified! Welcome grant + first post bonus" : "You're verified! Welcome grant");
        await checkEarnings();
      }
      rerender?.();
      renderRightRail();
    }
  } catch {
    /* try again next time */
  }
}
window.addEventListener("focus", recheckVerification);
document.addEventListener("visibilitychange", () => !document.hidden && recheckVerification());

registerScreen("wallet", (_route: Route, page) => {
  let selected = session.wallets()[0]?.id ?? "";
  let alive = true;

  const root = h("div.page");
  page.append(h("div.pagehead", h("div.title",
    h("button.iconbtn", { title: "Back", style: "font-size:20px", onclick: back }, "←"), h("h1.grow", "Wallet"))), root);

  const render = () => {
    if (!alive) return;
    if (!session.loggedIn) return clear(root, h("div.empty", "Log in to see this page."));
    const wallets = session.wallets();
    if (!wallets.some((w) => w.id === selected)) selected = wallets[0]?.id ?? "";
    clear(root,
      session.pendingRecoveryCode ? recoveryCard() : null,
      session.verified === false ? verifyCard() : null,
      wallets.length ? balanceCard(wallets) : null,
      wallets.length ? sendCard() : null,
      walletsCard(),
      wallets.length ? backupCard() : null,
      importCard(),
      securityCard(),
      wallets.length ? historyCard() : null);
  };
  rerender = render;

  const recoveryCard = () => h("div.box.warn",
    h("h2", "Write down your recovery code"),
    h("p.muted.small", "If you forget your password, reset it with your phone or email and this code, and your wallets come back with it. It's shown only this once and GFC can't show it again. Keep it somewhere safe, away from your phone."),
    h("div.codebox", session.pendingRecoveryCode),
    h("div.row", { style: "margin-top:12px" },
      h("button.btn.secondary.small", { onclick: async () => (await copyText(session.pendingRecoveryCode)) && toast("Recovery code copied. Paste it somewhere safe, then clear your clipboard.") }, "Copy"),
      h("button.btn.small", { onclick: () => { session.pendingRecoveryCode = ""; render(); } }, "I've written it down")));

  const verifyCard = () => h("div.box", { style: "border-color:var(--accent)" },
    h("h2", "Verify your phone"),
    h("p.muted.small", "Unlocks the 100 GFC welcome grant, your first post bonus, and rewards for the creators you watch. One account per phone number. It opens a page in your browser; come back to GFC when it's done."),
    h("button.btn", { onclick: startPhoneVerification }, "Verify phone"));

  const balanceCard = (wallets: ReturnType<typeof session.wallets>) => {
    const pickerEl = h("select", { onchange: (e: Event) => { selected = (e.target as HTMLSelectElement).value; render(); } },
      wallets.map((w) => h("option", { value: w.id, selected: w.id === selected }, `${w.name || "Wallet"}  (${shortId(w.id)})`)));
    const bal = h("div.gold", { style: "font-size:36px;font-weight:800;margin:8px 0" }, "…");
    api.wallet(selected).then((r) => {
      const cents = r.balance_cents ?? Math.round(r.balance * 100);
      bal.textContent = fmtGfc(cents);
      const gain = session.noteBalance(selected, cents);
      if (gain > 0) celebrate(gain / 100, "You earned GFC!");
    }).catch(() => (bal.textContent = "—"));
    return h("div.box", pickerEl, bal,
      h("div.mono.muted", `ID ${shortId(selected)}`),
      h("div.row", { style: "margin-top:8px" },
        h("button.btn.secondary.small", { onclick: async () => (await copyText(selected)) && toast("Wallet ID copied. Share it to receive GFC.") }, "Copy ID"),
        h("button.btn.secondary.small", { onclick: render }, "Refresh")));
  };

  const sendCard = () => {
    const to = h("input", { placeholder: "recipient wallet ID", spellcheck: false }) as HTMLInputElement;
    const amount = h("input", { placeholder: "e.g. 2.50", inputmode: "decimal" }) as HTMLInputElement;
    const note = h("input", { placeholder: "optional note, e.g. tip", maxlength: 200 }) as HTMLInputElement;
    const msg = h("div.small");
    const btn = h("button.btn", "Send") as HTMLButtonElement;
    btn.onclick = async () => {
      const recipient = to.value.trim();
      const cents = parseAmountToCents(amount.value);
      msg.className = "small danger";
      if (!recipient) return void (msg.textContent = "Enter the recipient's wallet ID.");
      if (recipient === selected) return void (msg.textContent = "That's this wallet. Choose another recipient.");
      if (!cents) return void (msg.textContent = "Enter an amount like 2.50 (up to two decimals).");
      const ok = await confirmSheet("Send GFC?",
        h("div", h("p", h("b.gold", fmtGfc(cents))), h("p.small", "To ", h("span.mono", recipient)),
          note.value.trim() ? h("p.small", `Note: ${note.value.trim()}`) : null,
          h("p.small", "Transfers can't be undone.")), `Send ${fmtGfc(cents)}`);
      if (!ok) return;
      btn.disabled = true;
      msg.className = "small muted";
      msg.textContent = `Sending ${fmtGfc(cents)}…`;
      try {
        const tx = await api.send(selected, recipient, cents, note.value.trim());
        toast(`Sent ${fmtGfc(cents)} (tx ${shortId(tx.tx_hash || tx.id)}).`);
        render();
        renderRightRail();
      } catch (e) {
        msg.className = "small danger";
        msg.textContent = String((e as Error).message);
        btn.disabled = false;
      }
    };
    return h("div.box", h("h2", "Send GFC"), h("label", "To"), to, h("label", "Amount (GFC)"), amount, h("label", "Note"), note,
      h("div.row", { style: "margin-top:12px" }, btn, msg));
  };

  const walletsCard = () => {
    const name = h("input", { placeholder: "new wallet name (optional)" }) as HTMLInputElement;
    const addId = h("input", { placeholder: "wallet ID you already own on this node", spellcheck: false }) as HTMLInputElement;
    const create = h("button.btn.small", "Create wallet") as HTMLButtonElement;
    create.onclick = async () => {
      create.disabled = true;
      toast("Creating a wallet…");
      try {
        const w = await api.createWallet(name.value);
        session.rememberWallet(w.id, w.name);
        selected = w.id;
        if (w.gfc_balance > 0) celebrate(w.gfc_balance, "Welcome grant");
        await checkEarnings();
        toast("Wallet created. Now back it up: see the orange box.");
        render();
      } catch (e) {
        toast(String((e as Error).message), true);
        create.disabled = false;
      }
    };
    return h("div.box", h("h2", "Your wallets"),
      !session.wallets().length ? h("p.muted", "You don't have a wallet on this device yet. Create one below.") : null,
      h("div.row", name, create),
      h("div.row", { style: "margin-top:8px" }, addId, h("button.btn.secondary.small", { onclick: async () => {
        const id = addId.value.trim();
        if (!id) return;
        try {
          const w = await api.wallet(id);
          session.rememberWallet(w.id, w.name);
          selected = w.id;
          render();
        } catch (e) {
          toast(e instanceof ApiError && e.status === 404 ? "That wallet isn't on this node." : String((e as Error).message), true);
        }
      } }, "Add by ID")),
      h("p.muted.small", "Your first wallet receives the 100 GFC welcome grant once your phone number is verified."));
  };

  const backupCard = () => {
    const pw = h("input", { type: "password", placeholder: "account password", autocomplete: "current-password" }) as HTMLInputElement;
    const pp = h("input", { type: "password", placeholder: "a new backup passphrase, 12+ characters" }) as HTMLInputElement;
    const pp2 = h("input", { type: "password", placeholder: "type the passphrase again" }) as HTMLInputElement;
    const msg = h("div.small", { style: "white-space:pre-line" });
    const btn = h("button.btn", { style: "background:#ffad1f;color:#000" }, "Export backup file") as HTMLButtonElement;
    btn.onclick = async () => {
      msg.className = "small danger";
      if (!pw.value) return void (msg.textContent = "Enter your account password.");
      if (pp.value.length < 12) return void (msg.textContent = "The backup passphrase needs at least 12 characters.");
      if (pp.value !== pp2.value) return void (msg.textContent = "The two passphrases don't match.");
      btn.disabled = true;
      msg.className = "small muted";
      msg.textContent = "Encrypting your backup on the node…";
      try {
        const backup = await api.exportBackup(pw.value, pp.value);
        if (!backup?.sealed) throw new Error("Unexpected response from the node.");
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
        const path = inTauri
          ? await invoke<string | null>("save_text", { defaultName: `${session.user}-wallet-backup-${stamp}.json`, contents: JSON.stringify(backup, null, 2) })
          : null;
        if (!path) {
          msg.textContent = "The backup was made but wasn't saved to a file.";
        } else {
          session.markBackedUp();
          pw.value = pp.value = pp2.value = "";
          msg.className = "small success";
          msg.textContent = `Saved to ${path}\nMove it somewhere safe (a USB stick, a password manager). Store the passphrase separately.`;
          toast("Backup saved.");
        }
      } catch (e) {
        msg.className = "small danger";
        msg.textContent = String((e as Error).message);
      } finally {
        btn.disabled = false;
      }
    };
    const done = !session.needsBackup();
    return h("div.box.warn",
      h("h2", done ? "✓ Backed up. Export again after adding a wallet." : "⚠ Back up your wallet"),
      h("p.muted.small", "Your wallet keys live encrypted on your node, unlocked by your password (or your recovery code after a reset). If you lose both, or the node loses its data, your GFC is gone. Export an encrypted backup and keep the file and its passphrase somewhere safe, apart from each other. Anyone with both can spend your GFC."),
      h("label", "Account password"), pw, h("label", "Backup passphrase"), pp, h("label", "Confirm passphrase"), pp2,
      h("div", { style: "margin-top:12px" }, btn), msg);
  };

  const importCard = () => {
    const pp = h("input", { type: "password", placeholder: "the backup's passphrase" }) as HTMLInputElement;
    const msg = h("div.small");
    const btn = h("button.btn.secondary", "Choose backup file and import") as HTMLButtonElement;
    btn.onclick = async () => {
      if (!inTauri) return;
      msg.className = "small danger";
      if (!pp.value) return void (msg.textContent = "Enter the backup's passphrase.");
      const f = await invoke<{ id: string; name: string } | null>("pick_file", { kind: "backup" });
      if (!f) return;
      btn.disabled = true;
      try {
        const text = new TextDecoder().decode(await invoke<ArrayBuffer>("read_picked", { id: f.id, maxBytes: 2 * 1024 * 1024 }));
        invoke("forget_picked", { id: f.id }).catch(() => {});
        const r = await api.importBackup(pp.value, text);
        for (const id of r.imported) session.rememberWallet(id, "");
        session.markBackedUp();
        pp.value = "";
        toast(`Imported ${r.imported.length} wallet${r.imported.length === 1 ? "" : "s"}.`);
        render();
        renderRightRail();
      } catch (e) {
        msg.textContent = String((e as Error).message);
      } finally {
        btn.disabled = false;
      }
    };
    return h("div.box", h("h2", "Restore from a backup"),
      h("p.muted.small", "Bring wallets from a backup file onto this node (for example after a password reset without the recovery code)."),
      h("label", "Backup passphrase"), pp, h("div", { style: "margin-top:12px" }, btn), msg);
  };

  const securityCard = () => {
    const status = h("div.small.muted", "Loading…");
    const pw = h("input", { type: "password", placeholder: "account password" }) as HTMLInputElement;
    api.security().then((s) => {
      clear(status,
        h("div", s.recovery_code ? "Recovery code: made" : "Recovery code: none yet, make one below"),
        h("div", s.email_verified ? `Email: ${s.email}` : "Email: not verified"),
        h("div", s.phone_verified ? "Phone: verified" : "Phone: not verified"));
    }).catch(() => (status.textContent = "This node doesn't offer account recovery yet."));
    return h("div.box", h("h2", "Account recovery"), status,
      h("button.btn.secondary.small", { style: "margin-top:12px", onclick: async () => {
        try {
          const r = await api.emailLink();
          if (await openExternal(r.url)) toast("Verify your email in the browser, then come back to GFC.");
        } catch (e) {
          toast(String((e as Error).message), true);
        }
      } }, "Verify an email"),
      h("p.muted.small", "A verified email can reset your password, or move your account to a new phone number. It opens a page in your browser."),
      h("label", "New recovery code (the old one stops working)"),
      h("div.row", pw, h("button.btn.secondary.small", { onclick: async () => {
        if (!pw.value) return toast("Enter your account password to make a new recovery code.", true);
        try {
          const r = await api.newRecoveryCode(pw.value);
          pw.value = "";
          toast("New recovery code made: write it down. Your old one no longer works.");
          await showRecoveryCode(r.recovery_code);
          render();
        } catch (e) {
          toast(e instanceof ApiError && e.status === 401 ? "That password isn't right." : String((e as Error).message), true);
        }
      } }, "Make a new recovery code")));
  };

  const historyCard = () => {
    const list = h("div", h("div.muted.small", "Loading…"));
    const id = selected;
    api.history(id).then((txs) => {
      if (!alive || id !== selected) return;
      clear(list, txs.length ? txs.map((t) => txRow(t, id)) : h("div.muted", "No transactions yet."));
    }).catch((e) => clear(list, h("div.danger.small", String(e.message))));
    return h("div.box", h("h2", "History"), list);
  };

  render();
  if (session.loggedIn) {
    api.verifyStatus().then((st) => {
      session.verified = st.verified;
      session.learnWallets(st.wallets);
      render();
    }).catch(() => {});
  }
  return () => {
    alive = false;
    rerender = null;
  };
});

function txRow(t: Tx, wallet: string) {
  const cents = t.amount_cents || Math.round(t.amount * 100);
  const incoming = t.recipient === wallet;
  const other = incoming ? t.sender : t.recipient;
  return h("div.history-row",
    h("div.grow",
      h("div", t.reason || t.tx_type || "Transfer"),
      h("div.muted.small", `${incoming ? "from" : "to"} ${shortId(other)} · ${t.tx_type || "TRANSFER"} · ${(t.timestamp || "").slice(0, 19).replace("T", " ")}`)),
    h("div.amt", { class: incoming ? "in" : "" }, `${incoming ? "+" : "−"}${fmtGfc(cents)}`));
}
