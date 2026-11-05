// Sharing an exclusive after posting it: X, LinkedIn and Substack, all from one click.
// X takes text + link in its intent. LinkedIn's share page takes only the link (it reads the
// title and image from the post's share page), so the text goes to the clipboard for the
// caption. Substack has no posting link: the text and link go to the clipboard and its
// Notes composer opens.

import { invoke } from "../native";
import { api, inTauri, isAndroid, type UploadResult } from "../api";
import { copyText, openExternal } from "./actions";

export type ShareTarget = "x" | "linkedin" | "substack";
export const SHARE_TARGETS: { id: ShareTarget; label: string }[] = [
  { id: "x", label: "X" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "substack", label: "Substack" },
];

/** The share links, from `share` (new nodes) or `x_post` (older nodes: X only). */
function linksFor(res: UploadResult) {
  const s = res.share;
  const text = s?.text ?? res.x_post?.text ?? "";
  const url = s?.url ?? res.x_post?.url ?? "";
  const x = s?.x || res.x_post?.intent || `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
  return { text, url, x, linkedin: s?.linkedin ?? "", substack: s?.substack ?? "" };
}

/** Substack can't be pre-filled: the poster pastes this (text, then the link) into a new Note. */
export function copyForSubstack(res: UploadResult): Promise<boolean> {
  const l = linksFor(res);
  return copyText(`${l.text}\n${l.url}`);
}

export function openSubstack(res: UploadResult): Promise<boolean> {
  return openExternal(linksFor(res).substack || "https://substack.com/notes");
}

export const PASTE_KEYS = isAndroid ? "long-press and tap Paste" : "press Ctrl+V";

export function availableTargets(res: UploadResult): ShareTarget[] {
  const l = linksFor(res);
  return SHARE_TARGETS.map((t) => t.id).filter((t) => !!l[t]);
}

/** Save the teaser clip to Videos\GFC (shown in Explorer). Returns its folder, or "". */
export async function saveTeaser(res: UploadResult): Promise<string> {
  if (!res.teaser || !inTauri) return "";
  try {
    const path = await invoke<string>("save_teaser", { baseUrl: api.baseUrl, path: res.teaser, fileName: res.title || `GFC-${res.id.slice(0, 12)}` });
    return path.replace(/[\\/][^\\/]+$/, "");
  } catch {
    return "";
  }
}

/** Share to every chosen target. Returns one short note per target, for the post screen. */
export async function shareTo(res: UploadResult, targets: ShareTarget[]): Promise<{ target: ShareTarget; note: string }[]> {
  const l = linksFor(res);
  // Only video teasers are attached: an audio preview is shared as the link (X can't post audio-only)
  const clip = res.content_type === "video" ? res.teaser ?? null : null;
  // Android: one system share sheet with the teaser clip, text and link; the poster picks
  // the X, LinkedIn or Substack app there. Falls back to the links below if it fails.
  if (isAndroid && inTauri) {
    try {
      const withClip = await invoke<boolean>("share_native", {
        text: `${l.text}
${l.url}`, baseUrl: api.baseUrl, teaser: clip, fileName: res.title || `GFC-${res.id.slice(0, 12)}`,
      });
      const names = targets.map((t) => SHARE_TARGETS.find((x) => x.id === t)!.label).join(", ");
      return [{ target: targets[0] ?? "x", note: `Pick ${names} in the share sheet${withClip ? ": the teaser clip, text and link are attached" : ": the text and link are attached"}.` }];
    } catch {
      /* fall back to links and the clipboard */
    }
  }
  const wantsLinkedIn = targets.includes("linkedin") && !!l.linkedin;
  const wantsSubstack = targets.includes("substack") && !!l.substack;
  // Copy first: once a browser window takes focus, the page may no longer write to the
  // clipboard. Substack needs text + link; LinkedIn only the text (it has the link).
  const copied = wantsSubstack ? await copyText(`${l.text}\n${l.url}`) : wantsLinkedIn ? await copyText(l.text) : false;
  let savedDir = "";
  if (targets.includes("x") && clip) savedDir = await saveTeaser(res);

  const notes: { target: ShareTarget; note: string }[] = [];
  for (const t of targets) {
    if (t === "x") {
      const ok = await openExternal(l.x);
      notes.push({ target: t, note: !ok ? "Couldn't open X."
        : savedDir ? `Opened X. The teaser is saved in ${savedDir}: attach it to the post.` : "Opened X with the text and link." });
    } else if (t === "linkedin" && wantsLinkedIn) {
      const ok = await openExternal(l.linkedin);
      notes.push({ target: t, note: !ok ? "Couldn't open LinkedIn."
        : !copied ? "Opened LinkedIn."
        : wantsSubstack ? "Opened LinkedIn: paste the copied text as the caption (leave out the link)."
        : "Text copied: paste it into LinkedIn as the caption." });
    } else if (t === "substack" && wantsSubstack) {
      const ok = await openExternal(l.substack);
      // Substack has no way to pre-fill a Note: it opens on the home page's empty Note box
      notes.push({ target: t, note: !ok ? "Couldn't open Substack. Use Open Substack below."
        : copied ? `Opened Substack. Click "What's on your mind?" at the top, ${PASTE_KEYS} to paste the text and link, then Post.`
        : `Opened Substack. Click Copy for Substack below, then click "What's on your mind?" and ${PASTE_KEYS}.` });
    }
  }
  return notes;
}
