import { v4 as uuid } from "uuid";
import { pool } from "../db/pool.js";
function normalizeCode(raw) {
    return raw.trim().toLowerCase().replace(/\s+/g, "-");
}
function mapReferral(row) {
    return {
        id: row.id,
        organizerId: row.organizer_id,
        listingId: row.listing_id,
        code: row.code,
        name: row.name,
        type: row.type,
        cutPercent: Number(row.cut_percent),
        referrerUserId: row.referrer_user_id ?? null,
        referrerEmail: row.referrer_email ?? null,
        referrerName: row.referrer_name ?? null,
        listingTitle: row.listing_title,
        status: row.status,
        createdAt: String(row.created_at),
    };
}
const REFERRAL_SELECT = `
  SELECT lr.*, l.title AS listing_title,
         u.email AS referrer_email, u.full_name AS referrer_name
  FROM listing_referrals lr
  JOIN listings l ON l.id = lr.listing_id
  LEFT JOIN users u ON u.id = lr.referrer_user_id`;
export async function listOrganizerReferrals(organizerId) {
    const [rows] = await pool.query(`${REFERRAL_SELECT}
     WHERE lr.organizer_id = :organizerId
     ORDER BY lr.created_at DESC`, { organizerId });
    return rows.map(mapReferral);
}
export async function searchReferrerByEmail(email) {
    const [rows] = await pool.query(`SELECT id, email, full_name, role FROM users
     WHERE LOWER(email) = LOWER(:email) AND role = 'customer' LIMIT 1`, { email: email.trim() });
    const row = rows[0];
    if (!row)
        return null;
    return {
        id: row.id,
        email: row.email,
        fullName: row.full_name,
    };
}
async function ensureReferrerProfile(userId) {
    await pool.query(`INSERT IGNORE INTO referrer_profiles (user_id) VALUES (:userId)`, { userId });
}
export async function createReferral(organizerId, input) {
    const code = normalizeCode(input.name);
    if (!code || code.length < 2)
        throw new Error("Referral name must be at least 2 characters");
    if (input.cutPercent < 1 || input.cutPercent > 50) {
        throw new Error("Revenue cut must be between 1% and 50%");
    }
    const [listingRows] = await pool.query(`SELECT id, title FROM listings WHERE id = :listingId AND organizer_id = :organizerId`, { listingId: input.listingId, organizerId });
    if (!listingRows[0])
        throw new Error("Listing not found");
    if (input.type !== "discount_only") {
        if (!input.referrerUserId) {
            throw new Error("A referrer user account is required for this referral type");
        }
        const [userRows] = await pool.query(`SELECT id, role FROM users WHERE id = :userId`, { userId: input.referrerUserId });
        const user = userRows[0];
        if (!user || user.role !== "customer") {
            throw new Error("Referrer must be a registered customer account");
        }
        await ensureReferrerProfile(input.referrerUserId);
    }
    const [dup] = await pool.query(`SELECT id FROM listing_referrals WHERE listing_id = :listingId AND code = :code`, { listingId: input.listingId, code });
    if (dup[0])
        throw new Error("A referral with this name already exists for this listing");
    const id = uuid();
    await pool.query(`INSERT INTO listing_referrals (
      id, organizer_id, listing_id, code, name, type, cut_percent, referrer_user_id, status
    ) VALUES (
      :id, :organizerId, :listingId, :code, :name, :type, :cutPercent, :referrerUserId, 'active'
    )`, {
        id,
        organizerId,
        listingId: input.listingId,
        code,
        name: input.name.trim(),
        type: input.type,
        cutPercent: input.cutPercent,
        referrerUserId: input.referrerUserId ?? null,
    });
    const [rows] = await pool.query(`${REFERRAL_SELECT} WHERE lr.id = :id`, { id });
    return mapReferral(rows[0]);
}
export async function setReferralStatus(organizerId, referralId, status) {
    const [result] = await pool.query(`UPDATE listing_referrals SET status = :status
     WHERE id = :id AND organizer_id = :organizerId`, { id: referralId, organizerId, status });
    if (result.affectedRows === 0) {
        throw new Error("Referral not found");
    }
    const [rows] = await pool.query(`${REFERRAL_SELECT} WHERE lr.id = :id`, { id: referralId });
    return mapReferral(rows[0]);
}
export async function deleteReferral(organizerId, referralId) {
    const [result] = await pool.query(`DELETE FROM listing_referrals WHERE id = :id AND organizer_id = :organizerId`, { id: referralId, organizerId });
    if (result.affectedRows === 0) {
        throw new Error("Referral not found");
    }
    return { deleted: true };
}
export function buildReferralLink(listingId, code, origin) {
    const base = (origin ?? "").replace(/\/$/, "") || "http://localhost:8000";
    return `${base}/checkout/${encodeURIComponent(listingId)}?ref=${encodeURIComponent(code)}`;
}
export async function listingHasActiveReferrals(listingId) {
    const [rows] = await pool.query(`SELECT 1 FROM listing_referrals WHERE listing_id = :listingId AND status = 'active' LIMIT 1`, { listingId });
    return rows.length > 0;
}
export async function resolveActiveReferral(listingId, code) {
    if (!code?.trim())
        return null;
    const normalized = normalizeCode(code);
    const [rows] = await pool.query(`${REFERRAL_SELECT}
     WHERE lr.listing_id = :listingId AND lr.code = :code AND lr.status = 'active'`, { listingId, code: normalized });
    const row = rows[0];
    return row ? mapReferral(row) : null;
}
export function computeReferralPricing(input) {
    const { catalogSubtotal, serviceFee, referral } = input;
    const cutAmount = Math.floor((catalogSubtotal * referral.cutPercent) / 100);
    let buyerDiscount = 0;
    let referrerCommission = 0;
    switch (referral.type) {
        case "split_both":
            buyerDiscount = cutAmount;
            referrerCommission = cutAmount;
            break;
        case "split_referrer":
            referrerCommission = cutAmount;
            break;
        case "discount_only":
            buyerDiscount = cutAmount;
            break;
    }
    const buyerSubtotal = catalogSubtotal - buyerDiscount;
    const organizerSubtotal = catalogSubtotal - buyerDiscount - referrerCommission;
    return {
        referralId: referral.id,
        referralCode: referral.code,
        referralType: referral.type,
        catalogSubtotal,
        buyerDiscount,
        referrerCommission,
        organizerSubtotal,
        buyerSubtotal,
        serviceFee,
        total: buyerSubtotal + serviceFee,
    };
}
export async function recordReferralEarning(input) {
    if (input.commissionMwk <= 0)
        return null;
    const id = uuid();
    await pool.query(`INSERT INTO referral_earnings (
      id, referral_id, order_id, referrer_user_id, listing_id,
      commission_mwk, buyer_discount_mwk, catalog_subtotal_mwk
    ) VALUES (
      :id, :referralId, :orderId, :referrerUserId, :listingId,
      :commission, :buyerDiscount, :catalogSubtotal
    )`, {
        id,
        referralId: input.referralId,
        orderId: input.orderId,
        referrerUserId: input.referrerUserId,
        listingId: input.listingId,
        commission: input.commissionMwk,
        buyerDiscount: input.buyerDiscountMwk,
        catalogSubtotal: input.catalogSubtotalMwk,
    });
    return id;
}
export async function userIsReferrer(userId) {
    const [rows] = await pool.query(`SELECT 1 FROM listing_referrals WHERE referrer_user_id = :userId LIMIT 1
     UNION
     SELECT 1 FROM referral_earnings WHERE referrer_user_id = :userId LIMIT 1`, { userId });
    return rows.length > 0;
}
