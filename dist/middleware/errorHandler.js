import { ZodError } from "zod";
import { friendlyDuplicateMessage, friendlyReferencedMessage, friendlySchemaMessage, isDuplicateEntryError, isReferencedRowError, } from "../utils/db-errors.js";
import { formatZodError } from "../utils/zod-helpers.js";
import { log } from "../utils/logger.js";
export function errorHandler(err, req, res, _next) {
    if (isDuplicateEntryError(err)) {
        return res.status(409).json({
            success: false,
            error: friendlyDuplicateMessage(err),
        });
    }
    if (isReferencedRowError(err)) {
        return res.status(409).json({
            success: false,
            error: friendlyReferencedMessage(err),
        });
    }
    if (err instanceof ZodError) {
        return res.status(400).json({
            success: false,
            error: formatZodError(err),
            details: err.flatten(),
        });
    }
    if (err instanceof Error && err.message === "Unauthorized") {
        return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    if (err instanceof Error && err.message === "Forbidden") {
        return res.status(403).json({ success: false, error: "Forbidden" });
    }
    const schemaMessage = friendlySchemaMessage(err, req.originalUrl);
    if (schemaMessage) {
        log.warn("http", "Database schema mismatch", err, {
            method: req.method,
            path: req.originalUrl,
        });
        return res.status(503).json({ success: false, error: schemaMessage });
    }
    log.error("http", "Unhandled request error", err, {
        method: req.method,
        path: req.originalUrl,
        status: 500,
    });
    return res.status(500).json({ success: false, error: "Internal server error" });
}
