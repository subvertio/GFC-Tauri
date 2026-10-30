// The 3D view: three.js with GLTFLoader (+ Draco, KTX2, meshopt), OrbitControls, a slow
// turntable that pauses while the user drags, neutral studio lighting and the model's
// first animation on a loop. Feed cards create one when they come near the viewport and
// dispose it (renderer, GPU memory, WebGL context) when they leave.

import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { fetchBytes } from "./api";

/** Over these, a model isn't shown (the thumbnail stays). Mid-range phone budgets. */
export const BUDGET = { bytes: 64 * 1024 * 1024, triangles: 1_500_000 };
const RESUME_TURN_MS = 4000;

let draco: DRACOLoader | null = null;
let ktx2: KTX2Loader | null = null;

function loaderFor(renderer: THREE.WebGLRenderer): GLTFLoader {
  if (!draco) {
    // three.js ships the Draco and Basis decoders and resolves them itself (bundled by Vite)
    draco = new DRACOLoader();
  }
  if (!ktx2) {
    ktx2 = new KTX2Loader();
    ktx2.detectSupport(renderer);
  }
  return new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
}

// Downloaded models are kept briefly so scrolling back doesn't refetch them.
const byteCache = new Map<string, ArrayBuffer>();
const BYTE_CACHE_MAX = 3;
async function getModelBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const hit = byteCache.get(url);
  if (hit) {
    byteCache.delete(url);
    byteCache.set(url, hit);
    return hit;
  }
  const buf = await fetchBytes(url, { signal, maxBytes: BUDGET.bytes });
  byteCache.set(url, buf);
  while (byteCache.size > BYTE_CACHE_MAX) byteCache.delete(byteCache.keys().next().value!);
  return buf;
}

export interface ModelViewOptions {
  autoRotate?: boolean;
  onStatus?: (msg: string) => void;
}

export class ModelView {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  private controls: OrbitControls;
  private mixer: THREE.AnimationMixer | null = null;
  private timer = new THREE.Timer();
  private resizeObs: ResizeObserver;
  private abort = new AbortController();
  private resumeTimer = 0;
  private frame = 0;
  private disposed = false;
  private home = { pos: new THREE.Vector3(), target: new THREE.Vector3() };

  constructor(private host: HTMLElement, private opts: ModelViewOptions = {}) {
    this.canvas = document.createElement("canvas");
    host.appendChild(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: "low-power" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(room, 0.04).texture;
    this.scene.environmentIntensity = 0.75;
    room.dispose();
    pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.35));

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.autoRotate = opts.autoRotate ?? true;
    this.controls.autoRotateSpeed = 1.2;
    // The plain wheel scrolls the feed; Ctrl + wheel zooms
    this.controls.enableZoom = false;
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("dblclick", () => this.resetView());
    this.controls.addEventListener("start", () => {
      clearTimeout(this.resumeTimer);
      this.controls.autoRotate = false;
    });
    this.controls.addEventListener("end", () => {
      clearTimeout(this.resumeTimer);
      if (opts.autoRotate ?? true) this.resumeTimer = window.setTimeout(() => (this.controls.autoRotate = true), RESUME_TURN_MS);
    });

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(host);
    this.resize();
    this.loop();
  }

  private onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    dir.multiplyScalar(e.deltaY > 0 ? 1.1 : 0.9);
    this.camera.position.copy(this.controls.target).add(dir);
  };

  async load(url: string): Promise<void> {
    this.opts.onStatus?.("Loading 3D…");
    const bytes = await getModelBytes(url, this.abort.signal);
    await this.loadBytes(bytes, url.slice(0, url.lastIndexOf("/") + 1));
  }

  async loadBytes(bytes: ArrayBuffer, base = ""): Promise<{ triangles: number; animation: string }> {
    if (this.disposed) return { triangles: 0, animation: "" };
    this.opts.onStatus?.("Preparing…");
    const gltf: GLTF = await loaderFor(this.renderer).parseAsync(bytes, base);
    if (this.disposed) {
      disposeObject(gltf.scene);
      return { triangles: 0, animation: "" };
    }
    const tris = countTriangles(gltf.scene);
    if (tris > BUDGET.triangles) {
      disposeObject(gltf.scene);
      throw new Error(`Over the triangle limit (${tris.toLocaleString()} > ${BUDGET.triangles.toLocaleString()})`);
    }
    this.scene.add(gltf.scene);
    this.frameObject(gltf.scene);
    if (gltf.animations.length) {
      this.mixer = new THREE.AnimationMixer(gltf.scene);
      this.mixer.clipAction(gltf.animations[0]).setLoop(THREE.LoopRepeat, Infinity).play();
    }
    this.opts.onStatus?.("");
    return { triangles: tris, animation: gltf.animations[0]?.name ?? "" };
  }

  /** A JPEG of the current view (the posted thumbnail is the view when Post is tapped). */
  snapshot(quality = 0.85): Promise<Blob | null> {
    this.renderer.render(this.scene, this.camera);
    return new Promise((ok) => this.canvas.toBlob(ok, "image/jpeg", quality));
  }

  private frameObject(obj: THREE.Object3D) {
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1e-3);
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.3;
    this.camera.near = dist / 100;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.home.target.copy(centre);
    this.home.pos.copy(centre).add(new THREE.Vector3(0.6, 0.35, 1).normalize().multiplyScalar(dist));
    this.resetView();
  }

  resetView() {
    this.camera.position.copy(this.home.pos);
    this.controls.target.copy(this.home.target);
    this.controls.update();
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = () => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.loop);
    if (document.hidden) return;
    this.timer.update();
    const dt = this.timer.getDelta();
    this.mixer?.update(dt);
    this.controls.update(dt);
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    cancelAnimationFrame(this.frame);
    clearTimeout(this.resumeTimer);
    this.resizeObs.disconnect();
    this.controls.dispose();
    this.mixer?.stopAllAction();
    disposeObject(this.scene);
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}

function countTriangles(obj: THREE.Object3D): number {
  let n = 0;
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    n += (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3;
  });
  return Math.round(n);
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      if (!mat) continue;
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
      mat.dispose();
    }
  });
}

// --- Lazy mounting for feed cards -------------------------------------------------

interface Slot { host: HTMLElement; url: string; view: ModelView | null; leaveTimer: number; note: HTMLElement; failed: boolean }
const slots = new Map<Element, Slot>();
const LEAVE_GRACE_MS = 1500;
/** WebGL contexts are limited (16 in Chromium); the feed keeps well under that. */
const MAX_LIVE = 4;

const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const s = slots.get(e.target);
    if (!s) continue;
    if (e.isIntersecting) {
      clearTimeout(s.leaveTimer);
      if (!s.view && !s.failed) mount(s);
    } else if (s.view) {
      clearTimeout(s.leaveTimer);
      s.leaveTimer = window.setTimeout(() => unmount(s), LEAVE_GRACE_MS);
    }
  }
}, { rootMargin: "300px 0px" });

function mount(s: Slot) {
  const live = [...slots.values()].filter((x) => x.view);
  if (live.length >= MAX_LIVE) unmount(live[0]);
  s.view = new ModelView(s.host, { onStatus: (m) => (s.note.textContent = m) });
  s.host.classList.add("live");
  s.view.load(s.url).then(
    () => s.host.querySelectorAll(":scope > img, :scope > .empty").forEach((e) => e.classList.add("hidden")),
    (err) => {
      if (err?.name === "AbortError") return;
      s.failed = true;
      s.note.textContent = String(err?.message ?? err);
      unmount(s);
    },
  );
}

function unmount(s: Slot) {
  clearTimeout(s.leaveTimer);
  s.view?.dispose();
  s.view = null;
  s.host.classList.remove("live");
  s.host.querySelectorAll(":scope > img, :scope > .empty").forEach((e) => e.classList.remove("hidden"));
}

/** Show a 3D model in `host` whenever it's near the viewport. Returns a release function. */
export function lazyModel(host: HTMLElement, url: string, note: HTMLElement): () => void {
  const s: Slot = { host, url, view: null, leaveTimer: 0, note, failed: false };
  slots.set(host, s);
  observer.observe(host);
  return () => {
    observer.unobserve(host);
    unmount(s);
    slots.delete(host);
  };
}

/** Drop every model that's no longer in the document (after a page change). */
export function sweepModels() {
  for (const [el, s] of slots) {
    if (!el.isConnected) {
      observer.unobserve(el);
      unmount(s);
      slots.delete(el);
    }
  }
}
