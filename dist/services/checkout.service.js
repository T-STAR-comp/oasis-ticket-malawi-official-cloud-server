import { v4 as uuid } from "uuid";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { getLedgerByOrderId, getUserPendingLedger, listExpiredPendingLedgers, parseCheckoutMeta, } from "./ledger.service.js";
import { assertCheckoutCapacity, isPurchasableStatus, syncListingSoldOutStatus, } from "./capacity.service.js";
import { assertListingEventDateActive, getListingById } from "./listings.service.js";
import * as ticketTiersService from "./ticket-tiers.service.js";
import { syncOrganizerRefundRecovery } from "./refund-recovery.service.js";
import { assertQueueCheckoutAllowed, completeQueueEntry, } from "./queue.service.js";
import { initiateMobileMoneyCharge, TERMINAL_PAYMENT_STATUSES, verifyMobileMoneyCharge, } from "./paychangu.service.js";
import { makeReference } from "../utils/http.js";
import { computeReferralPricing, recordReferralEarning, resolveActiveReferral, } from "./referral.service.js";
import { getProfile } from "./auth.service.js";
import { getPaymentMethodForUser, maybeSavePaymentMethodFromCheckout } from "./payment-methods.service.js";
import { normalizeMalawiPhone } from "../utils/phone.js";
import { fulfillResellSale } from "./resell.service.js";
import { computePlatformServiceFee, } from "../utils/platform-fee.js";
function platformServiceFeeForSubtotal(subtotalMwk) {
    return computePlatformServiceFee(subtotalMwk);
}
function makeChargeId(ledgerId) {
    return `TM${ledgerId.replace(/-/g, "").slice(0, 28)}`;
}
function makeQrToken() {
    return uuid().replace(/-/g, "");
}
async function resolveCheckoutIdentity(userId, input) {
    const profile = await getProfile(userId);
    if (!profile)
        throw new Error("Account not found");
    const fullName = String(profile.full_name ?? "").trim();
    const email = String(profile.email ?? "").trim();
    if (!fullName) {
        throw new Error("Your account is missing a name. Update your profile in Dashboard → Account.");
    }
    if (!email) {
        throw new Error("Your account is missing an email. Update your profile in Dashboard → Account.");
    }
    let paymentPhone = input.paymentPhone;
    if (input.paymentMethodId) {
        const method = await getPaymentMethodForUser(userId, input.paymentMethodId);
        if (!method?.phoneNumber)
            throw new Error("Saved payment method not found");
        if (method.type !== input.paymentMethod) {
            throw new Error("Selected payment method does not match operator");
        }
        paymentPhone = method.phoneNumber;
    }
    else {
        paymentPhone = normalizeMalawiPhone(paymentPhone ?? "") ?? undefined;
    }
    if (!paymentPhone)
        throw new Error("Mobile money number is required");
    const profilePhone = String(profile.phone ?? "").trim();
    return {
        contactName: fullName,
        contactEmail: email,
        contactPhone: profilePhone || paymentPhone,
        paymentPhone,
        nationalId: String(profile.national_id ?? "").trim() || undefined,
    };
}
async function pricingForCheckout(lineCount, unitPrice, listingId, referralCode) {
    const catalogSubtotal = unitPrice * lineCount;
    const catalogServiceFee = platformServiceFeeForSubtotal(catalogSubtotal);
    const referral = await resolveActiveReferral(listingId, referralCode);
    if (referral) {
        const applied = computeReferralPricing({
            catalogSubtotal,
            serviceFee: catalogServiceFee,
            referral,
        });
        if (env.paychangu.mock) {
            const mockTotal = env.paychangu.mockPaymentAmountMwk;
            return {
                subtotal: applied.organizerSubtotal,
                serviceFee: catalogServiceFee,
                total: mockTotal,
                catalogSubtotal,
                catalogServiceFee,
                catalogTotal: applied.buyerSubtotal + catalogServiceFee,
                referral: applied,
                referrerUserId: referral.referrerUserId,
            };
        }
        return {
            subtotal: applied.organizerSubtotal,
            serviceFee: applied.serviceFee,
            total: applied.total,
            catalogSubtotal,
            catalogServiceFee,
            catalogTotal: applied.buyerSubtotal + catalogServiceFee,
            referral: applied,
            referrerUserId: referral.referrerUserId,
        };
    }
    const catalogTotal = catalogSubtotal + catalogServiceFee;
    if (env.paychangu.mock) {
        const mockTotal = env.paychangu.mockPaymentAmountMwk;
        return {
            subtotal: mockTotal,
            serviceFee: catalogServiceFee,
            total: mockTotal,
            catalogSubtotal,
            catalogServiceFee,
            catalogTotal,
            referral: null,
            referrerUserId: null,
        };
    }
    return {
        subtotal: catalogSubtotal,
        serviceFee: catalogServiceFee,
        total: catalogTotal,
        catalogSubtotal,
        catalogServiceFee,
        catalogTotal,
        referral: null,
        referrerUserId: null,
    };
}
export async function failStalePendingPayments() {
    const expired = await listExpiredPendingLedgers();
    for (const ledger of expired) {
        await failCheckout(ledger, "Payment timed out after 5 minutes without confirmation.");
    }
}
async function resumePendingCheckout(userId, ledger, listingTitle) {
    const [orderRows] = await pool.query(`SELECT id, reference, total_mwk, payment_method FROM orders WHERE id = :orderId AND user_id = :userId`, { orderId: ledger.order_id, userId });
    const order = orderRows[0];
    if (!order)
        throw new Error("Pending order not found");
    return {
        orderId: order.id,
        ledgerId: ledger.id,
        reference: order.reference,
        total: Number(order.total_mwk),
        listingTitle,
        paymentStatus: "pending",
        paychanguChargeId: ledger.paychangu_charge_id,
        mockPayment: env.paychangu.mock,
        resumed: true,
        message: order.payment_method === "airtel"
            ? "Resuming your in-progress Airtel Money payment. Check your phone if you still have a PIN prompt."
            : "Resuming your in-progress TNM Mpamba payment. Check your phone if you still have a PIN prompt.",
    };
}
export async function initiateCheckout(userId, listingId, input) {
    await failStalePendingPayments();
    if (input.paymentMethod === "card") {
        throw new Error("Card payments via PayChangu are not enabled yet. Use Airtel or TNM.");
    }
    const identity = await resolveCheckoutIdentity(userId, input);
    const checkoutInput = { ...input, ...identity };
    const listing = await getListingById(listingId, true);
    if (!listing)
        throw new Error("Listing not found");
    if (!isPurchasableStatus(String(listing.eventStatus ?? "draft"))) {
        throw new Error("This listing is not available for purchase.");
    }
    const lineCount = listing.kind === "travel" && input.seatNumbers?.length
        ? input.seatNumbers.length
        : input.qty;
    let unitPrice = Number(listing.price);
    let selectedTier = null;
    if (listing.kind === "event") {
        await assertListingEventDateActive(listingId);
        const tiers = listing.ticketTiers ?? [];
        if (tiers.length > 0) {
            let tierId = input.tierId?.trim() || undefined;
            if (!tierId && tiers.length === 1) {
                tierId = tiers[0]?.id;
            }
            if (!tierId) {
                throw new Error("Select a ticket type (Standard, VIP, etc.) to continue.");
            }
            selectedTier = await ticketTiersService.resolveTier(listingId, tierId);
            if (!selectedTier)
                throw new Error("Ticket type not found");
            await ticketTiersService.assertTierCheckoutCapacity(selectedTier.id, lineCount);
            unitPrice = selectedTier.priceMwk;
        }
    }
    await assertCheckoutCapacity(listingId, listing.kind, listing.ticketCapacity ?? null, lineCount);
    await assertQueueCheckoutAllowed(listingId, userId, input.queueId, listing.kind, listing.ticketCapacity ?? null);
    const lockKey = `checkout:${userId}`;
    const conn = await pool.getConnection();
    try {
        const [lockRows] = await conn.query(`SELECT GET_LOCK(:lockKey, 15) AS ok`, {
            lockKey,
        });
        if (Number(lockRows[0]?.ok) !== 1) {
            throw new Error("Another checkout is in progress. Please wait a moment and try again.");
        }
        const existingPending = await getUserPendingLedger(userId);
        if (existingPending) {
            return resumePendingCheckout(userId, existingPending, listing.title);
        }
        return await createCheckoutWithPayChangu(userId, listingId, listing, checkoutInput, conn, unitPrice, selectedTier);
    }
    finally {
        await conn.query(`SELECT RELEASE_LOCK(:lockKey)`, { lockKey });
        conn.release();
    }
}
async function createCheckoutWithPayChangu(userId, listingId, listing, input, conn, unitPrice, selectedTier) {
    const lineCount = listing.kind === "travel" && input.seatNumbers?.length
        ? input.seatNumbers.length
        : input.qty;
    const pricing = await pricingForCheckout(lineCount, unitPrice, listingId, input.referralCode);
    const { subtotal, serviceFee, total } = pricing;
    const orderId = uuid();
    const ledgerId = uuid();
    const reference = makeReference(listingId);
    const chargeId = makeChargeId(ledgerId);
    if (!env.paychangu.mock && !env.paychangu.apiKey) {
        throw new Error("PayChangu API key is not configured");
    }
    const checkoutMeta = {
        listingId,
        qty: input.qty,
        seatNumbers: input.seatNumbers ?? [],
        lineCount,
        subtotal: pricing.catalogSubtotal,
        serviceFee: pricing.catalogServiceFee,
        catalogTotal: pricing.catalogTotal,
        chargedAmount: total,
        nationalId: input.nationalId ?? null,
        mockPayment: env.paychangu.mock,
        queueId: input.queueId ?? null,
        referralId: pricing.referral?.referralId ?? null,
        referralCode: pricing.referral?.referralCode ?? null,
        referralDiscount: pricing.referral?.buyerDiscount ?? 0,
        referrerCommission: pricing.referral?.referrerCommission ?? 0,
        referrerUserId: pricing.referrerUserId ?? null,
        catalogSubtotal: pricing.catalogSubtotal,
        tierId: selectedTier?.id ?? null,
        tierName: selectedTier?.name ?? null,
        unitPrice,
    };
    if (listing.kind === "travel" && input.seatNumbers?.length) {
        for (const num of input.seatNumbers) {
            const [seatRows] = await pool.query(`SELECT s.status FROM seats s
         JOIN seat_layouts sl ON sl.id = s.layout_id
         WHERE sl.listing_id = :listingId AND s.seat_number = :num`, { listingId, num });
            const seat = seatRows[0];
            if (!seat || seat.status !== "available") {
                throw new Error(`Seat ${num} is not available`);
            }
        }
    }
    const init = await initiateMobileMoneyCharge({
        chargeId,
        amount: total,
        mobile: input.paymentPhone,
        operator: input.paymentMethod,
        email: input.contactEmail,
        fullName: input.contactName,
    });
    const timeoutSec = env.paychangu.pendingTimeoutSec;
    try {
        await conn.beginTransaction();
        if (listing.kind === "travel" && input.seatNumbers?.length) {
            for (const num of input.seatNumbers) {
                const [seatRows] = await conn.query(`SELECT s.id, s.status FROM seats s
           JOIN seat_layouts sl ON sl.id = s.layout_id
           WHERE sl.listing_id = :listingId AND s.seat_number = :num FOR UPDATE`, { listingId, num });
                const seat = seatRows[0];
                if (!seat || seat.status !== "available") {
                    throw new Error(`Seat ${num} is not available`);
                }
            }
        }
        await conn.query(`INSERT INTO orders (
        id, user_id, listing_id, reference, status, subtotal_mwk, service_fee_mwk, total_mwk,
        payment_method, payment_phone, contact_name, contact_email, contact_phone, national_id,
        referral_id, referral_code, catalog_subtotal_mwk, referral_discount_mwk, referrer_commission_mwk
      ) VALUES (
        :orderId, :userId, :listingId, :reference, 'pending', :subtotal, :serviceFee, :total,
        :paymentMethod, :paymentPhone, :contactName, :contactEmail, :contactPhone, :nationalId,
        :referralId, :referralCode, :catalogSubtotal, :referralDiscount, :referrerCommission
      )`, {
            orderId,
            userId,
            listingId,
            reference,
            subtotal,
            serviceFee,
            total,
            paymentMethod: input.paymentMethod,
            paymentPhone: input.paymentPhone ?? null,
            contactName: input.contactName,
            contactEmail: input.contactEmail,
            contactPhone: input.contactPhone,
            nationalId: input.nationalId ?? null,
            referralId: pricing.referral?.referralId ?? null,
            referralCode: pricing.referral?.referralCode ?? null,
            catalogSubtotal: pricing.catalogSubtotal,
            referralDiscount: pricing.referral?.buyerDiscount ?? 0,
            referrerCommission: pricing.referral?.referrerCommission ?? 0,
        });
        await conn.query(`INSERT INTO payment_ledger (
        id, user_id, order_id, status, paychangu_charge_id, paychangu_trans_id, paychangu_ref_id,
        amount_mwk, payment_method, payment_phone, account_name, account_email, account_phone,
        checkout_meta, provider_status, expires_at
      ) VALUES (
        :ledgerId, :userId, :orderId, 'pending', :chargeId, :transId, :refId,
        :amount, :paymentMethod, :paymentPhone, :accountName, :accountEmail, :accountPhone,
        :checkoutMeta, :providerStatus, DATE_ADD(NOW(), INTERVAL ${timeoutSec} SECOND)
      )`, {
            ledgerId,
            userId,
            orderId,
            chargeId: init.chargeId,
            transId: init.transId,
            refId: init.refId,
            amount: total,
            paymentMethod: input.paymentMethod,
            paymentPhone: input.paymentPhone ?? null,
            accountName: input.contactName,
            accountEmail: input.contactEmail,
            accountPhone: input.contactPhone,
            checkoutMeta: JSON.stringify(checkoutMeta),
            providerStatus: init.providerStatus,
        });
        await conn.commit();
        await maybeSavePaymentMethodFromCheckout(userId, {
            savePaymentMethod: input.savePaymentMethod,
            paymentMethodId: input.paymentMethodId,
            paymentMethod: input.paymentMethod,
            paymentPhone: input.paymentPhone,
        });
        return {
            orderId,
            ledgerId,
            reference,
            total,
            listingTitle: listing.title,
            paymentStatus: "pending",
            paychanguChargeId: init.chargeId,
            mockPayment: env.paychangu.mock,
            message: input.paymentMethod === "airtel"
                ? "Check your phone for the Airtel Money PIN prompt."
                : "Check your phone for the TNM Mpamba PIN prompt.",
        };
    }
    catch (err) {
        await conn.rollback();
        throw err;
    }
}
export async function getOrderPaymentStatus(userId, orderId) {
    const [orderRows] = await pool.query(`SELECT * FROM orders WHERE id = :orderId AND user_id = :userId`, { orderId, userId });
    const order = orderRows[0];
    if (!order)
        throw new Error("Order not found");
    const ledger = await getLedgerByOrderId(orderId, userId);
    if (!ledger)
        throw new Error("Payment record not found");
    if (ledger.status === "pending") {
        await processPendingLedgerEntry(ledger.id);
    }
    const refreshedLedger = (await getLedgerByOrderId(orderId, userId));
    const [refreshedOrderRows] = await pool.query(`SELECT status, reference, total_mwk FROM orders WHERE id = :orderId`, { orderId });
    const refreshedOrder = refreshedOrderRows[0];
    let tickets = [];
    if (refreshedLedger.status === "completed") {
        const [rows] = await pool.query(`SELECT id, reference, qr_token, seat_number FROM user_tickets WHERE order_id = :orderId`, { orderId });
        tickets = rows.map((t) => ({
            id: t.id,
            reference: t.reference,
            qrToken: t.qr_token,
            seat: t.seat_number ? String(t.seat_number) : undefined,
        }));
        if (tickets.length === 0) {
            const meta = parseCheckoutMeta(refreshedLedger);
            const resaleTicketId = meta.userTicketId;
            if (resaleTicketId) {
                const [resaleRows] = await pool.query(`SELECT id, reference, qr_token, seat_number
           FROM user_tickets
           WHERE id = :ticketId AND user_id = :userId`, { ticketId: resaleTicketId, userId });
                tickets = resaleRows.map((t) => ({
                    id: t.id,
                    reference: t.reference,
                    qrToken: t.qr_token,
                    seat: t.seat_number ? String(t.seat_number) : undefined,
                }));
            }
        }
    }
    return {
        orderId,
        reference: refreshedOrder.reference,
        orderStatus: refreshedOrder.status,
        ledgerStatus: refreshedLedger.status,
        paymentStatus: refreshedLedger.status === "completed"
            ? "completed"
            : refreshedLedger.status === "failed"
                ? "failed"
                : "pending",
        total: refreshedOrder.total_mwk,
        paychanguChargeId: refreshedLedger.paychangu_charge_id,
        expiresAt: refreshedLedger.expires_at,
        failureReason: refreshedLedger.failure_reason,
        tickets,
    };
}
export async function processPendingLedgerEntry(ledgerId) {
    const [rows] = await pool.query(`SELECT *,
       GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), expires_at)) AS secs_remaining,
       TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age_sec
     FROM payment_ledger WHERE id = :ledgerId AND status = 'pending'`, { ledgerId });
    const row = rows[0];
    if (!row)
        return;
    await pool.query(`UPDATE payment_ledger SET last_polled_at = NOW(), poll_count = poll_count + 1 WHERE id = :ledgerId`, { ledgerId });
    const ageMs = Number(row.age_sec) * 1000;
    const inGrace = ageMs < env.paychangu.verifyGraceMs;
    if (Number(row.secs_remaining) <= 0 && !inGrace) {
        await failCheckout(row, "Payment timed out after 5 minutes without confirmation.");
        return;
    }
    const verify = await verifyMobileMoneyCharge(row.paychangu_charge_id, new Date(row.created_at));
    await pool.query(`UPDATE payment_ledger SET provider_status = :providerStatus WHERE id = :ledgerId`, { ledgerId, providerStatus: verify.providerStatus });
    const terminalFailure = TERMINAL_PAYMENT_STATUSES.has(verify.providerStatus);
    if (verify.success) {
        try {
            await fulfillCheckout(row);
        }
        catch (err) {
            console.error("[payment] fulfill failed after PayChangu success:", err);
            await failCheckout(row, err instanceof Error ? err.message : "Could not finalize tickets after payment");
        }
        return;
    }
    if (verify.failed && (terminalFailure || !inGrace)) {
        await failCheckout(row, verify.message || "Payment was cancelled or not completed.");
        return;
    }
    if (verify.failed && inGrace) {
        console.log(`[payment] ignoring ambiguous early verify (grace ${env.paychangu.verifyGraceMs}ms)`, ledgerId, verify.providerStatus, verify.message);
    }
}
async function fulfillCheckout(ledger) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [ledgerRows] = await conn.query(`SELECT * FROM payment_ledger WHERE id = :ledgerId AND status = 'pending' FOR UPDATE`, { ledgerId: ledger.id });
        if (!ledgerRows[0]) {
            await conn.rollback();
            return;
        }
        const [orderRows] = await conn.query(`SELECT * FROM orders WHERE id = :orderId FOR UPDATE`, { orderId: ledger.order_id });
        const order = orderRows[0];
        if (!order || order.status === "confirmed") {
            await conn.rollback();
            return;
        }
        const meta = parseCheckoutMeta(ledger);
        if (meta.resellListingId) {
            const resellResult = await fulfillResellSale(ledger, conn);
            if (resellResult) {
                await conn.commit();
                return resellResult;
            }
        }
        const listingId = String(meta.listingId ?? order.listing_id);
        const seatNumbers = meta.seatNumbers ?? [];
        const lineCount = Number(meta.lineCount ?? meta.qty ?? 1);
        const listing = await getListingById(listingId, true);
        if (!listing)
            throw new Error("Listing not found");
        const unitPrice = Number(meta.unitPrice ?? listing.price);
        const tierId = meta.tierId ?? null;
        const tierName = meta.tierName ?? null;
        const catalogSubtotal = Number(meta.subtotal ?? unitPrice * lineCount);
        const catalogServiceFee = Number(meta.serviceFee ?? platformServiceFeeForSubtotal(catalogSubtotal));
        const catalogTotal = Number(meta.catalogTotal ?? catalogSubtotal + catalogServiceFee);
        const subtotal = catalogSubtotal;
        const ticketIds = [];
        if (listing.kind === "travel" && seatNumbers.length) {
            for (const num of seatNumbers) {
                const [seatRows] = await conn.query(`SELECT s.id, s.status FROM seats s
           JOIN seat_layouts sl ON sl.id = s.layout_id
           WHERE sl.listing_id = :listingId AND s.seat_number = :num FOR UPDATE`, { listingId, num });
                const seat = seatRows[0];
                if (!seat || seat.status !== "available") {
                    throw new Error(`Seat ${num} is no longer available`);
                }
                const seatId = seat.id;
                const itemId = uuid();
                const ticketId = uuid();
                const qrToken = makeQrToken();
                await conn.query(`INSERT INTO order_items (id, order_id, seat_id, seat_number, quantity, unit_price, line_total)
           VALUES (:itemId, :orderId, :seatId, :seatNumber, 1, :unitPrice, :unitPrice)`, { itemId, orderId: ledger.order_id, seatId, seatNumber: num, unitPrice });
                await conn.query(`UPDATE seats SET status = 'taken', customer_name = :customerName WHERE id = :seatId`, { seatId, customerName: order.contact_name });
                await conn.query(`INSERT INTO user_tickets (id, user_id, order_id, listing_id, reference, qr_token, status, seat_number, amount_paid)
           VALUES (:id, :userId, :orderId, :listingId, :reference, :qrToken, 'active', :seatNumber, :amount)`, {
                    id: ticketId,
                    userId: ledger.user_id,
                    orderId: ledger.order_id,
                    listingId,
                    reference: order.reference,
                    qrToken,
                    seatNumber: num,
                    amount: unitPrice,
                });
                ticketIds.push(ticketId);
            }
        }
        else {
            const itemId = uuid();
            await conn.query(`INSERT INTO order_items (id, order_id, quantity, unit_price, line_total, ticket_tier_id)
         VALUES (:itemId, :orderId, :qty, :unitPrice, :lineTotal, :tierId)`, {
                itemId,
                orderId: ledger.order_id,
                qty: lineCount,
                unitPrice,
                lineTotal: subtotal,
                tierId,
            });
            for (let i = 0; i < lineCount; i++) {
                const ticketId = uuid();
                const qrToken = makeQrToken();
                const amount = unitPrice;
                await conn.query(`INSERT INTO user_tickets (
             id, user_id, order_id, listing_id, ticket_tier_id, ticket_tier_name,
             reference, qr_token, status, amount_paid
           ) VALUES (
             :id, :userId, :orderId, :listingId, :tierId, :tierName,
             :reference, :qrToken, 'active', :amount
           )`, {
                    id: ticketId,
                    userId: ledger.user_id,
                    orderId: ledger.order_id,
                    listingId,
                    tierId,
                    tierName,
                    reference: order.reference,
                    qrToken,
                    amount,
                });
                ticketIds.push(ticketId);
            }
        }
        await conn.query(`UPDATE orders SET status = 'confirmed' WHERE id = :orderId`, { orderId: ledger.order_id });
        await conn.query(`UPDATE payment_ledger SET status = 'completed', completed_at = NOW(), provider_status = 'success'
       WHERE id = :ledgerId`, { ledgerId: ledger.id });
        await conn.commit();
        const metaAfter = parseCheckoutMeta(ledger);
        await completeQueueEntry(metaAfter.queueId);
        await syncListingSoldOutStatus(listingId, listing.kind, listing.ticketCapacity ?? null);
        void syncOrganizerRefundRecovery(listing.organizerId).catch((err) => {
            console.error("[refund-recovery] Post-checkout sync failed:", err);
        });
        const metaReferral = parseCheckoutMeta(ledger);
        const referralId = metaReferral.referralId;
        const referrerUserId = metaReferral.referrerUserId;
        const referrerCommission = Number(metaReferral.referrerCommission ?? 0);
        if (referralId && referrerUserId && referrerCommission > 0) {
            void recordReferralEarning({
                referralId,
                orderId: ledger.order_id,
                referrerUserId,
                listingId,
                commissionMwk: referrerCommission,
                buyerDiscountMwk: Number(metaReferral.referralDiscount ?? 0),
                catalogSubtotalMwk: Number(metaReferral.catalogSubtotal ?? metaReferral.subtotal ?? 0),
            }).catch((err) => console.error("[referral] Earning record failed:", err));
        }
        return ticketIds;
    }
    catch (err) {
        await conn.rollback();
        throw err;
    }
    finally {
        conn.release();
    }
}
async function failCheckout(ledger, reason) {
    await pool.query(`UPDATE payment_ledger SET status = 'failed', failure_reason = :reason, provider_status = 'failed'
     WHERE id = :ledgerId AND status = 'pending'`, { ledgerId: ledger.id, reason });
    await pool.query(`UPDATE orders SET status = 'failed' WHERE id = :orderId AND status = 'pending'`, { orderId: ledger.order_id });
}
