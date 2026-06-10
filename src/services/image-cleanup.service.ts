import type { RowDataPacket } from "mysql2";
import { pool } from "../db/pool.js";
import { isManagedImagePath } from "../config/images.js";
import { deleteManagedImageFile } from "./image-upload.service.js";

/** Cleared in DB after purge — frontend renders a broken/missing image, not stock art. */
export const PURGED_LISTING_IMAGE = "";

/**
 * Delete listing cover images once the event/trip date has passed (day after event).
 */
export async function purgeListingImagesPastEventDate() {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, image_url
     FROM listings
     WHERE image_url IS NOT NULL
       AND image_url != ''
       AND image_url LIKE '%image-bucket-folder%'
       AND event_starts_on IS NOT NULL
       AND event_starts_on < CURDATE()`,
  );

  let deleted = 0;
  let cleared = 0;

  for (const row of rows) {
    const imageUrl = String(row.image_url);
    if (!isManagedImagePath(imageUrl)) continue;

    const removed = await deleteManagedImageFile(imageUrl);
    if (removed) deleted++;

    await pool.query(`UPDATE listings SET image_url = '' WHERE id = :id`, { id: row.id });
    cleared++;
  }

  return { listingsProcessed: rows.length, filesDeleted: deleted, dbCleared: cleared };
}
