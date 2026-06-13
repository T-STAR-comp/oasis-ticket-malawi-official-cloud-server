import { v4 as uuid } from "uuid";
import { pool } from "../db/pool.js";
import * as emailService from "./email.service.js";
import { getListingById } from "./listings.service.js";
async function ticketHasPendingRefund(userTicketId) {
    const [rows] = await pool.query(`SELECT 1 FROM ticket_refunds
     WHERE user_ticket_id = :userTicketId AND status = 'pending'
     LIMIT 1`, { userTicketId });
    return rows.length > 0;
}
export async function getUserTickets(userId, status) {
    let sql = `
    SELECT ut.*, l.title, l.category, l.date_label, l.time_label, l.kind, l.image_url,
           l.operator_name, l.location, l.organizer_id, l.status AS listing_status,
           l.event_starts_on, ut.ticket_tier_name,
           op.status AS organizer_status, op.flagged_at, op.flag_reason,
           op.suspension_reason,
           rl_active.id AS resell_listing_id,
           rl_active.price_mwk AS resell_price_mwk,
           EXISTS (
             SELECT 1 FROM ticket_refunds tr
             WHERE tr.user_ticket_id = ut.id AND tr.status = 'pending'
           ) AS refund_pending
    FROM user_tickets ut
    JOIN listings l ON l.id = ut.listing_id
    JOIN organizer_profiles op ON op.user_id = l.organizer_id
    LEFT JOIN resell_listings rl_active
      ON rl_active.user_ticket_id = ut.id AND rl_active.status = 'active'
    WHERE ut.user_id = :userId`;
    const params = { userId };
    if (status) {
        sql += ` AND ut.status = :status`;
        params.status = status;
    }
    sql += ` ORDER BY ut.purchased_at DESC`;
    const [rows] = await pool.query(sql, params);
    return rows.map((r) => {
        const organizerRestricted = ["suspended", "banned", "inactive"].includes(String(r.organizer_status));
        const listingPostponed = String(r.listing_status) === "postponed";
        const listingCancelled = String(r.listing_status) === "cancelled";
        const postponedMessage = listingPostponed && r.status === "active"
            ? `This ${r.kind === "travel" ? "trip" : "event"} has been postponed to ${r.date_label}${r.time_label ? ` · ${r.time_label}` : ""}. Your ticket is valid for the new date.`
            : undefined;
        const refundPending = Boolean(r.refund_pending);
        const cancelledMessage = listingCancelled
            ? `This ${r.kind === "travel" ? "trip" : "event"} was cancelled by the organizer. Your ticket is no longer valid. Eligible purchases receive a 90% refund by email; 10% covers processing and convenience fees.`
            : undefined;
        const refundPendingMessage = refundPending
            ? "A refund is being processed for this ticket. Sharing is disabled until the refund completes."
            : undefined;
        return {
            id: r.id,
            ticketId: r.listing_id,
            reference: r.reference,
            qrToken: r.qr_token,
            status: r.status,
            purchasedOn: r.purchased_at,
            seat: r.seat_number ? String(r.seat_number) : undefined,
            ticketTierName: r.ticket_tier_name ? String(r.ticket_tier_name) : undefined,
            amountPaid: r.amount_paid,
            organizerRestricted,
            organizerFlagged: r.flagged_at != null,
            organizerStatus: r.organizer_status,
            listingStatus: r.listing_status,
            listingPostponed,
            listingCancelled,
            refundPending,
            holdMessage: refundPendingMessage
                ?? (organizerRestricted
                    ? "There are issues with this organizer. Your ticket will be available once the issues are cleared."
                    : cancelledMessage ?? postponedMessage),
            resellListing: r.resell_listing_id
                ? {
                    id: String(r.resell_listing_id),
                    priceMwk: Number(r.resell_price_mwk),
                }
                : undefined,
            ticket: {
                title: r.title,
                category: r.category,
                date: r.date_label,
                kind: r.kind,
                image: r.image_url,
                operator: { name: r.operator_name },
                location: r.location,
            },
        };
    });
}
export async function getUserTicketDetail(userId, ticketId) {
    const tickets = await getUserTickets(userId);
    const purchase = tickets.find((t) => t.id === ticketId);
    if (!purchase)
        return null;
    const listing = await getListingById(purchase.ticketId, true);
    if (!listing)
        return null;
    return { purchase, listing };
}
export async function getSpendingSummary(userId) {
    const [rows] = await pool.query(`SELECT COUNT(*) AS count, COALESCE(SUM(amount_paid), 0) AS total FROM user_tickets WHERE user_id = :userId`, { userId });
    return { totalSpent: Number(rows[0]?.total ?? 0), purchaseCount: Number(rows[0]?.count ?? 0) };
}
async function findCustomerRecipientByEmail(email, excludeUserId) {
    const [rows] = await pool.query(`SELECT id, email, full_name, phone, role, status
     FROM users
     WHERE LOWER(email) = LOWER(:email)
       AND id != :excludeUserId
       AND role = 'customer'
       AND status = 'active'
     LIMIT 1`, { email, excludeUserId });
    return rows[0] ?? null;
}
export async function lookupShareRecipient(sharerUserId, recipientEmail) {
    const normalized = recipientEmail.trim().toLowerCase();
    if (!normalized.includes("@")) {
        throw new Error("Enter a valid email address");
    }
    const [sharerRows] = await pool.query(`SELECT email FROM users WHERE id = :sharerUserId`, { sharerUserId });
    if (sharerRows[0]?.email?.toLowerCase() === normalized) {
        throw new Error("You cannot share a ticket with yourself");
    }
    const recipient = await findCustomerRecipientByEmail(normalized, sharerUserId);
    if (!recipient) {
        throw new Error("No customer account found with this email. They must sign up as a customer (not organizer) before you can share.");
    }
    return {
        userId: recipient.id,
        email: recipient.email,
        fullName: recipient.full_name,
        phone: recipient.phone ?? undefined,
    };
}
export async function shareTicket(sharerUserId, userTicketId, recipientEmail) {
    const recipient = await lookupShareRecipient(sharerUserId, recipientEmail);
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [ticketRows] = await conn.query(`SELECT ut.*, u.full_name AS owner_name, u.email AS owner_email,
              l.title AS listing_title, l.date_label
       FROM user_tickets ut
       JOIN users u ON u.id = ut.user_id
       JOIN listings l ON l.id = ut.listing_id
       WHERE ut.id = :userTicketId AND ut.user_id = :sharerUserId AND ut.status = 'active'
       FOR UPDATE`, { userTicketId, sharerUserId });
        const ticket = ticketRows[0];
        if (!ticket) {
            throw new Error("Ticket not found or is no longer active");
        }
        const [pendingRefund] = await conn.query(`SELECT 1 FROM ticket_refunds
       WHERE user_ticket_id = :userTicketId AND status = 'pending'
       LIMIT 1`, { userTicketId });
        if (pendingRefund.length > 0) {
            throw new Error("This ticket has a refund in progress. Sharing is disabled until the refund completes.");
        }
        const [activeResell] = await conn.query(`SELECT 1 FROM resell_listings
       WHERE user_ticket_id = :userTicketId AND status = 'active'
       LIMIT 1`, { userTicketId });
        if (activeResell.length > 0) {
            throw new Error("This ticket is listed for resale. Cancel the listing before sharing.");
        }
        await conn.query(`UPDATE user_tickets SET user_id = :recipientId WHERE id = :userTicketId`, { recipientId: recipient.userId, userTicketId });
        if (ticket.seat_number != null && ticket.listing_id) {
            await conn.query(`UPDATE seats s
         JOIN seat_layouts sl ON sl.id = s.layout_id
         SET s.customer_name = :recipientName
         WHERE sl.listing_id = :listingId AND s.seat_number = :seatNumber`, {
                recipientName: recipient.fullName,
                listingId: ticket.listing_id,
                seatNumber: ticket.seat_number,
            });
        }
        const shareId = uuid();
        await conn.query(`INSERT INTO ticket_shares (
        id, user_ticket_id, shared_by_user_id, recipient_email, status
      ) VALUES (
        :shareId, :userTicketId, :sharerUserId, :recipientEmail, 'accepted'
      )`, {
            shareId,
            userTicketId,
            sharerUserId,
            recipientEmail: recipient.email,
        });
        await conn.commit();
        const ticketTitle = String(ticket.listing_title ?? "Ticket");
        const reference = String(ticket.reference);
        const sharerName = String(ticket.owner_name);
        const sharerEmail = String(ticket.owner_email);
        try {
            await Promise.all([
                emailService.sendTicketSharedToRecipientEmail({
                    recipientEmail: recipient.email,
                    recipientName: recipient.fullName,
                    sharerName,
                    ticketTitle,
                    reference,
                    eventDate: ticket.date_label ? String(ticket.date_label) : undefined,
                    seat: ticket.seat_number != null ? String(ticket.seat_number) : undefined,
                }),
                emailService.sendTicketSharedBySenderEmail({
                    sharerEmail,
                    sharerName,
                    recipientName: recipient.fullName,
                    recipientEmail: recipient.email,
                    ticketTitle,
                    reference,
                }),
            ]);
        }
        catch (err) {
            console.error("[email] ticket share notifications failed:", err);
        }
        return {
            shareId,
            transferred: true,
            recipient: {
                userId: recipient.userId,
                email: recipient.email,
                fullName: recipient.fullName,
            },
            message: `Ticket shared successfully with ${recipient.fullName}.`,
        };
    }
    catch (err) {
        await conn.rollback();
        throw err;
    }
    finally {
        conn.release();
    }
}
export async function getPaymentMethods(userId) {
    const [rows] = await pool.query(`SELECT * FROM payment_methods WHERE user_id = :userId ORDER BY is_default DESC`, { userId });
    return rows;
}
