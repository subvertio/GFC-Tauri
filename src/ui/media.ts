// One heavy media item plays at a time, nothing autoplays, and qualified plays are
// reported to /seeds/{id}/played once per seed per app session (never your own posts).

import { api, type Seed } from "../api";
import { session } from "../session";
import { toast } from "./dom";

const players = new Set<HTMLMediaElement>();
const reported = new Set<string>();

export function stopAllMedia(except?: HTMLMediaElement) {
  for (const p of players) {
    if (p === except) continue;
    if (!p.isConnected) {
      release(p);
      continue;
    }
    p.pause();
  }
}

function release(p: HTMLMediaElement) {
  p.pause();
  p.removeAttribute("src");
  p.load();
  players.delete(p);
}

/** Pause and let go of players that left the page. */
export function sweepMedia() {
  for (const p of players) if (!p.isConnected) release(p);
}

export async function reportPlayed(seed: Seed, announce = false) {
  if (!session.loggedIn || session.isMine(seed) || reported.has(seed.id)) return;
  reported.add(seed.id);
  try {
    const r = await api.played(seed.id);
    if (r.credited && announce) toast(`Your view of ${seed.title || "this post"} earned its creator ${(r.amount ?? 0).toFixed(2)} GFC.`);
  } catch {
    /* dropped, not queued */
  }
}

/** Track a video/audio element: counts after 5 s, or half of a clip under 10 s. */
export function trackPlayer(p: HTMLMediaElement, seed: Seed, announce = false) {
  players.add(p);
  p.addEventListener("play", () => stopAllMedia(p));
  const check = () => {
    const d = p.duration;
    if (p.currentTime >= 5 || (isFinite(d) && d > 0 && d < 10 && p.currentTime >= d / 2)) {
      p.removeEventListener("timeupdate", check);
      reportPlayed(seed, announce);
    }
  };
  p.addEventListener("timeupdate", check);
}

/** Report once `el` has been continuously visible for `ms` (images, text, loaded 3D). */
export function trackVisible(el: Element, seed: Seed, ms: number, announce = false): () => void {
  let timer = 0;
  const obs = new IntersectionObserver(([e]) => {
    clearTimeout(timer);
    if (e.isIntersecting && e.intersectionRatio >= 0.6 && !document.hidden) {
      timer = window.setTimeout(() => {
        obs.disconnect();
        reportPlayed(seed, announce);
      }, ms);
    }
  }, { threshold: [0, 0.6] });
  obs.observe(el);
  return () => {
    clearTimeout(timer);
    obs.disconnect();
  };
}

// Off-screen cards let go of their players (video stops and frees its buffer).
const offscreen = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) {
      const p = e.target as HTMLMediaElement;
      if (!p.paused) p.pause();
    }
  }
}, { rootMargin: "25% 0px" });

export function pauseWhenOffscreen(p: HTMLMediaElement) {
  offscreen.observe(p);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopAllMedia();
});
