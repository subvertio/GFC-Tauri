// A tiny hyperscript helper: h("div.card", {onclick}, child, ...). No framework.

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { class?: string; style?: string; dataset?: Record<string, string> };

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K | `${K}.${string}` | `${K}#${string}`,
  props?: Props | Child,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const [name, ...rest] = (tag as string).split(/(?=[.#])/);
  const el = document.createElement(name) as HTMLElementTagNameMap[K];
  for (const part of rest) {
    if (part.startsWith(".")) el.classList.add(part.slice(1));
    else if (part.startsWith("#")) el.id = part.slice(1);
  }
  if (props && (typeof props !== "object" || props instanceof Node || Array.isArray(props))) {
    children.unshift(props as Child);
  } else if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className += (el.className ? " " : "") + v;
      else if (k === "style") el.setAttribute("style", String(v));
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
      else if (k in el && typeof v !== "string") (el as unknown as Record<string, unknown>)[k] = v;
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element, ...children: Child[]) {
  el.replaceChildren();
  append(el, children);
}

let toastTimer = 0;
export function toast(msg: string, error = false) {
  let t = document.getElementById("toast");
  if (!t) {
    t = h("div#toast", { role: "status" });
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.toggle("error", error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t!.hidden = true), error ? 5000 : 3000);
}

/** A modal sheet. Resolves with whatever the content calls close() with (undefined on backdrop/Escape). */
export function sheet<T = void>(build: (close: (v?: T) => void) => Node): Promise<T | undefined> {
  return new Promise((resolve) => {
    const back = h("div.sheet-backdrop");
    const done = (v?: T) => {
      back.remove();
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && done();
    back.addEventListener("mousedown", (e) => e.target === back && done());
    document.addEventListener("keydown", onKey);
    back.appendChild(h("div.sheet", { role: "dialog" }, build(done)));
    document.body.appendChild(back);
    (back.querySelector("input,textarea,button") as HTMLElement | null)?.focus();
  });
}

export function confirmSheet(title: string, body: Child, ok = "OK", danger = false): Promise<boolean> {
  return sheet<boolean>((close) =>
    h("div", h("h2", title), h("div.muted", body),
      h("div.btns",
        h("button.btn.block", { class: danger ? "danger" : "", onclick: () => close(true) }, ok),
        h("button.btn.secondary.block", { onclick: () => close(false) }, "Cancel"))),
  ).then((v) => v === true);
}

export function timeAgo(iso?: string | number | null): string {
  if (!iso) return "";
  const t = typeof iso === "number" ? (iso < 1e12 ? iso * 1000 : iso) : Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z");
  if (!isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: s > 86400 * 300 ? "numeric" : undefined });
}

export function fmtCount(n?: number): string {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, "") + "K";
  return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
}

export function fmtGfc(cents: number): string {
  return (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " GFC";
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
