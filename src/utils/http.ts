import type { Response } from "express";

export function ok<T>(res: Response, data: T, status = 200) {
  return res.status(status).json({ success: true, data });
}

export function fail(res: Response, message: string, status = 400, details?: unknown) {
  return res.status(status).json({ success: false, error: message, details });
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

export function makeReference(listingId: string): string {
  const suffix = listingId.slice(0, 2).toUpperCase();
  const num = Math.floor(1000 + Math.random() * 9000);
  return `TM-${num}-${suffix}`;
}
