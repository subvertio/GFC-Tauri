// A zip post ("download"): name, size, what's inside, the virus-scan result, and a Download
// button once the node's scan has passed. Exclusive downloads get their link from /play.

import { invoke } from "@tauri-apps/api/core";
import { api, ApiError, inTauri, type Seed } from "../api";
import { go, askToVerify } from "../app";
import { h, clear, fmtBytes, toast } from "./dom";
import { exclusiveAccess, playLinks } from "./exclusive";

const scannerName = (engine?: string) => (/clam/i.test(engine ?? "") ? "ClamAV" : engine || "the node");

function scanDate(iso?: string) {
  if (!iso) return "";
  const t = Date.parse(iso);
  return isFinite(t) ? new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
}

export function downloadBox(s: Seed): HTMLElement {
  const d = s.download!;
  const box = h("div.media.download.no-open", { style: "padding:14px 16px" });
  const status = h("div.small", { style: "margin-top:6px" });
  const actions = h("div.row.wrap", { style: "margin-top:10px" });
  const counts = [d.files != null ? `${d.files} file${d.files === 1 ? "" : "s"}` : "", d.programs != null ? `${d.programs} program${d.programs === 1 ? "" : "s"}` : ""]
    .filter(Boolean).join(" · ");
  clear(box,
    h("div.row", h("span.badge", { style: "background:var(--surface-2);color:var(--text-3);margin:0" }, "ZIP"),
      h("div.grow", h("div", { style: "font-weight:700;overflow-wrap:anywhere" }, d.name),
        h("div.muted.small", [fmtBytes(d.size), counts].filter(Boolean).join(" · ")))),
    status, actions);

  const access = exclusiveAccess(s);
  const ready = d.status === "clean" || d.status === "unavailable";
  if (d.status === "pending") status.append(h("span.muted", "Checking for viruses…"));
  else if (d.status === "clean") {
    status.append(h("div.success", `✓ Scanned by ${scannerName(d.engine)}${scanDate(d.scanned_at) ? ` on ${scanDate(d.scanned_at)}` : ""}`));
  } else if (d.status === "unavailable") status.append(h("div", { style: "color:#ffad1f" }, "Not virus-scanned: this test node has no scanner."));
  else status.append(h("div.danger", "This download didn't pass the safety check."));
  if (ready && d.sha256) status.append(h("div.mono.muted", { title: "SHA-256 of the zip" }, `SHA-256 ${d.sha256}`));

  if (!ready) return box;
  if (s.exclusive && (access === "login" || access === "verify")) {
    actions.append(h("a.gold", { href: "#", style: "font-weight:700", onclick: (e: Event) => {
      e.preventDefault();
      if (access === "login") go({ name: "login", back: { name: "seed", id: s.id, seed: s } });
      else askToVerify("Verify your phone number to get GFC Exclusives. It takes a minute, and it keeps bots and spam out.");
    } }, access === "login" ? "Log in to download" : "Verify your phone to download"));
    return box;
  }
  const btn = h("button.btn.small", "Download") as HTMLButtonElement;
  btn.onclick = async () => {
    if (!inTauri) return toast("Downloading needs the desktop app.", true);
    btn.disabled = true;
    btn.textContent = "Downloading…";
    try {
      let url = s.full ? api.media(s.full) : "";
      if (s.exclusive || !url) {
        const links = await playLinks(s);
        if (!links) return box.replaceWith(downloadBox(s)); // not allowed after all: show why
        url = api.media(links.full);
      }
      const path = await invoke<string | null>("download_file", { url, defaultName: d.name });
      if (path) toast(`Saved to ${path}`);
    } catch (e) {
      toast(e instanceof ApiError && e.status === 409 ? "This download is still being checked for viruses. Try again in a few minutes." : String((e as Error).message ?? e), true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Download";
    }
  };
  actions.append(btn);
  return box;
}
