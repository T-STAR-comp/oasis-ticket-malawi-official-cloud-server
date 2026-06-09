import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./env.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Public URL path segment (served by API or cPanel alias). */
export const IMAGE_BUCKET_URL_PREFIX = "/image-bucket-folder";
/** Max raw upload size before processing (2 MB). */
export const IMAGE_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
/** Processed image max width in pixels. */
export const IMAGE_MAX_WIDTH = 1200;
/** Reject decompression bombs / oversized dimensions. */
export const IMAGE_MAX_PIXELS = 24_000_000;
export const IMAGE_MAX_DIMENSION = 12_000;
export function resolveImageBucketDir() {
    const configured = env.images.bucketDir.trim();
    if (path.isAbsolute(configured))
        return configured;
    return path.resolve(path.join(__dirname, "..", ".."), configured);
}
export function isManagedImagePath(imageUrl) {
    if (!imageUrl?.trim())
        return false;
    const v = imageUrl.trim();
    return (v.includes(`${IMAGE_BUCKET_URL_PREFIX}/`) ||
        v.startsWith(`${IMAGE_BUCKET_URL_PREFIX}/`));
}
export function imagePathToAbsoluteFile(imageUrl) {
    if (!isManagedImagePath(imageUrl))
        return null;
    const relative = imageUrl.includes(IMAGE_BUCKET_URL_PREFIX)
        ? imageUrl.slice(imageUrl.indexOf(IMAGE_BUCKET_URL_PREFIX))
        : imageUrl;
    const withoutPrefix = relative.replace(/^\/?image-bucket-folder\/?/, "");
    if (!withoutPrefix || withoutPrefix.includes(".."))
        return null;
    return path.join(resolveImageBucketDir(), withoutPrefix);
}
export function buildPublicImageUrl(relativePath) {
    const normalized = relativePath.replace(/\\/g, "/");
    const pathPart = normalized.startsWith("/")
        ? normalized
        : `${IMAGE_BUCKET_URL_PREFIX}/${normalized}`;
    const origin = env.images.publicOrigin.replace(/\/$/, "");
    return origin ? `${origin}${pathPart}` : pathPart;
}
