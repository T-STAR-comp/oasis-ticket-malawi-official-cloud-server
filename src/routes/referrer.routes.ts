import { Router } from "express";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { getReferrerEarningsLines, getReferrerFinance } from "../services/referrer-finance.service.js";
import * as referrerPayoutService from "../services/referrer-payout.service.js";
import { fail, ok } from "../utils/http.js";

export const referrerRouter = Router();

referrerRouter.use(requireAuth);

referrerRouter.get("/finance", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const finance = await getReferrerFinance(user.id);
    const earnings = await getReferrerEarningsLines(user.id);
    const payouts = await referrerPayoutService.listReferrerPayouts(user.id);
    const payoutDestination = await referrerPayoutService.getReferrerPayoutDestination(user.id);
    return ok(res, { finance, earnings, payouts, payoutDestination });
  } catch (err) {
    next(err);
  }
});

referrerRouter.get("/payouts/banks", async (_req, res, next) => {
  try {
    const banks = await referrerPayoutService.listAvailableBanks();
    return ok(res, banks);
  } catch (err) {
    next(err);
  }
});

referrerRouter.post("/payouts/initiate", async (req, res, next) => {
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
    const result = await referrerPayoutService.initiateReferrerPayoutVerification(user.id, body);
    return ok(res, result, 201);
  } catch (err) {
    if (err instanceof z.ZodError) return fail(res, "Invalid payout request", 400);
    if (err instanceof Error) return fail(res, err.message, 400);
    next(err);
  }
});

referrerRouter.post("/payouts/confirm", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const body = z
      .object({
        verificationId: z.string().uuid(),
        code: z.string().min(6).max(6),
      })
      .parse(req.body);
    const result = await referrerPayoutService.confirmReferrerPayoutVerification(
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
