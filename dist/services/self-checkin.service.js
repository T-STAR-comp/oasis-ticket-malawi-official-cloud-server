import crypto from "node:crypto";
import { v4 as uuid } from "uuid";
import { pool } from "../db/pool.js";
import { canVerifyListing } from "./verification.service.js";
function makeGateToken() {
    return crypto.randomBytes(24).toString("hex");
}
export function buildGateQrPayload(sessionId, gateToken) {
    return JSON.stringify({ t: "self_checkin", s: sessionId, g: gateToken });
}
export async function activateSelfCheckin(userId, listingId) {
    const allowed = await canVerifyListing(userId, listingId);
    if (!allowed)
        throw new Error("You do not have permission to activate self check-in for this event");
    const [existing] = await pool.query(`SELECT id FROM self_checkin_sessions WHERE listing_id = :listingId AND status = 'active' LIMIT 1`, { listingId });
    if (existing[0]) {
        throw new Error("Self check-in is already active for this event. End the current session first.");
    }
    const id = uuid();
    const gateToken = makeGateToken();
    await pool.query(`INSERT INTO self_checkin_sessions (id, listing_id, activated_by_user_id, gate_token, status)
     VALUES (:id, :listingId, :userId, :gateToken, 'active')`, { id, listingId, userId, gateToken });
    return {
        sessionId: id,
        gateToken,
        qrPayload: buildGateQrPayload(id, gateToken),
        listingId,
    };
}
export async function endSelfCheckin(userId, sessionId) {
    const [rows] = await pool.query(`SELECT * FROM self_checkin_sessions WHERE id = :id LIMIT 1`, { id: sessionId });
    const session = rows[0];
    if (!session)
        throw new Error("Session not found");
    const allowed = await canVerifyListing(userId, String(session.listing_id));
    if (!allowed)
        throw new Error("Not authorized");
    await pool.query(`UPDATE self_checkin_sessions SET status = 'ended', ended_at = NOW() WHERE id = :id`, { id: sessionId });
}
export async function getActiveSelfCheckinForListing(listingId) {
    const [rows] = await pool.query(`SELECT * FROM self_checkin_sessions WHERE listing_id = :listingId AND status = 'active' ORDER BY started_at DESC LIMIT 1`, { listingId });
    const s = rows[0];
    if (!s)
        return null;
    return {
        sessionId: s.id,
        listingId: s.listing_id,
        startedAt: s.started_at,
        qrPayload: buildGateQrPayload(String(s.id), String(s.gate_token)),
    };
}
export async function getSelfCheckinLogs(userId, sessionId, since) {
    const [sessions] = await pool.query(`SELECT * FROM self_checkin_sessions WHERE id = :id LIMIT 1`, { id: sessionId });
    const session = sessions[0];
    if (!session)
        throw new Error("Session not found");
    const allowed = await canVerifyListing(userId, String(session.listing_id));
    if (!allowed)
        throw new Error("Not authorized");
    let sql = `SELECT * FROM self_checkin_events WHERE session_id = :sessionId`;
    const params = { sessionId };
    if (since) {
        sql += ` AND verified_at > :since`;
        params.since = since;
    }
    sql += ` ORDER BY verified_at DESC LIMIT 100`;
    const [rows] = await pool.query(sql, params);
    return rows.map((r) => ({
        id: r.id,
        ticketReference: r.ticket_reference,
        holderName: r.holder_name,
        result: r.result,
        rejectReason: r.reject_reason,
        verifiedAt: r.verified_at,
    }));
}
function parseGatePayload(raw) {
    try {
        const data = JSON.parse(raw);
        if (data.t === "self_checkin" && data.s && data.g) {
            return { sessionId: data.s, gateToken: data.g };
        }
    }
    catch {
        /* try raw scan */
    }
    return null;
}
export async function performSelfCheckin(holderUserId, userTicketId, gatePayloadRaw) {
    const parsed = parseGatePayload(gatePayloadRaw.trim());
    if (!parsed)
        throw new Error("Invalid gate QR code");
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [sessions] = await conn.query(`SELECT * FROM self_checkin_sessions WHERE id = :id AND status = 'active' FOR UPDATE`, { id: parsed.sessionId });
        const session = sessions[0];
        if (!session || String(session.gate_token) !== parsed.gateToken) {
            throw new Error("Self check-in is not active or gate code is invalid");
        }
        const [tickets] = await conn.query(`SELECT ut.*, u.full_name, l.title AS listing_title
       FROM user_tickets ut
       JOIN users u ON u.id = ut.user_id
       JOIN listings l ON l.id = ut.listing_id
       WHERE ut.id = :ticketId AND ut.user_id = :userId
       FOR UPDATE`, { ticketId: userTicketId, userId: holderUserId });
        const ticket = tickets[0];
        if (!ticket)
            throw new Error("Ticket not found");
        const listingId = String(session.listing_id);
        if (String(ticket.listing_id) !== listingId) {
            await logSelfCheckinEvent(conn, {
                sessionId: parsed.sessionId,
                listingId,
                userTicketId,
                holderUserId,
                holderName: String(ticket.full_name),
                reference: String(ticket.reference),
                result: "rejected",
                rejectReason: "Ticket is for a different event",
            });
            await conn.commit();
            return {
                success: false,
                message: "This ticket is not valid for this gate",
                ticketStatus: String(ticket.status),
            };
        }
        if (ticket.status === "used") {
            await logSelfCheckinEvent(conn, {
                sessionId: parsed.sessionId,
                listingId,
                userTicketId,
                holderUserId,
                holderName: String(ticket.full_name),
                reference: String(ticket.reference),
                result: "rejected",
                rejectReason: "Ticket already used",
            });
            await conn.commit();
            return {
                success: false,
                message: "This ticket has already been used",
                ticketStatus: "used",
            };
        }
        if (ticket.status !== "active") {
            await logSelfCheckinEvent(conn, {
                sessionId: parsed.sessionId,
                listingId,
                userTicketId,
                holderUserId,
                holderName: String(ticket.full_name),
                reference: String(ticket.reference),
                result: "rejected",
                rejectReason: `Ticket status: ${ticket.status}`,
            });
            await conn.commit();
            return {
                success: false,
                message: "This ticket is not active",
                ticketStatus: String(ticket.status),
            };
        }
        await conn.query(`UPDATE user_tickets SET status = 'used', verified_at = NOW(), verified_by_user_id = :userId
       WHERE id = :id`, { id: userTicketId, userId: holderUserId });
        await conn.query(`INSERT INTO ticket_verifications (
        id, user_ticket_id, listing_id, verified_by_user_id, method, result, reference
      ) VALUES (
        :id, :ticketId, :listingId, :verifiedBy, 'self_checkin', 'accepted', :reference
      )`, {
            id: uuid(),
            ticketId: userTicketId,
            listingId,
            verifiedBy: holderUserId,
            reference: ticket.reference,
        });
        await logSelfCheckinEvent(conn, {
            sessionId: parsed.sessionId,
            listingId,
            userTicketId,
            holderUserId,
            holderName: String(ticket.full_name),
            reference: String(ticket.reference),
            result: "accepted",
        });
        await conn.commit();
        return {
            success: true,
            message: "Check-in successful — your ticket is now marked as used.",
            ticketStatus: "used",
            ticket: {
                reference: ticket.reference,
                listingTitle: ticket.listing_title,
            },
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
async function logSelfCheckinEvent(conn, input) {
    await conn.query(`INSERT INTO self_checkin_events (
      id, session_id, listing_id, user_ticket_id, holder_user_id, holder_name,
      ticket_reference, result, reject_reason
    ) VALUES (
      :id, :sessionId, :listingId, :ticketId, :holderId, :holderName,
      :reference, :result, :rejectReason
    )`, {
        id: uuid(),
        sessionId: input.sessionId,
        listingId: input.listingId,
        ticketId: input.userTicketId,
        holderId: input.holderUserId,
        holderName: input.holderName,
        reference: input.reference,
        result: input.result,
        rejectReason: input.rejectReason ?? null,
    });
}
