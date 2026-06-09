import { pool } from "../db/pool.js";
import { isManagedImagePath } from "../config/images.js";
import { deleteManagedImageFile } from "./image-upload.service.js";
const PLACEHOLDER_IMAGE = "/assets/event-artsummit.jpg";
/**
 * Delete listing cover images once the event/trip date has passed by one calendar day.
 * Matches ticket expiry policy.
 */
export async function purgeListingImagesPastEventDate() {
    const [rows] = await pool.query(`SELECT id, image_url
     FROM listings
     WHERE image_url IS NOT NULL
       AND image_url != ''
       AND image_url LIKE '%image-bucket-folder%'
       AND event_starts_on IS NOT NULL
       AND event_starts_on < DATE_SUB(CURDATE(), INTERVAL 1 DAY)`);
    let deleted = 0;
    let cleared = 0;
    for (const row of rows) {
        const imageUrl = String(row.image_url);
        if (!isManagedImagePath(imageUrl))
            continue;
        const removed = await deleteManagedImageFile(imageUrl);
        if (removed)
            deleted++;
        await pool.query(`UPDATE listings SET image_url = :placeholder WHERE id = :id`, { id: row.id, placeholder: PLACEHOLDER_IMAGE });
        cleared++;
    }
    return { listingsProcessed: rows.length, filesDeleted: deleted, dbCleared: cleared };
}
