import type { RowDataPacket, ResultSetHeader } from "mysql2";
import { v4 as uuid } from "uuid";
import { pool } from "../db/pool.js";
import { listingBelongsToOrganizer } from "./listings.service.js";

export type VerifyMethod = "reference" | "qr_scan" | "self_checkin";

export type VerifyResult = {
  success: boolean;
  result: "accepted" | "rejected";
  message: string;
  rejectReason?: string;
  ticket?: {
    id: string;
    reference: string;
    status: string;
    seat?: string;
    listingId: string;
    listingTitle: string;
    holderName?: string;
    verifiedAt?: string;
  };
  /** When multiple tickets share a reference (e.g. bus seats), ask client to pick one */
  choices?: Array<{
    id: string;
    seat?: string;
    listingId: string;
    listingTitle: string;
  }>;
};

type TicketRow = RowDataPacket & {
  id: string;
  listing_id: string;
  reference: string;
  qr_token: string;
  status: string;
  seat_number: number | null;
  listing_title: string;
  organizer_id: string;
  contact_name: string | null;
};

async function findCustomerByEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, email, full_name, role, status
     FROM users
     WHERE LOWER(email) = :email
       AND role = 'customer'
       AND status = 'active'
     LIMIT 1`,
    { email: normalized },
  );
  return rows[0] ?? null;
}

export async function searchVerifierCandidates(organizerId: string, emailQuery: string) {
  const q = emailQuery.trim().toLowerCase();
  if (q.length < 3) return [];

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, email, full_name
     FROM users
     WHERE role = 'customer'
       AND status = 'active'
       AND LOWER(email) LIKE :pattern
     ORDER BY email
     LIMIT 10`,
    { pattern: `%${q}%` },
  );

  return rows.map((r) => ({
    userId: r.id as string,
    email: r.email as string,
    fullName: r.full_name as string,
  }));
}

export async function assignListingVerifier(
  organizerId: string,
  listingId: string,
  verifierEmail: string,
) {
  const owned = await listingBelongsToOrganizer(listingId, organizerId);
  if (!owned) throw new Error("Listing not found");

  const verifier = await findCustomerByEmail(verifierEmail);
  if (!verifier) {
    throw new Error("No active customer account found with that email.");
  }
  if (verifier.id === organizerId) {
    throw new Error("You cannot assign yourself as a verifier.");
  }

  await pool.query(
    `UPDATE listing_verifier_assignments
     SET status = 'revoked', revoked_at = NOW()
     WHERE listing_id = :listingId
       AND verifier_user_id = :verifierUserId
       AND status = 'active'`,
    { listingId, verifierUserId: verifier.id },
  );

  const id = uuid();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO listing_verifier_assignments (
      id, listing_id, organizer_id, verifier_user_id, status, expires_at
    ) VALUES (
      :id, :listingId, :organizerId, :verifierUserId, 'active', :expiresAt
    )`,
    {
      id,
      listingId,
      organizerId,
      verifierUserId: verifier.id,
      expiresAt,
    },
  );

  return {
    assignmentId: id,
    listingId,
    verifierUserId: verifier.id as string,
    verifierEmail: verifier.email as string,
    verifierName: verifier.full_name as string,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function revokeVerifierAssignment(organizerId: string, assignmentId: string) {
  const [result] = await pool.query(
    `UPDATE listing_verifier_assignments
     SET status = 'revoked', revoked_at = NOW()
     WHERE id = :assignmentId AND organizer_id = :organizerId AND status = 'active'`,
    { assignmentId, organizerId },
  );
  const affected = (result as { affectedRows?: number }).affectedRows ?? 0;
  if (!affected) throw new Error("Assignment not found or already revoked");
  return { revoked: true };
}

export async function listOrganizerAssignments(organizerId: string, listingId?: string) {
  let sql = `
    SELECT a.*, u.email AS verifier_email, u.full_name AS verifier_name, l.title AS listing_title
    FROM listing_verifier_assignments a
    JOIN users u ON u.id = a.verifier_user_id
    JOIN listings l ON l.id = a.listing_id
    WHERE a.organizer_id = :organizerId
      AND a.status = 'active'
      AND a.expires_at > NOW()`;
  const params: Record<string, string> = { organizerId };
  if (listingId) {
    sql += ` AND a.listing_id = :listingId`;
    params.listingId = listingId;
  }
  sql += ` ORDER BY a.expires_at DESC`;

  const [rows] = await pool.query<RowDataPacket[]>(sql, params);
  return rows.map((r) => ({
    id: r.id as string,
    listingId: r.listing_id as string,
    listingTitle: r.listing_title as string,
    verifierUserId: r.verifier_user_id as string,
    verifierEmail: r.verifier_email as string,
    verifierName: r.verifier_name as string,
    expiresAt: r.expires_at as string,
    createdAt: r.created_at as string,
  }));
}

export async function getVerifierAssignments(userId: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT a.*, l.title AS listing_title, l.kind, l.date_label, l.location
     FROM listing_verifier_assignments a
     JOIN listings l ON l.id = a.listing_id
     WHERE a.verifier_user_id = :userId
       AND a.status = 'active'
       AND a.expires_at > NOW()
     ORDER BY a.expires_at ASC`,
    { userId },
  );

  return rows.map((r) => ({
    assignmentId: r.id as string,
    listingId: r.listing_id as string,
    listingTitle: r.listing_title as string,
    kind: r.kind as string,
    date: r.date_label as string,
    location: r.location as string,
    expiresAt: r.expires_at as string,
  }));
}

async function hasVerifierAccess(userId: string, listingId: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id FROM listing_verifier_assignments
     WHERE verifier_user_id = :userId
       AND listing_id = :listingId
       AND status = 'active'
       AND expires_at > NOW()
     LIMIT 1`,
    { userId, listingId },
  );
  return !!rows[0];
}

async function assertCanVerifyListing(
  userId: string,
  userRole: string,
  listingId: string,
): Promise<"organizer" | "verifier"> {
  if (userRole === "admin") return "organizer";
  if (await listingBelongsToOrganizer(listingId, userId)) return "organizer";
  if (await hasVerifierAccess(userId, listingId)) return "verifier";
  throw new Error("You do not have permission to verify tickets for this listing.");
}

export async function canVerifyListing(userId: string, listingId: string): Promise<boolean> {
  if (await listingBelongsToOrganizer(listingId, userId)) return true;
  return hasVerifierAccess(userId, listingId);
}

async function loadTicketRow(ticketId: string): Promise<TicketRow | null> {
  const [rows] = await pool.query<TicketRow[]>(
    `SELECT ut.*, l.title AS listing_title, l.organizer_id, o.contact_name
     FROM user_tickets ut
     JOIN listings l ON l.id = ut.listing_id
     JOIN orders o ON o.id = ut.order_id
     WHERE ut.id = :ticketId
     LIMIT 1`,
    { ticketId },
  );
  return rows[0] ?? null;
}

async function logVerification(input: {
  userTicketId: string;
  listingId: string;
  verifiedByUserId: string;
  method: VerifyMethod;
  result: "accepted" | "rejected";
  rejectReason?: string;
  reference?: string;
  qrToken?: string;
}) {
  await pool.query(
    `INSERT INTO ticket_verifications (
      id, user_ticket_id, listing_id, verified_by_user_id, method, result,
      reject_reason, reference, qr_token
    ) VALUES (
      :id, :userTicketId, :listingId, :verifiedByUserId, :method, :result,
      :rejectReason, :reference, :qrToken
    )`,
    {
      id: uuid(),
      userTicketId: input.userTicketId,
      listingId: input.listingId,
      verifiedByUserId: input.verifiedByUserId,
      method: input.method,
      result: input.result,
      rejectReason: input.rejectReason ?? null,
      reference: input.reference ?? null,
      qrToken: input.qrToken ?? null,
    },
  );
}

function ticketPayload(row: TicketRow, verifiedAt?: string) {
  return {
    id: row.id,
    reference: row.reference,
    status: verifiedAt ? "used" : row.status,
    seat: row.seat_number != null ? String(row.seat_number) : undefined,
    listingId: row.listing_id,
    listingTitle: row.listing_title,
    holderName: row.contact_name ?? undefined,
    verifiedAt,
  };
}

async function markTicketUsed(ticketId: string, verifiedByUserId: string) {
  const [result] = await pool.query<ResultSetHeader>(
    `UPDATE user_tickets
     SET status = 'used', verified_at = NOW(), verified_by_user_id = :verifiedByUserId
     WHERE id = :ticketId AND status = 'active'`,
    { ticketId, verifiedByUserId },
  );
  return result.affectedRows === 1;
}

async function acceptTicket(
  row: TicketRow,
  verifiedByUserId: string,
  method: VerifyMethod,
  reference?: string,
  qrToken?: string,
): Promise<VerifyResult> {
  if (row.status === "used") {
    await logVerification({
      userTicketId: row.id,
      listingId: row.listing_id,
      verifiedByUserId,
      method,
      result: "rejected",
      rejectReason: "already_used",
      reference,
      qrToken,
    });
    return {
      success: false,
      result: "rejected",
      rejectReason: "already_used",
      message: "This ticket has already been verified and used.",
      ticket: ticketPayload(row),
    };
  }

  if (row.status === "expired") {
    await logVerification({
      userTicketId: row.id,
      listingId: row.listing_id,
      verifiedByUserId,
      method,
      result: "rejected",
      rejectReason: "expired",
      reference,
      qrToken,
    });
    return {
      success: false,
      result: "rejected",
      rejectReason: "expired",
      message: "This ticket has expired.",
      ticket: ticketPayload(row),
    };
  }

  const updated = await markTicketUsed(row.id, verifiedByUserId);
  if (!updated) {
    return {
      success: false,
      result: "rejected",
      rejectReason: "already_used",
      message: "This ticket was just verified by someone else.",
      ticket: ticketPayload(row),
    };
  }

  const verifiedAt = new Date().toISOString();
  await logVerification({
    userTicketId: row.id,
    listingId: row.listing_id,
    verifiedByUserId,
    method,
    result: "accepted",
    reference,
    qrToken,
  });

  return {
    success: true,
    result: "accepted",
    message: "Ticket verified successfully. Entry granted.",
    ticket: ticketPayload({ ...row, status: "used" }, verifiedAt),
  };
}

export async function verifyByReference(input: {
  userId: string;
  userRole: string;
  reference: string;
  listingId?: string;
  seatNumber?: number;
}): Promise<VerifyResult> {
  const reference = input.reference.trim().toUpperCase();
  if (!reference) throw new Error("Enter a ticket reference.");

  let sql = `
    SELECT ut.*, l.title AS listing_title, l.organizer_id, o.contact_name
    FROM user_tickets ut
    JOIN listings l ON l.id = ut.listing_id
    JOIN orders o ON o.id = ut.order_id
    WHERE ut.reference = :reference`;
  const params: Record<string, string | number> = { reference };

  if (input.listingId) {
    await assertCanVerifyListing(input.userId, input.userRole, input.listingId);
    sql += ` AND ut.listing_id = :listingId`;
    params.listingId = input.listingId;
  } else if (input.userRole === "organizer" || input.userRole === "admin") {
    sql += ` AND l.organizer_id = :organizerId`;
    params.organizerId = input.userId;
  } else {
    throw new Error("Select a listing to verify tickets for.");
  }

  if (input.seatNumber != null) {
    sql += ` AND ut.seat_number = :seatNumber`;
    params.seatNumber = input.seatNumber;
  }

  const [rows] = await pool.query<TicketRow[]>(sql, params);

  if (rows.length === 0) {
    return {
      success: false,
      result: "rejected",
      rejectReason: "not_found",
      message: "No ticket found with that reference for this event.",
    };
  }

  if (rows.length > 1 && input.seatNumber == null) {
    return {
      success: false,
      result: "rejected",
      rejectReason: "multiple_matches",
      message: "Multiple tickets share this reference. Select a seat number.",
      choices: rows.map((r) => ({
        id: r.id,
        seat: r.seat_number != null ? String(r.seat_number) : undefined,
        listingId: r.listing_id,
        listingTitle: r.listing_title,
      })),
    };
  }

  const row = rows[0];
  if (input.listingId) {
    await assertCanVerifyListing(input.userId, input.userRole, row.listing_id);
  } else if (input.userRole === "verifier") {
    throw new Error("Select a listing to verify tickets for.");
  }

  return acceptTicket(row, input.userId, "reference", reference);
}

export async function verifyByQr(input: {
  userId: string;
  userRole: string;
  listingId?: string;
  payload: { ref: string; token: string; id: string };
}): Promise<VerifyResult> {
  const { ref, token, id } = input.payload;
  if (!ref || !token || !id) throw new Error("Invalid QR code.");

  const row = await loadTicketRow(id);
  if (!row || row.reference !== ref || row.qr_token !== token) {
    return {
      success: false,
      result: "rejected",
      rejectReason: "not_found",
      message: "QR code does not match any ticket on record.",
    };
  }

  if (input.listingId) {
    if (row.listing_id !== input.listingId) {
      return {
        success: false,
        result: "rejected",
        rejectReason: "wrong_listing",
        message: "This ticket is for a different listing.",
        ticket: ticketPayload(row),
      };
    }
    await assertCanVerifyListing(input.userId, input.userRole, input.listingId);
  } else if (input.userRole === "organizer" || input.userRole === "admin") {
    if (row.organizer_id !== input.userId && input.userRole !== "admin") {
      return {
        success: false,
        result: "rejected",
        rejectReason: "wrong_listing",
        message: "This ticket was not sold for one of your listings.",
        ticket: ticketPayload(row),
      };
    }
  } else {
    await assertCanVerifyListing(input.userId, input.userRole, row.listing_id);
  }

  return acceptTicket(row, input.userId, "qr_scan", ref, token);
}

export async function parseAndVerifyQrRaw(input: {
  userId: string;
  userRole: string;
  listingId?: string;
  raw: string;
}): Promise<VerifyResult> {
  let parsed: { ref?: string; token?: string; id?: string };
  try {
    parsed = JSON.parse(input.raw.trim());
  } catch {
    throw new Error("Could not read QR code. Scan a valid Ticket Malawi ticket.");
  }
  if (!parsed.ref || !parsed.token || !parsed.id) {
    throw new Error("Invalid ticket QR code.");
  }
  return verifyByQr({
    userId: input.userId,
    userRole: input.userRole,
    listingId: input.listingId,
    payload: { ref: parsed.ref, token: parsed.token, id: parsed.id },
  });
}
