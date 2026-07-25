import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import type { AuthedRequest } from "./auth.js";
import type { UserRole } from "../types/index.js";

export const optionalAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    next();
    return;
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, env.jwt.secret) as jwt.JwtPayload;
    (req as AuthedRequest).user = {
      id: String(payload.sub),
      email: String(payload.email),
      fullName: String(payload.fullName ?? ""),
      role: payload.role as UserRole,
    };
  } catch {
    // Ignore invalid token — treat as guest
  }
  next();
};
