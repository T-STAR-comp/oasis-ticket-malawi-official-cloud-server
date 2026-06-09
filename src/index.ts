import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { ensureDatabaseConnection } from "./db/connect.js";
import { ensureDefaultAdmin } from "./services/bootstrap.service.js";
import { startPaymentPoller } from "./services/payment-poller.service.js";
import { startReminderPoller } from "./services/reminder.service.js";
import { startTicketExpiryPoller } from "./services/ticket-expiry.service.js";

async function start() {
  try {
    await ensureDatabaseConnection();
    console.log(`MySQL connected (${env.mysql.host}:${env.mysql.port}/${env.mysql.database})`);
    await ensureDefaultAdmin();
  } catch (error) {
    console.error("Failed to connect to MySQL. Server will not start.");
    console.error(error);
    process.exit(1);
  }

  const app = createApp();

  app.listen(env.port, () => {
    const mode = env.serveFrontend ? "API + React SPA" : "API only";
    console.log(`Ticket Malawi (${mode}) on http://localhost:${env.port}`);
    console.log(`CORS origins: ${env.corsOrigins.join(", ")}`);
    startPaymentPoller();
    startReminderPoller();
    startTicketExpiryPoller();
  });
}

start();
