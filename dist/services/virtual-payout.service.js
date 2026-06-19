import { pool } from "../db/pool.js";
import { getVirtualEventWindowEnd, isVirtualEventWindowEnded, isVirtualListingFormat, } from "../utils/virtual-events.js";
const PAYMENT_COMPLETED_AT = `COALESCE(pl.completed_at, o.updated_at, o.created_at)`;
/** SQL fragment: listing is virtual and payout not yet admin-verified. */
export const UNVERIFIED_VIRTUAL_PAYOUT_WHERE = `
  (l.event_format = 'virtual' OR NULLIF(TRIM(l.virtual_meeting_url), '') IS NOT NULL)
  AND l.virtual_payout_verified_at IS NULL
`;
export async function getOrganizerVirtualPayoutHold(organizerId) {
    const [rows] = await pool.query(`SELECT COALESCE(SUM(o.subtotal_mwk), 0) AS held
     FROM orders o
     JOIN listings l ON l.id = o.listing_id
     JOIN payment_ledger pl ON pl.order_id = o.id AND pl.status = 'completed'
     WHERE l.organizer_id = :organizerId
       AND o.status = 'confirmed'
       AND l.status != 'cancelled'
       AND ${UNVERIFIED_VIRTUAL_PAYOUT_WHERE}
       AND CURDATE() > DATE(${PAYMENT_COMPLETED_AT})`, { organizerId });
    return Number(rows[0]?.held ?? 0);
}
export async function listVirtualEventsForAdmin() {
    const [rows] = await pool.query(`SELECT
       l.id AS listingId,
       l.title,
       l.status AS listingStatus,
       l.organizer_id AS organizerId,
       op.company_name AS companyName,
       op.contact_name AS contactName,
       op.email,
       l.virtual_meeting_url AS virtualMeetingUrl,
       l.event_starts_on AS eventStartsOn,
       l.time_label AS timeLabel,
       l.virtual_duration_minutes AS virtualDurationMinutes,
       l.virtual_payout_verified_at AS payoutVerifiedAt,
       COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN o.subtotal_mwk ELSE 0 END), 0) AS totalEarnings,
       COALESCE(SUM(
         CASE
           WHEN o.status = 'confirmed' AND CURDATE() > DATE(${PAYMENT_COMPLETED_AT})
           THEN o.subtotal_mwk ELSE 0
         END
       ), 0) AS settledEarnings,
       COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN 1 ELSE 0 END), 0) AS ticketsSold
     FROM listings l
     JOIN organizer_profiles op ON op.user_id = l.organizer_id
     LEFT JOIN orders o ON o.listing_id = l.id
     LEFT JOIN payment_ledger pl ON pl.order_id = o.id AND pl.status = 'completed'
     WHERE l.event_format = 'virtual'
        OR NULLIF(TRIM(l.virtual_meeting_url), '') IS NOT NULL
     GROUP BY
       l.id, l.title, l.status, l.organizer_id,
       op.company_name, op.contact_name, op.email,
       l.virtual_meeting_url, l.event_starts_on, l.time_label,
       l.virtual_duration_minutes, l.virtual_payout_verified_at
     ORDER BY l.event_starts_on DESC, l.created_at DESC`);
    const now = new Date();
    return rows.map((r) => {
        const eventStartsOn = r.eventStartsOn ? String(r.eventStartsOn).slice(0, 10) : null;
        const timeLabel = String(r.timeLabel ?? "");
        const virtualDurationMinutes = r.virtualDurationMinutes != null ? Number(r.virtualDurationMinutes) : null;
        const payoutVerified = r.payoutVerifiedAt != null;
        const eventEnded = isVirtualEventWindowEnded({
            eventStartsOn,
            timeLabel,
            virtualDurationMinutes,
            now,
        });
        const end = getVirtualEventWindowEnd(eventStartsOn, timeLabel, virtualDurationMinutes);
        return {
            listingId: String(r.listingId),
            title: String(r.title),
            listingStatus: String(r.listingStatus),
            organizerId: String(r.organizerId),
            companyName: String(r.companyName ?? ""),
            contactName: String(r.contactName ?? ""),
            email: String(r.email ?? ""),
            virtualMeetingUrl: String(r.virtualMeetingUrl ?? ""),
            eventStartsOn,
            timeLabel,
            virtualDurationMinutes,
            ticketsSold: Number(r.ticketsSold ?? 0),
            totalEarnings: Number(r.totalEarnings ?? 0),
            settledEarnings: Number(r.settledEarnings ?? 0),
            payoutVerified,
            payoutVerifiedAt: r.payoutVerifiedAt ? String(r.payoutVerifiedAt) : null,
            eventEnded,
            eventEndsAt: end ? end.toISOString() : null,
            canVerify: eventEnded && !payoutVerified,
        };
    });
}
export async function verifyVirtualEventPayout(listingId, adminUserId) {
    const [rows] = await pool.query(`SELECT id, title, event_format, virtual_meeting_url, event_starts_on, time_label,
            virtual_duration_minutes, virtual_payout_verified_at
     FROM listings WHERE id = :id`, { id: listingId });
    const row = rows[0];
    if (!row)
        throw new Error("Virtual event not found");
    if (!isVirtualListingFormat({
        eventFormat: row.event_format,
        virtualMeetingUrl: row.virtual_meeting_url,
    })) {
        throw new Error("This listing is not a virtual event");
    }
    if (row.virtual_payout_verified_at) {
        throw new Error("Payout for this virtual event has already been verified");
    }
    const eventEnded = isVirtualEventWindowEnded({
        eventStartsOn: row.event_starts_on,
        timeLabel: String(row.time_label ?? ""),
        virtualDurationMinutes: row.virtual_duration_minutes != null ? Number(row.virtual_duration_minutes) : null,
    });
    if (!eventEnded) {
        throw new Error("Payout can only be verified after the virtual event has ended. Use Check to open the meeting link once the event is live.");
    }
    await pool.query(`UPDATE listings
     SET virtual_payout_verified_at = NOW(), virtual_payout_verified_by = :adminUserId
     WHERE id = :id AND virtual_payout_verified_at IS NULL`, { id: listingId, adminUserId });
    return { listingId, verified: true };
}
