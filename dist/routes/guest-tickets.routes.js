import { Router } from "express";
import { z } from "zod";
import * as guestTicketsService from "../services/guest-tickets.service.js";
import * as selfCheckinService from "../services/self-checkin.service.js";
import { fail, ok } from "../utils/http.js";
export const guestTicketsRouter = Router();
guestTicketsRouter.post("/lookup", async (req, res, next) => {
    try {
        const body = z
            .object({
            reference: z.string().min(3).max(64),
            email: z.string().email(),
        })
            .parse(req.body);
        return ok(res, await guestTicketsService.lookupGuestTicket(body.reference, body.email));
    }
    catch (err) {
        if (err instanceof z.ZodError)
            return fail(res, "Invalid lookup request", 400);
        if (err instanceof Error)
            return fail(res, err.message, 404);
        next(err);
    }
});
guestTicketsRouter.post("/pdf", async (req, res, next) => {
    try {
        const body = z
            .object({
            reference: z.string().min(3).max(64),
            email: z.string().email(),
        })
            .parse(req.body);
        const { buffer, filename } = await guestTicketsService.guestTicketPdf(body.reference, body.email);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        return res.send(buffer);
    }
    catch (err) {
        if (err instanceof z.ZodError)
            return fail(res, "Invalid request", 400);
        if (err instanceof Error)
            return fail(res, err.message, 404);
        next(err);
    }
});
guestTicketsRouter.post("/self-checkin", async (req, res, next) => {
    try {
        const body = z
            .object({
            reference: z.string().min(3).max(64),
            email: z.string().email(),
            gatePayload: z.string().min(10),
        })
            .parse(req.body);
        const ticket = await guestTicketsService.lookupGuestTicket(body.reference, body.email);
        const result = await selfCheckinService.performSelfCheckinForGuest(ticket.id, body.email, body.gatePayload);
        return ok(res, result);
    }
    catch (err) {
        if (err instanceof z.ZodError)
            return fail(res, "Invalid request", 400);
        if (err instanceof Error)
            return fail(res, err.message, 400);
        next(err);
    }
});
