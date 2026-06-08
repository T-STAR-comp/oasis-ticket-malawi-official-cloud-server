import { Router } from "express";
import * as listingsService from "../services/listings.service.js";
import { ok } from "../utils/http.js";

/** Mirrors frontend /travel page */
export const travelRouter = Router();

travelRouter.get("/", async (_req, res, next) => {
  try {
    const routes = await listingsService.listPublished("travel");
    return ok(res, routes);
  } catch (err) {
    next(err);
  }
});
