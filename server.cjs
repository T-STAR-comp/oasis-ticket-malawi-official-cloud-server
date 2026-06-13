/**
 * CommonJS entry for cPanel, Passenger, and other hosts that require a .cjs startup file.
 * The application compiles to ESM under dist/; this file only loads env and boots it.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const entry = path.join(__dirname, "dist", "index.js");
const clientIndex = path.join(__dirname, "public", "client", "index.html");

if (!fs.existsSync(entry)) {
  console.error("[server.cjs] Missing dist/index.js");
  console.error(`[server.cjs] Expected at: ${entry}`);
  console.error("Run: npm install && npm run build:all");
  console.error("(main app folder must sit next to this cloud-server folder)");
  process.exit(1);
}

if (!fs.existsSync(clientIndex)) {
  console.warn(
    "[server.cjs] Warning: public/client/index.html missing — run npm run build:all",
  );
}

const appJs = path.join(__dirname, "dist", "app.js");
if (fs.existsSync(appJs)) {
  const built = fs.readFileSync(appJs, "utf8");
  if (!built.includes("apiVersion")) {
    console.warn(
      "[server.cjs] dist/app.js is outdated (missing apiVersion). Run: npm run build:all",
    );
  } else {
    const mtime = fs.statSync(appJs).mtime.toISOString();
    console.log(`[server.cjs] dist/app.js built ${mtime}`);
  }
} else {
  console.warn("[server.cjs] dist/app.js missing — run npm run build:all");
}

import(pathToFileURL(entry).href).catch((err) => {
  console.error("[server.cjs] Failed to start:", err);
  process.exit(1);
});
