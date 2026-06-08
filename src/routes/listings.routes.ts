import { Router } from "express";
import * as listingsService from "../services/listings.service.js";
import { fail, ok } from "../utils/http.js";

export const listingsRouter = Router();

/** GET /api/listings — home featured + browse */
listingsRouter.get("/", async (req, res, next) => {
  try {
    const kind = req.query.kind as "event" | "travel" | undefined;
    const listings = await listingsService.listPublished(kind);
    return ok(res, listings);
  } catch (err) {
    next(err);
  }
});

/** GET /api/listings/:id — ticket detail page */
listingsRouter.get("/:id", async (req, res, next) => {
  try {
    const listing = await listingsService.getListingById(req.params.id);
    if (!listing) return fail(res, "Listing not found", 404);
    return ok(res, listing);
  } catch (err) {
    next(err);
  }
});
