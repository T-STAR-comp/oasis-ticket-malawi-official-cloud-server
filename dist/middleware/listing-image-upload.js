import multer from "multer";
import { IMAGE_MAX_UPLOAD_BYTES } from "../config/images.js";
import { validateUploadMime } from "../services/image-upload.service.js";
const storage = multer.memoryStorage();
export const listingImageUpload = multer({
    storage,
    limits: {
        fileSize: IMAGE_MAX_UPLOAD_BYTES,
        files: 1,
        fields: 0,
        parts: 2,
    },
    fileFilter: (_req, file, cb) => {
        try {
            if (file.fieldname !== "image") {
                cb(new Error("Unexpected upload field"));
                return;
            }
            const name = file.originalname ?? "";
            if (name.includes("\0") || /[\\/]/.test(name)) {
                cb(new Error("Invalid file name"));
                return;
            }
            const lower = name.toLowerCase();
            if (/\.(php|phtml|js|html|svg|exe|sh|bat|cmd|asp|aspx|cgi)$/.test(lower)) {
                cb(new Error("File type not allowed"));
                return;
            }
            validateUploadMime(file.mimetype);
            cb(null, true);
        }
        catch (err) {
            cb(err instanceof Error ? err : new Error("Invalid upload"));
        }
    },
}).single("image");
