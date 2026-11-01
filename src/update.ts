// The app's version, and keeping it current. Windows installs updates from the node itself:
// Tauri's updater checks /app/windows/update.json, downloads the installer in the background,
// checks it's signed with the updater key built into the app, and asks to restart. Android
// can't install silently outside the Play Store, so it offers the new APK and Android asks.

import { LIVE_NODE, doFetch, inTauri, isAndroid } from "./api";
import { h } from "./ui/dom";
import { openExternal } from "./ui/actions";

declare const __APP_VERSION__: string;
export const APP_VERSION = __APP_VERSION__;

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const DISMISSED_KEY = "gfc.update.dismissed";

/** 1 if a is newer than b, -1 if older, 0 if the same ("0.2.10" is newer than "0.2.9"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

let banner: HTMLElement | null = null;
let busy = false;

function showBanner(text: string, action: string, onAction: () => void, version: string) {
  try {
    if (localStorage.getItem(DISMISSED_KEY) === version) return;
  } catch {
    /* storage blocked: show it */
  }
  banner?.remove();
  const button = h("button.btn.small", { onclick: onAction }, action) as HTMLButtonElement;
  banner = h("div#update-banner", { role: "status" },
    h("span.grow", text), button,
    h("button.linkbtn", { title: "Not now", onclick: () => {
      try {
        localStorage.setItem(DISMISSED_KEY, version);
      } catch {
        /* fine */
      }
      banner?.remove();
      banner = null;
    } }, "Later"));
  document.body.appendChild(banner);
}

async function checkWindows() {
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return;
  // Download now, so the restart is quick; the plugin refuses a download that isn't signed
  // with the app's updater key
  await update.download();
  showBanner(`GFC ${update.version} is ready.`, "Restart to update", async () => {
    if (!banner) return;
    banner.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
    banner.querySelector("span")!.textContent = `Installing GFC ${update.version}…`;
    await update.install();  // Windows closes the app to run the installer, which reopens it
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  }, update.version);
}

async function checkAndroid() {
  const res = await doFetch(`${LIVE_NODE}/app/release.json`, { cache: "no-store" });
  const rel = (await res.json()) as { published?: boolean; version?: string };
  if (!rel.published || !rel.version || compareVersions(rel.version, APP_VERSION) <= 0) return;
  const version = rel.version;
  showBanner(`GFC ${version} is available (you have ${APP_VERSION}).`, "Update", async () => {
    // The browser downloads the APK; opening it asks Android to install it over this one
    if (!(await openExternal(`${LIVE_NODE}/app/android`))) location.href = `${LIVE_NODE}/app/android`;
  }, version);
}

async function checkOnce() {
  if (busy || !inTauri) return;  // the browser preview has nothing to update
  busy = true;
  try {
    await (isAndroid ? checkAndroid() : checkWindows());
  } catch (e) {
    console.warn("update check failed", e);  // offline, or the node is down: try again later
  } finally {
    busy = false;
  }
}

/** Check now and then every few hours while the app stays open. */
export function startUpdateChecks() {
  setTimeout(checkOnce, 5000);  // after the feed has loaded
  setInterval(checkOnce, CHECK_EVERY_MS);
}
