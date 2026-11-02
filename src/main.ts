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
}

boot();
