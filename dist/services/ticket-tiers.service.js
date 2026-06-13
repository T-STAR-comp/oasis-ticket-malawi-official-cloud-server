import { v4 as uuid } from "uuid";
import { pool } from "../db/pool.js";
export async function getTierSoldCount(tierId) {
    const [rows] = await pool.query(`SELECT COALESCE(SUM(oi.quantity), 0) AS cnt
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE oi.ticket_tier_id = :tierId AND o.status = 'confirmed'`, { tierId });
    return Number(rows[0]?.cnt ?? 0);
}
async function getTierPendingCount(tierId) {
    const [rows] = await pool.query(`SELECT COALESCE(SUM(
       CAST(JSON_UNQUOTE(JSON_EXTRACT(pl.checkout_meta, '$.lineCount')) AS UNSIGNED)
     ), 0) AS cnt
     FROM payment_ledger pl
     JOIN orders o ON o.id = pl.order_id
     WHERE pl.status = 'pending' AND o.status = 'pending'
       AND JSON_UNQUOTE(JSON_EXTRACT(pl.checkout_meta, '$.tierId')) = :tierId`, { tierId });
    return Number(rows[0]?.cnt ?? 0);
}
export async function enrichTier(row) {
    const soldCount = await getTierSoldCount(row.id);
    const pendingCount = await getTierPendingCount(row.id);
    const capacity = row.capacity != null ? Number(row.capacity) : null;
    const remaining = capacity != null ? Math.max(0, capacity - soldCount - pendingCount) : null;
    return {
        id: row.id,
        listingId: row.listing_id,
        name: row.name,
        description: row.description ?? undefined,
        priceMwk: Number(row.price_mwk),
        capacity,
        sortOrder: Number(row.sort_order),
        soldCount,
        remaining,
    };
}
export async function listTiersForListing(listingId) {
    const [rows] = await pool.query(`SELECT * FROM listing_ticket_tiers WHERE listing_id = :listingId ORDER BY sort_order ASC, created_at ASC`, { listingId });
    const tiers = [];
    for (const row of rows) {
        tiers.push(await enrichTier(row));
    }
    return tiers;
}
/** Backfill a Standard tier for listings saved before the tiers migration. */
export async function ensureDefaultTierForListing(listingId, priceMwk) {
    const existing = await listTiersForListing(listingId);
    if (existing.length > 0)
        return existing;
    const id = uuid();
    const price = Math.max(1, Math.floor(priceMwk));
    await pool.query(`INSERT INTO listing_ticket_tiers (
       id, listing_id, name, description, price_mwk, capacity, sort_order
     ) VALUES (
       :id, :listingId, 'Standard', NULL, :priceMwk, NULL, 0
     )`, { id, listingId, priceMwk: price });
    return listTiersForListing(listingId);
}
export async function resolveTier(listingId, tierId) {
    const [rows] = await pool.query(`SELECT * FROM listing_ticket_tiers WHERE id = :tierId AND listing_id = :listingId LIMIT 1`, { tierId, listingId });
    const row = rows[0];
    if (!row)
        return null;
    return enrichTier(row);
}
export async function assertTierCheckoutCapacity(tierId, requestedUnits) {
    const [rows] = await pool.query(`SELECT * FROM listing_ticket_tiers WHERE id = :tierId LIMIT 1`, { tierId });
    const row = rows[0];
    if (!row)
        throw new Error("Ticket type not found");
    const tier = await enrichTier(row);
    if (tier.capacity == null)
        return tier;
    const available = tier.remaining ?? 0;
    if (requestedUnits > available) {
        if (available <= 0) {
            throw new Error(`${tier.name} tickets are sold out.`);
        }
        throw new Error(`Only ${available} ${tier.name} ticket${available === 1 ? "" : "s"} remaining.`);
    }
    return tier;
}
export async function saveTiersForListing(listingId, kind, tiers, fallbackPrice) {
    if (kind !== "event") {
        await pool.query(`DELETE FROM listing_ticket_tiers WHERE listing_id = :listingId`, {
            listingId,
        });
        return [];
    }
    const normalized = tiers && tiers.length > 0
        ? tiers
        : [{ name: "Standard", priceMwk: fallbackPrice, sortOrder: 0 }];
    for (const tier of normalized) {
        if (!tier.name.trim())
            throw new Error("Each ticket type needs a name");
        if (!Number.isFinite(tier.priceMwk) || tier.priceMwk <= 0) {
            throw new Error(`Ticket type "${tier.name}" needs a price greater than zero`);
        }
    }
    const existing = await listTiersForListing(listingId);
    const keepIds = new Set();
    for (let i = 0; i < normalized.length; i++) {
        const tier = normalized[i];
        const existingMatch = tier.id ? existing.find((t) => t.id === tier.id) : undefined;
        const id = existingMatch ? existingMatch.id : uuid();
        keepIds.add(id);
        const capacity = tier.capacity != null && tier.capacity > 0 ? Math.floor(tier.capacity) : null;
        await pool.query(`INSERT INTO listing_ticket_tiers (
         id, listing_id, name, description, price_mwk, capacity, sort_order
       ) VALUES (
         :id, :listingId, :name, :description, :priceMwk, :capacity, :sortOrder
       )
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         description = VALUES(description),
         price_mwk = VALUES(price_mwk),
         capacity = VALUES(capacity),
         sort_order = VALUES(sort_order)`, {
            id,
            listingId,
            name: tier.name.trim(),
            description: tier.description?.trim() || null,
            priceMwk: Math.floor(tier.priceMwk),
            capacity,
            sortOrder: tier.sortOrder ?? i,
        });
    }
    for (const old of existing) {
        if (!keepIds.has(old.id)) {
            await pool.query(`DELETE FROM listing_ticket_tiers WHERE id = :id`, { id: old.id });
        }
    }
    return listTiersForListing(listingId);
}
export function defaultTierFromListing(price) {
    return {
        id: "default",
        listingId: "",
        name: "Standard",
        priceMwk: price,
        capacity: null,
        sortOrder: 0,
        soldCount: 0,
        remaining: null,
    };
}
