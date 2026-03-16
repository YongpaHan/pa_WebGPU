import { spawn, spawnSync } from "node:child_process";

const DEFAULT_PORT = process.env.MOBILE_PORT || "5173";
const host = process.env.MOBILE_HOST || "0.0.0.0";
const viteBin = process.platform === "win32" ? "npm.cmd" : "npm";
const cloudflaredBin = process.env.CLOUDFLARED_BIN || "cloudflared";

function hasCommand(command, args = ["--version"]) {
  const result = spawnSync(command, args, {
    stdio: "ignore",
  });
  return result.status === 0;
}

function run(command, args, name) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_MOBILE_TUNNEL: "1",
    },
  });

  child.on("error", (error) => {
    console.error(`[mobile] ${name} failed to start:`, error.message);
    shutdown(1);
  });

  return child;
}

let viteProcess = null;
let tunnelProcess = null;
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  tunnelProcess?.kill("SIGTERM");
  viteProcess?.kill("SIGTERM");
  process.exit(code);
}

if (!hasCommand(cloudflaredBin)) {
  console.error(
    "[mobile] cloudflared is required. Install it first, then rerun `npm run mobile`."
  );
  console.error(
    "[mobile] macOS example: `brew install cloudflared`"
  );
  process.exit(1);
}

console.log(`[mobile] starting Vite on http://localhost:${DEFAULT_PORT}`);
viteProcess = run(
  viteBin,
  ["run", "dev", "--", "--host", host, "--port", DEFAULT_PORT, "--strictPort"],
  "vite"
);

viteProcess.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`[mobile] vite exited with code ${code ?? 0}`);
    shutdown(code ?? 0);
  }
});

setTimeout(() => {
  console.log("[mobile] starting cloudflared tunnel");
  tunnelProcess = run(
    cloudflaredBin,
    ["tunnel", "--url", `http://127.0.0.1:${DEFAULT_PORT}`],
    "cloudflared"
  );

  tunnelProcess.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`[mobile] cloudflared exited with code ${code ?? 0}`);
      shutdown(code ?? 0);
    }
  });
}, 1500);

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
