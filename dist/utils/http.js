export function ok(res, data, status = 200) {
    return res.status(status).json({ success: true, data });
}
export function fail(res, message, status = 400, details) {
    return res.status(status).json({ success: false, error: message, details });
}
export function slugify(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 64);
}
export function makeReference(listingId) {
    const suffix = listingId.slice(0, 2).toUpperCase();
    const num = Math.floor(1000 + Math.random() * 9000);
    return `TM-${num}-${suffix}`;
}
