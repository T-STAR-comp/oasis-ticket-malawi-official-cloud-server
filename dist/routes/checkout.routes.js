import { Router } from "express";
import { z } from "zod";
import * as checkoutService from "../services/checkout.service.js";
import { getListingById } from "../services/listings.service.js";
import * as queueService from "../services/queue.service.js";
import { PayChanguError } from "../services/paychangu.service.js";
import { optionalAuth } from "../middleware/optionalAuth.js";
import { features } from "../config/features.js";
import * as referralService from "../services/referral.service.js";
import { fail, ok } from "../utils/http.js";
import { log } from "../utils/logger.js";
import { emptyToUndefined, formatZodError, optionalTierId, optionalUuid, } from "../utils/zod-helpers.js";
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
    contactName: z.preprocess(emptyToUndefined, z.string().trim().min(2).max(120).optional()),
    contactEmail: z.preprocess(emptyToUndefined, z.string().trim().email().optional()),
    contactPhone: z.preprocess(emptyToUndefined, z.string().trim().min(8).max(32).optional()),
    nationalId: z.preprocess(emptyToUndefined, z.string().trim().max(32).optional()),
    guestKey: z.preprocess(emptyToUndefined, z.string().trim().min(8).max(64).optional()),
});
const accessQuerySchema = z.object({
    qty: z.coerce.number().int().min(1).max(20).default(1),
    seats: z.string().optional(),
    guestKey: z.preprocess(emptyToUndefined, z.string().trim().min(8).max(64).optional()),
});
export const checkoutRouter = Router();
const pricingQuerySchema = z.object({
    qty: z.coerce.number().int().min(1).max(20).default(1),
    seats: z.string().optional(),
    tierId: optionalTierId(),
    referralCode: z.preprocess(emptyToUndefined, z.string().trim().min(2).max(64).optional()),
    virtualSessions: z.string().optional(),
});
function checkoutError(err, res, next) {
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
        if (err.message.includes("not available for purchase"))
            return fail(res, err.message, 409);
        if (err.message.includes("already claimed free tickets"))
            return fail(res, err.message, 409);
        if (err.message.includes("required") || err.message.includes("not enabled")) {
            return fail(res, err.message, 400);
        }
        if (err.message.includes("PayChangu"))
            return fail(res, err.message, 402);
    }
    next(err);
}
checkoutRouter.get("/:listingId/pricing", async (req, res, next) => {
    try {
        const listingId = String(req.params.listingId);
        const query = pricingQuerySchema.parse(req.query);
        const seatNumbers = query.seats
            ? query.seats.split(",").map((s) => Number(s.trim())).filter((n) => n > 0)
            : undefined;
        const virtualSessionIds = query.virtualSessions
            ? query.virtualSessions.split(",").filter(Boolean)
            : undefined;
        const pricing = await checkoutService.previewListingCheckoutPricing(listingId, {
            qty: query.qty,
            seatNumbers,
            tierId: query.tierId,
            referralCode: query.referralCode,
            virtualSessionIds,
        });
        return ok(res, pricing);
    }
    catch (err) {
        if (err instanceof z.ZodError)
            return fail(res, "Invalid pricing request", 400);
        if (err instanceof Error && err.message.includes("not found")) {
            return fail(res, err.message, 404);
        }
        next(err);
    }
});
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
checkoutRouter.get("/:listingId/access", optionalAuth, async (req, res, next) => {
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
        const participant = user
            ? { userId: user.id }
            : query.guestKey
                ? { guestKey: query.guestKey }
                : null;
        if (!participant) {
            return fail(res, "Sign in or provide a guest session key for queue access.", 401);
        }
        const access = await queueService.getCheckoutAccess(listingId, participant, qty, seatNumbers, listing.kind, listing.ticketCapacity ?? null);
        return ok(res, access);
    }
    catch (err) {
        if (err instanceof z.ZodError)
            return fail(res, "Invalid access request", 400);
        next(err);
    }
});
checkoutRouter.get("/queue/:queueId", optionalAuth, async (req, res, next) => {
    try {
        const user = req.user;
        const guestKey = typeof req.query.guestKey === "string" ? req.query.guestKey.trim() : "";
        const participant = user ? { userId: user.id } : guestKey ? { guestKey } : null;
        if (!participant)
            return fail(res, "Authentication or guest key required", 401);
        const result = await queueService.pollQueueStatus(String(req.params.queueId), participant);
        return ok(res, result);
    }
    catch (err) {
        if (err instanceof Error && err.message.includes("not found")) {
            return fail(res, err.message, 404);
        }
        next(err);
    }
});
async function requirePaymentsUnlessFreeListing(req, res, next) {
    if (features.payments)
        return next();
    try {
        const listingId = String(req.params.listingId);
        const parsed = checkoutSchema.safeParse(req.body);
        if (!parsed.success)
            return next();
        const seatNumbers = parsed.data.seatNumbers;
        const isFree = await checkoutService.isFreeListingCheckout(listingId, {
            qty: parsed.data.qty,
            seatNumbers,
            tierId: parsed.data.tierId,
            referralCode: parsed.data.referralCode,
            virtualSessionIds: parsed.data.virtualSessionIds,
        });
        if (isFree)
            return next();
    }
    catch {
        return next();
    }
    return fail(res, "Checkout and payments are temporarily unavailable.", 503);
}
checkoutRouter.post("/:listingId", requirePaymentsUnlessFreeListing, optionalAuth, async (req, res, next) => {
    try {
        const user = req.user;
        const body = checkoutSchema.parse(req.body);
        const listingId = String(req.params.listingId);
        if (body.guestKey && features.guestCheckout) {
            const result = await checkoutService.initiateGuestCheckout(listingId, body, body.guestKey);
            log.info("checkout", "Guest checkout payment initiated", {
                listingId,
                orderId: result.orderId,
                ledgerId: result.ledgerId,
                reference: result.reference,
            });
            return ok(res, result, 201);
        }
        if (user) {
            const result = await checkoutService.initiateCheckout(user.id, listingId, body);
            return ok(res, result, 201);
        }
        if (!features.guestCheckout) {
            return fail(res, "Sign in to purchase tickets.", 401);
        }
        return fail(res, "Guest session key is required.", 400);
    }
    catch (err) {
        checkoutError(err, res, next);
    }
});
checkoutRouter.get("/orders/:orderId/status", optionalAuth, async (req, res, next) => {
    try {
        const user = req.user;
        const orderId = String(req.params.orderId);
        const guestToken = typeof req.query.token === "string" ? req.query.token.trim() : "";
        if (guestToken) {
            const result = await checkoutService.getOrderPaymentStatus(orderId, {
                guestAccessToken: guestToken,
            });
            return ok(res, result);
        }
        if (user) {
            const result = await checkoutService.getOrderPaymentStatus(orderId, { userId: user.id });
            return ok(res, result);
        }
        return fail(res, "Sign in or provide guest access token.", 401);
    }
    catch (err) {
        if (err instanceof Error && err.message.includes("not found")) {
            return fail(res, err.message, 404);
        }
        next(err);
    }
});
export { guestTicketsRouter } from "./guest-tickets.routes.js";
