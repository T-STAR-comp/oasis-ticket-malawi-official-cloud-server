import { Router } from "express";
import * as dashboardService from "../services/dashboard.service.js";
import { getVirtualTransferLockState } from "../utils/virtual-events.js";
import * as resellService from "../services/resell.service.js";
import * as resellerPayoutService from "../services/reseller-payout.service.js";
import * as paymentMethodsService from "../services/payment-methods.service.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { fail, ok } from "../utils/http.js";
import { z } from "zod";

export const dashboardRouter = Router();

dashboardRouter.use(requireAuth);

/** GET /api/dashboard/tickets — active tickets (My Tickets tab) */
dashboardRouter.get("/tickets", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const tickets = await dashboardService.getUserTickets(user.id, "active");
    return ok(res, tickets);
  } catch (err) {
    next(err);
  }
});

/** GET /api/dashboard/history — past tickets + spending */
dashboardRouter.get("/history", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const [history, summary] = await Promise.all([
      dashboardService.getUserTickets(user.id),
      dashboardService.getSpendingSummary(user.id),
    ]);
    const past = history.filter((t) => t.status !== "active");
    return ok(res, { history: past, summary });
  } catch (err) {
    next(err);
  }
});

/** GET /api/dashboard/tickets/:id — ticket detail modal */
dashboardRouter.get("/tickets/:id", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const detail = await dashboardService.getUserTicketDetail(user.id, req.params.id);
    if (!detail) return fail(res, "Ticket not found", 404);
    return ok(res, detail);
  } catch (err) {
    next(err);
  }
});

/** GET /api/dashboard/tickets/:id/share/recipient — lookup customer by email */
dashboardRouter.get("/tickets/:id/share/recipient", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const email = z.string().email().parse(req.query.email);
    const detail = await dashboardService.getUserTicketDetail(user.id, req.params.id);
    if (!detail) return fail(res, "Ticket not found", 404);
    if (detail.purchase.refundPending) {
      return fail(
        res,
        "This ticket has a refund in progress. Sharing is disabled until the refund completes.",
        400,
      );
    }
    if (detail.purchase.resellListing) {
      return fail(
        res,
        "This ticket is listed for resale. Cancel the listing before sharing.",
        400,
      );
    }
    const transferLock = getVirtualTransferLockState({
      eventFormat: detail.listing.eventFormat,
      eventStartsOn: detail.listing.eventStartsOn,
      timeLabel: detail.listing.time,
    });
    if (transferLock.locked) {
      return fail(res, transferLock.message, 400);
    }
    const recipient = await dashboardService.lookupShareRecipient(user.id, email);
    return ok(res, recipient);
  } catch (err) {
    if (err instanceof Error && err.message.length < 240) {
      const status = err.message.includes("not found") ? 404 : 400;
      return fail(res, err.message, status);
    }
    next(err);
  }
});

/** POST /api/dashboard/tickets/:id/share — transfer ticket ownership */
dashboardRouter.post("/tickets/:id/share", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const { recipientEmail } = z.object({ recipientEmail: z.string().email() }).parse(req.body);
    const result = await dashboardService.shareTicket(user.id, req.params.id, recipientEmail);
    return ok(res, result, 201);
  } catch (err) {
    if (err instanceof Error && err.message.length < 240) {
      const status =
        err.message.includes("not found") || err.message.includes("no longer active")
          ? 404
          : 400;
      return fail(res, err.message, status);
    }
    next(err);
  }
});

/** GET /api/dashboard/payment-methods */
dashboardRouter.get("/payment-methods", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const methods = await paymentMethodsService.listPaymentMethods(user.id, true);
    return ok(res, methods);
  } catch (err) {
    next(err);
  }
});

dashboardRouter.post("/payment-methods", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const body = z
      .object({
        type: z.enum(["airtel", "tnm"]),
        phone: z.string().min(9),
        label: z.string().optional(),
        isDefault: z.boolean().optional(),
      })
      .parse(req.body);
    const method = await paymentMethodsService.addPaymentMethod(user.id, body);
    return ok(res, method, 201);
  } catch (err) {
    if (err instanceof Error && err.message.length < 240) return fail(res, err.message, 400);
    next(err);
  }
});

dashboardRouter.delete("/payment-methods/:id", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    await paymentMethodsService.removePaymentMethod(user.id, req.params.id);
    return ok(res, { deleted: true });
  } catch (err) {
    if (err instanceof Error && err.message.length < 240) return fail(res, err.message, 404);
    next(err);
  }
});

dashboardRouter.patch("/payment-methods/:id/default", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const method = await paymentMethodsService.setDefaultPaymentMethod(user.id, req.params.id);
    return ok(res, method);
  } catch (err) {
    if (err instanceof Error && err.message.length < 240) return fail(res, err.message, 404);
    next(err);
  }
});

/** POST /api/dashboard/tickets/:id/resell — list ticket for resale */
dashboardRouter.post("/tickets/:id/resell", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const { priceMwk } = z.object({ priceMwk: z.number().int().min(500) }).parse(req.body);
    const listing = await resellService.createResellListing(user.id, req.params.id, priceMwk);
    return ok(res, listing, 201);
  } catch (err) {
    if (err instanceof Error && err.message.length < 240) return fail(res, err.message, 400);
    next(err);
  }
});

dashboardRouter.delete("/resell/:resellId", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    await resellService.cancelResellListing(user.id, req.params.resellId);
    return ok(res, { cancelled: true });
  } catch (err) {
    if (err instanceof Error && err.message.length < 240) return fail(res, err.message, 400);
    next(err);
  }
});

dashboardRouter.get("/resell/finance", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const finance = await resellService.getSellerResellFinance(user.id);
    return ok(res, finance);
  } catch (err) {
    next(err);
  }
});

dashboardRouter.get("/resell/payouts/banks", async (_req, res, next) => {
  try {
    const banks = await resellerPayoutService.listAvailableBanks();
    return ok(res, banks);
  } catch (err) {
    next(err);
  }
});

dashboardRouter.post("/resell/payouts/initiate", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
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
    const result = await resellerPayoutService.initiateResellerPayoutVerification(user.id, body);
    return ok(res, result, 201);
  } catch (err) {
    if (err instanceof z.ZodError) return fail(res, "Invalid payout request", 400);
    if (err instanceof Error) return fail(res, err.message, 400);
    next(err);
  }
});

dashboardRouter.post("/resell/payouts/confirm", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const body = z
      .object({
        verificationId: z.string().uuid(),
        code: z.string().min(6).max(6),
      })
      .parse(req.body);
    const result = await resellerPayoutService.confirmResellerPayoutVerification(
      user.id,
      body.verificationId,
      body.code,
    );
    return ok(res, result);
  } catch (err) {
    if (err instanceof z.ZodError) return fail(res, "Invalid confirmation", 400);
    if (err instanceof Error) return fail(res, err.message, 400);
    next(err);
  }
});
