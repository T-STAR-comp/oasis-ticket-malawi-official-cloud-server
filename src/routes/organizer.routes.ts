import { Router } from "express";
import { z } from "zod";
import * as financeService from "../services/finance.service.js";
import * as payoutService from "../services/payout.service.js";
import * as organizerService from "../services/organizer.service.js";
import * as listingsService from "../services/listings.service.js";
import * as verificationService from "../services/verification.service.js";
import * as moderationService from "../services/moderation.service.js";
import { listingImageUpload } from "../middleware/listing-image-upload.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import {
  assertUploadRateLimit,
  processAndStoreListingImage,
} from "../services/image-upload.service.js";
import * as referralService from "../services/referral.service.js";
import { fail, ok } from "../utils/http.js";
import type { NextFunction, Response } from "express";

function forwardListingMutationError(err: unknown, res: Response, next: NextFunction) {
  if (!(err instanceof Error)) return next(err);
  const message = err.message;
  if (message.includes("organizer account") || message.includes("suspended")) {
    return fail(res, message, 403);
  }
  if (message === "Listing not found") {
    return fail(res, message, 404);
  }
  return fail(res, message, 400);
}

export const organizerRouter = Router();

organizerRouter.use(requireAuth, requireRole("organizer", "admin"));

organizerRouter.get("/account-status", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const status = await moderationService.getOrganizerModerationState(user.id);
    return ok(res, status);
  } catch (err) {
    next(err);
  }
});

organizerRouter.post("/appeal", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const body = z
      .object({
        reason: z.string().min(30),
        appealType: z.enum(["suspension", "ban"]).optional(),
      })
      .parse(req.body);
    const result = await moderationService.submitAppeal(
      user.id,
      body.reason,
      body.appealType ?? "suspension",
    );
    return ok(res, result, 201);
  } catch (err) {
    if (err instanceof Error) return fail(res, err.message, 400);
    next(err);
  }
});

organizerRouter.get("/overview", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const overview = await organizerService.getOverview(user.id);
    return ok(res, overview);
  } catch (err) {
    next(err);
  }
});

organizerRouter.post("/uploads/listing-image", (req, res, next) => {
  listingImageUpload(req, res, async (err) => {
    if (err) {
      const message =
        err instanceof Error
          ? err.message.includes("File too large")
            ? "Image must be 2 MB or smaller"
            : err.message
          : "Upload failed";
      return fail(res, message, 400);
    }
    try {
      const user = (req as AuthedRequest).user!;
      if (!req.file?.buffer) {
        return fail(res, "No image file provided", 400);
      }
      assertUploadRateLimit(user.id);
      const result = await processAndStoreListingImage(
        user.id,
        req.file.buffer,
        req.file.mimetype,
      );
      return ok(res, result, 201);
    } catch (uploadErr) {
      if (uploadErr instanceof Error && uploadErr.message.length < 240) {
        return fail(res, uploadErr.message, 400);
      }
      next(uploadErr);
    }
  });
});

organizerRouter.get("/listings", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const listings = await listingsService.getOrganizerListings(user.id);
    return ok(res, listings);
  } catch (err) {
    next(err);
  }
});

organizerRouter.post("/listings", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const listing = await listingsService.upsertListing(user.id, req.body);
    return ok(res, listing, 201);
  } catch (err) {
    forwardListingMutationError(err, res, next);
  }
});

organizerRouter.get("/listings/:id", async (req, res, next) => {
  try {
    const listing = await listingsService.getListingById(req.params.id, true);
    if (!listing) return fail(res, "Listing not found", 404);
    return ok(res, listing);
  } catch (err) {
    next(err);
  }
});

organizerRouter.patch("/listings/:id", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const listing = await listingsService.upsertListing(user.id, {
      ...req.body,
      id: req.params.id,
    });
    return ok(res, listing);
  } catch (err) {
    forwardListingMutationError(err, res, next);
  }
});

organizerRouter.patch("/listings/:id/status", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const body = z
      .object({
        status: z.enum(["published", "draft", "postponed", "cancelled", "sold_out"]),
        eventStartsOn: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        date: z.string().min(1).optional(),
        time: z.string().min(1).optional(),
      })
      .parse(req.body);

    if (body.status === "postponed") {
      if (!body.eventStartsOn) {
        return fail(res, "New event date is required when postponing a listing", 400);
      }
      const result = await listingsService.postponeListing(req.params.id, user.id, {
        eventStartsOn: body.eventStartsOn,
        dateLabel: body.date,
        timeLabel: body.time,
      });
      if (!result) return fail(res, "Listing not found", 404);
      return ok(res, result);
    }

    if (body.status === "cancelled") {
      const result = await listingsService.cancelListing(req.params.id, user.id);
      if (!result) return fail(res, "Listing not found", 404);
      return ok(res, result);
    }

    const updated = await listingsService.updateListingStatus(
      req.params.id,
      user.id,
      body.status,
    );
    if (!updated) return fail(res, "Listing not found", 404);
    return ok(res, { status: body.status });
  } catch (err) {
    if (err instanceof Error && err.message.length < 240) {
      return fail(res, err.message, 400);
    }
    next(err);
  }
});

organizerRouter.put("/listings/:id/seats", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const owned = await listingsService.listingBelongsToOrganizer(req.params.id, user.id);
    if (!owned) return fail(res, "Listing not found", 404);
    await listingsService.saveSeatLayout(req.params.id, req.body);
    const updated = await listingsService.getListingById(req.params.id, true);
    return ok(res, updated);
  } catch (err) {
    next(err);
  }
});

organizerRouter.patch("/listings/:id/seats/:seatNumber", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const seatNumber = Number(req.params.seatNumber);
    if (!Number.isFinite(seatNumber) || seatNumber <= 0) {
      return fail(res, "Invalid seat number", 400);
    }
    const { status } = z
      .object({ status: z.enum(["available", "unavailable"]) })
      .parse(req.body);
    const listing = await listingsService.updateSeatStatus(
      req.params.id,
      user.id,
      seatNumber,
      status,
    );
    return ok(res, listing);
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === "Listing not found") return fail(res, err.message, 404);
      if (err.message.includes("Sold seats") || err.message.includes("travel")) {
        return fail(res, err.message, 400);
      }
      if (err.message === "Seat not found") return fail(res, err.message, 404);
    }
    next(err);
  }
});

organizerRouter.get("/finance", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    return ok(res, await financeService.getOrganizerFinance(user.id));
  } catch (err) {
    next(err);
  }
});

organizerRouter.get("/payouts/banks", async (_req, res, next) => {
  try {
    return ok(res, await payoutService.listAvailableBanks());
  } catch (err) {
    next(err);
  }
});

organizerRouter.get("/payouts", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    return ok(res, await payoutService.listOrganizerPayouts(user.id));
  } catch (err) {
    next(err);
  }
});

organizerRouter.post("/payouts/initiate", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const body = z
      .object({
        amount: z.number().int().positive(),
        bankUuid: z.string().uuid(),
        bankName: z.string().min(2),
        accountName: z.string().min(2),
        accountNumber: z.string().min(3),
        verificationEmail: z.string().email(),
        branch: z.string().optional(),
      })
      .parse(req.body);
    const result = await payoutService.initiatePayoutVerification(user.id, body);
    return ok(res, result, 201);
  } catch (err) {
    if (err instanceof Error && err.message.length < 240) {
      return fail(res, err.message, 400);
    }
    next(err);
  }
});

organizerRouter.post("/payouts/confirm", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const body = z
      .object({
        verificationId: z.string().uuid(),
        code: z.string().length(6),
      })
      .parse(req.body);
    const result = await payoutService.confirmPayoutVerification(
      user.id,
      body.verificationId,
      body.code,
    );
    return ok(res, result);
  } catch (err) {
    if (err instanceof Error && err.message.length < 240) {
      return fail(res, err.message, 400);
    }
    next(err);
  }
});

organizerRouter.delete("/listings/:id", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const deleted = await listingsService.deleteListing(req.params.id, user.id);
    if (!deleted) return fail(res, "Listing not found", 404);
    return ok(res, { deleted: true });
  } catch (err) {
    if (err instanceof Error && err.message.includes("cannot be deleted")) {
      return fail(res, err.message, 409);
    }
    next(err);
  }
});

organizerRouter.get("/buyers", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const buyers = await organizerService.getBuyers(user.id);
    return ok(res, buyers);
  } catch (err) {
    next(err);
  }
});

organizerRouter.get("/profile", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const profile = await organizerService.getOrganizerProfile(user.id);
    return ok(res, profile);
  } catch (err) {
    next(err);
  }
});

organizerRouter.patch("/profile", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const profile = await organizerService.updateOrganizerProfile(user.id, req.body);
    return ok(res, profile);
  } catch (err) {
    next(err);
  }
});

organizerRouter.get("/verify/users", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const email = z.string().min(3).parse(req.query.email ?? "");
    const users = await verificationService.searchVerifierCandidates(user.id, email);
    return ok(res, users);
  } catch (err) {
    if (err instanceof z.ZodError) return fail(res, "Enter at least 3 characters to search", 400);
    next(err);
  }
});

organizerRouter.get("/verify/assignments", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const listingId = typeof req.query.listingId === "string" ? req.query.listingId : undefined;
    const assignments = await verificationService.listOrganizerAssignments(user.id, listingId);
    return ok(res, assignments);
  } catch (err) {
    next(err);
  }
});

organizerRouter.delete("/verify/assignments/:assignmentId", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const result = await verificationService.revokeVerifierAssignment(
      user.id,
      req.params.assignmentId,
    );
    return ok(res, result);
  } catch (err) {
    if (err instanceof Error && err.message.length < 240) {
      return fail(res, err.message, 400);
    }
    next(err);
  }
});

organizerRouter.post("/verify/assignments", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const body = z
      .object({
        listingId: z.string().min(1),
        verifierEmail: z.string().email(),
      })
      .parse(req.body);
    const assignment = await verificationService.assignListingVerifier(
      user.id,
      body.listingId,
      body.verifierEmail,
    );
    return ok(res, assignment, 201);
  } catch (err) {
    if (err instanceof Error && err.message.length < 240) {
      return fail(res, err.message, 400);
    }
    next(err);
  }
});

organizerRouter.post("/verify/by-reference", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const body = z
      .object({
        reference: z.string().min(4),
        listingId: z.string().optional(),
        seatNumber: z.number().int().positive().optional(),
      })
      .parse(req.body);
    const result = await verificationService.verifyByReference({
      userId: user.id,
      userRole: user.role,
      reference: body.reference,
      listingId: body.listingId,
      seatNumber: body.seatNumber,
    });
    return ok(res, result);
  } catch (err) {
    if (err instanceof Error && err.message.length < 240) {
      return fail(res, err.message, 400);
    }
    next(err);
  }
});

organizerRouter.post("/verify/by-qr", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const body = z
      .object({
        listingId: z.string().optional(),
        payload: z
          .object({
            ref: z.string(),
            token: z.string(),
            id: z.string().uuid(),
          })
          .optional(),
        raw: z.string().optional(),
      })
      .parse(req.body);

    const result = body.raw
      ? await verificationService.parseAndVerifyQrRaw({
          userId: user.id,
          userRole: user.role,
          listingId: body.listingId,
          raw: body.raw,
        })
      : await verificationService.verifyByQr({
          userId: user.id,
          userRole: user.role,
          listingId: body.listingId,
          payload: body.payload!,
        });
    return ok(res, result);
  } catch (err) {
    if (err instanceof Error && err.message.length < 240) {
      return fail(res, err.message, 400);
    }
    next(err);
  }
});

organizerRouter.get("/referrals", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const referrals = await referralService.listOrganizerReferrals(user.id);
    const origin = `${req.protocol}://${req.get("host")}`;
    return ok(
      res,
      referrals.map((r) => ({
        ...r,
        link: referralService.buildReferralLink(r.listingId, r.code, origin),
      })),
    );
  } catch (err) {
    next(err);
  }
});

organizerRouter.get("/referrals/users/search", async (req, res, next) => {
  try {
    const email = String(req.query.email ?? "").trim();
    if (!email || !email.includes("@")) return ok(res, null);
    const found = await referralService.searchReferrerByEmail(email);
    return ok(res, found);
  } catch (err) {
    next(err);
  }
});

organizerRouter.post("/referrals", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const body = z
      .object({
        listingId: z.string().min(1),
        name: z.string().min(2).max(64),
        type: z.enum(["split_both", "split_referrer", "discount_only"]),
        cutPercent: z.number().int().min(1).max(50),
        referrerUserId: z.string().uuid().optional(),
      })
      .parse(req.body);
    const referral = await referralService.createReferral(user.id, body);
    const origin = `${req.protocol}://${req.get("host")}`;
    return ok(
      res,
      { ...referral, link: referralService.buildReferralLink(referral.listingId, referral.code, origin) },
      201,
    );
  } catch (err) {
    if (err instanceof z.ZodError) return fail(res, "Invalid referral data", 400);
    if (err instanceof Error) return fail(res, err.message, 400);
    next(err);
  }
});

organizerRouter.patch("/referrals/:id/status", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const body = z.object({ status: z.enum(["active", "inactive"]) }).parse(req.body);
    const referral = await referralService.setReferralStatus(
      user.id,
      String(req.params.id),
      body.status,
    );
    return ok(res, referral);
  } catch (err) {
    if (err instanceof Error) return fail(res, err.message, 400);
    next(err);
  }
});

organizerRouter.delete("/referrals/:id", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user!;
    const result = await referralService.deleteReferral(user.id, String(req.params.id));
    return ok(res, result);
  } catch (err) {
    if (err instanceof Error) return fail(res, err.message, 400);
    next(err);
  }
});
