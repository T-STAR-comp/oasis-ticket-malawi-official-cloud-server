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

if (!fs.existsSync(entry)) {
  console.error("[server.cjs] Missing dist/index.js. Run: npm run build");
  process.exit(1);
}

import(pathToFileURL(entry).href).catch((err) => {
  console.error("[server.cjs] Failed to start:", err);
  process.exit(1);
});
