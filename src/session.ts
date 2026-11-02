// Who's logged in, on which node, and what this device remembers about them.
// The token lives in memory; with "stay logged in" it is also kept in the OS credential
// store (Windows Credential Manager) via the app's secure-store plugin. Everything else
// that's remembered (node choice, known wallets, last-seen balances) is in localStorage.

import { invoke } from "@tauri-apps/api/core";
import { api, inTauri, HOME_NODE, normalizeBaseUrl, type PlayLinks } from "./api";

const PREFS_KEY = "gfc.prefs.v1";
const SECRET_KEY = "session";
// Browsers have no keychain. Dev runs keep the session for the tab only; the iPhone web app
// (Add to Home Screen) keeps it in its own storage, which only this app's origin can read, so
// people don't log in at every launch. That token can spend: the node serves the web app with a
// strict Content-Security-Policy (its own scripts only) so injected script can't read it, and
// unticking "stay logged in" keeps it in memory only.
const BROWSER_STORE: Storage | null = inTauri ? null : import.meta.env.DEV ? sessionStorage : localStorage;

async function secretGet(): Promise<string | null> {
  if (BROWSER_STORE) return BROWSER_STORE.getItem(SECRET_KEY);
  return invoke<string | null>("plugin:secure-store|get", { key: SECRET_KEY });
}
async function secretSet(value: string) {
  if (BROWSER_STORE) return BROWSER_STORE.setItem(SECRET_KEY, value);
  await invoke("plugin:secure-store|set", { key: SECRET_KEY, value });
}
async function secretDelete() {
  if (BROWSER_STORE) return BROWSER_STORE.removeItem(SECRET_KEY);
  await invoke("plugin:secure-store|delete", { key: SECRET_KEY });
}

export interface KnownWallet { owner: string; node: string; id: string; name: string; backedUp: boolean; lastSeenCents: number }
interface Prefs { nodeOverride: string; stayLoggedIn: boolean; wallets: KnownWallet[] }

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return { nodeOverride: p.nodeOverride || "", stayLoggedIn: p.stayLoggedIn ?? true, wallets: Array.isArray(p.wallets) ? p.wallets : [] };
  } catch {
    return { nodeOverride: "", stayLoggedIn: true, wallets: [] };
  }
}

type Listener = () => void;

class Session {
  prefs = loadPrefs();
  blocked = new Set<string>();
  reported = new Set<string>();
  /** null = unknown */
  verified: boolean | null = null;
  /** The node's /health rule; false on test nets. null = unknown. */
  phoneRequired: boolean | null = null;
  /** Shown once after registering or making a new code; never stored. */
  pendingRecoveryCode = "";
  playCache = new Map<string, { links: PlayLinks; until: number }>();
  locked = new Set<string>();
  private listeners = new Set<Listener>();

  get loggedIn() {
    return !!api.token;
  }
  get user() {
    return api.username;
  }
  get node() {
    return api.baseUrl;
  }

  onChange(f: Listener) {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }
  private emit() {
    for (const f of this.listeners) f();
  }

  savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
    } catch {
      /* storage full or blocked: not fatal */
    }
  }

  /** On launch: pick the node, then restore a remembered session for it. */
  async restore(): Promise<boolean> {
    api.baseUrl = normalizeBaseUrl(this.prefs.nodeOverride) || HOME_NODE;
    api.onUnauthorized = () => this.clear(true);
    try {
      const raw = await secretGet();
      if (!raw) return false;
      const s = JSON.parse(raw) as { node: string; user: string; token: string };
      if (s.node !== api.baseUrl || !s.token) return false;
      api.token = s.token;
      api.username = s.user;
      this.emit();
      return true;
    } catch {
      return false;
    }
  }

  async begin(user: string, token: string, stay: boolean) {
    this.resetPerUser();
    api.username = user;
    api.token = token;
    this.prefs.stayLoggedIn = stay;
    this.savePrefs();
    try {
      if (stay) await secretSet(JSON.stringify({ node: api.baseUrl, user, token }));
      else await secretDelete();
    } catch (e) {
      console.warn("couldn't remember the session", e);
    }
    this.emit();
  }

  private resetPerUser() {
    this.blocked.clear();
    this.reported.clear();
    this.verified = null;
    this.phoneRequired = null;
    this.playCache.clear();
    this.locked.clear();
  }

  /** Forget the session locally (after logout, a 401 or a node switch). */
  clear(expired = false) {
    const had = !!api.token;
    api.token = "";
    api.username = "";
    this.pendingRecoveryCode = "";
    this.resetPerUser();
    secretDelete().catch(() => {});
    if (had) {
      this.emit();
      if (expired) window.dispatchEvent(new CustomEvent("gfc:expired"));
    }
  }

  async logout() {
    try {
      await api.logout();
    } catch {
      /* the node may be unreachable; log out locally anyway */
    }
    this.clear();
  }

  /** Switch nodes. Tokens belong to one node, so this logs out. Returns false for a bad URL. */
  setNode(raw: string): boolean {
    const url = normalizeBaseUrl(raw);
    if (!url) return false;
    if (url !== api.baseUrl) {
      this.clear();
      api.baseUrl = url;
    }
    this.prefs.nodeOverride = url === HOME_NODE ? "" : url;
    this.savePrefs();
    this.emit();
    return true;
  }

  // ---- Wallets this device knows for the current user and node ----

  wallets(): KnownWallet[] {
    const u = api.username.toLowerCase();
    return this.prefs.wallets.filter((w) => w.owner.toLowerCase() === u && w.node === api.baseUrl);
  }

  rememberWallet(id: string, name: string) {
    const existing = this.wallets().find((w) => w.id === id);
    if (existing) existing.name = name || existing.name;
    else this.prefs.wallets.push({ owner: api.username, node: api.baseUrl, id, name: name || "Wallet", backedUp: false, lastSeenCents: -1 });
    this.savePrefs();
    this.emit();
  }

  /** Add wallets the node says are ours (from /verify/status). */
  learnWallets(ids: string[]) {
    let changed = false;
    for (const id of ids) {
      if (!id || id.length > 128 || this.wallets().some((w) => w.id === id)) continue;
      this.prefs.wallets.push({ owner: api.username, node: api.baseUrl, id, name: this.wallets().length ? "Wallet" : "main", backedUp: false, lastSeenCents: -1 });
      changed = true;
    }
    if (changed) {
      this.savePrefs();
      this.emit();
    }
  }

  /** Record a balance as seen; returns how much it rose since last seen (0 on first sighting). */
  noteBalance(id: string, cents: number): number {
    const w = this.wallets().find((x) => x.id === id);
    if (!w) return 0;
    const gain = w.lastSeenCents >= 0 && cents > w.lastSeenCents ? cents - w.lastSeenCents : 0;
    if (w.lastSeenCents !== cents) {
      w.lastSeenCents = cents;
      this.savePrefs();
    }
    return gain;
  }

  markBackedUp() {
    for (const w of this.wallets()) w.backedUp = true;
    this.savePrefs();
  }

  needsBackup() {
    return this.wallets().some((w) => !w.backedUp);
  }

  isHiddenForMe(s: { id: string; owner: string }) {
    return this.reported.has(s.id) || this.blocked.has(s.owner.toLowerCase());
  }

  isMine(s: { owner: string }) {
    return !!api.username && s.owner.toLowerCase() === api.username.toLowerCase();
  }
}

export const session = new Session();
