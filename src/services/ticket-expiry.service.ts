import type { RowDataPacket } from "mysql2";
import { pool } from "../db/pool.js";
import { purgeListingImagesPastEventDate } from "./image-cleanup.service.js";
import { processExpiredSuspensions } from "./moderation.service.js";
import { syncRefundRecoveryForOrganizersWithDebt } from "./refund-recovery.service.js";
import {
  isVirtualEventWindowEnded,
  isVirtualListingFormat,
} from "../utils/virtual-events.js";

const TICKET_EXPIRY_INTERVAL_MS = 60 * 60 * 1000;
const VIRTUAL_STATUS_INTERVAL_MS = 5 * 60 * 1000;

/** Physical events only — virtual tickets stay active until the scheduled window ends. */
export async function expireTicketsPastEventDate() {
  const [result] = await pool.query(
    `UPDATE user_tickets ut
     JOIN listings l ON l.id = ut.listing_id
     SET ut.status = 'expired'
     WHERE ut.status = 'active'
       AND l.event_starts_on IS NOT NULL
       AND l.event_starts_on < CURDATE()
       AND COALESCE(l.event_format, 'physical') = 'physical'
       AND (l.virtual_meeting_url IS NULL OR l.virtual_meeting_url = '')`,
  );
  return (result as { affectedRows?: number }).affectedRows ?? 0;
}

type VirtualTicketRow = {
  id: string;
  status: string;
  event_format?: string | null;
  virtual_meeting_url?: string | null;
  event_starts_on?: string | Date | null;
  time_label?: string | null;
  virtual_duration_minutes?: number | null;
};

/** Keep virtual tickets active during the live window; mark used only after it ends. */
export async function syncVirtualTicketStatus(row: VirtualTicketRow): Promise<string> {
  if (
    !isVirtualListingFormat({
      eventFormat: row.event_format,
      virtualMeetingUrl: row.virtual_meeting_url,
    })
  ) {
    return row.status;
  }

  const windowEnded = isVirtualEventWindowEnded({
    eventStartsOn: row.event_starts_on,
    timeLabel: String(row.time_label ?? ""),
    virtualDurationMinutes:
      row.virtual_duration_minutes != null ? Number(row.virtual_duration_minutes) : null,
  });

  if (windowEnded && row.status === "active") {
    await pool.query(
      `UPDATE user_tickets
       SET status = 'used', verified_at = COALESCE(verified_at, NOW())
       WHERE id = :id AND status = 'active'`,
      { id: row.id },
    );
    return "used";
  }

  if (!windowEnded && row.status === "expired") {
    await pool.query(
      `UPDATE user_tickets SET status = 'active' WHERE id = :id AND status = 'expired'`,
      { id: row.id },
    );
    return "active";
  }

  return row.status;
}

/** Mark virtual tickets as used once the scheduled window ends. */
export async function markVirtualTicketsUsedAfterWindow() {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ut.id, ut.status, l.event_starts_on, l.time_label, l.virtual_duration_minutes,
            l.event_format, l.virtual_meeting_url
     FROM user_tickets ut
     JOIN listings l ON l.id = ut.listing_id
     WHERE ut.status IN ('active', 'expired')
       AND (
         l.event_format = 'virtual'
         OR (l.virtual_meeting_url IS NOT NULL AND l.virtual_meeting_url != '')
       )
       AND l.event_starts_on IS NOT NULL`,
  );

  let updated = 0;
  for (const row of rows) {
    const before = String(row.status);
    const after = await syncVirtualTicketStatus({
      id: String(row.id),
      status: before,
      event_format: row.event_format as string | null,
      virtual_meeting_url: row.virtual_meeting_url as string | null,
      event_starts_on: row.event_starts_on as string,
      time_label: row.time_label as string | null,
      virtual_duration_minutes: row.virtual_duration_minutes as number | null,
    });
    if (after === "used" && before !== "used") updated += 1;
  }

  return updated;
}

export function startTicketExpiryPoller() {
  const tick = async () => {
    try {
      const expired = await expireTicketsPastEventDate();
      if (expired > 0) {
        console.log(`[ticket-expiry] Marked ${expired} physical ticket(s) expired (event date passed).`);
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
  setInterval(() => void markVirtualTicketsUsedAfterWindow(), VIRTUAL_STATUS_INTERVAL_MS);
  console.log(
    `[ticket-expiry] Started (physical every ${TICKET_EXPIRY_INTERVAL_MS}ms, virtual window every ${VIRTUAL_STATUS_INTERVAL_MS}ms)`,
  );
}
