import { Router } from "express";
import { z } from "zod";
import * as partnerService from "../services/partner.service.js";
import { ok } from "../utils/http.js";

const applicationSchema = z.object({
  partnerType: z.enum(["events", "travel", "both"]),
  companyName: z.string().min(2),
  tradingName: z.string().optional(),
  registrationNumber: z.string().min(2),
  yearEstablished: z.number().int().min(1900).max(2100),
  companyDescription: z.string().min(10),
  contactName: z.string().min(2),
  jobTitle: z.string().min(2),
  contactEmail: z.string().email(),
  contactPhone: z.string().min(8),
  city: z.string().min(2),
  region: z.string().min(2),
  physicalAddress: z.string().min(5),
  monthlyVolume: z.string().min(1),
  website: z.string().url().optional().or(z.literal("")),
  eventTypes: z.string().optional(),
  fleetInfo: z.string().optional(),
  paymentMethods: z.string().min(2),
  settlementPreference: z.string().min(2),
  bankName: z.string().optional(),
  accountName: z.string().optional(),
  accountNumber: z.string().optional(),
  branch: z.string().optional(),
  additionalNotes: z.string().optional(),
  acceptedTerms: z.literal(true, {
    errorMap: () => ({ message: "You must accept the Terms of Service and Privacy Policy" }),
  }),
});

/** POST /api/partner-applications — become-organizer form */
export const partnerRouter = Router();

partnerRouter.post("/", async (req, res, next) => {
  try {
    const body = applicationSchema.parse(req.body);
    const result = await partnerService.submitPartnerApplication(body);
    return ok(res, result, 201);
  } catch (err) {
    next(err);
  }
});
