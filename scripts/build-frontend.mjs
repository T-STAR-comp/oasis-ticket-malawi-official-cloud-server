import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, "..");
const parent = path.resolve(serverRoot, "..");

const candidates = [
  process.env.FRONTEND_APP_DIR,
  path.join(parent, "ticket-malawi-app"),
  path.join(parent, "oasis-ticket-malawi-official-main-app"),
].filter(Boolean);

const appDir = candidates.find((dir) =>
  fs.existsSync(path.join(dir, "package.json")),
);

if (!appDir) {
  console.error(
    "[build-frontend] Main app not found next to cloud-server.",
  );
  console.error(
    "Expected ticket-malawi-app or oasis-ticket-malawi-official-main-app as a sibling folder.",
  );
  console.error("Or set FRONTEND_APP_DIR to the app path.");
  process.exit(1);
}

console.log(`[build-frontend] Building ${appDir}`);
const nodeOptions = [process.env.NODE_OPTIONS, "--max-old-space-size=8192"]
  .filter(Boolean)
  .join(" ");
execSync("npm run build", {
  cwd: appDir,
  stdio: "inherit",
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
});
