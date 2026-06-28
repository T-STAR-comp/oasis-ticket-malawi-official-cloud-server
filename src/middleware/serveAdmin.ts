import type { Express, Request, Response } from "express";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveAdminDir(): string | null {
  const dir = path.resolve(__dirname, "..", "..", "public", "admin");
  if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  return null;
}

export function registerAdminFrontend(app: Express, enabled: boolean) {
  if (!enabled) return;

  const adminDir = resolveAdminDir();
  if (!adminDir) {
    console.warn(
      "[admin] No public/admin/index.html — run: npm run build:admin (included in npm run ship)",
    );
    return;
  }

  app.use(
    "/admin",
    express.static(adminDir, {
      index: false,
      maxAge: process.env.NODE_ENV === "production" ? "1d" : 0,
    }),
  );

  app.get("/admin/*", (req: Request, res: Response) => {
    if (req.path.startsWith("/admin/assets/") || path.extname(req.path)) {
      res.status(404).end();
      return;
    }
    res.sendFile(path.join(adminDir, "index.html"));
  });

  console.log(`[admin] Admin panel at /admin/ (${adminDir})`);
}
