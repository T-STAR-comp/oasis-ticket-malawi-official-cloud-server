import { Router } from "express";
import * as listingsService from "../services/listings.service.js";
import { ok } from "../utils/http.js";

/** Mirrors frontend /events page */
export const eventsRouter = Router();

eventsRouter.get("/", async (_req, res, next) => {
  try {
    const events = await listingsService.listPublished("event");
    return ok(res, events);
  } catch (err) {
    next(err);
  }
});
