import type { RowDataPacket } from "mysql2";
import { v4 as uuid } from "uuid";
import { pool } from "../db/pool.js";
import * as emailService from "./email.service.js";
import { addOrganizerRefundDebt } from "./refund-recovery.service.js";

const PAYMENT_COMPLETED_AT = `COALESCE(pl.completed_at, o.updated_at, o.created_at)`;

export type RefundContext = "ban" | "listing_cancellation";

function isOrderSettled(row: RowDataPacket): boolean {
  const completedAt = row.payment_completed_at;
  if (!completedAt) return false;
  const completedDate = new Date(String(completedAt));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  completedDate.setHours(0, 0, 0, 0);
  return today.getTime() > completedDate.getTime();
}

async function fetchRefundableTickets(filters: {
  organizerId: string;
  listingId?: string;
}) {
  let sql = `
    SELECT ut.id AS ticket_id, ut.user_id, ut.order_id, ut.amount_paid, ut.reference,
           u.email, u.full_name,
           o.service_fee_mwk, o.subtotal_mwk, o.total_mwk,
           l.title AS listing_title, l.kind AS listing_kind, l.date_label, l.time_label,
           ${PAYMENT_COMPLETED_AT} AS payment_completed_at
     FROM user_tickets ut
     JOIN users u ON u.id = ut.user_id
     JOIN orders o ON o.id = ut.order_id
     JOIN listings l ON l.id = ut.listing_id
     LEFT JOIN payment_ledger pl ON pl.order_id = o.id AND pl.status = 'completed'
     WHERE l.organizer_id = :organizerId
       AND ut.status = 'active'
       AND o.status = 'confirmed'`;
  const params: Record<string, string> = { organizerId: filters.organizerId };
  if (filters.listingId) {
    sql += ` AND l.id = :listingId`;
    params.listingId = filters.listingId;
  }
  const [tickets] = await pool.query<RowDataPacket[]>(sql, params);
  return tickets;
}

async function processRefunds(
  tickets: RowDataPacket[],
  organizerId: string,
  context: RefundContext,
) {
  let completed = 0;
  let skipped = 0;
  let totalRefunded = 0;
  let totalRefundOwed = 0;

  for (const ticket of tickets) {
    const amountPaid = Number(ticket.amount_paid);
    const orderTotal = Number(ticket.total_mwk);
    const orderFee = Number(ticket.service_fee_mwk);
    const feeShare =
      orderTotal > 0 ? Math.round((amountPaid / orderTotal) * orderFee) : 0;

    const retained = Math.floor(amountPaid * 0.1);
    const refundAmount = amountPaid - retained;
    const processingFee = Math.min(feeShare, retained);
    const platformFee = Math.max(0, retained - processingFee);

    const settled = isOrderSettled(ticket);
    const refundId = uuid();
    totalRefundOwed += refundAmount;

    if (!settled) {
      await pool.query(
        `INSERT INTO ticket_refunds (
          id, user_id, user_ticket_id, order_id, organizer_id,
          original_amount, refund_amount, processing_fee, platform_fee, status, skip_reason
        ) VALUES (
          :id, :userId, :ticketId, :orderId, :organizerId,
          :original, :refund, :procFee, :platFee, 'pending', 'Awaiting T+1 settlement or recovery'
        )`,
        {
          id: refundId,
          userId: ticket.user_id,
          ticketId: ticket.ticket_id,
          orderId: ticket.order_id,
          organizerId,
          original: amountPaid,
          refund: refundAmount,
          procFee: processingFee,
          platFee: platformFee,
        },
      );

      if (context === "listing_cancellation") {
        await pool.query(`UPDATE user_tickets SET status = 'expired' WHERE id = :ticketId`, {
          ticketId: ticket.ticket_id,
        });
        await emailService.sendListingCancelledBuyerPendingRefundEmail({
          email: ticket.email as string,
          fullName: ticket.full_name as string,
          listingTitle: String(ticket.listing_title),
          reference: String(ticket.reference),
          amountPaid,
          expectedRefund: refundAmount,
        });
      }

      skipped++;
      continue;
    }

    await pool.query(
      `INSERT INTO ticket_refunds (
        id, user_id, user_ticket_id, order_id, organizer_id,
        original_amount, refund_amount, processing_fee, platform_fee, status, completed_at
      ) VALUES (
        :id, :userId, :ticketId, :orderId, :organizerId,
        :original, :refund, :procFee, :platFee, 'completed', NOW()
      )`,
      {
        id: refundId,
        userId: ticket.user_id,
        ticketId: ticket.ticket_id,
        orderId: ticket.order_id,
        organizerId,
        original: amountPaid,
        refund: refundAmount,
        procFee: processingFee,
        platFee: platformFee,
      },
    );

    await pool.query(`UPDATE user_tickets SET status = 'expired' WHERE id = :ticketId`, {
      ticketId: ticket.ticket_id,
    });

    if (context === "listing_cancellation") {
      await pool.query(`UPDATE orders SET status = 'refunded' WHERE id = :orderId`, {
        orderId: ticket.order_id,
      });
    }

    await emailService.sendTicketRefundEmail(
      ticket.email as string,
      ticket.full_name as string,
      String(ticket.reference),
      refundAmount,
      amountPaid,
      context,
    );

    completed++;
    totalRefunded += refundAmount;
  }

  return {
    completed,
    skipped,
    totalRefunded,
    totalRefundOwed,
    ticketsReviewed: tickets.length,
  };
}

export async function processBanRefunds(organizerId: string) {
  const tickets = await fetchRefundableTickets({ organizerId });
  const result = await processRefunds(tickets, organizerId, "ban");
  await addOrganizerRefundDebt(organizerId, result.totalRefundOwed);
  return result;
}

export async function processListingCancellationRefunds(
  listingId: string,
  organizerId: string,
  cancelledListingFundsHeld = 0,
) {
  const tickets = await fetchRefundableTickets({ organizerId, listingId });
  const result = await processRefunds(tickets, organizerId, "listing_cancellation");

  const coveredByHold = Math.min(cancelledListingFundsHeld, result.totalRefundOwed);
  const debtIncrease = Math.max(0, result.totalRefundOwed - coveredByHold);

  if (coveredByHold > 0) {
    await pool.query(
      `UPDATE organizer_profiles
       SET refund_recovered_mwk = refund_recovered_mwk + :amount
       WHERE user_id = :organizerId`,
      { organizerId, amount: coveredByHold },
    );
    await pool.query(
      `INSERT INTO refund_recovery_allocations (id, organizer_id, amount_mwk, source)
       VALUES (:id, :organizerId, :amount, 'cancelled_hold')`,
      { id: uuid(), organizerId, amount: coveredByHold },
    );
  }

  if (debtIncrease > 0) {
    await addOrganizerRefundDebt(organizerId, debtIncrease);
  }

  return { ...result, debtIncrease, coveredByHold };
}
