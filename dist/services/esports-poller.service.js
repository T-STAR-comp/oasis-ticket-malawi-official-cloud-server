import { env } from "../config/env.js";
import { log } from "../utils/logger.js";
import { archiveExpiredEsportsEvents, failStaleEsportsRegistrations, listPendingEsportsRegistrations, processPendingEsportsRegistration, } from "./esports.service.js";
let timer = null;
export function startEsportsPoller() {
    if (timer)
        return;
    const tick = async () => {
        try {
            await failStaleEsportsRegistrations();
            const pending = await listPendingEsportsRegistrations();
            for (const registrationId of pending) {
                await processPendingEsportsRegistration(registrationId);
            }
            await archiveExpiredEsportsEvents();
        }
        catch (err) {
            log.error("esports-poller", "Tick failed", err);
        }
    };
    void tick();
    timer = setInterval(tick, env.paychangu.pollIntervalMs);
    log.info("esports-poller", "Started", { intervalMs: env.paychangu.pollIntervalMs });
}
export function stopEsportsPoller() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
