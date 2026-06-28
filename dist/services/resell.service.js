import { v4 as uuid } from "uuid";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { assertVirtualTicketTransferAllowed } from "../utils/virtual-events.js";
import { getProfile } from "./auth.service.js";
import { getUserPendingLedger, parseCheckoutMeta, } from "./ledger.service.js";
import { initiateMobileMoneyCharge, verifyMobileMoneyCharge, } from "./paychangu.service.js";
import { makeReference } from "../utils/http.js";
import { getPaymentMethodForUser, maybeSavePaymentMethodFromCheckout, } from "./payment-methods.service.js";
import { normalizeMalawiPhone } from "../utils/phone.js";
import { computePlatformServiceFee, platformServiceFeePercent } from "../utils/platform-fee.js";
const SETTLEMENT_DAYS = 1;
function isMissingResellTableError(err) {
    return (err instanceof Error &&
        (err.message.includes("resell_listings") ||
            err.message.includes("doesn't exist") ||
            err.message.includes("Unknown table")));
}
function makeQrToken() {
    return uuid().replace(/-/g, "");
}
function makeChargeId(ledgerId) {
    return `TMRS${ledgerId.replace(/-/g, "").slice(0, 28)}`;
}
async function assertTicketResellable(userId, userTicketId) {
    const [rows] = await pool.query(`SELECT ut.*, l.status AS listing_status, l.kind, l.event_starts_on, l.event_format, l.time_label,
            op.status AS organizer_status, op.flagged_at,
            EXISTS (SELECT 1 FROM ticket_refunds tr WHERE tr.user_ticket_id = ut.id AND tr.status = 'pending') AS refund_pending,
            EXISTS (SELECT 1 FROM resell_listings rl WHERE rl.user_ticket_id = ut.id AND rl.status = 'active') AS already_listed
     FROM user_tickets ut
     JOIN listings l ON l.id = ut.listing_id
     JOIN organizer_profiles op ON op.user_id = l.organizer_id
     WHERE ut.id = :userTicketId AND ut.user_id = :userId
     LIMIT 1`, { userTicketId, userId });
    const t = rows[0];
    if (!t)
        throw new Error("Ticket not found");
    if (t.status !== "active")
        throw new Error("Only active tickets can be listed for resale");
    if (t.refund_pending)
        throw new Error("Tickets with pending refunds cannot be resold");
    if (t.already_listed)
        throw new Error("This ticket is already listed for resale");
    if (["suspended", "banned", "inactive"].includes(String(t.organizer_status))) {
        throw new Error("This ticket cannot be resold while the organizer is under review");
    }
    if (String(t.listing_status) === "cancelled") {
        throw new Error("Cancelled events cannot be resold");
    }
    assertVirtualTicketTransferAllowed({
        eventFormat: t.event_format,
        eventStartsOn: t.event_starts_on,
        timeLabel: t.time_label,
    });
    return t;
}
export async function listPublicResellListings() {
    try {
        const [rows] = await pool.query(`SELECT rl.*, l.title, l.subtitle, l.category, l.date_label, l.time_label, l.location,
              l.kind, l.image_url, l.operator_name, l.event_starts_on,
              ut.reference AS ticket_reference, ut.ticket_tier_name
       FROM resell_listings rl
       JOIN listings l ON l.id = rl.listing_id
       JOIN user_tickets ut ON ut.id = rl.user_ticket_id
       WHERE rl.status = 'active'
       ORDER BY rl.created_at DESC`);
        return rows.map((r) => ({
            id: r.id,
            priceMwk: Number(r.price_mwk),
            listingId: r.listing_id,
            title: r.title,
            subtitle: r.subtitle,
            category: r.category,
            date: r.date_label,
            time: r.time_label,
            location: r.location,
            kind: r.kind,
            image: r.image_url,
            operator: { name: r.operator_name },
            ticketTierName: r.ticket_tier_name ?? undefined,
            eventStartsOn: r.event_starts_on,
        }));
    }
    catch (err) {
        if (isMissingResellTableError(err)) {
            console.warn("[resell] Marketplace tables missing — run: npm run db:migrate:marketplace");
            return [];
        }
        throw err;
    }
}
export async function getPublicResellListing(resellId) {
    let rows;
    try {
        [rows] = await pool.query(`SELECT rl.*, l.title, l.subtitle, l.category, l.date_label, l.time_label, l.location,
              l.kind, l.image_url, l.description, l.operator_name, l.operator_tagline,
              l.event_starts_on, ut.ticket_tier_name
       FROM resell_listings rl
       JOIN listings l ON l.id = rl.listing_id
       JOIN user_tickets ut ON ut.id = rl.user_ticket_id
       WHERE rl.id = :resellId AND rl.status = 'active'
       LIMIT 1`, { resellId });
    }
    catch (err) {
        if (isMissingResellTableError(err))
            return null;
        throw err;
    }
    const r = rows[0];
    if (!r)
        return null;
    const priceMwk = Number(r.price_mwk);
    const serviceFeeMwk = computePlatformServiceFee(priceMwk);
    return {
        id: r.id,
        priceMwk,
        listingId: r.listing_id,
        title: r.title,
        subtitle: r.subtitle,
        category: r.category,
        date: r.date_label,
        time: r.time_label,
        location: r.location,
        kind: r.kind,
        image: r.image_url,
        description: r.description,
        operator: { name: r.operator_name, tagline: r.operator_tagline },
        ticketTierName: r.ticket_tier_name ?? undefined,
        serviceFeeMwk,
        serviceFeePercent: platformServiceFeePercent(),
        sellerReceivesMwk: priceMwk,
    };
}
export async function createResellListing(userId, userTicketId, priceMwk) {
    if (!Number.isFinite(priceMwk) || priceMwk < 500) {
        throw new Error("Resale price must be at least K500");
    }
    const ticket = await assertTicketResellable(userId, userTicketId);
    const id = uuid();
    await pool.query(`INSERT INTO resell_listings (id, user_ticket_id, seller_user_id, listing_id, price_mwk, status)
     VALUES (:id, :userTicketId, :sellerId, :listingId, :price, 'active')`, {
        id,
        userTicketId,
        sellerId: userId,
        listingId: ticket.listing_id,
        price: Math.floor(priceMwk),
    });
    const [rows] = await pool.query(`SELECT * FROM resell_listings WHERE id = :id`, { id });
    return rows[0];
}
export async function cancelResellListing(userId, resellListingId) {
    const [result] = await pool.query(`UPDATE resell_listings
     SET status = 'cancelled', cancelled_at = NOW()
     WHERE id = :id AND seller_user_id = :userId AND status = 'active'`, { id: resellListingId, userId });
    if (result.affectedRows === 0) {
        throw new Error("Resale listing not found or already sold");
    }
}
export async function getSellerResellFinance(userId) {
    const [sales] = await pool.query(`SELECT * FROM resell_sales WHERE seller_user_id = :userId ORDER BY created_at DESC`, { userId });
    const [payouts] = await pool.query(`SELECT * FROM reseller_payouts WHERE user_id = :userId ORDER BY requested_at DESC LIMIT 20`, { userId });
    const now = new Date();
    let settledAmount = 0;
    let pendingSettlement = 0;
    let withdrawable = 0;
    for (const s of sales) {
        const net = Number(s.seller_net_mwk);
        if (s.settlement_status === "settled") {
            settledAmount += net;
            const withdrawAt = s.withdrawable_at ? new Date(String(s.withdrawable_at)) : null;
            if (withdrawAt && withdrawAt <= now)
                withdrawable += net;
        }
        else if (s.settlement_status === "pending_settlement") {
            pendingSettlement += net;
        }
    }
    const paidOut = payouts
        .filter((p) => p.status === "completed")
        .reduce((sum, p) => sum + Number(p.amount_mwk), 0);
    const reserved = payouts
        .filter((p) => ["pending", "processing"].includes(String(p.status)))
        .reduce((sum, p) => sum + Number(p.amount_mwk), 0);
    withdrawable = Math.max(0, withdrawable - paidOut - reserved);
    const [activeListings] = await pool.query(`SELECT COUNT(*) AS cnt FROM resell_listings WHERE seller_user_id = :userId AND status = 'active'`, { userId });
    return {
        totalEarnings: sales.reduce((s, r) => s + Number(r.seller_net_mwk), 0),
        pendingSettlement,
        settledAmount,
        withdrawable,
        paidOut,
        reservedInPayouts: reserved,
        activeListings: Number(activeListings[0]?.cnt ?? 0),
        sales: sales.map((s) => ({
            id: s.id,
            salePriceMwk: Number(s.sale_price_mwk),
            sellerNetMwk: Number(s.seller_net_mwk),
            settlementStatus: s.settlement_status,
            withdrawableAt: s.withdrawable_at,
            createdAt: s.created_at,
        })),
        payouts: payouts.map((p) => ({
            id: p.id,
            amount: Number(p.amount_mwk),
            netAmount: Number(p.net_amount_mwk),
            fee: Number(p.fee_mwk),
            status: p.status,
            requestedAt: p.requested_at,
            completedAt: p.completed_at,
        })),
        payoutFeePercent: env.referrals.payoutFeePercent,
        settlementPolicy: "T+1",
    };
}
async function resolveCheckoutPhone(userId, input) {
    if (input.paymentMethodId) {
        const method = await getPaymentMethodForUser(userId, input.paymentMethodId);
        if (!method?.phoneNumber)
            throw new Error("Saved payment method not found");
        if (method.type !== input.paymentMethod) {
            throw new Error("Payment method type does not match selected operator");
        }
        return method.phoneNumber;
    }
    const phone = normalizeMalawiPhone(input.paymentPhone ?? "");
    if (!phone)
        throw new Error("Mobile money number is required");
    return phone;
}
export async function releaseResellListingHoldForOrder(orderId) {
    await pool.query(`UPDATE resell_listings
     SET status = 'active',
         pending_buyer_id = NULL,
         pending_order_id = NULL,
         pending_expires_at = NULL
     WHERE pending_order_id = :orderId AND status = 'pending_sale'`, { orderId });
}
export async function expireStaleResellListingHolds() {
    await pool.query(`UPDATE resell_listings rl
     SET rl.status = 'active',
         rl.pending_buyer_id = NULL,
         rl.pending_order_id = NULL,
         rl.pending_expires_at = NULL
     WHERE rl.status = 'pending_sale'
       AND rl.pending_expires_at IS NOT NULL
       AND rl.pending_expires_at < NOW()
       AND NOT EXISTS (
         SELECT 1 FROM payment_ledger pl
         WHERE pl.order_id = rl.pending_order_id AND pl.status = 'pending'
       )`);
}
export async function initiateResellCheckout(buyerId, resellListingId, input) {
    const listing = await getPublicResellListing(resellListingId);
    if (!listing)
        throw new Error("Resale listing not found or no longer available");
    const [rlRows] = await pool.query(`SELECT * FROM resell_listings WHERE id = :id AND status = 'active' LIMIT 1`, { id: resellListingId });
    const rl = rlRows[0];
    if (!rl)
        throw new Error("Resale listing not found");
    if (String(rl.seller_user_id) === buyerId) {
        throw new Error("You cannot buy your own resale listing");
    }
    const existingPending = await getUserPendingLedger(buyerId);
    if (existingPending) {
        throw new Error("You already have a payment in progress. Complete or wait for it to expire.");
    }
    const profile = await getProfile(buyerId);
    if (!profile)
        throw new Error("Account not found");
    const paymentPhone = await resolveCheckoutPhone(buyerId, input);
    const salePrice = Number(rl.price_mwk);
    const serviceFee = computePlatformServiceFee(salePrice);
    const total = salePrice + serviceFee;
    const orderId = uuid();
    const ledgerId = uuid();
    const reference = makeReference(String(rl.listing_id));
    const chargeId = makeChargeId(ledgerId);
    const timeoutSec = env.paychangu.pendingTimeoutSec;
    const checkoutMeta = {
        resellListingId,
        userTicketId: rl.user_ticket_id,
        sellerUserId: rl.seller_user_id,
        listingId: rl.listing_id,
        subtotal: salePrice,
        serviceFee,
        total,
        lineCount: 1,
    };
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [lockedRows] = await conn.query(`SELECT * FROM resell_listings WHERE id = :id AND status = 'active' FOR UPDATE`, { id: resellListingId });
        if (!lockedRows[0]) {
            throw new Error("Resale listing is no longer available");
        }
        await conn.query(`UPDATE resell_listings
       SET status = 'pending_sale',
           pending_buyer_id = :buyerId,
           pending_order_id = :orderId,
           pending_expires_at = DATE_ADD(NOW(), INTERVAL ${timeoutSec} SECOND)
       WHERE id = :id`, { buyerId, orderId, id: resellListingId });
        await conn.query(`INSERT INTO orders (
        id, user_id, listing_id, reference, status, subtotal_mwk, service_fee_mwk, total_mwk,
        payment_method, payment_phone, contact_name, contact_email, contact_phone
      ) VALUES (
        :orderId, :userId, :listingId, :reference, 'pending', 0, :serviceFee, :total,
        :paymentMethod, :paymentPhone, :contactName, :contactEmail, :contactPhone
      )`, {
            orderId,
            userId: buyerId,
            listingId: rl.listing_id,
            reference,
            serviceFee,
            total,
            paymentMethod: input.paymentMethod,
            paymentPhone,
            contactName: profile.full_name,
            contactEmail: profile.email,
            contactPhone: profile.phone ?? paymentPhone,
        });
        await conn.query(`INSERT INTO payment_ledger (
        id, user_id, order_id, status, paychangu_charge_id,
        amount_mwk, payment_method, payment_phone, account_name, account_email,
        checkout_meta, provider_status, expires_at
      ) VALUES (
        :ledgerId, :userId, :orderId, 'pending', :chargeId,
        :amount, :paymentMethod, :paymentPhone, :accountName, :accountEmail,
        :checkoutMeta, 'initiated', DATE_ADD(NOW(), INTERVAL ${timeoutSec} SECOND)
      )`, {
            ledgerId,
            userId: buyerId,
            orderId,
            chargeId,
            amount: total,
            paymentMethod: input.paymentMethod,
            paymentPhone,
            accountName: profile.full_name,
            accountEmail: profile.email,
            checkoutMeta: JSON.stringify(checkoutMeta),
        });
        await conn.commit();
    }
    catch (err) {
        await conn.rollback();
        throw err;
    }
    finally {
        conn.release();
    }
    if (!env.paychangu.mock && !env.paychangu.apiKey) {
        await releaseResellListingHoldForOrder(orderId);
        throw new Error("PayChangu API key is not configured");
    }
    let init;
    try {
        init = await initiateMobileMoneyCharge({
            chargeId,
            amount: total,
            mobile: paymentPhone,
            operator: input.paymentMethod,
            email: String(profile.email),
            fullName: String(profile.full_name),
        });
    }
    catch (err) {
        await pool.query(`UPDATE payment_ledger SET status = 'failed', failure_reason = :reason, provider_status = 'failed'
       WHERE id = :ledgerId`, {
            ledgerId,
            reason: err instanceof Error ? err.message : "Could not start mobile money payment",
        });
        await pool.query(`UPDATE orders SET status = 'failed' WHERE id = :orderId`, { orderId });
        await releaseResellListingHoldForOrder(orderId);
        throw err;
    }
    await pool.query(`UPDATE payment_ledger
     SET paychangu_trans_id = :transId, paychangu_ref_id = :refId, provider_status = :providerStatus
     WHERE id = :ledgerId`, {
        ledgerId,
        transId: init.transId,
        refId: init.refId,
        providerStatus: init.providerStatus,
    });
    await maybeSavePaymentMethodFromCheckout(buyerId, {
        savePaymentMethod: input.savePaymentMethod,
        paymentMethodId: input.paymentMethodId,
        paymentMethod: input.paymentMethod,
        paymentPhone,
    });
    return {
        orderId,
        reference,
        total,
        paymentStatus: "pending",
        message: input.paymentMethod === "airtel"
            ? "Check your phone for the Airtel Money PIN prompt."
            : "Check your phone for the TNM Mpamba PIN prompt.",
    };
}
export async function fulfillResellSale(ledger, conn) {
    const meta = parseCheckoutMeta(ledger);
    const resellListingId = meta.resellListingId;
    if (!resellListingId)
        return null;
    const [orderRows] = await conn.query(`SELECT * FROM orders WHERE id = :orderId FOR UPDATE`, { orderId: ledger.order_id });
    const order = orderRows[0];
    if (!order)
        throw new Error("Order not found");
    const userTicketId = String(meta.userTicketId);
    const sellerUserId = String(meta.sellerUserId);
    const subtotal = Number(meta.subtotal);
    const [ticketRows] = await conn.query(`SELECT * FROM user_tickets WHERE id = :id FOR UPDATE`, { id: userTicketId });
    const ticket = ticketRows[0];
    if (!ticket || ticket.status !== "active") {
        throw new Error("Resale ticket is no longer available");
    }
    if (String(ticket.user_id) !== sellerUserId) {
        throw new Error("Ticket ownership changed — resale cancelled");
    }
    const [rlRows] = await conn.query(`SELECT * FROM resell_listings
     WHERE id = :id
       AND (
         status = 'active'
         OR (status = 'pending_sale' AND pending_order_id = :orderId)
       )
     FOR UPDATE`, { id: resellListingId, orderId: ledger.order_id });
    if (!rlRows[0])
        throw new Error("Resale listing no longer active");
    const newQrToken = makeQrToken();
    const withdrawableAt = new Date();
    withdrawableAt.setDate(withdrawableAt.getDate() + SETTLEMENT_DAYS);
    await conn.query(`UPDATE user_tickets
     SET user_id = :buyerId, order_id = :orderId, qr_token = :qrToken,
         reference = :reference, amount_paid = :amountPaid
     WHERE id = :id`, {
        buyerId: ledger.user_id,
        orderId: ledger.order_id,
        qrToken: newQrToken,
        reference: order.reference,
        amountPaid: subtotal,
        id: userTicketId,
    });
    if (ticket.seat_number != null && ticket.listing_id) {
        await conn.query(`UPDATE seats s
       JOIN seat_layouts sl ON sl.id = s.layout_id
       SET s.customer_name = :buyerName
       WHERE sl.listing_id = :listingId AND s.seat_number = :seatNumber`, {
            buyerName: ledger.account_name ?? "Guest",
            listingId: ticket.listing_id,
            seatNumber: ticket.seat_number,
        });
    }
    await conn.query(`UPDATE resell_listings
     SET status = 'sold', sold_at = NOW(),
         pending_buyer_id = NULL, pending_order_id = NULL, pending_expires_at = NULL
     WHERE id = :id`, { id: resellListingId });
    const saleId = uuid();
    await conn.query(`INSERT INTO resell_sales (
      id, resell_listing_id, order_id, buyer_user_id, seller_user_id, user_ticket_id,
      sale_price_mwk, seller_net_mwk, settlement_status, withdrawable_at
    ) VALUES (
      :saleId, :resellListingId, :orderId, :buyerId, :sellerId, :userTicketId,
      :salePrice, :sellerNet, 'pending_settlement', :withdrawableAt
    )`, {
        saleId,
        resellListingId,
        orderId: ledger.order_id,
        buyerId: ledger.user_id,
        sellerId: sellerUserId,
        userTicketId,
        salePrice: subtotal,
        sellerNet: subtotal,
        withdrawableAt: withdrawableAt.toISOString().slice(0, 19).replace("T", " "),
    });
    await conn.query(`INSERT INTO order_items (id, order_id, quantity, unit_price, line_total)
     VALUES (:itemId, :orderId, 1, :unitPrice, :lineTotal)`, {
        itemId: uuid(),
        orderId: ledger.order_id,
        unitPrice: subtotal,
        lineTotal: subtotal,
    });
    await conn.query(`UPDATE orders SET status = 'confirmed' WHERE id = :orderId`, {
        orderId: ledger.order_id,
    });
    await conn.query(`UPDATE payment_ledger SET status = 'completed', completed_at = NOW(), provider_status = 'success'
     WHERE id = :ledgerId`, { ledgerId: ledger.id });
    return {
        ticketIds: [userTicketId],
        reference: order.reference,
        total: Number(order.total_mwk),
    };
}
export async function settleResellSales() {
    await pool.query(`UPDATE resell_sales
     SET settlement_status = 'settled', settled_at = NOW()
     WHERE settlement_status = 'pending_settlement'
       AND withdrawable_at IS NOT NULL
       AND withdrawable_at <= NOW()`);
}
export { verifyMobileMoneyCharge };
