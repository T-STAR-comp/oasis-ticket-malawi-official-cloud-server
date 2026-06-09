import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IMAGE_BUCKET_URL_PREFIX } from "../config/images.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
function resolveFrontendDir() {
    const candidates = [
        path.resolve(__dirname, "..", "..", "public", "client"),
        path.resolve(__dirname, "..", "..", "public"),
    ];
    for (const dir of candidates) {
        if (fs.existsSync(path.join(dir, "index.html"))) {
            return dir;
        }
    }
    return null;
}
function findStylesheets(frontendDir) {
    const assetsDir = path.join(frontendDir, "assets");
    if (!fs.existsSync(assetsDir))
        return [];
    return fs
        .readdirSync(assetsDir)
        .filter((name) => name.endsWith(".css"))
        .map((name) => `/assets/${name}`);
}
function verifyFrontendAssets(frontendDir) {
    const cssFiles = findStylesheets(frontendDir);
    if (cssFiles.length === 0) {
        console.warn("[frontend] No CSS bundle found under public/client/assets. Run: npm run build:frontend");
        return;
    }
    console.log(`[frontend] CSS bundles: ${cssFiles.join(", ")}`);
}
function shouldServeSpaShell(req) {
    if (req.method !== "GET" && req.method !== "HEAD")
        return false;
    const p = req.path;
    if (p.startsWith("/api"))
        return false;
    if (p.startsWith(IMAGE_BUCKET_URL_PREFIX))
        return false;
    // Let express.static handle real files (hashed assets, icons, manifest).
    if (path.extname(p))
        return false;
    return true;
}
export function registerFrontend(app, enabled) {
    if (!enabled)
        return;
    const frontendDir = resolveFrontendDir();
    if (!frontendDir) {
        console.warn("[frontend] SERVE_FRONTEND is enabled but no index.html was found. Run: npm run build:frontend");
        return;
    }
    verifyFrontendAssets(frontendDir);
    app.use(express.static(frontendDir, {
        index: false,
        maxAge: process.env.NODE_ENV === "production" ? "1d" : 0,
        dotfiles: "ignore",
        setHeaders(res, filePath) {
            if (filePath.endsWith(".css")) {
                res.setHeader("Content-Type", "text/css; charset=utf-8");
            }
            if (filePath.endsWith(".js")) {
                res.setHeader("Content-Type", "application/javascript; charset=utf-8");
            }
        },
    }));
    app.get("*", (req, res, next) => {
        if (!shouldServeSpaShell(req))
            return next();
        res.sendFile(path.join(frontendDir, "index.html"));
    });
    console.log(`[frontend] Serving React SPA from ${frontendDir}`);
}
