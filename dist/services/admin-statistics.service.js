import { pool } from "../db/pool.js";
import { PUBLIC_VISIBILITY_SQL } from "./capacity.service.js";
async function count(sql, params = {}) {
    const [rows] = await pool.query(sql, params);
    return Number(rows[0]?.cnt ?? 0);
}
async function sum(sql, params = {}) {
    const [rows] = await pool.query(sql, params);
    return Number(rows[0]?.total ?? 0);
}
async function groupCount(sql, params = {}) {
    const [rows] = await pool.query(sql, params);
    return rows.map((r) => ({ label: String(r.label), count: Number(r.cnt) }));
}
export async function getAdminStatistics() {
    const [usersTotal, usersByRole, usersByStatus, usersEmailVerified, usersWithPhone, usersWithNationalId, usersNewToday, usersNew7d, usersNew30d, adminsTotal, partnerAppsTotal, partnerAppsByStatus, partnerAppsByPartnerType, partnerAppsReviewed, partnerAppsPending, organizersTotal, organizersByStatus, organizersByPartnerType, organizersWithPayout, organizersByCity, listingsTotal, listingsByKind, listingsByStatus, listingsPublicVisible, listingsWithEventDate, listingsUpcoming, listingsPastEventDate, listingsWithCapacity, listingsAvgPrice, listingsMinPrice, listingsMaxPrice, listingsByCategory, seatsTotal, seatsByStatus, seatLayoutsTotal, seatLayoutsByDriverSide, ordersTotal, ordersByStatus, ordersRevenueConfirmed, ordersRevenuePending, ordersRevenueFailed, ordersByPaymentMethod, ordersNewToday, ordersNew7d, ordersNew30d, ordersAvgTotal, orderItemsTotal, orderItemsQtySum, userTicketsTotal, userTicketsByStatus, userTicketsVerified, userTicketsWithSeat, userTicketsRevenue, userTicketsUniqueHolders, ledgerTotal, ledgerByStatus, ledgerAmountCompleted, ledgerAmountPending, ledgerAmountFailed, ledgerByPaymentMethod, ledgerAvgPollCount, verificationsTotal, verificationsByResult, verificationsByMethod, verifierAssignmentsTotal, verifierAssignmentsByStatus, checkoutQueueTotal, checkoutQueueByStatus, reminderLogTotal, reminderLogByDaysBefore, ticketSharesTotal, ticketSharesByStatus, payoutVerificationsTotal, payoutVerificationsByStatus, organizerPayoutsTotal, organizerPayoutsByStatus, organizerPayoutsAmountCompleted, organizerPayoutsAmountPending, paymentMethodsTotal, paymentMethodsByType, passwordChangeRequestsTotal, passwordChangeRequestsPending, emailCodesUnused, magicLinksUnused, emailCodesTotal, emailCodesByPurpose, emailCodesUsed, magicLinksTotal, magicLinksByAccountLink, magicLinksUsed, usersWithUsername, usersSuspended, partnerAppsByRegion, partnerAppsByCity, listingsSoldOutWithRemaining, listingsTopLocations, ordersServiceFeesTotal, ordersRefunded, orderItemsWithSeats, orderItemsAvgQty, seatsTaken, userTicketsNewToday, userTicketsNew7d, userTicketsNew30d, userTicketsAvgPaid, verificationRejectReasons, verifierAssignmentsActive, checkoutQueueWaiting, ticketSharesUniqueRecipients, payoutVerificationsAvgAttempts, payoutVerificationsTopBanks, organizerPayoutsFailed, organizerPayoutsProcessing, paymentMethodsUsers, paymentMethodsDefault,] = await Promise.all([
        count(`SELECT COUNT(*) AS cnt FROM users`),
        groupCount(`SELECT role AS label, COUNT(*) AS cnt FROM users GROUP BY role`),
        groupCount(`SELECT status AS label, COUNT(*) AS cnt FROM users GROUP BY status`),
        count(`SELECT COUNT(*) AS cnt FROM users WHERE email_verified = 1`),
        count(`SELECT COUNT(*) AS cnt FROM users WHERE phone IS NOT NULL AND phone != ''`),
        count(`SELECT COUNT(*) AS cnt FROM users WHERE national_id IS NOT NULL AND national_id != ''`),
        count(`SELECT COUNT(*) AS cnt FROM users WHERE DATE(created_at) = CURDATE()`),
        count(`SELECT COUNT(*) AS cnt FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`),
        count(`SELECT COUNT(*) AS cnt FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`),
        count(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin'`),
        count(`SELECT COUNT(*) AS cnt FROM partner_applications`),
        groupCount(`SELECT status AS label, COUNT(*) AS cnt FROM partner_applications GROUP BY status`),
        groupCount(`SELECT partner_type AS label, COUNT(*) AS cnt FROM partner_applications GROUP BY partner_type`),
        count(`SELECT COUNT(*) AS cnt FROM partner_applications WHERE reviewed_at IS NOT NULL`),
        count(`SELECT COUNT(*) AS cnt FROM partner_applications WHERE status IN ('submitted','reviewing')`),
        count(`SELECT COUNT(*) AS cnt FROM organizer_profiles`),
        groupCount(`SELECT status AS label, COUNT(*) AS cnt FROM organizer_profiles GROUP BY status`),
        groupCount(`SELECT partner_type AS label, COUNT(*) AS cnt FROM organizer_profiles GROUP BY partner_type`),
        count(`SELECT COUNT(*) AS cnt FROM organizer_profiles
       WHERE payout_account_number IS NOT NULL AND payout_account_number != ''`),
        groupCount(`SELECT city AS label, COUNT(*) AS cnt FROM organizer_profiles GROUP BY city ORDER BY cnt DESC LIMIT 15`),
        count(`SELECT COUNT(*) AS cnt FROM listings`),
        groupCount(`SELECT kind AS label, COUNT(*) AS cnt FROM listings GROUP BY kind`),
        groupCount(`SELECT status AS label, COUNT(*) AS cnt FROM listings GROUP BY status`),
        count(`SELECT COUNT(*) AS cnt FROM listings WHERE ${PUBLIC_VISIBILITY_SQL}`),
        count(`SELECT COUNT(*) AS cnt FROM listings WHERE event_starts_on IS NOT NULL`),
        count(`SELECT COUNT(*) AS cnt FROM listings WHERE event_starts_on >= CURDATE()`),
        count(`SELECT COUNT(*) AS cnt FROM listings WHERE event_starts_on < CURDATE()`),
        count(`SELECT COUNT(*) AS cnt FROM listings WHERE ticket_capacity IS NOT NULL AND ticket_capacity > 0`),
        sum(`SELECT ROUND(AVG(price_mwk)) AS total FROM listings`),
        sum(`SELECT MIN(price_mwk) AS total FROM listings`),
        sum(`SELECT MAX(price_mwk) AS total FROM listings`),
        groupCount(`SELECT category AS label, COUNT(*) AS cnt FROM listings GROUP BY category ORDER BY cnt DESC LIMIT 20`),
        count(`SELECT COUNT(*) AS cnt FROM seats`),
        groupCount(`SELECT status AS label, COUNT(*) AS cnt FROM seats GROUP BY status`),
        count(`SELECT COUNT(*) AS cnt FROM seat_layouts`),
        groupCount(`SELECT driver_side AS label, COUNT(*) AS cnt FROM seat_layouts GROUP BY driver_side`),
        count(`SELECT COUNT(*) AS cnt FROM orders`),
        groupCount(`SELECT status AS label, COUNT(*) AS cnt FROM orders GROUP BY status`),
        sum(`SELECT COALESCE(SUM(total_mwk),0) AS total FROM orders WHERE status = 'confirmed'`),
        sum(`SELECT COALESCE(SUM(total_mwk),0) AS total FROM orders WHERE status = 'pending'`),
        sum(`SELECT COALESCE(SUM(total_mwk),0) AS total FROM orders WHERE status = 'failed'`),
        groupCount(`SELECT payment_method AS label, COUNT(*) AS cnt FROM orders GROUP BY payment_method`),
        count(`SELECT COUNT(*) AS cnt FROM orders WHERE DATE(created_at) = CURDATE()`),
        count(`SELECT COUNT(*) AS cnt FROM orders WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`),
        count(`SELECT COUNT(*) AS cnt FROM orders WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`),
        sum(`SELECT ROUND(AVG(total_mwk)) AS total FROM orders WHERE status = 'confirmed'`),
        count(`SELECT COUNT(*) AS cnt FROM order_items`),
        sum(`SELECT COALESCE(SUM(quantity),0) AS total FROM order_items`),
        count(`SELECT COUNT(*) AS cnt FROM user_tickets`),
        groupCount(`SELECT status AS label, COUNT(*) AS cnt FROM user_tickets GROUP BY status`),
        count(`SELECT COUNT(*) AS cnt FROM user_tickets WHERE verified_at IS NOT NULL`),
        count(`SELECT COUNT(*) AS cnt FROM user_tickets WHERE seat_number IS NOT NULL`),
        sum(`SELECT COALESCE(SUM(amount_paid),0) AS total FROM user_tickets`),
        count(`SELECT COUNT(DISTINCT user_id) AS cnt FROM user_tickets`),
        count(`SELECT COUNT(*) AS cnt FROM payment_ledger`),
        groupCount(`SELECT status AS label, COUNT(*) AS cnt FROM payment_ledger GROUP BY status`),
        sum(`SELECT COALESCE(SUM(amount_mwk),0) AS total FROM payment_ledger WHERE status = 'completed'`),
        sum(`SELECT COALESCE(SUM(amount_mwk),0) AS total FROM payment_ledger WHERE status = 'pending'`),
        sum(`SELECT COALESCE(SUM(amount_mwk),0) AS total FROM payment_ledger WHERE status = 'failed'`),
        groupCount(`SELECT payment_method AS label, COUNT(*) AS cnt FROM payment_ledger GROUP BY payment_method`),
        sum(`SELECT ROUND(AVG(poll_count)) AS total FROM payment_ledger`),
        count(`SELECT COUNT(*) AS cnt FROM ticket_verifications`),
        groupCount(`SELECT result AS label, COUNT(*) AS cnt FROM ticket_verifications GROUP BY result`),
        groupCount(`SELECT method AS label, COUNT(*) AS cnt FROM ticket_verifications GROUP BY method`),
        count(`SELECT COUNT(*) AS cnt FROM listing_verifier_assignments`),
        groupCount(`SELECT status AS label, COUNT(*) AS cnt FROM listing_verifier_assignments GROUP BY status`),
        count(`SELECT COUNT(*) AS cnt FROM checkout_queue`),
        groupCount(`SELECT status AS label, COUNT(*) AS cnt FROM checkout_queue GROUP BY status`),
        count(`SELECT COUNT(*) AS cnt FROM ticket_reminder_log`),
        groupCount(`SELECT days_before AS label, COUNT(*) AS cnt FROM ticket_reminder_log GROUP BY days_before`),
        count(`SELECT COUNT(*) AS cnt FROM ticket_shares`),
        groupCount(`SELECT status AS label, COUNT(*) AS cnt FROM ticket_shares GROUP BY status`),
        count(`SELECT COUNT(*) AS cnt FROM payout_verifications`),
        groupCount(`SELECT status AS label, COUNT(*) AS cnt FROM payout_verifications GROUP BY status`),
        count(`SELECT COUNT(*) AS cnt FROM organizer_payouts`),
        groupCount(`SELECT status AS label, COUNT(*) AS cnt FROM organizer_payouts GROUP BY status`),
        sum(`SELECT COALESCE(SUM(amount_mwk),0) AS total FROM organizer_payouts WHERE status = 'completed'`),
        sum(`SELECT COALESCE(SUM(amount_mwk),0) AS total FROM organizer_payouts WHERE status IN ('pending','processing')`),
        count(`SELECT COUNT(*) AS cnt FROM payment_methods`),
        groupCount(`SELECT type AS label, COUNT(*) AS cnt FROM payment_methods GROUP BY type`),
        count(`SELECT COUNT(*) AS cnt FROM password_change_requests`),
        count(`SELECT COUNT(*) AS cnt FROM password_change_requests WHERE used_at IS NULL AND expires_at > NOW()`),
        count(`SELECT COUNT(*) AS cnt FROM email_verification_codes WHERE used_at IS NULL AND expires_at > NOW()`),
        count(`SELECT COUNT(*) AS cnt FROM magic_link_tokens WHERE used_at IS NULL AND expires_at > NOW()`),
        count(`SELECT COUNT(*) AS cnt FROM email_verification_codes`),
        groupCount(`SELECT purpose AS label, COUNT(*) AS cnt FROM email_verification_codes GROUP BY purpose`),
        count(`SELECT COUNT(*) AS cnt FROM email_verification_codes WHERE used_at IS NOT NULL`),
        count(`SELECT COUNT(*) AS cnt FROM magic_link_tokens`),
        groupCount(`SELECT CASE WHEN user_id IS NULL THEN 'Email only' ELSE 'Linked account' END AS label,
              COUNT(*) AS cnt
       FROM magic_link_tokens
       GROUP BY CASE WHEN user_id IS NULL THEN 'Email only' ELSE 'Linked account' END`),
        count(`SELECT COUNT(*) AS cnt FROM magic_link_tokens WHERE used_at IS NOT NULL`),
        count(`SELECT COUNT(*) AS cnt FROM users WHERE username IS NOT NULL AND username != ''`),
        count(`SELECT COUNT(*) AS cnt FROM users WHERE status = 'suspended'`),
        groupCount(`SELECT region AS label, COUNT(*) AS cnt FROM partner_applications GROUP BY region ORDER BY cnt DESC LIMIT 15`),
        groupCount(`SELECT city AS label, COUNT(*) AS cnt FROM partner_applications GROUP BY city ORDER BY cnt DESC LIMIT 15`),
        count(`SELECT COUNT(*) AS cnt FROM listings l
       WHERE l.status = 'sold_out'
         AND l.ticket_capacity IS NOT NULL
         AND l.ticket_capacity > (
           SELECT COALESCE(SUM(oi.quantity), 0)
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           WHERE o.listing_id = l.id AND o.status = 'confirmed'
         )`),
        groupCount(`SELECT location AS label, COUNT(*) AS cnt FROM listings GROUP BY location ORDER BY cnt DESC LIMIT 15`),
        sum(`SELECT COALESCE(SUM(service_fee_mwk), 0) AS total FROM orders WHERE status = 'confirmed'`),
        count(`SELECT COUNT(*) AS cnt FROM orders WHERE status = 'refunded'`),
        count(`SELECT COUNT(*) AS cnt FROM order_items WHERE seat_id IS NOT NULL`),
        sum(`SELECT ROUND(AVG(quantity)) AS total FROM order_items`),
        count(`SELECT COUNT(*) AS cnt FROM seats WHERE status = 'taken'`),
        count(`SELECT COUNT(*) AS cnt FROM user_tickets WHERE DATE(purchased_at) = CURDATE()`),
        count(`SELECT COUNT(*) AS cnt FROM user_tickets WHERE purchased_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`),
        count(`SELECT COUNT(*) AS cnt FROM user_tickets WHERE purchased_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`),
        sum(`SELECT ROUND(AVG(amount_paid)) AS total FROM user_tickets`),
        groupCount(`SELECT COALESCE(reject_reason, 'none') AS label, COUNT(*) AS cnt
       FROM ticket_verifications WHERE result = 'rejected'
       GROUP BY reject_reason`),
        count(`SELECT COUNT(*) AS cnt FROM listing_verifier_assignments
       WHERE status = 'active' AND expires_at > NOW()`),
        count(`SELECT COUNT(*) AS cnt FROM checkout_queue WHERE status = 'waiting'`),
        count(`SELECT COUNT(DISTINCT recipient_email) AS cnt FROM ticket_shares`),
        sum(`SELECT ROUND(AVG(attempt_count)) AS total FROM payout_verifications`),
        groupCount(`SELECT bank_name AS label, COUNT(*) AS cnt FROM payout_verifications GROUP BY bank_name ORDER BY cnt DESC LIMIT 10`),
        count(`SELECT COUNT(*) AS cnt FROM organizer_payouts WHERE status = 'failed'`),
        count(`SELECT COUNT(*) AS cnt FROM organizer_payouts WHERE status = 'processing'`),
        count(`SELECT COUNT(DISTINCT user_id) AS cnt FROM payment_methods`),
        count(`SELECT COUNT(*) AS cnt FROM payment_methods WHERE is_default = 1`),
    ]);
    const topListingsBySales = await groupCount(`SELECT l.title AS label, COUNT(ut.id) AS cnt
     FROM user_tickets ut
     JOIN listings l ON l.id = ut.listing_id
     GROUP BY l.id, l.title
     ORDER BY cnt DESC LIMIT 10`);
    const topOrganizersByRevenue = await groupCount(`SELECT op.company_name AS label, COALESCE(SUM(o.total_mwk),0) AS cnt
     FROM orders o
     JOIN listings l ON l.id = o.listing_id
     JOIN organizer_profiles op ON op.user_id = l.organizer_id
     WHERE o.status = 'confirmed'
     GROUP BY op.user_id, op.company_name
     ORDER BY cnt DESC LIMIT 10`);
    const salesByListingKind = await groupCount(`SELECT l.kind AS label, COUNT(ut.id) AS cnt
     FROM user_tickets ut
     JOIN listings l ON l.id = ut.listing_id
     GROUP BY l.kind`);
    const revenueByListingKind = await groupCount(`SELECT l.kind AS label, COALESCE(SUM(o.total_mwk), 0) AS cnt
     FROM orders o
     JOIN listings l ON l.id = o.listing_id
     WHERE o.status = 'confirmed'
     GROUP BY l.kind`);
    const topOrganizersByListings = await groupCount(`SELECT op.company_name AS label, COUNT(l.id) AS cnt
     FROM listings l
     JOIN organizer_profiles op ON op.user_id = l.organizer_id
     GROUP BY op.user_id, op.company_name
     ORDER BY cnt DESC LIMIT 10`);
    const seatOccupancyPercent = seatsTotal > 0 ? Math.round((seatsTaken / seatsTotal) * 10000) / 100 : 0;
    const gateVerificationRatePercent = userTicketsTotal > 0
        ? Math.round((userTicketsVerified / userTicketsTotal) * 10000) / 100
        : 0;
    const conversionRate = ordersTotal > 0
        ? Math.round((ordersByStatus.find((x) => x.label === "confirmed")?.count ?? 0) / ordersTotal * 10000) / 100
        : 0;
    return {
        generatedAt: new Date().toISOString(),
        users: {
            total: usersTotal,
            admins: adminsTotal,
            byRole: usersByRole,
            byStatus: usersByStatus,
            emailVerified: usersEmailVerified,
            emailUnverified: usersTotal - usersEmailVerified,
            withPhone: usersWithPhone,
            withNationalId: usersWithNationalId,
            withUsername: usersWithUsername,
            suspended: usersSuspended,
            newToday: usersNewToday,
            newLast7Days: usersNew7d,
            newLast30Days: usersNew30d,
        },
        partnerApplications: {
            total: partnerAppsTotal,
            byStatus: partnerAppsByStatus,
            byPartnerType: partnerAppsByPartnerType,
            byRegion: partnerAppsByRegion,
            byCity: partnerAppsByCity,
            reviewed: partnerAppsReviewed,
            pendingReview: partnerAppsPending,
        },
        organizers: {
            total: organizersTotal,
            byStatus: organizersByStatus,
            byPartnerType: organizersByPartnerType,
            withPayoutAccount: organizersWithPayout,
            topCities: organizersByCity,
            topByListingCount: topOrganizersByListings,
        },
        listings: {
            total: listingsTotal,
            byKind: listingsByKind,
            byStatus: listingsByStatus,
            publiclyVisible: listingsPublicVisible,
            soldOutWithRemainingCapacity: listingsSoldOutWithRemaining,
            withEventStartsOn: listingsWithEventDate,
            upcomingEvents: listingsUpcoming,
            pastEventDate: listingsPastEventDate,
            withTicketCapacity: listingsWithCapacity,
            avgPriceMwk: listingsAvgPrice,
            minPriceMwk: listingsMinPrice,
            maxPriceMwk: listingsMaxPrice,
            topCategories: listingsByCategory,
            topLocations: listingsTopLocations,
            topByTicketsSold: topListingsBySales,
        },
        seats: {
            total: seatsTotal,
            taken: seatsTaken,
            occupancyRatePercent: seatOccupancyPercent,
            byStatus: seatsByStatus,
            layouts: seatLayoutsTotal,
            layoutsByDriverSide: seatLayoutsByDriverSide,
        },
        orders: {
            total: ordersTotal,
            byStatus: ordersByStatus,
            revenueConfirmedMwk: ordersRevenueConfirmed,
            revenuePendingMwk: ordersRevenuePending,
            revenueFailedMwk: ordersRevenueFailed,
            serviceFeesMwk: ordersServiceFeesTotal,
            refunded: ordersRefunded,
            revenueByListingKind,
            byPaymentMethod: ordersByPaymentMethod,
            newToday: ordersNewToday,
            newLast7Days: ordersNew7d,
            newLast30Days: ordersNew30d,
            avgOrderTotalMwk: ordersAvgTotal,
            confirmationRatePercent: conversionRate,
        },
        orderItems: {
            total: orderItemsTotal,
            totalQuantity: orderItemsQtySum,
            withSeatAssignment: orderItemsWithSeats,
            avgQuantityPerLine: orderItemsAvgQty,
        },
        userTickets: {
            total: userTicketsTotal,
            byStatus: userTicketsByStatus,
            gateVerified: userTicketsVerified,
            gateVerificationRatePercent,
            withSeatNumber: userTicketsWithSeat,
            totalRevenueMwk: userTicketsRevenue,
            avgAmountPaidMwk: userTicketsAvgPaid,
            uniqueHolders: userTicketsUniqueHolders,
            newToday: userTicketsNewToday,
            newLast7Days: userTicketsNew7d,
            newLast30Days: userTicketsNew30d,
            byListingKind: salesByListingKind,
        },
        paymentLedger: {
            total: ledgerTotal,
            byStatus: ledgerByStatus,
            amountCompletedMwk: ledgerAmountCompleted,
            amountPendingMwk: ledgerAmountPending,
            amountFailedMwk: ledgerAmountFailed,
            byPaymentMethod: ledgerByPaymentMethod,
            avgPollCount: ledgerAvgPollCount,
        },
        ticketVerifications: {
            total: verificationsTotal,
            byResult: verificationsByResult,
            byMethod: verificationsByMethod,
            rejectReasons: verificationRejectReasons,
        },
        verifierAssignments: {
            total: verifierAssignmentsTotal,
            active: verifierAssignmentsActive,
            byStatus: verifierAssignmentsByStatus,
        },
        checkoutQueue: {
            total: checkoutQueueTotal,
            waiting: checkoutQueueWaiting,
            byStatus: checkoutQueueByStatus,
        },
        reminderEmails: {
            totalSent: reminderLogTotal,
            byDaysBefore: reminderLogByDaysBefore,
        },
        ticketShares: {
            total: ticketSharesTotal,
            uniqueRecipients: ticketSharesUniqueRecipients,
            byStatus: ticketSharesByStatus,
        },
        payoutVerifications: {
            total: payoutVerificationsTotal,
            avgAttemptCount: payoutVerificationsAvgAttempts,
            topBanks: payoutVerificationsTopBanks,
            byStatus: payoutVerificationsByStatus,
        },
        organizerPayouts: {
            total: organizerPayoutsTotal,
            failed: organizerPayoutsFailed,
            processing: organizerPayoutsProcessing,
            byStatus: organizerPayoutsByStatus,
            amountCompletedMwk: organizerPayoutsAmountCompleted,
            amountPendingMwk: organizerPayoutsAmountPending,
            topOrganizersByRevenue: topOrganizersByRevenue,
        },
        paymentMethods: {
            total: paymentMethodsTotal,
            uniqueUsers: paymentMethodsUsers,
            defaultMethods: paymentMethodsDefault,
            byType: paymentMethodsByType,
        },
        security: {
            passwordChangeRequestsTotal,
            passwordChangeRequestsPending,
            emailVerificationCodesTotal: emailCodesTotal,
            emailVerificationCodesUsed: emailCodesUsed,
            emailVerificationCodesByPurpose: emailCodesByPurpose,
            activeEmailVerificationCodes: emailCodesUnused,
            magicLinkTokensTotal: magicLinksTotal,
            magicLinkTokensUsed: magicLinksUsed,
            magicLinkTokensByAccountLink: magicLinksByAccountLink,
            activeMagicLinkTokens: magicLinksUnused,
        },
    };
}
