import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IMAGE_BUCKET_URL_PREFIX, resolveImageBucketDir } from "./config/images.js";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { authRouter } from "./routes/auth.routes.js";
import { listingsRouter } from "./routes/listings.routes.js";
import { eventsRouter } from "./routes/events.routes.js";
import { travelRouter } from "./routes/travel.routes.js";
import { checkoutRouter } from "./routes/checkout.routes.js";
import { dashboardRouter } from "./routes/dashboard.routes.js";
import { organizerRouter } from "./routes/organizer.routes.js";
import { partnerRouter } from "./routes/partner.routes.js";
import { adminRouter } from "./routes/admin.routes.js";
import { reportsRouter } from "./routes/reports.routes.js";
import { verifyRouter } from "./routes/verify.routes.js";
import { referrerRouter } from "./routes/referrer.routes.js";
import { careersRouter } from "./routes/careers.routes.js";
import { resellRouter } from "./routes/resell.routes.js";
import { selfCheckinRouter } from "./routes/self-checkin.routes.js";
import { pool } from "./db/pool.js";
import { LEGAL_VERSION } from "./config/legal.js";
import * as platformSettingsService from "./services/platform-settings.service.js";
import { registerFrontend } from "./middleware/serveFrontend.js";
/** Bump when deploy verification fields on /api/health change. */
export const API_BUILD_VERSION = 2;
export function createApp() {
    const app = express();
    app.use(cors({ origin: env.corsOrigins, credentials: true }));
    app.use(express.json({ limit: "1mb" }));
    const bucketDir = resolveImageBucketDir();
    if (!fs.existsSync(bucketDir)) {
        fs.mkdirSync(bucketDir, { recursive: true });
    }
    if (env.images.serveFromApi) {
        app.use(IMAGE_BUCKET_URL_PREFIX, express.static(bucketDir, {
            maxAge: env.nodeEnv === "production" ? "7d" : 0,
            dotfiles: "deny",
            index: false,
            fallthrough: false,
        }));
    }
    app.get("/api/health", async (_req, res) => {
        try {
            await pool.query("SELECT 1");
            let resellReady = false;
            try {
                const [tables] = await pool.query(`SELECT 1 FROM information_schema.tables
           WHERE table_schema = DATABASE() AND table_name = 'resell_listings'
           LIMIT 1`);
                resellReady = tables.length > 0;
            }
            catch {
                resellReady = false;
            }
            res.setHeader("Cache-Control", "no-store");
            const distApp = path.join(path.dirname(fileURLToPath(import.meta.url)), "app.js");
            let builtAt;
            try {
                builtAt = fs.statSync(distApp).mtime.toISOString();
            }
            catch {
                builtAt = undefined;
            }
            res.json({
                success: true,
                service: "ticket-malawi-cloud-server",
                database: "connected",
                apiVersion: API_BUILD_VERSION,
                builtAt,
                features: {
                    checkoutUsesProfile: true,
                    resell: resellReady,
                },
            });
        }
        catch {
            res.status(503).json({ success: false, service: "ticket-malawi-cloud-server", database: "disconnected" });
        }
    });
    app.get("/api/config/public", async (_req, res) => {
        const serviceFeeBearer = await platformSettingsService.getServiceFeeBearer();
        res.json({
            success: true,
            data: {
                paychanguMock: env.paychangu.mock,
                mockPaymentAmountMwk: env.paychangu.mock ? env.paychangu.mockPaymentAmountMwk : null,
                platformServiceFeePercent: env.platformServiceFeePercent,
                serviceFeeBearer,
                referralPayoutFeePercent: env.referrals.payoutFeePercent,
                authProvider: env.auth.provider,
                firebaseAuthEnabled: env.firebase.enabled,
            },
        });
    });
    app.get("/api/legal/version", (_req, res) => {
        res.json({
            success: true,
            data: { version: LEGAL_VERSION, termsUrl: "/terms", privacyUrl: "/privacy" },
        });
    });
    app.use("/api/auth", authRouter);
    app.use("/api/listings", listingsRouter);
    app.use("/api/events", eventsRouter);
    app.use("/api/travel", travelRouter);
    app.use("/api/checkout", checkoutRouter);
    app.use("/api/dashboard", dashboardRouter);
    app.use("/api/organizer", organizerRouter);
    app.use("/api/verify", verifyRouter);
    app.use("/api/partner-applications", partnerRouter);
    app.use("/api/admin", adminRouter);
    app.use("/api/reports", reportsRouter);
    app.use("/api/referrer", referrerRouter);
    app.use("/api/careers", careersRouter);
    app.use("/api/resell", resellRouter);
    app.use("/api/self-checkin", selfCheckinRouter);
    registerFrontend(app, env.serveFrontend);
    app.use(errorHandler);
    return app;
}
