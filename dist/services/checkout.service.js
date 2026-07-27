import { v4 as uuid } from "uuid";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { getGuestPendingLedger, getLedgerById, getLedgerByOrderId, getUserPendingLedger, listExpiredPendingLedgers, parseCheckoutMeta, } from "./ledger.service.js";
import { assertCheckoutCapacity, assertFulfillmentCapacity, isPurchasableStatus, syncListingSoldOutStatus, } from "./capacity.service.js";
import { failCheckoutWithRecovery } from "./payment-failure-refund.service.js";
import { distributeTicketAmountPaid } from "../utils/ticket-amount-paid.js";
import { assertListingEventDateActive, getListingById } from "./listings.service.js";
import { assertEventSpotsAvailable, listingUsesEventSeating, parseEventLayoutJson, } from "./event-layout.service.js";
import * as ticketTiersService from "./ticket-tiers.service.js";
import { syncOrganizerRefundRecovery } from "./refund-recovery.service.js";
import { assertQueueCheckoutAllowed, completeQueueEntry, } from "./queue.service.js";
import { initiateMobileMoneyCharge, TERMINAL_PAYMENT_STATUSES, verifyMobileMoneyCharge, } from "./paychangu.service.js";
import { makeReference, makeTicketReference } from "../utils/http.js";
import { computeReferralPricing, recordReferralEarning, resolveActiveReferral, } from "./referral.service.js";
import { getProfile } from "./auth.service.js";
import { getPaymentMethodForUser, maybeSavePaymentMethodFromCheckout } from "./payment-methods.service.js";
import { normalizeMalawiPhone } from "../utils/phone.js";
import { fulfillResellSale, expireStaleResellListingHolds } from "./resell.service.js";
import { computePlatformServiceFeeWithPercent, applyServiceFeeBearer, resolveCheckoutServiceFee, } from "../utils/platform-fee.js";
import { enrollUserTicketVirtualSessions, resolveVirtualCheckoutPricing, } from "./virtual-session-checkout.service.js";
import { features } from "../config/features.js";
import { emailTicketsForOrder } from "./guest-tickets.service.js";
import { makeGuestAccessToken } from "./ticket-pdf.service.js";
import { log } from "../utils/logger.js";
function eventSeatingEnabled(listing) {
    return (listing.kind === "event" &&
        listingUsesEventSeating(parseEventLayoutJson(listing.eventLayout)));
}
function resolveSeatBasedLineCount(listing, qty, seatNumbers) {
    const usesSeats = (listing.kind === "travel" || eventSeatingEnabled(listing)) && (seatNumbers?.length ?? 0) > 0;
    return usesSeats ? seatNumbers.length : qty;
}
function applyEventVirtualLineCount(listing, seatNumbers, virtualLineCount, fallbackLineCount) {
    if (eventSeatingEnabled(listing) && (seatNumbers?.length ?? 0) > 0) {
        return seatNumbers.length;
    }
    if (listing.kind === "event") {
        return virtualLineCount;
    }
    return fallbackLineCount;
}
function platformServiceFeeForSubtotal(subtotalMwk, percent) {
    return computePlatformServiceFeeWithPercent(subtotalMwk, percent);
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
function resolveGuestCheckoutIdentity(input, options) {
    const contactName = String(input.contactName ?? "").trim();
    const contactEmail = String(input.contactEmail ?? "").trim().toLowerCase();
    const paymentPhone = normalizeMalawiPhone(input.paymentPhone ?? "") ?? undefined;
    if (!contactName)
        throw new Error("Your name is required for guest checkout.");
    if (!contactEmail || !contactEmail.includes("@")) {
        throw new Error("A valid email is required — your tickets will be sent there.");
    }
    if (!options?.freeEvent && !paymentPhone)
        throw new Error("Mobile money number is required");
    return {
        contactName,
        contactEmail,
        contactPhone: String(input.contactPhone ?? "").trim() || paymentPhone || contactEmail,
        paymentPhone: options?.freeEvent ? undefined : paymentPhone,
        nationalId: String(input.nationalId ?? "").trim() || undefined,
    };
}
async function resolveAuthenticatedCheckoutInput(userId, input, freeEventCheckout) {
    if (freeEventCheckout) {
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
        return {
            ...input,
            contactName: fullName,
            contactEmail: email,
            contactPhone: String(profile.phone ?? "").trim() || email,
            paymentPhone: undefined,
            nationalId: String(profile.national_id ?? "").trim() || undefined,
        };
    }
    return { ...input, ...(await resolveCheckoutIdentity(userId, input)) };
}
async function isFreeEventCheckoutTotal(listing, lineCount, unitPrice, listingId, referralCode) {
    if (listing.kind !== "event")
        return false;
    if (unitPrice <= 0)
        return true;
    const pricing = await pricingForCheckout(lineCount, unitPrice, listingId, listing.organizerId, referralCode);
    return pricing.catalogSubtotal <= 0 && pricing.total <= 0;
}
function isFreeEventCheckoutPricing(listing, unitPrice, pricing) {
    return (listing.kind === "event" &&
        (unitPrice <= 0 || (pricing.catalogSubtotal <= 0 && pricing.total <= 0)));
}
/** Finalize a zero-amount event checkout without PayChangu verification. */
export async function fulfillFreeEventCheckout(ledger, options) {
    if (!features.ticketGeneration && !options?.bypassTicketGenerationGate) {
        throw new Error("Ticket generation is temporarily unavailable.");
    }
    const result = await fulfillCheckout(ledger, {
        freeEvent: ledger.status === "completed",
        bypassTicketGenerationGate: options?.bypassTicketGenerationGate,
    });
    const [countRows] = await pool.query(`SELECT COUNT(*) AS cnt FROM user_tickets WHERE order_id = :orderId`, { orderId: ledger.order_id });
    const ticketCount = Number(countRows[0]?.cnt ?? 0);
    const issued = ticketCount > 0 ||
        (Array.isArray(result) && result.length > 0) ||
        (result &&
            typeof result === "object" &&
            "ticketIds" in result &&
            Array.isArray(result.ticketIds) &&
            result.ticketIds.length > 0);
    if (!issued) {
        throw new Error("Could not issue free event tickets");
    }
}
async function pricingForCheckout(lineCount, unitPrice, listingId, organizerId, referralCode) {
    const catalogSubtotal = unitPrice * lineCount;
    const feeResolved = await resolveCheckoutServiceFee(organizerId, catalogSubtotal);
    const catalogServiceFee = feeResolved.fee;
    const mockTotal = catalogSubtotal > 0 && env.paychangu.mock ? env.paychangu.mockPaymentAmountMwk : null;
    const referral = await resolveActiveReferral(listingId, referralCode);
    if (referral) {
        const applied = computeReferralPricing({
            catalogSubtotal,
            serviceFee: catalogServiceFee,
            referral,
        });
        const priced = applyServiceFeeBearer({
            organizerSubtotal: applied.organizerSubtotal,
            buyerSubtotal: applied.buyerSubtotal,
            serviceFee: catalogServiceFee,
            bearer: feeResolved.bearer,
            mockTotal,
        });
        return {
            ...priced,
            catalogSubtotal,
            catalogServiceFee,
            catalogTotal: feeResolved.bearer === "organizer"
                ? applied.buyerSubtotal
                : applied.buyerSubtotal + catalogServiceFee,
            referral: applied,
            referrerUserId: referral.referrerUserId,
            serviceFeePercent: feeResolved.percent,
            serviceFeeSource: feeResolved.source,
            serviceFeeBearer: feeResolved.bearer,
        };
    }
    const buyerSubtotal = catalogSubtotal;
    const organizerSubtotal = catalogSubtotal;
    const priced = applyServiceFeeBearer({
        organizerSubtotal,
        buyerSubtotal,
        serviceFee: catalogServiceFee,
        bearer: feeResolved.bearer,
        mockTotal,
    });
    return {
        ...priced,
        catalogSubtotal,
        catalogServiceFee,
        catalogTotal: feeResolved.bearer === "organizer"
            ? catalogSubtotal
            : catalogSubtotal + catalogServiceFee,
        referral: null,
        referrerUserId: null,
        serviceFeePercent: feeResolved.percent,
        serviceFeeSource: feeResolved.source,
        serviceFeeBearer: feeResolved.bearer,
    };
}
export async function failStalePendingPayments() {
    await expireStaleResellListingHolds();
    const expired = await listExpiredPendingLedgers();
    for (const ledger of expired) {
        await failCheckoutWithRecovery(ledger, "Payment timed out after 5 minutes without confirmation.");
    }
}
async function resumePendingCheckout(userId, ledger, listingTitle) {
    const [orderRows] = await pool.query(userId
        ? `SELECT id, reference, total_mwk, payment_method, guest_access_token, is_guest, contact_email
         FROM orders WHERE id = :orderId AND user_id = :userId`
        : `SELECT id, reference, total_mwk, payment_method, guest_access_token, is_guest, contact_email
         FROM orders WHERE id = :orderId AND is_guest = 1`, userId ? { orderId: ledger.order_id, userId } : { orderId: ledger.order_id });
    const order = orderRows[0];
    if (!order)
        throw new Error("Pending order not found");
    log.info("checkout", "Resuming pending checkout", {
        orderId: order.id,
        ledgerId: ledger.id,
        isGuest: !userId,
    });
    return {
        orderId: order.id,
        ledgerId: ledger.id,
        reference: order.reference,
        total: Number(order.total_mwk),
        listingTitle,
        paymentStatus: "pending",
        paychanguChargeId: ledger.paychangu_charge_id,
        mockPayment: env.paychangu.mock,
        guestAccessToken: order.guest_access_token ?? undefined,
        isGuest: Boolean(order.is_guest),
        buyerEmail: order.contact_email ?? undefined,
        resumed: true,
        message: order.payment_method === "airtel"
            ? "Resuming your in-progress Airtel Money payment. Check your phone if you still have a PIN prompt."
            : "Resuming your in-progress TNM Mpamba payment. Check your phone if you still have a PIN prompt.",
    };
}
export async function previewListingCheckoutPricing(listingId, input) {
    const listing = await getListingById(listingId, true);
    if (!listing)
        throw new Error("Listing not found");
    const lineCountBase = resolveSeatBasedLineCount(listing, input.qty, input.seatNumbers);
    let lineCount = lineCountBase;
    let unitPrice = Number(listing.price);
    if (listing.kind === "event") {
        const virtualPlan = await resolveVirtualCheckoutPricing({
            id: listingId,
            kind: listing.kind,
            eventFormat: String(listing.eventFormat ?? "physical"),
            virtualEventType: String(listing.virtualEventType ?? "one_time"),
            virtualBuyMode: listing.virtualBuyMode,
            virtualPricingMode: listing.virtualPricingMode,
            price: Number(listing.price),
            ticketTiers: listing.ticketTiers,
        }, {
            qty: input.qty,
            tierId: input.tierId,
            virtualSessionIds: input.virtualSessionIds,
        });
        lineCount = applyEventVirtualLineCount(listing, input.seatNumbers, virtualPlan.lineCount, lineCountBase);
        unitPrice = virtualPlan.unitPrice;
        const tiers = listing.ticketTiers ?? [];
        if (tiers.length > 0) {
            const tierId = input.tierId?.trim() || tiers[0]?.id;
            if (tierId) {
                const selectedTier = await ticketTiersService.resolveTier(listingId, tierId);
                if (selectedTier && !virtualPlan.virtualSessionSelection) {
                    unitPrice = selectedTier.priceMwk;
                }
            }
        }
    }
    const pricing = await pricingForCheckout(lineCount, unitPrice, listingId, listing.organizerId, input.referralCode);
    return {
        unitPrice,
        lineCount,
        catalogSubtotal: pricing.catalogSubtotal,
        serviceFee: pricing.serviceFee,
        serviceFeePercent: pricing.serviceFeePercent,
        serviceFeeBearer: pricing.serviceFeeBearer,
        serviceFeeSource: pricing.serviceFeeSource,
        total: pricing.total,
        referralDiscount: pricing.referral?.buyerDiscount ?? 0,
        buyerPaysServiceFee: pricing.serviceFeeBearer === "buyer",
    };
}
export async function isFreeListingCheckout(listingId, input) {
    const preview = await previewListingCheckoutPricing(listingId, input);
    return preview.unitPrice <= 0 && preview.total <= 0;
}
/** Block repeat purchases when this buyer already received free tickets for the event. */
async function assertBuyerHasNoPriorFreeEventTickets(listingId, contactEmail, userId, conn) {
    const email = String(contactEmail ?? "").trim().toLowerCase();
    if (!email && !userId)
        return;
    const executor = conn ?? pool;
    const [rows] = await executor.query(`SELECT 1
     FROM orders o
     LEFT JOIN user_tickets ut ON ut.order_id = o.id
     WHERE o.listing_id = :listingId
       AND o.total_mwk = 0
       AND o.status IN ('confirmed', 'pending')
       AND (
         (:email != '' AND LOWER(o.contact_email) = :email)
         OR (:email != '' AND LOWER(COALESCE(ut.guest_email, '')) = :email)
         OR (:userId IS NOT NULL AND o.user_id = :userId)
         OR (:userId IS NOT NULL AND ut.user_id = :userId)
       )
     LIMIT 1`, { listingId, email, userId: userId ?? null });
    if (rows.length > 0) {
        throw new Error("This email has already claimed free tickets for this event. Additional tickets cannot be purchased.");
    }
}
export async function initiateCheckout(userId, listingId, input) {
    await failStalePendingPayments();
    if (input.paymentMethod === "card") {
        throw new Error("Card payments via PayChangu are not enabled yet. Use Airtel or TNM.");
    }
    const listing = await getListingById(listingId, true);
    if (!listing)
        throw new Error("Listing not found");
    if (!isPurchasableStatus(String(listing.eventStatus ?? "draft"))) {
        throw new Error("This listing is not available for purchase.");
    }
    const lineCountBase = resolveSeatBasedLineCount(listing, input.qty, input.seatNumbers);
    let lineCount = lineCountBase;
    let unitPrice = Number(listing.price);
    let selectedTier = null;
    let virtualSessionIds = [];
    let enrollAllVirtualSessions = false;
    if (listing.kind === "event") {
        await assertListingEventDateActive(listingId);
        const virtualPlan = await resolveVirtualCheckoutPricing({
            id: listingId,
            kind: listing.kind,
            eventFormat: String(listing.eventFormat ?? "physical"),
            virtualEventType: String(listing.virtualEventType ?? "one_time"),
            virtualBuyMode: listing.virtualBuyMode,
            virtualPricingMode: listing.virtualPricingMode,
            price: Number(listing.price),
            ticketTiers: listing.ticketTiers,
        }, {
            qty: input.qty,
            tierId: input.tierId,
            virtualSessionIds: input.virtualSessionIds,
        });
        lineCount = applyEventVirtualLineCount(listing, input.seatNumbers, virtualPlan.lineCount, lineCountBase);
        unitPrice = virtualPlan.unitPrice;
        virtualSessionIds = virtualPlan.selectedSessionIds;
        enrollAllVirtualSessions = virtualPlan.enrollAllSessions;
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
            if (!virtualPlan.virtualSessionSelection) {
                unitPrice = selectedTier.priceMwk;
            }
        }
    }
    if (eventSeatingEnabled(listing) && !input.seatNumbers?.length) {
        throw new Error("Select at least one seat or spot to continue.");
    }
    await assertCheckoutCapacity(listingId, listing.kind, listing.ticketCapacity ?? null, lineCount);
    await assertQueueCheckoutAllowed(listingId, { userId }, input.queueId, listing.kind, listing.ticketCapacity ?? null);
    const freeEventCheckout = await isFreeEventCheckoutTotal(listing, lineCount, unitPrice, listingId, input.referralCode);
    const checkoutInput = await resolveAuthenticatedCheckoutInput(userId, input, freeEventCheckout);
    if (listing.kind === "event") {
        await assertBuyerHasNoPriorFreeEventTickets(listingId, checkoutInput.contactEmail, userId);
    }
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
        return await createCheckoutWithPayChangu(userId, listingId, listing, checkoutInput, conn, unitPrice, selectedTier, lineCount, virtualSessionIds, enrollAllVirtualSessions);
    }
    finally {
        await conn.query(`SELECT RELEASE_LOCK(:lockKey)`, { lockKey });
        conn.release();
    }
}
export async function initiateGuestCheckout(listingId, input, guestKey) {
    if (!features.guestCheckout) {
        throw new Error("Guest checkout is not available right now.");
    }
    await failStalePendingPayments();
    if (input.paymentMethod === "card") {
        throw new Error("Card payments via PayChangu are not enabled yet. Use Airtel or TNM.");
    }
    if (input.paymentMethodId || input.savePaymentMethod) {
        throw new Error("Saved payment methods require an account. Sign in or use guest checkout.");
    }
    const listing = await getListingById(listingId, true);
    if (!listing)
        throw new Error("Listing not found");
    if (!isPurchasableStatus(String(listing.eventStatus ?? "draft"))) {
        throw new Error("This listing is not available for purchase.");
    }
    if (listing.kind === "event" &&
        String(listing.eventFormat ?? "physical") === "virtual") {
        throw new Error("Virtual events require a Ticket Malawi account. Please sign in to purchase tickets.");
    }
    const lineCountBase = resolveSeatBasedLineCount(listing, input.qty, input.seatNumbers);
    let lineCount = lineCountBase;
    let unitPrice = Number(listing.price);
    let selectedTier = null;
    let virtualSessionIds = [];
    let enrollAllVirtualSessions = false;
    if (listing.kind === "event") {
        await assertListingEventDateActive(listingId);
        const virtualPlan = await resolveVirtualCheckoutPricing({
            id: listingId,
            kind: listing.kind,
            eventFormat: String(listing.eventFormat ?? "physical"),
            virtualEventType: String(listing.virtualEventType ?? "one_time"),
            virtualBuyMode: listing.virtualBuyMode,
            virtualPricingMode: listing.virtualPricingMode,
            price: Number(listing.price),
            ticketTiers: listing.ticketTiers,
        }, {
            qty: input.qty,
            tierId: input.tierId,
            virtualSessionIds: input.virtualSessionIds,
        });
        lineCount = applyEventVirtualLineCount(listing, input.seatNumbers, virtualPlan.lineCount, lineCountBase);
        unitPrice = virtualPlan.unitPrice;
        virtualSessionIds = virtualPlan.selectedSessionIds;
        enrollAllVirtualSessions = virtualPlan.enrollAllSessions;
        const tiers = listing.ticketTiers ?? [];
        if (tiers.length > 0) {
            let tierId = input.tierId?.trim() || undefined;
            if (!tierId && tiers.length === 1)
                tierId = tiers[0]?.id;
            if (!tierId)
                throw new Error("Select a ticket type (Standard, VIP, etc.) to continue.");
            selectedTier = await ticketTiersService.resolveTier(listingId, tierId);
            if (!selectedTier)
                throw new Error("Ticket type not found");
            await ticketTiersService.assertTierCheckoutCapacity(selectedTier.id, lineCount);
            if (!virtualPlan.virtualSessionSelection)
                unitPrice = selectedTier.priceMwk;
        }
    }
    if (eventSeatingEnabled(listing) && !input.seatNumbers?.length) {
        throw new Error("Select at least one seat or spot to continue.");
    }
    await assertCheckoutCapacity(listingId, listing.kind, listing.ticketCapacity ?? null, lineCount);
    await assertQueueCheckoutAllowed(listingId, { guestKey }, input.queueId, listing.kind, listing.ticketCapacity ?? null);
    const freeEventCheckout = await isFreeEventCheckoutTotal(listing, lineCount, unitPrice, listingId, input.referralCode);
    const checkoutInput = {
        ...input,
        ...resolveGuestCheckoutIdentity(input, { freeEvent: freeEventCheckout }),
    };
    if (listing.kind === "event") {
        await assertBuyerHasNoPriorFreeEventTickets(listingId, checkoutInput.contactEmail, null);
    }
    const lockKey = `checkout:guest:${guestKey.slice(0, 32)}`;
    const conn = await pool.getConnection();
    try {
        const [lockRows] = await conn.query(`SELECT GET_LOCK(:lockKey, 15) AS ok`, {
            lockKey,
        });
        if (Number(lockRows[0]?.ok) !== 1) {
            throw new Error("Another checkout is in progress. Please wait a moment and try again.");
        }
        const guestAccessToken = makeGuestAccessToken();
        const existingPending = await getGuestPendingLedger(guestKey);
        if (existingPending) {
            return resumePendingCheckout(null, existingPending, listing.title);
        }
        log.info("checkout", "Guest checkout initiated", {
            listingId,
            guestKey: guestKey.slice(0, 32),
            email: checkoutInput.contactEmail,
        });
        return await createCheckoutWithPayChangu(null, listingId, listing, checkoutInput, conn, unitPrice, selectedTier, lineCount, virtualSessionIds, enrollAllVirtualSessions, { isGuest: true, guestAccessToken, guestKey: guestKey.slice(0, 64) });
    }
    finally {
        await conn.query(`SELECT RELEASE_LOCK(:lockKey)`, { lockKey });
        conn.release();
    }
}
async function createCheckoutWithPayChangu(userId, listingId, listing, input, conn, unitPrice, selectedTier, lineCount, virtualSessionIds, enrollAllVirtualSessions, guestOptions) {
    const pricing = await pricingForCheckout(lineCount, unitPrice, listingId, listing.organizerId, input.referralCode);
    const isFreeEvent = isFreeEventCheckoutPricing(listing, unitPrice, pricing);
    const { subtotal, serviceFee, total: pricedTotal, serviceFeePercent, serviceFeeBearer, } = pricing;
    const total = isFreeEvent ? 0 : pricedTotal;
    const orderId = uuid();
    const ledgerId = uuid();
    const reference = makeReference(listingId);
    const chargeId = makeChargeId(ledgerId);
    const paidCheckout = !isFreeEvent && (total > 0 || listing.kind !== "event");
    if (paidCheckout && !env.paychangu.mock && !env.paychangu.apiKey) {
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
        virtualSessionIds,
        serviceFeePercent: pricing.serviceFeePercent,
        serviceFeeBearer: pricing.serviceFeeBearer,
        serviceFeeSource: pricing.serviceFeeSource,
        enrollAllVirtualSessions,
        isGuest: Boolean(guestOptions?.isGuest),
        guestKey: guestOptions?.guestKey ?? null,
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
    if (eventSeatingEnabled(listing) && input.seatNumbers?.length) {
        await assertEventSpotsAvailable(listingId, input.seatNumbers);
    }
    if (eventSeatingEnabled(listing) && !input.seatNumbers?.length) {
        throw new Error("Select at least one seat or spot to continue.");
    }
    const timeoutSec = env.paychangu.pendingTimeoutSec;
    try {
        await conn.beginTransaction();
        if (listing.kind === "event") {
            await assertBuyerHasNoPriorFreeEventTickets(listingId, input.contactEmail, userId, conn);
        }
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
        if (eventSeatingEnabled(listing) && input.seatNumbers?.length) {
            await assertEventSpotsAvailable(listingId, input.seatNumbers, { conn });
        }
        await conn.query(`INSERT INTO orders (
        id, user_id, listing_id, reference, status, subtotal_mwk, service_fee_mwk, service_fee_bearer,
        service_fee_percent_applied, total_mwk,
        payment_method, payment_phone, contact_name, contact_email, contact_phone, national_id,
        referral_id, referral_code, catalog_subtotal_mwk, referral_discount_mwk, referrer_commission_mwk,
        is_guest, guest_access_token
      ) VALUES (
        :orderId, :userId, :listingId, :reference, 'pending', :subtotal, :serviceFee, :serviceFeeBearer,
        :serviceFeePercent, :total,
        :paymentMethod, :paymentPhone, :contactName, :contactEmail, :contactPhone, :nationalId,
        :referralId, :referralCode, :catalogSubtotal, :referralDiscount, :referrerCommission,
        :isGuest, :guestAccessToken
      )`, {
            orderId,
            userId,
            listingId,
            reference,
            subtotal,
            serviceFee,
            serviceFeeBearer,
            serviceFeePercent,
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
            isGuest: guestOptions?.isGuest ? 1 : 0,
            guestAccessToken: guestOptions?.guestAccessToken ?? null,
        });
        await conn.query(`INSERT INTO payment_ledger (
        id, user_id, order_id, status, paychangu_charge_id,
        amount_mwk, payment_method, payment_phone, account_name, account_email, account_phone,
        checkout_meta, provider_status, expires_at
      ) VALUES (
        :ledgerId, :userId, :orderId, 'pending', :chargeId,
        :amount, :paymentMethod, :paymentPhone, :accountName, :accountEmail, :accountPhone,
        :checkoutMeta, :providerStatus,
        DATE_ADD(NOW(), INTERVAL ${timeoutSec} SECOND)
      )`, {
            ledgerId,
            userId,
            orderId,
            chargeId,
            amount: total,
            paymentMethod: input.paymentMethod,
            paymentPhone: input.paymentPhone ?? null,
            accountName: input.contactName,
            accountEmail: input.contactEmail,
            accountPhone: input.contactPhone,
            checkoutMeta: JSON.stringify(checkoutMeta),
            providerStatus: isFreeEvent ? "free" : "initiated",
        });
        await conn.commit();
        log.info("checkout", "Order and payment ledger created", {
            orderId,
            ledgerId,
            reference,
            total,
            isGuest: Boolean(guestOptions?.isGuest),
            userId: userId ?? "guest",
            email: input.contactEmail,
        });
    }
    catch (err) {
        await conn.rollback();
        log.error("checkout", "Failed to create order/ledger transaction", err, {
            orderId,
            ledgerId,
            isGuest: Boolean(guestOptions?.isGuest),
        });
        throw err;
    }
    if (isFreeEvent) {
        const ledgerRow = await getLedgerById(ledgerId);
        if (!ledgerRow)
            throw new Error("Payment record not found");
        await fulfillFreeEventCheckout(ledgerRow);
        return {
            orderId,
            ledgerId,
            reference,
            total: 0,
            listingTitle: listing.title,
            paymentStatus: "completed",
            paychanguChargeId: chargeId,
            mockPayment: false,
            guestAccessToken: guestOptions?.guestAccessToken,
            isGuest: Boolean(guestOptions?.isGuest),
            buyerEmail: input.contactEmail,
            message: "Your free tickets are ready.",
        };
    }
    let init;
    try {
        init = await initiateMobileMoneyCharge({
            chargeId,
            amount: total,
            mobile: input.paymentPhone,
            operator: input.paymentMethod,
            email: input.contactEmail,
            fullName: input.contactName,
        });
    }
    catch (err) {
        await failCheckoutWithRecovery({
            id: ledgerId,
            order_id: orderId,
            user_id: userId,
            amount_mwk: total,
            payment_method: input.paymentMethod,
            payment_phone: input.paymentPhone ?? null,
        }, err instanceof Error ? err.message : "Could not start mobile money payment");
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
    await maybeSavePaymentMethodFromCheckout(userId ?? "", {
        savePaymentMethod: userId ? input.savePaymentMethod : false,
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
        guestAccessToken: guestOptions?.guestAccessToken,
        isGuest: Boolean(guestOptions?.isGuest),
        buyerEmail: input.contactEmail,
        message: input.paymentMethod === "airtel"
            ? "Check your phone for the Airtel Money PIN prompt."
            : "Check your phone for the TNM Mpamba PIN prompt.",
    };
}
export async function getOrderPaymentStatus(orderId, identity) {
    let order;
    if ("userId" in identity) {
        const [orderRows] = await pool.query(`SELECT * FROM orders WHERE id = :orderId AND user_id = :userId`, { orderId, userId: identity.userId });
        order = orderRows[0];
    }
    else {
        const [orderRows] = await pool.query(`SELECT * FROM orders WHERE id = :orderId AND guest_access_token = :token AND is_guest = 1`, { orderId, token: identity.guestAccessToken });
        order = orderRows[0];
    }
    if (!order)
        throw new Error("Order not found");
    const ledger = await getLedgerByOrderId(orderId, "userId" in identity ? identity.userId : undefined);
    if (!ledger)
        throw new Error("Payment record not found");
    if (ledger.status === "pending") {
        await processPendingLedgerEntry(ledger.id);
    }
    const refreshedLedger = (await getLedgerByOrderId(orderId, "userId" in identity ? identity.userId : undefined));
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
        if (tickets.length === 0 && "userId" in identity) {
            const meta = parseCheckoutMeta(refreshedLedger);
            const resaleTicketId = meta.userTicketId;
            if (resaleTicketId) {
                const [resaleRows] = await pool.query(`SELECT id, reference, qr_token, seat_number
           FROM user_tickets
           WHERE id = :ticketId AND user_id = :userId`, { ticketId: resaleTicketId, userId: identity.userId });
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
        buyerEmail: order.contact_email,
        isGuest: Boolean(order.is_guest),
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
    if (Number(row.amount_mwk) <= 0) {
        try {
            await fulfillFreeEventCheckout(row);
            log.info("checkout", "Free event checkout fulfilled without PayChangu", {
                ledgerId: row.id,
                orderId: row.order_id,
            });
        }
        catch (err) {
            log.error("checkout", "Free event fulfillment failed", err, {
                ledgerId: row.id,
                orderId: row.order_id,
            });
        }
        return;
    }
    await pool.query(`UPDATE payment_ledger SET last_polled_at = NOW(), poll_count = poll_count + 1 WHERE id = :ledgerId`, { ledgerId });
    const ageMs = Number(row.age_sec) * 1000;
    const inGrace = ageMs < env.paychangu.verifyGraceMs;
    if (Number(row.secs_remaining) <= 0 && !inGrace) {
        await failCheckoutWithRecovery(row, "Payment timed out after 5 minutes without confirmation.");
        return;
    }
    const verify = await verifyMobileMoneyCharge(row.paychangu_charge_id, new Date(row.created_at));
    await pool.query(`UPDATE payment_ledger SET provider_status = :providerStatus WHERE id = :ledgerId`, { ledgerId, providerStatus: verify.providerStatus });
    const terminalFailure = TERMINAL_PAYMENT_STATUSES.has(verify.providerStatus);
    if (verify.success) {
        if (!features.ticketGeneration) {
            log.warn("payment", "PayChangu success but ticket generation is disabled", { ledgerId });
            return;
        }
        try {
            await fulfillCheckout(row);
            log.info("payment", "Checkout fulfilled after PayChangu success", {
                ledgerId,
                orderId: row.order_id,
            });
        }
        catch (err) {
            log.error("payment", "Fulfill failed after PayChangu success", err, {
                ledgerId,
                orderId: row.order_id,
            });
            await failCheckoutWithRecovery(row, err instanceof Error ? err.message : "Could not finalize tickets after payment", { paymentSucceeded: true });
        }
        return;
    }
    if (verify.failed && (terminalFailure || !inGrace)) {
        await failCheckoutWithRecovery(row, verify.message || "Payment was cancelled or not completed.");
        return;
    }
    if (verify.failed && inGrace) {
        log.debug("payment", "Ignoring ambiguous early verify during grace period", {
            ledgerId,
            providerStatus: verify.providerStatus,
            message: verify.message,
            graceMs: env.paychangu.verifyGraceMs,
        });
    }
}
/** Post-commit hooks: organizer settlement, sold-out sync, referrals, queue, ticket email. */
export async function runPostCheckoutSideEffects(ledger, listing, listingId, options) {
    const metaAfter = parseCheckoutMeta(ledger);
    await completeQueueEntry(metaAfter.queueId);
    await syncListingSoldOutStatus(listingId, listing.kind, listing.ticketCapacity ?? null);
    void syncOrganizerRefundRecovery(listing.organizerId).catch((err) => {
        log.error("refund-recovery", "Post-checkout sync failed", err, { orderId: ledger.order_id });
    });
    const metaReferral = parseCheckoutMeta(ledger);
    const referralId = metaReferral.referralId;
    const referrerUserId = metaReferral.referrerUserId;
    const referrerCommission = Number(metaReferral.referrerCommission ?? 0);
    if (referralId && referrerUserId && referrerCommission > 0) {
        const [existing] = await pool.query(`SELECT 1 FROM referral_earnings WHERE order_id = :orderId LIMIT 1`, { orderId: ledger.order_id });
        if (!existing[0]) {
            void recordReferralEarning({
                referralId,
                orderId: ledger.order_id,
                referrerUserId,
                listingId,
                commissionMwk: referrerCommission,
                buyerDiscountMwk: Number(metaReferral.referralDiscount ?? 0),
                catalogSubtotalMwk: Number(metaReferral.catalogSubtotal ?? metaReferral.subtotal ?? 0),
            }).catch((err) => log.error("referral", "Earning record failed", err, { orderId: ledger.order_id }));
        }
    }
    try {
        const emailResult = await emailTicketsForOrder(ledger.order_id, {
            delayedApology: options?.delayedTicketEmail,
        });
        if (emailResult.sent) {
            log.info("email", "Ticket purchase email sent", {
                orderId: ledger.order_id,
                delayedApology: Boolean(options?.delayedTicketEmail),
            });
        }
        else {
            log.warn("email", "Ticket purchase email not sent", {
                orderId: ledger.order_id,
                reason: emailResult.reason ?? "unknown",
            });
        }
    }
    catch (err) {
        log.error("email", "Ticket delivery failed", err, { orderId: ledger.order_id });
    }
}
export async function fulfillCheckout(ledger, options) {
    if (!features.ticketGeneration && !options?.bypassTicketGenerationGate) {
        throw new Error("Ticket generation is temporarily unavailable.");
    }
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const ledgerStatusSql = options?.recovery || options?.freeEvent
            ? `SELECT * FROM payment_ledger WHERE id = :ledgerId AND status IN ('pending', 'failed', 'completed') FOR UPDATE`
            : `SELECT * FROM payment_ledger WHERE id = :ledgerId AND status = 'pending' FOR UPDATE`;
        const [ledgerRows] = await conn.query(ledgerStatusSql, {
            ledgerId: ledger.id,
        });
        const lockedLedger = ledgerRows[0];
        if (!lockedLedger) {
            await conn.rollback();
            if (options?.freeEvent) {
                throw new Error("Free event payment record is not in a fulfillable state");
            }
            return;
        }
        const [orderRows] = await conn.query(`SELECT * FROM orders WHERE id = :orderId FOR UPDATE`, { orderId: ledger.order_id });
        const order = orderRows[0];
        if (!order) {
            await conn.rollback();
            if (options?.freeEvent) {
                throw new Error("Order not found for free event fulfillment");
            }
            return;
        }
        if (order.status === "confirmed" && !options?.recovery && !options?.freeEvent) {
            await conn.rollback();
            return;
        }
        if (options?.freeEvent) {
            const [ticketCountRows] = await conn.query(`SELECT COUNT(*) AS cnt FROM user_tickets WHERE order_id = :orderId`, { orderId: ledger.order_id });
            if (Number(ticketCountRows[0]?.cnt ?? 0) > 0) {
                await conn.rollback();
                return [];
            }
        }
        else if (options?.recovery) {
            const [ticketCountRows] = await conn.query(`SELECT COUNT(*) AS cnt FROM user_tickets WHERE order_id = :orderId`, { orderId: ledger.order_id });
            const existingTickets = Number(ticketCountRows[0]?.cnt ?? 0);
            if (existingTickets > 0) {
                await conn.rollback();
                return;
            }
            if (lockedLedger.status !== "pending") {
                await conn.query(`UPDATE payment_ledger
           SET status = 'pending', failure_reason = NULL
           WHERE id = :ledgerId`, { ledgerId: ledger.id });
            }
            if (order.status !== "pending") {
                await conn.query(`UPDATE orders SET status = 'pending' WHERE id = :orderId`, { orderId: ledger.order_id });
            }
        }
        else if (order.status === "confirmed") {
            await conn.rollback();
            return;
        }
        const meta = parseCheckoutMeta(ledger);
        const listingId = String(meta.listingId ?? order.listing_id);
        const listingForSideEffects = await getListingById(listingId, true);
        if (meta.resellListingId) {
            const resellResult = await fulfillResellSale(ledger, conn);
            if (resellResult) {
                await conn.commit();
                if (listingForSideEffects) {
                    await runPostCheckoutSideEffects(ledger, listingForSideEffects, listingId, {
                        delayedTicketEmail: options?.recovery,
                    });
                }
                return resellResult;
            }
        }
        const seatNumbers = meta.seatNumbers ?? [];
        const lineCount = Number(meta.lineCount ?? meta.qty ?? 1);
        const listing = listingForSideEffects;
        if (!listing)
            throw new Error("Listing not found");
        const unitPrice = Number(meta.unitPrice ?? listing.price);
        const tierId = meta.tierId ?? null;
        const tierName = meta.tierName ?? null;
        const virtualSessionIds = (meta.virtualSessionIds ?? []).filter(Boolean);
        const enrollAllVirtualSessions = Boolean(meta.enrollAllVirtualSessions);
        const catalogSubtotal = Number(meta.subtotal ?? unitPrice * lineCount);
        const catalogServiceFee = Number(meta.serviceFee ??
            platformServiceFeeForSubtotal(catalogSubtotal, Number(meta.serviceFeePercent ?? env.platformServiceFeePercent)));
        const catalogTotal = Number(meta.catalogTotal ?? catalogSubtotal + catalogServiceFee);
        const subtotal = catalogSubtotal;
        const orderTotalCharged = Number(order.total_mwk ?? ledger.amount_mwk);
        const ticketIds = [];
        const guestEmail = order.contact_email ? String(order.contact_email).toLowerCase() : null;
        const ticketUserId = ledger.user_id ?? null;
        if (listing.kind === "travel" && seatNumbers.length) {
            await assertFulfillmentCapacity(conn, listingId, listing.kind, listing.ticketCapacity ?? null, seatNumbers.length, ledger.order_id);
            const travelAmounts = distributeTicketAmountPaid(orderTotalCharged, seatNumbers.length);
            for (let si = 0; si < seatNumbers.length; si++) {
                const num = seatNumbers[si];
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
                await conn.query(`INSERT INTO user_tickets (id, user_id, order_id, listing_id, reference, qr_token, status, seat_number, amount_paid, guest_email)
           VALUES (:id, :userId, :orderId, :listingId, :reference, :qrToken, 'active', :seatNumber, :amount, :guestEmail)`, {
                    id: ticketId,
                    userId: ticketUserId,
                    orderId: ledger.order_id,
                    listingId,
                    reference: makeTicketReference(listingId),
                    qrToken,
                    seatNumber: num,
                    amount: travelAmounts[si] ?? unitPrice,
                    guestEmail,
                });
                ticketIds.push(ticketId);
            }
        }
        else if (listing.kind === "event" && seatNumbers.length > 0 && eventSeatingEnabled(listing)) {
            await assertEventSpotsAvailable(listingId, seatNumbers, {
                conn,
                excludeOrderId: ledger.order_id,
            });
            await assertFulfillmentCapacity(conn, listingId, listing.kind, listing.ticketCapacity ?? null, seatNumbers.length, ledger.order_id);
            if (tierId) {
                await ticketTiersService.assertTierFulfillmentCapacity(conn, tierId, seatNumbers.length, ledger.order_id);
            }
            const eventAmounts = distributeTicketAmountPaid(orderTotalCharged, seatNumbers.length);
            for (let si = 0; si < seatNumbers.length; si++) {
                const num = seatNumbers[si];
                await assertEventSpotsAvailable(listingId, [num], {
                    conn,
                    excludeOrderId: ledger.order_id,
                });
                const ticketId = uuid();
                const qrToken = makeQrToken();
                const amount = eventAmounts[si] ?? unitPrice;
                await conn.query(`INSERT INTO user_tickets (
             id, user_id, order_id, listing_id, ticket_tier_id, ticket_tier_name,
             reference, qr_token, status, seat_number, amount_paid, guest_email
           ) VALUES (
             :id, :userId, :orderId, :listingId, :tierId, :tierName,
             :reference, :qrToken, 'active', :seatNumber, :amount, :guestEmail
           )`, {
                    id: ticketId,
                    userId: ticketUserId,
                    orderId: ledger.order_id,
                    listingId,
                    tierId,
                    tierName,
                    reference: makeTicketReference(listingId),
                    qrToken,
                    seatNumber: num,
                    amount,
                    guestEmail,
                });
                ticketIds.push(ticketId);
            }
        }
        else {
            await assertFulfillmentCapacity(conn, listingId, listing.kind, listing.ticketCapacity ?? null, lineCount, ledger.order_id);
            if (tierId) {
                await ticketTiersService.assertTierFulfillmentCapacity(conn, tierId, lineCount, ledger.order_id);
            }
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
            const eventAmounts = distributeTicketAmountPaid(orderTotalCharged, lineCount);
            for (let i = 0; i < lineCount; i++) {
                const ticketId = uuid();
                const qrToken = makeQrToken();
                const amount = eventAmounts[i] ?? unitPrice;
                await conn.query(`INSERT INTO user_tickets (
             id, user_id, order_id, listing_id, ticket_tier_id, ticket_tier_name,
             reference, qr_token, status, amount_paid, guest_email
           ) VALUES (
             :id, :userId, :orderId, :listingId, :tierId, :tierName,
             :reference, :qrToken, 'active', :amount, :guestEmail
           )`, {
                    id: ticketId,
                    userId: ticketUserId,
                    orderId: ledger.order_id,
                    listingId,
                    tierId,
                    tierName,
                    reference: makeTicketReference(listingId),
                    qrToken,
                    amount,
                    guestEmail,
                });
                ticketIds.push(ticketId);
                const isOngoingVirtual = listing.kind === "event" &&
                    listing.eventFormat === "virtual" &&
                    (listing.virtualEventType ?? "one_time") === "ongoing";
                if (isOngoingVirtual && virtualSessionIds.length > 0) {
                    await enrollUserTicketVirtualSessions(conn, ticketId, virtualSessionIds);
                }
            }
        }
        await conn.query(`UPDATE orders SET status = 'confirmed' WHERE id = :orderId`, { orderId: ledger.order_id });
        const freeProviderStatus = orderTotalCharged <= 0 && listing.kind === "event" ? "free" : "success";
        await conn.query(`UPDATE payment_ledger
       SET status = 'completed', completed_at = NOW(), provider_status = :providerStatus
       WHERE id = :ledgerId`, { ledgerId: ledger.id, providerStatus: freeProviderStatus });
        await conn.commit();
        if (listingForSideEffects) {
            await runPostCheckoutSideEffects(ledger, listingForSideEffects, listingId, {
                delayedTicketEmail: options?.recovery,
            });
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
