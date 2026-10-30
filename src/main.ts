import "./styles.css";
import { mountShell, start } from "./app";
import { session } from "./session";
import { afterLogin } from "./earnings";
import "./screens/feed";
import "./screens/login";
import "./screens/detail";
import "./screens/post";
import "./screens/wallet";

async function boot() {
  mountShell(document.getElementById("app")!);
  const restored = await session.restore();
  start(restored ? { name: "feed", src: "foryou" } : { name: "login" });
  if (restored) afterLogin();
}

boot();
