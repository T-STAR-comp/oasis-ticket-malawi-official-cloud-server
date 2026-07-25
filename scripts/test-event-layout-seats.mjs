/**
 * Quick verification: event layout seat occupancy after purchase.
 * Run: node scripts/test-event-layout-seats.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import {
  enrichEventLayoutAvailability,
  getOccupiedEventSpotNumbers,
} from "../src/services/event-layout.service.ts";

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER ?? "root",
  password: process.env.MYSQL_PASSWORD ?? "",
  database: process.env.MYSQL_DATABASE ?? "ticket_malawi",
});

function normalizeEventLayoutLikeApp(raw) {
  if (!raw?.spots) return raw;
  return {
    ...raw,
    spots: raw.spots.map((s) => ({
      ...s,
      status:
        s.status === "taken"
          ? "taken"
          : s.status === "unavailable"
            ? "unavailable"
            : s.status === "selected"
              ? "available"
              : "available",
    })),
  };
}

async function main() {
  console.log("=== Event layout seat occupancy test ===\n");

  const [layoutEvents] = await pool.query(
    `SELECT id, title, event_layout_json
     FROM listings
     WHERE kind = 'event'
       AND event_layout_json IS NOT NULL
       AND JSON_EXTRACT(event_layout_json, '$.enabled') = true
     ORDER BY updated_at DESC
     LIMIT 5`,
  );

  if (layoutEvents.length === 0) {
    console.log("No events with enabled layout found.");
    await pool.end();
    return;
  }

  console.log(`Found ${layoutEvents.length} event(s) with layout:\n`);

  for (const event of layoutEvents) {
    const listingId = event.id;
    console.log(`--- ${event.title} (${listingId}) ---`);

    const [tickets] = await pool.query(
      `SELECT ut.seat_number, ut.status AS ticket_status, o.status AS order_status, o.is_guest
       FROM user_tickets ut
       JOIN orders o ON o.id = ut.order_id
       WHERE ut.listing_id = ?
         AND ut.seat_number IS NOT NULL
       ORDER BY ut.id DESC
       LIMIT 10`,
      [listingId],
    );

    console.log(`  Tickets with seat_number: ${tickets.length}`);
    for (const t of tickets) {
      console.log(
        `    spot ${t.seat_number} | ticket=${t.ticket_status} order=${t.order_status} guest=${t.is_guest ? "yes" : "no"}`,
      );
    }

    const [pending] = await pool.query(
      `SELECT o.id, pl.checkout_meta
       FROM payment_ledger pl
       JOIN orders o ON o.id = pl.order_id
       WHERE o.listing_id = ?
         AND o.status = 'pending'
         AND pl.status IN ('pending', 'processing')
         AND pl.expires_at > NOW()`,
      [listingId],
    );
    console.log(`  Pending checkouts with seats: ${pending.length}`);

    const occupied = await getOccupiedEventSpotNumbers(listingId);
    console.log(`  Occupied spot numbers (API logic): [${[...occupied].sort((a, b) => a - b).join(", ")}]`);

    const raw =
      typeof event.event_layout_json === "string"
        ? JSON.parse(event.event_layout_json)
        : event.event_layout_json;
    const enriched = enrichEventLayoutAvailability(raw, occupied);
    const takenFromApi = enriched.spots.filter((s) => s.status === "taken").map((s) => s.number);
    console.log(`  Spots marked taken in API response: [${takenFromApi.sort((a, b) => a - b).join(", ")}]`);

    const afterNormalize = normalizeEventLayoutLikeApp(enriched);
    const takenAfterNormalize = afterNormalize.spots
      .filter((s) => s.status === "taken")
      .map((s) => s.number);
    console.log(`  Spots still taken after normalize (fixed): [${takenAfterNormalize.sort((a, b) => a - b).join(", ")}]`);

    const apiUrl = `http://127.0.0.1:${process.env.PORT ?? 8000}/api/listings/${listingId}`;
    try {
      const res = await fetch(apiUrl);
      if (res.ok) {
        const body = await res.json();
        const listing = body.data ?? body;
        const apiTaken = (listing.eventLayout?.spots ?? [])
          .filter((s) => s.status === "taken")
          .map((s) => s.number);
        console.log(`  Live API taken spots: [${apiTaken.sort((a, b) => a - b).join(", ")}]`);
      } else {
        console.log(`  Live API: HTTP ${res.status} (is dev server running?)`);
      }
    } catch (err) {
      console.log(`  Live API: unavailable (${err.message})`);
    }

    console.log("");
  }

  const [recentGuest] = await pool.query(
    `SELECT o.id, o.listing_id, pl.checkout_meta, o.status
     FROM orders o
     JOIN payment_ledger pl ON pl.order_id = o.id
     WHERE o.is_guest = 1
     ORDER BY o.created_at DESC
     LIMIT 3`,
  );
  console.log("Recent guest orders (checkout_meta.seatNumbers):");
  for (const row of recentGuest) {
    const meta =
      typeof row.checkout_meta === "string" ? JSON.parse(row.checkout_meta) : row.checkout_meta;
    console.log(
      `  order ${row.id.slice(0, 8)}… status=${row.status} seats=${JSON.stringify(meta?.seatNumbers ?? [])}`,
    );
  }

  await pool.end();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
