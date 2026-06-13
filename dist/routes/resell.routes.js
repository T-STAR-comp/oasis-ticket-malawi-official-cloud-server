import { Router } from "express";
import { z, ZodError } from "zod";
import * as resellService from "../services/resell.service.js";
import * as checkoutService from "../services/checkout.service.js";
import { requireAuth } from "../middleware/auth.js";
import { fail, ok } from "../utils/http.js";
import { emptyToUndefined, formatZodError, optionalUuid } from "../utils/zod-helpers.js";
import { PayChanguError } from "../services/paychangu.service.js";
export const resellRouter = Router();
resellRouter.get("/", async (_req, res, next) => {
    try {
        const listings = await resellService.listPublicResellListings();
        return ok(res, listings);
    }
    catch (err) {
        next(err);
    }
});
resellRouter.get("/orders/:orderId/status", requireAuth, async (req, res, next) => {
    try {
        const user = req.user;
        const result = await checkoutService.getOrderPaymentStatus(user.id, String(req.params.orderId));
        return ok(res, result);
    }
    catch (err) {
        if (err instanceof Error && err.message.includes("not found")) {
            return fail(res, err.message, 404);
        }
        next(err);
    }
});
resellRouter.get("/:id", async (req, res, next) => {
    try {
        const listing = await resellService.getPublicResellListing(String(req.params.id));
        if (!listing)
            return fail(res, "Resale listing not found", 404);
        return ok(res, listing);
    }
    catch (err) {
        next(err);
    }
});
resellRouter.post("/:id/checkout", requireAuth, async (req, res, next) => {
    try {
        const user = req.user;
        const body = z
            .object({
            paymentMethod: z.enum(["airtel", "tnm"]),
            paymentPhone: z.preprocess(emptyToUndefined, z.string().trim().min(8).max(32).optional()),
            paymentMethodId: optionalUuid(),
            savePaymentMethod: z.boolean().optional(),
        })
            .parse(req.body);
        const result = await resellService.initiateResellCheckout(user.id, String(req.params.id), body);
        return ok(res, result, 201);
    }
    catch (err) {
        if (err instanceof ZodError)
            return fail(res, formatZodError(err), 400);
        if (err instanceof PayChanguError) {
            return fail(res, err.message, err.status >= 400 && err.status < 500 ? err.status : 402);
        }
        if (err instanceof Error && err.message.length < 240) {
            return fail(res, err.message, 400);
        }
        next(err);
    }
});
