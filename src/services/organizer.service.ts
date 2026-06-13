import type { RowDataPacket } from "mysql2";
import { pool, type QueryParams } from "../db/pool.js";

export async function getOverview(organizerId: string) {
  const [revenueRows] = await pool.query<RowDataPacket[]>(
    `SELECT COALESCE(SUM(o.subtotal_mwk), 0) AS revenue
     FROM orders o
     JOIN listings l ON l.id = o.listing_id
     WHERE l.organizer_id = :organizerId AND o.status = 'confirmed'`,
    { organizerId },
  );

  const [ticketRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(ut.id) AS ticketsSold
     FROM user_tickets ut
     JOIN orders o ON o.id = ut.order_id
     JOIN listings l ON l.id = ut.listing_id
     WHERE l.organizer_id = :organizerId AND o.status = 'confirmed'`,
    { organizerId },
  );

  const [listingRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS active FROM listings WHERE organizer_id = :organizerId AND status = 'published'`,
    { organizerId },
  );

  const [byListing] = await pool.query<RowDataPacket[]>(
    `SELECT l.id, l.title,
       COUNT(ut.id) AS ticketsSold,
       COALESCE(SUM(o.subtotal_mwk), 0) AS revenue
     FROM listings l
     LEFT JOIN orders o ON o.listing_id = l.id AND o.status = 'confirmed'
     LEFT JOIN user_tickets ut ON ut.order_id = o.id
     WHERE l.organizer_id = :organizerId
     GROUP BY l.id, l.title`,
    { organizerId },
  );

  return {
    totalRevenue: Number(revenueRows[0]?.revenue ?? 0),
    ticketsSold: Number(ticketRows[0]?.ticketsSold ?? 0),
    activeListings: Number(listingRows[0]?.active ?? 0),
    revenueByListing: byListing.map((r) => ({
      listingId: r.id,
      title: r.title,
      ticketsSold: Number(r.ticketsSold),
      revenue: Number(r.revenue),
    })),
  };
}

export async function getBuyers(organizerId: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ut.id AS purchase_id, o.contact_name AS name, o.contact_email AS email,
            ut.purchased_at AS purchased_on, ut.seat_number AS seat, ut.amount_paid AS amount,
            ut.status AS ticket_status, o.status AS order_status,
            l.id AS listing_id, l.title AS listing_title, ut.reference
     FROM user_tickets ut
     JOIN orders o ON o.id = ut.order_id
     JOIN listings l ON l.id = ut.listing_id
     WHERE l.organizer_id = :organizerId
     ORDER BY ut.purchased_at DESC`,
    { organizerId },
  );
  return rows.map((r) => ({
    purchaseId: r.purchase_id as string,
    name: r.name,
    email: r.email,
    purchasedOn: r.purchased_on,
    seat: r.seat ? String(r.seat) : undefined,
    amount: Number(r.amount),
    reference: r.reference as string,
    status:
      r.order_status === "confirmed"
        ? "confirmed"
        : r.order_status === "pending"
          ? "pending"
          : r.order_status === "failed"
            ? "failed"
            : "refunded",
    ticketId: r.listing_id,
    listingTitle: r.listing_title,
  }));
}

export async function getOrganizerProfile(userId: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM organizer_profiles WHERE user_id = :userId`,
    { userId },
  );
  const row = rows[0];
  if (!row) return null;
  return {
    companyName: row.company_name,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    partnerType: row.partner_type,
    city: row.city,
    bio: row.bio,
  };
}

export async function updateOrganizerProfile(userId: string, data: Record<string, unknown>) {
  // Organizers cannot change their partner type — set by admin on approval
  await pool.query(
    `UPDATE organizer_profiles SET
      company_name = COALESCE(:companyName, company_name),
      contact_name = COALESCE(:contactName, contact_name),
      email = COALESCE(:email, email),
      phone = COALESCE(:phone, phone),
      city = COALESCE(:city, city),
      bio = COALESCE(:bio, bio)
     WHERE user_id = :userId`,
    {
      userId,
      companyName: data.companyName != null ? String(data.companyName) : null,
      contactName: data.contactName != null ? String(data.contactName) : null,
      email: data.email != null ? String(data.email) : null,
      phone: data.phone != null ? String(data.phone) : null,
      city: data.city != null ? String(data.city) : null,
      bio: data.bio != null ? String(data.bio) : null,
    } satisfies QueryParams,
  );
  return getOrganizerProfile(userId);
}
