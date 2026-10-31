// Following creators: one shared state per creator, so every Follow button for the same
// person (feed cards, their profile) changes together.

import { api } from "../api";
import { go } from "../app";
import { session } from "../session";
import { h, toast } from "./dom";

const state = new Map<string, boolean>(); // lower-case username -> followed
const listeners = new Set<() => void>();

const key = (name: string) => name.toLowerCase();

/** What the node said (feed items' `following`, a profile's `followed_by_me`). */
export function noteFollowing(name: string, following: boolean | undefined) {
  if (following !== undefined) state.set(key(name), following);
}

export function isFollowing(name: string): boolean {
  return state.get(key(name)) ?? false;
}

export function onFollowChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export async function setFollowing(name: string, follow: boolean): Promise<{ followers: number } | null> {
  const before = isFollowing(name);
  state.set(key(name), follow);
  listeners.forEach((fn) => fn());
  try {
    const r = follow ? await api.follow(name) : await api.unfollow(name);
    return { followers: r.followers };
  } catch (e) {
    state.set(key(name), before);
    listeners.forEach((fn) => fn());
    toast(String((e as Error).message ?? e));
    return null;
  }
}

/**
 * A Follow / Following button for `name` (nothing for your own account). Logged out, it
 * opens the login page. `onCount` gets the new follower count after a change. The button's
 * listener goes into `disposers`, for the caller to run when the button leaves the page.
 */
export function followButton(name: string, disposers: (() => void)[],
                             opts: { small?: boolean; onCount?: (n: number) => void } = {}): HTMLElement | null {
  if (session.isMine({ owner: name })) return null;
  const btn = h(opts.small ? "button.follow.small" : "button.follow") as HTMLButtonElement;
  const paint = () => {
    const on = session.loggedIn && isFollowing(name);
    btn.classList.toggle("on", on);
    btn.textContent = on ? "Following" : "Follow";
    btn.title = on ? `Stop following @${name}` : `Follow @${name}: their posts show in your Following tab`;
  };
  btn.onclick = async (e) => {
    e.stopPropagation();
    if (!session.loggedIn) {
      go({ name: "login" });
      return;
    }
    btn.disabled = true;
    const r = await setFollowing(name, !isFollowing(name));
    btn.disabled = false;
    if (r) opts.onCount?.(r.followers);
  };
  // Hovering "Following" offers to unfollow, like most apps
  btn.onmouseenter = () => { if (btn.classList.contains("on")) btn.textContent = "Unfollow"; };
  btn.onmouseleave = paint;
  paint();
  disposers.push(onFollowChange(paint));
  return btn;
}
