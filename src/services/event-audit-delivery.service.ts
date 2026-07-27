import type { RowDataPacket } from "mysql2";
import { pool } from "../db/pool.js";
import { parseEventStartsAt } from "../utils/virtual-events.js";
import * as emailService from "./email.service.js";
import {
  buildEventAuditSnapshot,
  hasAutoAuditReport,
  recordAuditReport,
  recordAuditDeliverySkip,
  tryResolveOrganizerContact,
} from "./event-audit.service.js";
import { generateEventAuditPdf } from "./event-audit-pdf.service.js";

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export async function sendEventAuditReport(input: {
  listingId: string;
  triggerKind: "auto" | "manual";
  triggeredBy?: string;
  recipientEmail?: string;
}) {
  const snapshot = await buildEventAuditSnapshot(input.listingId);
  const email = input.recipientEmail?.trim() || snapshot.organizerEmail;
  if (!email) throw new Error("Organizer email not found");

  const pdf = await generateEventAuditPdf(snapshot);
  const filename = `event-audit-${slugify(snapshot.title)}-${snapshot.listingId.slice(-8)}.pdf`;

  await emailService.sendEventAuditReportEmail({
    email,
    companyName: snapshot.companyName,
    listingTitle: snapshot.title,
    eventDateLabel: snapshot.dateLabel,
    attachments: [{ filename, content: pdf }],
  });

  await recordAuditReport({
    listingId: snapshot.listingId,
    organizerId: snapshot.organizerId,
    triggerKind: input.triggerKind,
    triggeredBy: input.triggeredBy,
    recipientEmail: email,
    pdfFilename: filename,
    summary: snapshot.summary,
  });

  return {
    listingId: snapshot.listingId,
    title: snapshot.title,
    recipientEmail: email,
    filename,
    sentAt: new Date().toISOString(),
  };
}

export async function processEventAuditReports() {
  let rows: RowDataPacket[] = [];
  try {
    const [result] = await pool.query<RowDataPacket[]>(
      `SELECT l.id AS listingId, l.title, l.organizer_id AS organizerId,
         l.event_starts_on AS eventStartsOn, l.time_label AS timeLabel
       FROM listings l
       JOIN users u ON u.id = l.organizer_id
       WHERE l.kind = 'event'
         AND l.event_starts_on IS NOT NULL
         AND l.status NOT IN ('draft', 'cancelled')
         AND NULLIF(TRIM(u.email), '') IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM event_audit_reports ear
           WHERE ear.listing_id = l.id AND ear.trigger_kind = 'auto'
         )`,
    );
    rows = result;
  } catch (err) {
    if (err instanceof Error && err.message.includes("event_audit_reports")) {
      console.warn("[event-audit] Table missing — run: npm run db:migrate:event-audit");
      return;
    }
    throw err;
  }

  const now = Date.now();
  let sent = 0;
  let skipped = 0;

  for (const row of rows) {
    const listingId = row.listingId as string;
    const organizerId = row.organizerId as string;
    const startsAt = parseEventStartsAt(
      row.eventStartsOn as string,
      String(row.timeLabel ?? ""),
    );
    if (!startsAt || startsAt.getTime() > now) continue;

    try {
      const already = await hasAutoAuditReport(listingId);
      if (already) continue;

      const contact = await tryResolveOrganizerContact(organizerId);
      if (!contact) {
        await recordAuditDeliverySkip({
          listingId,
          organizerId,
          reason: "no_organizer_email",
        });
        skipped++;
        console.warn(
          "[event-audit] Skipped (no organizer email):",
          listingId,
          row.title,
        );
        continue;
      }

      await sendEventAuditReport({
        listingId,
        triggerKind: "auto",
      });
      sent++;
      console.log("[event-audit] Sent auto report for", listingId, row.title);
    } catch (err) {
      if (err instanceof Error && err.message === "Organizer email not found") {
        await recordAuditDeliverySkip({
          listingId,
          organizerId,
          reason: "no_organizer_email",
        });
        skipped++;
        console.warn(
          "[event-audit] Skipped (no organizer email):",
          listingId,
          row.title,
        );
        continue;
      }
      console.error("[event-audit] Failed for listing", listingId, err);
    }
  }

  if (sent > 0) {
    console.log(`[event-audit] Sent ${sent} automatic audit report(s)`);
  }
  if (skipped > 0) {
    console.log(`[event-audit] Skipped ${skipped} event(s) with no deliverable organizer email`);
  }
}

const POLL_MS = 15 * 60 * 1000;

export function startEventAuditPoller() {
  void processEventAuditReports().catch((err) =>
    console.error("[event-audit-poller] initial tick failed", err),
  );
  setInterval(
    () =>
      void processEventAuditReports().catch((err) =>
        console.error("[event-audit-poller] tick failed", err),
      ),
    POLL_MS,
  );
  console.log(`[event-audit-poller] Started (every ${POLL_MS}ms)`);
}
