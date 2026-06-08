import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { v4 as uuid } from "uuid";
import {
  IMAGE_BUCKET_URL_PREFIX,
  IMAGE_MAX_DIMENSION,
  IMAGE_MAX_PIXELS,
  IMAGE_MAX_UPLOAD_BYTES,
  IMAGE_MAX_WIDTH,
  buildPublicImageUrl,
  imagePathToAbsoluteFile,
  isManagedImagePath,
  resolveImageBucketDir,
} from "../config/images.js";
import { assertOrganizerCanMutate } from "./moderation.service.js";

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Magic-byte signatures for allowed formats only. */
function detectImageType(buffer: Buffer): "jpeg" | "png" | "webp" | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "png";
  }
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

export function validateUploadMime(mimetype: string | undefined): void {
  if (!mimetype || !ALLOWED_MIME.has(mimetype)) {
    throw new Error("Only JPEG, PNG, or WebP images are allowed");
  }
}

export async function processAndStoreListingImage(
  organizerId: string,
  buffer: Buffer,
  declaredMime: string | undefined,
): Promise<{ path: string; url: string; sizeBytes: number }> {
  await assertOrganizerCanMutate(organizerId);

  if (!buffer?.length) throw new Error("No image data received");
  if (buffer.length > IMAGE_MAX_UPLOAD_BYTES) {
    throw new Error("Image must be 2 MB or smaller");
  }

  validateUploadMime(declaredMime);

  const detected = detectImageType(buffer);
  if (!detected) {
    throw new Error("File content is not a valid JPEG, PNG, or WebP image");
  }

  if (declaredMime === "image/jpeg" && detected !== "jpeg") {
    throw new Error("Image content does not match declared type");
  }
  if (declaredMime === "image/png" && detected !== "png") {
    throw new Error("Image content does not match declared type");
  }
  if (declaredMime === "image/webp" && detected !== "webp") {
    throw new Error("Image content does not match declared type");
  }

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(buffer, { failOn: "error", limitInputPixels: IMAGE_MAX_PIXELS })
      .metadata();
  } catch {
    throw new Error("Could not read image — file may be corrupt or unsupported");
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new Error("Invalid image dimensions");
  }
  if (width > IMAGE_MAX_DIMENSION || height > IMAGE_MAX_DIMENSION) {
    throw new Error("Image dimensions are too large");
  }
  if (width * height > IMAGE_MAX_PIXELS) {
    throw new Error("Image resolution is too large");
  }

  const processed = await sharp(buffer, { failOn: "error", limitInputPixels: IMAGE_MAX_PIXELS })
    .rotate()
    .resize({
      width: IMAGE_MAX_WIDTH,
      withoutEnlargement: true,
      fit: "inside",
    })
    .webp({ quality: 82, effort: 4 })
    .toBuffer();

  if (processed.length > IMAGE_MAX_UPLOAD_BYTES) {
    throw new Error("Processed image exceeded size limit");
  }

  const bucketRoot = resolveImageBucketDir();
  const organizerDir = path.join(bucketRoot, organizerId);
  await fs.mkdir(organizerDir, { recursive: true });

  const fileName = `${uuid()}.webp`;
  const absolutePath = path.join(organizerDir, fileName);
  await fs.writeFile(absolutePath, processed, { mode: 0o644 });

  const storedPath = `${IMAGE_BUCKET_URL_PREFIX}/${organizerId}/${fileName}`;
  return {
    path: storedPath,
    url: buildPublicImageUrl(storedPath),
    sizeBytes: processed.length,
  };
}

export async function deleteManagedImageFile(imageUrl: string | null | undefined): Promise<boolean> {
  const absolute = imagePathToAbsoluteFile(String(imageUrl ?? ""));
  if (!absolute) return false;

  const bucketRoot = path.resolve(resolveImageBucketDir());
  const resolved = path.resolve(absolute);
  if (!resolved.startsWith(bucketRoot + path.sep) && resolved !== bucketRoot) {
    return false;
  }

  try {
    await fs.unlink(resolved);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw err;
  }
}

export async function replaceListingImageIfManaged(
  organizerId: string,
  previousImageUrl: string | null | undefined,
  nextImageUrl: string | null | undefined,
) {
  if (!previousImageUrl || previousImageUrl === nextImageUrl) return;
  if (!isManagedImagePath(previousImageUrl)) return;
  if (!previousImageUrl.includes(`/${organizerId}/`)) return;
  await deleteManagedImageFile(previousImageUrl);
}

/** Simple in-memory rate limit: max uploads per organizer per hour. */
const uploadCounts = new Map<string, { count: number; resetAt: number }>();
const UPLOADS_PER_HOUR = 30;

export function assertUploadRateLimit(organizerId: string) {
  const now = Date.now();
  const entry = uploadCounts.get(organizerId);
  if (!entry || now > entry.resetAt) {
    uploadCounts.set(organizerId, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return;
  }
  if (entry.count >= UPLOADS_PER_HOUR) {
    throw new Error("Upload limit reached. Try again in an hour.");
  }
  entry.count += 1;
}

export function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}
