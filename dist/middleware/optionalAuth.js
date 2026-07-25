import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
export const optionalAuth = (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
        next();
        return;
    }
    const token = header.slice(7);
    try {
        const payload = jwt.verify(token, env.jwt.secret);
        req.user = {
            id: String(payload.sub),
            email: String(payload.email),
            fullName: String(payload.fullName ?? ""),
            role: payload.role,
        };
    }
    catch {
        // Ignore invalid token — treat as guest
    }
    next();
};
