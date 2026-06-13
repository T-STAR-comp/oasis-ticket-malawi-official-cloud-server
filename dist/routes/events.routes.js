import { Router } from "express";
import * as listingsService from "../services/listings.service.js";
import { ok } from "../utils/http.js";
/** Mirrors frontend /events page */
export const eventsRouter = Router();
eventsRouter.get("/", async (req, res, next) => {
    try {
        const city = typeof req.query.city === "string" ? req.query.city.trim() : "";
        const events = city
            ? await listingsService.listEventsInCity(city)
            : await listingsService.listPublished("event");
        return ok(res, events);
    }
    catch (err) {
        next(err);
    }
});
