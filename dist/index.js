import { API_BUILD_VERSION, createApp } from "./app.js";
import { env } from "./config/env.js";
import { ensureDatabaseConnection } from "./db/connect.js";
import { ensureDefaultAdmin } from "./services/bootstrap.service.js";
import { startPaymentPoller } from "./services/payment-poller.service.js";
import { startPaymentReconciliationPoller } from "./services/payment-reconciliation.service.js";
import { startPayoutReconciliationPoller } from "./services/payout-reconciliation.service.js";
import { logFeatureFlags } from "./config/features.js";
import { startReminderPoller } from "./services/reminder.service.js";
import { startEventAuditPoller } from "./services/event-audit-delivery.service.js";
import { startTicketExpiryPoller } from "./services/ticket-expiry.service.js";
import { applySettlementEpochResetOnStartup } from "./services/settlement-balance-reset.service.js";
import { startEsportsPoller } from "./services/esports-poller.service.js";
import { warnIfEsportsSchemaMissing } from "./services/esports-schema.service.js";
import { settleResellSales } from "./services/resell.service.js";
import { log } from "./utils/logger.js";
async function start() {
    try {
        await ensureDatabaseConnection();
        log.info("server", "MySQL connected", {
            host: env.mysql.host,
            port: env.mysql.port,
            database: env.mysql.database,
        });
        await ensureDefaultAdmin();
        await warnIfEsportsSchemaMissing();
    }
    catch (error) {
        log.error("server", "Failed to connect to MySQL — server will not start", error);
        process.exit(1);
    }
    try {
        await applySettlementEpochResetOnStartup();
    }
    catch (error) {
        log.warn("settlement-epoch", "Startup balance reset failed — server will continue", {
            error: error instanceof Error ? error.message : String(error),
        });
    }
    const app = createApp();
    app.listen(env.port, () => {
        const mode = env.serveFrontend ? "API + React SPA" : "API only";
        log.info("server", `Ticket Malawi listening (${mode})`, {
            url: `http://localhost:${env.port}`,
            apiVersion: API_BUILD_VERSION,
            corsOrigins: env.corsOrigins.join(", "),
        });
        logFeatureFlags();
        startPaymentPoller();
        startPaymentReconciliationPoller();
        startPayoutReconciliationPoller();
        startReminderPoller();
        startEventAuditPoller();
        startTicketExpiryPoller();
        startEsportsPoller();
        setInterval(() => void settleResellSales(), 60 * 60 * 1000);
        void settleResellSales();
    });
}
start();
