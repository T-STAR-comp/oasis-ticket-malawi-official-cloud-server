import { Router } from "express";
import { z } from "zod";
import * as checkoutService from "../services/checkout.service.js";
import { getListingById } from "../services/listings.service.js";
import * as queueService from "../services/queue.service.js";
import { PayChanguError } from "../services/paychangu.service.js";
import { requireAuth } from "../middleware/auth.js";
import * as referralService from "../services/referral.service.js";
import { fail, ok } from "../utils/http.js";
import { emptyToUndefined, formatZodError, optionalTierId, optionalUuid, } from "../utils/zod-helpers.js";
/** Checkout body — contact details come from the signed-in user's profile server-side. */
const checkoutSchema = z.object({
    qty: z.coerce.number().int().min(1).max(20).default(1),
    seatNumbers: z
        .array(z.coerce.number().int().positive())
        .optional()
        .transform((nums) => (nums && nums.length > 0 ? nums : undefined)),
    tierId: optionalTierId(),
    paymentMethod: z.enum(["airtel", "tnm", "card"]),
    paymentPhone: z.preprocess(emptyToUndefined, z.string().trim().min(8).max(32).optional()),
    paymentMethodId: optionalUuid(),
    savePaymentMethod: z.boolean().optional(),
    queueId: optionalUuid(),
    referralCode: z.preprocess(emptyToUndefined, z.string().trim().min(2).max(64).optional()),
    virtualSessionIds: z
        .array(z.string().uuid())
        .optional()
        .transform((ids) => (ids && ids.length > 0 ? ids : undefined)),
});
const accessQuerySchema = z.object({
    qty: z.coerce.number().int().min(1).max(20).default(1),
    seats: z.string().optional(),
});
export const checkoutRouter = Router();
/** GET /api/checkout/:listingId/referral — validate referral code */
checkoutRouter.get("/:listingId/referral", async (req, res, next) => {
    try {
        const listingId = String(req.params.listingId);
        const code = String(req.query.code ?? "").trim();
        const hasActive = await referralService.listingHasActiveReferrals(listingId);
        if (!code)
            return ok(res, { hasActiveReferrals: hasActive, valid: false });
        const referral = await referralService.resolveActiveReferral(listingId, code);
        if (!referral)
            return ok(res, { hasActiveReferrals: hasActive, valid: false });
        return ok(res, {
            hasActiveReferrals: hasActive,
            valid: true,
            code: referral.code,
            name: referral.name,
            type: referral.type,
            cutPercent: referral.cutPercent,
        });
    }
    catch (err) {
        next(err);
    }
});
/** GET /api/checkout/:listingId/access — queue position / direct checkout access */
checkoutRouter.get("/:listingId/access", requireAuth, async (req, res, next) => {
    try {
        const user = req.user;
        const query = accessQuerySchema.parse(req.query);
        const listingId = String(req.params.listingId);
        const listing = await getListingById(listingId, true);
        if (!listing)
            return fail(res, "Listing not found", 404);
        const seatNumbers = query.seats
            ? query.seats.split(",").map((s) => Number(s.trim())).filter((n) => n > 0)
            : undefined;
        const qty = seatNumbers && seatNumbers.length > 0 ? seatNumbers.length : query.qty;
        const access = await queueService.getCheckoutAccess(listingId, user.id, qty, seatNumbers, listing.kind, listing.ticketCapacity ?? null);
        return ok(res, access);
    }
    catch (err) {
        if (err instanceof z.ZodError)
            return fail(res, "Invalid access request", 400);
        next(err);
    }
});
/** GET /api/checkout/queue/:queueId — poll queue position */
checkoutRouter.get("/queue/:queueId", requireAuth, async (req, res, next) => {
    try {
        const user = req.user;
        const result = await queueService.pollQueueStatus(String(req.params.queueId), user.id);
        return ok(res, result);
    }
    catch (err) {
        if (err instanceof Error && err.message.includes("not found")) {
            return fail(res, err.message, 404);
        }
        next(err);
    }
});
/** POST /api/checkout/:listingId — initiate PayChangu payment (ledger pending) */
checkoutRouter.post("/:listingId", requireAuth, async (req, res, next) => {
    try {
        const user = req.user;
        const body = checkoutSchema.parse(req.body);
        const listingId = String(req.params.listingId);
        const result = await checkoutService.initiateCheckout(user.id, listingId, body);
        return ok(res, result, 201);
    }
    catch (err) {
        if (err instanceof z.ZodError)
            return fail(res, formatZodError(err), 400);
        if (err instanceof PayChanguError) {
            return fail(res, err.message, err.status >= 400 && err.status < 500 ? err.status : 402);
        }
        if (err instanceof Error) {
            if (err.message.includes("not available"))
                return fail(res, err.message, 409);
            if (err.message.includes("payment in progress"))
                return fail(res, err.message, 409);
            if (err.message.includes("sold out") || err.message.includes("remaining")) {
                return fail(res, err.message, 409);
            }
            if (err.message.includes("queue") || err.message.includes("High demand")) {
                return fail(res, err.message, 409);
            }
            if (err.message.includes("not available for purchase")) {
                return fail(res, err.message, 409);
            }
            if (err.message.includes("required") || err.message.includes("not enabled")) {
                return fail(res, err.message, 400);
            }
            if (err.message.includes("PayChangu"))
                return fail(res, err.message, 402);
        }
        next(err);
    }
});
/** GET /api/checkout/orders/:orderId/status — poll payment + ticket generation */
checkoutRouter.get("/orders/:orderId/status", requireAuth, async (req, res, next) => {
    try {
        const user = req.user;
        const orderId = String(req.params.orderId);
        const result = await checkoutService.getOrderPaymentStatus(user.id, orderId);
        return ok(res, result);
    }
    catch (err) {
        if (err instanceof Error && err.message.includes("not found")) {
            return fail(res, err.message, 404);
        }
        next(err);
    }
});
