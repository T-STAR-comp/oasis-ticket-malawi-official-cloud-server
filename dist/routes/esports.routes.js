import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { fail, ok } from "../utils/http.js";
import { getEsportsDashboard, getEsportsPublicVisibility, getEsportsRegistrationStatus, getPublicEsportsEvent, listPublicEsportsEvents, registerForEsportsEvent, } from "../services/esports.service.js";
import { confirmEsportsPayoutVerification, initiateEsportsPayoutVerification, listAvailableBanks, } from "../services/esports-payout.service.js";
export const esportsRouter = Router();
esportsRouter.get("/visibility", async (_req, res, next) => {
    try {
        return ok(res, await getEsportsPublicVisibility());
    }
    catch (err) {
        next(err);
    }
});
esportsRouter.get("/events", async (_req, res, next) => {
    try {
        return ok(res, await listPublicEsportsEvents());
    }
    catch (err) {
        next(err);
    }
});
esportsRouter.get("/events/:id", async (req, res, next) => {
    try {
        const event = await getPublicEsportsEvent(req.params.id);
        if (!event)
            return fail(res, "Tournament not found", 404);
        return ok(res, event);
    }
    catch (err) {
        next(err);
    }
});
esportsRouter.use(requireAuth);
esportsRouter.get("/me", async (req, res, next) => {
    try {
        const user = req.user;
        return ok(res, await getEsportsDashboard(user.id));
    }
    catch (err) {
        next(err);
    }
});
esportsRouter.post("/events/:id/register", async (req, res, next) => {
    try {
        const user = req.user;
        const body = z
            .object({
            gameUsername: z.string().min(2).max(128),
            paymentMethod: z.enum(["airtel", "tnm", "card"]),
            phone: z.string().optional(),
        })
            .parse(req.body);
        const result = await registerForEsportsEvent(user.id, req.params.id, body);
        return ok(res, result, result.paymentStatus === "completed" ? 201 : 202);
    }
    catch (err) {
        if (err instanceof z.ZodError)
            return fail(res, "Invalid registration request", 400);
        if (err instanceof Error)
            return fail(res, err.message, 400);
        next(err);
    }
});
esportsRouter.get("/registrations/:id/status", async (req, res, next) => {
    try {
        const user = req.user;
        const status = await getEsportsRegistrationStatus(user.id, req.params.id);
        if (!status)
            return fail(res, "Registration not found", 404);
        return ok(res, status);
    }
    catch (err) {
        next(err);
    }
});
esportsRouter.get("/payouts/banks", async (_req, res, next) => {
    try {
        return ok(res, await listAvailableBanks());
    }
    catch (err) {
        next(err);
    }
});
esportsRouter.post("/payouts/initiate", async (req, res, next) => {
    try {
        const user = req.user;
        const body = z
            .object({
            amount: z.number().int().positive(),
            bankUuid: z.string().min(1),
            bankName: z.string().min(1),
            accountName: z.string().min(2),
            accountNumber: z.string().min(4),
            verificationEmail: z.string().email(),
            branch: z.string().optional(),
        })
            .parse(req.body);
        const result = await initiateEsportsPayoutVerification(user.id, body);
        return ok(res, result, 201);
    }
    catch (err) {
        if (err instanceof z.ZodError)
            return fail(res, "Invalid payout request", 400);
        if (err instanceof Error)
            return fail(res, err.message, 400);
        next(err);
    }
});
esportsRouter.post("/payouts/confirm", async (req, res, next) => {
    try {
        const user = req.user;
        const body = z
            .object({
            verificationId: z.string().uuid(),
            code: z.string().min(6).max(6),
        })
            .parse(req.body);
        const result = await confirmEsportsPayoutVerification(user.id, body.verificationId, body.code);
        return ok(res, result);
    }
    catch (err) {
        if (err instanceof z.ZodError)
            return fail(res, "Invalid confirmation", 400);
        if (err instanceof Error)
            return fail(res, err.message, 400);
        next(err);
    }
});
