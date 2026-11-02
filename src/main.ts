import "./styles.css";
import { mountShell, start } from "./app";
import { session } from "./session";
import { afterLogin, watchEarnings } from "./earnings";
import { startUpdateChecks } from "./update";
import "./screens/feed";
import "./screens/login";
import "./screens/detail";
import "./screens/post";
import "./screens/batch";
import "./screens/profile-edit";
import "./screens/ads";
import "./screens/connect";
import "./screens/discord";
import "./screens/wallet";

async function boot() {
  mountShell(document.getElementById("app")!);
  const restored = await session.restore();
  start(restored ? { name: "feed", src: "foryou" } : { name: "login" });
  if (restored) afterLogin();
  startUpdateChecks();
  watchEarnings();
  // The iPhone web app (npm run build:web): installable, and opens offline with the last version
  if (import.meta.env.MODE === "web" && "serviceWorker" in navigator) {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  }
}

boot();
