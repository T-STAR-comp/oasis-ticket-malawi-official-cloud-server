import PDFDocument from "pdfkit";
import type { EventAuditSnapshot } from "./event-audit.service.js";

type PdfDoc = InstanceType<typeof PDFDocument>;

const BRAND = "#0f4c5c";
const MUTED = "#646464";
const INK = "#282828";
const AUDIT_FOOTER =
  "Oasis Technology and Capital Finance Audit Office";

function formatMwk(amount: number): string {
  return `MWK ${amount.toLocaleString("en-MW")}`;
}

function formatDateTime(value: string): string {
  try {
    return new Intl.DateTimeFormat("en-MW", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Africa/Blantyre",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

type BarItem = { label: string; value: number };

function drawHorizontalBarChart(
  doc: PdfDoc,
  x: number,
  y: number,
  width: number,
  title: string,
  items: BarItem[],
  valueFormatter: (n: number) => string = (n) => String(n),
) {
  if (items.length === 0) {
    doc.fontSize(10).fillColor(MUTED).text(`${title}: No data`, x, y);
    return y + 24;
  }

  doc.fontSize(11).fillColor(BRAND).text(title, x, y);
  let cursorY = y + 18;
  const maxVal = Math.max(...items.map((i) => i.value), 1);
  const barMaxWidth = width - 120;

  for (const item of items.slice(0, 8)) {
    const barWidth = Math.max(4, (item.value / maxVal) * barMaxWidth);
    doc.fontSize(9).fillColor(INK).text(item.label.slice(0, 28), x, cursorY, { width: 90 });
    doc
      .rect(x + 95, cursorY + 1, barWidth, 10)
      .fillColor(BRAND)
      .fill();
    doc
      .fontSize(8)
      .fillColor(MUTED)
      .text(valueFormatter(item.value), x + 95 + barWidth + 6, cursorY + 1);
    cursorY += 16;
  }
  return cursorY + 8;
}

function drawAuditFooter(doc: PdfDoc) {
  const y = doc.page.height - 48;
  doc
    .moveTo(48, y - 12)
    .lineTo(doc.page.width - 48, y - 12)
    .strokeColor("#c8c8c8")
    .stroke();
  doc
    .fontSize(9)
    .fillColor(MUTED)
    .text(AUDIT_FOOTER, 48, y, { align: "center", width: doc.page.width - 96 });
  doc.fontSize(7).text("Confidential — for organizer use only", 48, y + 14, {
    align: "center",
    width: doc.page.width - 96,
  });
}

export async function generateEventAuditPdf(snapshot: EventAuditSnapshot): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width - 96;

    doc
      .fontSize(22)
      .fillColor(BRAND)
      .text("Event Financial Audit Report", { align: "center" });
    doc
      .fontSize(10)
      .fillColor(MUTED)
      .text(`Generated ${formatDateTime(snapshot.generatedAt)}`, { align: "center" });
    doc.moveDown(1.2);

    doc.fontSize(14).fillColor(INK).text(snapshot.title, { align: "left" });
    doc.fontSize(10).fillColor(MUTED);
    doc.text(`Organizer: ${snapshot.companyName}`);
    doc.text(`Schedule: ${snapshot.dateLabel} · ${snapshot.timeLabel}`);
    doc.text(`Location: ${snapshot.location || "—"} · Format: ${snapshot.eventFormat}`);
    doc.text(`Event ID: ${snapshot.listingId}`);
    doc.moveDown(1);

    doc.fontSize(12).fillColor(BRAND).text("Executive summary");
    doc.moveDown(0.4);
    const summaryLines = [
      ["Tickets sold", String(snapshot.summary.ticketsSold)],
      ["Active tickets", String(snapshot.summary.activeTickets)],
      ["Refunded / cancelled", String(snapshot.summary.refundedTickets)],
      ["Gross revenue (incl. fees)", formatMwk(snapshot.summary.grossRevenue)],
      ["Organizer share", formatMwk(snapshot.summary.organizerShare)],
      ["Platform service fees", formatMwk(snapshot.summary.serviceFees)],
      ["Customer refunds processed", formatMwk(snapshot.summary.refundsTotal)],
      ["Average ticket (organizer share)", formatMwk(snapshot.summary.avgTicketPrice)],
    ];
    for (const [label, value] of summaryLines) {
      doc.fontSize(10).fillColor(INK).text(`${label}: `, { continued: true });
      doc.font("Helvetica-Bold").text(value);
      doc.font("Helvetica");
    }

    doc.moveDown(1);
    let chartY = doc.y;
    chartY = drawHorizontalBarChart(
      doc,
      48,
      chartY,
      pageWidth,
      "Ticket sales by day",
      snapshot.charts.salesByDay.map((d) => ({
        label: d.day,
        value: d.revenue,
      })),
      formatMwk,
    );

    if (chartY > doc.page.height - 120) {
      doc.addPage();
      chartY = 48;
    }

    chartY = drawHorizontalBarChart(
      doc,
      48,
      chartY,
      pageWidth,
      "Sales by ticket type",
      snapshot.charts.salesByTier.map((t) => ({
        label: t.tier,
        value: t.revenue,
      })),
      formatMwk,
    );

    if (chartY > doc.page.height - 120) {
      doc.addPage();
      chartY = 48;
    }

    chartY = drawHorizontalBarChart(
      doc,
      48,
      chartY,
      pageWidth,
      "Payment methods",
      snapshot.charts.paymentMethods.map((p) => ({
        label: p.method.toUpperCase(),
        value: p.amount,
      })),
      formatMwk,
    );

    chartY = drawHorizontalBarChart(
      doc,
      48,
      chartY + 8,
      pageWidth,
      "Ticket status breakdown",
      snapshot.charts.ticketStatus.map((s) => ({
        label: s.status,
        value: s.count,
      })),
    );

    doc.addPage();
    doc.fontSize(12).fillColor(BRAND).text("Order ledger");
    doc.moveDown(0.5);

    const colX = [48, 130, 200, 280, 360, 440];
    doc.fontSize(8).fillColor(MUTED);
    doc.text("Reference", colX[0], doc.y);
    doc.text("Status", colX[1], doc.y - doc.currentLineHeight());
    doc.text("Paid", colX[2], doc.y - doc.currentLineHeight());
    doc.text("Total", colX[3], doc.y - doc.currentLineHeight());
    doc.text("Your share", colX[4], doc.y - doc.currentLineHeight());
    doc.text("Tickets", colX[5], doc.y - doc.currentLineHeight());
    doc.moveDown(0.8);

    for (const order of snapshot.orders.slice(0, 40)) {
      if (doc.y > doc.page.height - 80) {
        doc.addPage();
      }
      const rowY = doc.y;
      doc.fontSize(8).fillColor(INK);
      doc.text(order.reference.slice(0, 14), colX[0], rowY, { width: 78 });
      doc.text(order.status, colX[1], rowY, { width: 65 });
      doc.text(order.paidAt ? formatDateTime(order.paidAt).slice(0, 16) : "—", colX[2], rowY, {
        width: 75,
      });
      doc.text(formatMwk(order.total), colX[3], rowY, { width: 75 });
      doc.text(formatMwk(order.organizerShare), colX[4], rowY, { width: 75 });
      doc.text(String(order.ticketCount), colX[5], rowY);
      doc.moveDown(0.6);
    }

    if (snapshot.refunds.length > 0) {
      doc.addPage();
      doc.fontSize(12).fillColor(BRAND).text("Refund records");
      doc.moveDown(0.5);
      for (const refund of snapshot.refunds) {
        doc
          .fontSize(9)
          .fillColor(INK)
          .text(
            `${refund.reference} · ${formatMwk(refund.amount)} · ${refund.status} · ${formatDateTime(refund.createdAt)}`,
          );
      }
    }

    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      drawAuditFooter(doc);
    }

    doc.end();
  });
}

export { AUDIT_FOOTER };
