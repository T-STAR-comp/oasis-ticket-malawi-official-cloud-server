import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, "..");
const parent = path.resolve(serverRoot, "..");

const candidates = [
  process.env.ADMIN_APP_DIR,
  path.join(parent, "ticket-malawi-admin-app"),
].filter(Boolean);

const appDir = candidates.find((dir) => fs.existsSync(path.join(dir, "package.json")));

if (!appDir) {
  console.error("[build-admin] Admin app not found next to cloud-server.");
  console.error("Expected ticket-malawi-admin-app as a sibling folder.");
  process.exit(1);
}

const outDir = path.join(serverRoot, "public", "admin");
console.log(`[build-admin] Building ${appDir} → public/admin/`);

execSync("npm run build", {
  cwd: appDir,
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_API_URL: "",
    VITE_BASE: "/admin/",
  },
});

const adminDist = path.join(appDir, "dist");
if (!fs.existsSync(path.join(adminDist, "index.html"))) {
  console.error("[build-admin] Build did not produce dist/index.html");
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.cpSync(adminDist, outDir, { recursive: true });
console.log("[build-admin] Copied admin SPA to public/admin/");
