import { defineConfig, type Plugin } from "vite";
import pkg from "./package.json" with { type: "json" };

// Tauri expects a fixed port and must see Rust-side errors in the terminal.
const host = process.env.TAURI_DEV_HOST;

// `npm run build:web`: the same app as a web app for iPhone (Safari → Add to Home Screen),
// served by the node at /app/web/ (GFCCoin app_webapp.py). Its extra files are in web/:
// everything there is published, so keep notes out of it.
const WEB_HEAD = `
    <link rel="manifest" href="manifest.webmanifest" />
    <link rel="icon" type="image/png" href="icons/icon-192.png" />
    <link rel="apple-touch-icon" href="icons/apple-touch-icon.png" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="GFC" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="theme-color" content="#05010f" />`;

const webAppHead = (): Plugin => ({
  name: "gfc-web-app-head",
  transformIndexHtml: (html) => html.replace("</title>", "</title>" + WEB_HEAD),
});

export default defineConfig(({ mode }) => ({
  ...(mode === "web" ? { base: "/app/web/", publicDir: "web", plugins: [webAppHead()] } : {}),
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  // The release version (bumped with tauri.conf.json and Cargo.toml), shown in the app and
  // compared with the node's published one
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    target: "es2022",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 900,
    ...(mode === "web" ? { outDir: "dist-web", emptyOutDir: true } : {}),
  },
}));
