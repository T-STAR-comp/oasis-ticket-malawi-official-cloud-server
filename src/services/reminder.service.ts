import type { RowDataPacket } from "mysql2";
import { v4 as uuid } from "uuid";
import { pool } from "../db/pool.js";
import * as emailService from "./email.service.js";

const REMINDER_DAYS = [2, 1] as const;

export async function processEventReminders() {
  for (const daysBefore of REMINDER_DAYS) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT ut.id AS user_ticket_id, ut.reference, ut.seat_number,
              u.email, u.full_name,
              l.id AS listing_id, l.title, l.kind, l.date_label, l.time_label,
              l.location, l.event_starts_on
       FROM user_tickets ut
       JOIN users u ON u.id = ut.user_id
       JOIN listings l ON l.id = ut.listing_id
       WHERE ut.status = 'active'
         AND l.event_starts_on IS NOT NULL
         AND l.event_starts_on = DATE_ADD(CURDATE(), INTERVAL :daysBefore DAY)
         AND NOT EXISTS (
           SELECT 1 FROM ticket_reminder_log trl
           WHERE trl.user_ticket_id = ut.id AND trl.days_before = :daysBefore
         )`,
      { daysBefore },
    );

    for (const row of rows) {
      try {
        await emailService.sendEventReminderEmail({
          email: row.email as string,
          fullName: row.full_name as string,
          listingTitle: row.title as string,
          kind: row.kind as string,
          dateLabel: row.date_label as string,
          timeLabel: row.time_label as string,
          location: row.location as string,
          reference: row.reference as string,
          seat: row.seat_number != null ? String(row.seat_number) : undefined,
          daysBefore,
        });

        await pool.query(
          `INSERT INTO ticket_reminder_log (id, user_ticket_id, listing_id, days_before)
           VALUES (:id, :userTicketId, :listingId, :daysBefore)`,
          {
            id: uuid(),
            userTicketId: row.user_ticket_id,
            listingId: row.listing_id,
            daysBefore,
          },
        );
      } catch (err) {
        console.error("[reminder] failed for ticket", row.user_ticket_id, err);
      }
    }

    if (rows.length > 0) {
      console.log(`[reminder] Sent ${rows.length} reminder(s) for ${daysBefore} day(s) before event`);
    }
  }
}

export function startReminderPoller() {
  const hourMs = 60 * 60 * 1000;
  void processEventReminders();
  setInterval(() => void processEventReminders(), hourMs);
  console.log("[reminder-poller] Started (every 3600000ms)");
}
