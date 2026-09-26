// Convenience preview without cloud credentials. Data is ephemeral and loopback-only.
import { spawn } from "node:child_process";
const env = {
  ...process.env,
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54329",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "local-test-publishable-key",
  SUPABASE_SECRET_KEY: "local-test-server-secret-key",
  CRON_SECRET: "local-test-cron-secret-at-least-32-characters",
};
const children = [];
function start(args) {
  const p = spawn(process.execPath, args, {
    stdio: "inherit",
    env,
    windowsHide: true,
  });
  children.push(p);
  p.on("exit", (code) => {
    if (code) stop(code);
  });
  return p;
}
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
start(["scripts/test-server.mjs"]);
let path;
for (let i = 0; i < 100; i++) {
  try {
    const r = await fetch("http://127.0.0.1:54329/test/book");
    if (r.ok) {
      path = (await r.json()).path;
      break;
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!path) {
  stop(1);
  throw new Error("Local database did not start");
}
start(["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1"]);
console.log("\n本機預覽：資料只供測試，停止後清空，無法分享給群組。");
console.log(`http://127.0.0.1:3000${path}\n`);
