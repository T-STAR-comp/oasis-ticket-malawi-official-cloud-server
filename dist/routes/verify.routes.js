import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import * as verificationService from "../services/verification.service.js";
import { fail, ok } from "../utils/http.js";
export const verifyRouter = Router();
verifyRouter.use(requireAuth);
/** GET /api/verify/assignments — listings the current user may verify (24h delegate) */
verifyRouter.get("/assignments", async (req, res, next) => {
    try {
        const user = req.user;
        const assignments = await verificationService.getVerifierAssignments(user.id);
        return ok(res, { assignments, hasAccess: assignments.length > 0 });
    }
    catch (err) {
        next(err);
    }
});
/** POST /api/verify/by-reference */
verifyRouter.post("/by-reference", async (req, res, next) => {
    try {
        const user = req.user;
        const body = z
            .object({
            reference: z.string().min(4),
            listingId: z.string().optional(),
            seatNumber: z.number().int().positive().optional(),
        })
            .parse(req.body);
        const result = await verificationService.verifyByReference({
            userId: user.id,
            userRole: user.role,
            reference: body.reference,
            listingId: body.listingId,
            seatNumber: body.seatNumber,
        });
        return ok(res, result);
    }
    catch (err) {
        if (err instanceof Error && err.message.length < 240) {
            return fail(res, err.message, 400);
        }
        next(err);
    }
});
/** POST /api/verify/by-qr */
verifyRouter.post("/by-qr", async (req, res, next) => {
    try {
        const user = req.user;
        const body = z
            .object({
            listingId: z.string().optional(),
            payload: z
                .object({
                ref: z.string(),
                token: z.string(),
                id: z.string().uuid(),
            })
                .optional(),
            raw: z.string().optional(),
        })
            .parse(req.body);
        const result = body.raw
            ? await verificationService.parseAndVerifyQrRaw({
                userId: user.id,
                userRole: user.role,
                listingId: body.listingId,
                raw: body.raw,
            })
            : await verificationService.verifyByQr({
                userId: user.id,
                userRole: user.role,
                listingId: body.listingId,
                payload: body.payload,
            });
        return ok(res, result);
    }
    catch (err) {
        if (err instanceof Error && err.message.length < 240) {
            return fail(res, err.message, 400);
        }
        next(err);
    }
});
