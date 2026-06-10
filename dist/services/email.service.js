import nodemailer from "nodemailer";
import { env } from "../config/env.js";
let transporter = null;
function getTransporter() {
    if (!env.mail.host || !env.mail.user) {
        console.warn("[email] SMTP not configured — emails will be logged to console only.");
        return null;
    }
    if (!transporter) {
        transporter = nodemailer.createTransport({
            host: env.mail.host,
            port: env.mail.port,
            secure: env.mail.secure,
            auth: { user: env.mail.user, pass: env.mail.pass },
        });
    }
    return transporter;
}
function wrapHtml(title, body) {
    return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px">
    <h2 style="color:#1e40af;margin-bottom:16px">${title}</h2>
    ${body}
    <p style="margin-top:32px;font-size:12px;color:#6b7280">Ticket Malawi — Powered by Oasis</p>
  </body></html>`;
}
export async function sendEmail(to, subject, html) {
    const transport = getTransporter();
    const from = `"${env.mail.fromName}" <${env.mail.fromAddress}>`;
    if (!transport) {
        console.log(`[email] To: ${to} | Subject: ${subject}\n${html.replace(/<[^>]+>/g, " ")}`);
        return { sent: false, logged: true };
    }
    await transport.sendMail({ from, to, subject, html });
    return { sent: true };
}
export async function sendLoginCode(email, fullName, code) {
    return sendEmail(email, "Your Ticket Malawi sign-in code", wrapHtml("Sign-in security code", `<p>Hi ${fullName},</p>
       <p>Someone is signing in to your Ticket Malawi account. Your security code is:</p>
       <p style="font-size:32px;font-weight:700;letter-spacing:8px;color:#1e40af">${code}</p>
       <p>This code expires in 15 minutes. If you did not try to sign in, change your password immediately.</p>`));
}
export async function sendVerificationCode(email, fullName, code) {
    return sendEmail(email, "Verify your Ticket Malawi account", wrapHtml("Verify your email", `<p>Hi ${fullName},</p>
       <p>Your verification code is:</p>
       <p style="font-size:32px;font-weight:700;letter-spacing:8px;color:#1e40af">${code}</p>
       <p>This code expires in 15 minutes. If you did not create an account, ignore this email.</p>`));
}
export async function sendWelcomeEmail(email, fullName) {
    return sendEmail(email, "Welcome to Ticket Malawi", wrapHtml("Welcome!", `<p>Hi ${fullName},</p><p>Your email is verified and your Ticket Malawi account is active. Start exploring events and travel across Malawi.</p>`));
}
export async function sendAccountStatusEmail(email, fullName, status) {
    const messages = {
        suspended: "Your account has been suspended. Contact support if you believe this is an error.",
        inactive: "Your account has been deactivated.",
        active: "Your account has been reactivated. You can sign in again.",
    };
    return sendEmail(email, `Ticket Malawi account ${status}`, wrapHtml("Account update", `<p>Hi ${fullName},</p><p>${messages[status]}</p>`));
}
export async function sendPartnerApplicationReceived(email, companyName) {
    return sendEmail(email, "Partner application received — Ticket Malawi", wrapHtml("Application received", `<p>Thank you for applying to partner with Ticket Malawi as <strong>${companyName}</strong>.</p>
       <p>Our team will review your application and email you within 3–5 business days.</p>`));
}
export async function sendPartnerDecisionEmail(email, companyName, approved, notes) {
    const body = approved
        ? `<p>Congratulations! Your partner application for <strong>${companyName}</strong> has been approved.</p>
       <p>You can now sign in and access the organizer dashboard.</p>`
        : `<p>Your partner application for <strong>${companyName}</strong> was not approved at this time.</p>
       ${notes ? `<p><strong>Note:</strong> ${notes}</p>` : ""}`;
    return sendEmail(email, approved ? "Partner application approved" : "Partner application update", wrapHtml(approved ? "Application approved" : "Application update", body));
}
export async function sendOrganizerStatusEmail(email, companyName, status) {
    return sendEmail(email, `Organizer account ${status} — Ticket Malawi`, wrapHtml("Organizer status update", `<p>The organizer account for <strong>${companyName}</strong> is now <strong>${status}</strong>.</p>`));
}
export async function sendPayoutVerificationCode(email, accountName, amountMwk, bankName, code) {
    return sendEmail(email, "Verify your Ticket Malawi payout", wrapHtml("Payout verification", `<p>Hi ${accountName},</p>
       <p>Someone requested a payout of <strong>MK ${amountMwk.toLocaleString()}</strong> to <strong>${bankName}</strong> on your Ticket Malawi organizer account.</p>
       <p>Your verification code is:</p>
       <p style="font-size:32px;font-weight:700;letter-spacing:8px;color:#1e40af">${code}</p>
       <p>This code expires in 15 minutes. If you did not request this payout, ignore this email and contact support.</p>`));
}
export async function sendTicketSharedToRecipientEmail(input) {
    const seatLine = input.seat ? `<p><strong>Seat:</strong> ${input.seat}</p>` : "";
    const dateLine = input.eventDate ? `<p><strong>Date:</strong> ${input.eventDate}</p>` : "";
    return sendEmail(input.recipientEmail, `You received a ticket — ${input.ticketTitle}`, wrapHtml("Ticket transferred to you", `<p>Hi ${input.recipientName},</p>
       <p><strong>${input.sharerName}</strong> shared a Ticket Malawi ticket with you. It is now in your dashboard under <strong>My Tickets</strong>.</p>
       <div style="margin:20px 0;padding:16px;background:#f3f4f6;border-radius:12px">
         <p style="margin:0 0 8px"><strong>${input.ticketTitle}</strong></p>
         <p style="margin:0 0 4px"><strong>Reference:</strong> ${input.reference}</p>
         ${dateLine}
         ${seatLine}
       </div>
       <p>Sign in to view your QR code and ticket details before you travel or attend the event.</p>`));
}
export async function sendTicketSharedBySenderEmail(input) {
    return sendEmail(input.sharerEmail, `Ticket shared with ${input.recipientName}`, wrapHtml("Share confirmed", `<p>Hi ${input.sharerName},</p>
       <p>You successfully transferred <strong>${input.ticketTitle}</strong> (${input.reference}) to <strong>${input.recipientName}</strong> (${input.recipientEmail}).</p>
       <p>The ticket has been removed from your account and now belongs to the recipient.</p>
       <p>If you did not authorize this transfer, contact Ticket Malawi support immediately.</p>`));
}
export async function sendPasswordChangeCode(email, fullName, code) {
    return sendEmail(email, "Confirm your new password — Ticket Malawi", wrapHtml("Confirm password change", `<p>Hi ${fullName},</p>
       <p>Use this code to confirm your password change:</p>
       <p style="font-size:32px;font-weight:700;letter-spacing:8px;color:#1e40af">${code}</p>
       <p>This code expires in 15 minutes. If you did not request this, ignore this email.</p>`));
}
export async function sendPasswordChangedEmail(email, fullName) {
    return sendEmail(email, "Password changed — Ticket Malawi", wrapHtml("Password updated", `<p>Hi ${fullName},</p><p>Your password was changed successfully. If you did not make this change, contact support immediately.</p>`));
}
export async function sendEventReminderEmail(input) {
    const when = input.daysBefore === 1
        ? "tomorrow"
        : `in ${input.daysBefore} days`;
    const kindLabel = input.kind === "travel" ? "trip" : "event";
    return sendEmail(input.email, `Reminder: your ${kindLabel} is ${when}`, wrapHtml(`${input.listingTitle} is coming up`, `<p>Hi ${input.fullName},</p>
       <p>Your <strong>${input.listingTitle}</strong> ${kindLabel} is <strong>${when}</strong>.</p>
       <ul style="padding-left:18px;line-height:1.6">
         <li><strong>When:</strong> ${input.dateLabel}${input.timeLabel ? ` · ${input.timeLabel}` : ""}</li>
         <li><strong>Where:</strong> ${input.location}</li>
         <li><strong>Reference:</strong> ${input.reference}${input.seat ? ` · Seat ${input.seat}` : ""}</li>
       </ul>
       <p>Open your Ticket Malawi dashboard to view your ticket and QR code before you travel or attend.</p>`));
}
export async function sendOrganizerSuspensionEmail(email, companyName, reason, until) {
    const untilLine = until
        ? `<p>Your suspension is in effect until <strong>${until.toLocaleString()}</strong>. You may submit an appeal from your organizer dashboard.</p>`
        : `<p>Contact Ticket Malawi support if you believe this is an error.</p>`;
    return sendEmail(email, `Organizer account suspended — ${companyName}`, wrapHtml("Account suspended", `<p>The organizer account for <strong>${companyName}</strong> has been suspended.</p>
       <p><strong>Reason:</strong> ${reason}</p>
       ${untilLine}
       <p>Your listings are hidden from public view while suspended. Customers with existing tickets have been notified.</p>`));
}
export async function sendOrganizerContentSuspensionEmail(email, companyName, listingTitle) {
    return sendEmail(email, `Listing removed — explicit content policy`, wrapHtml("Content policy violation", `<p>The listing <strong>${listingTitle}</strong> for <strong>${companyName}</strong> contained explicit or prohibited language.</p>
       <p>Your organizer account has been suspended pending review. Edit listings to comply with Ticket Malawi community guidelines.</p>`));
}
export async function sendOrganizerFlaggedEmail(email, companyName, reportCount) {
    return sendEmail(email, `Organizer account flagged for review — ${companyName}`, wrapHtml("Account flagged", `<p><strong>${companyName}</strong> has received <strong>${reportCount}</strong> user reports and is now flagged for admin review.</p>
       <p>A temporary flag is shown on your profile and listings. Our team will contact you. Continue cooperating with any investigation.</p>`));
}
export async function sendOrganizerBanEmail(email, companyName, notes) {
    return sendEmail(email, `Organizer account permanently banned — ${companyName}`, wrapHtml("Permanent ban", `<p>The organizer account for <strong>${companyName}</strong> has been permanently banned.</p>
       ${notes ? `<p><strong>Note:</strong> ${notes}</p>` : ""}
       <p>All listings have been taken down. Eligible ticket holders may receive refunds after settlement review.</p>`));
}
export async function sendOrganizerSuspendedBuyerNotice(organizerId, companyName) {
    const { pool } = await import("../db/pool.js");
    const [rows] = await pool.query(`SELECT DISTINCT u.email, u.full_name
     FROM user_tickets ut
     JOIN users u ON u.id = ut.user_id
     JOIN listings l ON l.id = ut.listing_id
     WHERE l.organizer_id = :organizerId AND ut.status = 'active'`, { organizerId });
    const buyers = rows;
    await Promise.all(buyers.map((b) => sendEmail(b.email, `Update on your ticket — ${companyName}`, wrapHtml("Organizer under review", `<p>Hi ${b.full_name},</p>
           <p>There are issues with the organizer <strong>${companyName}</strong> associated with one of your tickets.</p>
           <p>Your ticket is temporarily on hold in your dashboard. Tickets will become available again once the issues are cleared.</p>
           <p>If you purchased recently, we will email you about any refund if a permanent ban is applied.</p>`))));
}
export async function sendAppealReceivedEmail(email, companyName) {
    return sendEmail(email, `Appeal received — ${companyName}`, wrapHtml("Appeal submitted", `<p>We received your suspension appeal for <strong>${companyName}</strong>. Our team will review it and respond by email.</p>`));
}
export async function sendAppealDecisionEmail(email, companyName, approved, notes) {
    const body = approved
        ? `<p>Your appeal for <strong>${companyName}</strong> was approved. Your organizer account access has been restored where applicable.</p>`
        : `<p>Your appeal for <strong>${companyName}</strong> was not approved at this time.</p>
       ${notes ? `<p><strong>Note:</strong> ${notes}</p>` : ""}`;
    return sendEmail(email, approved ? "Appeal approved" : "Appeal decision", wrapHtml(approved ? "Appeal approved" : "Appeal update", body));
}
export async function sendListingPostponedEmails(input) {
    const { pool } = await import("../db/pool.js");
    const [rows] = await pool.query(`SELECT DISTINCT u.email, u.full_name, ut.reference, ut.seat_number
     FROM user_tickets ut
     JOIN users u ON u.id = ut.user_id
     WHERE ut.listing_id = :listingId AND ut.status IN ('active', 'expired')`, { listingId: input.listingId });
    const buyers = rows;
    await Promise.all(buyers.map((b) => sendEmail(b.email, `${input.listingTitle} has been postponed`, wrapHtml("Event postponed", `<p>Hi ${b.full_name},</p>
           <p><strong>${input.organizerName}</strong> has postponed <strong>${input.listingTitle}</strong>.</p>
           <ul style="padding-left:18px;line-height:1.6">
             <li><strong>Previous date:</strong> ${input.previousDateLabel}</li>
             <li><strong>New date:</strong> ${input.newDateLabel}${input.timeLabel ? ` · ${input.timeLabel}` : ""}</li>
             <li><strong>Location:</strong> ${input.location}</li>
             <li><strong>Your reference:</strong> ${b.reference}${b.seat_number != null ? ` · Seat ${b.seat_number}` : ""}</li>
           </ul>
           <p>Your ticket remains valid for the new date. Open your Ticket Malawi dashboard to view the updated details and QR code.</p>`))));
    return { notified: buyers.length };
}
export async function sendTicketRefundEmail(email, fullName, reference, refundAmount, originalAmount, context = "ban", paymentMethodLabel = "your original payment method") {
    const reasonLine = context === "listing_cancellation"
        ? "following cancellation of the event or travel listing by the organizer"
        : "following a permanent organizer ban";
    return sendEmail(email, `Refund processed — ${reference}`, wrapHtml("Refund issued", `<p>Hi ${fullName},</p>
       <p>A <strong>90% refund</strong> of <strong>MK ${refundAmount.toLocaleString()}</strong> has been sent to <strong>${paymentMethodLabel}</strong> for ticket <strong>${reference}</strong> (original MK ${originalAmount.toLocaleString()}).</p>
       <p>A 10% retention covers payment processing and Ticket Malawi's convenience fee per our policy ${reasonLine}.</p>`));
}
export async function sendListingCancelledBuyerPendingRefundEmail(input) {
    return sendEmail(input.email, `${input.listingTitle} has been cancelled`, wrapHtml("Listing cancelled", `<p>Hi ${input.fullName},</p>
       <p><strong>${input.listingTitle}</strong> has been cancelled by the organizer. Your ticket <strong>${input.reference}</strong> is no longer valid.</p>
       <p>A <strong>90% refund</strong> of <strong>MK ${input.expectedRefund.toLocaleString()}</strong> (from MK ${input.amountPaid.toLocaleString()} paid) will be sent to your original payment method once T+1 settlement completes for your payment.</p>
       <p>The remaining 10% covers payment processing and Ticket Malawi's convenience fee. We will email you when the refund is issued. Ticket sharing is disabled while a refund is in progress.</p>`));
}
export async function sendListingCancelledOrganizerEmail(input) {
    const debtNote = (input.debtIncrease ?? 0) > 0
        ? `<p><strong>Refund debt:</strong> MK ${input.debtIncrease.toLocaleString()} was added to your account because customer refunds exceed funds held from this listing (for example, if you had already withdrawn earnings). Future settled ticket sales will go toward paying customers back until this debt is cleared. Withdrawals remain blocked until then.</p>`
        : (input.coveredByHold ?? 0) > 0
            ? `<p>Funds held from this listing (MK ${input.coveredByHold.toLocaleString()}) were applied toward customer refunds.</p>`
            : "";
    return sendEmail(input.email, `Listing cancelled — ${input.listingTitle}`, wrapHtml("Listing cancelled", `<p>Hi ${input.companyName},</p>
       <p>You cancelled <strong>${input.listingTitle}</strong> on Ticket Malawi.</p>
       <ul style="padding-left:18px;line-height:1.6">
         <li><strong>Tickets reviewed:</strong> ${input.ticketsReviewed}</li>
         <li><strong>Refunds issued now:</strong> ${input.refundsCompleted}</li>
         <li><strong>Refunds pending settlement:</strong> ${input.refundsPending}</li>
         <li><strong>Total refunded:</strong> MK ${input.totalRefunded.toLocaleString()}</li>
         <li><strong>Funds held from this listing:</strong> MK ${input.fundsHeld.toLocaleString()} (not available for payout)</li>
       </ul>
       ${debtNote}
       <p>Eligible ticket holders receive a 90% refund; 10% covers processing and convenience fees. All parties have been notified by email.</p>`));
}
export async function sendOrganizerRefundDebtEmail(input) {
    return sendEmail(input.email, "Customer refund debt on your Ticket Malawi account", wrapHtml("Refund debt recorded", `<p>Hi ${input.companyName},</p>
       <p>MK ${input.amountAdded.toLocaleString()} was added to your customer refund debt because you owe refunds that are not fully covered by held listing funds or your current withdrawable balance.</p>
       <ul style="padding-left:18px;line-height:1.6">
         <li><strong>Total refund debt:</strong> MK ${input.totalDebt.toLocaleString()}</li>
         <li><strong>Outstanding (unrecovered):</strong> MK ${input.outstanding.toLocaleString()}</li>
       </ul>
       <p>Until this outstanding amount is cleared, <strong>withdrawals are blocked</strong>. When you publish new listings and customers purchase tickets, settled earnings from those sales are applied to customer refunds first. Only after every affected customer is paid back will you have a positive withdrawable balance again.</p>`));
}
