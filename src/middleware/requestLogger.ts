import type { NextFunction, Request, Response } from "express";
import { log } from "../utils/logger.js";

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const started = Date.now();
  const { method, originalUrl } = req;

  res.on("finish", () => {
    const durationMs = Date.now() - started;
    const meta = {
      method,
      path: originalUrl,
      status: res.statusCode,
      durationMs,
      ip: req.ip,
    };

    if (res.statusCode >= 500) {
      log.error("http", "Request failed", undefined, meta);
    } else if (res.statusCode >= 400) {
      log.warn("http", "Client error", meta);
    } else if (originalUrl.startsWith("/api/")) {
      log.info("http", "API request", meta);
    } else {
      log.debug("http", "Request", meta);
    }
  });

  next();
}
