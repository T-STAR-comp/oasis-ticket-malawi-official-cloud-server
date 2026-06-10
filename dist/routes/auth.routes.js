import { Router } from "express";
import { z } from "zod";
import * as authService from "../services/auth.service.js";
import { signToken, requireAuth } from "../middleware/auth.js";
import { fail, ok } from "../utils/http.js";
const signUpSchema = z.object({
    fullName: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(8),
    phone: z.string().optional(),
    acceptedTerms: z.literal(true, {
        errorMap: () => ({ message: "You must accept the Terms of Service and Privacy Policy" }),
    }),
});
const signInSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
});
export const authRouter = Router();
authRouter.post("/signup", async (req, res, next) => {
    try {
        const body = signUpSchema.parse(req.body);
        const result = await authService.signUp(body);
        return ok(res, { user: result, requiresVerification: true }, 201);
    }
    catch (err) {
        next(err);
    }
});
authRouter.post("/verify-email", async (req, res, next) => {
    try {
        const { email, code } = z
            .object({ email: z.string().email(), code: z.string().length(6) })
            .parse(req.body);
        const result = await authService.verifyEmail(email, code);
        if ("alreadyVerified" in result && result.alreadyVerified) {
            return ok(res, { message: "Email already verified" });
        }
        const token = signToken(result.user);
        return ok(res, { user: result.user, token });
    }
    catch (err) {
        if (err instanceof Error && err.message.includes("verification code")) {
            return fail(res, err.message, 400);
        }
        next(err);
    }
});
authRouter.post("/resend-verification", async (req, res, next) => {
    try {
        const { email } = z.object({ email: z.string().email() }).parse(req.body);
        await authService.resendVerification(email);
        return ok(res, { sent: true });
    }
    catch (err) {
        if (err instanceof Error)
            return fail(res, err.message, 400);
        next(err);
    }
});
authRouter.post("/signin", async (req, res, next) => {
    try {
        const body = signInSchema.parse(req.body);
        const result = await authService.initiateSignIn(body.email, body.password);
        if (!result)
            return fail(res, "Invalid email or password", 401);
        return ok(res, result);
    }
    catch (err) {
        if (err instanceof Error) {
            if (err.message === "Email not verified")
                return fail(res, err.message, 403);
            if (err.message === "Account suspended")
                return fail(res, err.message, 403);
            if (err.message === "Account inactive")
                return fail(res, err.message, 403);
        }
        if (err instanceof Error && err.message.includes("Data truncated")) {
            return fail(res, "Login security codes are not enabled on the database yet. Run: npm run db:migrate:tiers", 503);
        }
        next(err);
    }
});
authRouter.post("/signin/verify", async (req, res, next) => {
    try {
        const { email, code } = z
            .object({ email: z.string().email(), code: z.string().length(6) })
            .parse(req.body);
        const user = await authService.confirmSignIn(email, code);
        if (!user)
            return fail(res, "Invalid email or security code", 401);
        const token = signToken(user);
        return ok(res, { user, token });
    }
    catch (err) {
        if (err instanceof Error) {
            if (err.message.includes("security code"))
                return fail(res, err.message, 400);
            if (err.message === "Account suspended")
                return fail(res, err.message, 403);
            if (err.message === "Account inactive")
                return fail(res, err.message, 403);
        }
        next(err);
    }
});
authRouter.post("/magic-link", (_req, res) => {
    return fail(res, "Magic link sign-in is not enabled yet", 501);
});
authRouter.get("/me", requireAuth, async (req, res, next) => {
    try {
        const user = req.user;
        const profile = await authService.getProfile(user.id);
        return ok(res, { user, profile });
    }
    catch (err) {
        next(err);
    }
});
authRouter.patch("/me", requireAuth, async (req, res, next) => {
    try {
        const user = req.user;
        const profile = await authService.updateProfile(user.id, req.body);
        return ok(res, profile);
    }
    catch (err) {
        next(err);
    }
});
authRouter.post("/change-password/initiate", requireAuth, async (req, res, next) => {
    try {
        const user = req.user;
        const body = z
            .object({ currentPassword: z.string().min(1), newPassword: z.string().min(8) })
            .parse(req.body);
        const result = await authService.initiatePasswordChange(user.id, body.currentPassword, body.newPassword);
        return ok(res, result);
    }
    catch (err) {
        if (err instanceof Error && err.message === "Current password is incorrect") {
            return fail(res, err.message, 400);
        }
        next(err);
    }
});
authRouter.post("/change-password/confirm", requireAuth, async (req, res, next) => {
    try {
        const user = req.user;
        const body = z
            .object({
            requestId: z.string().uuid(),
            code: z.string().length(6),
        })
            .parse(req.body);
        const result = await authService.confirmPasswordChange(user.id, body.requestId, body.code);
        return ok(res, result);
    }
    catch (err) {
        if (err instanceof Error && err.message.includes("verification code")) {
            return fail(res, err.message, 400);
        }
        next(err);
    }
});
