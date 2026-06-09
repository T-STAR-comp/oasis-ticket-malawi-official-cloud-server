import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
export function signToken(user) {
    return jwt.sign({ sub: user.id, email: user.email, role: user.role, fullName: user.fullName }, env.jwt.secret, { expiresIn: env.jwt.expiresIn });
}
export function requireAuth(req, _res, next) {
    try {
        const header = req.headers.authorization;
        if (!header?.startsWith("Bearer "))
            throw new Error("Unauthorized");
        const token = header.slice(7);
        const payload = jwt.verify(token, env.jwt.secret);
        req.user = {
            id: String(payload.sub),
            email: String(payload.email),
            fullName: String(payload.fullName),
            role: payload.role,
        };
        next();
    }
    catch {
        next(new Error("Unauthorized"));
    }
}
export function requireRole(...roles) {
    return (req, _res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            next(new Error("Forbidden"));
            return;
        }
        next();
    };
}
