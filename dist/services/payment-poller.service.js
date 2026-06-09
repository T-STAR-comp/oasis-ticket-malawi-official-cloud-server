import { env } from "../config/env.js";
import { failStalePendingPayments, processPendingLedgerEntry } from "./checkout.service.js";
import { listPendingLedgerEntries } from "./ledger.service.js";
let timer = null;
export function startPaymentPoller() {
    if (timer)
        return;
    const tick = async () => {
        try {
            await failStalePendingPayments();
            const entries = await listPendingLedgerEntries();
            for (const entry of entries) {
                await processPendingLedgerEntry(entry.id);
            }
        }
        catch (err) {
            console.error("[payment-poller] tick failed:", err);
        }
    };
    void tick();
    timer = setInterval(tick, env.paychangu.pollIntervalMs);
    console.log(`[payment-poller] Started (every ${env.paychangu.pollIntervalMs}ms, timeout ${env.paychangu.pendingTimeoutMs}ms)`);
}
export function stopPaymentPoller() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
