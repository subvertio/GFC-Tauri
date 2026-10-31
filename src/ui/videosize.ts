// Videos over the 1 GB post limit can be uploaded (up to 4 GB) when GFC's optimised copy will
// fit: the node re-encodes oversized videos at the same resolution, capped at a bitrate for that
// resolution. The same estimate as the node's audio_stream.estimated_optimized_bytes, from the
// video's length and size (its header only), so people find out before a long upload.

import { invoke } from "@tauri-apps/api/core";
import { fmtBytes } from "./dom";

export const MAX_POST = 1024 ** 3;            // what the node keeps
export const MAX_VIDEO_UPLOAD = 4 * 1024 ** 3; // what it takes in, for videos it will optimise
const AUDIO_KBPS = 192;
// (max short side, kbit/s ceiling): audio_stream.OPTIMIZE_CEILINGS
const CEILINGS: [number, number][] = [[720, 5000], [1080, 10000], [1440, 16000], [2160, 35000], [1e6, 60000]];

export interface VideoInfo { duration: number; width: number; height: number }

const ceiling = (i: VideoInfo) => CEILINGS.find(([side]) => Math.min(i.width, i.height) <= side)![1];

/** About how big the stored video will be (an upper bound). */
export function estimatedBytes(info: VideoInfo, size: number): number {
  const kbps = (size * 8) / 1000 / info.duration;
  if (kbps <= ceiling(info) * 1.2) return size; // not oversized: kept as uploaded
  return (info.duration * (ceiling(info) + AUDIO_KBPS) * 1000) / 8;
}

/** The highest video bitrate (Mbit/s, one decimal, rounded down) that keeps a video this long under 1 GB. */
export function targetMbps(duration: number): number {
  return Math.max(0.1, Math.floor((((MAX_POST * 8) / 1000 / Math.max(duration, 1) - AUDIO_KBPS) / 1000) * 10) / 10);
}

/** The tip when even the optimised copy is over 1 GB. */
export function bitrateTip(info: VideoInfo, size: number): string {
  const target = targetMbps(info.duration);
  const short = Math.min(info.width, info.height);
  // Below about 3 Mbit/s, 1080p and up looks soft: 720p at the same bitrate looks better
  const res = target < 3 && short > 720 ? ", and at 720p (1280x720): at this bitrate it looks better than "
    + `${short}p` : "";
  return `Tip: lower the bitrate. This video would still be about ${fmtBytes(estimatedBytes(info, size))} after GFC `
    + `optimises it (${Math.round(info.duration / 60)} min at ${info.width}x${info.height}), and posts can be up to 1 GB. `
    + `Export it at ${target.toFixed(1)} Mbit/s or less (the video bitrate in your editor's export settings)${res}. `
    + "Or split it into parts, then post them.";
}

export interface BigVideoCheck { ok: boolean; note: string }

/**
 * For a video file: fine as it is (ok, no note), over 1 GB but its optimised copy fits (ok,
 * with the estimate), or not postable as it is (with what to do).
 */
export async function checkVideoSize(p: { id: string; size: number; online_only?: boolean }): Promise<BigVideoCheck> {
  if (p.size <= MAX_POST) return { ok: true, note: "" };
  if (p.size > MAX_VIDEO_UPLOAD) {
    return { ok: false, note: `Too big: ${fmtBytes(p.size)}. Videos can be uploaded up to 4 GB (GFC optimises them to 1 GB or less). Export it smaller, or trim it.` };
  }
  if (p.online_only) {
    return { ok: true, note: `${fmtBytes(p.size)}: GFC checks it fits once it's downloaded from OneDrive.` };
  }
  const info = await invoke<VideoInfo | null>("video_info", { id: p.id }).catch(() => null);
  if (!info || !(info.duration > 0)) {
    return { ok: false, note: `Over 1 GB, and GFC can't read this video's length to work out its optimised size. Export it as MP4 (H.264) under 1 GB, then post it again.` };
  }
  const est = estimatedBytes(info, p.size);
  if (est > MAX_POST) return { ok: false, note: bitrateTip(info, p.size) };
  return { ok: true, note: `Over 1 GB: GFC optimises it after it's posted, to about ${fmtBytes(est)} at the same ${info.width}x${info.height}. A ${fmtBytes(p.size)} upload takes a while: keep the app open until it's done.` };
}
