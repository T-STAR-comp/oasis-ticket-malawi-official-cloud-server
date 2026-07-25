import { env } from "../config/env.js";
import { log } from "../utils/logger.js";
import { failStalePendingPayments, processPendingLedgerEntry } from "./checkout.service.js";
import { listPendingLedgerEntries } from "./ledger.service.js";

let timer: ReturnType<typeof setInterval> | null = null;

export function startPaymentPoller() {
  if (timer) return;

  const tick = async () => {
    try {
      await failStalePendingPayments();
      const entries = await listPendingLedgerEntries();
      for (const entry of entries) {
        await processPendingLedgerEntry(entry.id);
      }
    } catch (err) {
      log.error("payment-poller", "Tick failed", err);
    }
  };

  void tick();
  timer = setInterval(tick, env.paychangu.pollIntervalMs);
  log.info("payment-poller", "Started", {
    intervalMs: env.paychangu.pollIntervalMs,
    timeoutMs: env.paychangu.pendingTimeoutMs,
  });
}

export function stopPaymentPoller() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
