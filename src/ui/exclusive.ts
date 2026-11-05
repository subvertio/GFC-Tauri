// GFC Exclusives: who may see the full post, and the signed /play links for it.

import { api, ApiError, type PlayLinks, type Seed } from "../api";
import { session } from "../session";

export type Access = "full" | "login" | "verify" | "unknown";

export function exclusiveAccess(s: Seed): Access {
  if (!s.exclusive) return "full";
  if (!session.loggedIn) return "login";
  if (session.isMine(s) || cachedLinks(s.id)) return "full";
  if (session.locked.has(s.id)) return "verify";
  if (session.verified === true || session.phoneRequired === false) return "full";
  if (session.verified === false && session.phoneRequired === true) return "verify";
  return "unknown";
}

function cachedLinks(id: string): PlayLinks | null {
  const c = session.playCache.get(id);
  return c && c.until > Date.now() ? c.links : null;
}

/** Signed links (and the text of an exclusive text post). Null when the account can't see it. */
export async function playLinks(s: Seed): Promise<PlayLinks | null> {
  const hit = cachedLinks(s.id);
  if (hit) return hit;
  const user = session.user;
  try {
    const links = await api.play(s.id);
    if (session.user !== user) return null;
    const ttl = links.expires_in ? (links.expires_in - 60) * 1000 : 300_000;
    session.playCache.set(s.id, { links, until: Date.now() + ttl });
    return links;
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) session.locked.add(s.id);
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return null;
    throw e;
  }
}

export function unlockText(kind: "text" | "video" | "audio", access: Access): string {
  const what = kind === "text" ? "read the full post" : kind === "audio" ? "hear the full track" : "watch the full clip";
  if (access === "login") return `Log in to ${what}`;
  if (access === "verify") return `Verify your phone to ${what}`;
  return "";
}

export const EXCLUSIVE_BADGE = "★ Exclusive to the GFC Network";
