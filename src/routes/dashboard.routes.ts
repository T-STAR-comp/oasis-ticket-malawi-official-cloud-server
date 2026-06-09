import { Router } from "express";
import * as dashboardService from "../services/dashboard.service.js";
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
    if (detail.purchase.refund_pending) {
      return fail(
        res,
        "This ticket has a refund in progress. Sharing is disabled until the refund completes.",
        400,
      );
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
    const methods = await dashboardService.getPaymentMethods(user.id);
    return ok(res, methods);
  } catch (err) {
    next(err);
  }
});
