import { pool } from "../db/pool.js";
import { purgeListingImagesPastEventDate } from "./image-cleanup.service.js";
import { processExpiredSuspensions } from "./moderation.service.js";
import { syncRefundRecoveryForOrganizersWithDebt } from "./refund-recovery.service.js";

const TICKET_EXPIRY_INTERVAL_MS = 60 * 60 * 1000;

export async function expireTicketsPastEventDate() {
  const [result] = await pool.query(
    `UPDATE user_tickets ut
     JOIN listings l ON l.id = ut.listing_id
     SET ut.status = 'expired'
     WHERE ut.status = 'active'
       AND l.event_starts_on IS NOT NULL
       AND l.event_starts_on < CURDATE()`,
  );
  return (result as { affectedRows?: number }).affectedRows ?? 0;
}

export function startTicketExpiryPoller() {
  const tick = async () => {
    try {
      const expired = await expireTicketsPastEventDate();
      if (expired > 0) {
        console.log(`[ticket-expiry] Marked ${expired} ticket(s) inactive (event date passed).`);
      }
      const imagePurge = await purgeListingImagesPastEventDate();
      if (imagePurge.filesDeleted > 0) {
        console.log(
          `[image-cleanup] Removed ${imagePurge.filesDeleted} listing image(s) after event date.`,
        );
      }
      await processExpiredSuspensions();
      await syncRefundRecoveryForOrganizersWithDebt();
    } catch (err) {
      console.error("[ticket-expiry] Poller error:", err);
    }
  };

  void tick();
  setInterval(tick, TICKET_EXPIRY_INTERVAL_MS);
  console.log(`[ticket-expiry] Started (every ${TICKET_EXPIRY_INTERVAL_MS}ms)`);
}
