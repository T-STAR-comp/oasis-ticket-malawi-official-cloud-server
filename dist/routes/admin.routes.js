import { Router } from "express";
import { z } from "zod";
import * as adminService from "../services/admin.service.js";
import * as adminStatisticsService from "../services/admin-statistics.service.js";
import * as moderationService from "../services/moderation.service.js";
import * as financeService from "../services/finance.service.js";
import * as careersService from "../services/careers.service.js";
import { requireAuth, requireRole, signToken } from "../middleware/auth.js";
import { fail, ok } from "../utils/http.js";
export const adminRouter = Router();
adminRouter.post("/auth/signin", async (req, res, next) => {
    try {
        const { username, password } = z
            .object({ username: z.string().min(1), password: z.string().min(1) })
            .parse(req.body);
        const user = await adminService.adminSignIn(username, password);
        if (!user)
            return fail(res, "Invalid admin credentials", 401);
        const token = signToken(user);
        return ok(res, { user, token });
    }
    catch (err) {
        next(err);
    }
});
adminRouter.use(requireAuth, requireRole("admin"));
adminRouter.get("/auth/me", async (req, res) => {
    return ok(res, { user: req.user });
});
adminRouter.post("/auth/change-password", async (req, res, next) => {
    try {
        const user = req.user;
        const body = z
            .object({ currentPassword: z.string().min(1), newPassword: z.string().min(8) })
            .parse(req.body);
        const result = await adminService.changeAdminPassword(user.id, body.currentPassword, body.newPassword);
        return ok(res, result);
    }
    catch (err) {
        if (err instanceof Error && err.message === "Current password is incorrect") {
            return fail(res, err.message, 400);
        }
        next(err);
    }
});
adminRouter.get("/finance", async (_req, res, next) => {
    try {
        return ok(res, await financeService.getAdminFinance());
    }
    catch (err) {
        next(err);
    }
});
adminRouter.get("/stats", async (_req, res, next) => {
    try {
        return ok(res, await adminService.getDashboardStats());
    }
    catch (err) {
        next(err);
    }
});
adminRouter.get("/statistics", async (_req, res, next) => {
    try {
        return ok(res, await adminStatisticsService.getAdminStatistics());
    }
    catch (err) {
        next(err);
    }
});
adminRouter.get("/reports", async (_req, res, next) => {
    try {
        return ok(res, await moderationService.listReportsForAdmin());
    }
    catch (err) {
        next(err);
    }
});
adminRouter.get("/flags", async (_req, res, next) => {
    try {
        return ok(res, await moderationService.listFlagsForAdmin());
    }
    catch (err) {
        next(err);
    }
});
adminRouter.post("/flags/:id/remove", async (req, res, next) => {
    try {
        const admin = req.user;
        const { adminNotes } = z.object({ adminNotes: z.string().optional() }).parse(req.body ?? {});
        return ok(res, await moderationService.removeFlag(req.params.id, admin.id, adminNotes));
    }
    catch (err) {
        if (err instanceof Error)
            return fail(res, err.message, 404);
        next(err);
    }
});
adminRouter.get("/appeals", async (req, res, next) => {
    try {
        const status = req.query.status;
        return ok(res, await moderationService.listAppealsForAdmin(status));
    }
    catch (err) {
        next(err);
    }
});
adminRouter.post("/appeals/:id/review", async (req, res, next) => {
    try {
        const admin = req.user;
        const body = z
            .object({
            decision: z.enum(["approved", "rejected"]),
            adminNotes: z.string().optional(),
        })
            .parse(req.body);
        return ok(res, await moderationService.reviewAppeal(req.params.id, admin.id, body.decision, body.adminNotes));
    }
    catch (err) {
        if (err instanceof Error)
            return fail(res, err.message, 400);
        next(err);
    }
});
adminRouter.post("/organizers/:userId/ban", async (req, res, next) => {
    try {
        const admin = req.user;
        const { adminNotes } = z.object({ adminNotes: z.string().optional() }).parse(req.body ?? {});
        return ok(res, await moderationService.permanentBanOrganizer(req.params.userId, admin.id, adminNotes));
    }
    catch (err) {
        if (err instanceof Error)
            return fail(res, err.message, 400);
        next(err);
    }
});
adminRouter.get("/users", async (_req, res, next) => {
    try {
        return ok(res, await adminService.listUsers());
    }
    catch (err) {
        next(err);
    }
});
adminRouter.patch("/users/:id/status", async (req, res, next) => {
    try {
        const { status } = z
            .object({ status: z.enum(["active", "suspended", "inactive"]) })
            .parse(req.body);
        const result = await adminService.updateUserStatus(req.params.id, status);
        return ok(res, result);
    }
    catch (err) {
        if (err instanceof Error && err.message === "User not found") {
            return fail(res, err.message, 404);
        }
        next(err);
    }
});
adminRouter.get("/organizers", async (_req, res, next) => {
    try {
        return ok(res, await adminService.listOrganizers());
    }
    catch (err) {
        next(err);
    }
});
adminRouter.patch("/organizers/:userId/status", async (req, res, next) => {
    try {
        const admin = req.user;
        const { status, adminNotes } = z
            .object({
            status: z.enum(["pending", "approved", "inactive", "suspended", "banned"]),
            adminNotes: z.string().optional(),
        })
            .parse(req.body);
        if (status === "banned") {
            const result = await moderationService.permanentBanOrganizer(req.params.userId, admin.id, adminNotes);
            return ok(res, result);
        }
        const result = await adminService.updateOrganizerStatus(req.params.userId, status);
        return ok(res, result);
    }
    catch (err) {
        if (err instanceof Error && err.message === "Organizer not found") {
            return fail(res, err.message, 404);
        }
        next(err);
    }
});
adminRouter.get("/partner-applications", async (req, res, next) => {
    try {
        const status = req.query.status;
        return ok(res, await adminService.listPartnerApplications(status));
    }
    catch (err) {
        next(err);
    }
});
adminRouter.get("/partner-applications/:id", async (req, res, next) => {
    try {
        const app = await adminService.getPartnerApplication(req.params.id);
        if (!app)
            return fail(res, "Application not found", 404);
        return ok(res, app);
    }
    catch (err) {
        next(err);
    }
});
const applicationFieldSchema = z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    type: z.enum(["text", "email", "tel", "url", "textarea"]).optional(),
    required: z.boolean().optional(),
    placeholder: z.string().optional(),
});
const jobPostBodySchema = z.object({
    title: z.string().min(2),
    description: z.string().min(10),
    applyEmail: z.string().email(),
    department: z.string().optional(),
    location: z.string().optional(),
    employmentType: z.enum(["full_time", "part_time", "contract", "internship", "other"]).optional(),
    requirements: z.string().optional(),
    benefits: z.string().optional(),
    applicationFields: z.array(applicationFieldSchema).optional(),
    status: z.enum(["draft", "published", "closed"]).optional(),
    closesAt: z.string().nullable().optional(),
});
adminRouter.get("/job-posts", async (_req, res, next) => {
    try {
        return ok(res, await careersService.listAllJobs());
    }
    catch (err) {
        next(err);
    }
});
adminRouter.get("/job-posts/:id", async (req, res, next) => {
    try {
        const job = await careersService.getJob(req.params.id);
        if (!job)
            return fail(res, "Job post not found", 404);
        return ok(res, job);
    }
    catch (err) {
        next(err);
    }
});
function normalizeApplicationFields(fields) {
    return fields?.map((f) => ({
        id: f.id,
        label: f.label,
        type: f.type ?? "text",
        required: f.required ?? false,
        placeholder: f.placeholder,
    }));
}
function normalizeJobBody(body) {
    return {
        ...body,
        applicationFields: normalizeApplicationFields(body.applicationFields),
    };
}
function normalizePartialJobBody(body) {
    return {
        ...body,
        applicationFields: normalizeApplicationFields(body.applicationFields),
    };
}
adminRouter.post("/job-posts", async (req, res, next) => {
    try {
        const admin = req.user;
        const body = normalizeJobBody(jobPostBodySchema.parse(req.body));
        const job = await careersService.createJob(admin.id, body);
        return ok(res, job, 201);
    }
    catch (err) {
        if (err instanceof z.ZodError)
            return fail(res, "Invalid job post", 400);
        next(err);
    }
});
adminRouter.patch("/job-posts/:id", async (req, res, next) => {
    try {
        const body = normalizePartialJobBody(jobPostBodySchema.partial().parse(req.body));
        const job = await careersService.updateJob(req.params.id, body);
        return ok(res, job);
    }
    catch (err) {
        if (err instanceof z.ZodError)
            return fail(res, "Invalid job post", 400);
        if (err instanceof Error && err.message === "Job post not found") {
            return fail(res, err.message, 404);
        }
        next(err);
    }
});
adminRouter.delete("/job-posts/:id", async (req, res, next) => {
    try {
        const result = await careersService.deleteJob(req.params.id);
        return ok(res, result);
    }
    catch (err) {
        if (err instanceof Error && err.message === "Job post not found") {
            return fail(res, err.message, 404);
        }
        next(err);
    }
});
adminRouter.post("/partner-applications/:id/review", async (req, res, next) => {
    try {
        const admin = req.user;
        const body = z
            .object({
            decision: z.enum(["approved", "rejected"]),
            adminNotes: z.string().optional(),
        })
            .parse(req.body);
        const result = await adminService.reviewPartnerApplication(req.params.id, admin.id, body.decision, body.adminNotes);
        return ok(res, result);
    }
    catch (err) {
        if (err instanceof Error) {
            if (err.message === "Application not found")
                return fail(res, err.message, 404);
            if (err.message === "Application already reviewed")
                return fail(res, err.message, 409);
        }
        next(err);
    }
});
