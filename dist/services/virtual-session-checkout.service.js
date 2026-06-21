import { pool } from "../db/pool.js";
import * as ticketTiersService from "./ticket-tiers.service.js";
export function computeUniformSessionUnitPrice(tierPriceMwk, activeSessionCount) {
    if (activeSessionCount <= 0)
        return tierPriceMwk;
    return Math.floor(tierPriceMwk / activeSessionCount);
}
export function computeSelectedSessionsSubtotal(input) {
    const activeSessions = input.sessions.filter((s) => s.status !== "cancelled");
    const selected = activeSessions.filter((s) => input.selectedSessionIds.includes(s.id));
    if (selected.length === 0) {
        throw new Error("Select at least one session to purchase.");
    }
    if (input.pricingMode === "per_session") {
        const total = selected.reduce((sum, s) => sum + Math.max(0, Number(s.price_mwk ?? 0)), 0);
        if (total <= 0) {
            throw new Error("Selected sessions must have a price greater than zero.");
        }
        return total;
    }
    const unit = computeUniformSessionUnitPrice(input.tierPriceMwk, activeSessions.length);
    if (unit <= 0) {
        throw new Error("Set a ticket price greater than zero for this virtual event.");
    }
    return unit * selected.length;
}
export async function listListingVirtualSessions(listingId) {
    try {
        const [rows] = await pool.query(`SELECT id, title, starts_at, ends_at, meeting_url, price_mwk, status
       FROM virtual_event_sessions
       WHERE listing_id = :listingId
       ORDER BY session_index ASC`, { listingId });
        return rows;
    }
    catch (err) {
        if (err instanceof Error && err.message.includes("doesn't exist"))
            return [];
        throw err;
    }
}
export async function resolveVirtualCheckoutPricing(listing, input) {
    const isOngoingVirtual = listing.kind === "event" &&
        listing.eventFormat === "virtual" &&
        (listing.virtualEventType ?? "one_time") === "ongoing";
    const buyMode = listing.virtualBuyMode ?? "bundle_only";
    if (!isOngoingVirtual) {
        return {
            virtualSessionSelection: false,
            lineCount: input.qty,
            unitPrice: Number(listing.price),
            selectedSessionIds: [],
            enrollAllSessions: false,
        };
    }
    const sessions = await listListingVirtualSessions(listing.id);
    const activeSessions = sessions.filter((s) => s.status !== "cancelled");
    if (activeSessions.length === 0) {
        throw new Error("This virtual event has no purchasable sessions yet.");
    }
    let tierPrice = Number(listing.price);
    const tiers = listing.ticketTiers ?? [];
    if (tiers.length > 0) {
        let tierId = input.tierId?.trim() || undefined;
        if (!tierId && tiers.length === 1)
            tierId = tiers[0]?.id;
        if (!tierId)
            throw new Error("Select a ticket type to continue.");
        const tier = await ticketTiersService.resolveTier(listing.id, tierId);
        if (!tier)
            throw new Error("Ticket type not found");
        tierPrice = tier.priceMwk;
    }
    if (buyMode === "allow_session_selection") {
        const selectedSessionIds = (input.virtualSessionIds ?? []).filter(Boolean);
        if (selectedSessionIds.length === 0) {
            throw new Error("Select at least one session to purchase.");
        }
        const validIds = new Set(activeSessions.map((s) => s.id));
        for (const id of selectedSessionIds) {
            if (!validIds.has(id)) {
                throw new Error("One or more selected sessions are no longer available.");
            }
        }
        const subtotal = computeSelectedSessionsSubtotal({
            pricingMode: listing.virtualPricingMode ?? "uniform",
            tierPriceMwk: tierPrice,
            sessions,
            selectedSessionIds,
        });
        return {
            virtualSessionSelection: true,
            lineCount: 1,
            unitPrice: subtotal,
            selectedSessionIds,
            enrollAllSessions: false,
        };
    }
    return {
        virtualSessionSelection: false,
        lineCount: input.qty,
        unitPrice: tierPrice,
        selectedSessionIds: activeSessions.map((s) => s.id),
        enrollAllSessions: true,
    };
}
export async function enrollUserTicketVirtualSessions(conn, userTicketId, sessionIds) {
    if (sessionIds.length === 0)
        return;
    const { v4: uuid } = await import("uuid");
    for (const sessionId of sessionIds) {
        await conn.query(`INSERT INTO user_ticket_virtual_sessions (id, user_ticket_id, session_id)
       VALUES (:id, :userTicketId, :sessionId)`, { id: uuid(), userTicketId, sessionId });
    }
}
export async function getPurchasedVirtualSeriesEndAt(userTicketId, listingId, buyMode) {
    let sessions = await listEnrolledVirtualSessions(userTicketId);
    if (sessions.length === 0 && buyMode === "bundle_only") {
        sessions = await listListingVirtualSessions(listingId);
    }
    const active = sessions.filter((s) => s.status !== "cancelled");
    if (active.length === 0)
        return null;
    let maxEndMs = 0;
    for (const session of active) {
        const endMs = new Date(session.ends_at).getTime();
        if (Number.isFinite(endMs) && endMs > maxEndMs)
            maxEndMs = endMs;
    }
    return maxEndMs > 0 ? new Date(maxEndMs) : null;
}
export async function isPurchasedVirtualSeriesEnded(userTicketId, listingId, buyMode, now = new Date()) {
    const endAt = await getPurchasedVirtualSeriesEndAt(userTicketId, listingId, buyMode);
    if (!endAt)
        return false;
    return now > endAt;
}
export async function listEnrolledVirtualSessions(userTicketId) {
    try {
        const [rows] = await pool.query(`SELECT s.id, s.title, s.starts_at, s.ends_at, s.meeting_url, s.price_mwk, s.status, s.session_index
       FROM user_ticket_virtual_sessions utvs
       JOIN virtual_event_sessions s ON s.id = utvs.session_id
       WHERE utvs.user_ticket_id = :userTicketId
       ORDER BY s.session_index ASC`, { userTicketId });
        return rows;
    }
    catch (err) {
        if (err instanceof Error && err.message.includes("doesn't exist"))
            return [];
        throw err;
    }
}
