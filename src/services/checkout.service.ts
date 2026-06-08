import type { RowDataPacket } from "mysql2";
import { v4 as uuid } from "uuid";
import { env } from "../config/env.js";
import { pool, type QueryParams } from "../db/pool.js";
import {
  getLedgerById,
  getLedgerByOrderId,
  getUserPendingLedger,
  listExpiredPendingLedgers,
  parseCheckoutMeta,
  type LedgerRow,
} from "./ledger.service.js";
import {
  assertCheckoutCapacity,
  isPurchasableStatus,
  syncListingSoldOutStatus,
} from "./capacity.service.js";
import { getListingById } from "./listings.service.js";
import { syncOrganizerRefundRecovery } from "./refund-recovery.service.js";
import {
  assertQueueCheckoutAllowed,
  completeQueueEntry,
} from "./queue.service.js";
import {
  initiateMobileMoneyCharge,
  TERMINAL_PAYMENT_STATUSES,
  verifyMobileMoneyCharge,
  type MomoOperator,
} from "./paychangu.service.js";
import { makeReference } from "../utils/http.js";

const SERVICE_FEE = 0;

export type CheckoutInput = {
  qty: number;
  seatNumbers?: number[];
  paymentMethod: "airtel" | "tnm" | "card";
  paymentPhone?: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  nationalId?: string;
  queueId?: string;
};

function makeChargeId(ledgerId: string): string {
  return `TM${ledgerId.replace(/-/g, "").slice(0, 28)}`;
}

function makeQrToken(): string {
  return uuid().replace(/-/g, "");
}

function pricingForCheckout(lineCount: number, unitPrice: number) {
  const catalogSubtotal = unitPrice * lineCount;
  const catalogServiceFee = SERVICE_FEE;
  const catalogTotal = catalogSubtotal + catalogServiceFee;

  if (env.paychangu.mock) {
    const mockTotal = env.paychangu.mockPaymentAmountMwk;
    return {
      subtotal: mockTotal,
      serviceFee: 0,
      total: mockTotal,
      catalogSubtotal,
      catalogServiceFee,
      catalogTotal,
    };
  }

  return {
    subtotal: catalogSubtotal,
    serviceFee: catalogServiceFee,
    total: catalogTotal,
    catalogSubtotal,
    catalogServiceFee,
    catalogTotal,
  };
}

export async function failStalePendingPayments() {
  const expired = await listExpiredPendingLedgers();
  for (const ledger of expired) {
    await failCheckout(ledger, "Payment timed out after 5 minutes without confirmation.");
  }
}

async function resumePendingCheckout(userId: string, ledger: LedgerRow, listingTitle: string) {
  const [orderRows] = await pool.query<RowDataPacket[]>(
    `SELECT id, reference, total_mwk, payment_method FROM orders WHERE id = :orderId AND user_id = :userId`,
    { orderId: ledger.order_id, userId },
  );
  const order = orderRows[0];
  if (!order) throw new Error("Pending order not found");

  return {
    orderId: order.id as string,
    ledgerId: ledger.id,
    reference: order.reference as string,
    total: Number(order.total_mwk),
    listingTitle,
    paymentStatus: "pending" as const,
    paychanguChargeId: ledger.paychangu_charge_id,
    mockPayment: env.paychangu.mock,
    resumed: true,
    message:
      order.payment_method === "airtel"
        ? "Resuming your in-progress Airtel Money payment. Check your phone if you still have a PIN prompt."
        : "Resuming your in-progress TNM Mpamba payment. Check your phone if you still have a PIN prompt.",
  };
}

export async function initiateCheckout(
  userId: string,
  listingId: string,
  input: CheckoutInput,
) {
  await failStalePendingPayments();

  if (input.paymentMethod === "card") {
    throw new Error("Card payments via PayChangu are not enabled yet. Use Airtel or TNM.");
  }
  if (!input.paymentPhone) {
    throw new Error("Mobile money number is required");
  }

  const listing = await getListingById(listingId, true);
  if (!listing) throw new Error("Listing not found");
  if (!isPurchasableStatus(String(listing.eventStatus ?? "draft"))) {
    throw new Error("This listing is not available for purchase.");
  }

  const lineCount =
    listing.kind === "travel" && input.seatNumbers?.length
      ? input.seatNumbers.length
      : input.qty;

  await assertCheckoutCapacity(
    listingId,
    listing.kind,
    listing.ticketCapacity ?? null,
    lineCount,
  );
  await assertQueueCheckoutAllowed(
    listingId,
    userId,
    input.queueId,
    listing.kind,
    listing.ticketCapacity ?? null,
  );

  const lockKey = `checkout:${userId}`;
  const conn = await pool.getConnection();
  try {
    const [lockRows] = await conn.query<RowDataPacket[]>(`SELECT GET_LOCK(:lockKey, 15) AS ok`, {
      lockKey,
    });
    if (Number(lockRows[0]?.ok) !== 1) {
      throw new Error("Another checkout is in progress. Please wait a moment and try again.");
    }

    const existingPending = await getUserPendingLedger(userId);
    if (existingPending) {
      return resumePendingCheckout(userId, existingPending, listing.title);
    }

    return await createCheckoutWithPayChangu(userId, listingId, listing, input, conn);
  } finally {
    await conn.query(`SELECT RELEASE_LOCK(:lockKey)`, { lockKey });
    conn.release();
  }
}

async function createCheckoutWithPayChangu(
  userId: string,
  listingId: string,
  listing: NonNullable<Awaited<ReturnType<typeof getListingById>>>,
  input: CheckoutInput,
  conn: Awaited<ReturnType<typeof pool.getConnection>>,
) {
  const lineCount =
    listing.kind === "travel" && input.seatNumbers?.length
      ? input.seatNumbers.length
      : input.qty;

  const pricing = pricingForCheckout(lineCount, listing.price);
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
  };

  if (listing.kind === "travel" && input.seatNumbers?.length) {
    for (const num of input.seatNumbers) {
      const [seatRows] = await pool.query<RowDataPacket[]>(
        `SELECT s.status FROM seats s
         JOIN seat_layouts sl ON sl.id = s.layout_id
         WHERE sl.listing_id = :listingId AND s.seat_number = :num`,
        { listingId, num },
      );
      const seat = seatRows[0];
      if (!seat || seat.status !== "available") {
        throw new Error(`Seat ${num} is not available`);
      }
    }
  }

  const init = await initiateMobileMoneyCharge({
    chargeId,
    amount: total,
    mobile: input.paymentPhone!,
    operator: input.paymentMethod as MomoOperator,
    email: input.contactEmail,
    fullName: input.contactName,
  });

  const timeoutSec = env.paychangu.pendingTimeoutSec;
  try {
    await conn.beginTransaction();

    if (listing.kind === "travel" && input.seatNumbers?.length) {
      for (const num of input.seatNumbers) {
        const [seatRows] = await conn.query<RowDataPacket[]>(
          `SELECT s.id, s.status FROM seats s
           JOIN seat_layouts sl ON sl.id = s.layout_id
           WHERE sl.listing_id = :listingId AND s.seat_number = :num FOR UPDATE`,
          { listingId, num },
        );
        const seat = seatRows[0];
        if (!seat || seat.status !== "available") {
          throw new Error(`Seat ${num} is not available`);
        }
      }
    }

    await conn.query(
      `INSERT INTO orders (
        id, user_id, listing_id, reference, status, subtotal_mwk, service_fee_mwk, total_mwk,
        payment_method, payment_phone, contact_name, contact_email, contact_phone, national_id
      ) VALUES (
        :orderId, :userId, :listingId, :reference, 'pending', :subtotal, :serviceFee, :total,
        :paymentMethod, :paymentPhone, :contactName, :contactEmail, :contactPhone, :nationalId
      )`,
      {
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
      } satisfies QueryParams,
    );

    await conn.query(
      `INSERT INTO payment_ledger (
        id, user_id, order_id, status, paychangu_charge_id, paychangu_trans_id, paychangu_ref_id,
        amount_mwk, payment_method, payment_phone, account_name, account_email, account_phone,
        checkout_meta, provider_status, expires_at
      ) VALUES (
        :ledgerId, :userId, :orderId, 'pending', :chargeId, :transId, :refId,
        :amount, :paymentMethod, :paymentPhone, :accountName, :accountEmail, :accountPhone,
        :checkoutMeta, :providerStatus, DATE_ADD(NOW(), INTERVAL ${timeoutSec} SECOND)
      )`,
      {
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
      } satisfies QueryParams,
    );

    await conn.commit();

    return {
      orderId,
      ledgerId,
      reference,
      total,
      listingTitle: listing.title,
      paymentStatus: "pending" as const,
      paychanguChargeId: init.chargeId,
      mockPayment: env.paychangu.mock,
      message:
        input.paymentMethod === "airtel"
          ? "Check your phone for the Airtel Money PIN prompt."
          : "Check your phone for the TNM Mpamba PIN prompt.",
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}

export async function getOrderPaymentStatus(userId: string, orderId: string) {
  const [orderRows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM orders WHERE id = :orderId AND user_id = :userId`,
    { orderId, userId },
  );
  const order = orderRows[0];
  if (!order) throw new Error("Order not found");

  const ledger = await getLedgerByOrderId(orderId, userId);
  if (!ledger) throw new Error("Payment record not found");

  if (ledger.status === "pending") {
    await processPendingLedgerEntry(ledger.id);
  }

  const refreshedLedger = (await getLedgerByOrderId(orderId, userId))!;
  const [refreshedOrderRows] = await pool.query<RowDataPacket[]>(
    `SELECT status, reference, total_mwk FROM orders WHERE id = :orderId`,
    { orderId },
  );
  const refreshedOrder = refreshedOrderRows[0];

  let tickets: Array<{
    id: string;
    reference: string;
    qrToken: string;
    seat?: string;
  }> = [];

  if (refreshedLedger.status === "completed") {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, reference, qr_token, seat_number FROM user_tickets WHERE order_id = :orderId`,
      { orderId },
    );
    tickets = rows.map((t) => ({
      id: t.id as string,
      reference: t.reference as string,
      qrToken: t.qr_token as string,
      seat: t.seat_number ? String(t.seat_number) : undefined,
    }));
  }

  return {
    orderId,
    reference: refreshedOrder.reference,
    orderStatus: refreshedOrder.status,
    ledgerStatus: refreshedLedger.status,
    paymentStatus:
      refreshedLedger.status === "completed"
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

export async function processPendingLedgerEntry(ledgerId: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT *,
       GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), expires_at)) AS secs_remaining,
       TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age_sec
     FROM payment_ledger WHERE id = :ledgerId AND status = 'pending'`,
    { ledgerId },
  );
  const row = rows[0] as (LedgerRow & { secs_remaining: number; age_sec: number }) | undefined;
  if (!row) return;

  await pool.query(
    `UPDATE payment_ledger SET last_polled_at = NOW(), poll_count = poll_count + 1 WHERE id = :ledgerId`,
    { ledgerId },
  );

  const ageMs = Number(row.age_sec) * 1000;
  const inGrace = ageMs < env.paychangu.verifyGraceMs;

  if (Number(row.secs_remaining) <= 0 && !inGrace) {
    await failCheckout(row, "Payment timed out after 5 minutes without confirmation.");
    return;
  }

  const verify = await verifyMobileMoneyCharge(
    row.paychangu_charge_id,
    new Date(row.created_at),
  );

  await pool.query(
    `UPDATE payment_ledger SET provider_status = :providerStatus WHERE id = :ledgerId`,
    { ledgerId, providerStatus: verify.providerStatus },
  );

  const terminalFailure = TERMINAL_PAYMENT_STATUSES.has(verify.providerStatus);

  if (verify.success) {
    try {
      await fulfillCheckout(row);
    } catch (err) {
      console.error("[payment] fulfill failed after PayChangu success:", err);
      await failCheckout(
        row,
        err instanceof Error ? err.message : "Could not finalize tickets after payment",
      );
    }
    return;
  }

  if (verify.failed && (terminalFailure || !inGrace)) {
    await failCheckout(
      row,
      verify.message || "Payment was cancelled or not completed.",
    );
    return;
  }

  if (verify.failed && inGrace) {
    console.log(
      `[payment] ignoring ambiguous early verify (grace ${env.paychangu.verifyGraceMs}ms)`,
      ledgerId,
      verify.providerStatus,
      verify.message,
    );
  }
}

async function fulfillCheckout(ledger: LedgerRow) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [ledgerRows] = await conn.query<RowDataPacket[]>(
      `SELECT * FROM payment_ledger WHERE id = :ledgerId AND status = 'pending' FOR UPDATE`,
      { ledgerId: ledger.id },
    );
    if (!ledgerRows[0]) {
      await conn.rollback();
      return;
    }

    const [orderRows] = await conn.query<RowDataPacket[]>(
      `SELECT * FROM orders WHERE id = :orderId FOR UPDATE`,
      { orderId: ledger.order_id },
    );
    const order = orderRows[0];
    if (!order || order.status === "confirmed") {
      await conn.rollback();
      return;
    }

    const meta = parseCheckoutMeta(ledger);
    const listingId = String(meta.listingId ?? order.listing_id);
    const seatNumbers = (meta.seatNumbers as number[]) ?? [];
    const lineCount = Number(meta.lineCount ?? meta.qty ?? 1);
    const listing = await getListingById(listingId, true);
    if (!listing) throw new Error("Listing not found");

    const unitPrice = listing.price;
    const catalogSubtotal = Number(meta.subtotal ?? unitPrice * lineCount);
    const catalogServiceFee = Number(meta.serviceFee ?? SERVICE_FEE);
    const catalogTotal = Number(meta.catalogTotal ?? catalogSubtotal + catalogServiceFee);
    const subtotal = catalogSubtotal;
    const ticketIds: string[] = [];

    if (listing.kind === "travel" && seatNumbers.length) {
      for (const num of seatNumbers) {
        const [seatRows] = await conn.query<RowDataPacket[]>(
          `SELECT s.id, s.status FROM seats s
           JOIN seat_layouts sl ON sl.id = s.layout_id
           WHERE sl.listing_id = :listingId AND s.seat_number = :num FOR UPDATE`,
          { listingId, num },
        );
        const seat = seatRows[0];
        if (!seat || seat.status !== "available") {
          throw new Error(`Seat ${num} is no longer available`);
        }

        const seatId = seat.id as string;
        const itemId = uuid();
        const ticketId = uuid();
        const qrToken = makeQrToken();

        await conn.query(
          `INSERT INTO order_items (id, order_id, seat_id, seat_number, quantity, unit_price, line_total)
           VALUES (:itemId, :orderId, :seatId, :seatNumber, 1, :unitPrice, :unitPrice)`,
          { itemId, orderId: ledger.order_id, seatId, seatNumber: num, unitPrice },
        );
        await conn.query(
          `UPDATE seats SET status = 'taken', customer_name = :customerName WHERE id = :seatId`,
          { seatId, customerName: order.contact_name },
        );
        await conn.query(
          `INSERT INTO user_tickets (id, user_id, order_id, listing_id, reference, qr_token, status, seat_number, amount_paid)
           VALUES (:id, :userId, :orderId, :listingId, :reference, :qrToken, 'active', :seatNumber, :amount)`,
          {
            id: ticketId,
            userId: ledger.user_id,
            orderId: ledger.order_id,
            listingId,
            reference: order.reference,
            qrToken,
            seatNumber: num,
            amount: unitPrice + Math.floor(catalogServiceFee / lineCount),
          },
        );
        ticketIds.push(ticketId);
      }
    } else {
      const itemId = uuid();
      await conn.query(
        `INSERT INTO order_items (id, order_id, quantity, unit_price, line_total)
         VALUES (:itemId, :orderId, :qty, :unitPrice, :lineTotal)`,
        {
          itemId,
          orderId: ledger.order_id,
          qty: lineCount,
          unitPrice,
          lineTotal: subtotal,
        },
      );

      const perTicketAmount =
        Math.floor(catalogTotal / lineCount) +
        (catalogTotal % lineCount > 0 ? 1 : 0);
      for (let i = 0; i < lineCount; i++) {
        const ticketId = uuid();
        const qrToken = makeQrToken();
        const amount =
          i === lineCount - 1
            ? catalogTotal - perTicketAmount * (lineCount - 1)
            : perTicketAmount;
        await conn.query(
          `INSERT INTO user_tickets (id, user_id, order_id, listing_id, reference, qr_token, status, amount_paid)
           VALUES (:id, :userId, :orderId, :listingId, :reference, :qrToken, 'active', :amount)`,
          {
            id: ticketId,
            userId: ledger.user_id,
            orderId: ledger.order_id,
            listingId,
            reference: order.reference,
            qrToken,
            amount,
          },
        );
        ticketIds.push(ticketId);
      }
    }

    await conn.query(
      `UPDATE orders SET status = 'confirmed' WHERE id = :orderId`,
      { orderId: ledger.order_id },
    );
    await conn.query(
      `UPDATE payment_ledger SET status = 'completed', completed_at = NOW(), provider_status = 'success'
       WHERE id = :ledgerId`,
      { ledgerId: ledger.id },
    );

    await conn.commit();

    const metaAfter = parseCheckoutMeta(ledger);
    await completeQueueEntry(metaAfter.queueId as string | undefined);
    await syncListingSoldOutStatus(
      listingId,
      listing.kind,
      listing.ticketCapacity ?? null,
    );

    void syncOrganizerRefundRecovery(listing.organizerId).catch((err) => {
      console.error("[refund-recovery] Post-checkout sync failed:", err);
    });

    return ticketIds;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function failCheckout(ledger: LedgerRow, reason: string) {
  await pool.query(
    `UPDATE payment_ledger SET status = 'failed', failure_reason = :reason, provider_status = 'failed'
     WHERE id = :ledgerId AND status = 'pending'`,
    { ledgerId: ledger.id, reason },
  );
  await pool.query(
    `UPDATE orders SET status = 'failed' WHERE id = :orderId AND status = 'pending'`,
    { orderId: ledger.order_id },
  );
}
