// three.js is most of the app's JavaScript, so it loads on first use (the first 3D post
// near the viewport), not at startup.

type Viewer = typeof import("./viewer3d");
let mod: Promise<Viewer> | null = null;

export const load3d = (): Promise<Viewer> => (mod ??= import("./viewer3d"));

export function lazyModel(host: HTMLElement, url: string, note: HTMLElement): () => void {
  let release: (() => void) | null = null;
  let cancelled = false;
  load3d().then((m) => {
    if (!cancelled) release = m.lazyModel(host, url, note);
  });
  return () => {
    cancelled = true;
    release?.();
  };
}

export function sweepModels() {
  mod?.then((m) => m.sweepModels());
}
