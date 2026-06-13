import type { Express, Request, Response, NextFunction } from "express";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IMAGE_BUCKET_URL_PREFIX } from "../config/images.js";
import {
  buildSeoSnapshot,
  injectSeoIntoHtml,
  seoPageForPath,
} from "../utils/seo-snapshot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveFrontendDir(): string | null {
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

function findStylesheets(frontendDir: string): string[] {
  const assetsDir = path.join(frontendDir, "assets");
  if (!fs.existsSync(assetsDir)) return [];
  return fs
    .readdirSync(assetsDir)
    .filter((name) => name.endsWith(".css"))
    .map((name) => `/assets/${name}`);
}

function verifyFrontendAssets(frontendDir: string): void {
  const cssFiles = findStylesheets(frontendDir);
  if (cssFiles.length === 0) {
    console.warn(
      "[frontend] No CSS bundle found under public/client/assets. Run: npm run build:frontend",
    );
    return;
  }
  console.log(`[frontend] CSS bundles: ${cssFiles.join(", ")}`);
}

function shouldServeSpaShell(req: Request): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const p = req.path;
  if (p.startsWith("/api")) return false;
  if (p.startsWith(IMAGE_BUCKET_URL_PREFIX)) return false;
  // Let express.static handle real files (hashed assets, icons, manifest).
  if (path.extname(p)) return false;
  return true;
}

export function registerFrontend(app: Express, enabled: boolean) {
  if (!enabled) return;

  const frontendDir = resolveFrontendDir();
  if (!frontendDir) {
    console.warn(
      "[frontend] SERVE_FRONTEND is enabled but no index.html was found. Run: npm run build:frontend",
    );
    return;
  }

  verifyFrontendAssets(frontendDir);

  app.use(
    express.static(frontendDir, {
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
    }),
  );

  app.get("*", async (req: Request, res: Response, next: NextFunction) => {
    if (!shouldServeSpaShell(req)) return next();

    const seoPage = seoPageForPath(req.path);
    if (!seoPage) {
      res.sendFile(path.join(frontendDir, "index.html"));
      return;
    }

    try {
      const template = fs.readFileSync(path.join(frontendDir, "index.html"), "utf8");
      const snapshot = await buildSeoSnapshot(seoPage);
      const html = injectSeoIntoHtml(template, snapshot);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (err) {
      console.warn("[frontend] SEO snapshot failed, serving plain SPA shell:", err);
      res.sendFile(path.join(frontendDir, "index.html"));
    }
  });

  console.log(`[frontend] Serving React SPA from ${frontendDir}`);
}
