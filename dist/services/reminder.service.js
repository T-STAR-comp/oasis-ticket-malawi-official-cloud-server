import { v4 as uuid } from "uuid";
import { pool } from "../db/pool.js";
import * as emailService from "./email.service.js";
const REMINDER_DAYS = [2, 1];
const VIRTUAL_JOIN_LEAD_MINUTES = 10;
const ORGANIZER_MISSING_LINK_WINDOWS_HOURS = [12, 8, 4];
function isMissingSchemaError(err) {
    if (!(err instanceof Error))
        return false;
    return (err.message.includes("doesn't exist") ||
        err.message.includes("Unknown table") ||
        err.message.includes("Unknown column"));
}
function formatMalawiDateTime(value) {
    const d = value instanceof Date ? value : new Date(value);
    return new Intl.DateTimeFormat("en-MW", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Africa/Blantyre",
    }).format(d);
}
export async function processEventReminders() {
    for (const daysBefore of REMINDER_DAYS) {
        const [rows] = await pool.query(`SELECT ut.id AS user_ticket_id, ut.reference, ut.seat_number,
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
         )`, { daysBefore });
        for (const row of rows) {
            try {
                await emailService.sendEventReminderEmail({
                    email: row.email,
                    fullName: row.full_name,
                    listingTitle: row.title,
                    kind: row.kind,
                    dateLabel: row.date_label,
                    timeLabel: row.time_label,
                    location: row.location,
                    reference: row.reference,
                    seat: row.seat_number != null ? String(row.seat_number) : undefined,
                    daysBefore,
                });
                await pool.query(`INSERT INTO ticket_reminder_log (id, user_ticket_id, listing_id, days_before)
           VALUES (:id, :userTicketId, :listingId, :daysBefore)`, {
                    id: uuid(),
                    userTicketId: row.user_ticket_id,
                    listingId: row.listing_id,
                    daysBefore,
                });
            }
            catch (err) {
                console.error("[reminder] failed for ticket", row.user_ticket_id, err);
            }
        }
        if (rows.length > 0) {
            console.log(`[reminder] Sent ${rows.length} reminder(s) for ${daysBefore} day(s) before event`);
        }
    }
}
async function processVirtualAttendeePrestartReminders() {
    let rows = [];
    try {
        const [result] = await pool.query(`SELECT ut.id AS user_ticket_id, ut.reference,
              u.email, u.full_name,
              l.id AS listing_id, l.title, l.date_label, l.time_label, l.virtual_meeting_url
       FROM user_tickets ut
       JOIN users u ON u.id = ut.user_id
       JOIN listings l ON l.id = ut.listing_id
       WHERE ut.status = 'active'
         AND l.event_format = 'virtual'
         AND COALESCE(l.virtual_event_type, 'one_time') = 'one_time'
         AND NULLIF(TRIM(l.virtual_meeting_url), '') IS NOT NULL
         AND TIMESTAMPDIFF(MINUTE, NOW(), STR_TO_DATE(CONCAT(l.event_starts_on, ' ', l.time_label), '%Y-%m-%d %H:%i')) BETWEEN 0 AND :leadMins
         AND NOT EXISTS (
           SELECT 1 FROM virtual_join_reminder_log vrl
           WHERE vrl.user_ticket_id = ut.id
             AND vrl.reminder_kind = 'attendee_prestart'
             AND vrl.reminder_bucket = DATE_FORMAT(l.event_starts_on, '%Y-%m-%d')
         )`, { leadMins: VIRTUAL_JOIN_LEAD_MINUTES });
        rows = result;
    }
    catch (err) {
        if (isMissingSchemaError(err))
            return;
        throw err;
    }
    for (const row of rows) {
        try {
            await emailService.sendVirtualJoinReminderEmail({
                email: String(row.email),
                fullName: String(row.full_name),
                listingTitle: String(row.title),
                dateLabel: String(row.date_label),
                timeLabel: String(row.time_label ?? ""),
                meetingUrl: String(row.virtual_meeting_url),
                reference: String(row.reference),
            });
            await pool.query(`INSERT INTO virtual_join_reminder_log
          (id, user_ticket_id, listing_id, reminder_kind, reminder_bucket)
         VALUES (:id, :ticketId, :listingId, 'attendee_prestart', :bucket)`, {
                id: uuid(),
                ticketId: String(row.user_ticket_id),
                listingId: String(row.listing_id),
                bucket: String(row.date_label ?? "").slice(0, 32) || "one_time",
            });
        }
        catch (err) {
            console.error("[virtual-reminder] attendee prestart failed", row.user_ticket_id, err);
        }
    }
}
async function processVirtualOngoingSessionPrestartReminders() {
    let rows = [];
    try {
        const [result] = await pool.query(`SELECT ut.id AS user_ticket_id, ut.reference,
              u.email, u.full_name,
              l.id AS listing_id, l.title,
              s.id AS session_id, s.title AS session_title, s.starts_at, s.meeting_url
       FROM user_tickets ut
       JOIN users u ON u.id = ut.user_id
       JOIN listings l ON l.id = ut.listing_id
       JOIN user_ticket_virtual_sessions utvs ON utvs.user_ticket_id = ut.id
       JOIN virtual_event_sessions s ON s.id = utvs.session_id
       WHERE ut.status = 'active'
         AND l.event_format = 'virtual'
         AND COALESCE(l.virtual_event_type, 'one_time') = 'ongoing'
         AND s.status != 'cancelled'
         AND NULLIF(TRIM(COALESCE(s.meeting_url, '')), '') IS NOT NULL
         AND TIMESTAMPDIFF(MINUTE, NOW(), s.starts_at) BETWEEN 0 AND :leadMins
         AND NOT EXISTS (
           SELECT 1 FROM virtual_join_reminder_log vrl
           WHERE vrl.user_ticket_id = ut.id
             AND vrl.session_id = s.id
             AND vrl.reminder_kind = 'attendee_prestart'
             AND vrl.reminder_bucket = CONCAT('session-', s.id)
         )`, { leadMins: VIRTUAL_JOIN_LEAD_MINUTES });
        rows = result;
    }
    catch (err) {
        if (isMissingSchemaError(err))
            return;
        throw err;
    }
    for (const row of rows) {
        try {
            const startsAt = new Date(row.starts_at);
            await emailService.sendVirtualJoinReminderEmail({
                email: String(row.email),
                fullName: String(row.full_name),
                listingTitle: `${String(row.title)} · ${String(row.session_title)}`,
                dateLabel: startsAt.toLocaleDateString("en-MW", {
                    dateStyle: "medium",
                    timeZone: "Africa/Blantyre",
                }),
                timeLabel: startsAt.toLocaleTimeString("en-MW", {
                    timeStyle: "short",
                    timeZone: "Africa/Blantyre",
                }),
                meetingUrl: String(row.meeting_url),
                reference: String(row.reference),
            });
            await pool.query(`INSERT INTO virtual_join_reminder_log
          (id, user_ticket_id, listing_id, session_id, reminder_kind, reminder_bucket)
         VALUES (:id, :ticketId, :listingId, :sessionId, 'attendee_prestart', :bucket)`, {
                id: uuid(),
                ticketId: String(row.user_ticket_id),
                listingId: String(row.listing_id),
                sessionId: String(row.session_id),
                bucket: `session-${String(row.session_id)}`,
            });
        }
        catch (err) {
            console.error("[virtual-reminder] ongoing session prestart failed", row.user_ticket_id, err);
        }
    }
}
async function processOrganizerMissingSessionLinks() {
    for (const windowHours of ORGANIZER_MISSING_LINK_WINDOWS_HOURS) {
        let rows = [];
        try {
            const [result] = await pool.query(`SELECT l.id AS listing_id, l.title AS listing_title,
                op.email, op.contact_name,
                s.id AS session_id, s.title AS session_title, s.starts_at
         FROM virtual_event_sessions s
         JOIN listings l ON l.id = s.listing_id
         JOIN organizer_profiles op ON op.user_id = l.organizer_id
         WHERE l.event_format = 'virtual'
           AND COALESCE(l.virtual_event_type, 'one_time') = 'ongoing'
           AND s.status != 'cancelled'
           AND NULLIF(TRIM(COALESCE(s.meeting_url, '')), '') IS NULL
           AND TIMESTAMPDIFF(HOUR, NOW(), s.starts_at) BETWEEN 0 AND :windowHours
           AND NOT EXISTS (
             SELECT 1 FROM virtual_join_reminder_log vrl
             WHERE vrl.listing_id = l.id
               AND vrl.session_id = s.id
               AND vrl.reminder_kind = 'organizer_missing_link'
               AND vrl.reminder_bucket = :bucket
           )`, { windowHours, bucket: `h-${windowHours}` });
            rows = result;
        }
        catch (err) {
            if (isMissingSchemaError(err))
                return;
            throw err;
        }
        for (const row of rows) {
            try {
                await emailService.sendOrganizerMissingSessionLinkReminderEmail({
                    email: String(row.email),
                    organizerName: String(row.contact_name || "Organizer"),
                    listingTitle: String(row.listing_title),
                    sessionTitle: String(row.session_title),
                    startsAtLabel: formatMalawiDateTime(row.starts_at),
                    hoursLeft: windowHours,
                });
                await pool.query(`INSERT INTO virtual_join_reminder_log
            (id, user_ticket_id, listing_id, session_id, reminder_kind, reminder_bucket)
           VALUES (:id, NULL, :listingId, :sessionId, 'organizer_missing_link', :bucket)`, {
                    id: uuid(),
                    listingId: String(row.listing_id),
                    sessionId: String(row.session_id),
                    bucket: `h-${windowHours}`,
                });
            }
            catch (err) {
                console.error("[virtual-reminder] organizer missing link failed", row.session_id, err);
            }
        }
    }
}
function logReminderError(label, err) {
    console.error(`[reminder] ${label}:`, err instanceof Error ? err.message : err);
}
export function startReminderPoller() {
    const hourMs = 60 * 60 * 1000;
    void processEventReminders().catch((err) => logReminderError("startup tick failed", err));
    void processVirtualAttendeePrestartReminders().catch((err) => logReminderError("virtual prestart tick failed", err));
    void processVirtualOngoingSessionPrestartReminders().catch((err) => logReminderError("ongoing session prestart tick failed", err));
    void processOrganizerMissingSessionLinks().catch((err) => logReminderError("organizer link tick failed", err));
    setInterval(() => void processEventReminders().catch((err) => logReminderError("tick failed", err)), hourMs);
    setInterval(() => void processVirtualAttendeePrestartReminders().catch((err) => logReminderError("virtual prestart tick failed", err)), 5 * 60 * 1000);
    setInterval(() => void processVirtualOngoingSessionPrestartReminders().catch((err) => logReminderError("ongoing session prestart tick failed", err)), 5 * 60 * 1000);
    setInterval(() => void processOrganizerMissingSessionLinks().catch((err) => logReminderError("organizer link tick failed", err)), 60 * 60 * 1000);
    console.log("[reminder-poller] Started (every 3600000ms)");
}
