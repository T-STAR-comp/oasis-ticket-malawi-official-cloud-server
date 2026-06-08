import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import type { AuthUser, UserRole } from "../types/index.js";

export type AuthedRequest = Request & { user?: AuthUser };

export function signToken(user: AuthUser): string {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, fullName: user.fullName },
    env.jwt.secret,
    { expiresIn: env.jwt.expiresIn as jwt.SignOptions["expiresIn"] },
  );
}

export function requireAuth(req: AuthedRequest, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new Error("Unauthorized");
    const token = header.slice(7);
    const payload = jwt.verify(token, env.jwt.secret) as jwt.JwtPayload;
    req.user = {
      id: String(payload.sub),
      email: String(payload.email),
      fullName: String(payload.fullName),
      role: payload.role as UserRole,
    };
    next();
  } catch {
    next(new Error("Unauthorized"));
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthedRequest, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      next(new Error("Forbidden"));
      return;
    }
    next();
  };
}
