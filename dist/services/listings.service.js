import { v4 as uuidv4, v5 as uuidv5 } from "uuid";
import { pool } from "../db/pool.js";
import { getCapacityInfo, getSoldCount, PUBLIC_VISIBILITY_SQL, syncListingSoldOutStatus, } from "./capacity.service.js";
import { getOrganizerProfile } from "./organizer.service.js";
import * as emailService from "./email.service.js";
import * as refundService from "./refund.service.js";
import { replaceListingImageIfManaged } from "./image-upload.service.js";
import { isManagedImagePath } from "../config/images.js";
import { assertOrganizerCanMutate, containsExplicitContent, getOrganizerModerationState, suspendOrganizerForContent, } from "./moderation.service.js";
import { formatSqlDate, parseEventDateInput } from "../utils/dates.js";
import { assertListingLocation } from "../utils/malawi-locations.js";
import * as ticketTiersService from "./ticket-tiers.service.js";
function formatEventDateLabel(isoDate) {
    const d = new Date(`${isoDate.slice(0, 10)}T12:00:00`);
    return d.toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
    });
}
function assertOrganizerKindAllowed(partnerType, kind) {
    const pt = partnerType ?? "events";
    if (pt === "events" && kind === "travel") {
        throw new Error("Your organizer account is for events only");
    }
    if (pt === "travel" && kind === "event") {
        throw new Error("Your organizer account is for travel only");
    }
}
async function enrichListingCapacity(row, listing) {
    const info = await getCapacityInfo(row.id, row.kind, row.ticket_capacity ?? null);
    return {
        ...listing,
        ticketCapacity: info.ticketCapacity,
        soldCount: info.soldCount,
        remainingTickets: info.remaining,
    };
}
async function enrichOrganizerModeration(organizerId, listing) {
    const mod = await getOrganizerModerationState(organizerId);
    return {
        ...listing,
        organizerId,
        organizerFlagged: mod.flagged,
        organizerFlagReason: mod.flagReason,
        organizerStatus: mod.status,
    };
}
async function attachTicketTiers(row, listing) {
    if (row.kind !== "event")
        return listing;
    try {
        let tiers = await ticketTiersService.listTiersForListing(row.id);
        if (tiers.length === 0) {
            const fallbackPrice = Number(row.price_mwk) || Number(listing.price) || 1;
            tiers = await ticketTiersService.ensureDefaultTierForListing(row.id, fallbackPrice);
        }
        if (tiers.length > 0) {
            return {
                ...listing,
                price: Math.min(...tiers.map((t) => t.priceMwk)),
                ticketTiers: tiers,
            };
        }
    }
    catch (err) {
        if (err instanceof Error && err.message.includes("doesn't exist")) {
            return listing;
        }
        throw err;
    }
    return listing;
}
export async function assertListingEventDateActive(listingId) {
    const [rows] = await pool.query(`SELECT kind, event_starts_on FROM listings WHERE id = :listingId LIMIT 1`, { listingId });
    const row = rows[0];
    if (!row || row.kind !== "event")
        return;
    if (!row.event_starts_on) {
        throw new Error("This event does not have a valid date.");
    }
    const [dateRows] = await pool.query(`SELECT (event_starts_on >= CURDATE()) AS isActive FROM listings WHERE id = :listingId`, { listingId });
    if (!dateRows[0]?.isActive) {
        throw new Error("This event has already passed and is no longer available.");
    }
}
async function mapListing(row, seats) {
    const listing = {
        id: row.id,
        kind: row.kind,
        title: row.title,
        subtitle: row.subtitle,
        category: row.category,
        date: row.date_label,
        eventStartsOn: formatSqlDate(row.event_starts_on),
        time: row.time_label,
        location: row.location,
        price: row.price_mwk,
        image: row.image_url,
        description: row.description,
        operator: {
            name: row.operator_name,
            tagline: row.operator_tagline,
            detail: row.operator_detail,
        },
        eventStatus: row.status,
        route: row.kind === "travel" && row.route_from
            ? { from: row.route_from, to: row.route_to, duration: row.route_duration }
            : undefined,
    };
    if (row.kind === "travel" && seats && seats.length > 0) {
        const meta = seats[0];
        const withCapacity = await enrichListingCapacity(row, {
            ...listing,
            seatLayout: {
                totalSeats: Number(meta.total_seats ?? seats.length),
                gridCols: Number(meta.grid_cols ?? 6),
                gridRows: Number(meta.grid_rows ?? 6),
                driverSide: (meta.driver_side === "right" ? "right" : "left"),
                seats: seats.map((s) => ({
                    id: String(s.seat_number),
                    number: s.seat_number,
                    status: s.status,
                    customerName: s.customer_name ?? undefined,
                    row: s.grid_row,
                    col: s.grid_col,
                })),
            },
        });
        const withTiers = await attachTicketTiers(row, withCapacity);
        return enrichOrganizerModeration(row.organizer_id, withTiers);
    }
    const withCapacity = await enrichListingCapacity(row, listing);
    const withTiers = await attachTicketTiers(row, withCapacity);
    return enrichOrganizerModeration(row.organizer_id, withTiers);
}
export async function listPublished(kind) {
    let sql = `SELECT * FROM listings WHERE ${PUBLIC_VISIBILITY_SQL}`;
    const params = {};
    if (kind) {
        sql += ` AND kind = :kind`;
        params.kind = kind;
    }
    sql += ` ORDER BY created_at DESC`;
    const [rows] = await pool.query(sql, params);
    const listings = [];
    for (const r of rows) {
        listings.push(await mapListing(r));
    }
    return listings;
}
/** Upcoming published events whose venue location mentions the given city/town. */
export async function listEventsInCity(city, limit = 6) {
    const place = String(city ?? "").trim();
    if (!place)
        return [];
    const safeLimit = Math.min(Math.max(limit, 1), 12);
    const sql = `SELECT * FROM listings
    WHERE ${PUBLIC_VISIBILITY_SQL}
      AND kind = 'event'
      AND LOWER(location) LIKE :pattern
      AND (event_starts_on IS NULL OR event_starts_on >= CURDATE())
    ORDER BY event_starts_on ASC, created_at DESC
    LIMIT ${safeLimit}`;
    const [rows] = await pool.query(sql, {
        pattern: `%${place.toLowerCase()}%`,
    });
    const listings = [];
    for (const r of rows) {
        listings.push(await mapListing(r));
    }
    return listings;
}
export async function getListingById(id, includeDraft = false) {
    let sql = `SELECT * FROM listings WHERE id = :id`;
    if (!includeDraft)
        sql += ` AND ${PUBLIC_VISIBILITY_SQL}`;
    const [rows] = await pool.query(sql, { id });
    const row = rows[0];
    if (!row)
        return null;
    if (row.kind === "travel") {
        const [seatRows] = await pool.query(`SELECT s.*, sl.total_seats, sl.grid_cols, sl.grid_rows, sl.driver_side
       FROM seats s
       JOIN seat_layouts sl ON sl.id = s.layout_id
       WHERE sl.listing_id = :id
       ORDER BY s.seat_number`, { id });
        return mapListing(row, seatRows);
    }
    return mapListing(row);
}
export async function getOrganizerListings(organizerId) {
    const [rows] = await pool.query(`SELECT * FROM listings WHERE organizer_id = :organizerId ORDER BY updated_at DESC`, { organizerId });
    const listings = [];
    for (const row of rows) {
        if (row.kind === "travel") {
            const full = await getListingById(row.id, true);
            if (full)
                listings.push(full);
        }
        else {
            listings.push(await mapListing(row));
        }
    }
    return listings;
}
export async function upsertListing(organizerId, body) {
    const id = String(body.id ?? body.slug ?? "");
    const kind = body.kind;
    await assertOrganizerCanMutate(organizerId);
    const profile = await getOrganizerProfile(organizerId);
    assertOrganizerKindAllowed(profile?.partnerType, kind);
    const title = String(body.title ?? "");
    const subtitle = String(body.subtitle ?? "");
    const description = String(body.description ?? "");
    if (containsExplicitContent(title, subtitle, description)) {
        await suspendOrganizerForContent(organizerId, title || id);
        throw new Error("Listing contains explicit or prohibited language. Your organizer account has been suspended pending review.");
    }
    const [existingRows] = await pool.query(`SELECT status, ticket_capacity, image_url FROM listings WHERE id = :id AND organizer_id = :organizerId`, { id, organizerId });
    const existing = existingRows[0];
    const nextImageUrl = String(body.image ?? body.imageUrl ?? "");
    if (!nextImageUrl.trim()) {
        throw new Error("Cover image is required. Upload an image for this listing.");
    }
    if (isManagedImagePath(nextImageUrl) &&
        !nextImageUrl.includes(`/image-bucket-folder/${organizerId}/`)) {
        throw new Error("Invalid cover image path");
    }
    await replaceListingImageIfManaged(organizerId, existing?.image_url, nextImageUrl);
    const rawCapacity = body.ticketCapacity ?? body.ticket_capacity;
    const ticketCapacity = rawCapacity != null && rawCapacity !== "" ? Number(rawCapacity) : null;
    const parsedCapacity = ticketCapacity != null && Number.isFinite(ticketCapacity) && ticketCapacity > 0
        ? ticketCapacity
        : null;
    let status = String(body.eventStatus ?? body.status ?? existing?.status ?? "draft");
    if (status === "postponed" && existing?.status !== "postponed") {
        throw new Error("Use the Postpone status action to enter a new date and notify ticket holders.");
    }
    if (status === "cancelled" && existing?.status !== "cancelled") {
        throw new Error("Use the Cancel status action to process refunds and notify ticket holders.");
    }
    const soldCount = await getSoldCount(id, kind);
    if (parsedCapacity != null && soldCount < parsedCapacity && status === "sold_out") {
        status = "published";
    }
    const eventStartsOn = parseEventDateInput(body.eventStartsOn ?? body.event_starts_on);
    let dateLabel = String(body.date ?? body.dateLabel ?? "").trim();
    if (kind === "event" && (status === "published" || status === "sold_out")) {
        if (!eventStartsOn) {
            throw new Error("Event date is required before publishing. Set the event / trip date field.");
        }
        const [dateRows] = await pool.query(`SELECT (:eventStartsOn >= CURDATE()) AS isValid`, { eventStartsOn });
        if (!dateRows[0]?.isValid) {
            throw new Error("Event date must be today or in the future.");
        }
        if (!dateLabel) {
            dateLabel = formatEventDateLabel(eventStartsOn);
        }
    }
    const rawTiers = body.ticketTiers;
    const priceMwk = Number(body.price ?? 0);
    const location = String(body.location ?? "").trim();
    const routeFrom = body.route?.from ?? null;
    const routeTo = body.route?.to ?? null;
    assertListingLocation(kind, status, location, routeFrom, routeTo);
    await pool.query(`INSERT INTO listings (
      id, organizer_id, kind, title, subtitle, category, date_label, event_starts_on, ticket_capacity,
      time_label, location,
      price_mwk, image_url, description, operator_name, operator_tagline, operator_detail,
      route_from, route_to, route_duration, status
    ) VALUES (
      :id, :organizerId, :kind, :title, :subtitle, :category, :dateLabel, :eventStartsOn, :ticketCapacity,
      :timeLabel, :location,
      :priceMwk, :imageUrl, :description, :operatorName, :operatorTagline, :operatorDetail,
      :routeFrom, :routeTo, :routeDuration, :status
    )
    ON DUPLICATE KEY UPDATE
      title = VALUES(title), subtitle = VALUES(subtitle), category = VALUES(category),
      date_label = VALUES(date_label), event_starts_on = VALUES(event_starts_on),
      ticket_capacity = VALUES(ticket_capacity),
      time_label = VALUES(time_label), location = VALUES(location),
      price_mwk = VALUES(price_mwk), image_url = VALUES(image_url), description = VALUES(description),
      operator_name = VALUES(operator_name), operator_tagline = VALUES(operator_tagline),
      operator_detail = VALUES(operator_detail), route_from = VALUES(route_from),
      route_to = VALUES(route_to), route_duration = VALUES(route_duration), status = VALUES(status)`, {
        id,
        organizerId,
        kind,
        title: String(body.title ?? ""),
        subtitle: String(body.subtitle ?? ""),
        category: String(body.category ?? ""),
        dateLabel,
        eventStartsOn,
        ticketCapacity: parsedCapacity,
        timeLabel: String(body.time ?? body.timeLabel ?? ""),
        location,
        priceMwk,
        imageUrl: nextImageUrl,
        description: String(body.description ?? ""),
        operatorName: String(body.operator?.name ?? body.operatorName ?? ""),
        operatorTagline: String(body.operator?.tagline ?? body.operatorTagline ?? ""),
        operatorDetail: String(body.operator?.detail ?? body.operatorDetail ?? ""),
        routeFrom,
        routeTo,
        routeDuration: body.route?.duration ?? null,
        status,
    });
    if (kind === "travel") {
        const layout = body.seatLayout;
        const seatList = layout?.seats ?? [];
        if (!layout || seatList.length === 0) {
            throw new Error("Travel listings require a seat layout with at least one seat");
        }
        await saveSeatLayout(id, layout);
    }
    else {
        try {
            const tiers = await ticketTiersService.saveTiersForListing(id, kind, rawTiers, priceMwk > 0 ? priceMwk : 1);
            if (tiers.length > 0) {
                const minPrice = Math.min(...tiers.map((t) => t.priceMwk));
                await pool.query(`UPDATE listings SET price_mwk = :price WHERE id = :id`, {
                    id,
                    price: minPrice,
                });
            }
        }
        catch (err) {
            if (err instanceof Error && err.message.includes("doesn't exist")) {
                throw new Error("Ticket types are not enabled on the database yet. Run: npm run db:migrate:tiers");
            }
            throw err;
        }
    }
    if (status === "published" || status === "sold_out") {
        await syncListingSoldOutStatus(id, kind, parsedCapacity);
    }
    return getListingById(id, true);
}
function resolveSeatNumber(seat, index, usedNumbers) {
    const raw = seat.number ?? seat.seatNumber ?? seat.id;
    let seatNumber = Number(raw);
    if (!Number.isFinite(seatNumber) || seatNumber <= 0) {
        seatNumber = index + 1;
    }
    while (usedNumbers.has(seatNumber)) {
        seatNumber += 1;
    }
    usedNumbers.add(seatNumber);
    return seatNumber;
}
const SEAT_LAYOUT_NAMESPACE = "fb3ddf5c-2b3c-4e15-9f21-7c39b45e2d01";
/** Stable 36-char layout id (fits seats.id CHAR(36); long listing ids must not be embedded). */
function layoutIdForListing(listingId) {
    return uuidv5(`seat-layout:${listingId}`, SEAT_LAYOUT_NAMESPACE);
}
export async function saveSeatLayout(listingId, layout) {
    const layoutId = layoutIdForListing(listingId);
    const seats = layout.seats ?? [];
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        // Drop prior layouts/seats (including rows created with truncated string ids).
        const [priorLayouts] = await conn.query(`SELECT id FROM seat_layouts WHERE listing_id = :listingId`, { listingId });
        for (const row of priorLayouts) {
            await conn.query(`DELETE FROM seats WHERE layout_id = :layoutId`, {
                layoutId: row.id,
            });
        }
        await conn.query(`DELETE FROM seat_layouts WHERE listing_id = :listingId`, {
            listingId,
        });
        const driverSide = layout.driverSide === "right" ? "right" : "left";
        await conn.query(`INSERT INTO seat_layouts (id, listing_id, total_seats, grid_cols, grid_rows, driver_side)
       VALUES (:id, :listingId, :totalSeats, :gridCols, :gridRows, :driverSide)`, {
            id: layoutId,
            listingId,
            totalSeats: Number(layout.totalSeats ?? seats.length),
            gridCols: Number(layout.gridCols ?? 6),
            gridRows: Number(layout.gridRows ?? 6),
            driverSide,
        });
        const usedNumbers = new Set();
        for (let i = 0; i < seats.length; i++) {
            const seat = seats[i];
            const seatNumber = resolveSeatNumber(seat, i, usedNumbers);
            const gridRow = Number(seat.row ?? 0);
            const gridCol = Number(seat.col ?? 0);
            const id = uuidv4();
            await conn.query(`INSERT INTO seats (id, layout_id, seat_number, grid_row, grid_col, status, customer_name)
         VALUES (:id, :layoutId, :seatNumber, :gridRow, :gridCol, :status, :customerName)`, {
                id,
                layoutId,
                seatNumber,
                gridRow,
                gridCol,
                status: String(seat.status === "selected" ? "available" : seat.status ?? "available"),
                customerName: seat.customerName ? String(seat.customerName) : null,
            });
        }
        await conn.commit();
    }
    catch (err) {
        await conn.rollback();
        throw err;
    }
    finally {
        conn.release();
    }
}
export async function listingBelongsToOrganizer(listingId, organizerId) {
    const [rows] = await pool.query(`SELECT id FROM listings WHERE id = :listingId AND organizer_id = :organizerId`, { listingId, organizerId });
    return !!rows[0];
}
export async function updateSeatStatus(listingId, organizerId, seatNumber, status) {
    const [listingRows] = await pool.query(`SELECT id, kind FROM listings WHERE id = :listingId AND organizer_id = :organizerId`, { listingId, organizerId });
    const listing = listingRows[0];
    if (!listing)
        throw new Error("Listing not found");
    if (listing.kind !== "travel")
        throw new Error("Seat management is only for travel listings");
    const [seatRows] = await pool.query(`SELECT s.id, s.status FROM seats s
     JOIN seat_layouts sl ON sl.id = s.layout_id
     WHERE sl.listing_id = :listingId AND s.seat_number = :seatNumber`, { listingId, seatNumber });
    const seat = seatRows[0];
    if (!seat)
        throw new Error("Seat not found");
    if (seat.status === "taken") {
        throw new Error("Sold seats cannot be changed. Only unsold seats can be marked unavailable.");
    }
    await pool.query(`UPDATE seats SET status = :status WHERE id = :seatId`, { seatId: seat.id, status });
    return getListingById(listingId, true);
}
export async function postponeListing(id, organizerId, input) {
    await assertOrganizerCanMutate(organizerId);
    const [listingRows] = await pool.query(`SELECT id, title, kind, location, date_label, time_label, operator_name
     FROM listings WHERE id = :id AND organizer_id = :organizerId`, { id, organizerId });
    const listing = listingRows[0];
    if (!listing)
        return null;
    const eventStartsOn = String(input.eventStartsOn).slice(0, 10);
    const [dateRows] = await pool.query(`SELECT (:eventStartsOn >= CURDATE()) AS isValid`, { eventStartsOn });
    if (!dateRows[0]?.isValid) {
        throw new Error("New event date must be today or in the future");
    }
    const previousDateLabel = String(listing.date_label);
    const dateLabel = input.dateLabel?.trim() || formatEventDateLabel(eventStartsOn);
    const timeLabel = input.timeLabel?.trim() || String(listing.time_label);
    await pool.query(`UPDATE listings
     SET status = 'postponed', event_starts_on = :eventStartsOn,
         date_label = :dateLabel, time_label = :timeLabel
     WHERE id = :id AND organizer_id = :organizerId`, { id, organizerId, eventStartsOn, dateLabel, timeLabel });
    const [ticketResult] = await pool.query(`UPDATE user_tickets SET status = 'active'
     WHERE listing_id = :id AND status = 'expired'`, { id });
    const reactivatedTickets = ticketResult.affectedRows ?? 0;
    try {
        await emailService.sendListingPostponedEmails({
            listingId: id,
            listingTitle: String(listing.title),
            kind: String(listing.kind),
            location: String(listing.location),
            timeLabel,
            previousDateLabel,
            newDateLabel: dateLabel,
            organizerName: String(listing.operator_name),
        });
    }
    catch (err) {
        console.error("[email] listing postponed notifications failed:", err);
    }
    return {
        status: "postponed",
        eventStartsOn,
        dateLabel,
        timeLabel,
        reactivatedTickets,
    };
}
export async function cancelListing(id, organizerId) {
    await assertOrganizerCanMutate(organizerId);
    const [listingRows] = await pool.query(`SELECT l.id, l.title, l.status, l.kind, op.company_name, u.email AS organizer_email
     FROM listings l
     JOIN organizer_profiles op ON op.user_id = l.organizer_id
     JOIN users u ON u.id = l.organizer_id
     WHERE l.id = :id AND l.organizer_id = :organizerId`, { id, organizerId });
    const listing = listingRows[0];
    if (!listing)
        return null;
    if (String(listing.status) === "cancelled") {
        throw new Error("This listing is already cancelled");
    }
    await pool.query(`UPDATE listings SET status = 'cancelled' WHERE id = :id AND organizer_id = :organizerId`, { id, organizerId });
    const [fundRows] = await pool.query(`SELECT COALESCE(SUM(o.subtotal_mwk), 0) AS held
     FROM orders o
     WHERE o.listing_id = :id AND o.status IN ('confirmed', 'refunded')`, { id });
    const fundsHeld = Number(fundRows[0]?.held ?? 0);
    const refunds = await refundService.processListingCancellationRefunds(id, organizerId, fundsHeld);
    try {
        await emailService.sendListingCancelledOrganizerEmail({
            email: String(listing.organizer_email),
            companyName: String(listing.company_name),
            listingTitle: String(listing.title),
            ticketsReviewed: refunds.ticketsReviewed,
            refundsCompleted: refunds.completed,
            refundsPending: refunds.skipped,
            totalRefunded: refunds.totalRefunded,
            fundsHeld,
            debtIncrease: refunds.debtIncrease,
            coveredByHold: refunds.coveredByHold,
        });
    }
    catch (err) {
        console.error("[email] listing cancelled organizer notification failed:", err);
    }
    return {
        status: "cancelled",
        refunds,
        fundsHeld,
    };
}
export async function updateListingStatus(id, organizerId, status) {
    await assertOrganizerCanMutate(organizerId);
    const [result] = await pool.query(`UPDATE listings SET status = :status WHERE id = :id AND organizer_id = :organizerId`, { id, organizerId, status });
    const updated = result.affectedRows > 0;
    if (!updated)
        return false;
    if (status === "published" || status === "sold_out") {
        const [rows] = await pool.query(`SELECT kind, ticket_capacity FROM listings WHERE id = :id`, { id });
        const row = rows[0];
        if (row) {
            await syncListingSoldOutStatus(id, row.kind, row.ticket_capacity != null ? Number(row.ticket_capacity) : null);
        }
    }
    return true;
}
export async function deleteListing(id, organizerId) {
    const [listingRows] = await pool.query(`SELECT id FROM listings WHERE id = :id AND organizer_id = :organizerId`, { id, organizerId });
    if (!listingRows[0])
        return false;
    const [orderRows] = await pool.query(`SELECT COUNT(*) AS cnt FROM orders WHERE listing_id = :id`, { id });
    const orderCount = Number(orderRows[0]?.cnt ?? 0);
    if (orderCount > 0) {
        throw new Error("This listing has ticket sales and cannot be deleted. Change its status to Cancelled to stop new sales while keeping purchase records.");
    }
    const [result] = await pool.query(`DELETE FROM listings WHERE id = :id AND organizer_id = :organizerId`, { id, organizerId });
    return result.affectedRows > 0;
}
