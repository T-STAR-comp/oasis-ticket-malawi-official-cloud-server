import { Router } from "express";
import * as careersService from "../services/careers.service.js";
import { fail, ok } from "../utils/http.js";

export const careersRouter = Router();

careersRouter.get("/", async (_req, res, next) => {
  try {
    return ok(res, await careersService.listPublishedJobs());
  } catch (err) {
    next(err);
  }
});

careersRouter.get("/:slugOrId", async (req, res, next) => {
  try {
    const job = await careersService.getPublishedJob(req.params.slugOrId);
    if (!job) return fail(res, "Job opening not found", 404);
    return ok(res, job);
  } catch (err) {
    next(err);
  }
});
