import { pool } from "../db/pool.js";
import { isMissingColumnError, isMissingTableError } from "../utils/db-errors.js";
import { log } from "../utils/logger.js";
export async function warnIfEsportsSchemaMissing() {
    try {
        await pool.query("SELECT id, max_slots FROM esports_events LIMIT 1");
    }
    catch (err) {
        if (isMissingTableError(err)) {
            log.warn("esports", "E-Sports tables are missing — admin/public E-Sports will fail until you run: npm run db:migrate:esports-all");
            return;
        }
        if (isMissingColumnError(err)) {
            log.warn("esports", "E-Sports max_slots column is missing — run: npm run db:migrate:esports-slots");
            return;
        }
        log.warn("esports", "Could not verify E-Sports schema", {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
