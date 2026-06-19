import type { RowDataPacket } from "mysql2";
import { pool } from "../db/pool.js";
import { purgeListingImagesPastEventDate } from "./image-cleanup.service.js";
import { processExpiredSuspensions } from "./moderation.service.js";
import { syncRefundRecoveryForOrganizersWithDebt } from "./refund-recovery.service.js";
import { getVirtualAccessState } from "../utils/virtual-events.js";

const TICKET_EXPIRY_INTERVAL_MS = 60 * 60 * 1000;

export async function expireTicketsPastEventDate() {
  const [result] = await pool.query(
    `UPDATE user_tickets ut
     JOIN listings l ON l.id = ut.listing_id
     SET ut.status = 'expired'
     WHERE ut.status = 'active'
       AND l.event_starts_on IS NOT NULL
       AND l.event_starts_on < CURDATE()
       AND COALESCE(l.event_format, 'physical') = 'physical'`,
  );
  return (result as { affectedRows?: number }).affectedRows ?? 0;
}

/** Mark virtual tickets as used once the scheduled window ends. */
export async function markVirtualTicketsUsedAfterWindow() {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ut.id, l.event_starts_on, l.time_label, l.virtual_duration_minutes
     FROM user_tickets ut
     JOIN listings l ON l.id = ut.listing_id
     WHERE ut.status = 'active'
       AND l.event_format = 'virtual'
       AND l.event_starts_on IS NOT NULL`,
  );

  let updated = 0;
  const now = new Date();

  for (const row of rows) {
    const access = getVirtualAccessState({
      eventFormat: "virtual",
      eventStartsOn: row.event_starts_on as string,
      timeLabel: String(row.time_label ?? ""),
      virtualDurationMinutes: Number(row.virtual_duration_minutes ?? 120),
      ticketStatus: "active",
      now,
    });

    if (access.accessClosesAt && now > new Date(access.accessClosesAt)) {
      await pool.query(
        `UPDATE user_tickets
         SET status = 'used', verified_at = COALESCE(verified_at, NOW())
         WHERE id = :id AND status = 'active'`,
        { id: row.id },
      );
      updated += 1;
    }
  }

  return updated;
}

export function startTicketExpiryPoller() {
  const tick = async () => {
    try {
      const expired = await expireTicketsPastEventDate();
      if (expired > 0) {
        console.log(`[ticket-expiry] Marked ${expired} ticket(s) inactive (event date passed).`);
      }
      const virtualUsed = await markVirtualTicketsUsedAfterWindow();
      if (virtualUsed > 0) {
        console.log(`[ticket-expiry] Marked ${virtualUsed} virtual ticket(s) as used (window ended).`);
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
