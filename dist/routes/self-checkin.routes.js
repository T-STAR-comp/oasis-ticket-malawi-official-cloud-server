import { Router } from "express";
import { z } from "zod";
import * as selfCheckinService from "../services/self-checkin.service.js";
import { requireAuth } from "../middleware/auth.js";
import { fail, ok } from "../utils/http.js";
export const selfCheckinRouter = Router();
selfCheckinRouter.use(requireAuth);
selfCheckinRouter.post("/activate", async (req, res, next) => {
    try {
        const user = req.user;
        const { listingId } = z.object({ listingId: z.string().min(1) }).parse(req.body);
        const session = await selfCheckinService.activateSelfCheckin(user.id, listingId);
        return ok(res, session, 201);
    }
    catch (err) {
        if (err instanceof Error && err.message.length < 240)
            return fail(res, err.message, 400);
        next(err);
    }
});
selfCheckinRouter.post("/end", async (req, res, next) => {
    try {
        const user = req.user;
        const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(req.body);
        await selfCheckinService.endSelfCheckin(user.id, sessionId);
        return ok(res, { ended: true });
    }
    catch (err) {
        if (err instanceof Error && err.message.length < 240)
            return fail(res, err.message, 400);
        next(err);
    }
});
selfCheckinRouter.get("/listing/:listingId/active", async (req, res, next) => {
    try {
        const session = await selfCheckinService.getActiveSelfCheckinForListing(req.params.listingId);
        return ok(res, session ?? { active: false });
    }
    catch (err) {
        next(err);
    }
});
selfCheckinRouter.get("/sessions/:sessionId/logs", async (req, res, next) => {
    try {
        const user = req.user;
        const since = typeof req.query.since === "string" ? req.query.since : undefined;
        const logs = await selfCheckinService.getSelfCheckinLogs(user.id, req.params.sessionId, since);
        return ok(res, { logs });
    }
    catch (err) {
        if (err instanceof Error && err.message.length < 240)
            return fail(res, err.message, 403);
        next(err);
    }
});
selfCheckinRouter.post("/scan", async (req, res, next) => {
    try {
        const user = req.user;
        const body = z
            .object({
            userTicketId: z.string().uuid(),
            gatePayload: z.string().min(10),
        })
            .parse(req.body);
        const result = await selfCheckinService.performSelfCheckin(user.id, body.userTicketId, body.gatePayload);
        return ok(res, result);
    }
    catch (err) {
        if (err instanceof Error && err.message.length < 240)
            return fail(res, err.message, 400);
        next(err);
    }
});
