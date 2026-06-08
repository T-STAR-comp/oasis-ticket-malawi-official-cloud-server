import { Router } from "express";
import { z } from "zod";
import * as moderationService from "../services/moderation.service.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { fail, ok } from "../utils/http.js";

export const reportsRouter = Router();

reportsRouter.get("/reasons", (_req, res) => {
  return ok(res, moderationService.REPORT_REASONS);
});

reportsRouter.use(requireAuth);

reportsRouter.post("/organizer", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const body = z
      .object({
        organizerId: z.string().min(1),
        listingId: z.string().optional(),
        reason: z.enum([
          "fraudulent_listing",
          "misleading_information",
          "no_show_or_cancellation",
          "harassment_or_abuse",
          "unsafe_or_illegal_content",
          "payment_or_refund_issue",
          "spam_or_scam",
          "poor_service",
          "other",
        ]),
        details: z.string().optional(),
      })
      .parse(req.body);

    const result = await moderationService.submitReport({
      reporterUserId: user.id,
      organizerId: body.organizerId,
      listingId: body.listingId,
      reason: body.reason,
      details: body.details,
    });
    return ok(res, result, 201);
  } catch (err) {
    if (err instanceof Error) return fail(res, err.message, 400);
    next(err);
  }
});
