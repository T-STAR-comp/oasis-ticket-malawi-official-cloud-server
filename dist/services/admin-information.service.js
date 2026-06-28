import { pool } from "../db/pool.js";
import { sendEmail } from "./email.service.js";
async function listRecipientEmails(audience) {
    let sql = `SELECT DISTINCT email FROM users WHERE email IS NOT NULL AND email != '' AND status = 'active'`;
    if (audience === "organizers") {
        sql = `SELECT DISTINCT u.email
           FROM users u
           JOIN organizer_profiles op ON op.user_id = u.id
           WHERE u.email IS NOT NULL AND u.email != '' AND u.status = 'active'
             AND op.status IN ('approved', 'pending', 'suspended')`;
    }
    const [rows] = await pool.query(sql);
    return rows.map((r) => String(r.email).trim().toLowerCase()).filter(Boolean);
}
export async function sendAdminBroadcastEmail(input) {
    const subject = input.subject.trim();
    const bodyHtml = input.bodyHtml.trim();
    if (!subject)
        throw new Error("Subject is required");
    if (!bodyHtml)
        throw new Error("Email body is required");
    const recipients = await listRecipientEmails(input.audience);
    if (recipients.length === 0) {
        throw new Error("No recipients found for the selected audience");
    }
    const html = `<div style="line-height:1.6">${bodyHtml}</div>`;
    let sent = 0;
    let logged = 0;
    const failures = [];
    for (const email of recipients) {
        try {
            const result = await sendEmail(email, subject, html);
            if (result.sent)
                sent += 1;
            else
                logged += 1;
        }
        catch (err) {
            failures.push(email);
            console.error("[admin-information] Failed to send to", email, err);
        }
    }
    return {
        audience: input.audience,
        recipientCount: recipients.length,
        sent,
        logged,
        failed: failures.length,
        message: failures.length > 0
            ? `Sent to ${sent} recipients. ${failures.length} failed.`
            : `Message queued for ${recipients.length} recipient${recipients.length === 1 ? "" : "s"}.`,
    };
}
