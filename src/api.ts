// The node's REST API. Requests go through Tauri's HTTP plugin (Rust side), so nodes don't
// need CORS for the app's origin. In a plain browser (vite dev without Tauri) it falls
// back to window.fetch, which only works against a node that allows the origin.

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke, Channel } from "@tauri-apps/api/core";

export const LIVE_NODE = "https://node.galacticfederation.tech";
export const SHARE_BASE = "https://node.galacticfederation.tech";
export const REQUEST_TIMEOUT_MS = 30_000;

export const inTauri = "__TAURI_INTERNALS__" in window;
export const isAndroid = /Android/i.test(navigator.userAgent);
export const doFetch: typeof fetch = inTauri ? (tauriFetch as typeof fetch) : window.fetch.bind(window);

export class ApiError extends Error {
  constructor(public status: number, message: string, public detail = "") {
    super(message);
  }
}

// ---- Types (as the node sends them) ----------------------------------------------

/** A zip post ("download"): checked and virus-scanned on the node before anyone can get it. */
export interface Download {
  name: string; size: number;
  /** pending | clean | infected | rejected | error | unavailable (no scanner: test nets only) */
  status: string;
  scanned_at?: string; engine?: string; sha256?: string; files?: number | null; programs?: number | null;
}
export interface RepostOf { seed_id: string; owner: string; label?: string; url?: string }
export interface Seed {
  id: string;
  title: string;
  description: string;
  tags: string[];
  full: string | null;
  thumb: string | null;
  stream?: string | null;
  content_type: string;
  file_size: number;
  gfc_earned: number;
  likes: number;
  comments: number;
  views: number;
  created_at: string;
  edited_at?: string;
  owner: string;
  owner_avatar?: string | null;
  reward_wallet?: string;
  liked?: boolean;
  bookmarked?: boolean;
  following?: boolean;  // the viewer follows this post's creator
  /** A promoted post in the For you feed: report its view with the token once it's been seen */
  ad?: { campaign: string; label: string; token: string };
  repost_of?: RepostOf | null;
  exclusive?: boolean;
  teaser?: string | null;
  /** The public preview's length for exclusive videos: 5, 10 or 30 */
  teaser_seconds?: number;
  download?: Download;
}
export interface AdMarket {
  price_per_1000_views: number; floor_per_1000_views: number; active_ads: number;
  views_per_15_min: number; views_wanted_per_15_min: number; creator_share: number;
  ad_every: number; max_days: number; min_budget: number;
}
export interface AdCampaign {
  id: string; seed_id: string; wallet: string; status: "active" | "ended" | "cancelled";
  budget: number; max_cpm: number; spent: number; remaining: number; views: number;
  paid_to_creators: number; avg_cpm: number | null; starts_at: string; ends_at: string;
  ended_at?: string | null; refund?: number | null;
}

export interface Profile {
  username: string; first_name?: string; last_name?: string; bio?: string; avatar?: string | null; created_at?: string;
  followers?: number; following?: number; followed_by_me?: boolean;
}
export interface Tx {
  id: string; sender: string; recipient: string; amount: number; amount_cents?: number; reason: string;
  timestamp: string; tx_hash?: string; tx_type?: string; block_index?: number | null;
}
export interface Comment { id: string; seed_id: string; owner: string; text: string; created_at: string }
export interface Edit { id: string; title: string; description: string; tags: string[]; edited_at: string }
export interface PlayLinks { exclusive: boolean; full: string | null; stream: string | null; teaser?: string | null; text?: string | null; expires_in: number | null }
export interface VerifyStatus { verified: boolean; rewards?: { grant?: number; first_post_bonus?: number }; wallets: string[] }
export interface Health { network: string; phone_required_to_post: boolean }
export interface Security { recovery_code: boolean; email: string; email_verified: boolean; phone_verified: boolean }
export interface TopSeeder { wallet: string; owner?: string; total_earned_gfc: number; transfer_count: number }
export interface PodtStats { total_reward_gfc: number; total_transfers: number; top_seeders: TopSeeder[] }
export interface XPost { text?: string; url?: string; intent?: string }
/** Where an exclusive can be shared. Substack has no posting link: copy text + url, open its Notes. */
export interface ShareLinks { text: string; url: string; x: string; linkedin: string; substack: string }
export interface UploadResult extends Seed {
  rewards_enabled?: boolean; first_post_bonus?: number; first_post_bonus_pending?: boolean; x_post?: XPost; share?: ShareLinks; desc?: string;
}

export type Kind = "3d" | "image" | "video" | "audio" | "text" | "other";

const EXT: Record<Exclude<Kind, "other">, string[]> = {
  "3d": ["glb", "gltf", "fbx", "obj", "usdz", "stl", "3ds"],
  image: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tga"],
  video: ["mp4", "mov", "avi", "webm", "mkv", "wmv", "flv"],
  audio: ["mp3", "wav", "ogg", "oga", "opus", "flac", "aac", "m4a", "aif", "aiff", "wma"],
  text: ["txt", "md"],
};

export function extOf(path?: string | null): string {
  if (!path) return "";
  const clean = path.split(/[?#]/)[0];
  const dot = clean.lastIndexOf(".");
  return dot < 0 ? "" : clean.slice(dot + 1).toLowerCase();
}

/** What a seed is, from content_type, then the file extension. Same rules as the Unreal app. */
export function kindOf(s: Seed): Kind {
  const ct = (s.content_type || "").toLowerCase();
  if (ct === "3d" || ct.startsWith("model/")) return "3d";
  if (ct === "image" || ct.startsWith("image/")) return "image";
  if (ct === "video" || ct.startsWith("video/")) return "video";
  if (ct === "audio" || ct.startsWith("audio/")) return "audio";
  if (ct === "text" || ct.startsWith("text/")) return "text";
  const ext = extOf(s.full);
  for (const [k, list] of Object.entries(EXT)) if (list.includes(ext)) return k as Kind;
  if (s.download) return "other"; // a zip: its link is hidden until the virus scan passes
  if (s.exclusive && !s.full && !s.teaser) return "text";
  return "other";
}

export const KIND_LABEL: Record<Kind, string> = { "3d": "3D model", image: "Image", video: "Video", audio: "Audio", text: "Text", other: "File" };

/** A text post's automatic title: the first line, at most 80 characters. */
export const isZip = (path?: string | null) => extOf(path) === "zip";

export function titleFromBody(body: string): string {
  const line = body.trim().split(/\r?\n/)[0].trim();
  return line.length > 80 ? line.slice(0, 79) + "…" : line;
}

export function normalizeBaseUrl(raw: string): string {
  const s = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/./i.test(s)) return "";
  try {
    new URL(s);
  } catch {
    return "";
  }
  return s;
}

/** Parse "2.50" into cents. Digits, an optional point, at most two decimals, over zero. */
export function parseAmountToCents(raw: string): number | null {
  const s = raw.trim();
  if (!s || s.length > 15 || !/^\d*(\.\d{0,2})?$/.test(s) || s === ".") return null;
  const [w, f = ""] = s.split(".");
  const cents = Number(w || "0") * 100 + Number((f + "00").slice(0, 2));
  return cents > 0 && Number.isSafeInteger(cents) ? cents : null;
}

export interface BridgeChain {
  chain_id: number; name: string; escrow_wallet: string; token_address: string | null; bridge_address?: string | null;
}
export interface BridgeInfo {
  enabled: boolean; chains: BridgeChain[]; min_deposit_cents: number; relay_fee_cents: number;
  faucet_hold_days: number; notice: string;
}
export interface BridgeQuote {
  balance_cents: number; bridgeable_cents: number; held_cents: number; faucet_hold_days: number;
  min_deposit_cents: number; relay_fee_cents: number;
}
export interface BridgeDeposit { ok: boolean; tx_hash: string; amount_cents: number; mint_cents: number; status: string }

// ---- The client --------------------------------------------------------------------

type Query = Record<string, string | number | undefined>;
interface ReqOpts {
  auth?: "required" | "optional" | "none";
  form?: Record<string, string | number | boolean | undefined>;
  /** Files and fields as multipart/form-data (the boundary header is set from it) */
  multipart?: FormData;
  json?: unknown;
  query?: Query;
  signal?: AbortSignal;
  /** A 401 here means a wrong password, not an expired session (keep the session). */
  passwordCheck?: boolean;
}

function errorMessage(status: number, body: unknown): string {
  const d = (body as { detail?: unknown })?.detail;
  if (typeof d === "string" && d) return d;
  if (Array.isArray(d)) {
    const parts = d.map((x: { loc?: unknown[]; msg?: string }) => `${x.loc?.[x.loc.length - 1] ?? "field"}: ${x.msg}`);
    if (parts.length) return parts.join("; ");
  }
  if (status === 0) return "Can't reach the node. Check your connection and the node address.";
  if (status === 400) return "The node rejected the request.";
  if (status === 401) return "Your session has expired. Please log in again.";
  if (status === 403) return "Not allowed with this account or token.";
  if (status === 404) return "Not found.";
  if (status === 409) return "That already exists.";
  if (status === 429) return "Too many requests. Try again in a moment.";
  if (status >= 500) return `The node had a problem (HTTP ${status}). Try again later.`;
  return `Request failed (HTTP ${status}).`;
}

export class GfcApi {
  baseUrl = LIVE_NODE;
  token = "";
  username = "";
  onUnauthorized: () => void = () => {};
  private healthCache = new Map<string, Promise<Health>>();

  media(path?: string | null): string {
    if (!path) return "";
    if (/^https?:\/\//i.test(path)) return path;
    return this.baseUrl + (path.startsWith("/") ? path : "/" + path);
  }

  shareUrl(id: string) {
    return `${SHARE_BASE}/p/${encodeURIComponent(id)}`;
  }

  async request<T>(method: string, path: string, o: ReqOpts = {}): Promise<T> {
    const auth = o.auth ?? "none";
    if (auth === "required" && !this.token) throw new ApiError(401, "Please log in first.");
    let url = this.baseUrl + path;
    if (o.query) {
      const q = Object.entries(o.query).filter(([, v]) => v !== undefined && v !== "");
      if (q.length) url += "?" + q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    if (auth !== "none" && this.token) headers.Authorization = `Bearer ${this.token}`;
    let body: string | FormData | undefined;
    if (o.multipart) {
      body = o.multipart;
    } else if (o.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(o.json);
    } else if (o.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = Object.entries(o.form)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&");
    } else if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = "";
    }

    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await doFetch(url, { method, headers, body, signal });
    } catch (e) {
      if (o.signal?.aborted) throw e;
      throw new ApiError(0, errorMessage(0, null), String(e));
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const msg = errorMessage(res.status, data);
      if (res.status === 401 && auth !== "none" && this.token) {
        if (o.passwordCheck && /invalid credentials|wrong password/i.test(msg)) throw new ApiError(401, "Wrong password.", msg);
        this.onUnauthorized();
      }
      throw new ApiError(res.status, msg);
    }
    if (data === null && text) throw new ApiError(res.status, "Unexpected response from the node.");
    return data as T;
  }

  // Auth
  async login(username: string, password: string) {
    return this.request<{ token: string; user: string }>("POST", "/auth/login", { form: { username: username.trim(), password } });
  }
  async register(username: string, password: string, email: string) {
    return this.request<{ token: string; user: string; recovery_code?: string }>("POST", "/auth/register", {
      form: { username: username.trim(), password, email: email.trim() || undefined },
    });
  }
  /** Revoke this session's token on the node. Any token may revoke itself. */
  async logout() {
    if (!this.token) return;
    const id = await tokenId(this.token);
    await this.request("DELETE", `/auth/tokens/${id}`, { auth: "required" });
  }

  health(): Promise<Health> {
    let p = this.healthCache.get(this.baseUrl);
    if (!p) {
      p = this.request<Health>("GET", "/health");
      p.catch(() => this.healthCache.delete(this.baseUrl));
      this.healthCache.set(this.baseUrl, p);
    }
    return p;
  }

  // Feed
  async feed() {
    return (await this.request<{ items: Seed[] }>("GET", "/feed", { auth: "optional" })).items ?? [];
  }
  async search(q: string) {
    return (await this.request<{ seeds: Seed[] }>("GET", "/search", { auth: "optional", query: { q } })).seeds ?? [];
  }
  async followingFeed() {
    return (await this.request<{ items: Seed[] }>("GET", "/feed/following", { auth: "required" })).items ?? [];
  }
  follow(name: string) {
    return this.request<{ followed_by_me: boolean; followers: number }>("POST", `/users/${encodeURIComponent(name)}/follow`, { auth: "required" });
  }
  unfollow(name: string) {
    return this.request<{ followed_by_me: boolean; followers: number }>("DELETE", `/users/${encodeURIComponent(name)}/follow`, { auth: "required" });
  }
  async bookmarks() {
    return (await this.request<{ items: Seed[] }>("GET", "/bookmarks", { auth: "required" })).items ?? [];
  }
  async mine() {
    return (await this.request<{ items: Seed[] }>("GET", "/seeds/mine", { auth: "required" })).items ?? [];
  }
  async userSeeds(name: string) {
    return (await this.request<{ items: Seed[] }>("GET", `/users/${encodeURIComponent(name)}/seeds`, { auth: "optional" })).items ?? [];
  }
  user(name: string) {
    return this.request<Profile>("GET", `/users/${encodeURIComponent(name)}`, { auth: "optional" });
  }
  me() {
    return this.request<Profile>("GET", "/users/me", { auth: "required" });
  }
  updateProfile(fields: { first_name: string; last_name: string; bio: string }) {
    return this.request<Profile>("POST", "/users/me", { auth: "required", form: fields });
  }
  /** A new profile photo (JPEG, PNG, GIF or WebP, up to 5 MB). Returns its address. */
  uploadAvatar(image: Blob, fileName = "avatar.jpg") {
    const fd = new FormData();
    fd.append("avatar", image, fileName);
    return this.request<{ avatar: string }>("POST", "/users/me/avatar", { auth: "required", multipart: fd });
  }
  seed(id: string) {
    return this.request<Seed>("GET", `/seeds/${encodeURIComponent(id)}`);
  }
  like(id: string) {
    return this.request<{ liked: boolean; like_count: number }>("POST", `/seeds/${encodeURIComponent(id)}/like`, { auth: "required" });
  }
  bookmark(id: string) {
    return this.request<{ bookmarked: boolean }>("POST", `/seeds/${encodeURIComponent(id)}/bookmark`, { auth: "required" });
  }
  connectPartners() {
    return this.request<{ partners: { id: string; name: string }[] }>("GET", "/connect/partners");
  }
  /** A one-time code that tells a partner site this is a (phone-verified) GFC member. */
  connectCode(partner: string) {
    return this.request<{ code: string; partner: string; name: string; expiresIn: number }>("POST", "/connect/code",
      { auth: "required", form: { partner } });
  }
  adMarket() {
    return this.request<AdMarket>("GET", "/ads/market");
  }
  myAds() {
    return this.request<{ campaigns: AdCampaign[]; market: AdMarket }>("GET", "/ads/campaigns", { auth: "required" });
  }
  createAd(a: { seedId: string; walletId: string; budget: number; maxCpm: number; days: number }) {
    return this.request<AdCampaign>("POST", "/ads/campaigns", { auth: "required", form: {
      seed_id: a.seedId, wallet_id: a.walletId, budget: a.budget, max_cpm: a.maxCpm, days: a.days } });
  }
  cancelAd(id: string) {
    return this.request<AdCampaign>("POST", `/ads/campaigns/${encodeURIComponent(id)}/cancel`, { auth: "required" });
  }
  /** Report that an ad was on screen: a counted view pays the creator of the post above it. */
  adView(token: string) {
    return this.request<{ counted: boolean; creator_paid?: number; why?: string }>("POST", "/ads/view", { auth: "required", form: { token } });
  }
  async comments(id: string, offset = 0) {
    return (await this.request<{ items: Comment[] }>("GET", `/seeds/${encodeURIComponent(id)}/comments`, { query: { limit: 50, offset } })).items ?? [];
  }
  comment(id: string, text: string) {
    return this.request<{ comment: Comment; comment_count: number }>("POST", `/seeds/${encodeURIComponent(id)}/comments`, { auth: "required", form: { text } });
  }
  played(id: string) {
    return this.request<{ credited: boolean; amount?: number; reason?: string }>("POST", `/seeds/${encodeURIComponent(id)}/played`, { auth: "required" });
  }
  play(id: string) {
    return this.request<PlayLinks>("GET", `/seeds/${encodeURIComponent(id)}/play`, { auth: "required" });
  }
  edit(id: string, fields: { title?: string; description?: string; tags?: string }) {
    return this.request<{ title: string; description: string; tags: string[]; edited_at: string }>("POST", `/seeds/${encodeURIComponent(id)}/edit`, {
      auth: "required", form: fields,
    });
  }
  async edits(id: string) {
    return (await this.request<{ edits: Edit[] }>("GET", `/seeds/${encodeURIComponent(id)}/edits`, { auth: "optional" })).edits ?? [];
  }
  report(id: string, reason: string) {
    return this.request("POST", `/seeds/${encodeURIComponent(id)}/report`, { auth: "required", form: { reason } });
  }
  block(name: string) {
    return this.request("POST", `/users/${encodeURIComponent(name)}/block`, { auth: "required" });
  }
  async blocks() {
    return (await this.request<{ blocked: string[] }>("GET", "/users/me/blocks", { auth: "required" })).blocked ?? [];
  }
  podtStats() {
    return this.request<PodtStats>("GET", "/podt/stats");
  }

  // Wallets
  createWallet(name: string) {
    return this.request<{ id: string; name: string; gfc_balance: number }>("POST", "/wallets/create", { auth: "required", form: { name: name.trim() || "Default Wallet" } });
  }
  wallet(id: string) {
    return this.request<{ id: string; name: string; balance: number; balance_cents?: number }>("GET", `/wallets/${encodeURIComponent(id)}`);
  }
  async history(walletId: string) {
    return (await this.request<{ transactions: Tx[] }>("GET", "/transactions/history", { query: { wallet_id: walletId } })).transactions ?? [];
  }
  /** The node truncates int(amount*100), so send a quarter cent over. */
  send(sender: string, recipient: string, cents: number, reason: string) {
    return this.request<Tx>("POST", "/transactions/create", {
      auth: "required", json: { sender, recipient: recipient.trim(), amount: (cents + 0.25) / 100, reason },
    });
  }
  // Bridge to Base (the node's app_bridge.py)
  bridgeInfo() {
    return this.request<BridgeInfo>("GET", "/bridge/info");
  }
  bridgeQuote(walletId: string) {
    return this.request<BridgeQuote>("GET", "/bridge/quote", { query: { wallet_id: walletId } });
  }
  bridgeDeposit(walletId: string, chainId: number, evmAddress: string, cents: number) {
    return this.request<BridgeDeposit>("POST", "/bridge/deposit", {
      auth: "required", json: { wallet_id: walletId, chain_id: chainId, evm_address: evmAddress, amount: cents / 100 },
    });
  }
  exportBackup(password: string, passphrase: string) {
    return this.request<Record<string, unknown>>("POST", "/wallets/export", {
      auth: "required", form: { password, backup_passphrase: passphrase }, passwordCheck: true,
    });
  }
  importBackup(passphrase: string, backup: string) {
    return this.request<{ imported: string[] }>("POST", "/wallets/import", { auth: "required", form: { backup_passphrase: passphrase, backup } });
  }

  // Verification and account
  verifyStatus() {
    return this.request<VerifyStatus>("GET", "/verify/status", { auth: "required" });
  }
  verifyLink() {
    return this.request<{ verified: boolean; url: string }>("POST", "/verify/link", { auth: "required" });
  }
  security() {
    return this.request<Security>("GET", "/account/security", { auth: "required" });
  }
  emailLink() {
    return this.request<{ url: string }>("POST", "/email/link", { auth: "required" });
  }
  newRecoveryCode(password: string) {
    return this.request<{ recovery_code: string }>("POST", "/account/recovery-code", { auth: "required", form: { password }, passwordCheck: true });
  }

  /** Upload with progress, retried twice (2 s, then 6 s) on network errors, 429 and 5xx. */
  async upload(
    args: { fileId?: string; text?: string; title: string; description: string; tags: string; exclusive: boolean; teaserSeconds?: number; thumbnail?: Uint8Array | null },
    onProgress: (sent: number, total: number) => void,
    uploadId: string,
  ): Promise<{ result: UploadResult; attempts: number }> {
    if (!this.token) throw new ApiError(401, "Please log in first.");
    const delays = [2000, 6000];
    for (let attempt = 1; ; attempt++) {
      const ch = new Channel<{ sent: number; total: number }>();
      ch.onmessage = (p) => onProgress(p.sent, p.total);
      let r: { status: number; body: string };
      try {
        r = await invoke("upload_seed", {
          uploadId, baseUrl: this.baseUrl, token: this.token,
          fileId: args.fileId ?? null, text: args.text ?? null,
          title: args.title, description: args.description, tags: args.tags, exclusive: args.exclusive,
          teaserSeconds: args.exclusive && args.teaserSeconds ? args.teaserSeconds : null,
          thumbnail: args.thumbnail ? Array.from(args.thumbnail) : null, onProgress: ch,
        });
      } catch (e) {
        throw new ApiError(-1, String(e));
      }
      const retryable = r.status === 0 || r.status === 429 || r.status >= 500;
      if (retryable && attempt <= delays.length) {
        await new Promise((ok) => setTimeout(ok, delays[attempt - 1]));
        continue;
      }
      let data: unknown = null;
      try {
        data = JSON.parse(r.body);
      } catch {
        /* not JSON */
      }
      if (r.status >= 200 && r.status < 300 && data) {
        const res = data as UploadResult;
        if (!res.description && res.desc) res.description = res.desc;
        return { result: res, attempts: attempt };
      }
      if (r.status === 401) this.onUnauthorized();
      if (r.status === 413) throw new ApiError(413, "The file is too big for the node.");
      throw new ApiError(r.status, errorMessage(r.status, data), r.body);
    }
  }
}

/** The node's token id: the first 16 hex characters of SHA-256(token). */
export async function tokenId(token: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/** Download bytes (3D models, text files) without CORS, with a size cap. */
export async function fetchBytes(url: string, o: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<ArrayBuffer> {
  const res = await doFetch(url, { signal: o.signal });
  if (!res.ok) throw new ApiError(res.status, res.status === 403 ? "This is exclusive to the GFC Network." : `Download failed (HTTP ${res.status}).`);
  const len = Number(res.headers.get("content-length") || 0);
  if (o.maxBytes && len > o.maxBytes) throw new Error(`This file is ${(len / 1048576).toFixed(0)} MB; the limit is ${(o.maxBytes / 1048576).toFixed(0)} MB.`);
  const buf = await res.arrayBuffer();
  if (o.maxBytes && buf.byteLength > o.maxBytes) throw new Error("This file is too big to open here.");
  return buf;
}

export const api = new GfcApi();
