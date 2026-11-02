// The OneDrive tip: online-only OneDrive videos ("Available when online") download through
// the OneDrive app. When it isn't running they can't be posted, so say so, offer to start
// it, and say when it's back.

import { invoke } from "../native";
import { h, clear } from "./dom";

/** True when some of these picked files are online-only in OneDrive and OneDrive isn't running. */
export function oneDriveMissing(ids: string[]): Promise<boolean> {
  return invoke<boolean>("onedrive_missing", { ids }).catch(() => false);
}

/** Does an error message come from OneDrive (or another cloud storage app)? */
export const isOneDriveError = (msg: string) => /onedrive|cloud file/i.test(msg);

/** The tip, with a Start OneDrive button. `onReady` runs once OneDrive is running. */
export function oneDriveTip(onReady?: () => void): HTMLElement {
  const text = h("div",
    h("b", "Tip: start OneDrive. "),
    "Some of your videos are only in OneDrive's cloud (\"Available when online\"), and they download through "
    + "the OneDrive app, which isn't running. Start it, wait until it's signed in, then press Post again.");
  const button = h("button.btn.small", "Start OneDrive") as HTMLButtonElement;
  const status = h("div.small.muted");
  const tip = h("div.tip", text, h("div.row.wrap", { style: "gap:8px;margin-top:8px;align-items:center" }, button, status));
  button.onclick = async () => {
    button.disabled = true;
    try {
      await invoke("start_onedrive");
    } catch (e) {
      status.textContent = String(e);
      button.disabled = false;
      return;
    }
    status.textContent = "Starting OneDrive…";
    // OneDrive takes a few seconds to start and sign in
    for (let i = 0; i < 45 && tip.isConnected; i++) {
      await new Promise((ok) => setTimeout(ok, 2000));
      if (await invoke<boolean>("onedrive_status").catch(() => false)) {
        clear(tip, h("div", h("b", "✓ OneDrive is running. "),
          "Give it a moment to sign in (its cloud icon in the taskbar), then press Post."));
        tip.classList.add("ok");
        onReady?.();
        return;
      }
    }
    status.textContent = "OneDrive hasn't started yet. Open it from the Start menu, then press Post.";
    button.disabled = false;
  };
  return tip;
}
